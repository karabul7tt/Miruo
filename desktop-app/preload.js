const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miruoDesktop', {
  isDesktop: true,
  platform: process.platform,
  promptAppleTouchID: (details) => ipcRenderer.invoke('mac-touch-id-apple-sign-in', details),
  openOAuthWindow: (opts) => ipcRenderer.invoke('desktop-oauth-login', opts),
  getSystemUserInfo: () => ipcRenderer.invoke('get-system-user-info'),
  getDesktopProfile: () => ipcRenderer.invoke('get-desktop-profile'),
  saveDesktopProfile: (profile) => ipcRenderer.invoke('save-desktop-profile', profile),
  selectPhotoFile: () => ipcRenderer.invoke('select-photo-file'),
  onNavBackward: (cb) => { ipcRenderer.on('nav-backward', cb); },
  onNavForward: (cb) => { ipcRenderer.on('nav-forward', cb); },
  onMediaKey: (cb) => { ipcRenderer.on('media-key', cb); }
});
