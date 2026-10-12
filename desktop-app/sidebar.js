// desktop-app/sidebar.js
// Left sidebar navigation (E1): Draft, ARAM Mayhem, Arena, Builds, Champions, Profile, Live game (red dot while you are in a game),
// Dodgeball; then the mini window, Glossary, How to Use and Settings. The markup is static in index.html (#sidebar) so the
// Settings / How to Use buttons keep their ids for the scripts that bind them. Collapsible; the choice is saved
// (settings.sidebarCollapsed). Also restores the saved game mode (settings.gameMode: 'sr' | 'aram-mayhem' | 'arena') at start.
(function () {
    'use strict';
    const DD = window.DD;
    const nav = document.getElementById('sidebar');
    if (!DD || !nav) return;
    const api = window.electronAPI && window.electronAPI.feature;
    const MODE_VIEW = { 'sr': 'draft', 'aram-mayhem': 'aram', 'arena': 'arena' };
    const items = [...nav.querySelectorAll('.sb-item[data-view]')];
    const ACTIVE = new Set(['GameStart', 'InProgress', 'Reconnect']);
    let inGame = false;

    const profileTab = () => (window.DDProfile && window.DDProfile.state && window.DDProfile.state.tab) || null;
    function current() {
        const v = DD.currentView();
        return v === 'profile' && profileTab() === 'live' ? 'live' : v;
    }
    function sync() {
        const cur = current();
        for (const b of items) {
            const on = b.dataset.view === cur;
            b.classList.toggle('active', on);
            if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
        }
        const live = nav.querySelector('[data-view="live"]');
        live.classList.toggle('live-on', inGame);
        live.title = inGame ? 'You are in a game: open the live game' : 'Your live game: all 10 players scouted';
    }

    function go(view) {
        if (view === 'live') {
            if (window.DDProfile && window.DDProfile.openFromOutside) window.DDProfile.openFromOutside(null, 'live');
            else DD.showView('profile');
        } else if (view === 'profile') {
            DD.showView('profile');
            if (profileTab() === 'live' && window.DDProfile && window.DDProfile.showTab) window.DDProfile.showTab('summary');
        } else {
            DD.showView(view);
        }
        if (view === 'draft' || view === 'aram' || view === 'arena') DD.patchSettings({ gameMode: view === 'draft' ? 'sr' : view === 'aram' ? 'aram-mayhem' : 'arena' }).catch(() => {});
        sync();
    }

    nav.addEventListener('click', e => {
        const b = e.target.closest('.sb-item');
        if (!b) return;
        if (b.dataset.view) { go(b.dataset.view); return; }
        const act = b.dataset.act;
        if (act === 'glossary') { if (DD.openGlossary) DD.openGlossary(); }
        else if (act === 'mini') { if (DD.mini) DD.mini.toggle(); }
        else if (act === 'collapse') setCollapsed(!document.body.classList.contains('sb-collapsed'), true);
    });

    function setCollapsed(on, persist) {
        document.body.classList.toggle('sb-collapsed', on);
        const c = nav.querySelector('[data-act="collapse"] .sb-label');
        if (c) c.textContent = on ? 'Expand' : 'Collapse';
        if (persist) DD.patchSettings({ sidebarCollapsed: on }).catch(() => {});
    }

    // the mini window button shows whether the window is open (DD.mini comes from mini.js and fires 'mini-state')
    window.addEventListener('mini-state', e => { const b = nav.querySelector('[data-act="mini"]'); if (b) b.classList.toggle('active', !!(e.detail && e.detail.open)); });

    DD.onView(sync);
    nav.ownerDocument.getElementById('profile-root').addEventListener('click', () => setTimeout(sync, 0)); // Profile's own tabs
    if (api) {
        api.on('profile:live', ev => { if (ev && typeof ev.active === 'boolean') { inGame = ev.active; sync(); } });
        api.on('profile:phase', ev => { if (ev && ev.next) { inGame = ACTIVE.has(ev.next); sync(); } });
        api.invoke('profile:me').then(r => { if (r && r.ok && r.phase) { inGame = ACTIVE.has(r.phase); sync(); } }).catch(() => {});
    }

    // saved layout + game mode
    (async () => {
        let s = null;
        try { s = await window.electronAPI.getSettings(); } catch (e) { /* defaults */ }
        setCollapsed(s && typeof s.sidebarCollapsed === 'boolean' ? s.sidebarCollapsed : window.innerWidth < 1600, false); // icons only on smaller windows until chosen
        await DD.ready;
        if (s && MODE_VIEW[s.gameMode] && ['draft', 'aram', 'arena'].includes(DD.currentView())) DD.showView(MODE_VIEW[s.gameMode]);
        sync();
    })();
    sync();
    DD.sidebar = { sync, isInGame: () => inGame, go };
})();
