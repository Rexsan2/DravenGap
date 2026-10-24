// Settings > Automation: "Keep running in the tray" and "Start with Windows" (tray-main.js applies them when settings.json is
// saved). The tray icon's menu can change them too, so the boxes are read again whenever the window comes back.
(function () {
    'use strict';
    const api = window.electronAPI;
    if (!api || !api.getSettings) return;
    const boxes = { trayMode: ['tray-mode-toggle', true], startWithWindows: ['start-windows-toggle', false] };
    async function read() {
        let s = {};
        try { s = (await api.getSettings()) || {}; } catch (e) { return; }
        for (const [key, [id, def]] of Object.entries(boxes)) {
            const el = document.getElementById(id);
            if (el) el.checked = s[key] == null ? def : !!s[key];
        }
    }
    function init() {
        for (const [key, [id]] of Object.entries(boxes)) {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', () => { if (window.DD && DD.patchSettings) DD.patchSettings({ [key]: el.checked }).catch(() => {}); });
        }
        read();
        window.addEventListener('focus', read);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
