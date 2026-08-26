'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tomato', {
  // 音频
  selectAudio: () => ipcRenderer.invoke('select-audio'),
  loadAudio: (filePath) => ipcRenderer.invoke('load-audio', filePath),
  // 无边框窗口控制
  minimize: () => ipcRenderer.send('win-minimize'),
  close: () => ipcRenderer.send('win-close'),
  toggleTop: () => ipcRenderer.send('win-toggle-top'),
  toggleLock: () => ipcRenderer.send('win-toggle-lock'),
  resizeTo: (w, h) => ipcRenderer.send('win-resize', w, h),
  // 置顶/锁定状态变化回调
  onWindowState: (cb) => ipcRenderer.on('win-state', (e, s) => cb(s)),
  // 开机自启动
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
  // 学习记录（Excel）
  readRecords: () => ipcRenderer.invoke('read-records'),
  recordStudy: (date, minutes) => ipcRenderer.invoke('record-study', date, minutes),
  getRecordFile: () => ipcRenderer.invoke('get-record-file')
});
