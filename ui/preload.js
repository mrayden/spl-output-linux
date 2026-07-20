const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  report: (days, all, device) => ipcRenderer.invoke('report', { days, all, device }),
  devices: () => ipcRenderer.invoke('devices'),
  setCap: (v) => ipcRenderer.invoke('setCap', v),
  whitelist: (match, on) => ipcRenderer.invoke('whitelist', { match, on }),
  playtone: (freq, level) => ipcRenderer.invoke('playtone', { freq, level }),
  addCalib: (device, volume, freq, slope, offset) => ipcRenderer.invoke('addCalib', { device, volume, freq, slope, offset }),
  calibList: () => ipcRenderer.invoke('calibList'),
  delCalib: (device, volume, freq) => ipcRenderer.invoke('delCalib', { device, volume, freq }),
  getUiSettings: () => ipcRenderer.invoke('getUiSettings'),
  setUiSetting: (key, value) => ipcRenderer.invoke('setUiSetting', { key, value }),
  trayUpdate: (image, tip) => ipcRenderer.send('tray-update', { image, tip }),
  onLive: (cb) => ipcRenderer.on('live', (e, obj) => cb(obj))
});
