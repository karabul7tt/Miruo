const { app, BrowserWindow, shell, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;

function createWindow() {
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
      webSecurity: true
    }
  });

  // Automatically grant camera, mic, and screen permissions
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
      // YouTube, external links etc.
      if (!url.includes('miruo.com.tr') && !url.includes('supabase.co')) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
    }
    return { action: 'allow' };
  });

  mainWindow.loadURL('https://www.miruo.com.tr/app/').catch((err) => {
    console.warn('[Miruo] Failed to load remote URL, falling back to local file:', err);
    const localIndexPath = path.join(__dirname, 'public/index.html');
    if (fs.existsSync(localIndexPath)) {
      mainWindow.loadFile(localIndexPath);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// App lifecycle
app.whenReady().then(() => {
  createWindow();

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
