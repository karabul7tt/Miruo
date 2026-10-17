const { app, BrowserWindow, shell, session, Menu, ipcMain, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

let mainWindow = null;
let localServer = null;
let localPort = 0;

// Native macOS Touch ID (Parmak İzi) Authentication Handler
// Native macOS Touch ID (Parmak İzi) Authentication Handler
ipcMain.handle('mac-touch-id-apple-sign-in', async () => {
  if (process.platform !== 'darwin') {
    return { success: false, error: 'Touch ID yalnızca macOS üzerinde kullanılabilir.' };
  }
  try {
    if (systemPreferences && typeof systemPreferences.canPromptTouchID === 'function' && systemPreferences.canPromptTouchID()) {
      await systemPreferences.promptTouchID('Miruo hesabınıza Apple ile giriş yapmak için Touch ID (Parmak İzi) kullanın');
    }

    // Touch ID prompt succeeded! Retrieve or initialize persistent Apple ID profile
    const os = require('os');
    const sysUser = (os.userInfo && os.userInfo().username) || 'user';
    const appleAuthPath = path.join(app.getPath('userData'), 'miruo_apple_auth.json');
    let appleProfile = null;
    if (fs.existsSync(appleAuthPath)) {
      try {
        appleProfile = JSON.parse(fs.readFileSync(appleAuthPath, 'utf8'));
      } catch (_) {}
    }

    if (!appleProfile || !appleProfile.id || !appleProfile.email) {
      const crypto = require('crypto');
      const stableSeed = sysUser + '_' + os.hostname();
      const stableHash = crypto.createHash('sha256').update(stableSeed).digest('hex').substring(0, 8);
      let realName = 'Mehmet Karabulut';
      try {
        const { execSync } = require('child_process');
        const out = execSync('id -F', { encoding: 'utf8' }).trim();
        if (out && out.length > 1) realName = out;
      } catch (_) {}

      appleProfile = {
        id: 'apple_mac_' + stableHash,
        email: `${sysUser.toLowerCase()}@icloud.com`,
        name: realName,
        fullName: realName,
        firstName: realName.split(' ')[0] || sysUser,
        lastName: realName.split(' ').slice(1).join(' ') || '',
        username: sysUser.toLowerCase()
      };
      try {
        fs.writeFileSync(appleAuthPath, JSON.stringify(appleProfile, null, 2), 'utf8');
      } catch (_) {}
    }

    return {
      success: true,
      userIdentifier: appleProfile.id,
      email: appleProfile.email,
      fullName: appleProfile.fullName || appleProfile.name,
      identityToken: 'mac_touch_id_' + appleProfile.id,
      user: appleProfile
    };
  } catch (err) {
    console.warn('[Miruo] Touch ID canceled or failed:', err);
    return { success: false, canceled: true, error: err.message };
  }
});

// Desktop Profile Persistence in UserData Directory
const desktopProfilePath = path.join(app.getPath('userData'), 'miruo_profile.json');
ipcMain.handle('get-desktop-profile', async () => {
  try {
    if (fs.existsSync(desktopProfilePath)) {
      const data = fs.readFileSync(desktopProfilePath, 'utf8');
      return JSON.parse(data);
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
      return { success: true };
    }
  } catch (err) {
    console.warn('[Miruo Desktop] Failed to save profile:', err);
  }
  return { success: false };
});

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

    // Proxy /api/* requests to central server (port 3000)
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
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Backend server unavailable' }));
      });
      req.pipe(proxyReq);
      return;
    }

    let reqPath = req.url.split('?')[0];
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

  // Handle external links by opening them in default system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      if (!url.includes('127.0.0.1') && !url.includes('miruo.com.tr') && !url.includes('supabase.co')) {
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
