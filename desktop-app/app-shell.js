// desktop-app/app-shell.js
// App-wide helpers on top of the views (renderer only; talks to them through window.DD / DDProfile / DDAram):
//   - Command palette (Ctrl+K / Ctrl+P): champions (builds, ARAM), views, Riot IDs ("Name#TAG"), recent profiles
//   - Keyboard shortcuts in the draft: 1-5 = suggest for your top..support, Shift+1-5 = the enemy's, R / A / B / D = tabs, ? = help
//   - "Follow my game": switches views with the League client's phase (champ select -> Draft or ARAM, game -> Live game
//     or the ARAM build, end of game -> Profile). Setting followGame (on by default); a manual click always wins until
//     the next phase change.
//   - Toasts: DD.toast(text, { action, actionLabel, ms })
(function () {
    const DD = window.DD;
    if (!DD) return;
    const api = window.electronAPI && window.electronAPI.feature;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const typing = () => { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable); };
    const modalOpen = () => [...document.querySelectorAll('#how-to-use-modal, #storage-modal, #range-modal, #settings-modal, #glossary-modal')].some(m => m.style.display && m.style.display !== 'none');

    // ---------------------------------------------------------------- toasts
    const host = document.createElement('div');
    host.className = 'dg-toasts';
    document.body.appendChild(host);
    function toast(text, opts = {}) {
        const el = document.createElement('div');
        el.className = 'dg-toast';
        el.innerHTML = `<span>${esc(text)}</span>${opts.action ? `<button>${esc(opts.actionLabel || 'Open')}</button>` : ''}<i title="Dismiss">&times;</i>`;
        const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 250); };
        el.querySelector('i').addEventListener('click', close);
        if (opts.action) el.querySelector('button').addEventListener('click', () => { close(); opts.action(); });
        host.appendChild(el);
        while (host.children.length > 4) host.firstChild.remove();
        setTimeout(close, opts.ms || 6000);
        return el;
    }
    DD.toast = toast;

    // ---------------------------------------------------------------- command palette
    const back = document.createElement('div');
    back.className = 'dg-pal-back';
    back.style.display = 'none';
    back.innerHTML = `<div class="dg-pal" role="dialog" aria-label="Command palette">
        <input class="dg-pal-in" type="text" spellcheck="false" autocomplete="off" placeholder="Search champions, views, or a Riot ID (Name#TAG)…">
        <div class="dg-pal-list" role="listbox"></div>
        <div class="dg-pal-foot">↑↓ move · Enter open · Esc close · <b>Ctrl+K</b> anywhere</div></div>`;
    document.body.appendChild(back);
    const input = back.querySelector('.dg-pal-in'), list = back.querySelector('.dg-pal-list');
    let items = [], sel = 0;

    const click = sel => () => { const el = document.querySelector(sel); if (el) el.click(); };
    const draftTab = sel => () => { DD.showView('draft'); setTimeout(click(sel), 0); };
    const VIEWS = [
        { label: "Summoner's Rift draft", hint: 'view', run: () => DD.showView('draft'), keys: 'sr draft recommendations' },
        { label: 'Draft: Bans', hint: 'tab', run: draftTab('#bans-tab-btn'), keys: 'ban bans' },
        { label: 'Draft: Draft Analysis', hint: 'tab', run: draftTab('#analysis-tab-btn'), keys: 'analysis matchup grid verdict' },
        { label: 'Draft: Duo', hint: 'tab', run: draftTab('#duo-tab-btn'), keys: 'duo premade partner synergy bot support pair' },
        { label: 'ARAM Mayhem', hint: 'view', run: () => DD.showView('aram'), keys: 'aram mayhem augments' },
        { label: 'Arena', hint: 'view', run: () => DD.showView('arena'), keys: 'arena augments 2v2 3v3 cherry' },
        { label: 'Builds', hint: 'view', run: () => DD.showView('builds'), keys: 'builds items runes coachless' },
        { label: 'Champion pages', hint: 'view', run: () => DD.showView('champion'), keys: 'champion hub page matchups synergies counters' },
        { label: 'Tier list', hint: 'view', run: () => DD.showView('tierlist'), keys: 'tier list tierlist meta best champions patch movers buffs nerfs' },
        { label: 'Multi-search', hint: 'view', run: () => DD.showView('scout'), keys: 'multi search multisearch lobby scout players paste' },
        { label: 'Game plan', hint: 'flow', run: () => DD.flow && DD.flow.openPlan(), keys: 'game plan matchup brief lane opponent post lock' },
        { label: 'Send runes, spells and item set to the client', hint: 'flow', run: () => DD.flow && DD.flow.send(false), keys: 'send apply import runes spells items client' },
        { label: 'Profile', hint: 'view', run: () => profile(null, 'summary'), keys: 'profile summary matches' },
        { label: 'My profile', hint: 'view', run: () => (window.DDProfile && window.DDProfile.openOwner ? window.DDProfile.openOwner() : profile(null, 'summary')), keys: 'my own profile home me account' },
        { label: 'Profile: Insights', hint: 'tab', run: () => profile(null, 'insights'), keys: 'insights stats form tilt backtest' },
        { label: 'Profile: Live game', hint: 'tab', run: () => profile(null, 'live'), keys: 'live game spectate scout' },
        { label: 'Dodgeball', hint: 'view', run: () => DD.showView('dodgeball'), keys: 'dodgeball mundo game' },
        { label: 'Settings', hint: 'dialog', run: click('#settings-btn'), keys: 'settings riot key account follow' },
        { label: 'How to Use', hint: 'dialog', run: click('#how-to-use-btn'), keys: 'help how to use guide' },
        { label: 'Mini window (always on top)', hint: 'window', run: () => DD.mini && DD.mini.toggle(), keys: 'mini compact small overlay always on top champ select' },
        { label: 'Glossary', hint: 'dialog', run: () => DD.openGlossary && DD.openGlossary(), keys: 'glossary definitions pp wpa exp wr shrunk delta dd score tags colours explain' },
        { label: 'Saved data', hint: 'dialog', run: click('#storage-info'), keys: 'saved data storage download history' },
        { label: 'Practice draft', hint: 'draft', run: () => DD.practiceDraft && DD.practiceDraft(), keys: 'practice draft what if manual offline sandbox' },
        { label: 'Run setup check', hint: 'dialog', run: () => DD.onboarding && DD.onboarding.open(), keys: 'setup check first run onboarding wizard client riot key account data' }
    ];
    function profile(acct, tab) {
        if (window.DDProfile && window.DDProfile.openFromOutside) window.DDProfile.openFromOutside(acct, tab);
        else DD.showView('profile');
    }
    async function defaultPlatform() {
        try { const s = await window.electronAPI.getSettings(); return (s && s.profileAccount && s.profileAccount.platform) || 'EUW1'; } catch (e) { return 'EUW1'; }
    }
    function build(q) {
        const out = [], nq = norm(q);
        const riot = q.match(/^\s*(.{2,16})#([A-Za-z0-9]{2,5})\s*$/);
        if (riot) out.push({ label: `Open profile ${riot[1]}#${riot[2]}`, hint: 'Riot ID', run: async () => profile({ gameName: riot[1].trim(), tagLine: riot[2], platform: await defaultPlatform() }, 'summary') });
        const rec = (window.DDProfile && window.DDProfile.state && window.DDProfile.state.recent) || [];
        for (const a of rec) if (!nq || norm(a.gameName + a.tagLine).includes(nq)) out.push({ label: `${a.gameName}#${a.tagLine}`, hint: `profile · ${a.platform}`, run: () => profile(a, 'summary') });
        if (nq) {
            const champs = (DD.getChampions() || []).map(c => ({ c, n: norm(c.name), i: norm(c.id) }))
                .filter(x => x.n.includes(nq) || x.i.includes(nq))
                .sort((a, b) => (b.n.startsWith(nq) - a.n.startsWith(nq)) || a.n.localeCompare(b.n)).slice(0, 4);
            for (const { c } of champs) {
                out.push({ label: `${c.name}`, hint: 'Champion page', img: c, run: () => DD.openChampion && DD.openChampion(c.id) });
                out.push({ label: `${c.name}`, hint: 'Builds (Coachless)', img: c, run: () => DD.openBuilds && DD.openBuilds(c.id) });
                out.push({ label: `${c.name}`, hint: 'ARAM Mayhem build', img: c, run: () => window.DDAram && window.DDAram.selectByKey(c.key) });
            }
        }
        for (const v of VIEWS) if (!nq || norm(v.label + v.keys).includes(nq)) out.push(v);
        return out.slice(0, 16);
    }
    function render() {
        const base = DD.ddragonBase, patch = DD.getLatestPatch && DD.getLatestPatch();
        list.innerHTML = items.length ? items.map((it, i) => `<div class="dg-pal-item${i === sel ? ' on' : ''}" data-i="${i}" role="option">
            ${it.img && patch ? `<img src="${base}/cdn/${patch}/img/champion/${esc(it.img.image.full)}" alt="">` : '<span class="dg-pal-dot"></span>'}
            <span class="dg-pal-l">${esc(it.label)}</span><span class="dg-pal-h">${esc(it.hint || '')}</span></div>`).join('')
            : '<div class="dg-pal-empty">No matches. Try a champion name, a view, or Name#TAG.</div>';
        const on = list.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
    }
    function open() { back.style.display = ''; input.value = ''; items = build(''); sel = 0; render(); setTimeout(() => input.focus(), 0); }
    function close() { back.style.display = 'none'; }
    function run(i) { const it = items[i]; close(); if (it) Promise.resolve().then(it.run).catch(() => {}); }
    input.addEventListener('input', () => { items = build(input.value); sel = 0; render(); });
    input.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); render(); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
        else if (e.key === 'Enter') { run(sel); e.preventDefault(); }
        else if (e.key === 'Escape') { close(); e.preventDefault(); }
    });
    list.addEventListener('mousemove', e => { const it = e.target.closest('.dg-pal-item'); if (it && +it.dataset.i !== sel) { sel = +it.dataset.i; render(); } });
    list.addEventListener('click', e => { const it = e.target.closest('.dg-pal-item'); if (it) run(+it.dataset.i); });
    back.addEventListener('mousedown', e => { if (e.target === back) close(); });
    DD.openPalette = open;

    // ---------------------------------------------------------------- keyboard shortcuts
    const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'SUPPORT'];
    const HELP = 'Ctrl+K: search anything · Draft: 1–5 suggest for your Top…Support, Shift+1–5 for the enemy, R recommendations, A analysis, B bans, D duo · Esc closes';
    document.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K' || e.key === 'p' || e.key === 'P')) {
            e.preventDefault();
            if (back.style.display === 'none') open(); else close();
            return;
        }
        if (back.style.display !== 'none' || typing() || modalOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === '?') { toast(HELP, { ms: 9000 }); return; }
        if (DD.currentView() !== 'draft') return;
        const digit = /^Digit([1-5])$/.exec(e.code);
        if (digit) {
            const role = ROLES[+digit[1] - 1], side = e.shiftKey ? 'right' : 'left';
            const btn = document.querySelector(`[data-side='${side}'][data-role='${role}'] .suggest-btn`);
            if (btn) { btn.click(); e.preventDefault(); }
            return;
        }
        const tab = { r: '#rec-tab-btn', a: '#analysis-tab-btn', b: '#bans-tab-btn', d: '#duo-tab-btn' }[e.key.toLowerCase()];
        if (tab) { const el = document.querySelector(tab); if (el) { el.click(); e.preventDefault(); } }
    });

    // ---------------------------------------------------------------- Follow my game
    const ARAM_QUEUES = new Set([100, 450, 720, 2400]);
    const ARENA_QUEUES = new Set([1700, 1710, 1750]);
    const ACTIVE = new Set(['GameStart', 'InProgress', 'Reconnect']);
    let follow = true;
    const toggle = document.getElementById('follow-game-toggle');
    (async () => {
        try { const s = await window.electronAPI.getSettings(); follow = !(s && s.followGame === false); } catch (e) { /* default on */ }
        if (toggle) toggle.checked = follow;
    })();
    if (toggle) toggle.addEventListener('change', () => {
        follow = toggle.checked;
        if (DD.patchSettings) DD.patchSettings({ followGame: follow }).catch(() => {});
    });
    function onPhase(ev) {
        if (!follow || !ev || ev.next === ev.prev) return;
        const aram = ARAM_QUEUES.has(ev.queueId), arena = ARENA_QUEUES.has(ev.queueId);
        const mode = aram ? 'aram' : arena ? 'arena' : null;   // these modes keep their own view in champion select and in game
        if (ev.next === 'ChampSelect') {
            const view = mode || 'draft';
            if (DD.currentView() !== view) { DD.showView(view); toast(`Champion select: switched to ${aram ? 'ARAM Mayhem' : arena ? 'Arena' : 'the draft'}. (Follow my game, in Settings)`); }
        } else if (ACTIVE.has(ev.next) && !ACTIVE.has(ev.prev)) {
            if (mode) { if (DD.currentView() !== mode) DD.showView(mode); }
            else { profile(null, 'live'); toast('Game started: showing the live game.'); }
        } else if ((ev.next === 'EndOfGame' || ev.next === 'PreEndOfGame') && ACTIVE.has(ev.prev)) {
            profile(null, 'summary');
            toast('Game over: your match appears in Profile once Riot publishes it (usually within a minute).', { ms: 8000 });
        }
    }
    if (api) api.on('profile:phase', onPhase);
    DD.followGame = { onPhase, isOn: () => follow };   // for tests

    // ---- "Copy as image" (REC 2.11 / FEEDBACK B11): the element as a PNG on the clipboard, for Discord. It is scrolled into view
    // first (only what is on screen can be captured) and cut to the window; the button that asked is hidden while capturing.
    DD.copyAsImage = async (el, what = 'it') => {
        const api = window.electronAPI;
        if (!el || !api || !api.copyRegion) return { ok: false };
        el.scrollIntoView({ block: 'nearest' });
        const hide = [...el.querySelectorAll('[data-copy-hide]')];
        hide.forEach(b => { b.style.visibility = 'hidden'; });
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const b = el.getBoundingClientRect();
        const x = Math.max(0, b.left), y = Math.max(0, b.top), rect = { x, y, width: Math.min(innerWidth, b.right) - x, height: Math.min(innerHeight, b.bottom) - y };
        let r;
        try { r = await api.copyRegion(rect); } catch (e) { r = { ok: false, error: e.message }; }
        hide.forEach(x2 => { x2.style.visibility = ''; });
        toast(r && r.ok ? `Copied ${what} as an image: paste it in Discord or anywhere.` : `Could not copy ${what}: ${(r && r.error) || 'unknown error'}`);
        return r || { ok: false };
    };
})();
