const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miruoDesktop', {
  isDesktop: true,
  platform: process.platform,
  promptAppleTouchID: () => ipcRenderer.invoke('mac-touch-id-apple-sign-in')
});
