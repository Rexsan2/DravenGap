// desktop-app/preload.js
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const FEATURE_CHANNEL = /^(profile|aram|arena|build|lcu|diag|mini|seed):[a-z0-9-]+$/;

contextBridge.exposeInMainWorld('electronAPI', {
  // Favorites
  getFavorites: () => ipcRenderer.invoke('get-favorites'),
  saveFavorites: (favorites) => ipcRenderer.invoke('save-favorites', favorites),
  
  // UI scale (Settings > Appearance, ui-states.js): page zoom factor 0.9 to 1.25 for this window
  setUiScale: (factor) => { const f = Number(factor); if (f >= 0.8 && f <= 1.5) webFrame.setZoomFactor(f); },

  // "Copy as image": rect in CSS pixels (getBoundingClientRect), scaled here by the UI zoom to window pixels
  copyRegion: (rect) => { const z = webFrame.getZoomFactor() || 1, n = v => Number(v) * z; return ipcRenderer.invoke('copy-region', { x: n(rect.x), y: n(rect.y), width: n(rect.width), height: n(rect.height) }); },

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // LCU
  getChampSelect: () => ipcRenderer.invoke('get-champ-select'),
  getPickableChampions: () => ipcRenderer.invoke('get-pickable-champions'),
  getPersonalStats: () => ipcRenderer.invoke('get-personal-stats'),

  // Riot API (optional history backfill). The key goes in but is never read back.
  getRiotKeyStatus: () => ipcRenderer.invoke('get-riot-key-status'),
  // true in a personal build (key inside the exe): the window then hides everything about keys (builtin-mode.js)
  builtinKey: (() => { try { return ipcRenderer.sendSync('is-builtin-key') === true; } catch (e) { return false; } })(),
  setRiotKey: (key) => ipcRenderer.invoke('set-riot-key', key),
  syncRiotHistory: () => ipcRenderer.invoke('sync-riot-history'),
  onRiotSyncProgress: (callback) => ipcRenderer.on('riot-sync-progress', (event, progress) => callback(progress)),

  // Local LoLalytics scraper (past patches, 7/14 day windows)
  scrapeStart: (jobs, opts) => ipcRenderer.invoke('scrape-start', jobs, opts),
  scrapeCancel: () => ipcRenderer.invoke('scrape-cancel'),
  onScrapeEvent: (callback) => {
    for (const channel of ['scrape-progress', 'scrape-dataset', 'scrape-error', 'scrape-finished']) {
      ipcRenderer.on(channel, (event, payload) => callback(channel, payload));
    }
  },

  // Builds (Coachless WPA) download
  coachlessPatches: () => ipcRenderer.invoke('coachless-patches'),
  coachlessStart: (jobs) => ipcRenderer.invoke('coachless-start', jobs),
  coachlessCancel: () => ipcRenderer.invoke('coachless-cancel'),
  coachlessStored: (patch) => ipcRenderer.invoke('coachless-stored', patch),
  coachlessStatus: () => ipcRenderer.invoke('coachless-status'),
  coachlessDetail: (req) => ipcRenderer.invoke('coachless-detail', req),
  coachlessChampion: (req) => ipcRenderer.invoke('coachless-champion', req),
  coachlessRateStatus: () => ipcRenderer.invoke('coachless-rate-status'),
  onCoachlessEvent: (callback) => {
    for (const channel of ['coachless-progress', 'coachless-dataset', 'coachless-error', 'coachless-finished']) {
      ipcRenderer.on(channel, (event, payload) => callback(channel, payload));
    }
  },

  // Feature modules (profile-main, aram-main, arena-main, skills-main, lcu-apply, diagnostics-main, mini-main): channels under their own prefixes only.
  feature: {
    invoke: (channel, ...args) => FEATURE_CHANNEL.test(channel)
      ? ipcRenderer.invoke(channel, ...args)
      : Promise.reject(new Error(`IPC channel not allowed: ${channel}`)),
    on: (channel, callback) => {
      if (!FEATURE_CHANNEL.test(channel)) return () => {};
      const handler = (event, payload) => callback(payload);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler); // unsubscribe
    },
  },
});
