// desktop-app/mini-feed.js
// Main-window side of the mini window (A5, see mini-main.js): DD.mini = { open, close, toggle, isOpen, push }.
// While the mini window is open the rows are recomputed every 1.5 s and sent when they changed: the ARAM Mayhem options in
// the ARAM view, otherwise the draft's top picks for the selected slot or your lane (DD.miniDraftData in index.html).
// Settings > Automation "Open the mini window in champion select" (settings.miniAuto, off by default): it then opens when
// champion select starts and closes again when the game starts (only if it was opened that way).
(function () {
    'use strict';
    const DD = window.DD;
    const api = window.electronAPI && window.electronAPI.feature;
    if (!DD || !api) return;
    const ACTIVE = new Set(['GameStart', 'InProgress', 'Reconnect']);
    let open = false, timer = null, lastSig = '', auto = false, autoOpened = false;

    function setOpen(v) {
        if (v === open) return;
        open = v;
        window.dispatchEvent(new CustomEvent('mini-state', { detail: { open } }));
        if (open) { if (!timer) { push(true); timer = setInterval(push, 1500); } }
        else { clearInterval(timer); timer = null; lastSig = ''; autoOpened = false; }
    }
    async function payload() {
        if (DD.currentView() === 'aram' && window.DDAram && window.DDAram.miniData) return window.DDAram.miniData();
        // once your champion is locked in (and through the game), the game plan instead of the pick list
        const g = DD.flow && DD.flow.state.game;
        if (g && g.locked && g.pick && g.lane && DD.gamePlan) { const p = await DD.gamePlan(g.pick, g.lane); if (p) return planPayload(p); }
        if (DD.miniDraftData) return DD.miniDraftData();
        return { mode: 'sr', rows: [], empty: 'Loading…' };
    }
    const LANE = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', SUPPORT: 'Support' };
    const pts = v => (v == null || !isFinite(v) ? '–' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}`);
    function planPayload(p) {
        const lines = [{ label: 'Exp WR', value: p.expWr == null ? '–' : (p.expWr * 100).toFixed(1) + '%', cls: p.expWr >= 0.5 ? 'pos' : 'neg', sub: p.expSd != null ? `± ${(p.expSd * 100).toFixed(1)}` : '' }];
        if (p.laneEffect) lines.push({ label: `Lane vs ${p.oppName}`, value: pts(p.laneEffect.mean), cls: p.laneEffect.mean >= 0 ? 'pos' : 'neg', sub: p.laneEffect.pp != null ? `PP ${Math.round(p.laneEffect.pp * 100)}%` : '' });
        else if (p.blind) lines.push({ label: 'Lane (opponent unknown)', value: pts(p.blind.ev), cls: p.blind.ev >= 0 ? 'pos' : 'neg', sub: 'expected' });
        if (p.verdict) lines.push({ label: 'Draft', value: Math.abs(p.verdict.wr - 0.5) < 0.02 ? 'Even' : (p.verdict.wr * 100).toFixed(1) + '%', cls: Math.abs(p.verdict.wr - 0.5) < 0.02 ? '' : p.verdict.wr > 0.5 ? 'pos' : 'neg', sub: 'your team' });
        if (p.you && p.you.offset != null) lines.push({ label: `You on ${p.name}`, value: pts(p.you.offset), cls: p.you.offset >= 0 ? 'pos' : 'neg', sub: `${p.you.games} games` });
        if (p.vsItems && p.vsItems.length) lines.push({ label: `Items vs ${p.oppName}`, value: p.vsItems.map(i => i.name).join(', '), cls: '' });
        const cname = id => ((DD.getChampions() || []).find(x => x.id === id) || {}).name || id;
        if (!p.opponent && p.blind && p.blind.counters.length) lines.push({ label: 'Watch out for', value: p.blind.counters.slice(0, 3).map(c => cname(c.champion)).join(', '), cls: 'neg' });
        for (const w of p.warnings.slice(0, 2)) lines.push({ label: 'Note', value: w, cls: 'warn' });
        return { mode: 'plan', title: `${p.name} ${LANE[p.lane] || p.lane}${p.oppName ? ' vs ' + p.oppName : ''}`, sub: `Game plan · ${p.label}`, rows: [], lines };
    }
    async function push(force) {
        if (!open) return;
        let p;
        try { p = await payload(); } catch (e) { p = { mode: 'sr', rows: [], empty: 'Could not compute the picks: ' + e.message }; }
        const sig = JSON.stringify(p);
        if (!force && sig === lastSig) return;
        lastSig = sig;
        api.invoke('mini:update', Object.assign({}, p, { at: Date.now() })).catch(() => {});
    }
    const call = ch => api.invoke(ch).then(r => { setOpen(!!(r && r.open)); return r; }).catch(e => ({ ok: false, error: e.message }));
    DD.mini = { open: () => call('mini:open'), close: () => call('mini:close'), toggle: () => call('mini:toggle'), isOpen: () => open, push: () => push(true) };

    api.on('mini:state', ev => setOpen(!!(ev && ev.open)));
    api.invoke('mini:state').then(r => setOpen(!!(r && r.open))).catch(() => {});
    DD.onView(() => push(true));
    // a row clicked in the mini window
    api.on('mini:pick', ev => {
        if (!ev || !ev.id) return;
        if (ev.mode === 'aram') { if (window.DDAram && window.DDAram.selectByKey) window.DDAram.selectByKey(Number(ev.id)); }
        else if (DD.showPickInDraft) DD.showPickInDraft(ev.id);
    });

    // automation: open in champion select, close when the game starts (if opened automatically)
    const toggle = document.getElementById('mini-auto-toggle');
    (async () => {
        try { const s = await window.electronAPI.getSettings(); auto = !!(s && s.miniAuto); } catch (e) { /* default off */ }
        if (toggle) toggle.checked = auto;
    })();
    if (toggle) toggle.addEventListener('change', () => { auto = toggle.checked; DD.patchSettings({ miniAuto: auto }).catch(() => {}); });
    api.on('profile:phase', ev => {
        if (!auto || !ev || ev.next === ev.prev) return;
        if (ev.next === 'ChampSelect' && !open) { autoOpened = true; DD.mini.open().then(() => { autoOpened = true; }); }
        else if (ACTIVE.has(ev.next) && autoOpened && open) DD.mini.close();
    });
})();
