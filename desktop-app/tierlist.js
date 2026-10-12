// desktop-app/tierlist.js
// Summoner's Rift tier list (view 'tierlist', #tierlist-root; op.gg / u.gg / lolalytics style) and patch movers (op.gg "Buffs &
// Nerfs"), from the draft dataset the Time Period and Rank selectors choose (DD.tierData). A tier is the champion's shrunk win
// rate against its role's average (games-weighted), so rare picks with a lucky record don't top the list:
//   S+ >= +2.5 pts, S >= +1.5, A >= +0.5, B >= -0.5, C >= -1.5, D below.
// Niche picks (played there in under 10% of the champion's games, or picked in under 0.5% of games) are hidden unless asked for.
// Patch movers: the biggest changes since the previous saved patch that are beyond noise (the same rule as ▲/▼ in the draft).
// Pool planner (pool-planner.js): your best 2-3 champions for the chosen role, the gaps and what to learn next.
// Loading / empty / error states come from DD.ui (ui-states.js).
(function () {
    'use strict';
    const DD = window.DD, root = document.getElementById('tierlist-root');
    if (!DD || !root) return;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ROLES = [['ALL', 'All roles'], ['TOP', 'Top'], ['JUNGLE', 'Jungle'], ['MIDDLE', 'Mid'], ['BOTTOM', 'Bot'], ['SUPPORT', 'Support']];
    const LANE = Object.fromEntries(ROLES);
    const TIERS = [['S+', 0.025], ['S', 0.015], ['A', 0.005], ['B', -0.005], ['C', -0.015], ['D', -Infinity]];
    const tierOf = d => TIERS.find(([, t]) => d >= t)[0];
    const S = { role: 'ALL', q: '', niche: false, sort: 'tier', data: null, loading: false, seq: 0, tab: 'list' };
    const champ = id => (DD.getChampions() || []).find(c => c.id === id) || null;
    const img = id => { const c = champ(id), v = DD.getLatestPatch && DD.getLatestPatch(); return c && v ? `${DD.ddragonBase}/cdn/${v}/img/champion/${c.image.full}` : ''; };
    const pts = v => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}`;
    const pct = (v, d = 2) => (v * 100).toFixed(d) + '%';

    async function load() {
        const seq = ++S.seq;
        S.loading = true; paint();
        let d = null;
        try { d = DD.tierData ? await DD.tierData() : null; } catch (e) { d = { error: e.message }; }
        if (seq !== S.seq) return;
        S.data = d; S.loading = false; paint();
        // patch trends load in the background the first time: read again once they are in
        if (d && !d.error && !d.trendReady && !S.retried) { S.retried = true; setTimeout(() => { if (DD.currentView() === 'tierlist') load(); }, 1500); }
    }
    function rows() {
        const d = S.data;
        if (!d || d.error) return [];
        const q = S.q.trim().toLowerCase();
        return d.rows.filter(r => (S.role === 'ALL' || r.role === S.role) && (S.niche || (r.freq >= 0.1 && r.pick >= 0.005)) && (!q || r.name.toLowerCase().includes(q)))
            .map(r => ({ ...r, d: r.wr - (d.mean[r.role] || 0.5), tier: tierOf(r.wr - (d.mean[r.role] || 0.5)) }));
    }
    function paint() {
        if (!root.firstChild) {
            root.innerHTML = `<div class="tl-wrap"><div class="tl-top" id="tl-top"></div><div class="tl-body" id="tl-body"></div></div>`;
            root.addEventListener('click', onClick);
            root.addEventListener('input', e => { if (e.target.id === 'tl-q') { S.q = e.target.value; paintBody(); } });
            root.addEventListener('change', e => { if (e.target.dataset.tl === 'niche') { S.niche = e.target.checked; paintBody(); } else if (e.target.dataset.tl === 'sort') { S.sort = e.target.value; paintBody(); } });
        }
        const d = S.data;
        root.querySelector('#tl-top').innerHTML = `<div class="tl-tabs">${[['list', 'Tier list'], ['movers', 'Patch movers'], ['pool', 'Pool planner']].map(([k, n]) => `<button class="tl-tab${S.tab === k ? ' on' : ''}" data-tab="${k}">${n}</button>`).join('')}</div>
            <div class="tl-roles">${ROLES.map(([k, n]) => `<button class="tl-role${S.role === k ? ' on' : ''}" data-role="${k}">${n}</button>`).join('')}</div>
            <input type="text" id="tl-q" class="tl-q" placeholder="Search…" value="${esc(S.q)}" autocomplete="off" spellcheck="false">
            <span class="dg-prov-row">${DD.provChip && DD.draftProv && d && !d.error ? DD.provChip('tier', DD.draftProv()) : ''}</span>${DD.help ? DD.help('tier') : ''}`;
        paintBody();
    }
    function paintBody() {
        const body = root.querySelector('#tl-body');
        if (!body) return;
        if (S.loading && !S.data) { body.innerHTML = DD.ui.loading('Loading the tier list…', { rows: 8 }); return; }
        if (S.data && S.data.error) { body.innerHTML = DD.ui.error(S.data.error, { onRetry: load }); return; }
        if (!S.data) {
            body.innerHTML = DD.ui.empty('No data for this Time Period and Rank', 'Pick another Time Period or Rank at the top right, or download more in Saved data.', { label: 'Saved data…', act: 'saved-data' });
            return;
        }
        if (S.tab === 'pool') { if (window.DDPool) window.DDPool.render(body, S.role); return; }   // pool-planner.js (one role at a time)
        const list = rows();
        if (S.tab === 'movers') { body.innerHTML = moversHtml(list); return; }
        const order = { tier: (a, b) => b.d - a.d, wr: (a, b) => b.wr - a.wr, pick: (a, b) => b.pick - a.pick, games: (a, b) => b.games - a.games, name: (a, b) => a.name.localeCompare(b.name) };
        list.sort(order[S.sort] || order.tier);
        const trendMark = t => (t && t.flag ? `<span class="tl-tr ${t.d > 0 ? 'up' : 'down'}" title="${pts(t.d)} pts since patch ${esc(t.prevPatch)}">${t.d > 0 ? '▲' : '▼'}</span>` : '');
        body.innerHTML = `<div class="tl-controls"><label><input type="checkbox" data-tl="niche"${S.niche ? ' checked' : ''}> Show niche picks</label>
                <label>Sort <select data-tl="sort">${[['tier', 'Tier'], ['wr', 'Win rate'], ['pick', 'Pick rate'], ['games', 'Games'], ['name', 'Name']].map(([k, n]) => `<option value="${k}"${S.sort === k ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
                <span class="tl-m">${list.length} champion${list.length === 1 ? '' : 's'} · ${esc(S.data.label)}</span></div>
            <table class="tl-table"><thead><tr><th>#</th><th>Tier</th><th class="l">Champion</th>${S.role === 'ALL' ? '<th class="l">Role</th>' : ''}<th title="Shrunk win rate (small samples pulled toward the role average)">Win rate</th><th title="Against the role's average">vs role</th><th>Pick rate</th><th title="Share of the champion's games played in this role">Role share</th><th>Games</th></tr></thead><tbody>
            ${list.map((r, i) => `<tr class="tl-row" data-hub="${esc(r.champion)}" data-hub-role="${esc(r.role)}" title="${esc(r.name)}: open its page">
                <td class="tl-m">${i + 1}</td><td><span class="tl-tier t-${r.tier.replace('+', 'p')}">${r.tier}</span></td>
                <td class="l"><img class="tl-ico" src="${esc(img(r.champion))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">${esc(r.name)}${trendMark(r.trend)}</td>
                ${S.role === 'ALL' ? `<td class="l tl-m">${LANE[r.role]}</td>` : ''}
                <td><b>${pct(r.wr)}</b>${r.sd != null && r.sd > 0.008 ? '<span class="tl-m" title="Few games: still uncertain">*</span>' : ''}</td><td class="${r.d >= 0 ? 'delta-pos' : 'delta-neg'}">${pts(r.d)}</td>
                <td>${pct(r.pick, 1)}</td><td class="tl-m">${pct(r.freq, 0)}</td><td class="tl-m">${Math.round(r.games).toLocaleString()}</td></tr>`).join('') || `<tr><td colspan="9">${DD.ui.empty('No champion matches', S.q.trim() ? 'Clear the search box.' : 'Tick "Show niche picks" to include rarely played champion-roles.')}</td></tr>`}</tbody></table>`;
    }
    function moversHtml(list) {
        const withTrend = list.filter(r => r.trend && r.trend.flag);
        if (!list.some(r => r.trend)) return DD.ui.empty('No previous patch to compare with', `Patch movers need the previous patch saved for this rank (it is saved automatically when a patch ends, or from Saved data › Download more history). Current selection: ${S.data.label}.`, { label: 'Saved data…', act: 'saved-data' });
        const up = withTrend.filter(r => r.trend.d > 0).sort((a, b) => b.trend.d - a.trend.d).slice(0, 15);
        const down = withTrend.filter(r => r.trend.d < 0).sort((a, b) => a.trend.d - b.trend.d).slice(0, 15);
        const prev = (list.find(r => r.trend) || {}).trend.prevPatch;
        const col = (title, rs, cls) => `<div class="tl-col"><h3 class="${cls}">${title}</h3>${rs.map(r => `<div class="tl-mover" data-hub="${esc(r.champion)}" data-hub-role="${esc(r.role)}"><img class="tl-ico" src="${esc(img(r.champion))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
            <span class="tl-mn">${esc(r.name)} <span class="tl-m">${LANE[r.role]}</span></span><b class="${cls}">${pts(r.trend.d)}</b><span class="tl-m">${pct(r.trend.prev, 1)} → ${pct(r.wr, 1)}</span></div>`).join('') || '<div class="tl-m">None beyond noise.</div>'}</div>`;
        return `<p class="tl-note">Shrunk win rate now against patch ${esc(prev)} (same rank). Only changes of 0.75+ points that are at least twice their noise are listed, so ordinary patch-to-patch wobble is left out.</p>
            <div class="tl-cols">${col('Rising', up, 'delta-pos')}${col('Falling', down, 'delta-neg')}</div>`;
    }
    function onClick(e) {
        const t = e.target.closest('[data-tab]'); if (t && t.closest('.tl-tabs')) { S.tab = t.dataset.tab; paint(); return; }
        const r = e.target.closest('[data-role]'); if (r && r.closest('.tl-roles')) { S.role = r.dataset.role; paint(); return; }
        const h = e.target.closest('[data-hub]'); if (h && DD.openChampion) DD.openChampion(h.dataset.hub, h.dataset.hubRole || null);
    }
    DD.onView(name => { if (name === 'tierlist') load(); });
    for (const id of ['time-period-select', 'rank-select']) {   // shown in this view too (index.html CSS); a new choice reloads
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', () => { if (DD.currentView() === 'tierlist') setTimeout(load, 50); });
    }
    window.DDTier = {
        context: () => ({ role: S.role, tab: S.tab }),
        restore: c => { if (c && c.role) S.role = c.role; if (c && c.tab) S.tab = c.tab; paint(); },
        state: S, reload: load, tierOf
    };
})();
