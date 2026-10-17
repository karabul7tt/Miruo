const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miruoDesktop', {
  isDesktop: true,
  platform: process.platform,
  promptAppleTouchID: () => ipcRenderer.invoke('mac-touch-id-apple-sign-in'),
  getDesktopProfile: () => ipcRenderer.invoke('get-desktop-profile'),
  saveDesktopProfile: (profile) => ipcRenderer.invoke('save-desktop-profile', profile),
  onNavBackward: (cb) => { ipcRenderer.on('nav-backward', cb); },
  onNavForward: (cb) => { ipcRenderer.on('nav-forward', cb); }
});
