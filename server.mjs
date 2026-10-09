import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const WEBSITE_DIR = path.join(__dirname, 'website');
const USERS_FILE = path.join(__dirname, 'data', 'users.json');

function loadUsers() {
  try {
    if (!fs.existsSync(path.dirname(USERS_FILE))) {
      fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
    }
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading users:', err);
  }
  return [];
}

function saveUsers(users) {
  try {
    if (!fs.existsSync(path.dirname(USERS_FILE))) {
      fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
    }
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving users:', err);
  }
}

const PORT = process.env.PORT || 3000;

// Rooms store: roomId -> { meta: { id, name, isPrivate, host, category, mediaTitle }, clients: Map }
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
  '.ico': 'image/x-icon'
};

// Random, impersonal room codes: ODA-XXXX (e.g. ODA-7492 or ODA-8319).
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
        name: meta.name || upperId,
        isPrivate: meta.isPrivate !== undefined ? meta.isPrivate : true,
        host: meta.host || 'Anonim',
        category: meta.category || 'Genel',
        mediaTitle: meta.mediaTitle || 'Henüz video seçilmedi',
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

// Lightweight RFC-6455 WebSocket Frame Parser
function handleWebSocketConnection(socket, req) {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const roomId = (urlObj.searchParams.get('room') || 'default').toUpperCase();
  const userId = urlObj.searchParams.get('userId') || crypto.randomUUID().slice(0, 8);
  const userName = urlObj.searchParams.get('name') || 'Misafir';

  const room = getOrCreateRoom(roomId, { host: userName });
  const clientObj = { type: 'ws', socket, id: userId, roomId, name: userName };
  room.clients.set(userId, clientObj);

  console.log(`[WS] Client joined: ${userName} (${userId}) -> Room: ${roomId} (Total: ${room.clients.size})`);

  // Notify everyone in room about peer list
  const peerList = Array.from(room.clients.keys());
  sendWsFrame(socket, JSON.stringify({ 
    type: 'init', 
    userId, 
    peers: peerList.filter(p => p !== userId),
    roomMeta: room.meta
  }));
  broadcastToRoom(roomId, userId, { type: 'peer-joined', userId, name: userName });

  let buffer = Buffer.alloc(0);

  socket.on('data', chunk => {
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
          const msg = JSON.parse(payload.toString('utf8'));
          msg.senderId = userId;
          if (msg.mediaTitle) {
            room.meta.mediaTitle = msg.mediaTitle;
          }
          broadcastToRoom(roomId, userId, msg);
        } catch (e) {
          console.error('Invalid WS payload json', e);
        }
      }
    }
  });

  const cleanup = () => {
    if (room.clients.has(userId)) {
      room.clients.delete(userId);
      console.log(`[WS] Client disconnected: ${userId} from ${roomId}`);
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
          title: v.title.runs[0].text,
          channel: v.ownerText?.runs?.[0]?.text || 'YouTube',
          duration: v.lengthText?.simpleText || 'Video',
          category: 'youtube',
          views: v.viewCountText?.simpleText || '',
          thumb: `https://img.youtube.com/vi/${v.videoId}/hqdefault.jpg`
        });
      }
    }
    return videos;
  } catch (err) {
    console.error('[YT Search] Hata:', err.message);
    return [];
  }
}

const server = http.createServer(async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const urlObj = new URL(req.url, `http://${req.headers.host}`);

  // 1. Public Rooms Listing API
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

  // 1.5 Media Search & Discovery API (YouTube & Curated Music / Video catalog)
  if (urlObj.pathname === '/api/room-exists') {
    const code = (urlObj.searchParams.get('code') || '').trim().toUpperCase();
    const r = rooms.get(code);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r ? { exists: true, room: { id: r.meta.id, name: r.meta.name, host: r.meta.host, category: r.meta.category } } : { exists: false }));
    return;
  }

  if (urlObj.pathname === '/api/search-media') {
    const query = (urlObj.searchParams.get('q') || '').toLowerCase().trim();
    const category = (urlObj.searchParams.get('cat') || 'all').toLowerCase();

    const catalog = [
      // Trendler & Popüler
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
      },
      {
        id: 'QdBZY2fkU-0',
        title: 'Grand Theft Auto VI Trailer 1',
        channel: 'Rockstar Games',
        duration: '1:31',
        category: 'gaming',
        views: '190M görüntüleme',
        thumb: 'https://img.youtube.com/vi/QdBZY2fkU-0/hqdefault.jpg'
      },
      {
        id: '4NRXx6U8ABQ',
        title: 'The Weeknd - Blinding Lights (Official Music Video)',
        channel: 'The Weeknd',
        duration: '4:20',
        category: 'music',
        views: '800M görüntüleme',
        thumb: 'https://img.youtube.com/vi/4NRXx6U8ABQ/hqdefault.jpg'
      },
      {
        id: 'TUVcZfQe-Kw',
        title: 'Dua Lipa - Levitating (Official Music Video)',
        channel: 'Dua Lipa',
        duration: '3:50',
        category: 'music',
        views: '750M görüntüleme',
        thumb: 'https://img.youtube.com/vi/TUVcZfQe-Kw/hqdefault.jpg'
      },
      {
        id: 'H5v3kku4y6Q',
        title: 'Harry Styles - As It Was (Official Video)',
        channel: 'Harry Styles',
        duration: '2:45',
        category: 'music',
        views: '620M görüntüleme',
        thumb: 'https://img.youtube.com/vi/H5v3kku4y6Q/hqdefault.jpg'
      },
      {
        id: 'kJQP7kiw5Fk',
        title: 'Luis Fonsi - Despacito ft. Daddy Yankee',
        channel: 'Luis Fonsi',
        duration: '4:42',
        category: 'music',
        views: '8.4B görüntüleme',
        thumb: 'https://img.youtube.com/vi/kJQP7kiw5Fk/hqdefault.jpg'
      },
      {
        id: 'kXYiU_JCYtU',
        title: 'Linkin Park - Numb (Official Music Video)',
        channel: 'Linkin Park',
        duration: '3:07',
        category: 'music',
        views: '2.2B görüntüleme',
        thumb: 'https://img.youtube.com/vi/kXYiU_JCYtU/hqdefault.jpg'
      },
      {
        id: 'OPf0YbXqDm0',
        title: 'Mark Ronson - Uptown Funk ft. Bruno Mars',
        channel: 'Mark Ronson',
        duration: '4:30',
        category: 'music',
        views: '5.1B görüntüleme',
        thumb: 'https://img.youtube.com/vi/OPf0YbXqDm0/hqdefault.jpg'
      },
      {
        id: 'JGwWNGJdvx8',
        title: 'Ed Sheeran - Shape of You (Official Music Video)',
        channel: 'Ed Sheeran',
        duration: '4:23',
        category: 'music',
        views: '6.2B görüntüleme',
        thumb: 'https://img.youtube.com/vi/JGwWNGJdvx8/hqdefault.jpg'
      },
      {
        id: 'uelHwf8o7_U',
        title: 'Eminem - Love The Way You Lie ft. Rihanna',
        channel: 'Eminem',
        duration: '4:26',
        category: 'music',
        views: '2.7B görüntüleme',
        thumb: 'https://img.youtube.com/vi/uelHwf8o7_U/hqdefault.jpg'
      },
      {
        id: 'pB-5XG-DbAA',
        title: 'Imagine Dragons - Believer (Official Music Video)',
        channel: 'ImagineDragons',
        duration: '3:36',
        category: 'music',
        views: '2.5B görüntüleme',
        thumb: 'https://img.youtube.com/vi/pB-5XG-DbAA/hqdefault.jpg'
      },
      {
        id: 'RgKAFK5djSk',
        title: 'Wiz Khalifa - See You Again ft. Charlie Puth',
        channel: 'Wiz Khalifa',
        duration: '3:57',
        category: 'music',
        views: '6.1B görüntüleme',
        thumb: 'https://img.youtube.com/vi/RgKAFK5djSk/hqdefault.jpg'
      },
      // 24/7 Lo-Fi & Gece Dinleme
      {
        id: 'rUxyKA_-grg',
        title: 'synthwave radio 🌌 - beats to chill/game to',
        channel: 'Lofi Girl Synthwave',
        duration: 'CANLI',
        category: 'lofi',
        views: '14K canlı izleyici',
        thumb: 'https://img.youtube.com/vi/rUxyKA_-grg/hqdefault.jpg'
      },
      {
        id: '5yx6BWlEVcY',
        title: 'Chillhop Radio - jazzy & lofi hip hop beats',
        channel: 'Chillhop Music',
        duration: 'CANLI',
        category: 'lofi',
        views: '8.5K canlı izleyici',
        thumb: 'https://img.youtube.com/vi/5yx6BWlEVcY/hqdefault.jpg'
      },
      {
        id: 'S_MOd40zlYU',
        title: 'Tokyo Night Drive - Japanese Lofi Beats',
        channel: 'Lofi Japan',
        duration: '1:02:14',
        category: 'lofi',
        views: '4.2M görüntüleme',
        thumb: 'https://img.youtube.com/vi/S_MOd40zlYU/hqdefault.jpg'
      },
      {
        id: 'WPni755-Krg',
        title: 'Warm Rainy Night - Cozy Cafe & Jazz Vibes',
        channel: 'Cozy Coffee Shop',
        duration: '2:15:30',
        category: 'lofi',
        views: '3.1M görüntüleme',
        thumb: 'https://img.youtube.com/vi/WPni755-Krg/hqdefault.jpg'
      },
      // Dizi & Fragmanlar
      {
        id: 'Way9Dexny3w',
        title: 'Dune: Part Two | Official Trailer',
        channel: 'Warner Bros. Pictures',
        duration: '2:54',
        category: 'series',
        views: '42M görüntüleme',
        thumb: 'https://img.youtube.com/vi/Way9Dexny3w/hqdefault.jpg'
      },
      {
        id: 'uYPbbksJxIg',
        title: 'Oppenheimer | Official Trailer',
        channel: 'Universal Pictures',
        duration: '3:05',
        category: 'series',
        views: '55M görüntüleme',
        thumb: 'https://img.youtube.com/vi/uYPbbksJxIg/hqdefault.jpg'
      },
      {
        id: '1JLUn2DFW4w',
        title: 'Gladiator II | Official Teaser Trailer',
        channel: 'Paramount Pictures',
        duration: '3:10',
        category: 'series',
        views: '30M görüntüleme',
        thumb: 'https://img.youtube.com/vi/1JLUn2DFW4w/hqdefault.jpg'
      },
      {
        id: 'HhesaQXLuRY',
        title: 'Breaking Bad - All Time Iconic Moments & Scenes',
        channel: 'Sony Pictures Television',
        duration: '14:22',
        category: 'series',
        views: '12M görüntüleme',
        thumb: 'https://img.youtube.com/vi/HhesaQXLuRY/hqdefault.jpg'
      },
      {
        id: 'd9MyW72ELq0',
        title: 'Avatar: The Way of Water | Official Trailer',
        channel: 'Avatar',
        duration: '2:28',
        category: 'series',
        views: '65M görüntüleme',
        thumb: 'https://img.youtube.com/vi/d9MyW72ELq0/hqdefault.jpg'
      },
      // Podcast & Talk
      {
        id: 'l_X_Ocxw3bU',
        title: 'Sam Altman: OpenAI, GPT-5, and AGI',
        channel: 'Lex Fridman Podcast',
        duration: '2:18:40',
        category: 'podcast',
        views: '4.8M görüntüleme',
        thumb: 'https://img.youtube.com/vi/l_X_Ocxw3bU/hqdefault.jpg'
      },
      {
        id: 'eBSeDu5Y-d8',
        title: 'How to Sleep Better & Boost Daily Energy',
        channel: 'Andrew Huberman',
        duration: '1:45:10',
        category: 'podcast',
        views: '6.2M görüntüleme',
        thumb: 'https://img.youtube.com/vi/eBSeDu5Y-d8/hqdefault.jpg'
      },
      {
        id: '3VzL0B5eW8U',
        title: 'The Psychology of High Performance',
        channel: 'The Diary Of A CEO',
        duration: '1:12:35',
        category: 'podcast',
        views: '2.9M görüntüleme',
        thumb: 'https://img.youtube.com/vi/3VzL0B5eW8U/hqdefault.jpg'
      },
      // Oyun & Espor
      {
        id: 'aM3ElTrVrcM',
        title: 'VALORANT Champions 2024 Cinematic',
        channel: 'VALORANT',
        duration: '3:45',
        category: 'gaming',
        views: '8.4M görüntüleme',
        thumb: 'https://img.youtube.com/vi/aM3ElTrVrcM/hqdefault.jpg'
      },
      {
        id: 'mDYqT0_9nJA',
        title: 'League of Legends: Warriors ft. Imagine Dragons',
        channel: 'League of Legends',
        duration: '3:27',
        category: 'gaming',
        views: '410M görüntüleme',
        thumb: 'https://img.youtube.com/vi/mDYqT0_9nJA/hqdefault.jpg'
      },
      {
        id: 'MmB9b5njVbA',
        title: 'Minecraft: 15 Years of Memories & Updates',
        channel: 'Minecraft',
        duration: '4:52',
        category: 'gaming',
        views: '11M görüntüleme',
        thumb: 'https://img.youtube.com/vi/MmB9b5njVbA/hqdefault.jpg'
      }
    ];

    let results = catalog;
    if (category && category !== 'all' && category !== 'trending') {
      results = results.filter(item => item.category === category);
    }

    if (query) {
      // Check if user entered a URL or video ID directly
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
        // Query REAL YouTube search!
        const realYtResults = await searchYouTubeReal(query);
        if (realYtResults && realYtResults.length > 0) {
          results = realYtResults;
        } else {
          const matched = catalog.filter(item => 
            item.title.toLowerCase().includes(query) || 
            item.channel.toLowerCase().includes(query) ||
            item.category.toLowerCase().includes(query)
          );
          results = matched.length > 0 ? matched : catalog.slice(0, 8);
        }
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results }));
    return;
  }

  // 1.8 Persistent Authentication API (Register, Login & Password Reset)
  if (urlObj.pathname === '/api/auth/register' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { fullName, username, email, password, avatarUrl } = JSON.parse(body);
        const displayName = (fullName || username || '').trim();
        const cleanEmail = (email || '').trim().toLowerCase();
        if (!displayName || !cleanEmail || !password) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Lütfen tüm zorunlu alanları doldurun.' }));
          return;
        }
        if (password.length < 6) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Şifre en az 6 karakter olmalıdır.' }));
          return;
        }
        const users = loadUsers();
        // 1. Unique Username Check: Her isim sadece bir kez kullanılabilir!
        const cleanUsername = displayName.replace(/^@/, '').toLowerCase();
        const existingName = users.find(u => 
          (u.username || '').toLowerCase().replace(/^@/, '') === cleanUsername ||
          (u.fullName || '').toLowerCase().replace(/^@/, '') === cleanUsername
        );
        if (existingName) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: false, 
            message: `"${displayName}" ismi zaten alınmış! Her isim platformda sadece bir kez kullanılabilir.` 
          }));
          return;
        }

        // 2. Unique Email Check
        if (users.find(u => (u.email || '').toLowerCase() === cleanEmail)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Bu e-posta adresi zaten kayıtlı. Lütfen giriş yapın.' }));
          return;
        }
        const newUser = {
          id: 'usr_' + Date.now().toString(36),
          fullName: displayName,
          username: displayName.replace(/^@/, ''),
          email: cleanEmail,
          password: password,
          avatarUrl: avatarUrl || null,
          createdAt: new Date().toISOString()
        };
        users.push(newUser);
        saveUsers(users);
        console.log(`[AUTH] Yeni kullanıcı kaydedildi: ${newUser.fullName} (@${newUser.username} - ${newUser.email})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: 'Hesabınız başarıyla oluşturuldu! ✓', 
          user: { 
            id: newUser.id, 
            fullName: newUser.fullName,
            username: newUser.username, 
            email: newUser.email,
            avatarUrl: newUser.avatarUrl 
          } 
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
    });
    return;
  }

  // Search User by Unique Username (for adding friends)
  if (urlObj.pathname === '/api/users/search' && req.method === 'GET') {
    const query = (urlObj.searchParams.get('q') || '').replace(/^@/, '').trim().toLowerCase();
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

  if (urlObj.pathname === '/api/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { email, emailOrUsername, password } = JSON.parse(body);
        const query = ((email || emailOrUsername) || '').toLowerCase().trim();
        const users = loadUsers();
        const found = users.find(u => 
          ((u.email || '').toLowerCase() === query ||
           (u.username || '').toLowerCase() === query ||
           (u.fullName || '').toLowerCase() === query) &&
          u.password === password
        );
        if (!found) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Hatalı e-posta veya şifre girdiniz.' }));
          return;
        }
        console.log(`[AUTH] Giriş başarılı: ${found.username || found.fullName} (${found.email})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: 'Giriş başarılı ✓', 
          user: { 
            id: found.id, 
            fullName: found.fullName || found.username,
            username: found.username || found.fullName, 
            email: found.email,
            avatarUrl: found.avatarUrl || null 
          } 
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
    });
    return;
  }

  // 1.9 Password Recovery Endpoints (Forgot & Reset)
  if (urlObj.pathname === '/api/auth/forgot-password' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { email } = JSON.parse(body);
        const cleanEmail = (email || '').trim().toLowerCase();
        if (!cleanEmail) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'E-posta adresinizi giriniz.' }));
          return;
        }
        const users = loadUsers();
        const found = users.find(u => (u.email || '').toLowerCase() === cleanEmail);
        if (!found) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Bu e-posta adresiyle kayıtlı bir hesap bulunamadı.' }));
          return;
        }
        // Generate 6-digit random verification code
        const code = String(Math.floor(100000 + Math.random() * 900000));
        passwordResetCodes.set(cleanEmail, { code, expires: Date.now() + 15 * 60 * 1000 });
        console.log(`[AUTH] Şifre sıfırlama kodu oluşturuldu for ${cleanEmail}: ${code}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: '6 haneli doğrulama kodunuz oluşturuldu.',
          code // returned for immediate entry & display
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
    });
    return;
  }

  if (urlObj.pathname === '/api/auth/verify-code' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { email, code } = JSON.parse(body);
        const cleanEmail = (email || '').trim().toLowerCase();
        const cleanCode = (code || '').trim();
        const record = passwordResetCodes.get(cleanEmail);
        if (!record || record.expires < Date.now() || record.code !== cleanCode) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Girdiğiniz 6 haneli kod hatalı veya süresi dolmuş.' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Kod doğrulandı ✓' }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
    });
    return;
  }

  if (urlObj.pathname === '/api/auth/reset-password' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { email, code, newPassword } = JSON.parse(body);
        const cleanEmail = (email || '').trim().toLowerCase();
        const cleanCode = (code || '').trim();
        if (!newPassword || newPassword.length < 6) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Yeni şifreniz en az 6 karakter olmalıdır.' }));
          return;
        }
        const record = passwordResetCodes.get(cleanEmail);
        if (!record || record.expires < Date.now() || record.code !== cleanCode) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Doğrulama kodu geçersiz veya süresi dolmuş.' }));
          return;
        }
        const users = loadUsers();
        const user = users.find(u => (u.email || '').toLowerCase() === cleanEmail);
        if (!user) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Kullanıcı bulunamadı.' }));
          return;
        }
        user.password = newPassword;
        saveUsers(users);
        passwordResetCodes.delete(cleanEmail);
        console.log(`[AUTH] Şifre başarıyla güncellendi: ${user.email}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Şifreniz başarıyla değiştirildi! Yeni şifrenizle giriş yapabilirsiniz.' }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
    });
    return;
  }

  // 1.10 Phone Login OTP Endpoints
  if (urlObj.pathname === '/api/auth/phone-otp' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { phone } = JSON.parse(body);
        const cleanPhone = (phone || '').replace(/[^0-9+]/g, '');
        if (!cleanPhone || cleanPhone.length < 8) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Geçerli bir telefon numarası girin.' }));
          return;
        }
        const code = String(Math.floor(100000 + Math.random() * 900000));
        phoneOtpCodes.set(cleanPhone, { code, expires: Date.now() + 10 * 60 * 1000 });
        console.log(`[AUTH] SMS Onay Kodu oluşturuldu for ${cleanPhone}: ${code}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: '6 haneli SMS onay kodu gönderildi.',
          code
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
    });
    return;
  }

  if (urlObj.pathname === '/api/auth/verify-phone-otp' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { phone, code } = JSON.parse(body);
        const cleanPhone = (phone || '').replace(/[^0-9+]/g, '');
        const cleanCode = (code || '').trim();
        const record = phoneOtpCodes.get(cleanPhone);
        if (!record || record.expires < Date.now() || record.code !== cleanCode) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Girdiğiniz SMS onay kodu hatalı veya süresi dolmuş.' }));
          return;
        }
        phoneOtpCodes.delete(cleanPhone);

        // Find or create phone user
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
            avatarChar: '📱',
            provider: 'phone',
            createdAt: new Date().toISOString()
          };
          users.push(user);
          saveUsers(users);
        }

        console.log(`[AUTH] Telefonla giriş başarılı: ${cleanPhone}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Telefonla giriş başarılı ✓',
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
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
    });
    return;
  }

  // 1.11 Change Email & Change Password Endpoints
  if (urlObj.pathname === '/api/auth/change-email' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { userId, newEmail } = JSON.parse(body);
        const cleanEmail = (newEmail || '').trim().toLowerCase();
        if (!cleanEmail || !cleanEmail.includes('@')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Geçerli bir yeni e-posta adresi girin.' }));
          return;
        }
        const users = loadUsers();
        const existing = users.find(u => (u.email || '').toLowerCase() === cleanEmail && u.id !== userId);
        if (existing) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Bu e-posta adresi başka bir hesap tarafından kullanılıyor.' }));
          return;
        }
        const user = users.find(u => u.id === userId);
        if (user) {
          user.email = cleanEmail;
          saveUsers(users);
        }
        console.log(`[AUTH] E-posta başarıyla güncellendi: ${cleanEmail}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'E-posta adresiniz başarıyla güncellendi ✓', email: cleanEmail }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
    });
    return;
  }

  if (urlObj.pathname === '/api/auth/change-password' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { userId, email, currentPassword, newPassword } = JSON.parse(body);
        if (!newPassword || newPassword.length < 6) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Yeni şifreniz en az 6 karakter olmalıdır.' }));
          return;
        }
        const users = loadUsers();
        const user = users.find(u => u.id === userId || (email && (u.email || '').toLowerCase() === (email || '').toLowerCase()));
        if (user) {
          if (user.password && currentPassword && user.password !== currentPassword) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Mevcut şifreniz hatalı.' }));
            return;
          }
          user.password = newPassword;
          saveUsers(users);
        }
        console.log(`[AUTH] Şifre başarıyla güncellendi for user: ${userId || email}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Şifreniz başarıyla güncellendi ✓' }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
    });
    return;
  }

  // 2. Create Room API
  if (urlObj.pathname === '/api/create-room' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { name, isPrivate, host, category } = payload;
        // The server always mints the code, so two rooms can never share one.
        const finalId = generateRoomCode();
        const room = getOrCreateRoom(finalId, {
          name: name || finalId,
          isPrivate: !!isPrivate,
          host: host || 'Kullanıcı',
          category: category || 'Genel'
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, room: room.meta }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 3. HTTP SSE Signaling Fallback Endpoint
  if (urlObj.pathname === '/api/events') {
    const roomId = (urlObj.searchParams.get('room') || 'default').toUpperCase();
    const userId = urlObj.searchParams.get('userId') || crypto.randomUUID().slice(0, 8);
    const userName = urlObj.searchParams.get('name') || 'Misafir';

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    const room = getOrCreateRoom(roomId, { host: userName });
    room.clients.set(userId, { type: 'sse', res, id: userId, roomId });

    console.log(`[SSE] Client connected: ${userId} -> Room: ${roomId}`);
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

  // 4. HTTP POST Signaling Fallback
  if (urlObj.pathname === '/api/signal' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { roomId, userId, data } = payload;
        if (roomId && userId) {
          broadcastToRoom(roomId.toUpperCase(), userId, { ...data, senderId: userId });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 1.8 Download Endpoints (Mac, Windows, iOS, Android)
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

  // 1.9 Website Marketing / Landing Page Serving
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

  // Explicit Website Assets Serving
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

  // Root path check: If standard browser requesting root without ?app=1, show the official Website!
  if ((urlObj.pathname === '/' || urlObj.pathname === '/index.html') && !urlObj.searchParams.get('app') && !req.headers['x-miruo-native']) {
    const webIndex = path.join(__dirname, 'index.html');
    if (fs.existsSync(webIndex)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(webIndex).pipe(res);
      return;
    }
  }

  // Static File Serving for Public Web App (e.g. /app, /style.css, /app.js, /oda/...)
  let filePath = path.join(PUBLIC_DIR, (urlObj.pathname === '/' || urlObj.pathname === '/app') ? 'index.html' : urlObj.pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, indexContent) => {
          if (err2) {
            res.writeHead(404);
            res.end('Not Found');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(indexContent);
          }
        });
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
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
  console.log(`\n✨ MIRUO (Birlikte Gör & İzle) başarıyla başlatıldı!`);
  console.log(`👉 Yerel Bağlantı: http://localhost:${PORT}`);
  console.log(`👉 Mobil / Ağ Bağlantısı: http://[Senin-Yerel-IP-Adresin]:${PORT}\n`);
});
