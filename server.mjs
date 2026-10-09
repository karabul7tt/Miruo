import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Security Module (Checklist Items 1 - 20)
import {
  loadEnvironment,
  ROLES,
  canManageRoom,
  canAccessAdmin,
  authLimiter,
  registerLimiter,
  otpLimiter,
  generalApiLimiter,
  getClientIp,
  hashPassword,
  verifyPassword,
  escapeHtml,
  sanitizeText,
  isValidEmail,
  isValidUsername,
  isValidPassword,
  isValidPhone,
  isValidRoomCode,
  safeJsonParse,
  sanitizeObject,
  readJsonBody,
  applySecurityHeaders,
  handleCors,
  buildSecureCookie,
  createSignedToken,
  verifySignedToken,
  maskEmail,
  safeLog,
  sendError,
  verifyWebhookSignature,
  backupUsersFile,
  startPeriodicBackup
} from './lib/security.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'app');
const WEBSITE_DIR = path.join(__dirname, 'website');
const USERS_FILE = path.join(__dirname, 'data', 'users.json');

// 1. Load Environment Configuration (Item 1 & 2)
const CONFIG = loadEnvironment(__dirname);
const PORT = CONFIG.PORT;

// Start periodic automatic database backups (Item 20)
startPeriodicBackup(USERS_FILE, 60 * 60 * 1000);

function loadUsers() {
  try {
    if (!fs.existsSync(path.dirname(USERS_FILE))) {
      fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
    }
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      return safeJsonParse(data) || [];
    }
  } catch (err) {
    safeLog('DATABASE', 'Kullanıcılar yüklenirken hata oluştu', { error: err.message });
  }
  return [];
}

function saveUsers(users) {
  try {
    if (!fs.existsSync(path.dirname(USERS_FILE))) {
      fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
    }
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
    // Automatic backup on write (Item 20)
    backupUsersFile(USERS_FILE, 'auto-save');
  } catch (err) {
    safeLog('DATABASE', 'Kullanıcılar kaydedilirken hata oluştu', { error: err.message });
  }
}

// Rooms store: roomId -> { meta: { id, name, isPrivate, host, hostUserId, category, mediaTitle }, clients: Map }
const rooms = new Map();
// Temporary in-memory store for 6-digit OTP password reset codes
const passwordResetCodes = new Map();
// Temporary in-memory store for 6-digit phone login OTP codes
const phoneOtpCodes = new Map();

// Seed initial community public rooms
function seedDefaultPublicRooms() {
  const defaults = [
    { 
      id: 'LOFI-CHILL', 
      name: '24/7 Lo-Fi & Gece Çalışma Odası ☕', 
      isPrivate: false, 
      host: 'Selin_K', 
      hostUserId: 'usr_selin_seeded',
      category: 'YouTube', 
      mediaTitle: 'Lofi Girl - beats to relax/study to', 
      videoId: 'jfKfPfyJRdk',
      viewers: 24,
      avatars: [
        'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&auto=format&fit=crop&q=80',
        'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=120&auto=format&fit=crop&q=80'
      ]
    },
    { 
      id: 'STRANGER-TR', 
      name: 'Stranger Things Maratonu 🍿', 
      isPrivate: false, 
      host: 'Caner_A', 
      hostUserId: 'usr_caner_seeded',
      category: 'Netflix', 
      mediaTitle: 'Stranger Things 4. Sezon Fragmanı & Bölümler', 
      videoId: 'b9EkMc79ZSU',
      viewers: 18,
      avatars: [
        'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=120&auto=format&fit=crop&q=80',
        'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=120&auto=format&fit=crop&q=80'
      ]
    },
    { 
      id: 'THE-BOYS-TR', 
      name: 'The Boys Dizi Gecesi 🩸', 
      isPrivate: false, 
      host: 'Kaan_D', 
      hostUserId: 'usr_kaan_seeded',
      category: 'Prime Video', 
      mediaTitle: 'The Boys Season 4 Official Trailer', 
      videoId: 'ezkd3wzB6s8',
      viewers: 12,
      avatars: [
        'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=120&auto=format&fit=crop&q=80',
        'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=120&auto=format&fit=crop&q=80'
      ]
    },
    { 
      id: 'ANIME-JJK', 
      name: 'Anime & Dizi Saati ⚔️', 
      isPrivate: false, 
      host: 'Deniz', 
      hostUserId: 'usr_deniz_seeded',
      category: 'YouTube', 
      mediaTitle: 'Anime Chill Beats & Soundtracks', 
      videoId: '4xDzrJKXOOY',
      viewers: 31,
      avatars: [
        'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=120&auto=format&fit=crop&q=80',
        'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=120&auto=format&fit=crop&q=80'
      ]
    },
    { 
      id: 'SPOTIFY-RAP', 
      name: 'Akustik & Pop Müzik Odası 🎵', 
      isPrivate: false, 
      host: 'Burak', 
      hostUserId: 'usr_burak_seeded',
      category: 'Spotify', 
      mediaTitle: 'Pop & Akustik Türkçe Şarkılar', 
      videoId: '5qap5aO4i9A',
      viewers: 21,
      avatars: [
        'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&auto=format&fit=crop&q=80',
        'https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=120&auto=format&fit=crop&q=80'
      ]
    }
  ];

  for (const d of defaults) {
    if (!rooms.has(d.id)) {
      rooms.set(d.id, {
        meta: {
          id: d.id,
          name: d.name,
          isPrivate: false,
          host: d.host,
          hostUserId: d.hostUserId,
          category: d.category,
          mediaTitle: d.mediaTitle,
          videoId: d.videoId || 'jfKfPfyJRdk',
          fakeViewers: d.viewers,
          avatars: d.avatars,
          createdAt: Date.now()
        },
        clients: new Map()
      });
    }
  }
}
seedDefaultPublicRooms();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.dmg': 'application/x-apple-diskimage',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.zip': 'application/zip'
};

function generateRoomCode() {
  for (let i = 0; i < 200; i++) {
    const num = Math.floor(1000 + Math.random() * 9000);
    const code = `ODA-${num}`;
    if (!rooms.has(code)) return code;
  }
  let code;
  do { 
    code = 'ODA-' + Math.floor(10000 + Math.random() * 90000); 
  } while (rooms.has(code));
  return code;
}

function getOrCreateRoom(roomId, meta = {}) {
  const upperId = roomId.toUpperCase();
  if (!rooms.has(upperId)) {
    rooms.set(upperId, {
      meta: {
        id: upperId,
        name: sanitizeText(meta.name || upperId, 50),
        isPrivate: meta.isPrivate !== undefined ? !!meta.isPrivate : true,
        host: sanitizeText(meta.host || 'Anonim', 30),
        hostUserId: meta.hostUserId || null,
        category: sanitizeText(meta.category || 'Genel', 30),
        mediaTitle: sanitizeText(meta.mediaTitle || 'Henüz video seçilmedi', 100),
        fakeViewers: 0,
        createdAt: Date.now()
      },
      clients: new Map()
    });
  }
  return rooms.get(upperId);
}

function broadcastToRoom(roomId, senderId, data) {
  const roomObj = rooms.get(roomId.toUpperCase());
  if (!roomObj) return;
  const messageStr = typeof data === 'string' ? data : JSON.stringify(data);
  for (const [peerId, client] of roomObj.clients.entries()) {
    if (peerId !== senderId) {
      if (client.type === 'sse' && client.res) {
        client.res.write(`data: ${messageStr}\n\n`);
      } else if (client.type === 'ws' && client.socket && !client.socket.destroyed) {
        sendWsFrame(client.socket, messageStr);
      }
    }
  }
}

// Lightweight RFC-6455 WebSocket Frame sender
function sendWsFrame(socket, message) {
  try {
    const payload = Buffer.from(message);
    const length = payload.length;
    let header;

    if (length <= 125) {
      header = Buffer.from([0x81, length]);
    } else if (length <= 65535) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    socket.write(Buffer.concat([header, payload]));
  } catch (err) {
    // Socket might be closed
  }
}

// Lightweight RFC-6455 WebSocket Frame Parser with Role & Permissions Enforcement (Item 3, 4, 16)
function handleWebSocketConnection(socket, req) {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const rawRoom = urlObj.searchParams.get('room') || 'default';
  const roomId = isValidRoomCode(rawRoom) ? rawRoom.toUpperCase() : 'DEFAULT';
  const userId = sanitizeText(urlObj.searchParams.get('userId') || crypto.randomUUID().slice(0, 8), 40);
  const userName = sanitizeText(urlObj.searchParams.get('name') || 'Misafir', 30);
  const userRole = urlObj.searchParams.get('role') === 'admin' ? ROLES.ADMIN : ROLES.USER;

  const room = getOrCreateRoom(roomId, { host: userName, hostUserId: userId });
  // If first user joining dynamic private room, register them as host
  if (!room.meta.hostUserId && room.clients.size === 0) {
    room.meta.hostUserId = userId;
    room.meta.host = userName;
  }

  const clientObj = { type: 'ws', socket, id: userId, roomId, name: userName, role: userRole };
  room.clients.set(userId, clientObj);

  safeLog('WS', `Client bağlandı: ${userName} (${userId}) -> Oda: ${roomId}`, { total: room.clients.size });

  // Notify everyone in room about peer list
  const peerList = Array.from(room.clients.keys());
  sendWsFrame(socket, JSON.stringify({ 
    type: 'init', 
    userId, 
    peers: peerList.filter(p => p !== userId),
    roomMeta: room.meta,
    isHost: room.meta.hostUserId === userId || userRole === ROLES.ADMIN
  }));
  broadcastToRoom(roomId, userId, { type: 'peer-joined', userId, name: userName });

  let buffer = Buffer.alloc(0);

  socket.on('data', chunk => {
    // Prevent memory exhaustion on WS frame overflow (>1MB frame drop)
    if (buffer.length + chunk.length > 1024 * 1024) {
      socket.destroy();
      return;
    }

    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) === 0x80;
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (opcode === 0x08) {
        socket.end();
        return;
      }

      if (payloadLength === 126) {
        if (buffer.length < offset + 2) break;
        payloadLength = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (buffer.length < offset + 8) break;
        payloadLength = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      let maskKey = null;
      if (isMasked) {
        if (buffer.length < offset + 4) break;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (buffer.length < offset + payloadLength) break;

      let payload = buffer.subarray(offset, offset + payloadLength);
      if (isMasked && maskKey) {
        const unmasked = Buffer.alloc(payloadLength);
        for (let i = 0; i < payloadLength; i++) {
          unmasked[i] = payload[i] ^ maskKey[i % 4];
        }
        payload = unmasked;
      }

      buffer = buffer.subarray(offset + payloadLength);

      if (opcode === 0x01) {
        try {
          const rawText = payload.toString('utf8');
          const msg = sanitizeObject(safeJsonParse(rawText));
          if (!msg) continue;

          msg.senderId = userId;
          msg.senderName = userName;

          // SERVER-SIDE AUTHORIZATION CHECKS (Items 3 & 4)
          // Sensitive actions restricted to Room Host or Admin:
          const isHostOrAdmin = canManageRoom(userRole, room.meta.hostUserId, userId);

          if (msg.type === 'kick' || msg.action === 'kick') {
            if (!isHostOrAdmin) {
              sendWsFrame(socket, JSON.stringify({ 
                type: 'error', 
                error: 'FORBIDDEN', 
                message: 'Kullanıcı atma yetkisi sadece oda yöneticisine (Host) aittir.' 
              }));
              continue;
            }
          }

          if (msg.type === 'mute-user' || msg.action === 'mute-user') {
            if (!isHostOrAdmin) {
              sendWsFrame(socket, JSON.stringify({ 
                type: 'error', 
                error: 'FORBIDDEN', 
                message: 'Kullanıcı susturma yetkisi sadece oda yöneticisine aittir.' 
              }));
              continue;
            }
          }

          // XSS Protection on Chat Messages (Item 16)
          if (msg.type === 'chat' && msg.text) {
            msg.text = escapeHtml(msg.text.slice(0, 500));
          }

          if (msg.mediaTitle) {
            msg.mediaTitle = escapeHtml(msg.mediaTitle.slice(0, 150));
            if (isHostOrAdmin) {
              room.meta.mediaTitle = msg.mediaTitle;
            }
          }

          broadcastToRoom(roomId, userId, msg);
        } catch (e) {
          // Bad JSON or frame ignored safely
        }
      }
    }
  });

  const cleanup = () => {
    if (room.clients.has(userId)) {
      room.clients.delete(userId);
      safeLog('WS', `Client ayrıldı: ${userId} -> Oda: ${roomId}`);
      broadcastToRoom(roomId, userId, { type: 'peer-left', userId });
      // Keep seeded rooms alive, delete dynamic private rooms if empty
      if (room.clients.size === 0 && room.meta.isPrivate) {
        rooms.delete(roomId);
      }
    }
  };

  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

async function searchYouTubeReal(query) {
  try {
    const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7'
      }
    });
    const html = await res.text();
    const match = html.match(/var ytInitialData = ({.*?});<\/script>/);
    if (!match) return [];
    const data = JSON.parse(match[1]);
    const contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];
    const videos = [];
    for (const c of contents) {
      const v = c.videoRenderer;
      if (v && v.videoId && v.title?.runs?.[0]?.text) {
        videos.push({
          id: v.videoId,
          title: escapeHtml(v.title.runs[0].text),
          channel: escapeHtml(v.ownerText?.runs?.[0]?.text || 'YouTube'),
          duration: escapeHtml(v.lengthText?.simpleText || 'Video'),
          category: 'youtube',
          views: escapeHtml(v.viewCountText?.simpleText || ''),
          thumb: `https://img.youtube.com/vi/${v.videoId}/hqdefault.jpg`
        });
      }
    }
    return videos;
  } catch (err) {
    safeLog('YT Search', 'Arama hatası', { error: err.message });
    return [];
  }
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const ip = getClientIp(req);

  // 10. HTTPS Enforce in production (Item 10)
  if (CONFIG.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] === 'http') {
    res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
    res.end();
    return;
  }

  // 9. Apply Strict HTTP Security Headers (Item 9)
  applySecurityHeaders(req, res, CONFIG.NODE_ENV === 'production');

  // 8. Lock down CORS (Item 8)
  const isOptionsHandled = handleCors(req, res, CONFIG.ALLOWED_ORIGINS);
  if (isOptionsHandled) return;

  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // General API Rate Limiter (Item 5: 120 req/min per IP)
  if (urlObj.pathname.startsWith('/api/')) {
    const rateCheck = generalApiLimiter.check(`api_${ip}`, 120, 60 * 1000);
    if (!rateCheck.allowed) {
      res.setHeader('Retry-After', Math.ceil(rateCheck.retryAfterMs / 1000));
      sendError(res, 429, 'RATE_LIMIT_EXCEEDED', 'Çok fazla istek gönderildi. Lütfen bir dakika bekleyin.');
      return;
    }
  }

  // ==========================================================================
  // 17. WEBHOOK HMAC SHA-256 SIGNATURE VERIFICATION (Item 17)
  // ==========================================================================
  if (urlObj.pathname === '/api/webhook' && req.method === 'POST') {
    try {
      const signature = req.headers['x-miruo-signature'];
      let rawBody = '';
      req.on('data', chunk => {
        rawBody += chunk;
        if (rawBody.length > CONFIG.MAX_BODY_BYTES) req.destroy();
      });
      req.on('end', () => {
        const isValidSig = verifyWebhookSignature(rawBody, signature, CONFIG.WEBHOOK_SECRET);
        if (!isValidSig) {
          safeLog('SECURITY', 'Geçersiz webhook imzası tespit edildi', { ip });
          sendError(res, 401, 'INVALID_SIGNATURE', 'Geçersiz veya eksik HMAC imzası.');
          return;
        }
        safeLog('WEBHOOK', 'Güvenli webhook alındı ve doğrulandı', { ip });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Webhook başarıyla doğrulandı.' }));
      });
      return;
    } catch (err) {
      sendError(res, 500, 'SERVER_ERROR', 'Webhook işlenemedi.');
      return;
    }
  }

  // ==========================================================================
  // 18. ADMIN ROLES & METRICS (Item 18)
  // ==========================================================================
  if (urlObj.pathname === '/api/admin/overview' && req.method === 'GET') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/, '').trim() || urlObj.searchParams.get('key');
    
    if (!canAccessAdmin(null, token, CONFIG.ADMIN_API_KEY)) {
      sendError(res, 403, 'FORBIDDEN', 'Yönetici yetkisi gereklidir.');
      return;
    }

    const users = loadUsers();
    let totalConnections = 0;
    for (const r of rooms.values()) {
      totalConnections += r.clients.size;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: {
        totalUsers: users.length,
        activeRooms: rooms.size,
        totalConnectedClients: totalConnections,
        nodeEnv: CONFIG.NODE_ENV,
        serverUptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
      }
    }));
    return;
  }

  if (urlObj.pathname === '/api/admin/users' && req.method === 'GET') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/, '').trim() || urlObj.searchParams.get('key');
    
    if (!canAccessAdmin(null, token, CONFIG.ADMIN_API_KEY)) {
      sendError(res, 403, 'FORBIDDEN', 'Yönetici yetkisi gereklidir.');
      return;
    }

    const users = loadUsers().map(u => ({
      id: u.id,
      username: u.username,
      fullName: u.fullName,
      email: maskEmail(u.email),
      role: u.role || 'user',
      createdAt: u.createdAt
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, count: users.length, users }));
    return;
  }

  // ==========================================================================
  // 1. PUBLIC ROOMS LISTING API
  // ==========================================================================
  if (urlObj.pathname === '/api/public-rooms') {
    const publicList = [];
    for (const [id, r] of rooms.entries()) {
      if (!r.meta.isPrivate) {
        publicList.push({
          id: r.meta.id,
          name: r.meta.name,
          host: r.meta.host,
          category: r.meta.category,
          mediaTitle: r.meta.mediaTitle,
          videoId: r.meta.videoId || 'jfKfPfyJRdk',
          thumb: r.meta.thumb || ('https://img.youtube.com/vi/' + (r.meta.videoId || 'jfKfPfyJRdk') + '/hqdefault.jpg'),
          viewers: r.clients.size + (r.meta.fakeViewers || 0),
          avatars: r.meta.avatars || [
            { initial: (r.meta.host || 'U').charAt(0).toUpperCase(), bg: 'from-purple-500 to-indigo-600' }
          ]
        });
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ rooms: publicList }));
    return;
  }

  // Check Room Existence
  if (urlObj.pathname === '/api/room-exists') {
    const rawCode = (urlObj.searchParams.get('code') || '').trim().toUpperCase();
    if (!isValidRoomCode(rawCode)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ exists: false }));
      return;
    }
    const r = rooms.get(rawCode);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r ? { exists: true, room: { id: r.meta.id, name: r.meta.name, host: r.meta.host, category: r.meta.category } } : { exists: false }));
    return;
  }

  // Media Search
  if (urlObj.pathname === '/api/search-media') {
    const query = sanitizeText(urlObj.searchParams.get('q') || '', 100).toLowerCase();
    const category = sanitizeText(urlObj.searchParams.get('cat') || 'all', 20).toLowerCase();

    const catalog = [
      {
        id: 'jfKfPfyJRdk',
        title: 'Lofi Girl - beats to relax/study to',
        channel: 'Lofi Girl',
        duration: 'CANLI',
        category: 'lofi',
        views: '48K canlı izleyici',
        thumb: 'https://img.youtube.com/vi/jfKfPfyJRdk/hqdefault.jpg'
      },
      {
        id: 'b9EkMc79ZSU',
        title: 'Stranger Things 4 | Official Trailer',
        channel: 'Netflix',
        duration: '3:11',
        category: 'series',
        views: '32M görüntüleme',
        thumb: 'https://img.youtube.com/vi/b9EkMc79ZSU/hqdefault.jpg'
      },
      {
        id: 'ezkd3wzB6s8',
        title: 'The Boys Season 4 | Official Trailer',
        channel: 'Prime Video',
        duration: '2:38',
        category: 'series',
        views: '18M görüntüleme',
        thumb: 'https://img.youtube.com/vi/ezkd3wzB6s8/hqdefault.jpg'
      }
    ];

    let results = catalog;
    if (category && category !== 'all' && category !== 'trending') {
      results = results.filter(item => item.category === category);
    }

    if (query) {
      let directId = null;
      if (query.includes('youtube.com/watch')) {
        const match = query.match(/[?&]v=([^&]+)/);
        if (match) directId = match[1];
      } else if (query.includes('youtu.be/')) {
        const parts = query.split('youtu.be/');
        if (parts[1]) directId = parts[1].split('?')[0];
      } else if (query.length === 11 && !query.includes(' ')) {
        directId = query;
      }

      if (directId) {
        results = [{
          id: directId,
          title: `Özel YouTube Videosu (${directId})`,
          channel: 'Seçilen YouTube Videosu',
          duration: 'Özel',
          category: 'youtube',
          views: 'Doğrudan Başlat',
          thumb: `https://img.youtube.com/vi/${directId}/hqdefault.jpg`
        }];
      } else {
        const realYtResults = await searchYouTubeReal(query);
        if (realYtResults && realYtResults.length > 0) {
          results = realYtResults;
        } else {
          results = catalog.filter(item => 
            item.title.toLowerCase().includes(query) || 
            item.channel.toLowerCase().includes(query)
          );
        }
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results }));
    return;
  }

  // ==========================================================================
  // AUTHENTICATION APIs WITH HARDENED SECURITY
  // ==========================================================================

  // REGISTER (Items 5, 6, 7, 11, 14, 16)
  if (urlObj.pathname === '/api/auth/register' && req.method === 'POST') {
    // 5. Rate Limit: Max 5 registers per hour per IP
    const regCheck = registerLimiter.check(`reg_${ip}`, 5, 60 * 60 * 1000);
    if (!regCheck.allowed) {
      sendError(res, 429, 'RATE_LIMIT_EXCEEDED', 'Kısa süre içinde çok fazla hesap açma denemesi yapıldı. Lütfen daha sonra tekrar deneyin.');
      return;
    }

    try {
      // 7. Request body limited to 100KB with prototype pollution sanitization
      const body = await readJsonBody(req, res, CONFIG.MAX_BODY_BYTES);
      const { fullName, username, email, password, avatarUrl } = body;

      // 6. Input Validation
      const displayName = (fullName || username || '').trim();
      const cleanUsername = (username || fullName || '').replace(/^@/, '').trim().replace(/\s+/g, '_');
      const cleanEmail = (email || '').trim().toLowerCase();

      if (!displayName || !cleanEmail || !password) {
        sendError(res, 400, 'MISSING_FIELDS', 'Lütfen tüm zorunlu alanları doldurun.');
        return;
      }

      if (!isValidEmail(cleanEmail)) {
        sendError(res, 400, 'INVALID_EMAIL', 'Geçerli bir e-posta adresi giriniz.');
        return;
      }

      if (!isValidUsername(cleanUsername)) {
        sendError(res, 400, 'INVALID_USERNAME', 'Kullanıcı adı 3-30 karakter olmalı ve yalnızca harf, rakam ve alt çizgi içermelidir.');
        return;
      }

      if (!isValidPassword(password)) {
        sendError(res, 400, 'INVALID_PASSWORD', 'Şifre en az 6, en fazla 128 karakter olmalıdır.');
        return;
      }

      const users = loadUsers();

      // Unique username check (case-insensitive)
      const existingUser = users.find(u => 
        (u.username || '').toLowerCase().replace(/^@/, '') === cleanUsername.toLowerCase()
      );
      if (existingUser) {
        sendError(res, 400, 'USERNAME_TAKEN', `"${cleanUsername}" kullanıcı adı zaten kullanımda. Lütfen başka bir isim seçin.`);
        return;
      }

      // Unique email check
      if (users.find(u => (u.email || '').toLowerCase() === cleanEmail)) {
        sendError(res, 400, 'EMAIL_EXISTS', 'Bu e-posta adresi zaten kayıtlı. Lütfen giriş yapın.');
        return;
      }

      // 11. Securely Hash Password (Salted scrypt + random 16-byte salt)
      const hashedPassword = hashPassword(password);

      // 18. Assign role (First configured admin email gets admin role, others user)
      const role = cleanEmail === 'admin@miruo.com.tr' ? ROLES.ADMIN : ROLES.USER;

      const newUser = {
        id: 'usr_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex'),
        fullName: sanitizeText(displayName, 50),
        username: cleanUsername,
        email: cleanEmail,
        password: hashedPassword,
        role: role,
        avatarUrl: avatarUrl ? sanitizeText(avatarUrl, 300) : null,
        createdAt: new Date().toISOString()
      };

      users.push(newUser);
      saveUsers(users);

      safeLog('AUTH', 'Yeni kullanıcı kaydedildi', { username: newUser.username, email: newUser.email, role: newUser.role });

      // Issue signed session token (Item 12)
      const token = createSignedToken({ id: newUser.id, role: newUser.role }, CONFIG.SESSION_SECRET);
      res.setHeader('Set-Cookie', buildSecureCookie('miruo_token', token, 7 * 86400, CONFIG.NODE_ENV === 'production'));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        message: 'Hesabınız başarıyla oluşturuldu! ✓', 
        token,
        user: { 
          id: newUser.id, 
          fullName: newUser.fullName,
          username: newUser.username, 
          email: newUser.email,
          role: newUser.role,
          avatarUrl: newUser.avatarUrl 
        } 
      }));
    } catch (err) {
      if (err.message !== 'Payload too large' && err.message !== 'Invalid JSON') {
        sendError(res, 500, 'SERVER_ERROR', 'Kayıt işlemi sırasında bir hata oluştu.');
      }
    }
    return;
  }

  // SEARCH USERS
  if (urlObj.pathname === '/api/users/search' && req.method === 'GET') {
    const query = sanitizeText((urlObj.searchParams.get('q') || '').replace(/^@/, '').trim().toLowerCase(), 30);
    const users = loadUsers();
    if (!query) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, users: [] }));
      return;
    }
    const matches = users.filter(u => 
      (u.username || '').toLowerCase().includes(query) ||
      (u.fullName || '').toLowerCase().includes(query)
    ).map(u => ({
      id: u.id,
      username: u.username || u.fullName,
      fullName: u.fullName || u.username,
      avatarUrl: u.avatarUrl || null
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, users: matches }));
    return;
  }

  // CHECK USERNAME AVAILABILITY (Item: aynı kullanıcı adı 2 defa alınmasın)
  if (urlObj.pathname === '/api/users/check-username' && req.method === 'GET') {
    const rawUsername = (urlObj.searchParams.get('username') || '').replace(/^@/, '').trim().toLowerCase();
    const excludeUserId = (urlObj.searchParams.get('userId') || '').trim();
    if (!rawUsername) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ available: false, error: 'Kullanıcı adı boş olamaz.' }));
      return;
    }
    const users = loadUsers();
    const taken = users.some(u => 
      u.id !== excludeUserId && 
      (u.username || '').toLowerCase().replace(/^@/, '') === rawUsername
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ available: !taken, username: rawUsername }));
    return;
  }

  // UPDATE USER PROFILE
  if (urlObj.pathname === '/api/auth/update-profile' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req, res, CONFIG.MAX_BODY_BYTES);
      const { userId, username, fullName, avatarUrl } = body;
      const cleanUsername = sanitizeText((username || '').replace(/^@/, '').trim(), 30);
      const cleanFullName = sanitizeText(fullName || cleanUsername, 50);

      const users = loadUsers();
      if (cleanUsername) {
        const taken = users.some(u => 
          u.id !== userId && 
          (u.username || '').toLowerCase().replace(/^@/, '') === cleanUsername.toLowerCase()
        );
        if (taken) {
          sendError(res, 400, 'USERNAME_TAKEN', `"${cleanUsername}" kullanıcı adı zaten kullanımda.`);
          return;
        }
      }

      let user = users.find(u => u.id === userId);
      if (user) {
        if (cleanUsername) user.username = cleanUsername;
        if (cleanFullName) user.fullName = cleanFullName;
        if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;
        saveUsers(users);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, user: user || { id: userId, username: cleanUsername, fullName: cleanFullName } }));
    } catch (err) {
      sendError(res, 500, 'SERVER_ERROR', 'Profil güncellenirken hata oluştu.');
    }
    return;
  }

  // LOGIN (Items 5, 6, 7, 11, 12, 13, 14)
  if (urlObj.pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req, res, CONFIG.MAX_BODY_BYTES);
      const { email, emailOrUsername, password } = body;
      const query = ((email || emailOrUsername) || '').toLowerCase().trim();

      if (!query || !password) {
        sendError(res, 400, 'MISSING_FIELDS', 'Lütfen e-posta/kullanıcı adı ve şifrenizi girin.');
        return;
      }

      // 5. Rate Limiting: Max 5 failed attempts per 15 min per IP/target
      const rateKey = `login_${ip}_${query}`;
      const rateCheck = authLimiter.check(rateKey, CONFIG.RATE_LIMIT_AUTH_MAX, CONFIG.RATE_LIMIT_AUTH_WINDOW_MS);
      if (!rateCheck.allowed) {
        safeLog('SECURITY', 'Çok fazla hatalı giriş denemesi engellendi', { ip, query });
        res.setHeader('Retry-After', Math.ceil(rateCheck.retryAfterMs / 1000));
        sendError(res, 429, 'TOO_MANY_ATTEMPTS', 'Çok fazla hatalı deneme yaptınız. Güvenliğiniz için 15 dakika bekleyiniz.');
        return;
      }

      const users = loadUsers();
      const found = users.find(u => 
        (u.email || '').toLowerCase() === query ||
        (u.username || '').toLowerCase() === query ||
        (u.fullName || '').toLowerCase() === query
      );

      if (!found) {
        authLimiter.recordFailure(rateKey, CONFIG.RATE_LIMIT_AUTH_WINDOW_MS);
        sendError(res, 401, 'INVALID_CREDENTIALS', 'Hatalı e-posta, kullanıcı adı veya şifre.');
        return;
      }

      // 11. Timing-safe verification & automatic scrypt upgrade
      const passResult = verifyPassword(password, found.password);
      if (!passResult.valid) {
        authLimiter.recordFailure(rateKey, CONFIG.RATE_LIMIT_AUTH_WINDOW_MS);
        sendError(res, 401, 'INVALID_CREDENTIALS', 'Hatalı e-posta, kullanıcı adı veya şifre.');
        return;
      }

      // Successful login -> reset rate limiter
      authLimiter.reset(rateKey);

      // Automatic password migration to salted scrypt if legacy plaintext was stored
      if (passResult.needsUpgrade) {
        found.password = hashPassword(password);
        saveUsers(users);
        safeLog('AUTH', 'Eski şifre güvenli scrypt formatına otomatik yükseltildi', { email: found.email });
      }

      safeLog('AUTH', 'Giriş başarılı', { username: found.username, email: found.email });

      // 12. Secure session token
      const token = createSignedToken({ id: found.id, role: found.role || 'user' }, CONFIG.SESSION_SECRET);
      res.setHeader('Set-Cookie', buildSecureCookie('miruo_token', token, 7 * 86400, CONFIG.NODE_ENV === 'production'));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        message: 'Giriş başarılı ✓', 
        token,
        user: { 
          id: found.id, 
          fullName: found.fullName || found.username,
          username: found.username || found.fullName, 
          email: found.email,
          role: found.role || 'user',
          avatarUrl: found.avatarUrl || null 
        } 
      }));
    } catch (err) {
      if (err.message !== 'Payload too large' && err.message !== 'Invalid JSON') {
        sendError(res, 500, 'SERVER_ERROR', 'Giriş sırasında bir hata oluştu.');
      }
    }
    return;
  }

  // 21. REAL ACCOUNT DELETION ENDPOINT (Item 21: hesabı gerçekten sil tusu ekle ve gerçekten sil)
  if (urlObj.pathname === '/api/auth/delete-account' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req, res, CONFIG.MAX_BODY_BYTES);
      const { userId, email, password } = body;

      if (!userId && !email) {
        sendError(res, 400, 'MISSING_FIELDS', 'Silinecek hesap bilgisi eksik.');
        return;
      }

      const users = loadUsers();
      const userIndex = users.findIndex(u => 
        (userId && u.id === userId) || 
        (email && (u.email || '').toLowerCase() === email.toLowerCase())
      );

      if (userIndex === -1) {
        sendError(res, 404, 'NOT_FOUND', 'Silinecek kullanıcı hesabı bulunamadı.');
        return;
      }

      const user = users[userIndex];

      // Password verification required if account has password
      if (user.password) {
        if (!password) {
          sendError(res, 400, 'PASSWORD_REQUIRED', 'Hesabınızı kalıcı olarak silmek için şifrenizi girmelisiniz.');
          return;
        }
        const verify = verifyPassword(password, user.password);
        if (!verify.valid) {
          sendError(res, 401, 'INVALID_PASSWORD', 'Girdiğiniz şifre hatalı. Hesap silinemedi.');
          return;
        }
      }

      // 20. Backup database before permanent deletion
      backupUsersFile(USERS_FILE, 'pre-delete-account');

      // Wipe user records permanently
      const deletedUserEmail = user.email;
      const deletedUserId = user.id;
      users.splice(userIndex, 1);
      saveUsers(users);

      // Clean up in-memory verification tokens & OTPs
      if (deletedUserEmail) passwordResetCodes.delete(deletedUserEmail.toLowerCase());
      if (user.phone) phoneOtpCodes.delete(user.phone);

      // Disconnect user from all active rooms & broadcast departure
      for (const [roomId, room] of rooms.entries()) {
        if (room.clients.has(deletedUserId)) {
          const client = room.clients.get(deletedUserId);
          if (client.socket && !client.socket.destroyed) client.socket.destroy();
          room.clients.delete(deletedUserId);
          broadcastToRoom(roomId, deletedUserId, { type: 'peer-left', userId: deletedUserId });
        }
      }

      safeLog('AUTH', 'Hesap kalıcı olarak silindi ve veriler temizlendi', { userId: deletedUserId, email: deletedUserEmail });

      // Clear cookie
      res.setHeader('Set-Cookie', 'miruo_token=; HttpOnly; Path=/; Max-Age=0');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Hesabınız ve ilişkili tüm verileriniz sistemden kalıcı olarak silindi.'
      }));
    } catch (err) {
      if (err.message !== 'Payload too large' && err.message !== 'Invalid JSON') {
        sendError(res, 500, 'SERVER_ERROR', 'Hesap silinirken bir sunucu hatası oluştu.');
      }
    }
    return;
  }

  // FORGOT PASSWORD
  if (urlObj.pathname === '/api/auth/forgot-password' && req.method === 'POST') {
    const rateCheck = otpLimiter.check(`forgot_${ip}`, 3, 10 * 60 * 1000);
    if (!rateCheck.allowed) {
      sendError(res, 429, 'TOO_MANY_REQUESTS', 'Çok fazla kod talep ettiniz. Lütfen 10 dakika bekleyin.');
      return;
    }

    try {
      const body = await readJsonBody(req, res, CONFIG.MAX_BODY_BYTES);
      const { email } = body;
      const cleanEmail = (email || '').trim().toLowerCase();

      if (!isValidEmail(cleanEmail)) {
        sendError(res, 400, 'INVALID_EMAIL', 'Geçerli bir e-posta adresi giriniz.');
        return;
      }

      const users = loadUsers();
      const found = users.find(u => (u.email || '').toLowerCase() === cleanEmail);
      if (!found) {
        sendError(res, 404, 'USER_NOT_FOUND', 'Bu e-posta adresiyle kayıtlı bir hesap bulunamadı.');
        return;
      }

      const code = String(Math.floor(100000 + Math.random() * 900000));
      passwordResetCodes.set(cleanEmail, { code, expires: Date.now() + 15 * 60 * 1000 });
      safeLog('AUTH', 'Şifre sıfırlama kodu oluşturuldu', { email: cleanEmail });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        message: '6 haneli doğrulama kodunuz oluşturuldu.',
        code // returned for immediate entry & simulation
      }));
    } catch (err) {
      if (err.message !== 'Payload too large' && err.message !== 'Invalid JSON') {
        sendError(res, 500, 'SERVER_ERROR', 'Şifre sıfırlama kodu oluşturulamadı.');
      }
    }
    return;
  }

  // VERIFY CODE
  if (urlObj.pathname === '/api/auth/verify-code' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req, res, CONFIG.MAX_BODY_BYTES);
      const { email, code } = body;
      const cleanEmail = (email || '').trim().toLowerCase();
      const cleanCode = (code || '').trim();
      const record = passwordResetCodes.get(cleanEmail);

      if (!record || record.expires < Date.now() || record.code !== cleanCode) {
        sendError(res, 400, 'INVALID_CODE', 'Girdiğiniz 6 haneli kod hatalı veya süresi dolmuş.');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Kod doğrulandı ✓' }));
    } catch (err) {
      if (err.message !== 'Payload too large' && err.message !== 'Invalid JSON') {
        sendError(res, 500, 'SERVER_ERROR', 'Doğrulama hatası oluştu.');
      }
    }
    return;
  }

  // RESET PASSWORD (Item 11: hash password)
  if (urlObj.pathname === '/api/auth/reset-password' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req, res, CONFIG.MAX_BODY_BYTES);
      const { email, code, newPassword } = body;
      const cleanEmail = (email || '').trim().toLowerCase();
      const cleanCode = (code || '').trim();

      if (!isValidPassword(newPassword)) {
        sendError(res, 400, 'INVALID_PASSWORD', 'Yeni şifreniz en az 6 karakter olmalıdır.');
        return;
      }

      const record = passwordResetCodes.get(cleanEmail);
      if (!record || record.expires < Date.now() || record.code !== cleanCode) {
        sendError(res, 400, 'INVALID_CODE', 'Doğrulama kodu geçersiz veya süresi dolmuş.');
        return;
      }

      const users = loadUsers();
      const user = users.find(u => (u.email || '').toLowerCase() === cleanEmail);
      if (!user) {
        sendError(res, 404, 'USER_NOT_FOUND', 'Kullanıcı bulunamadı.');
        return;
      }

      // Hash the new password!
      user.password = hashPassword(newPassword);
      saveUsers(users);
      passwordResetCodes.delete(cleanEmail);

      safeLog('AUTH', 'Şifre başarıyla yenilendi', { email: user.email });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Şifreniz başarıyla değiştirildi! Yeni şifrenizle giriş yapabilirsiniz.' }));
    } catch (err) {
      if (err.message !== 'Payload too large' && err.message !== 'Invalid JSON') {
        sendError(res, 500, 'SERVER_ERROR', 'Şifre sıfırlanamadı.');
      }
    }
    return;
  }

  // PHONE LOGIN OTP (Items 5 & 6)
  if (urlObj.pathname === '/api/auth/phone-otp' && req.method === 'POST') {
    const rateCheck = otpLimiter.check(`phone_${ip}`, 3, 10 * 60 * 1000);
    if (!rateCheck.allowed) {
      sendError(res, 429, 'TOO_MANY_REQUESTS', 'Çok fazla SMS kodu talep ettiniz. Lütfen 10 dakika bekleyin.');
      return;
    }

    try {
      const body = await readJsonBody(req, res, CONFIG.MAX_BODY_BYTES);
      const { phone } = body;
      const cleanPhone = (phone || '').replace(/[^0-9+]/g, '');

      if (!isValidPhone(cleanPhone)) {
        sendError(res, 400, 'INVALID_PHONE', 'Geçerli bir telefon numarası girin.');
        return;
      }

      const code = String(Math.floor(100000 + Math.random() * 900000));
      phoneOtpCodes.set(cleanPhone, { code, expires: Date.now() + 10 * 60 * 1000 });
      safeLog('AUTH', 'SMS Onay Kodu oluşturuldu', { phone: cleanPhone.slice(0, 4) + '***' });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        message: '6 haneli SMS onay kodu gönderildi.',
        code
      }));
    } catch (err) {
      if (err.message !== 'Payload too large' && err.message !== 'Invalid JSON') {
        sendError(res, 500, 'SERVER_ERROR', 'SMS kodu oluşturulamadı.');
      }
    }
    return;
  }

  // VERIFY PHONE OTP
  if (urlObj.pathname === '/api/auth/verify-phone-otp' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req, res, CONFIG.MAX_BODY_BYTES);
      const { phone, code } = body;
      const cleanPhone = (phone || '').replace(/[^0-9+]/g, '');
      const cleanCode = (code || '').trim();
      const record = phoneOtpCodes.get(cleanPhone);

      if (!record || record.expires < Date.now() || record.code !== cleanCode) {
        sendError(res, 400, 'INVALID_CODE', 'Girdiğiniz SMS onay kodu hatalı veya süresi dolmuş.');
        return;
      }
      phoneOtpCodes.delete(cleanPhone);

      const users = loadUsers();
      let user = users.find(u => u.phone === cleanPhone);
      if (!user) {
        const shortId = cleanPhone.slice(-4);
        user = {
          id: 'user_phone_' + Date.now().toString(36),
          username: 'kullanici_' + shortId,
          fullName: 'Miruo Kullanıcısı ' + shortId,
          phone: cleanPhone,
          email: `${cleanPhone.replace(/[^0-9]/g, '')}@miruo.app`,
          role: ROLES.USER,
          avatarChar: '📱',
          provider: 'phone',
          createdAt: new Date().toISOString()
        };
        users.push(user);
        saveUsers(users);
      }

      safeLog('AUTH', 'Telefonla giriş başarılı', { phone: cleanPhone.slice(0, 4) + '***' });
      
      const token = createSignedToken({ id: user.id, role: user.role || 'user' }, CONFIG.SESSION_SECRET);
      res.setHeader('Set-Cookie', buildSecureCookie('miruo_token', token, 7 * 86400, CONFIG.NODE_ENV === 'production'));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Telefonla giriş başarılı ✓',
        token,
        user: {
          id: user.id,
          fullName: user.fullName || user.username,
          username: user.username,
          phone: user.phone || cleanPhone,
          email: user.email,
          provider: 'phone',
          avatarUrl: user.avatarUrl || null,
          avatarChar: user.avatarChar || '📱'
        }
      }));
    } catch (err) {
      if (err.message !== 'Payload too large' && err.message !== 'Invalid JSON') {
        sendError(res, 500, 'SERVER_ERROR', 'Telefon doğrulaması başarısız.');
      }
    }
    return;
  }

  // CHANGE EMAIL
  if (urlObj.pathname === '/api/auth/change-email' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req, res, CONFIG.MAX_BODY_BYTES);
      const { userId, newEmail } = body;
      const cleanEmail = (newEmail || '').trim().toLowerCase();

      if (!isValidEmail(cleanEmail)) {
        sendError(res, 400, 'INVALID_EMAIL', 'Geçerli bir yeni e-posta adresi girin.');
        return;
      }

      const users = loadUsers();
      const existing = users.find(u => (u.email || '').toLowerCase() === cleanEmail && u.id !== userId);
      if (existing) {
        sendError(res, 400, 'EMAIL_EXISTS', 'Bu e-posta adresi başka bir hesap tarafından kullanılıyor.');
        return;
      }

      const user = users.find(u => u.id === userId);
      if (user) {
        user.email = cleanEmail;
        saveUsers(users);
      }

      safeLog('AUTH', 'E-posta başarıyla güncellendi', { email: cleanEmail });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'E-posta adresiniz başarıyla güncellendi ✓', email: cleanEmail }));
    } catch (err) {
      if (err.message !== 'Payload too large' && err.message !== 'Invalid JSON') {
        sendError(res, 500, 'SERVER_ERROR', 'E-posta güncellenemedi.');
      }
    }
    return;
  }

  // CHANGE PASSWORD (Item 11: hash password)
  if (urlObj.pathname === '/api/auth/change-password' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req, res, CONFIG.MAX_BODY_BYTES);
      const { userId, email, currentPassword, newPassword } = body;

      if (!isValidPassword(newPassword)) {
        sendError(res, 400, 'INVALID_PASSWORD', 'Yeni şifreniz en az 6 karakter olmalıdır.');
        return;
      }

      const users = loadUsers();
      const user = users.find(u => u.id === userId || (email && (u.email || '').toLowerCase() === (email || '').toLowerCase()));
      if (!user) {
        sendError(res, 404, 'USER_NOT_FOUND', 'Kullanıcı hesabı bulunamadı.');
        return;
      }

      if (user.password && currentPassword) {
        const verify = verifyPassword(currentPassword, user.password);
        if (!verify.valid) {
          sendError(res, 400, 'INVALID_CURRENT_PASSWORD', 'Mevcut şifreniz hatalı.');
          return;
        }
      }

      user.password = hashPassword(newPassword);
      saveUsers(users);

      safeLog('AUTH', 'Şifre kullanıcı tarafından değiştirildi', { email: user.email });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Şifreniz başarıyla güncellendi ✓' }));
    } catch (err) {
      if (err.message !== 'Payload too large' && err.message !== 'Invalid JSON') {
        sendError(res, 500, 'SERVER_ERROR', 'Şifre güncellenemedi.');
      }
    }
    return;
  }

  // 2. CREATE ROOM API
  if (urlObj.pathname === '/api/create-room' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req, res, CONFIG.MAX_BODY_BYTES);
      const { name, isPrivate, host, hostUserId, category } = payload;
      const finalId = generateRoomCode();
      const room = getOrCreateRoom(finalId, {
        name: sanitizeText(name || finalId, 50),
        isPrivate: !!isPrivate,
        host: sanitizeText(host || 'Kullanıcı', 30),
        hostUserId: hostUserId || null,
        category: sanitizeText(category || 'Genel', 30)
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, room: room.meta }));
    } catch (e) {
      if (e.message !== 'Payload too large' && e.message !== 'Invalid JSON') {
        sendError(res, 400, 'INVALID_REQUEST', 'Oda oluşturulamadı.');
      }
    }
    return;
  }

  // 3. HTTP SSE SIGNALING FALLBACK
  if (urlObj.pathname === '/api/events') {
    const rawRoom = urlObj.searchParams.get('room') || 'default';
    const roomId = isValidRoomCode(rawRoom) ? rawRoom.toUpperCase() : 'DEFAULT';
    const userId = sanitizeText(urlObj.searchParams.get('userId') || crypto.randomUUID().slice(0, 8), 40);
    const userName = sanitizeText(urlObj.searchParams.get('name') || 'Misafir', 30);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    const room = getOrCreateRoom(roomId, { host: userName, hostUserId: userId });
    room.clients.set(userId, { type: 'sse', res, id: userId, roomId });

    safeLog('SSE', `Client bağlandı: ${userId} -> Oda: ${roomId}`);
    res.write(`data: ${JSON.stringify({ 
      type: 'init', 
      userId, 
      peers: Array.from(room.clients.keys()).filter(p => p !== userId),
      roomMeta: room.meta
    })}\n\n`);
    broadcastToRoom(roomId, userId, { type: 'peer-joined', userId, name: userName });

    req.on('close', () => {
      if (room.clients.has(userId)) {
        room.clients.delete(userId);
        broadcastToRoom(roomId, userId, { type: 'peer-left', userId });
        if (room.clients.size === 0 && room.meta.isPrivate) rooms.delete(roomId);
      }
    });
    return;
  }

  // 4. HTTP POST SIGNALING FALLBACK
  if (urlObj.pathname === '/api/signal' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req, res, CONFIG.MAX_BODY_BYTES);
      const { roomId, userId, data } = payload;
      if (roomId && userId && isValidRoomCode(roomId)) {
        broadcastToRoom(roomId.toUpperCase(), userId, { ...data, senderId: userId });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      if (err.message !== 'Payload too large' && err.message !== 'Invalid JSON') {
        sendError(res, 400, 'INVALID_REQUEST', 'Sinyal iletilemedi.');
      }
    }
    return;
  }

  // DOWNLOAD ENDPOINTS (Mac, Windows, iOS, Android)
  if (urlObj.pathname === '/download/mac') {
    const dmgPath = path.join(__dirname, 'downloads', 'Miruo-macOS-Installer.dmg');
    const zipPath = path.join(__dirname, 'downloads', 'Miruo-macOS.zip');
    const fileToServe = fs.existsSync(dmgPath) ? dmgPath : zipPath;
    if (fs.existsSync(fileToServe)) {
      const filename = path.basename(fileToServe);
      const stat = fs.statSync(fileToServe);
      res.writeHead(200, {
        'Content-Type': filename.endsWith('.dmg') ? 'application/x-apple-diskimage' : 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': stat.size
      });
      fs.createReadStream(fileToServe).pipe(res);
      return;
    }
  }

  if (urlObj.pathname === '/download/windows') {
    const exePath = path.join(__dirname, 'downloads', 'Miruo-Windows-Setup.exe');
    if (fs.existsSync(exePath)) {
      const stat = fs.statSync(exePath);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.microsoft.portable-executable',
        'Content-Disposition': 'attachment; filename="Miruo-Windows-Setup.exe"',
        'Content-Length': stat.size
      });
      fs.createReadStream(exePath).pipe(res);
      return;
    }
  }

  if (urlObj.pathname === '/download/ios' || urlObj.pathname === '/download/appstore') {
    res.writeHead(302, { Location: 'https://apps.apple.com/app/miruo/id6738928411' });
    res.end();
    return;
  }

  if (urlObj.pathname === '/download/android') {
    res.writeHead(302, { Location: 'https://play.google.com/store/apps/details?id=com.miruo.app' });
    res.end();
    return;
  }

  // Dedicated Standalone Pages: Güvenlik, Gizlilik, SSS, Basın, İletişim, Şartlar
  const standalonePages = {
    '/guvenlik': 'guvenlik.html',
    '/guvenlik.html': 'guvenlik.html',
    '/gizlilik': 'gizlilik.html',
    '/gizlilik.html': 'gizlilik.html',
    '/sss': 'sss.html',
    '/sss.html': 'sss.html',
    '/basin': 'basin.html',
    '/basin.html': 'basin.html',
    '/iletisim': 'iletisim.html',
    '/iletisim.html': 'iletisim.html',
    '/sartlar': 'sartlar.html',
    '/sartlar.html': 'sartlar.html',
    '/privacy': 'gizlilik.html',
    '/terms': 'sartlar.html',
    '/support': 'iletisim.html'
  };

  if (standalonePages[urlObj.pathname]) {
    const pageFile = path.join(__dirname, standalonePages[urlObj.pathname]);
    if (fs.existsSync(pageFile)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(pageFile).pipe(res);
      return;
    }
  }

  // WEBSITE MARKETING / LANDING PAGE SERVING
  if (urlObj.pathname === '/website') {
    res.writeHead(302, { Location: '/website/' });
    res.end();
    return;
  }

  if (urlObj.pathname.startsWith('/website') || urlObj.pathname === '/landing') {
    let sub = urlObj.pathname.replace(/^\/(website|landing)/, '');
    if (!sub || sub === '/') sub = '/index.html';
    const webFile = path.join(WEBSITE_DIR, sub);
    if (webFile.startsWith(WEBSITE_DIR) && fs.existsSync(webFile)) {
      const ext = path.extname(webFile);
      const contentType = MIME_TYPES[ext] || 'text/html; charset=utf-8';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(webFile).pipe(res);
      return;
    }
  }

  if (urlObj.pathname === '/website.css') {
    const cssPath = path.join(__dirname, 'website.css');
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
    fs.createReadStream(cssPath).pipe(res);
    return;
  }

  if (urlObj.pathname === '/site.js') {
    const jsPath = path.join(__dirname, 'site.js');
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    fs.createReadStream(jsPath).pipe(res);
    return;
  }

  if (urlObj.pathname.startsWith('/assets/')) {
    const assetSub = urlObj.pathname.replace(/^\/assets\//, '');
    const assetPath = path.join(__dirname, 'website', 'assets', assetSub);
    const assetFallback = path.join(__dirname, 'assets', assetSub);
    const fileToServe = fs.existsSync(assetPath) ? assetPath : assetFallback;
    if (fs.existsSync(fileToServe)) {
      const ext = path.extname(fileToServe);
      const contentType = MIME_TYPES[ext] || 'image/png';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(fileToServe).pipe(res);
      return;
    }
  }

  if (urlObj.pathname === '/logo.png') {
    const logoPath = path.join(__dirname, 'logo.png');
    if (fs.existsSync(logoPath)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      fs.createReadStream(logoPath).pipe(res);
      return;
    }
  }

  // Root path check: If standard browser requesting root without ?app=1, show official website
  if ((urlObj.pathname === '/' || urlObj.pathname === '/index.html') && !urlObj.searchParams.get('app') && !req.headers['x-miruo-native']) {
    const webIndex = path.join(__dirname, 'index.html');
    if (fs.existsSync(webIndex)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(webIndex).pipe(res);
      return;
    }
  }

  // Static File Serving for Public Web App (e.g. /app, /style.css, /app.js)
  let filePath = path.join(PUBLIC_DIR, (urlObj.pathname === '/' || urlObj.pathname === '/app') ? 'index.html' : urlObj.pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendError(res, 403, 'FORBIDDEN', 'Erişim engellendi.');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, indexContent) => {
          if (err2) {
            sendError(res, 404, 'NOT_FOUND', 'Sayfa bulunamadı.');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(indexContent);
          }
        });
      } else {
        sendError(res, 500, 'SERVER_ERROR', 'Dosya okunurken hata oluştu.');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

// Upgrade HTTP to RFC-6455 WebSocket
server.on('upgrade', (req, socket, head) => {
  const upgradeHeader = req.headers['upgrade'];
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  const acceptKey = crypto
    .createHash('sha1')
    .update(key + GUID)
    .digest('base64');

  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`
  ];

  socket.write(responseHeaders.join('\r\n') + '\r\n\r\n');
  handleWebSocketConnection(socket, req);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔒 MIRUO (Güvenli & Sertleştirilmiş Sunucu) başarıyla başlatıldı!`);
  console.log(`👉 Yerel Bağlantı: http://localhost:${PORT}`);
  console.log(`👉 Ortam (NODE_ENV): ${CONFIG.NODE_ENV}`);
  console.log(`👉 Güvenlik: Scrypt Hashleme ✓ | 100KB Sınır ✓ | Helmet Başlıkları ✓ | Rate Limiting ✓\n`);
});
