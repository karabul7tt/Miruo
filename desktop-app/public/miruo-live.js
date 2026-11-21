/* ============================================================================
 * Miruo Live — LiveKit (SFU) bridge
 *  - Camera + microphone travel through the LiveKit SFU (one uplink per user,
 *    no P2P mesh, no shared free TURN) -> low-latency voice, stable video.
 *  - Playback-sync messages ALSO travel over the LiveKit data channel (fast, ordered).
 *  - Host<->guest wall-clock offset (NTP-style ping/pong) so sync maths ignore transport delay.
 * Loaded after app.js. Everything is optional: if LiveKit cannot be used the app falls
 * back to the legacy P2P media path automatically.
 * ========================================================================== */
(function () {
  'use strict';
  if (window.MiruoLive) return;

  const S = () => window.state;
  const LK = () => window.LivekitClient;

  let room = null;
  let connectingKey = null;
  let roomKey = null;
  let connectedAt = 0;
  let failCount = 0;
  let failed = false;
  let nextAttemptAt = 0;
  let localChain = Promise.resolve();
  const pubs = { audio: null, video: null, screen: null, screenAudio: null }; // { mst, pub }
  const remote = new Map();                              // identity -> { audio, audioTrackObj, video, screen, screenAudio, name }
  const ownStreams = new Map();                          // identity -> MediaStream (video only)
  const audioEls = new Map();                            // identity -> <audio>
  const audioTrackObjs = new Map();                      // identity -> RemoteAudioTrack
  const screenAudioEls = new Map();                      // identity -> <audio>
  const clock = { samples: [] };

  function tokenUrl() {
    if (window.MIRUO_LIVE_TOKEN_URL) return window.MIRUO_LIVE_TOKEN_URL;
    const h = (location && location.hostname) || '';
    if (/(^|\.)miruo\.com\.tr$/.test(h)) return '/api/livekit-token';
    return 'https://www.miruo.com.tr/api/livekit-token';
  }

  function isEnabled() { return !!LK() && !failed; }
  function isConnected() { return !!room && room.state === 'connected'; }
  function hasRemoteParticipant(identity) {
    if (!room || !identity || !room.remoteParticipants) return false;
    return room.remoteParticipants.has(identity);
  }
  function connectedDurationMs() {
    return (isConnected() && connectedAt > 0) ? (Date.now() - connectedAt) : 0;
  }
  function getVideoTrack(identity) {
    if (!identity) return null;
    const r = remote.get(identity);
    if (r && r.video && r.video.readyState === 'live') return r.video;
    return null;
  }
  function hasVideo(identity) { return !!getVideoTrack(identity); }

  async function fetchToken(roomId) {
    const st = S();
    const res = await fetch(tokenUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room: roomId,
        identity: st.clientId,
        name: st.username || 'Miruo',
        userId: st.userId || '',
        deviceId: st.deviceId || '',
        singleInstance: !!st.isSingleInstanceDevice
      })
    });
    if (!res.ok) throw new Error('token_http_' + res.status);
    const j = await res.json();
    if (!j || !j.token || !j.url) throw new Error('token_bad_response');
    return j;
  }

  /* ---------------- remote media plumbing ---------------- */
  function findPeer(identity) {
    try { return (typeof getPeerEntry === 'function') ? getPeerEntry(identity) : null; } catch (_) { return null; }
  }
  function participantFor(identity) {
    const st = S();
    if (!st || !st.participants) return null;
    return st.participants[identity] || Object.values(st.participants).find(p => p && p.clientId === identity) || null;
  }
  function streamFor(identity) {
    let own = ownStreams.get(identity);
    if (!own) { own = new MediaStream(); ownStreams.set(identity, own); }
    return own;
  }
  function applyVideo(identity) {
    const r = remote.get(identity) || {};
    const vt = r.video || null;
    const targets = new Set();
    targets.add(streamFor(identity));
    const peer = findPeer(identity);
    if (peer) {
      if (!peer.stream) peer.stream = new MediaStream();
      targets.add(peer.stream);
      peer.camVideoTrack = vt;
    }
    const p = participantFor(identity);
    if (p) { p.stream = (peer && peer.stream) || streamFor(identity); targets.add(p.stream); }
    targets.forEach(ms => {
      ms.getVideoTracks().forEach(t => { if (t !== vt) { try { ms.removeTrack(t); } catch (_) {} } });
      if (vt && !ms.getVideoTracks().includes(vt)) { try { ms.addTrack(vt); } catch (_) {} }
    });
  }
  function setAudio(identity, trackObj) {
    const safeId = String(identity).replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!trackObj) {
      const prevTrack = audioTrackObjs.get(identity);
      if (prevTrack && typeof prevTrack.detach === 'function') {
        try { prevTrack.detach(); } catch (_) {}
      }
      audioTrackObjs.delete(identity);
      const prevEl = audioEls.get(identity);
      if (prevEl) { try { prevEl.pause(); prevEl.srcObject = null; prevEl.remove(); } catch (_) {} audioEls.delete(identity); }
      return;
    }

    const mst = trackObj.mediaStreamTrack || trackObj;
    const prevTrack = audioTrackObjs.get(identity);
    let el = audioEls.get(identity);
    if (prevTrack && prevTrack !== trackObj && typeof prevTrack.detach === 'function') {
      try { prevTrack.detach(); } catch (_) {}
    }

    if (typeof trackObj.attach === 'function') {
      if (!el || el.dataset.trackId !== mst.id) {
        if (el) { try { el.pause(); el.srcObject = null; el.remove(); } catch (_) {} }
        el = trackObj.attach();
      }
    } else {
      if (!el) el = document.createElement('audio');
      if (!el.srcObject || el.dataset.trackId !== mst.id) {
        el.srcObject = new MediaStream([mst]);
      }
    }

    el.id = 'lkAudio_' + safeId;
    el.dataset.trackId = mst.id;
    el.autoplay = true;
    el.playsInline = true;
    el.setAttribute('playsinline', 'true');
    el.setAttribute('webkit-playsinline', 'true');
    el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1';
    if (!el.isConnected) document.body.appendChild(el);
    audioEls.set(identity, el);
    audioTrackObjs.set(identity, trackObj);

    el.muted = false;
    el.defaultMuted = false;
    el.volume = 1;
    el.onpause = () => {
      if (S() && S().isInRoom && el.srcObject && !el.muted) el.play().catch(() => {});
    };
    if (mst && !mst._lkAudioBound && typeof mst.addEventListener === 'function') {
      mst._lkAudioBound = true;
      mst.addEventListener('unmute', () => {
        if (el && (el.srcObject || typeof trackObj.attach === 'function')) {
          el.muted = false;
          el.volume = 1;
          el.play().catch(() => {});
        }
      });
    }
    const p = el.play();
    if (p && p.catch) p.catch(() => { _needGesture = true; });
    try { if (typeof updateBlockedMediaState === 'function') updateBlockedMediaState(); } catch (_) {}
  }
  let _needGesture = false;
  function unlockAudio() {
    if (room && typeof room.startAudio === 'function') room.startAudio().catch(() => {});
    audioEls.forEach(el => {
      if (el && el.paused && el.srcObject) {
        el.play().catch(() => {});
      }
    });
    _needGesture = false;
  }
  ['click', 'touchstart', 'keydown'].forEach(evt => window.addEventListener(evt, unlockAudio, { passive: true }));

  function repaint() {
    try { if (typeof renderStagePipCards === 'function') renderStagePipCards(); } catch (_) {}
    try { if (typeof renderVideoGrid === 'function') renderVideoGrid(); } catch (_) {}
    try { if (typeof renderParticipantsList === 'function') renderParticipantsList(); } catch (_) {}
  }
  function notifyStatus(identity) {
    const r = remote.get(identity) || {};
    const p = participantFor(identity) || {};
    const st = S();
    if (!st || identity === st.clientId) return;
    try {
      if (typeof updateRemoteParticipantStatus === 'function') {
        updateRemoteParticipantStatus(p.userId || identity, p.username || r.name || 'Katılımcı', !!r.audio, !!r.video, p.avatar, p.avatarColor, identity, r.deviceId || p.deviceId || '', Boolean(r.singleInstance || p.singleInstance));
      }
    } catch (_) {}
  }

  function getScreenTrack(identity) {
    if (identity) {
      const r = remote.get(identity);
      return (r && r.screen && r.screen.readyState === 'live') ? r.screen : null;
    }
    for (const [, r] of remote.entries()) {
      if (r && r.screen && r.screen.readyState === 'live') return r.screen;
    }
    return null;
  }
  function setScreenAudio(identity, trackObj) {
    const safeId = String(identity).replace(/[^a-zA-Z0-9_-]/g, '_');
    const prevEl = screenAudioEls.get(identity);
    if (!trackObj) {
      if (prevEl) { try { prevEl.pause(); prevEl.srcObject = null; prevEl.remove(); } catch (_) {} screenAudioEls.delete(identity); }
      return;
    }
    const mst = trackObj.mediaStreamTrack || trackObj;
    let el = prevEl;
    if (typeof trackObj.attach === 'function') {
      if (!el || el.dataset.trackId !== mst.id) {
        if (el) { try { el.pause(); el.srcObject = null; el.remove(); } catch (_) {} }
        el = trackObj.attach();
      }
    } else {
      if (!el) el = document.createElement('audio');
      el.srcObject = new MediaStream([mst]);
    }
    el.id = 'lkScreenAudio_' + safeId;
    el.dataset.trackId = mst.id;
    el.autoplay = true;
    el.playsInline = true;
    el.muted = false;
    el.volume = 1;
    el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1';
    if (!el.isConnected) document.body.appendChild(el);
    screenAudioEls.set(identity, el);
    el.play().catch(() => {});
  }
  function applyScreen(identity) {
    const r = remote.get(identity) || {};
    const st = S();
    const peer = findPeer(identity);
    if (peer) peer.screenVideoTrack = r.screen || null;
    const screenPlayer = document.getElementById('remoteScreenPlayer');
    if (r.screen && r.screen.readyState === 'live') {
      const p = participantFor(identity) || {};
      const sharerName = p.username || r.name || 'Oda Sahibi';
      if (typeof window.handleRemoteScreenShareStarted === 'function' && (!st || st.activeMode !== 'screenshare')) {
        try { window.handleRemoteScreenShareStarted(sharerName, { trackId: r.screen.id }); } catch (_) {}
      }
      if (screenPlayer) {
        screenPlayer.classList.remove('hidden');
        screenPlayer.playsInline = true;
        screenPlayer.muted = true;
        screenPlayer.autoplay = true;
        if (!screenPlayer.srcObject || screenPlayer.dataset.trackId !== r.screen.id) {
          screenPlayer.dataset.trackId = r.screen.id;
          screenPlayer.srcObject = new MediaStream([r.screen]);
        }
        screenPlayer.play().catch(() => {});
      }
    } else {
      const anyOtherScreen = getScreenTrack(null);
      if (!anyOtherScreen && st && st.activeMode === 'screenshare' && !st.isScreenSharing) {
        if (typeof window.handleRemoteScreenShareStopped === 'function') {
          try { window.handleRemoteScreenShareStopped(); } catch (_) {}
        }
      }
    }
  }

  function onTrackSubscribed(track, pub, participant) {
    const id = participant.identity;
    const r = remote.get(id) || { name: participant.name };
    if (participant.metadata) {
      try {
        const meta = JSON.parse(participant.metadata);
        if (meta && meta.deviceId) r.deviceId = meta.deviceId;
        if (meta && typeof meta.singleInstance === 'boolean') r.singleInstance = meta.singleInstance;
      } catch (_) {}
    }
    const L = LK();
    const isScreenVideo = (pub && pub.source === L.Track.Source.ScreenShare) || (pub && pub.trackName === 'screen');
    const isScreenAudio = (pub && pub.source === L.Track.Source.ScreenShareAudio) || (pub && pub.trackName === 'screen_audio');
    if (track.kind === 'audio' && isScreenAudio) {
      r.screenAudio = track.mediaStreamTrack;
      remote.set(id, r);
      setScreenAudio(id, track);
    } else if (track.kind === 'audio') {
      r.audio = track.mediaStreamTrack;
      r.audioTrackObj = track;
      remote.set(id, r);
      setAudio(id, track);
    } else if (track.kind === 'video' && isScreenVideo) {
      r.screen = track.mediaStreamTrack;
      r.screenTrackObj = track;
      remote.set(id, r);
      applyScreen(id);
    } else if (track.kind === 'video') {
      r.video = track.mediaStreamTrack;
      remote.set(id, r);
      applyVideo(id);
    }
    notifyStatus(id);
    repaint();
  }
  function onTrackUnsubscribed(track, pub, participant) {
    const id = participant.identity;
    const r = remote.get(id);
    if (!r) return;
    const L = LK();
    const isScreenVideo = (pub && pub.source === L.Track.Source.ScreenShare) || (pub && pub.trackName === 'screen');
    const isScreenAudio = (pub && pub.source === L.Track.Source.ScreenShareAudio) || (pub && pub.trackName === 'screen_audio');
    if (track.kind === 'audio' && isScreenAudio) {
      r.screenAudio = null;
      setScreenAudio(id, null);
    } else if (track.kind === 'audio') {
      r.audio = null; r.audioTrackObj = null; setAudio(id, null);
    } else if (track.kind === 'video' && isScreenVideo) {
      r.screen = null; r.screenTrackObj = null;
      applyScreen(id);
    } else if (track.kind === 'video') {
      r.video = null; applyVideo(id);
    }
    notifyStatus(id);
    repaint();
  }
  function onParticipantGone(participant) {
    const id = participant.identity;
    setAudio(id, null);
    setScreenAudio(id, null);
    const r = remote.get(id);
    if (r) {
      const hadScreen = !!r.screen;
      r.audio = null;
      r.audioTrackObj = null;
      r.video = null;
      r.screen = null;
      r.screenAudio = null;
      applyVideo(id);
      if (hadScreen) applyScreen(id);
    }
    remote.delete(id);
    ownStreams.delete(id);
    if (typeof window.removeParticipantImmediately === 'function') {
      try { window.removeParticipantImmediately(id); } catch (_) {}
    } else {
      notifyStatus(id);
      repaint();
    }
  }

  /* ---------------- data channel ---------------- */
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  function sendRaw(obj, reliable) {
    if (!isConnected()) return false;
    try {
      room.localParticipant.publishData(enc.encode(JSON.stringify(obj)), { reliable: reliable !== false, topic: 'miruo' }).catch(() => {});
      return true;
    } catch (_) { return false; }
  }
  function sendSync(payload) {
    const reliable = !(payload && (payload.action === 'heartbeat'));
    return sendRaw({ k: 'sync', p: payload }, reliable);
  }
  function sendP2P(type, payload) {
    if (!type || type === 'sync') return false;
    return sendRaw({ k: 'p2p', t: type, p: payload }, true);
  }
  function sendLeave() {
    const st = S();
    if (!isConnected() || !st || !st.clientId) return false;
    return sendRaw({ k: 'left', id: st.clientId, uid: st.userId || '', dev: st.deviceId || '' }, true);
  }
  function sendAlive() {
    const st = S();
    if (!isConnected() || !st || !st.clientId) return false;
    let savedAv = '';
    try { savedAv = JSON.parse(localStorage.getItem('miruo_user') || '{}').avatarUrl || ''; } catch (_) {}
    return sendRaw({
      k: 'alive',
      id: st.clientId,
      uid: st.userId || '',
      dev: st.deviceId || '',
      si: !!st.isSingleInstanceDevice,
      u: st.username || 'Katılımcı',
      av: st.avatarUrl || savedAv || '',
      mic: !!st.isMicOn,
      cam: !!st.isCamOn,
      host: !!st.isHost,
      role: st.userRole || (st.isHost ? 'owner' : 'member')
    }, false);
  }
  function onData(bytes, participant, kind, topic) {
    if (topic && topic !== 'miruo') return;
    let m;
    try { m = JSON.parse(dec.decode(bytes)); } catch (_) { return; }
    const st = S();
    if (!m || !st) return;
    if (m.k === 'sync' && m.p) {
      try { window.handleRemoteSync && window.handleRemoteSync(m.p); } catch (e) { console.warn('[MiruoLive] sync handler', e); }
    } else if (m.k === 'p2p' && m.t && m.p) {
      try {
        if (typeof window.handleIncomingP2PData === 'function') {
          window.handleIncomingP2PData({ type: m.t, payload: m.p, ...m.p });
        }
      } catch (e) {
        console.warn('[MiruoLive] p2p handler', e);
      }
    } else if (m.k === 'left') {
      if (m.id && m.id !== st.clientId) {
        setAudio(m.id, null);
        const r = remote.get(m.id);
        if (r) { r.audio = null; r.audioTrackObj = null; r.video = null; applyVideo(m.id); }
        remote.delete(m.id);
        ownStreams.delete(m.id);
        if (typeof window.removeParticipantImmediately === 'function') {
          try { window.removeParticipantImmediately(m.id); } catch (_) {}
        }
      }
    } else if (m.k === 'alive') {
      if (m.id && m.id !== st.clientId) {
        if (typeof window.evictDuplicateDeviceSessions === 'function' && m.dev) {
          try { window.evictDuplicateDeviceSessions(m.id, m.dev, !!m.si); } catch (_) {}
        }
        const existingP = st.participants && (st.participants[m.id] || Object.values(st.participants).find(p => p && p.clientId === m.id));
        if (existingP) {
          existingP.lastSeen = Date.now();
          if (m.dev) existingP.deviceId = m.dev;
          if (typeof m.si === 'boolean') existingP.singleInstance = m.si;
          delete existingP.vanishedSince;
        } else if (typeof updateRemoteParticipantStatus === 'function') {
          updateRemoteParticipantStatus(m.uid || m.id, m.u || 'Katılımcı', !!m.mic, !!m.cam, m.av || '', '', m.id, m.dev || '', !!m.si);
        }
      }
    } else if (m.k === 'ping') {
      if (st.isHost) sendRaw({ k: 'pong', w0: m.w0, p0: m.p0, to: m.from, h: Date.now() }, false);
    } else if (m.k === 'pong') {
      if (m.to !== st.clientId) return;
      const rtt = performance.now() - m.p0;
      if (!(rtt >= 0 && rtt < 3000)) return;
      const offset = m.h - (m.w0 + rtt / 2);        // host clock minus my clock
      clock.samples.push({ rtt, offset });
      if (clock.samples.length > 12) clock.samples.shift();
      const best = clock.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      st.hostClockOffsetMs = best.offset;
      st.hostClockRttMs = best.rtt;
    }
  }
  let pingTimer = null;
  let aliveTimer = null;
  function startClockSync() {
    if (pingTimer) clearInterval(pingTimer);
    if (aliveTimer) clearInterval(aliveTimer);
    sendAlive();
    aliveTimer = setInterval(sendAlive, 1500);
    const tick = () => {
      const st = S();
      if (!isConnected() || !st || st.isHost) return;
      sendRaw({ k: 'ping', w0: Date.now(), p0: performance.now(), from: st.clientId }, false);
    };
    tick();
    pingTimer = setInterval(() => { tick(); }, 1000);
    // after warm-up, slow down
    setTimeout(() => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = setInterval(tick, 6000); }
    }, 12000);
  }

  /* ---------------- local publishing ---------------- */
  function syncLocal() {
    localChain = localChain.then(doSyncLocal).catch(e => console.warn('[MiruoLive] syncLocal', e));
    return localChain;
  }
  async function doSyncLocal() {
    if (!isConnected()) return;
    const st = S();
    const L = LK();
    const lp = room.localParticipant;
    const ls = st.localStream;
    const ss = st.screenStream;
    const a = (st.isMicOn && ls) ? ls.getAudioTracks().find(t => t.readyState === 'live') : null;
    const v = (st.isCamOn && ls) ? ls.getVideoTracks().find(t => t.readyState === 'live') : null;
    const sv = (st.isScreenSharing && ss) ? ss.getVideoTracks().find(t => t.readyState === 'live') : null;
    const sa = (st.isScreenSharing && ss) ? ss.getAudioTracks().find(t => t.readyState === 'live') : null;

    const desiredMap = { audio: a, video: v, screen: sv, screenAudio: sa };

    for (const kind of ['audio', 'video', 'screen', 'screenAudio']) {
      const mst = desiredMap[kind];
      const cur = pubs[kind];
      if (cur && (!mst || cur.mst !== mst || cur.mst.readyState !== 'live')) {
        try { await lp.unpublishTrack(cur.mst, false); } catch (_) {}
        pubs[kind] = null;
      }
      if (mst && !pubs[kind]) {
        mst.enabled = true;
        let opts;
        if (kind === 'audio') {
          opts = { source: L.Track.Source.Microphone, dtx: false, red: false, audioPreset: { maxBitrate: 48000 } };
        } else if (kind === 'video') {
          opts = { source: L.Track.Source.Camera, simulcast: false, videoEncoding: { maxBitrate: 700000, maxFramerate: 24 }, degradationPreference: 'maintain-framerate' };
        } else if (kind === 'screen') {
          opts = { source: L.Track.Source.ScreenShare, name: 'screen', simulcast: false, videoEncoding: { maxBitrate: 2500000, maxFramerate: 30 }, degradationPreference: 'maintain-resolution' };
        } else {
          opts = { source: L.Track.Source.ScreenShareAudio, name: 'screen_audio', dtx: false, red: false, audioPreset: { maxBitrate: 64000 } };
        }
        try {
          const pub = await lp.publishTrack(mst, opts);
          pubs[kind] = { mst, pub };
        } catch (e) {
          console.warn('[MiruoLive] publish ' + kind + ' failed', e);
        }
      }
    }
  }

  /* ---------------- connection lifecycle ---------------- */
  async function connect(roomId, key) {
    const L = LK();
    const st = S();
    connectingKey = key;
    try {
      const t = await fetchToken(roomId);
      if (connectingKey !== key || !st.isInRoom) return;
      const r = new L.Room({
        adaptiveStream: false,
        dynacast: false,
        stopLocalTrackOnUnpublish: false,
        publishDefaults: { simulcast: false, dtx: false, red: false, videoCodec: 'vp8' }
      });
      const E = L.RoomEvent;
      r.on(E.TrackSubscribed, onTrackSubscribed);
      r.on(E.TrackUnsubscribed, onTrackUnsubscribed);
      r.on(E.ParticipantConnected, (p) => {
        if (p && p.identity) {
          const entry = remote.get(p.identity) || { name: p.name };
          if (p.metadata) {
            try {
              const meta = JSON.parse(p.metadata);
              if (meta && meta.deviceId) {
                entry.deviceId = meta.deviceId;
                entry.singleInstance = !!meta.singleInstance;
                if (typeof window.evictDuplicateDeviceSessions === 'function') {
                  window.evictDuplicateDeviceSessions(p.identity, meta.deviceId, !!meta.singleInstance);
                }
              }
            } catch (_) {}
          }
          remote.set(p.identity, entry);
          notifyStatus(p.identity);
          repaint();
        }
      });
      r.on(E.ParticipantDisconnected, onParticipantGone);
      r.on(E.DataReceived, onData);
      if (E.AudioPlaybackStatusChanged) {
        r.on(E.AudioPlaybackStatusChanged, () => {
          if (r && r.canPlaybackAudio === false && typeof showToast === 'function') {
            showToast('Sesi açmak için ekrana dokunun');
          }
        });
      }
      r.on(E.Reconnected, () => syncLocal());
      r.on(E.Disconnected, () => {
        if (room === r) { room = null; roomKey = null; connectedAt = 0; pubs.audio = null; pubs.video = null; pubs.screen = null; pubs.screenAudio = null; }
      });
      await r.connect(t.url, t.token, { autoSubscribe: true });
      if (connectingKey !== key || !S().isInRoom) { try { r.disconnect(); } catch (_) {} return; }
      room = r;
      roomKey = key;
      connectedAt = Date.now();
      failCount = 0;
      console.log('[MiruoLive] connected', t.room);
      unlockAudio();
      // pick up anyone already publishing
      r.remoteParticipants.forEach(p => {
        p.trackPublications.forEach(pub => { if (pub.track) onTrackSubscribed(pub.track, pub, p); });
      });
      startClockSync();
      if (!st.isHost) {
        sendSync({ action: 'request_sync', clientId: st.clientId, sentAt: Date.now() });
      }
      await syncLocal();
    } catch (e) {
      failCount++;
      console.warn('[MiruoLive] connect failed (' + failCount + ')', e && e.message || e);
      nextAttemptAt = Date.now() + Math.min(8000, 1000 * failCount);
      if (failCount >= 4 && !failed) {
        failed = true;
        console.warn('[MiruoLive] giving up -> legacy P2P media fallback');
        legacyFallback();
      }
    } finally {
      if (connectingKey === key) connectingKey = null;
    }
  }

  function legacyFallback() {
    try {
      const peers = (typeof getUniquePeerEntries === 'function') ? getUniquePeerEntries() : [];
      peers.forEach(p => {
        try { if (typeof ensureSendRecvTransceivers === 'function') ensureSendRecvTransceivers(p.pc, p); } catch (_) {}
        try { if (typeof syncLocalMediaToPeer === 'function') syncLocalMediaToPeer(p, true); } catch (_) {}
      });
    } catch (_) {}
  }

  function disconnect() {
    connectingKey = null;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (aliveTimer) { clearInterval(aliveTimer); aliveTimer = null; }
    const r = room;
    room = null;
    roomKey = null;
    connectedAt = 0;
    failCount = 0;
    failed = false;
    nextAttemptAt = 0;
    pubs.audio = null; pubs.video = null; pubs.screen = null; pubs.screenAudio = null;
    clock.samples = [];
    if (S()) { S().hostClockOffsetMs = null; }
    audioEls.forEach((el, id) => setAudio(id, null));
    screenAudioEls.forEach((el, id) => setScreenAudio(id, null));
    audioTrackObjs.clear();
    remote.forEach((v, id) => { v.video = null; v.screen = null; applyVideo(id); });
    remote.clear();
    ownStreams.clear();
    if (r) { try { r.disconnect(); } catch (_) {} }
  }

  function watch() {
    const st = S();
    if (!st || !LK() || failed) return;
    const wantKey = (st.isInRoom && st.roomId && st.clientId) ? (String(st.roomId).trim().toUpperCase() + '|' + st.clientId) : null;
    if (!wantKey) { if (room || connectingKey) disconnect(); return; }
    if (room && roomKey !== wantKey) disconnect();
    if (!room && !connectingKey && Date.now() >= nextAttemptAt) {
      connect(String(st.roomId).trim().toUpperCase(), wantKey);
    }
    // keep late-created peer entries / participants wired to LiveKit video and self-heal removed <audio> elements
    remote.forEach((v, id) => {
      applyVideo(id);
      if (v && v.screen) applyScreen(id);
      if (v && v.audioTrackObj) {
        const el = audioEls.get(id);
        if (!el || !el.isConnected) {
          setAudio(id, v.audioTrackObj);
        }
      }
    });
    // self-heal any paused camera or screen-share <video> elements so cameras never stay frozen
    if (st.isInRoom && typeof document !== 'undefined') {
      const camSelectors = '#selfVideo, #partnerVideo, .extra-partner-video, #roomVideoGrid video, #remoteScreenPlayer';
      document.querySelectorAll(camSelectors).forEach(vid => {
        if (vid && vid.paused && vid.srcObject) {
          const tracks = vid.srcObject.getVideoTracks ? vid.srcObject.getVideoTracks() : [];
          if (tracks.length > 0 && tracks[0].readyState === 'live') {
            vid.play().catch(() => {});
          }
        }
      });
    }
    // if the local stream changed outside the toggles (device change, camera flip, interruption), re-sync
    if (isConnected()) {
      const curA = (st.isMicOn && st.localStream) ? (st.localStream.getAudioTracks().find(t => t.readyState === 'live') || null) : null;
      const curV = (st.isCamOn && st.localStream) ? (st.localStream.getVideoTracks().find(t => t.readyState === 'live') || null) : null;
      const curSV = (st.isScreenSharing && st.screenStream) ? (st.screenStream.getVideoTracks().find(t => t.readyState === 'live') || null) : null;
      const curSA = (st.isScreenSharing && st.screenStream) ? (st.screenStream.getAudioTracks().find(t => t.readyState === 'live') || null) : null;
      if ((pubs.audio ? pubs.audio.mst : null) !== curA ||
          (pubs.video ? pubs.video.mst : null) !== curV ||
          (pubs.screen ? pubs.screen.mst : null) !== curSV ||
          (pubs.screenAudio ? pubs.screenAudio.mst : null) !== curSA) {
        syncLocal();
      }
    }
  }
  setInterval(watch, 1000);

  window.MiruoLive = {
    isEnabled, isConnected, syncLocal, sendSync, sendP2P, sendLeave, unlockAudio,
    streamFor, getVideoTrack, getScreenTrack, hasVideo, tokenUrl, hasRemoteParticipant, connectedDurationMs,
    debug() {
      return {
        connected: isConnected(), failed, failCount, offset: S() && S().hostClockOffsetMs, rtt: S() && S().hostClockRttMs,
        remote: Array.from(remote.entries()).map(([id, v]) => ({ id, audio: !!v.audio, video: !!v.video, screen: !!v.screen })),
        pubs: { audio: !!pubs.audio, video: !!pubs.video, screen: !!pubs.screen, screenAudio: !!pubs.screenAudio }
      };
    },
    _disconnect: disconnect,
    _watch: watch
  };
})();
