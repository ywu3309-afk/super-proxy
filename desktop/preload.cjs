const { contextBridge, ipcRenderer } = require('electron');

// Keep Node disabled in the panel and expose only these two fixed operations.
contextBridge.exposeInMainWorld('superProxyDesktop', Object.freeze({
  getAutostart: () => ipcRenderer.invoke('super-proxy:autostart:status'),
  setAutostart: enabled => {
    if (typeof enabled !== 'boolean') return Promise.reject(new TypeError('开机自启动参数必须为布尔值'));
    return ipcRenderer.invoke('super-proxy:autostart:set', enabled);
  }
}));
