// Miruo LiveKit token endpoint (Vercel serverless function, zero dependencies).
// Secrets come ONLY from environment variables: LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL.
const crypto = require('crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function signJwt(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (_) { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { return {}; }
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }

  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.LIVEKIT_URL;
  if (!key || !secret || !url) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'livekit_not_configured' }));
  }

  const body = await readBody(req);
  const room = String(body.room || '').trim().toUpperCase();
  const identity = String(body.identity || '').trim();
  const name = String(body.name || 'Miruo').slice(0, 40);
  if (!/^[A-Z0-9_-]{3,40}$/.test(room) || !/^[A-Za-z0-9_.:-]{3,80}$/.test(identity)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'bad_request' }));
  }

  const now = Math.floor(Date.now() / 1000);
  const token = signJwt({
    iss: key,
    sub: identity,
    name,
    nbf: now - 10,
    exp: now + 6 * 3600,
    jti: identity,
    metadata: JSON.stringify({ userId: String(body.userId || '').slice(0, 80) }),
    video: {
      room: `miruo-${room}`,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    }
  }, secret);

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ token, url, room: `miruo-${room}` }));
};
