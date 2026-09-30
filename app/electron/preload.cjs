const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  // Resolve server URL synchronously after main publishes it.
  getServerUrl: () => ipcRenderer.sendSync('server:url'),
  getLanIps: () => ipcRenderer.invoke('lan:ips'),
  getShareSources: () => ipcRenderer.invoke('sources:list'),
});