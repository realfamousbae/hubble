'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Безопасный мост renderer ↔ main. Никакого прямого доступа к Node из UI.
contextBridge.exposeInMainWorld('hubble', {
  /** Список сервисов из apps.json. */
  getApps: () => ipcRenderer.invoke('get-apps'),

  /** Сохранённая раскладка окон (дерево тайлинга, фокус, разворот). */
  getWorkspace: () => ipcRenderer.invoke('get-workspace'),

  /** Запомнить раскладку окон. */
  setWorkspace: (state) => ipcRenderer.invoke('set-workspace', state),

  /** Сохранённая громкость по сервисам: { [id]: 0..1 }. */
  getVolumes: () => ipcRenderer.invoke('get-volumes'),

  /** Запомнить громкость конкретного сервиса. */
  setVolume: (id, v) => ipcRenderer.send('set-volume', { id, v }),

  /** Управление окном приложения (frameless): 'minimize' | 'maximize' | 'close'. */
  windowControl: (action) => ipcRenderer.send('window-control', action),

  /** Подписка на изменение состояния развёрнутости окна. */
  onMaximizeChange: (cb) => {
    const handler = (_e, isMax) => cb(isMax);
    ipcRenderer.on('window-maximized', handler);
    return () => ipcRenderer.removeListener('window-maximized', handler);
  },

  /** Показать нативное уведомление. */
  notify: (payload) => ipcRenderer.send('notify', payload),

  /** Прокинуть число непрочитанных для бейджа сайдбара. */
  reportUnread: (payload) => ipcRenderer.send('unread-count', payload),

  /** Подписка: клик по нативному уведомлению просит показать сервис. */
  onFocusApp: (cb) => {
    const handler = (_e, appId) => cb(appId);
    ipcRenderer.on('focus-app', handler);
    return () => ipcRenderer.removeListener('focus-app', handler);
  },

  /** Подписка на обновление бейджа непрочитанных. */
  onUnreadCount: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('unread-count', handler);
    return () => ipcRenderer.removeListener('unread-count', handler);
  },

  /** Подписка: Ctrl +/−/0 в активном webview просит зум ('in' | 'out' | 'reset'). */
  onZoom: (cb) => {
    const handler = (_e, dir) => cb(dir);
    ipcRenderer.on('zoom', handler);
    return () => ipcRenderer.removeListener('zoom', handler);
  },

  /** Подписка: main просит показать пикер источников демонстрации экрана.
   *  payload = { sources:[{id,name,isScreen,thumbnail,appIcon}], audioRequested }. */
  onPickScreenShare: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('pick-screen-share', handler);
    return () => ipcRenderer.removeListener('pick-screen-share', handler);
  },

  /** Ответ пикера демонстрации: { id, withAudio } либо {} для отмены. */
  pickScreenShare: (payload) => ipcRenderer.send('screen-share-pick', payload || {})
});
