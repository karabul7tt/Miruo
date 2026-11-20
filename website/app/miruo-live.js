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
  let failCount = 0;
  let failed = false;
  let nextAttemptAt = 0;
  let localChain = Promise.resolve();
  const pubs = { audio: null, video: null };            // { mst }
  const remote = new Map();                              // identity -> { audio, video, name }
  const ownStreams = new Map();                          // identity -> MediaStream (video only)
  const audioEls = new Map();                            // identity -> <audio>
  const clock = { samples: [] };

  function tokenUrl() {
    if (window.MIRUO_LIVE_TOKEN_URL) return window.MIRUO_LIVE_TOKEN_URL;
    const h = (location && location.hostname) || '';
    if (/(^|\.)miruo\.com\.tr$/.test(h)) return '/api/livekit-token';
    return 'https://www.miruo.com.tr/api/livekit-token';
  }

  function isEnabled() { return !!LK() && !failed; }
  function isConnected() { return !!room && room.state === 'connected'; }
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
      body: JSON.stringify({ room: roomId, identity: st.clientId, name: st.username || 'Miruo', userId: st.userId || '' })
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
  function setAudio(identity, track) {
    let el = audioEls.get(identity);
    if (!track) {
      if (el) { try { el.pause(); el.srcObject = null; el.remove(); } catch (_) {} audioEls.delete(identity); }
      return;
    }
    if (!el) {
      el = document.createElement('audio');
      el.id = 'lkAudio_' + String(identity).replace(/[^a-zA-Z0-9_-]/g, '_');
      el.autoplay = true;
      el.playsInline = true;
      el.setAttribute('playsinline', 'true');
      el.setAttribute('webkit-playsinline', 'true');
      el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1';
      document.body.appendChild(el);
      audioEls.set(identity, el);
    }
    if (!el.srcObject || el.dataset.trackId !== track.id) {
      el.dataset.trackId = track.id;
      el.srcObject = new MediaStream([track]);
    }
    el.muted = false;
    el.defaultMuted = false;
    el.volume = 1;
    el.onpause = () => {
      if (S() && S().isInRoom && el.srcObject && !el.muted) el.play().catch(() => {});
    };
    if (!track._lkAudioBound && typeof track.addEventListener === 'function') {
      track._lkAudioBound = true;
      track.addEventListener('unmute', () => {
        if (el && el.srcObject) {
          el.muted = false;
          el.volume = 1;
          el.play().catch(() => {});
        }
      });
    }
    const p = el.play();
    if (p && p.catch) p.catch(() => { _needGesture = true; });
  }
  let _needGesture = false;
  ['click', 'touchstart', 'keydown'].forEach(evt => window.addEventListener(evt, () => {
    if (room && typeof room.startAudio === 'function') room.startAudio().catch(() => {});
    audioEls.forEach(el => { if (el.srcObject && el.paused) el.play().catch(() => {}); });
    _needGesture = false;
  }, { passive: true }));

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
        updateRemoteParticipantStatus(p.userId || identity, p.username || r.name || 'Katılımcı', !!r.audio, !!r.video, p.avatar, p.avatarColor, identity);
      }
    } catch (_) {}
  }

  function onTrackSubscribed(track, pub, participant) {
    const id = participant.identity;
    const r = remote.get(id) || { name: participant.name };
    const L = LK();
    if (track.kind === 'audio') {
      r.audio = track.mediaStreamTrack;
      remote.set(id, r);
      setAudio(id, r.audio);
    } else if (track.kind === 'video' && pub.source !== L.Track.Source.ScreenShare) {
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
    if (track.kind === 'audio') { r.audio = null; setAudio(id, null); }
    else if (track.kind === 'video') { r.video = null; applyVideo(id); }
    notifyStatus(id);
    repaint();
  }
  function onParticipantGone(participant) {
    const id = participant.identity;
    setAudio(id, null);
    const r = remote.get(id);
    if (r) {
      r.audio = null;
      r.video = null;
      applyVideo(id);
    }
    notifyStatus(id);
    remote.delete(id);
    ownStreams.delete(id);
    repaint();
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
  function onData(bytes, participant, kind, topic) {
    if (topic && topic !== 'miruo') return;
    let m;
    try { m = JSON.parse(dec.decode(bytes)); } catch (_) { return; }
    const st = S();
    if (!m || !st) return;
    if (m.k === 'sync' && m.p) {
      try { window.handleRemoteSync && window.handleRemoteSync(m.p); } catch (e) { console.warn('[MiruoLive] sync handler', e); }
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
  function startClockSync() {
    if (pingTimer) clearInterval(pingTimer);
    let n = 0;
    const tick = () => {
      const st = S();
      if (!isConnected() || !st || st.isHost) return;
      n++;
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
    const a = (st.isMicOn && ls) ? ls.getAudioTracks().find(t => t.readyState === 'live') : null;
    const v = (st.isCamOn && ls) ? ls.getVideoTracks().find(t => t.readyState === 'live') : null;

    for (const kind of ['audio', 'video']) {
      const mst = kind === 'audio' ? a : v;
      const cur = pubs[kind];
      if (cur && (!mst || cur.mst !== mst || cur.mst.readyState !== 'live')) {
        try { await lp.unpublishTrack(cur.mst, false); } catch (_) {}
        pubs[kind] = null;
      }
      if (mst && !pubs[kind]) {
        mst.enabled = true;
        const opts = kind === 'audio'
          ? { source: L.Track.Source.Microphone, dtx: true, red: true, audioPreset: L.AudioPresets.speech }
          : { source: L.Track.Source.Camera, simulcast: false, videoEncoding: { maxBitrate: 700000, maxFramerate: 24 }, degradationPreference: 'maintain-framerate' };
        try {
          await lp.publishTrack(mst, opts);
          pubs[kind] = { mst };
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
        dynacast: true,
        stopLocalTrackOnUnpublish: false,
        publishDefaults: { simulcast: false, dtx: true, red: true, videoCodec: 'vp8' }
      });
      const E = L.RoomEvent;
      r.on(E.TrackSubscribed, onTrackSubscribed);
      r.on(E.TrackUnsubscribed, onTrackUnsubscribed);
      r.on(E.ParticipantConnected, (p) => {
        if (p && p.identity) {
          remote.set(p.identity, remote.get(p.identity) || { name: p.name });
          notifyStatus(p.identity);
          repaint();
        }
      });
      r.on(E.ParticipantDisconnected, onParticipantGone);
      r.on(E.DataReceived, onData);
      r.on(E.Reconnected, () => syncLocal());
      r.on(E.Disconnected, () => {
        if (room === r) { room = null; roomKey = null; pubs.audio = null; pubs.video = null; }
      });
      await r.connect(t.url, t.token, { autoSubscribe: true });
      if (connectingKey !== key || !S().isInRoom) { try { r.disconnect(); } catch (_) {} return; }
      room = r;
      roomKey = key;
      failCount = 0;
      console.log('[MiruoLive] connected', t.room);
      if (typeof r.startAudio === 'function') r.startAudio().catch(() => {});
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
    const r = room;
    room = null;
    roomKey = null;
    failCount = 0;
    failed = false;
    nextAttemptAt = 0;
    pubs.audio = null; pubs.video = null;
    clock.samples = [];
    if (S()) { S().hostClockOffsetMs = null; }
    audioEls.forEach((el, id) => setAudio(id, null));
    remote.forEach((v, id) => { v.video = null; applyVideo(id); });
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
    // keep late-created peer entries / participants wired to LiveKit video
    remote.forEach((v, id) => applyVideo(id));
    // if the local stream changed outside the toggles (device change, camera flip, interruption), re-sync
    if (isConnected()) {
      const curA = (st.isMicOn && st.localStream) ? (st.localStream.getAudioTracks().find(t => t.readyState === 'live') || null) : null;
      const curV = (st.isCamOn && st.localStream) ? (st.localStream.getVideoTracks().find(t => t.readyState === 'live') || null) : null;
      if ((pubs.audio ? pubs.audio.mst : null) !== curA || (pubs.video ? pubs.video.mst : null) !== curV) syncLocal();
    }
  }
  setInterval(watch, 1000);

  window.MiruoLive = {
    isEnabled, isConnected, syncLocal, sendSync, streamFor, getVideoTrack, hasVideo, tokenUrl,
    debug() {
      return {
        connected: isConnected(), failed, failCount, offset: S() && S().hostClockOffsetMs, rtt: S() && S().hostClockRttMs,
        remote: Array.from(remote.entries()).map(([id, v]) => ({ id, audio: !!v.audio, video: !!v.video })),
        pubs: { audio: !!pubs.audio, video: !!pubs.video }
      };
    },
    _disconnect: disconnect,
    _watch: watch
  };
})();
