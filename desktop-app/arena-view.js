// desktop-app/arena-view.js
// Renderer side of the Arena mode; renders into #arena-root only.
// Data comes from arena-main.js over window.electronAPI.feature ('arena:*'): LoLalytics' Arena tier list and one build page per
// champion, opened on demand (nothing is prefetched in bulk). Champion select is polled only while the view is visible.
// Riot policy: no overlay, no timers; it reads champion select and shows plain numbers in this window.
(function () {
    'use strict';
    const root = document.getElementById('arena-root');
    if (!root || !window.DD || !window.electronAPI || !window.electronAPI.feature) return;
    const api = window.electronAPI.feature;
    const DD = window.DD;

    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmt1 = n => (n == null ? '-' : (Math.round(n * 10) / 10).toFixed(1));
    const fmt2 = n => (n == null ? '-' : (Math.round(n * 100) / 100).toFixed(2));
    const fmtInt = n => (n == null ? '-' : Number(n).toLocaleString('en-US'));
    const signed = n => (n == null ? '' : (n >= 0 ? '+' : '') + fmt1(n));
    const deltaCls = n => (n == null ? '' : n > 0.05 ? 'pos' : n < -0.05 ? 'neg' : 'flat');
    const ord = n => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
    const tierCls = t => 't-' + String(t || '').replace('+', 'p').replace('-', 'm').toLowerCase();

    // A win rate with few games says little: pull it toward the average of its list by n / (n + SHRINK_K). Noise of a rate over n games
    // is about 50 / sqrt(n) points and real differences between augments, items or pairs are a few points, so a few hundred games
    // are needed before a row counts fully. Used to sort, never to hide a number.
    const SHRINK_K = 300;
    const shrink = (v, mean, n) => mean + (v - mean) * (n / (n + SHRINK_K));
    const LOW_GAMES = 30;          // rows under this (or under 1% of the champion's games) are dimmed
    const SHOW = 14;               // rows shown per list until "Show all"
    const CDN_ITEM = 'https://cdn5.lolalytics.com/item64/';
    const TIER_KEY = 'dg-arena-tier';

    const S = {
        ready: false, active: false, bracket: 'all', tier: null, tierErr: null, byCid: new Map(), bySlug: new Map(), ddByKey: new Map(),
        augMeta: null, cs: null, csSig: '', polling: false, timer: null, autoMine: 0, left: 'auto', search: '', sort: { key: 'rank', dir: 1 },
        selected: null, build: {}, rarity: 'all', pickRound: 0, itemTab: 'start', showAll: {}, lastErr: ''
    };
    try { const b = localStorage.getItem(TIER_KEY); if (b === 'all' || b === 'emerald_plus') S.bracket = b; } catch (e) { /* default */ }

    // ---- champions (Riot champion id = Data Dragon "key") ------------------------------------------------------------------
    function buildMaps() {
        S.ddByKey.clear();
        for (const c of DD.getChampions() || []) S.ddByKey.set(Number(c.key), c);
        S.byCid.clear(); S.bySlug.clear();
        if (!S.tier) return;
        for (const e of S.tier.champions) { S.byCid.set(e.cid, e); S.bySlug.set(e.slug, e); }
    }
    const entry = cid => S.byCid.get(Number(cid)) || null;
    const champName = cid => { const dd = S.ddByKey.get(Number(cid)), e = entry(cid); return (dd && dd.name) || (e && e.name) || ('#' + cid); };
    function champIcon(cid) {
        const dd = S.ddByKey.get(Number(cid)), v = DD.getLatestPatch && DD.getLatestPatch();
        return dd && v ? `${DD.ddragonBase}/cdn/${v}/img/champion/${dd.image.full}` : '';
    }
    const icon = (cid, cls) => `<img class="arena-champ${cls ? ' ' + cls : ''}" src="${esc(champIcon(cid))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
    const chip = (id, info) => (DD.provChip ? DD.provChip(id, info) : '');
    const bracketLabel = b => (b === 'emerald_plus' ? 'Emerald+' : 'All ranks');

    // ---- data loading --------------------------------------------------------------------------------------------------------
    async function loadTier(force) {
        const r = await api.invoke('arena:tier-list', { tier: S.bracket, force: !!force }).catch(e => ({ ok: false, error: e.message }));
        if (r && r.ok) { S.tier = Object.assign({}, r.data, { fetchedAt: r.fetchedAt, stale: r.stale }); S.tierErr = r.error || null; buildMaps(); }
        else if (!S.tier) S.tierErr = (r && r.error) || 'Could not load the Arena tier list';
        else S.tierErr = (r && r.error) || null;
    }
    async function loadAugMeta() {
        if (S.augMeta) return;
        const r = await api.invoke('arena:augments', {}).catch(() => null);
        if (r && r.ok && r.data) { S.augMeta = r.data; renderBuild(); }   // icons only: the view works without them
    }
    const bkey = (cid, b = S.bracket) => cid + '|' + b;
    async function loadBuild(cid, force, quiet) {
        const e = entry(cid); if (!e) return;
        const k = bkey(cid);
        S.build[k] = Object.assign(S.build[k] || {}, { loading: true });
        if (!quiet) renderBuild();
        const r = await api.invoke('arena:champion', { slug: e.slug, tier: S.bracket, force: !!force }).catch(err => ({ ok: false, error: err.message }));
        S.build[k] = { loading: false, r };
        if (S.selected === cid) renderBuild();
        renderLeft();   // champion select panel uses partner tables
    }
    function select(cid) {
        S.selected = Number(cid);
        renderLeft(); renderBuild();
        const b = S.build[bkey(S.selected)];
        if (entry(S.selected) && (!b || (!b.loading && !(b.r && b.r.ok)))) loadBuild(S.selected);
        loadAugMeta();
    }
    const buildData = (cid) => { const b = S.build[bkey(cid)]; return b && b.r && b.r.ok ? b.r.data : null; };

    // ---- champion select -------------------------------------------------------------------------------------------------------
    async function poll() {
        if (S.polling || !S.active) return;
        S.polling = true;
        try { const r = await api.invoke('arena:champ-select', {}); S.cs = r && r.ok ? r.data : null; }
        catch (e) { S.cs = null; }
        finally { S.polling = false; }
        const d = S.cs;
        const sig = d ? JSON.stringify([d.connected, d.inChampSelect, d.inGame, d.phase, d.isArena, d.mine, d.mineLocked, d.mates, d.taken, d.banned, d.pickable ? d.pickable.length : -1]) : '';
        // Follow your own champion: whenever it changes its build opens. Clicking another row overrides that until it changes again.
        const mine = d && d.isArena && (d.inChampSelect || d.inGame) ? d.mine : 0;
        if (mine && mine !== S.autoMine && S.tier) { S.autoMine = mine; select(mine); }
        else if (!mine) S.autoMine = 0;
        if (sig !== S.csSig) {
            S.csSig = sig;
            renderTop(); renderLeft();
        }
        ensureMateBuilds();
    }
    // The partner's page holds the pair numbers (one page, only once they have picked and the tier list is there).
    function ensureMateBuilds() {
        const d = S.cs;
        if (!S.tier || !d || !d.isArena || !d.inChampSelect) return;
        for (const m of d.mates || []) if (m.championId && entry(m.championId) && !S.build[bkey(m.championId)]) loadBuild(m.championId, false, true);
    }
    function startPolling() { if (S.timer) return; poll(); S.timer = setInterval(poll, 1200); }
    function stopPolling() { if (S.timer) clearInterval(S.timer); S.timer = null; }

    const inArenaCs = () => !!(S.cs && S.cs.inChampSelect && S.cs.isArena);

    // Champions you could still pick, best first. With a teammate who has picked: the estimated top-half rate of the pair
    // (their rate + the candidate's rate) / 2 plus the pair's synergy delta, shrunk by its games. Without: the champion's own rate.
    function mateInfo() {
        const d = S.cs; if (!d) return null;
        for (const m of d.mates || []) {
            const e = m.championId && entry(m.championId); if (!e) continue;
            const data = buildData(m.championId);
            return { cid: m.championId, entry: e, data };
        }
        return null;
    }
    function suggestions() {
        const d = S.cs; if (!inArenaCs() || !S.tier) return [];
        const taken = new Set(d.taken || []), banned = new Set(d.banned || []);
        const pool = d.pickable && d.pickable.length ? d.pickable : S.tier.champions.map(e => e.cid);
        const mate = mateInfo();
        const out = [];
        for (const cid of pool) {
            if (taken.has(cid) || banned.has(cid) || cid === d.mine) continue;
            const e = entry(cid); if (!e) continue;
            let syn = null;
            if (mate && mate.data) { const p = (mate.data.partners || []).find(x => x.id === cid); if (p) syn = p; }
            const est = mate ? (e.wr + mate.entry.wr) / 2 + (syn ? shrink(syn.delta, 0, syn.games) : 0) : e.wr;
            out.push({ e, syn, est });
        }
        out.sort((a, b) => b.est - a.est);
        return out;
    }

    // ---- rendering: top bar ------------------------------------------------------------------------------------------------------
    function skeleton() {
        root.innerHTML = `<div class="arena-wrap">
            <div class="arena-top" id="arena-top"></div>
            <div class="arena-cols">
                <section class="arena-left" id="arena-left"></section>
                <section class="arena-right" id="arena-right"></section>
            </div></div>`;
        root.querySelector('#arena-left').addEventListener('click', onLeftClick);
        root.querySelector('#arena-left').addEventListener('input', onLeftInput);
        root.querySelector('#arena-right').addEventListener('click', onRightClick);
        root.querySelector('#arena-top').addEventListener('click', onTopClick);
        root.querySelector('#arena-top').addEventListener('change', onTopChange);
    }
    function renderTop() {
        const el = root.querySelector('#arena-top'); if (!el) return;
        const d = S.cs, t = S.tier;
        let status;
        if (!d || !d.connected) status = '<span class="arena-dot off"></span>League client not detected: showing the tier list.';
        else if (d.inGame) status = `<span class="arena-dot ${d.isArena ? 'on' : 'off'}"></span>In game${d.queueName ? ` (${esc(d.queueName)})` : ''}${d.isArena ? ": showing your champion's build." : '.'}`;
        else if (!d.inChampSelect) status = `<span class="arena-dot off"></span>Not in champion select (${esc(d.phase || 'idle')}).`;
        else if (!d.isArena) status = `<span class="arena-dot warn"></span>In champion select, but the queue is <b>${esc(d.queueName || 'not Arena')}</b>: Arena picks are shown for reference only.`;
        else status = `<span class="arena-dot on"></span>Arena champion select${d.mine ? '' : ': pick a champion'}.`;
        const meta = t ? `${chip('arena-tier', { title: 'Arena tier list', source: 'LoLalytics', url: t.url || 'https://lolalytics.com/lol/tierlist/arena/', rank: bracketLabel(t.bracket), period: `Patch ${t.patch || '?'}`,
                games: t.analysed || null, fetchedAt: t.fetchedAt, stale: !!t.stale, rows: [['Champions', String(t.champions.length)], ['Average top-half rate', fmt1(t.avgWr) + '%']],
                note: 'Fetched when this view opens; cached on this PC for about 6 hours and refreshed in the background.', onRefresh: async () => { await reload(); return { message: 'Tier list fetched again.' }; } })}
                ${DD.help ? DD.help('arena') : ''}${t.stale ? ' &middot; <span class="arena-stale">refreshing</span>' : ''}` : '';
        el.innerHTML = `<div class="arena-status">${status}</div><div class="arena-meta">${meta}
            <label class="arena-rank" title="Which players' games the numbers come from">Ranks <select data-act="bracket"><option value="all"${S.bracket === 'all' ? ' selected' : ''}>All ranks</option><option value="emerald_plus"${S.bracket === 'emerald_plus' ? ' selected' : ''}>Emerald+</option></select></label>
            <a href="https://lolalytics.com/lol/tierlist/arena/" target="_blank" rel="noopener" class="arena-link">lolalytics.com</a>
            <button class="arena-btn" data-act="reload" title="Fetch the tier list and the selected champion again">Refresh</button></div>`;
    }

    // ---- rendering: left panel ---------------------------------------------------------------------------------------------------
    const COLS = [['rank', 'Tier'], ['wr', 'Top-half'], ['pick', 'Pick'], ['ban', 'Ban'], ['games', 'Games']];
    function tags(cid) {
        const d = S.cs; if (!d || !(d.inChampSelect || d.inGame)) return '';
        let t = '';
        if (d.mine === cid) t += '<span class="arena-src you">you</span>';
        if ((d.mates || []).some(m => m.championId === cid)) t += '<span class="arena-src mate">partner</span>';
        return t;
    }
    function rowHtml(e, sel) {
        const low = e.games < 1000;
        return `<div class="arena-row${sel ? ' sel' : ''}${low ? ' low' : ''}" data-cid="${e.cid}">
            ${icon(e.cid)}
            <div class="arena-name">${esc(champName(e.cid))}<div class="arena-sub">${tags(e.cid)}<span class="arena-rk">#${e.rank}</span></div></div>
            <span class="arena-tier ${tierCls(e.tier)}">${esc(e.tier || '')}</span>
            <span class="arena-wr">${fmt1(e.wr)}%</span><span class="arena-num">${fmt1(e.pick)}%</span><span class="arena-num">${fmt1(e.ban)}%</span><span class="arena-num">${fmtInt(e.games)}</span>
        </div>`;
    }
    function tierListHtml() {
        const q = S.search.trim().toLowerCase();
        const key = S.sort.key, dir = S.sort.dir;
        const list = S.tier.champions.filter(e => !q || champName(e.cid).toLowerCase().includes(q) || e.slug.includes(q))
            .sort((a, b) => dir * (key === 'rank' ? a.rank - b.rank : (a[key] || 0) - (b[key] || 0)) || a.rank - b.rank);
        const head = COLS.map(([k, label]) => `<button class="arena-h${S.sort.key === k ? ' on' : ''}" data-sort="${k}" title="Sort by ${label.toLowerCase()}">${label}${S.sort.key === k ? (S.sort.dir > 0 ? ' &#9650;' : ' &#9660;') : ''}</button>`).join('');
        return `<input id="arena-search" class="arena-search" type="search" placeholder="Search champion" value="${esc(S.search)}">
            <div class="arena-listhead"><span>Champion</span>${head}</div>
            <div class="arena-list">${list.map(e => rowHtml(e, e.cid === S.selected)).join('') || '<div class="arena-empty small">No champion matches.</div>'}</div>`;
    }
    function personCard(label, cid, locked) {
        if (!cid) return `<div class="arena-person none"><span class="arena-plabel">${label}</span><span class="arena-pname">no pick yet</span></div>`;
        const e = entry(cid);
        return `<div class="arena-person${cid === S.selected ? ' sel' : ''}" data-cid="${cid}">${icon(cid)}
            <div><span class="arena-plabel">${label}${locked === false ? ' (hovering)' : ''}</span><span class="arena-pname">${esc(champName(cid))}</span></div>
            ${e ? `<span class="arena-tier ${tierCls(e.tier)}">${esc(e.tier || '')}</span><span class="arena-wr">${fmt1(e.wr)}%</span>` : '<span class="arena-sub">no stats</span>'}</div>`;
    }
    function pairLine() {
        const d = S.cs, mate = mateInfo();
        if (!d || !d.mine || !mate) return '';
        const mine = buildData(d.mine);
        const p = mine && (mine.partners || []).find(x => x.id === mate.cid) || (mate.data && (mate.data.partners || []).find(x => x.id === d.mine));
        if (!p) return `<div class="arena-pair">No recorded games of ${esc(champName(d.mine))} with ${esc(champName(mate.cid))} yet (or the page is still loading).</div>`;
        const few = p.games < 100;
        return `<div class="arena-pair">Together: <b>${fmt1(p.wr)}%</b> top-half over ${fmtInt(p.games)} games &middot; ${signed(p.delta)} against what the two do apart${few ? ' <span class="arena-stale">(few games: take it lightly)</span>' : ''}</div>`;
    }
    function champSelectHtml() {
        const d = S.cs;
        const mates = (d.mates || []);
        const sg = suggestions();
        const mate = mateInfo();
        const top = sg.slice(0, 12);
        const note = !d.teamKnown ? '<div class="arena-note">The client did not say who your teammate is, so the suggestions use the champions\' own numbers.</div>' : '';
        return `<div class="arena-team">
                ${personCard('You', d.mine, d.mineLocked)}
                ${mates.map(m => personCard('Partner', m.championId, true)).join('')}
            </div>${pairLine()}${note}
            <div class="arena-listhead cs"><span>${top.length ? 'Still available, best first' : 'Suggestions'}</span><span class="h-tier">Tier</span><span class="h-wr">Top-half</span><span class="h-est">${mate ? `With ${esc(champName(mate.cid))}` : ''}</span></div>
            <div class="arena-list">${top.length ? top.map(s => {
                const e = s.e;
                return `<div class="arena-row cs${e.cid === S.selected ? ' sel' : ''}" data-cid="${e.cid}">${icon(e.cid)}
                    <div class="arena-name">${esc(champName(e.cid))}<div class="arena-sub"><span class="arena-rk">#${e.rank}</span>${s.syn ? `<span>${fmtInt(s.syn.games)} games together</span>` : ''}</div></div>
                    <span class="arena-tier ${tierCls(e.tier)}">${esc(e.tier || '')}</span><span class="arena-wr">${fmt1(e.wr)}%</span>
                    <span class="arena-est" title="${mate ? 'Estimated top-half rate of the pair' : ''}">${mate ? '~' + fmt1(s.est) + '%' : ''}</span></div>`;
            }).join('') : '<div class="arena-empty small">Nothing left to suggest (or the tier list is still loading).</div>'}</div>
            ${mate ? `<div class="arena-note">The estimate is the two champions' average top-half rate plus how the pair did together, counted fully only after a few hundred games.</div>` : ''}`;
    }
    function renderLeft() {
        const el = root.querySelector('#arena-left'); if (!el) return;
        const keepFocus = document.activeElement && document.activeElement.id === 'arena-search';
        const pos = keepFocus ? document.activeElement.selectionStart : 0;
        const csOn = inArenaCs();
        const mode = S.left === 'auto' ? (csOn ? 'cs' : 'tier') : S.left === 'cs' && !csOn ? 'tier' : S.left;
        let body;
        if (!S.tier) {
            body = `<div class="arena-empty">${S.tierErr ? `No Arena data: ${esc(S.tierErr)}<br>The numbers come from lolalytics.com; nothing else is used.<br><button class="arena-btn" data-act="reload">Retry</button>` : 'Loading the Arena tier list...'}</div>`;
            if (csOn) body = champSelectBasic() + body;
        } else body = mode === 'cs' ? champSelectHtml() : tierListHtml();
        el.innerHTML = `<div class="arena-tabs">
                <button class="arena-tab${mode === 'cs' ? ' on' : ''}${csOn ? '' : ' off'}" data-aview="cs" title="${csOn ? '' : 'Available in an Arena champion select'}">Champion select</button>
                <button class="arena-tab${mode === 'tier' ? ' on' : ''}" data-aview="tier">Tier list</button></div>${body}`;
        if (keepFocus) { const i = el.querySelector('#arena-search'); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch (e) { /* type=search */ } } }
    }
    // no tier data: still show who is picked (names and portraits come from Data Dragon)
    function champSelectBasic() {
        const d = S.cs;
        return `<div class="arena-team">${personCard('You', d.mine, d.mineLocked)}${(d.mates || []).map(m => personCard('Partner', m.championId, true)).join('')}</div>`;
    }

    // ---- rendering: build panel ----------------------------------------------------------------------------------------------------
    function ageText(ts) { if (!ts) return ''; const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'just now' : m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; }
    function placementsHtml(c) {
        const p = c.places || [];
        if (!p.length) return '';
        return `<div class="arena-places" title="How often the champion finished 1st, 2nd, ...">${p.map((v, i) => `<div class="arena-place${i < c.winPlaces ? ' win' : ''}" style="flex:${Math.max(v, 3)}"><b>${fmt1(v)}%</b><i>${ord(i + 1)}</i></div>`).join('')}</div>`;
    }
    // One ranked list (augments or items). rows: { id, name, icon?, wr, pick, games, round?, rarity? }
    function listHtml(listKey, rows, champGames, opts = {}) {
        if (!rows.length) return '<div class="arena-empty small">Nothing recorded for this list.</div>';
        // Later picks look better because only players who are doing well reach them, so each row is compared with the games-weighted
        // average of its own group (its rarity for augments, the whole list for items) and sorted by that difference.
        const sum = {};
        for (const r of rows) { const g = r.rarity || ''; const a = sum[g] || (sum[g] = { w: 0, n: 0 }); a.w += r.wr * r.games; a.n += r.games; }
        const meanOf = r => { const a = sum[r.rarity || '']; return a && a.n ? a.w / a.n : 50; };
        const lowN = Math.max(LOW_GAMES, champGames * 0.01);
        const ranked = rows.map(r => { const m = meanOf(r); return { ...r, mean: m, score: shrink(r.wr, m, r.games) - m, low: r.games < lowN }; }).sort((a, b) => b.score - a.score);
        const shown = S.showAll[listKey] ? ranked : ranked.slice(0, SHOW);
        const head = `<div class="arena-listhead aug"><span>${opts.label || 'Name'}</span><span class="h-app">${opts.pickLabel || 'Taken'}</span><span class="h-g">Games</span><span class="h-wr">Top-half</span><span class="h-d">vs avg</span></div>`;
        const body = shown.map(r => {
            const d = r.wr - r.mean;
            return `<div class="arena-arow${r.low ? ' low' : ''}" title="${esc(r.name || '')}">${r.icon ? `<img class="arena-aug" src="${esc(r.icon)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '<span class="arena-aug"></span>'}
                <span class="arena-aname">${r.rarity ? `<i class="arena-rar r-${r.rarity}" title="${r.rarity}"></i>` : ''}${esc(r.name || ('#' + r.id))}${r.round ? `<small>round ~${r.round}</small>` : ''}</span>
                <span class="arena-app">${fmt1(r.pick)}%</span><span class="arena-gm">${fmtInt(r.games)}</span><span class="arena-wr">${fmt1(r.wr)}%</span><span class="arena-delta ${deltaCls(d)}">${signed(d)}</span></div>`;
        }).join('');
        const more = ranked.length > SHOW ? `<button class="arena-btn more" data-more="${listKey}">${S.showAll[listKey] ? 'Show fewer' : `Show all ${ranked.length}`}</button>` : '';
        return head + body + more;
    }
    const augIcon = id => { const m = S.augMeta && S.augMeta[id]; return m ? m.icon : null; };
    function augmentsHtml(c) {
        const g = c.header.games;
        const src = S.pickRound ? (c.augments.rounds[S.pickRound] || []) : (c.augments.all || []);
        const rows = src.filter(a => S.rarity === 'all' || a.rarity === S.rarity).map(a => ({ id: a.id, name: a.name, icon: augIcon(a.id), wr: a.wr, pick: a.pick, games: a.games, rarity: a.rarity }));
        const tabs = ['all', 'prismatic', 'gold', 'silver'].map(r => `<button class="arena-tab r-${r}${S.rarity === r ? ' on' : ''}" data-rarity="${r}">${r[0].toUpperCase() + r.slice(1)}</button>`).join('');
        const rounds = [0, 1, 2, 3, 4].map(n => `<option value="${n}"${S.pickRound === n ? ' selected' : ''}>${n ? ord(n) + ' pick' : 'Any pick'}</option>`).join('');
        return `<h3>Augments ${DD.help ? DD.help('arena') : ''} <span class="arena-hint">sorted by top-half rate, small samples pulled toward the list average; dimmed = few games</span></h3>
            <div class="arena-tabs sm">${tabs}<select class="arena-sel" data-act="round" title="Which augment pick of the game">${rounds}</select></div>
            ${listHtml('aug' + S.rarity + S.pickRound, rows, g, { label: 'Augment', pickLabel: 'Taken' })}`;
    }
    const ITEM_TABS = [['start', 'Start'], ['prismatic', 'Prismatic'], ['1', 'Item 1'], ['2', 'Item 2'], ['3', 'Item 3'], ['4', 'Item 4'], ['5', 'Item 5'], ['6', 'Item 6']];
    function itemsHtml(c) {
        const t = S.itemTab;
        const src = t === 'start' ? c.items.start : t === 'prismatic' ? c.items.prismatic : (c.items.slots[t] || []);
        const rows = src.map(i => ({ id: i.id, name: i.name, icon: CDN_ITEM + i.id + '.webp', wr: i.wr, pick: i.pick, games: i.games, round: t === 'start' || t === 'prismatic' ? null : i.round }));
        const tabs = ITEM_TABS.map(([k, label]) => `<button class="arena-tab${t === k ? ' on' : ''}" data-itab="${k}">${label}</button>`).join('');
        return `<h3>Items <span class="arena-hint">by the order they are bought; compare rows inside one list. Later items look better because players who survive longer reach them.</span></h3>
            <div class="arena-tabs sm wrap">${tabs}</div>
            ${listHtml('item' + t, rows, c.header.games, { label: 'Item', pickLabel: 'Bought' })}`;
    }
    function partnersHtml(c) {
        const rows = (c.partners || []).filter(p => entry(p.id) || S.ddByKey.has(p.id)).map(p => ({ ...p, adj: shrink(p.delta, 0, p.games) })).filter(p => p.games >= 20).sort((a, b) => b.adj - a.adj).slice(0, 8);
        if (!rows.length) return '';
        return `<h3>Best partners <span class="arena-hint">how the pair does compared with the two champions alone, small samples pulled toward zero</span></h3>
            <div class="arena-listhead aug"><span>Partner</span><span class="h-app">Picked</span><span class="h-g">Games</span><span class="h-wr">Together</span><span class="h-d">vs apart</span></div>
            ${rows.map(p => `<div class="arena-arow part" data-cid="${p.id}">${icon(p.id, 'sm')}<span class="arena-aname">${esc(champName(p.id))}</span>
                <span class="arena-app">${fmt1(p.pick)}%</span><span class="arena-gm">${fmtInt(p.games)}</span><span class="arena-wr">${fmt1(p.wr)}%</span><span class="arena-delta ${deltaCls(p.delta)}">${signed(p.delta)}</span></div>`).join('')}`;
    }
    function renderBuild() {
        const el = root.querySelector('#arena-right'); if (!el) return;
        const cid = S.selected;
        if (!cid) { el.innerHTML = '<div class="arena-empty big">Select a champion on the left to see its placements, augments and items.</div>'; return; }
        const e = entry(cid), b = S.build[bkey(cid)];
        const head = `<div class="arena-bhead">${icon(cid, 'lg')}<div><h2>${esc(champName(cid))}</h2>
            <div class="arena-sub">${e ? `<span class="arena-tier ${tierCls(e.tier)}">${esc(e.tier || '')}</span> Top-half rate <b>${fmt1(e.wr)}%</b> &middot; rank #${e.rank} of ${S.tier.champions.length} &middot; ${bracketLabel(S.bracket)}` : 'No Arena statistics for this champion.'}</div></div></div>`;
        if (!e) { el.innerHTML = head; return; }
        if (!b || b.loading) { el.innerHTML = head + '<div class="arena-empty">Loading build...</div>'; return; }
        const r = b.r, c = r && r.ok ? r.data : null;
        if (!c) { el.innerHTML = head + `<div class="arena-empty">Could not load the Arena build: ${esc((r && r.error) || 'unknown error')} <button class="arena-btn" data-act="retry">Retry</button></div>`; return; }
        const h = c.header;
        let html = head;
        html += `<div class="dg-prov-row">${chip('arena-build', { title: 'Arena build', source: 'LoLalytics', url: c.url || `https://lolalytics.com/lol/${c.slug}/arena/build/`, rank: bracketLabel(S.bracket), period: `Patch ${c.patch || '?'}`,
            games: h.games, fetchedAt: r.fetchedAt, stale: !!r.stale, rows: [['Champion', c.name], ['Pick rate', fmt1(h.pick) + '%'], ['Ban rate', fmt1(h.ban) + '%']],
            note: 'Fetched when the champion is opened; cached on this PC for about 6 hours.', onRefresh: async () => { await loadBuild(cid, true); return { message: 'Fetched again.' }; } })}</div>`;
        html += placementsHtml(c);
        html += `<div class="arena-statline">Top-half rate <b>${fmt1(h.wr)}%</b> (finishing ${c.winPlaces === 1 ? '1st' : '1st to ' + ord(c.winPlaces)} of ${c.places.length}; average of all champions ${fmt1(c.avgWr)}%) &middot; average finish ${c.avgPlace == null ? '-' : fmt2(c.avgPlace)} &middot; picked in ${fmt1(h.pick)}% of games, banned in ${fmt1(h.ban)}% &middot; ${fmtInt(h.games)} games &middot; patch ${esc(c.patch || '?')}</div>`;
        html += augmentsHtml(c) + itemsHtml(c) + partnersHtml(c);
        html += `<div class="arena-foot">Source: <a class="arena-link" target="_blank" rel="noopener" href="${esc(c.url || '')}">lolalytics.com Arena build</a>${S.augMeta ? ' &middot; augment icons from CommunityDragon' : ''} &middot; fetched ${ageText(r.fetchedAt)}${r.stale ? ' (refreshing in background)' : ''}</div>`;
        el.innerHTML = html;
    }

    // ---- events ----------------------------------------------------------------------------------------------------------------------
    function onTopClick(ev) { if (ev.target.closest('[data-act="reload"]')) reload(); }
    function onTopChange(ev) {
        const sel = ev.target.closest('[data-act="bracket"]');
        if (!sel) return;
        S.bracket = sel.value === 'emerald_plus' ? 'emerald_plus' : 'all';
        try { localStorage.setItem(TIER_KEY, S.bracket); } catch (e) { /* private mode */ }
        S.tier = null; S.tierErr = null; renderTop(); renderLeft(); renderBuild();
        loadTier(false).then(() => { renderTop(); renderLeft(); if (S.selected) select(S.selected); });
    }
    async function reload() {
        await loadTier(true); renderTop(); renderLeft();
        if (S.selected) loadBuild(S.selected, true);
    }
    function onLeftClick(ev) {
        if (ev.target.closest('[data-act="reload"]')) { reload(); return; }
        const tab = ev.target.closest('[data-aview]');
        if (tab) { if (tab.dataset.aview === 'cs' && !inArenaCs()) return; S.left = tab.dataset.aview; renderLeft(); return; }
        const h = ev.target.closest('[data-sort]');
        if (h) { const k = h.dataset.sort; S.sort = S.sort.key === k ? { key: k, dir: -S.sort.dir } : { key: k, dir: k === 'rank' ? 1 : -1 }; renderLeft(); return; }
        const row = ev.target.closest('[data-cid]');
        if (row) select(Number(row.dataset.cid));
    }
    function onLeftInput(ev) { if (ev.target.id === 'arena-search') { S.search = ev.target.value; renderLeft(); } }
    function onRightClick(ev) {
        const r = ev.target.closest('[data-rarity]');
        if (r) { S.rarity = r.dataset.rarity; renderBuild(); return; }
        const it = ev.target.closest('[data-itab]');
        if (it) { S.itemTab = it.dataset.itab; renderBuild(); return; }
        const more = ev.target.closest('[data-more]');
        if (more) { S.showAll[more.dataset.more] = !S.showAll[more.dataset.more]; renderBuild(); return; }
        const part = ev.target.closest('.arena-arow.part');
        if (part) { select(Number(part.dataset.cid)); return; }
        if (ev.target.closest('[data-act="retry"]')) loadBuild(S.selected, true);
    }
    root.addEventListener('change', ev => {
        const s = ev.target.closest('[data-act="round"]');
        if (s) { S.pickRound = Number(s.value) || 0; renderBuild(); }
    });

    // ---- lifecycle ---------------------------------------------------------------------------------------------------------------------
    api.on('arena:updated', ev => {   // a background refresh finished: swap in the new data
        if (!ev) return;
        if (ev.kind === 'tier-list') loadTier(false).then(() => { renderTop(); renderLeft(); });
        else if (ev.kind === 'champion' && S.selected) { const e = entry(S.selected); if (e && String(ev.key || '').includes(e.slug)) loadBuild(S.selected, false); }
    });

    async function activate() {
        if (S.active) return;
        S.active = true;
        if (!root.firstChild) skeleton();
        renderTop(); renderLeft(); renderBuild();
        await DD.ready;
        if (!S.active) return;
        buildMaps(); renderLeft();
        if (!S.tier) { await loadTier(false); renderTop(); renderLeft(); }
        renderBuild();
        startPolling();
    }
    function deactivate() { S.active = false; stopPolling(); }

    DD.onView(name => { if (name === 'arena') activate(); else deactivate(); });
    if (DD.currentView() === 'arena') activate();
    DD.ready.then(() => { if (DD.currentView() === 'arena') activate(); });

    window.__arenaDebug = { state: S, suggestions, shrink, entry };      // for the test harness
    window.DDArena = {
        selectedKey: () => S.selected,
        // From other views: open the Arena view on a champion (Data Dragon numeric key); waits for the tier list
        async selectByKey(key) {
            DD.showView('arena');
            for (let i = 0; i < 50 && !S.tier; i++) await new Promise(r => setTimeout(r, 100));
            if (!entry(Number(key))) return false;
            select(Number(key));
            return true;
        }
    };
})();
