// desktop-app/workflow.js
// One workflow across the views. Renderer only.
//   Back / forward  every view change and context change (draft tab, Builds champion, champion page, Profile account and tab, ARAM
//                   champion, tier list role) is a step: Alt+Left / Alt+Right, the mouse's back / forward buttons, ‹ › in the bar.
//   Champion menu   right-click any champion picture in any view: its page, Builds (and vs the lane opponent), the ARAM build.
//   Game flow bar   (#flow-bar) the client's phase as steps (Lobby › Champion select › In game › Review), your lane / pick /
//                   opponent, the next actions for that step, and today's session (W/L and LP, profile:session).
//   Game plan       the post-lock-in brief (DD.gamePlan) in a panel under the bar; your record vs the opponent from Profile.
//   Send to client  rune page + spells + item set in one click (DD.sendAll); automatic on lock-in when settings.autoSend is on.
(function () {
    'use strict';
    const DD = window.DD;
    const api = window.electronAPI && window.electronAPI.feature;
    const bar = document.getElementById('flow-bar');
    if (!DD || !bar) return;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const LANE = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', SUPPORT: 'Support' };
    const champs = () => DD.getChampions() || [];
    const champ = id => champs().find(c => c.id === id) || null;
    const nameOf = id => (champ(id) || {}).name || id || '';
    const icon = (id, cls = 'fb-ico') => { const c = champ(id), v = DD.getLatestPatch && DD.getLatestPatch(); return c && v ? `<img class="${cls}" src="${DD.ddragonBase}/cdn/${v}/img/champion/${c.image.full}" alt="" onerror="this.style.visibility='hidden'">` : ''; };
    const pts = v => (v == null || !isFinite(v) ? '–' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}`);
    const pct = (v, d = 1) => (v == null || !isFinite(v) ? '–' : (v * 100).toFixed(d) + '%');
    const pp = p => (p == null ? '–' : `<span class="${DD.ppClass ? DD.ppClass(p) : ''}">${p > 0.995 ? '>99%' : p < 0.005 ? '<1%' : Math.round(p * 100) + '%'}</span>`);
    const help = k => (DD.help ? DD.help(k) : '');

    // ================================================================================================ back / forward
    const H = { list: [], i: -1, applying: false, timer: null };
    function ctxOf(view) {
        try {
            if (view === 'draft') return { tab: DD.draftTab ? DD.draftTab() : null };
            if (view === 'builds') return DD.buildsContext ? DD.buildsContext() : {};
            if (view === 'champion') { const s = window.DDHub && window.DDHub.state; return s ? { champ: s.champ, role: s.role, tab: s.tab } : {}; }
            if (view === 'profile') { const s = window.DDProfile && window.DDProfile.state; return s ? { acct: s.acct ? { gameName: s.acct.gameName, tagLine: s.acct.tagLine, platform: s.acct.platform } : null, tab: s.tab } : {}; }
            if (view === 'aram') return { key: window.DDAram && window.DDAram.selectedKey ? window.DDAram.selectedKey() : null };
            if (view === 'arena') return { key: window.DDArena && window.DDArena.selectedKey ? window.DDArena.selectedKey() : null };
            if (view === 'tierlist') return window.DDTier ? window.DDTier.context() : {};
            if (view === 'scout') return {};
        } catch (e) { /* a view not ready yet */ }
        return {};
    }
    const sig = e => JSON.stringify([e.view, e.ctx]);
    function record() {
        if (H.applying) return;
        const e = { view: DD.currentView(), ctx: ctxOf(DD.currentView()) };
        if (H.list[H.i] && sig(H.list[H.i]) === sig(e)) return;
        H.list = H.list.slice(0, H.i + 1);
        H.list.push(e);
        if (H.list.length > 80) H.list.shift();
        H.i = H.list.length - 1;
        paintNav();
    }
    const recordSoon = () => { clearTimeout(H.timer); H.timer = setTimeout(record, 350); };
    const sameAcct = (a, b) => !!a && !!b && String(a.gameName).toLowerCase() === String(b.gameName).toLowerCase() && String(a.tagLine).toLowerCase() === String(b.tagLine).toLowerCase() && a.platform === b.platform;
    async function apply(e) {
        H.applying = true;
        const c = e.ctx || {};
        try {
            if (e.view === 'builds' && c.champion && DD.openBuilds) DD.openBuilds(c.champion, c.role, c.vs);
            else if (e.view === 'champion' && c.champ && window.DDHub) { await window.DDHub.open(c.champ, c.role); if (c.tab) window.DDHub.setTab(c.tab); }
            else if (e.view === 'profile' && window.DDProfile) {
                const s = window.DDProfile.state;
                if (!c.acct || sameAcct(c.acct, s && s.acct)) { DD.showView('profile'); if (c.tab && window.DDProfile.showTab) window.DDProfile.showTab(c.tab); }
                else window.DDProfile.openFromOutside(c.acct, c.tab || 'summary');
            } else if (e.view === 'aram' && c.key && window.DDAram) window.DDAram.selectByKey(c.key);
            else if (e.view === 'arena' && c.key && window.DDArena) window.DDArena.selectByKey(c.key);
            else if (e.view === 'tierlist' && window.DDTier) { DD.showView('tierlist'); window.DDTier.restore(c); }
            else DD.showView(e.view);
            if (e.view === 'draft' && c.tab && DD.setDraftTab) DD.setDraftTab(c.tab);
        } finally { setTimeout(() => { H.applying = false; paintNav(); }, 500); }
    }
    function back() { if (H.i > 0) { H.i--; paintNav(); apply(H.list[H.i]); } }
    function forward() { if (H.i < H.list.length - 1) { H.i++; paintNav(); apply(H.list[H.i]); } }
    function paintNav() {
        const b = bar.querySelector('[data-fb="back"]'), f = bar.querySelector('[data-fb="fwd"]');
        const label = e => (e ? `${({ draft: 'Draft', profile: 'Profile', aram: 'ARAM Mayhem', arena: 'Arena', builds: 'Builds', champion: 'Champion page', tierlist: 'Tier list', scout: 'Multi-search', dodgeball: 'Dodgeball' })[e.view] || e.view}${e.ctx && (e.ctx.champ || e.ctx.champion) ? ': ' + nameOf(e.ctx.champ || e.ctx.champion) : ''}` : '');
        if (b) { b.disabled = H.i <= 0; b.title = H.i > 0 ? `Back to ${label(H.list[H.i - 1])} (Alt+←)` : 'Back (Alt+←)'; }
        if (f) { f.disabled = H.i >= H.list.length - 1; f.title = H.i < H.list.length - 1 ? `Forward to ${label(H.list[H.i + 1])} (Alt+→)` : 'Forward (Alt+→)'; }
    }
    DD.onView(recordSoon);
    for (const id of ['draft-area', 'profile-root', 'aram-root', 'arena-root', 'builds-root', 'champion-root', 'tierlist-root', 'scout-root']) {
        const el = document.getElementById(id);
        if (el) { el.addEventListener('click', recordSoon); el.addEventListener('change', recordSoon); }
    }
    document.addEventListener('keydown', e => {
        if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); if (e.key === 'ArrowLeft') back(); else forward(); }
    });
    window.addEventListener('mouseup', e => { if (e.button === 3) { e.preventDefault(); back(); } else if (e.button === 4) { e.preventDefault(); forward(); } });
    DD.history = { back, forward, record, state: H };

    // ================================================================================================ champion menu
    const menu = document.createElement('div');
    menu.className = 'dg-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
    let menuFor = null;
    function champAt(target) {
        const img = target.closest('img');
        if (img && /\/img\/champion\//.test(img.src || '')) {
            const file = decodeURIComponent((img.src.split('/img/champion/')[1] || '').split('?')[0]);
            const c = champs().find(x => x.image && x.image.full === file);
            if (c) return c.id;
        }
        const el = target.closest('[data-hub],[data-champion-name],.role-slot[data-champion],.role-slot[data-hover]');
        if (!el) return null;
        const id = el.dataset.hub || el.dataset.championName || el.dataset.champion || el.dataset.hover;
        return champ(id) ? id : null;
    }
    function roleAt(target) {
        const slot = target.closest('.role-slot');
        if (slot) return { role: slot.dataset.role, side: slot.dataset.side };
        const hub = target.closest('[data-hub-role]');
        if (hub && hub.dataset.hubRole) return { role: hub.dataset.hubRole };
        if (target.closest('#recommendation-list') && DD.recTarget) { const t = DD.recTarget(); if (t) return { role: t.role, side: t.side }; }
        return {};
    }
    function opponentOf(side, role) {
        if (!side || !role) return null;
        const s = document.querySelector(`.role-slot[data-side='${side === 'left' ? 'right' : 'left'}'][data-role='${role}']`);
        return s ? s.dataset.champion || null : null;
    }
    document.addEventListener('contextmenu', e => {
        if (e.target.closest('.champion-tile, input, textarea, select, .dg-menu')) return;   // the draft grid keeps its own menu
        const id = champAt(e.target);
        if (!id) return;
        e.preventDefault(); e.stopPropagation();
        const { role, side } = roleAt(e.target);
        const opp = opponentOf(side, role);
        menuFor = { id, role: role || null, opp };
        const c = champ(id);
        const items = [
            ['hub', `Champion page`],
            ['builds', `Builds${role ? ' · ' + (LANE[role] || role) : ''}`],
            opp ? ['builds-vs', `Builds vs ${nameOf(opp)}`] : null,
            c && c.key ? ['aram', 'ARAM Mayhem build'] : null,
            c && c.key ? ['arena', 'Arena build'] : null
        ].filter(Boolean);
        menu.innerHTML = `<div class="dg-menu-h">${icon(id, 'dg-menu-ico')}${esc(nameOf(id))}${role ? ` <span>${esc(LANE[role] || role)}</span>` : ''}</div>` +
            items.map(([k, label]) => `<button type="button" class="dg-menu-i" data-menu="${k}">${esc(label)}</button>`).join('');
        menu.style.display = 'block';
        const w = menu.offsetWidth, h = menu.offsetHeight;
        menu.style.left = Math.min(e.clientX, window.innerWidth - w - 6) + 'px';
        menu.style.top = Math.min(e.clientY, window.innerHeight - h - 6) + 'px';
    }, true);
    const closeMenu = () => { menu.style.display = 'none'; menuFor = null; };
    menu.addEventListener('click', e => {
        const b = e.target.closest('[data-menu]');
        if (!b || !menuFor) return;
        const { id, role, opp } = menuFor;
        closeMenu();
        if (b.dataset.menu === 'hub') DD.openChampion(id, role);
        else if (b.dataset.menu === 'builds') DD.openBuilds(id, role);
        else if (b.dataset.menu === 'builds-vs') DD.openBuilds(id, role, opp);
        else if (b.dataset.menu === 'aram' && window.DDAram) { const c = champ(id); if (c) window.DDAram.selectByKey(Number(c.key)); }
        else if (b.dataset.menu === 'arena' && window.DDArena) { const c = champ(id); if (c) window.DDArena.selectByKey(Number(c.key)); }
    });
    document.addEventListener('mousedown', e => { if (menu.style.display !== 'none' && !menu.contains(e.target)) closeMenu(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
    window.addEventListener('blur', closeMenu);
    DD.champMenu = { close: closeMenu };

    // ================================================================================================ game flow bar
    const ACTIVE = new Set(['GameStart', 'InProgress', 'Reconnect']);
    const REVIEW = new Set(['WaitingForStats', 'PreEndOfGame', 'EndOfGame']);
    const LOBBY = new Set(['Lobby', 'Matchmaking', 'ReadyCheck']);
    const F = { phase: null, lcu: false, queueId: null, st: null, game: null, session: null, plan: null, planOpen: false, planErr: null, msg: '', msgCls: '', autoSend: false, sentKey: '', selectId: 0, sessionOpen: false, moreOpen: false, low: [], mine: new Map() };
    // ARAM and Arena have their own views (champion pool, augments): no lane, runes or Summoner's Rift draft there
    const MODE_QUEUES = { aram: new Set([100, 450, 720, 2400]), arena: new Set([1700, 1710, 1750]) };
    const modeOf = () => (MODE_QUEUES.aram.has(F.queueId) ? 'aram' : MODE_QUEUES.arena.has(F.queueId) ? 'arena' : null);
    function stepOf() {
        if (F.phase === 'ChampSelect') return 'select';
        if (ACTIVE.has(F.phase)) return 'game';
        if (REVIEW.has(F.phase)) return 'review';
        if (LOBBY.has(F.phase)) return 'lobby';
        const last = F.session && F.session.games && F.session.games[0];
        if (last && Date.now() - (last.at + last.dur * 1000) < 30 * 60e3) return 'review';     // a game ended in the last 30 min
        return null;
    }
    const STEPS = [['lobby', 'Lobby'], ['select', 'Champion select'], ['game', 'In game'], ['review', 'Review']];
    const STEP_TITLE = { lobby: 'Lobby: opens the tier list', select: 'Champion select: the draft', game: 'In game: the live game', review: 'Review: your last game in Profile' };
    const ACT = {
        suggest: () => [`Suggest for ${LANE[F.st.lane]}`, 'Show the best picks for your lane in the draft'],
        bans: () => ['Bans', 'Who to ban against your team'],
        scout: () => ['Scout lobby', 'Look up the players in your lobby (multi-search)'],
        plan: () => ['Game plan', 'Your lane matchup, the draft, your record and the best items vs your opponent'],
        build: () => [`Build${F.ctx.opp ? ' vs ' + nameOf(F.ctx.opp) : ''}`, 'Items, runes and spells for your pick'],
        send: () => ['Send to client', 'Rune page, summoner spells and item set for your pick, in one click'],
        hub: () => ['Champion page', 'Everything about your pick'],
        live: () => ['Live game', 'All 10 players scouted'],
        mini: () => [DD.mini && DD.mini.isOpen() ? 'Close mini window' : 'Mini window', 'The always-on-top window'],
        review: () => ['Review the game', 'Your last game in Profile'],
        tier: () => ['Tier list', 'Summoner\'s Rift tier list'],
        multi: () => ['Multi-search', 'Look up several players at once'],
        aram: () => ['ARAM Mayhem', 'Your options, reroll advice, augments and items'],
        arena: () => ['Arena', 'Picks with your partner, augments and items']
    };
    // small stroke icons (16 x 16) for the icon-only bar, and the lane marks
    const SVG = d => `<svg class="fb-i" viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
    const ICO = {
        suggest: SVG('<path d="M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5z"/>'),
        bans: SVG('<circle cx="8" cy="8" r="5.5"/><path d="M4.1 4.1l7.8 7.8"/>'),
        scout: SVG('<circle cx="6" cy="6" r="2.3"/><path d="M2 13c0-2.2 1.8-3.8 4-3.8s4 1.6 4 3.8"/><path d="M10.5 3.9a2.2 2.2 0 010 4.2M12.2 9.6c1.1.6 1.8 1.7 1.8 3"/>'),
        plan: SVG('<rect x="3.2" y="2.5" width="9.6" height="11.5" rx="1.5"/><path d="M6 2.5h4M5.5 7h5M5.5 10h3.5"/>'),
        build: SVG('<path d="M8 2l5 2.8v5.4L8 13 3 10.2V4.8z"/><path d="M3 4.8l5 2.8 5-2.8M8 7.6V13"/>'),
        send: SVG('<path d="M8 11V3M5 6l3-3 3 3"/><path d="M3 11v2h10v-2"/>'),
        hub: SVG('<path d="M3 3.5h4a1 1 0 011 1V13a1 1 0 00-1-1H3zM13 3.5H9a1 1 0 00-1 1V13a1 1 0 011-1h4z"/>'),
        live: SVG('<circle cx="8" cy="8" r="1.6"/><path d="M4.9 4.9a4.4 4.4 0 000 6.2M11.1 4.9a4.4 4.4 0 010 6.2"/>'),
        mini: SVG('<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><rect x="7.5" y="7.5" width="4.5" height="3.5" rx="0.6"/>'),
        review: SVG('<path d="M3.5 2.5v11M3.5 3.5h8l-1.5 2.5 1.5 2.5h-8"/>'),
        tier: SVG('<path d="M3 13V8M8 13V3M13 13V6"/>'),
        multi: SVG('<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>'),
        aram: SVG('<path d="M8 2l1.7 3.6 3.8.5-2.8 2.6.7 3.8L8 10.7l-3.4 1.8.7-3.8-2.8-2.6 3.8-.5z"/>'),
        arena: SVG('<path d="M3 13l10-10M10 3h3v3M13 13L3 3M3 6V3h3"/>'),
        more: '<svg class="fb-i dots" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg>'
    };
    // lane mark: the map's three lanes faint, yours bright (jungle = the diamond, support = a plus)
    const LANE_HI = { TOP: 'M2.5 13.5v-11h11', MIDDLE: 'M3.5 12.5l9-9', BOTTOM: 'M2.5 13.5h11v-11', JUNGLE: 'M8 3.5l4.5 4.5L8 12.5 3.5 8z', SUPPORT: 'M8 3.5v9M3.5 8h9' };
    const laneIco = lane => (LANE_HI[lane] ? `<svg class="fb-lane" viewBox="0 0 16 16" aria-hidden="true"><path class="b" d="M2.5 13.5v-11h11M2.5 13.5h11v-11M2.5 13.5l11-11"/><path class="h" d="${LANE_HI[lane]}"/></svg>` : '');
    // quiet in the bar once there is no room: they move into the "..." menu
    const LOW = new Set(['tier', 'multi', 'mini', 'hub']);
    // your champion and lane for this game: champion select while it is open, then remembered for the game and the review
    function context() {
        if (F.st && (F.st.pick || F.st.hover)) return { pick: F.st.pick || F.st.hover, locked: !!(F.st.pick && F.st.locked), lane: F.st.lane, opp: F.st.opponent };
        if (F.game && (ACTIVE.has(F.phase) || REVIEW.has(F.phase))) return F.game;
        return { pick: null, lane: F.st && F.st.lane, opp: null };
    }
    function actions(step) {
        const c = F.ctx, mode = modeOf();
        if (mode && (step === 'select' || step === 'game')) return [mode];
        if (step === 'select') {
            if (!c.pick) return [F.st && F.st.lane ? 'suggest' : null, 'bans', 'scout'].filter(Boolean);
            return [!c.locked && F.st && F.st.lane ? 'suggest' : null, 'plan', 'build', 'send', 'hub'].filter(Boolean);
        }
        if (step === 'game') return ['live', c.pick ? 'plan' : null, c.pick ? 'build' : null, 'mini'].filter(Boolean);
        if (step === 'review') return ['review', 'tier'];
        if (step === 'lobby') return ['scout', 'tier'];
        return ['tier', 'multi'];
    }
    // exactly one filled (primary) action per step; the rest are quiet text buttons
    function primaryOf(step, keys) {
        if (step === 'select' && F.ctx.pick && F.ctx.locked && keys.includes('send')) return 'send';
        return keys[0];
    }
    const kdaHtml = g => `<span class="fb-kda"><b>${g.k}</b><s>/</s><b class="d">${g.d}</b><s>/</s><b>${g.a}</b></span>`;
    const lenOf = sec => (sec >= 60 ? `${Math.round(sec / 60)} min` : '');
    // the context card: champion select = lane, your pick, "vs" the opponent; in game the same; review = the last game's result
    function ctxHtml(step) {
        const c = F.ctx;
        const matchup = (withLane) => `${withLane && c.lane ? `<span class="fb-lane-t" title="Your lane">${laneIco(c.lane)}<b>${esc(LANE[c.lane])}</b></span>` : ''}
            ${c.pick ? `${withLane && c.lane ? '<i class="fb-div s"></i>' : ''}${icon(c.pick, 'fb-ico lg')}<b class="fb-name">${esc(nameOf(c.pick))}</b>${c.locked || step === 'game' ? '' : ' <span class="fb-m fb-hov" title="Hovered, not locked in yet">hover</span>'}` : ''}
            ${c.opp ? `<span class="fb-vs">vs</span> ${icon(c.opp, 'fb-ico')}<span class="fb-name2">${esc(nameOf(c.opp))}</span>` : ''}`;
        if (step === 'select' && modeOf()) return `<div class="fb-card plain"><span class="fb-m">${modeOf() === 'aram' ? 'ARAM' : 'Arena'} champion select</span></div>`;
        if (step === 'game' && modeOf()) return `<div class="fb-card plain"><span class="fb-m">In game (${modeOf() === 'aram' ? 'ARAM' : 'Arena'})</span></div>`;
        if (step === 'select') return `<div class="fb-card">${c.lane || c.pick ? matchup(true) : '<span class="fb-m">Champion select</span>'}</div>`;
        if (step === 'game') return `<div class="fb-card"><span class="fb-m">In game</span>${c.pick ? ' ' + matchup(false) : ''}</div>`;
        if (step === 'review') {
            const g = F.session && F.session.games && F.session.games[0];
            if (!g) return '<div class="fb-card"><span class="fb-m">Game over</span></div>';
            const id = nameIdByKey(g.champId), len = lenOf(g.dur);
            return `<div class="fb-card rv"><span class="fb-m fb-lbl">Last game</span> ${icon(id, 'fb-ico lg')}<b class="fb-res ${g.win ? 'w' : 'l'}">${g.win ? 'Win' : 'Loss'}</b> ${kdaHtml(g)}<span class="fb-name">${esc(nameOf(id))}</span>${len ? ` <span class="fb-m fb-len">${len}</span>` : ''}</div>`;
        }
        if (step === 'lobby') return `<div class="fb-card plain"><span class="fb-m">${F.phase === 'Matchmaking' ? 'In queue' : F.phase === 'ReadyCheck' ? 'Match found' : 'In lobby'}</span></div>`;
        return `<div class="fb-card plain">${F.lcu ? '<span class="fb-m">Not in a game</span>' : '<span class="fb-m">League client not detected</span>'}</div>`;
    }
    // today's session as chips: 1W 1L, the LP change, and a dot per game (oldest first)
    function sessionHtml() {
        const s = F.session;
        if (!s) return '';
        if (!(s.w + s.l)) return s.lcu ? '<span class="fb-chip mute">No games today</span>' : '';
        const lp = s.lp ? Object.values(s.lp).reduce((a, b) => a + b, 0) : 0, hasLp = s.lp && Object.keys(s.lp).length;
        const dots = (s.games || []).slice(0, 10).reverse().map(g => `<i class="${g.win ? 'w' : 'l'}" title="${g.win ? 'Win' : 'Loss'} · ${esc(nameOf(nameIdByKey(g.champId)))} ${g.k}/${g.d}/${g.a}"></i>`).join('');
        return `<span class="fb-chip"><span class="fb-today">Today</span> <b class="w${s.w ? '' : ' z'}">${s.w}W</b> <b class="l${s.l ? '' : ' z'}">${s.l}L</b></span>`
            + (hasLp ? `<span class="fb-chip lp ${lp >= 0 ? 'pos' : 'neg'}">${lp >= 0 ? '+' : ''}${lp} LP</span>` : '')
            + (dots ? `<span class="fb-dots">${dots}</span>` : '');
    }
    function paint() {
        F.ctx = context();
        const step = stepOf(), idx = STEPS.findIndex(s => s[0] === step);
        const keys = actions(step), main = primaryOf(step, keys);
        const btn = k => {
            const [label, title] = ACT[k]();
            return `<button type="button" class="fb-act${k === main ? ' main' : ''}${LOW.has(k) && k !== main ? ' lo' : ''}${k === 'plan' && F.planOpen ? ' on' : ''}" data-fb-act="${k}" title="${esc(title)}" aria-label="${esc(label)}">${ICO[k] || ''}<span class="fb-al">${esc(label)}</span></button>`;
        };
        const low = keys.filter(k => LOW.has(k) && k !== main);
        const stepper = STEPS.map(([k, label], i) => `${i ? `<i class="fb-line${i <= idx ? ' done' : ''}"></i>` : ''}<button type="button" class="fb-step${i === idx ? ' now' : i < idx ? ' done' : ''}" data-fb-step="${k}" title="${esc(STEP_TITLE[k])}"><i class="fb-dot"></i><span class="fb-sl">${label}</span></button>`).join('');
        bar.innerHTML = `<div class="fb-nav"><button type="button" data-fb="back" aria-label="Back">‹</button><button type="button" data-fb="fwd" aria-label="Forward">›</button></div><i class="fb-div"></i>
            <div class="fb-steps">${stepper}</div><i class="fb-div"></i>
            <div class="fb-ctx">${ctxHtml(step)}</div>
            <div class="fb-acts">${keys.filter(k => k !== main).map(btn).join('')}${low.length ? `<button type="button" class="fb-act fb-more${F.moreOpen ? ' on' : ''}" data-fb="more" title="More: ${esc(low.map(k => ACT[k]()[0]).join(', '))}" aria-label="More">${ICO.more}</button>` : ''}${main ? btn(main) : ''}</div>
            <button type="button" class="fb-session" data-fb="session" title="Today's games (from the League client)">${sessionHtml()}</button>
            ${F.msg ? `<div class="fb-msg ${F.msgCls}">${F.msg}</div>` : ''}`;
        F.low = low;
        paintNav();
        paintPlan();
        paintSession();
        paintMore();
    }
    const nameIdByKey = key => { const c = champs().find(x => Number(x.key) === Number(key)); return c ? c.id : null; };

    // ---- game plan panel
    const planEl = document.createElement('div');
    planEl.className = 'fb-plan';
    planEl.style.display = 'none';
    bar.after(planEl);
    async function ownerAccount() {
        try { const r = await api.invoke('profile:owner'); if (r && r.ok && r.owner && r.owner.gameName && r.owner.platform) return { gameName: r.owner.gameName, tagLine: r.owner.tagLine, platform: r.owner.platform }; } catch (e) { /* not available: older lookups below */ }
        try { const r = await api.invoke('profile:me'); if (r && r.ok && r.me && r.me.platform) return { gameName: r.me.gameName, tagLine: r.me.tagLine, platform: r.me.platform }; } catch (e) { /* no client */ }
        try { const s = await window.electronAPI.getSettings(); if (s && s.profileAccount && s.profileAccount.gameName) return s.profileAccount; } catch (e) { /* none */ }
        return null;
    }
    async function loadPlan() {
        const c = F.ctx;
        if (!c.pick || !DD.gamePlan) { F.plan = null; return; }
        try { F.plan = await DD.gamePlan(c.pick, c.lane); F.planErr = null; } catch (e) { F.planErr = e.message; }
        const ch = champ(c.pick);
        if (ch && api && !F.mine.has(c.pick)) {
            F.mine.set(c.pick, null);
            const acct = await ownerAccount();
            if (acct) api.invoke('profile:champ-summary', { champId: Number(ch.key), ...acct }).then(r => { F.mine.set(c.pick, r && r.ok ? r : null); paintPlan(); }).catch(() => {});
        }
        paintPlan();
    }
    function paintPlan() {
        planEl.style.display = F.planOpen ? 'block' : 'none';
        if (!F.planOpen) return;
        const p = F.plan;
        if (!p) { planEl.innerHTML = `<div class="fb-m">${F.planErr ? esc(F.planErr) : F.ctx.pick ? 'Working out the game plan…' : 'Pick or hover a champion first.'}</div>`; return; }
        const mine = F.mine.get(p.champion);
        const oppKey = p.opponent && champ(p.opponent) ? champ(p.opponent).key : null;
        const vs = mine && oppKey && mine.vsOpp ? mine.vsOpp[oppKey] : null;
        const le = p.laneEffect;
        const cell = (label, value, sub) => `<div class="fb-cell"><span>${label}</span><b>${value}</b>${sub ? `<em>${sub}</em>` : ''}</div>`;
        let h = `<div class="fb-plan-h">${icon(p.champion, 'fb-ico lg')}<div><b>${esc(p.name)}</b> ${esc(LANE[p.lane] || p.lane)}${p.opponent ? ` vs ${icon(p.opponent)}<b>${esc(p.oppName)}</b>` : ''} <span class="fb-m">· ${esc(p.label)}</span></div>
            <button type="button" class="fb-x" data-fb="plan-close" aria-label="Close the game plan">&times;</button></div><div class="fb-cells">`;
        h += cell(`Exp WR ${help('exp-wr')}`, `<span class="${p.expWr >= 0.5 ? 'delta-pos' : 'delta-neg'}">${pct(p.expWr)}</span>`, p.expSd != null ? `± ${(p.expSd * 100).toFixed(1)} · above 50%: ${Math.round((p.p50 || 0) * 100)}%` : '');
        h += p.opponent ? cell(`Lane vs ${esc(p.oppName)} ${help('shrunk-delta')}`, le ? `<span class="${le.mean >= 0 ? 'delta-pos' : 'delta-neg'}">${pts(le.mean)}</span>` : '–', le ? `± ${(le.sd * 100).toFixed(1)} · PP ${pp(le.pp)} · ${Math.round(le.games).toLocaleString()} games` : 'not enough games')
            : cell('Lane opponent', 'not picked yet', p.blind ? `expected lane effect ${pts(p.blind.ev)}` : '');
        h += p.verdict ? cell(`Draft ${help('verdict')}`, `<span class="${Math.abs(p.verdict.wr - 0.5) < 0.02 ? '' : p.verdict.wr > 0.5 ? 'delta-pos' : 'delta-neg'}">${Math.abs(p.verdict.wr - 0.5) < 0.02 ? 'Even' : pct(p.verdict.wr)}</span>`, `your team${p.verdict.complete ? '' : ` · ${p.teams.my}v${p.teams.enemy} picked`}`) : '';
        h += cell(`You on ${esc(p.name)} ${help('you')}`, p.you && p.you.offset != null ? `<span class="${p.you.offset >= 0 ? 'delta-pos' : 'delta-neg'}">${pts(p.you.offset)}</span>` : '–',
            `${p.you ? `${p.you.games} game${p.you.games === 1 ? '' : 's'} (client history)` : 'no games yet'}${vs ? ` · vs ${esc(p.oppName)}: ${vs.w}-${vs.g - vs.w}` : ''}${mine && mine.games ? ` · Profile: ${mine.w}-${mine.games - mine.w}` : ''}`);
        h += '</div>';
        if (p.vsItems && p.vsItems.length) h += `<div class="fb-row"><span class="fb-m">Best items vs ${esc(p.oppName)}:</span> ${p.vsItems.map(i => `<span class="fb-item" title="${esc(i.name)}"><img src="${esc(i.img)}" alt="" onerror="this.style.visibility='hidden'"><em class="${i.wpa >= 0 ? 'delta-pos' : 'delta-neg'}">${pts(i.wpa)}</em></span>`).join('')}</div>`;
        else if (p.opponent) h += `<div class="fb-row fb-m">Items against ${esc(p.oppName)}: open <button type="button" class="link-btn" data-fb-act="build">Build vs ${esc(p.oppName)}</button> (downloads that matchup on demand).</div>`;
        if (!p.opponent && p.blind && p.blind.counters && p.blind.counters.length) h += `<div class="fb-row"><span class="fb-m">Counters to watch:</span> ${p.blind.counters.slice(0, 4).map(c => `${icon(c.champion)}${esc(nameOf(c.champion))} <b class="delta-neg">${pts(c.d)}</b>`).join(' · ')}</div>`;
        if (DD.skillOrder && p.lane) h += DD.skillOrder.slot(p.champion, p.lane, { compact: true });   // skill order (skills-view.js)
        if (p.warnings.length) h += `<div class="fb-row fb-warn">${p.warnings.map(esc).join(' · ')}</div>`;
        planEl.innerHTML = h;
    }

    // ---- today's session
    const sessEl = document.createElement('div');
    sessEl.className = 'fb-sess';
    sessEl.style.display = 'none';
    document.body.appendChild(sessEl);
    function paintSession() {
        sessEl.style.display = F.sessionOpen ? 'block' : 'none';
        if (!F.sessionOpen) return;
        const s = F.session;
        const QN = { 420: 'Ranked Solo', 440: 'Flex', 400: 'Draft', 430: 'Blind', 450: 'ARAM', 2400: 'ARAM Mayhem', 490: 'Quickplay', 480: 'Swiftplay' };
        const r = bar.querySelector('[data-fb="session"]').getBoundingClientRect();
        sessEl.style.top = r.bottom + 6 + 'px'; sessEl.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
        sessEl.innerHTML = !s || !s.games.length ? '<div class="fb-m">No games today (from the League client).</div>'
            : `<div class="fb-sess-h">Today: ${s.w}W ${s.l}L</div>${s.games.map(g => { const id = nameIdByKey(g.champId); return `<div class="fb-sess-g ${g.win ? 'w' : 'l'}">${icon(id)}<b>${g.win ? 'W' : 'L'}</b> ${esc(nameOf(id))} <span>${g.k}/${g.d}/${g.a}</span><em>${esc(QN[g.q] || 'Queue ' + g.q)} · ${new Date(g.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</em></div>`; }).join('')}
              ${s.l >= 2 && s.games[0] && !s.games[0].win && s.games[1] && !s.games[1].win ? '<div class="fb-warn">Two losses in a row: your Insights show how you do right after a loss. A short break may pay off.</div>' : ''}`;
    }
    // ---- the "..." menu: the quiet actions when the bar has no room for them
    const moreEl = document.createElement('div');
    moreEl.className = 'dg-menu fb-more-menu';
    moreEl.style.display = 'none';
    document.body.appendChild(moreEl);
    function paintMore() {
        const b = bar.querySelector('[data-fb="more"]');
        if (!F.moreOpen || !b || !b.offsetWidth || !F.low.length) { moreEl.style.display = 'none'; return; }
        moreEl.innerHTML = F.low.map(k => `<button type="button" class="dg-menu-i" data-fb-act="${k}">${ICO[k] || ''}<span>${esc(ACT[k]()[0])}</span></button>`).join('');
        moreEl.style.display = 'block';
        const r = b.getBoundingClientRect();
        moreEl.style.top = r.bottom + 6 + 'px';
        moreEl.style.left = Math.max(8, Math.min(window.innerWidth - moreEl.offsetWidth - 8, r.right - moreEl.offsetWidth)) + 'px';
    }
    moreEl.addEventListener('click', e => {
        const b = e.target.closest('[data-fb-act]');
        if (!b) return;
        F.moreOpen = false; paint();
        runAction(b.dataset.fbAct);
    });
    async function loadSession() {
        if (!api) return;
        const r = await api.invoke('profile:session').catch(() => null);
        if (r && r.ok) { F.session = r; F.lcu = F.lcu || r.lcu; paint(); }
    }

    // ---- actions
    async function send(replaceCurrent) {
        const c = F.ctx;
        if (!c.pick || !c.lane || !DD.sendAll) return;
        F.msg = `Sending ${esc(nameOf(c.pick))} ${esc(LANE[c.lane])} to the client…`; F.msgCls = ''; paint();
        const r = await DD.sendAll(c.pick, c.lane, { replaceCurrent }).catch(e => ({ ok: false, error: e.message }));
        if (!r.parts) { F.msg = esc(r.error || 'Could not send.'); F.msgCls = 'err'; paint(); return r; }
        const bits = Object.entries(r.parts).map(([k, v]) => (v.ok ? `✓ ${esc(v.text)}` : `✗ ${esc(k)}: ${esc(v.error || 'failed')}`));
        const full = r.parts.runes && r.parts.runes.code === 'PAGES_FULL';
        F.msg = bits.join(' · ') + (full ? ' <button type="button" class="link-btn" data-fb-act="send-replace">Replace my current rune page</button>' : '');
        F.msgCls = r.ok ? 'ok' : 'err';
        paint();
        setTimeout(() => { if (!full) { F.msg = ''; paint(); } }, 12000);
        return r;
    }
    bar.addEventListener('click', e => {
        const b = e.target.closest('[data-fb],[data-fb-step],[data-fb-act]');
        if (!b) return;
        if (b.dataset.fb === 'back') return back();
        if (b.dataset.fb === 'fwd') return forward();
        if (b.dataset.fb === 'more') { F.moreOpen = !F.moreOpen; paint(); return; }
        if (b.dataset.fb === 'session') { F.sessionOpen = !F.sessionOpen; if (F.sessionOpen) loadSession(); paintSession(); return; }
        if (b.dataset.fbStep) {
            const k = b.dataset.fbStep;
            if (k === 'lobby') DD.showView('tierlist');
            else if (k === 'select') { if (!DD.selectMyLane || !DD.selectMyLane()) DD.showView('draft'); }
            else if (k === 'game' && window.DDProfile) window.DDProfile.openFromOutside(null, 'live');
            else if (k === 'review' && window.DDProfile) window.DDProfile.openFromOutside(null, 'summary');
            return;
        }
        runAction(b.dataset.fbAct);
    });
    planEl.addEventListener('click', e => {
        const b = e.target.closest('[data-fb],[data-fb-act]');
        if (!b) return;
        if (b.dataset.fb === 'plan-close') { F.planOpen = false; paint(); return; }
        runAction(b.dataset.fbAct);
    });
    function runAction(k) {
        const c = F.ctx;
        if (k === 'suggest') DD.selectMyLane && DD.selectMyLane();
        else if (k === 'bans') { DD.showView('draft'); DD.setDraftTab && DD.setDraftTab('bans'); }
        else if (k === 'scout') { if (window.DDScout) window.DDScout.fromLobby(); else DD.showView('scout'); }
        else if (k === 'multi') DD.showView('scout');
        else if (k === 'tier') DD.showView('tierlist');
        else if (k === 'plan') { F.planOpen = !F.planOpen; paint(); if (F.planOpen) loadPlan(); }
        else if (k === 'build' && c.pick) DD.openBuilds(c.pick, c.lane, c.opp || null);
        else if (k === 'send') send(false);
        else if (k === 'send-replace') send(true);
        else if (k === 'hub' && c.pick) DD.openChampion(c.pick, c.lane);
        else if (k === 'live' && window.DDProfile) window.DDProfile.openFromOutside(null, 'live');
        else if (k === 'mini' && DD.mini) DD.mini.toggle().then(paint);
        else if (k === 'review' && window.DDProfile) window.DDProfile.openFromOutside(null, 'summary');
        else if (k === 'aram' || k === 'arena') DD.showView(k);
    }
    document.addEventListener('mousedown', e => { if (F.moreOpen && !moreEl.contains(e.target) && !e.target.closest('[data-fb="more"]')) { F.moreOpen = false; paintMore(); } });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && F.moreOpen) { F.moreOpen = false; paintMore(); } });
    window.addEventListener('resize', () => { if (F.moreOpen) paintMore(); });
    document.addEventListener('mousedown', e => { if (F.sessionOpen && !sessEl.contains(e.target) && !e.target.closest('[data-fb="session"]')) { F.sessionOpen = false; paintSession(); } });

    // ---- the client's phase, champion select polling, auto-send
    let csTimer = null;
    async function pollSelect() {
        if (F.phase !== 'ChampSelect' || modeOf()) return;   // ARAM / Arena: their own views read champion select
        if (DD.currentView() !== 'draft' && DD.liveSync) await DD.liveSync();   // Live Tracking pauses outside the draft view
        const st = DD.flowState ? DD.flowState() : null;
        const before = JSON.stringify([F.st && F.st.pick, F.st && F.st.locked, F.st && F.st.opponent, F.st && F.st.lane, F.st && F.st.hover]);
        F.st = st;
        if (st && (st.pick || st.hover)) F.game = { pick: st.pick || st.hover, locked: !!st.locked, lane: st.lane, opp: st.opponent };
        if (JSON.stringify([st && st.pick, st && st.locked, st && st.opponent, st && st.lane, st && st.hover]) !== before) { paint(); if (F.planOpen) loadPlan(); }
        // automatic send on lock-in (Settings > Automation), once per champion select and champion
        if (F.autoSend && st && st.locked && st.pick && st.lane && F.sentKey !== `${F.selectId}|${st.pick}`) {
            F.sentKey = `${F.selectId}|${st.pick}`;
            const r = await send(false);
            if (r && DD.toast) DD.toast(r.ok ? `Sent ${nameOf(st.pick)} ${LANE[st.lane]}: runes, spells and item set.` : `Could not send everything for ${nameOf(st.pick)}: see the bar.`);
        }
    }
    function onPhase(next) {
        const prev = F.phase;
        F.phase = next;
        if (next === 'ChampSelect' && prev !== 'ChampSelect') { F.selectId = Date.now(); F.st = null; F.game = null; F.plan = null; F.mine.clear(); }
        clearInterval(csTimer); csTimer = null;
        if (next === 'ChampSelect') { csTimer = setInterval(pollSelect, 1500); pollSelect(); }
        if (REVIEW.has(next) || (next === 'None' && ACTIVE.has(prev)) || next === 'Lobby') setTimeout(loadSession, 6000);
        if (!ACTIVE.has(next) && !REVIEW.has(next) && next !== 'ChampSelect' && F.planOpen && !F.game) F.planOpen = false;
        paint();
    }
    if (api) {
        api.on('profile:phase', ev => {
            if (!ev) return;
            F.lcu = true;
            if (ev.queueId != null) F.queueId = ev.queueId; else if (ev.next === 'ChampSelect' || ev.next === 'Lobby' || ev.next === 'None') F.queueId = null;
            onPhase(ev.next);
        });
        api.on('profile:update', ev => { if (ev && ev.kind === 'lp') loadSession(); });
        api.invoke('profile:me').then(r => { if (r && r.ok) { F.lcu = !!r.lcu; if (r.phase) onPhase(r.phase); else paint(); } }).catch(() => paint());
    }
    // settings: automatic send on lock-in
    const autoToggle = document.getElementById('auto-send-toggle');
    (async () => {
        try { const s = await window.electronAPI.getSettings(); F.autoSend = !!(s && s.autoSend); } catch (e) { /* default off */ }
        if (autoToggle) autoToggle.checked = F.autoSend;
    })();
    if (autoToggle) autoToggle.addEventListener('change', () => { F.autoSend = autoToggle.checked; DD.patchSettings({ autoSend: F.autoSend }).catch(() => {}); });
    window.addEventListener('mini-state', () => paint());
    DD.onView(() => { if (F.sessionOpen) { F.sessionOpen = false; paintSession(); } if (F.moreOpen) { F.moreOpen = false; paintMore(); } });
    setInterval(loadSession, 120000);
    DD.ready.then(() => { paint(); loadSession(); record(); });
    paint();
    DD.flow = { state: F, paint, onPhase, send, loadPlan, openPlan: () => { F.planOpen = true; paint(); loadPlan(); } };
})();
