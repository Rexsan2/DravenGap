// desktop-app/notifications.js
// In-app notifications for real events. Renderer only; builds on DD.toast (app-shell.js).
//   Events   Your profile updated after a game: profile:update { kind:'matches', owner:true }, with the LP change when the LP
//            tracker recorded one (profile:update { kind:'lp', entry }). The two arrive in either order: one toast, the LP is
//            added to it when it comes second.
//            New patch data downloaded: DD.notify.dataReady({ patch }) / ({ kind:'scrape', saved }) from the freshness code
//            in index.html. Coachless download finished for the champion you opened: DD.notify.coachless(...) from Builds.
//            Champion select started: profile:phase.
//   Quiet    The same event never shows twice; nothing shows during champion select except the champion-select-start toast
//            (the rest is held and shown after it).
//   Settings Settings > Automation: notifyToasts (in-app toasts, default on) and notifyWindows ("Also show Windows
//            notifications", default off; the HTML5 Notification API, only while this window is in the background).
(function () {
    'use strict';
    const DD = window.DD;
    if (!DD || !DD.toast) return;
    const api = window.electronAPI && window.electronAPI.feature;
    const N = { toasts: true, windows: false, phase: null, seen: new Map(), held: [], lp: null, post: null, lpTimer: null, selects: 0 };
    const OPTS = { lpGraceMs: 8000, dedupeMs: 10 * 60e3, lpFreshMs: 15 * 60e3, holdMaxMs: 15 * 60e3, winOnlyWhenUnfocused: true };
    const QUEUE = { 420: 'Ranked Solo/Duo', 440: 'Ranked Flex', 400: 'Normal Draft', 430: 'Normal Blind', 450: 'ARAM', 2400: 'ARAM Mayhem', 490: 'Quickplay', 480: 'Swiftplay', 1700: 'Arena', 1710: 'Arena', 1750: 'Arena' };
    const ARAM_QUEUES = new Set([100, 450, 720, 2400]);
    const ARENA_QUEUES = new Set([1700, 1710, 1750]);
    const LANE = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', SUPPORT: 'Support' };
    const champName = id => { const c = (DD.getChampions() || []).find(x => x.id === id); return c ? c.name : id; };
    const profile = tab => (window.DDProfile && window.DDProfile.openFromOutside ? window.DDProfile.openFromOutside(null, tab) : DD.showView('profile'));
    // your profile, even when someone else's is on screen (the toasts below are about your games)
    const ownProfile = () => (window.DDProfile && window.DDProfile.openOwner ? window.DDProfile.openOwner() : profile('summary'));

    // ---- one notification: in-app toast (+ a Windows notification when asked for and the window is in the background)
    function winNotify(text, key) {
        if (!N.windows || typeof window.Notification !== 'function') return;
        if (OPTS.winOnlyWhenUnfocused && !document.hidden && document.hasFocus()) return;
        try {
            const go = () => { const n = new window.Notification('DravenGap', { body: text, tag: key, silent: true }); n.onclick = () => { try { window.focus(); } catch (e) { /* ignore */ } }; };
            const p = window.Notification.permission;
            if (p === 'granted') go();
            else if (p !== 'denied' && window.Notification.requestPermission) Promise.resolve(window.Notification.requestPermission()).then(r => { if (r === 'granted') go(); }).catch(() => {});
        } catch (e) { /* not available here: the toast is enough */ }
    }
    // opts: action, actionLabel, ms (as DD.toast), champSelect (allowed during champion select), noToast (Windows only)
    function show(key, text, opts = {}) {
        if (!N.toasts) return null;
        const now = Date.now(), at = N.seen.get(key);
        if (at && now - at < OPTS.dedupeMs) return null;                    // the same event again
        if (N.phase === 'ChampSelect' && !opts.champSelect) {               // quiet during champion select: shown afterwards
            N.held = N.held.filter(h => h.key !== key).concat({ key, text, opts, at: now }).slice(-3);
            return 'held';
        }
        N.seen.set(key, now);
        if (N.seen.size > 200) for (const k of [...N.seen.keys()].slice(0, 100)) N.seen.delete(k);
        winNotify(text, key);
        return opts.noToast ? null : DD.toast(text, { action: opts.action, actionLabel: opts.actionLabel, ms: opts.ms });
    }
    function flushHeld() {
        const list = N.held.splice(0).filter(h => Date.now() - h.at < OPTS.holdMaxMs);
        for (const h of list) show(h.key, h.text, h.opts);
    }

    // ---- your profile updated (+ LP)
    const signed = n => `${n >= 0 ? '+' : ''}${n} LP`;
    const APEX = /^(MASTER|GRANDMASTER|CHALLENGER)$/;
    const rankText = a => (a && a.tier ? `${a.tier[0]}${a.tier.slice(1).toLowerCase()}${APEX.test(a.tier) || !a.rank || a.rank === 'NA' ? '' : ' ' + a.rank} ${a.lp} LP` : '');
    const lpPart = lp => `${lp.win === true ? 'win, ' : lp.win === false ? 'loss, ' : ''}${signed(lp.delta)}${rankText(lp.after) ? ` (now ${rankText(lp.after)})` : ''}`;
    const postText = (n, lp) => `Your profile updated: ${n} new game${n === 1 ? '' : 's'}${lp ? ' · ' + lpPart(lp) : ''}`;
    function onMatches(ev) {
        if (!ev || !ev.owner) return;                                        // somebody else's profile refreshed
        const n = ev.added || (ev.ids && ev.ids.length) || 1;
        const key = 'm:' + (ev.ids && ev.ids.length ? ev.ids.join(',') : `${ev.puuid || ''}:${n}:${Math.floor(Date.now() / 6e4)}`);
        const lp = N.lp && !N.lp.used && Date.now() - N.lp.at < OPTS.lpFreshMs ? N.lp : null;
        const post = { n, hasLp: !!lp };
        const el = show(key, postText(n, lp), { ms: 9000, action: ownProfile, actionLabel: 'Open', post });
        if (el && lp) { lp.used = true; clearTimeout(N.lpTimer); }               // shown or held: the LP is in it, no LP-only toast
        if (el && el !== 'held') N.post = { el, n, hasLp: !!lp };
    }
    function onLp(entry) {
        if (!entry || entry.dodge || typeof entry.delta !== 'number') return;
        const key = 'lp:' + (entry.at || `${entry.q}:${entry.delta}`);
        if (N.seen.has('lp-ev:' + key)) return;                              // the same LP entry again
        N.seen.set('lp-ev:' + key, Date.now());
        const lp = { delta: entry.delta, win: entry.win, after: entry.after, at: Date.now(), used: false };
        N.lp = lp;
        const H = N.held.find(h => h.opts.post && !h.opts.post.hasLp);   // a profile update held during champion select: add it there
        if (H) { H.opts.post.hasLp = true; lp.used = true; H.text = postText(H.opts.post.n, lp); return; }
        const P = N.post;
        if (P && !P.hasLp && P.el && P.el.isConnected) {                     // the profile toast is still up: add the LP to it
            P.hasLp = true; lp.used = true;
            const span = P.el.querySelector('span');
            if (span) span.textContent = postText(P.n, lp);
            return;
        }
        clearTimeout(N.lpTimer);                                             // wait a little for the profile update, else say it alone
        N.lpTimer = setTimeout(() => { if (!lp.used) { lp.used = true; show(key, `Ranked game: ${lpPart(lp)}`, { action: ownProfile, actionLabel: 'Open' }); } }, OPTS.lpGraceMs);
    }

    // ---- champion select started (and the phase, for the quiet rule)
    function onPhase(ev) {
        if (!ev) return;
        const was = N.phase;
        N.phase = ev.next;
        if (ev.next === 'ChampSelect' && was !== 'ChampSelect') {
            const q = QUEUE[ev.queueId], aram = ARAM_QUEUES.has(ev.queueId), arena = ARENA_QUEUES.has(ev.queueId), view = aram ? 'aram' : arena ? 'arena' : 'draft';
            // "Follow my game" (app-shell.js) already says so when it switches the view: not twice
            const shell = [...document.querySelectorAll('.dg-toast')].some(t => /^Champion select:/.test(t.textContent));
            show('cs:' + (++N.selects), `Champion select started${q ? ': ' + q : ''}.`, { champSelect: true, noToast: shell,
                action: DD.currentView() === view ? null : () => DD.showView(view), actionLabel: aram ? 'Open ARAM' : arena ? 'Open Arena' : 'Open draft' });
        } else if (was === 'ChampSelect' && ev.next !== 'ChampSelect') flushHeld();
    }

    // ---- hooks called from index.html
    const PATCH_KEY = 'dg-notify-patch';
    // the freshness code finished an automatic download: { patch } after R2 data was reloaded, { kind:'scrape', saved } after an automatic re-download
    function dataReady(info) {
        info = info || {};
        if (info.kind === 'scrape') {
            if (info.saved > 0) show(`scrape:${info.saved}:${Math.floor(Date.now() / 6e5)}`, `Your downloaded data was refreshed (${info.saved} saved).`, { action: () => DD.showView('tierlist'), actionLabel: 'Tier list' });
            return;
        }
        if (!info.patch) return;
        let before = null;
        try { before = localStorage.getItem(PATCH_KEY); localStorage.setItem(PATCH_KEY, info.patch); } catch (e) { /* storage unavailable */ }
        if (!before || before === info.patch) return;                        // first start: only remember the patch
        show('patch:' + info.patch, `Patch ${info.patch} data is ready.`, { action: () => DD.showView('tierlist'), actionLabel: 'Tier list' });
    }
    // a Coachless download for { champion, role } finished (visible = its Builds page is open and repaints by itself)
    function coachless(info) {
        if (!info || !info.champion || info.visible) return;
        const lane = LANE[info.role];
        show(`cl:${info.champion}|${info.role || ''}`, `Coachless data for ${champName(info.champion)}${lane ? ' ' + lane : ''} is ready.`,
            { action: () => DD.openBuilds && DD.openBuilds(info.champion, info.role), actionLabel: 'Open' });
    }

    // ---- Settings > Automation
    const tToggle = document.getElementById('notify-toast-toggle'), wToggle = document.getElementById('notify-win-toggle');
    const hasNative = () => typeof window.Notification === 'function';
    function syncToggles() {
        if (tToggle) tToggle.checked = N.toasts;
        if (wToggle) { wToggle.checked = N.windows; wToggle.disabled = !N.toasts || !hasNative(); }
    }
    (async () => {
        try { const s = await window.electronAPI.getSettings(); N.toasts = !(s && s.notifyToasts === false); N.windows = !!(s && s.notifyWindows); } catch (e) { /* defaults: toasts on, Windows off */ }
        syncToggles();
    })();
    if (tToggle) tToggle.addEventListener('change', () => { N.toasts = tToggle.checked; syncToggles(); DD.patchSettings({ notifyToasts: N.toasts }).catch(() => {}); });
    if (wToggle) wToggle.addEventListener('change', () => {
        N.windows = wToggle.checked && hasNative();
        syncToggles();
        DD.patchSettings({ notifyWindows: N.windows }).catch(() => {});
        if (N.windows && window.Notification.permission === 'default' && window.Notification.requestPermission) Promise.resolve(window.Notification.requestPermission()).catch(() => {});
    });

    if (api) {
        api.on('profile:update', ev => { if (ev && ev.kind === 'matches') onMatches(ev); else if (ev && ev.kind === 'lp') onLp(ev.entry); });
        api.on('profile:phase', onPhase);
        api.invoke('profile:me').then(r => { if (r && r.ok && r.phase && N.phase == null) N.phase = r.phase; }).catch(() => {});
    }
    DD.notify = { state: N, opts: OPTS, show, flushHeld, dataReady, coachless, onPhase };
})();
