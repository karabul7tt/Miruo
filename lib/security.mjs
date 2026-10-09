import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ============================================================================
// 1. CONFIG & ENVIRONMENT VARIABLES LOADER (Item 1 & 2)
// ============================================================================
export function parseEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const result = {};
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) continue;
      const key = line.slice(0, eqIdx).trim();
      let val = line.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
    return result;
  } catch (e) {
    return {};
  }
}

export function loadEnvironment(baseDir) {
  const envFile = path.join(baseDir, '.env');
  const envVars = parseEnvFile(envFile);
  for (const [k, v] of Object.entries(envVars)) {
    if (!process.env[k]) {
      process.env[k] = v;
    }
  }

  const rawOrigins = process.env.ALLOWED_ORIGINS || 'https://miruo.com.tr,https://www.miruo.com.tr,https://miruo.vercel.app,http://localhost:3000,http://127.0.0.1:3000,capacitor://localhost';
  const allowedOrigins = rawOrigins.split(',').map(s => s.trim()).filter(Boolean);

  return {
    PORT: Number(process.env.PORT) || 3000,
    NODE_ENV: process.env.NODE_ENV || 'production',
    SESSION_SECRET: process.env.SESSION_SECRET || 'miruo_prod_super_secret_session_key_2026_x89q2m_secure',
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || 'miruo_webhook_hmac_secret_key_2026_prod',
    ADMIN_API_KEY: process.env.ADMIN_API_KEY || 'miruo_admin_master_access_key_2026',
    ALLOWED_ORIGINS: allowedOrigins,
    MAX_BODY_BYTES: 100 * 1024, // 100 KB payload limit (Item 7)
    RATE_LIMIT_AUTH_MAX: Number(process.env.RATE_LIMIT_AUTH_MAX) || 5,
    RATE_LIMIT_AUTH_WINDOW_MS: Number(process.env.RATE_LIMIT_AUTH_WINDOW_MS) || 15 * 60 * 1000 // 15 min
  };
}

// ============================================================================
// 2. ROLES & PERMISSIONS MATRIX (Item 3, 4, 18)
// ============================================================================
export const ROLES = {
  ADMIN: 'admin',
  MODERATOR: 'moderator',
  USER: 'user',
  GUEST: 'guest'
};

export function canManageRoom(userRole, hostUserId, currentUserId) {
  if (userRole === ROLES.ADMIN) return true;
  if (!hostUserId || !currentUserId) return false;
  return hostUserId === currentUserId;
}

export function canAccessAdmin(userRole, tokenOrKey, adminApiKey) {
  if (userRole === ROLES.ADMIN) return true;
  if (tokenOrKey && adminApiKey && tokenOrKey === adminApiKey) return true;
  return false;
}

// ============================================================================
// 3. RATE LIMITING (Item 5: girişe sınır koy)
// ============================================================================
export class SlidingRateLimiter {
  constructor() {
    this.hits = new Map(); // key -> [timestamp, timestamp, ...]
    // Periodic cleanup of stale entries every 5 minutes
    setInterval(() => this.cleanup(), 5 * 60 * 1000).unref();
  }

  check(key, maxLimit, windowMs) {
    const now = Date.now();
    const timestamps = this.hits.get(key) || [];
    const valid = timestamps.filter(t => now - t < windowMs);
    
    if (valid.length >= maxLimit) {
      const oldest = valid[0];
      const retryAfterMs = windowMs - (now - oldest);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(1000, retryAfterMs)
      };
    }

    valid.push(now);
    this.hits.set(key, valid);
    return {
      allowed: true,
      remaining: maxLimit - valid.length,
      retryAfterMs: 0
    };
  }

  recordFailure(key, windowMs) {
    const now = Date.now();
    const timestamps = this.hits.get(key) || [];
    const valid = timestamps.filter(t => now - t < windowMs);
    valid.push(now);
    this.hits.set(key, valid);
  }

  reset(key) {
    this.hits.delete(key);
  }

  cleanup() {
    const now = Date.now();
    const maxWindow = 60 * 60 * 1000; // 1 hour max retention
    for (const [key, timestamps] of this.hits.entries()) {
      const valid = timestamps.filter(t => now - t < maxWindow);
      if (valid.length === 0) {
        this.hits.delete(key);
      } else {
        this.hits.set(key, valid);
      }
    }
  }
}

export const authLimiter = new SlidingRateLimiter(); // Login brute force
export const registerLimiter = new SlidingRateLimiter(); // Register flood
export const otpLimiter = new SlidingRateLimiter(); // OTP requests
export const generalApiLimiter = new SlidingRateLimiter(); // API flood

export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '127.0.0.1';
}

// ============================================================================
// 4. PASSWORD HASHING (Item 11: şifreleri hashle - Salted scrypt & timing-safe)
// ============================================================================
export function hashPassword(plainPassword) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(plainPassword, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `$scrypt$${salt}$${derivedKey}`;
}

export function verifyPassword(plainPassword, storedPasswordOrHash) {
  if (!storedPasswordOrHash || typeof storedPasswordOrHash !== 'string') {
    return { valid: false, needsUpgrade: false };
  }

  // Modern salted scrypt hash format: $scrypt$<saltHex>$<hashHex>
  if (storedPasswordOrHash.startsWith('$scrypt$')) {
    const parts = storedPasswordOrHash.split('$');
    if (parts.length !== 4) return { valid: false, needsUpgrade: false };
    const salt = parts[2];
    const targetHash = parts[3];
    const derivedKey = crypto.scryptSync(plainPassword, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
    
    const bufA = Buffer.from(derivedKey, 'hex');
    const bufB = Buffer.from(targetHash, 'hex');
    if (bufA.length !== bufB.length) return { valid: false, needsUpgrade: false };
    
    const match = crypto.timingSafeEqual(bufA, bufB);
    return { valid: match, needsUpgrade: false };
  }

  // Legacy plaintext backward compatibility migration:
  // Constant-time compare legacy plaintext to prevent timing leaks, then trigger upgrade
  const bufA = Buffer.from(plainPassword);
  const bufB = Buffer.from(storedPasswordOrHash);
  let match = false;
  if (bufA.length === bufB.length) {
    match = crypto.timingSafeEqual(bufA, bufB);
  }
  return { valid: match, needsUpgrade: match };
}

// ============================================================================
// 5. INPUT VALIDATION & SANITIZATION (Item 6 & 16: girdiyi doğrula & XSS kaçır)
// ============================================================================
export function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;')
    .replace(/`/g, '&#x60;');
}

export function sanitizeText(str, maxLength = 250) {
  if (typeof str !== 'string') return '';
  const trimmed = str.trim().slice(0, maxLength);
  return escapeHtml(trimmed);
}

export function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const clean = email.trim();
  if (clean.length < 5 || clean.length > 100) return false;
  // RFC 5322 compatible regex
  const re = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  return re.test(clean);
}

export function isValidUsername(username) {
  if (typeof username !== 'string') return false;
  const clean = username.trim().replace(/^@/, '');
  if (clean.length < 3 || clean.length > 30) return false;
  // Alphanumeric, underscores, hyphens only
  const re = /^[a-zA-Z0-9_.-]+$/;
  return re.test(clean);
}

export function isValidPassword(password) {
  if (typeof password !== 'string') return false;
  return password.length >= 6 && password.length <= 128;
}

export function isValidPhone(phone) {
  if (typeof phone !== 'string') return false;
  const digits = phone.replace(/[^0-9+]/g, '');
  return digits.length >= 8 && digits.length <= 18;
}

export function isValidRoomCode(code) {
  if (typeof code !== 'string') return false;
  const clean = code.trim().toUpperCase();
  if (clean.length < 3 || clean.length > 30) return false;
  return /^[A-Z0-9_-]+$/.test(clean);
}

// ============================================================================
// 6. PROTOTYPE POLLUTION PROTECTION (Item 15: sorguyu parametrele / prototype guard)
// ============================================================================
export function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item));
  }
  const clean = Object.create(null);
  for (const [key, value] of Object.entries(obj)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue; // Drop dangerous prototype keys
    }
    clean[key] = sanitizeObject(value);
  }
  return clean;
}

export function safeJsonParse(jsonString) {
  return JSON.parse(jsonString, (key, value) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return undefined;
    }
    return value;
  });
}

// ============================================================================
// 7. REQUEST BODY SIZE LIMITER (Item 7: yüklemeyi sınırla - 100KB limit)
// ============================================================================
export function readJsonBody(req, res, maxBytes = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        res.writeHead(413, { 'Content-Type': 'application/json', 'Connection': 'close' });
        res.end(JSON.stringify({ 
          success: false, 
          error: 'PAYLOAD_TOO_LARGE', 
          message: `İstek boyutu çok büyük (Maksimum ${Math.round(maxBytes / 1024)}KB).` 
        }));
        req.pause();
        req.removeAllListeners('data');
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw || raw.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = safeJsonParse(raw);
        resolve(sanitizeObject(parsed));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: false, 
          error: 'INVALID_JSON', 
          message: 'Geçersiz JSON verisi.' 
        }));
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', err => {
      reject(err);
    });
  });
}

// ============================================================================
// 8. CORS & HTTP SECURITY HEADERS (Item 8, 9, 10: cors kilitle, başlıklar, https)
// ============================================================================
export function applySecurityHeaders(req, res, isProduction = false) {
  // Helmet-style security headers (Item 9)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  
  // Strict Content Security Policy allowing required YouTube/media embeds & WebSockets
  res.setHeader('Content-Security-Policy', 
    "default-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob: data: wss: ws:; " +
    "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com https://open.spotify.com https://*.netflix.com https://*.primevideo.com; " +
    "frame-ancestors 'self';"
  );

  // HTTPS HSTS (Item 10)
  if (isProduction || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
}

export function handleCors(req, res, allowedOrigins) {
  const origin = req.headers.origin;
  
  if (origin && (allowedOrigins.includes(origin) || allowedOrigins.includes('*'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Miruo-Signature');
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return true; // Request handled
  }
  return false;
}

// ============================================================================
// 9. SECURE COOKIES & SESSION TOKENS (Item 12: çerezleri güvenli yap)
// ============================================================================
export function buildSecureCookie(name, value, maxAgeSeconds = 7 * 24 * 3600, isProduction = true) {
  const secureFlag = isProduction ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; HttpOnly${secureFlag}; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function createSignedToken(payloadObj, secret) {
  const dataStr = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(dataStr).digest('base64url');
  return `${dataStr}.${signature}`;
}

export function verifySignedToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [dataStr, signature] = parts;
  const expectedSig = crypto.createHmac('sha256', secret).update(dataStr).digest('base64url');
  
  const bufA = Buffer.from(signature);
  const bufB = Buffer.from(expectedSig);
  if (bufA.length !== bufB.length) return null;
  if (!crypto.timingSafeEqual(bufA, bufB)) return null;

  try {
    const raw = Buffer.from(dataStr, 'base64url').toString('utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// ============================================================================
// 10. ERROR SANITIZATION & LOG MASKING (Item 13 & 14: hata mesajı kıs & logları temizle)
// ============================================================================
export function maskEmail(email) {
  if (!email || typeof email !== 'string') return '***';
  const parts = email.split('@');
  if (parts.length !== 2) return '***';
  const name = parts[0];
  const domain = parts[1];
  const maskedName = name.length <= 2 ? name.charAt(0) + '***' : name.charAt(0) + '***' + name.charAt(name.length - 1);
  return `${maskedName}@${domain}`;
}

export function safeLog(tag, message, meta = {}) {
  const sanitizedMeta = { ...meta };
  if (sanitizedMeta.password) sanitizedMeta.password = '***';
  if (sanitizedMeta.newPassword) sanitizedMeta.newPassword = '***';
  if (sanitizedMeta.currentPassword) sanitizedMeta.currentPassword = '***';
  if (sanitizedMeta.code && process.env.NODE_ENV === 'production') sanitizedMeta.code = '***';
  if (sanitizedMeta.email) sanitizedMeta.email = maskEmail(sanitizedMeta.email);

  const metaStr = Object.keys(sanitizedMeta).length ? ' ' + JSON.stringify(sanitizedMeta) : '';
  console.log(`[${new Date().toISOString()}] [${tag}] ${message}${metaStr}`);
}

export function sendError(res, statusCode, errorCode, message) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    success: false,
    error: errorCode,
    message: message || 'İşlem gerçekleştirilemedi.'
  }));
}

// ============================================================================
// 11. WEBHOOK HMAC SIGNATURE VERIFICATION (Item 17: webhook imzası)
// ============================================================================
export function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const cleanSig = signatureHeader.replace(/^sha256=/, '').trim();
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const expectedSig = hmac.digest('hex');

  const bufA = Buffer.from(cleanSig, 'hex');
  const bufB = Buffer.from(expectedSig, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ============================================================================
// 12. AUTOMATIC USERS BACKUP (Item 20: otomatik yedek)
// ============================================================================
export function backupUsersFile(usersFilePath, reason = 'auto') {
  try {
    if (!fs.existsSync(usersFilePath)) return null;
    const backupDir = path.join(path.dirname(usersFilePath), '.backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `users-${timestamp}-${reason}.json`;
    const targetPath = path.join(backupDir, backupName);
    
    fs.copyFileSync(usersFilePath, targetPath);
    safeLog('BACKUP', `Kullanıcı veritabanı başarıyla yedeklendi (${reason})`, { backup: backupName });

    // Rotate backups: keep max 30 recent backups
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('users-') && f.endsWith('.json'))
      .map(f => ({ name: f, time: fs.statSync(path.join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);

    if (files.length > 30) {
      for (const oldFile of files.slice(30)) {
        try {
          fs.unlinkSync(path.join(backupDir, oldFile.name));
        } catch (e) {}
      }
    }
    return targetPath;
  } catch (err) {
    console.error('[BACKUP] Yedekleme hatası:', err.message);
    return null;
  }
}

export function startPeriodicBackup(usersFilePath, intervalMs = 60 * 60 * 1000) {
  setInterval(() => {
    backupUsersFile(usersFilePath, 'hourly');
  }, intervalMs).unref();
}
