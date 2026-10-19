const { app, BrowserWindow, shell, session, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

let mainWindow = null;
let localServer = null;
let localPort = 0;

// Persistent User Database & Profile Paths in UserData Directory
const userDataDir = app.getPath('userData');
const usersDbPath = path.join(userDataDir, 'miruo_users_db.json');
const desktopProfilePath = path.join(userDataDir, 'miruo_profile.json');
const appleAuthPath = path.join(userDataDir, 'miruo_apple_auth.json');

// Clean up any legacy fake/placeholder data ("Karabul7tt", "@icloud.com") from previous builds
function sanitizeLegacyFakeFiles() {
  for (const filePath of [desktopProfilePath, appleAuthPath]) {
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        const nameStr = String((parsed && (parsed.fullName || parsed.name || parsed.username)) || '').toLowerCase();
        const emailStr = String((parsed && parsed.email) || '').toLowerCase();
        const tokStr = String((parsed && parsed.identityToken) || '');
        if (
          nameStr === 'karabul7tt' ||
          emailStr === 'mehmetkarabul7tt@icloud.com' ||
          tokStr.startsWith('mac_touch_id_')
        ) {
          fs.unlinkSync(filePath);
        }
      }
    } catch (_) {}
  }
}
sanitizeLegacyFakeFiles();

function loadLocalUsers() {
  try {
    if (fs.existsSync(usersDbPath)) {
      const data = JSON.parse(fs.readFileSync(usersDbPath, 'utf8'));
      if (Array.isArray(data)) {
        return data.filter(u => {
          const n = String((u && (u.fullName || u.username)) || '').toLowerCase();
          const e = String((u && u.email) || '').toLowerCase();
          return n !== 'karabul7tt' && e !== 'mehmetkarabul7tt@icloud.com';
        });
      }
    }
  } catch (_) {}
  return [];
}

function saveLocalUsers(users) {
  try {
    fs.writeFileSync(usersDbPath, JSON.stringify(users, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Miruo Desktop] Failed to save users DB:', err);
  }
}

function decodeJwtPayload(jwt) {
  try {
    if (!jwt || typeof jwt !== 'string') return null;
    const parts = jwt.split('.');
    if (parts.length < 2) return null;
    let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0) base64 += '=';
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function resolveAppleAuthHelperBinary() {
  const candidates = [
    path.join(process.resourcesPath || '', 'MiruoAppleAuth.app', 'Contents', 'MacOS', 'MiruoAppleAuth'),
    path.join(__dirname, 'build', 'MiruoAppleAuth.app', 'Contents', 'MacOS', 'MiruoAppleAuth'),
    path.join(__dirname, '..', 'mac-auth', 'DerivedData', 'Build', 'Products', 'Release', 'MiruoAppleAuth.app', 'Contents', 'MacOS', 'MiruoAppleAuth'),
    path.join(__dirname, 'MiruoAppleAuth.app', 'Contents', 'MacOS', 'MiruoAppleAuth'),
    path.join(__dirname, '..', 'MiruoAppleAuth.app', 'Contents', 'MacOS', 'MiruoAppleAuth'),
    path.join(userDataDir, 'MiruoAppleAuth.app', 'Contents', 'MacOS', 'MiruoAppleAuth')
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  try {
    const b64Path = path.join(__dirname, 'apple-auth-bundle.b64');
    const extractedApp = path.join(userDataDir, 'MiruoAppleAuth.app');
    const extractedBin = path.join(extractedApp, 'Contents', 'MacOS', 'MiruoAppleAuth');
    if (fs.existsSync(b64Path)) {
      if (!fs.existsSync(extractedBin)) {
        const b64Data = fs.readFileSync(b64Path, 'utf8').replace(/\s+/g, '');
        const zipBuf = Buffer.from(b64Data, 'base64');
        const tmpZip = path.join(userDataDir, 'MiruoAppleAuth_tmp.zip');
        fs.writeFileSync(tmpZip, zipBuf);
        try {
          if (fs.existsSync(extractedApp)) {
            fs.rmSync(extractedApp, { recursive: true, force: true });
          }
          execFileSync('/usr/bin/ditto', ['-x', '-k', tmpZip, userDataDir]);
          execFileSync('/usr/bin/xattr', ['-cr', extractedApp]);
        } finally {
          try { fs.unlinkSync(tmpZip); } catch (_) {}
        }
      }
      if (fs.existsSync(extractedBin)) {
        return extractedBin;
      }
    }
  } catch (err) {
    console.warn('[Miruo Desktop] Failed to extract Apple Auth helper:', err);
  }

  return null;
}

// Real Native macOS Sign in with Apple (ASAuthorizationAppleIDProvider via MiruoAppleAuth.app)
ipcMain.handle('mac-touch-id-apple-sign-in', async () => {
  if (process.platform !== 'darwin') {
    return { success: false, error: 'Apple ile Giriş yalnızca macOS ve iOS üzerinde kullanılabilir.' };
  }
  const helperBin = resolveAppleAuthHelperBinary();
  if (!helperBin) {
    return { success: false, error: 'Native Apple Sign-In bileşeni (MiruoAppleAuth) bulunamadı.' };
  }

  return new Promise((resolve) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    let finished = false;

    const child = spawn(helperBin, [], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const finish = (result) => {
      if (finished) return;
      finished = true;
      resolve(result);
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('MIRUO_APPLE_AUTH_JSON:')) {
          const jsonStr = trimmed.slice('MIRUO_APPLE_AUTH_JSON:'.length);
          try {
            const payload = JSON.parse(jsonStr);
            if (payload && payload.success) {
              let userIdentifier = String(payload.userIdentifier || '').trim();
              let email = String(payload.email || '').trim().toLowerCase();
              let fullName = String(payload.fullName || '').trim();
              const identityToken = String(payload.identityToken || '');

              if (identityToken) {
                const claims = decodeJwtPayload(identityToken);
                if (claims) {
                  if (!email && claims.email) email = String(claims.email).trim().toLowerCase();
                  if (!userIdentifier && claims.sub) userIdentifier = String(claims.sub).trim();
                }
              }

              const canonicalId = userIdentifier.startsWith('apple_') ? userIdentifier : `apple_${userIdentifier}`;
              const users = loadLocalUsers();
              const existingUser = users.find(u =>
                (userIdentifier && (u.id === canonicalId || u.id === userIdentifier || u.appleUserId === userIdentifier)) ||
                (email && (u.email || '').toLowerCase() === email)
              );

              if (existingUser) {
                if (!fullName && existingUser.fullName) fullName = existingUser.fullName;
                if (!email && existingUser.email) email = existingUser.email;
              }

              finish({
                success: true,
                userIdentifier,
                email,
                fullName,
                identityToken,
                authorizationCode: payload.authorizationCode || '',
                existingUser: existingUser || null
              });
              return;
            } else {
              finish({
                success: false,
                canceled: Boolean(payload && payload.canceled),
                error: (payload && payload.error) || 'canceled'
              });
              return;
            }
          } catch (_) {}
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      finish({ success: false, canceled: false, error: err.message });
    });

    child.on('close', () => {
      if (!finished) {
        finish({
          success: false,
          canceled: true,
          error: stderrBuf.trim() || 'canceled'
        });
      }
    });
  });
});

// Dedicated Desktop OAuth Modal Window for 100% Reliable Apple & Google Sign-In
ipcMain.handle('desktop-oauth-login', async (event, { provider, authUrl }) => {
  return new Promise((resolve) => {
    const parentWin = BrowserWindow.getFocusedWindow() || mainWindow;
    const authWin = new BrowserWindow({
      width: 520,
      height: 700,
      parent: parentWin || undefined,
      modal: Boolean(parentWin),
      title: provider === 'apple' ? 'Apple ile Giriş Yap' : 'Google ile Giriş Yap',
      show: true,
      backgroundColor: '#0E0512',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true
      }
    });

    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      try {
        if (!authWin.isDestroyed()) {
          authWin.destroy();
        }
      } catch (_) {}
      resolve(result);
    };

    const checkAuthCompletion = async (explicitUrl) => {
      if (finished || authWin.isDestroyed()) return;
      try {
        let currentUrl = explicitUrl || '';
        if (!currentUrl && !authWin.isDestroyed()) {
          currentUrl = authWin.webContents.getURL() || '';
        }

        let pageHref = '';
        try {
          if (!authWin.isDestroyed()) {
            pageHref = await authWin.webContents.executeJavaScript('window.location.href').catch(() => '');
          }
        } catch (_) {}

        const bestUrl = (pageHref && (pageHref.includes('access_token=') || pageHref.includes('code=')))
          ? pageHref
          : (currentUrl || pageHref);

        if (bestUrl.includes('access_token=') || bestUrl.includes('code=')) {
          finish({
            success: true,
            url: bestUrl,
            canceled: false,
            error: null
          });
          return;
        }

        if (bestUrl.includes('error=') && !bestUrl.includes('access_token=')) {
          finish({
            success: false,
            url: bestUrl,
            canceled: false,
            error: 'Giriş işlemi iptal edildi veya onaylanmadı.'
          });
          return;
        }

        // If it landed on callback redirect (miruo.com.tr), give DOM 600ms to settle hash tokens
        if (bestUrl.includes('miruo.com.tr') || bestUrl.includes('miruo://')) {
          setTimeout(async () => {
            if (finished || authWin.isDestroyed()) return;
            try {
              const delayedHref = await authWin.webContents.executeJavaScript('window.location.href').catch(() => '');
              if (delayedHref.includes('access_token=') || delayedHref.includes('code=')) {
                finish({
                  success: true,
                  url: delayedHref,
                  canceled: false,
                  error: null
                });
              }
            } catch (_) {}
          }, 600);
        }
      } catch (_) {}
    };

    authWin.webContents.on('will-redirect', (e, targetUrl) => {
      if (targetUrl && (targetUrl.includes('access_token=') || targetUrl.includes('code='))) {
        finish({ success: true, url: targetUrl, canceled: false, error: null });
      }
    });

    authWin.webContents.on('will-navigate', (e, targetUrl) => {
      if (targetUrl && (targetUrl.includes('access_token=') || targetUrl.includes('code='))) {
        finish({ success: true, url: targetUrl, canceled: false, error: null });
      }
    });

    authWin.webContents.on('did-navigate', (e, targetUrl) => {
      checkAuthCompletion(targetUrl);
    });

    authWin.webContents.on('did-redirect-navigation', (e, targetUrl) => {
      checkAuthCompletion(targetUrl);
    });

    authWin.webContents.on('did-finish-load', () => {
      checkAuthCompletion();
    });

    authWin.on('closed', () => {
      finish({ success: false, canceled: true, error: 'Pencere kapatıldı.' });
    });

    authWin.loadURL(authUrl);
  });
});

ipcMain.handle('get-system-user-info', async () => {
  return { username: '', fullName: '', email: '' };
});

ipcMain.handle('get-desktop-profile', async () => {
  try {
    if (fs.existsSync(desktopProfilePath)) {
      const data = fs.readFileSync(desktopProfilePath, 'utf8');
      const parsed = JSON.parse(data);
      const nameStr = String((parsed && (parsed.fullName || parsed.name || parsed.username)) || '').toLowerCase();
      if (nameStr === 'karabul7tt') return null;
      return parsed;
    }
  } catch (err) {
    console.warn('[Miruo Desktop] Failed to read profile:', err);
  }
  return null;
});

ipcMain.handle('save-desktop-profile', async (e, profile) => {
  try {
    if (profile) {
      fs.writeFileSync(desktopProfilePath, JSON.stringify(profile, null, 2), 'utf8');
      // Also update in persistent users DB so profile changes survive logout/login
      const users = loadLocalUsers();
      const uid = String(profile.id || '').trim();
      const uemail = String(profile.email || '').trim().toLowerCase();
      const idx = users.findIndex(u =>
        (uid && (u.id === uid || `apple_${u.appleUserId}` === uid)) ||
        (uemail && (u.email || '').toLowerCase() === uemail)
      );
      if (idx !== -1) {
        if (profile.fullName || profile.name) users[idx].fullName = profile.fullName || profile.name;
        if (profile.username) users[idx].username = String(profile.username).replace(/^@/, '').toLowerCase();
        if (profile.avatarUrl !== undefined) users[idx].avatarUrl = profile.avatarUrl;
        if (profile.avatarBg) users[idx].avatarBg = profile.avatarBg;
        saveLocalUsers(users);
      }
      return { success: true };
    }
  } catch (err) {
    console.warn('[Miruo Desktop] Failed to save profile:', err);
  }
  return { success: false };
});

function handleLocalAuthRequest(req, res, pathname, bodyStr) {
  let body = {};
  try {
    body = JSON.parse(bodyStr || '{}');
  } catch (_) {}

  // Also forward asynchronously to central server on port 3000 if running
  try {
    const syncReq = http.request({
      host: '127.0.0.1',
      port: 3000,
      path: pathname,
      method: req.method,
      headers: { 'Content-Type': 'application/json' }
    });
    syncReq.on('error', () => {});
    syncReq.write(bodyStr || '{}');
    syncReq.end();
  } catch (_) {}

  const users = loadLocalUsers();
  const genericNames = ['kullanıcı', 'kullanici', 'apple kullanıcısı', 'apple user', 'user', 'misafir', 'karabul7tt'];

  if (pathname === '/api/auth/social-sync' && req.method === 'POST') {
    const rawId = String(body.id || '').trim();
    const rawAppleId = String(body.appleUserId || rawId).replace(/^apple_/, '').trim();
    const canonicalId = rawId || (rawAppleId ? `apple_${rawAppleId}` : `usr_${Date.now()}`);
    const cleanEmail = String(body.email || '').trim().toLowerCase();
    const incomingName = String(body.fullName || body.displayName || '').trim();
    const isIncomingGeneric = !incomingName || genericNames.includes(incomingName.toLowerCase());
    const reqUsername = String(body.username || '').replace(/^@/, '').trim().toLowerCase();

    let existing = users.find(u =>
      (canonicalId && (u.id === canonicalId || (rawAppleId && (u.id === rawAppleId || u.appleUserId === rawAppleId)))) ||
      (cleanEmail && (u.email || '').toLowerCase() === cleanEmail)
    );

    let isExistingUser = false;
    if (existing) {
      isExistingUser = true;
      const existingIsGeneric = !existing.fullName || genericNames.includes(String(existing.fullName).trim().toLowerCase());
      if (existingIsGeneric && !isIncomingGeneric) {
        existing.fullName = incomingName;
      }
      if (!existing.email && cleanEmail) existing.email = cleanEmail;
      if (rawAppleId && !existing.appleUserId) existing.appleUserId = rawAppleId;
      if (!existing.avatarUrl && body.avatarUrl) existing.avatarUrl = body.avatarUrl;
      if (!existing.avatarBg && body.avatarBg) existing.avatarBg = body.avatarBg;
      existing.last_login = new Date().toISOString();
    } else {
      const finalName = !isIncomingGeneric ? incomingName : (reqUsername || (cleanEmail ? cleanEmail.split('@')[0] : 'Apple Kullanıcısı'));
      let baseUsername = (reqUsername || (cleanEmail ? cleanEmail.split('@')[0] : finalName))
        .toLowerCase()
        .replace(/[^a-z0-9_.]/g, '');
      if (!baseUsername || baseUsername.length < 3) {
        baseUsername = 'user_' + Math.floor(1000 + Math.random() * 9000);
      }
      if (users.some(u => (u.username || '').toLowerCase() === baseUsername)) {
        baseUsername = `${baseUsername}${Math.floor(10 + Math.random() * 900)}`;
      }
      existing = {
        id: canonicalId,
        appleUserId: rawAppleId || undefined,
        fullName: finalName,
        username: baseUsername,
        email: cleanEmail,
        provider: body.provider || 'Apple',
        avatarUrl: body.avatarUrl || '',
        avatarBg: body.avatarBg || 'linear-gradient(135deg, #ec4899, #8b5cf6)',
        createdAt: new Date().toISOString(),
        last_login: new Date().toISOString()
      };
      users.push(existing);
    }
    saveLocalUsers(users);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      success: true,
      isExistingUser,
      token: `local_tok_${existing.id}`,
      user: existing
    }));
    return true;
  }

  if (pathname === '/api/auth/register' && req.method === 'POST') {
    const fullName = String(body.fullName || '').trim();
    const username = String(body.username || '').replace(/^@/, '').trim().toLowerCase();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (email && users.some(u => (u.email || '').toLowerCase() === email)) {
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Bu e-posta adresi ile zaten kayıtlı bir hesap bulunuyor. Lütfen giriş yapın.' }));
      return true;
    }
    if (username && users.some(u => (u.username || '').toLowerCase() === username)) {
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Bu kullanıcı adı zaten alınmış.' }));
      return true;
    }
    const uid = `usr_${Date.now()}_${Math.floor(100 + Math.random() * 899)}`;
    const newUser = {
      id: uid,
      fullName,
      username,
      email,
      password,
      provider: 'local',
      avatarUrl: body.avatarUrl || '',
      avatarBg: body.avatarBg || 'linear-gradient(135deg, #ec4899, #8b5cf6)',
      createdAt: new Date().toISOString()
    };
    users.push(newUser);
    saveLocalUsers(users);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, success: true, token: `local_tok_${uid}`, user: newUser }));
    return true;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const identifier = String(body.identifier || body.email || body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const found = users.find(u =>
      ((u.email || '').toLowerCase() === identifier || (u.username || '').toLowerCase() === identifier) &&
      (!u.password || u.password === password)
    );
    if (found) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, success: true, token: `local_tok_${found.id}`, user: found }));
      return true;
    }
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Hatalı e-posta, kullanıcı adı veya şifre.' }));
    return true;
  }

function validateInstagramUsername(username) {
  const raw = String(username || '').trim().replace(/^@/, '');
  if (!raw) return { valid: false, error: 'Kullanıcı adı boş bırakılamaz.' };
  if (raw.length < 3) return { valid: false, error: 'Kullanıcı adı en az 3 karakter olmalıdır.' };
  if (raw.length > 30) return { valid: false, error: 'Kullanıcı adı en fazla 30 karakter olabilir.' };
  if (!/^[a-zA-Z0-9_.]+$/.test(raw)) return { valid: false, error: 'Kullanıcı adı yalnızca harf, rakam, alt çizgi (_) ve nokta (.) içerebilir.' };
  if (raw.startsWith('.')) return { valid: false, error: 'Kullanıcı adı nokta (.) ile başlayamaz.' };
  if (raw.endsWith('.')) return { valid: false, error: 'Kullanıcı adı nokta (.) ile bitemez.' };
  if (raw.includes('..')) return { valid: false, error: 'Kullanıcı adında yan yana iki nokta (..) bulunamaz.' };
  return { valid: true, cleanUsername: raw.toLowerCase() };
}

  if (pathname === '/api/auth/update-profile' && req.method === 'POST') {
    const uid = String(body.id || body.userId || '').trim();
    const uemail = String(body.email || '').trim().toLowerCase();
    const rawUsername = body.username ? String(body.username).replace(/^@/, '').trim() : '';
    let cleanUsername = '';
    if (rawUsername) {
      const userCheck = validateInstagramUsername(rawUsername);
      if (!userCheck.valid) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, success: false, error: userCheck.error }));
        return true;
      }
      cleanUsername = userCheck.cleanUsername;
    }
    const found = users.find(u =>
      (uid && (u.id === uid || `apple_${u.appleUserId}` === uid)) ||
      (uemail && (u.email || '').toLowerCase() === uemail)
    );
    if (cleanUsername) {
      const taken = users.some(u =>
        u.id !== (found ? found.id : uid) &&
        (!uemail || (u.email || '').toLowerCase() !== uemail) &&
        String(u.username || '').replace(/^@/, '').trim().toLowerCase() === cleanUsername
      );
      if (taken) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, success: false, error: `"${cleanUsername}" kullanıcı adı zaten kullanımda.` }));
        return true;
      }
    }
    if (found) {
      if (body.fullName && String(body.fullName).trim()) found.fullName = String(body.fullName).trim();
      if (cleanUsername) found.username = cleanUsername;
      if (body.avatarUrl !== undefined) found.avatarUrl = body.avatarUrl;
      if (body.avatarBg) found.avatarBg = body.avatarBg;
      saveLocalUsers(users);
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, success: true, user: found || null }));
    return true;
  }

  if (pathname === '/api/auth/delete-account' && req.method === 'POST') {
    const uid = String(body.userId || body.id || '').trim();
    const uemail = String(body.email || '').trim().toLowerCase();
    const idx = users.findIndex(u =>
      (uid && u.id === uid) ||
      (uemail && (u.email || '').toLowerCase() === uemail)
    );
    if (idx !== -1) {
      users.splice(idx, 1);
      saveLocalUsers(users);
    }
    try { if (fs.existsSync(desktopProfilePath)) fs.unlinkSync(desktopProfilePath); } catch (_) {}
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, success: true }));
    return true;
  }

  return false;
}

function startLocalServer(callback) {
  const publicDir = path.join(__dirname, 'public');
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2'
  };

  localServer = http.createServer((req, res) => {
    // Enable CORS for desktop app requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const reqPathOnly = req.url.split('?')[0];

    // Check username availability locally
    if (reqPathOnly === '/api/users/check-username' && req.method === 'GET') {
      const urlObj = new URL(req.url, 'http://127.0.0.1');
      const rawUsername = (urlObj.searchParams.get('username') || '').replace(/^@/, '').trim();
      const excludeUserId = (urlObj.searchParams.get('userId') || '').trim();
      if (!rawUsername) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ available: false, error: 'Kullanıcı adı boş olamaz.' }));
        return;
      }
      const check = validateInstagramUsername(rawUsername);
      if (!check.valid) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ available: false, error: check.error }));
        return;
      }
      const cleanUsername = check.cleanUsername;
      const users = loadLocalUsers();
      const taken = users.some(u =>
        u.id !== excludeUserId &&
        String(u.username || '').toLowerCase().replace(/^@/, '') === cleanUsername
      );
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ available: !taken, username: cleanUsername }));
      return;
    }

    // Handle /api/auth/* directly in embedded persistent store (and sync to 3000 if available)
    if (reqPathOnly.startsWith('/api/auth/')) {
      let bodyChunks = [];
      req.on('data', chunk => bodyChunks.push(chunk));
      req.on('end', () => {
        const bodyStr = Buffer.concat(bodyChunks).toString('utf8');
        if (!handleLocalAuthRequest(req, res, reqPathOnly, bodyStr)) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        }
      });
      return;
    }

    // Proxy other /api/* requests to central server (port 3000)
    if (req.url.startsWith('/api/')) {
      const proxyReq = http.request({
        host: '127.0.0.1',
        port: 3000,
        path: req.url,
        method: req.method,
        headers: req.headers
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('error', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, offline: true }));
      });
      req.pipe(proxyReq);
      return;
    }

    let reqPath = reqPathOnly;
    if (reqPath === '/' || reqPath === '/app' || reqPath === '/app/') reqPath = '/index.html';
    const filePath = path.join(publicDir, reqPath);
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403);
      return res.end();
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        fs.readFile(path.join(publicDir, 'index.html'), (err2, fallback) => {
          if (err2) {
            res.writeHead(404);
            return res.end('Not Found');
          }
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(fallback);
        });
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(data);
    });
  });

  const DEFAULT_PORT = 24180;
  localServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[Miruo Desktop] Port ${DEFAULT_PORT} is in use, falling back to dynamic port...`);
      localServer.listen(0, '127.0.0.1');
    }
  });

  localServer.listen(DEFAULT_PORT, '127.0.0.1', () => {
    localPort = localServer.address().port;
    console.log(`[Miruo Desktop] Embedded server listening on http://127.0.0.1:${localPort}`);
    callback(localPort);
  });
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 500,
    minHeight: 600,
    backgroundColor: '#0E0512',
    title: 'Miruo — Birlikte Canlı Video ve Dizi İzle | Watch Party',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    icon: process.platform === 'darwin'
      ? path.join(__dirname, 'build/icon.icns')
      : path.join(__dirname, 'build/icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      allowsRunningInsecureContent: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true
    }
  });

  // Support hardware/mouse back & forward buttons
  mainWindow.on('app-command', (e, cmd) => {
    if (cmd === 'browser-backward') {
      mainWindow.webContents.send('nav-backward');
    } else if (cmd === 'browser-forward') {
      mainWindow.webContents.send('nav-forward');
    }
  });

  // Automatically grant camera, mic, and screen permissions
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const allowed = ['media', 'camera', 'microphone', 'notifications', 'display-capture', 'fullscreen'];
    return allowed.includes(permission);
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'camera', 'microphone', 'notifications', 'display-capture', 'fullscreen'];
    if (allowed.includes(permission)) {
      return callback(true);
    }
    callback(false);
  });

  // YouTube Embed & Copyright Restrictions Bypass (Fixes "Bu video kullanılamıyor" Error 150/101)
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*', '*://*.googlevideo.com/*'] },
    (details, callback) => {
      details.requestHeaders['Referer'] = 'https://www.youtube.com/';
      details.requestHeaders['Origin'] = 'https://www.youtube.com';
      callback({ cancel: false, requestHeaders: details.requestHeaders });
    }
  );

  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*', '*://*.googlevideo.com/*'] },
    (details, callback) => {
      const responseHeaders = Object.assign({}, details.responseHeaders);
      delete responseHeaders['x-frame-options'];
      delete responseHeaders['X-Frame-Options'];
      callback({ responseHeaders });
    }
  );

  // Handle external links by opening them in default system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      const isAuthUrl = url.includes('supabase.co') || url.includes('appleid.apple.com') || url.includes('accounts.google.com');
      if (!url.includes('127.0.0.1') && !url.includes('miruo.com.tr') && !isAuthUrl) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
    }
    return { action: 'allow' };
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/index.html`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// App lifecycle
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) contents.loadURL(url);
      return { action: 'deny' };
    });
  }
});

app.whenReady().then(() => {
  startLocalServer((port) => {
    createWindow(port);
  });

  // Mac Application Menu
  if (process.platform === 'darwin') {
    const template = [
      {
        label: 'Miruo',
        submenu: [
          { role: 'about', label: 'Miruo Hakkında' },
          { type: 'separator' },
          { role: 'hide', label: 'Miruo\'yu Gizle' },
          { role: 'hideOthers', label: 'Diğerlerini Gizle' },
          { role: 'unhide', label: 'Tümünü Göster' },
          { type: 'separator' },
          { role: 'quit', label: 'Miruo\'dan Çık' }
        ]
      },
      {
        label: 'Düzenle',
        submenu: [
          { role: 'undo', label: 'Geri Al' },
          { role: 'redo', label: 'Yinele' },
          { type: 'separator' },
          { role: 'cut', label: 'Kes' },
          { role: 'copy', label: 'Kopyala' },
          { role: 'paste', label: 'Yapıştır' },
          { role: 'selectAll', label: 'Tümünü Seç' }
        ]
      },
      {
        label: 'Görünüm',
        submenu: [
          { role: 'reload', label: 'Yenile' },
          { role: 'forceReload', label: 'Sert Yenile' },
          { type: 'separator' },
          { role: 'resetZoom', label: 'Varsayılan Boyut' },
          { role: 'zoomIn', label: 'Yakınlaştır' },
          { role: 'zoomOut', label: 'Uzaklaştır' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: 'Tam Ekran' }
        ]
      },
      {
        label: 'Pencere',
        submenu: [
          { role: 'minimize', label: 'Küçült' },
          { role: 'zoom', label: 'Ekranı Kapla' },
          { type: 'separator' },
          { role: 'front', label: 'Tümünü Öne Getir' }
        ]
      }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
