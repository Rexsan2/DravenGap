// desktop-app/build-coach.js
// Personal build coaching (C8): the items you finish with in your own games on a champion and role (Profile's saved matches,
// profile:champ-summary) against the Coachless WPA tables for the same champion and role (the saved Builds data).
// "You buy X in 70% of your Ahri games; Y has +1.1 WPA (PP 96%)" is shown only with strong evidence: Y needs PP >= 90%, at least
// +0.5 points more sample-adjusted WPA than X, and 1,000+ buys. Your items whose WPA is very likely negative (PP <= 10%) are flagged.
// computeCoaching() is pure (Node tests load it with require); in the window it is window.DDCoach with a cache and a card renderer
// used by the Builds view and the champion hub (repaint on the 'coach-updated' event).
(function () {
    'use strict';
    const C = { minGames: 3, minShare: 0.4, pp: 0.9, gain: 0.005, minBuys: 1000, warnPp: 0.1 };
    const POS = { TOP: 'TOP', JUNGLE: 'JUNGLE', MIDDLE: 'MIDDLE', BOTTOM: 'BOTTOM', SUPPORT: 'UTILITY' };

    // mine: profile:champ-summary result; tables: { legendaries:[row], boots:[row] } with row = { id, name, img, wpa, adj, pp, buys, pickRate }
    // -> { status:'ok'|'few-games'|'no-items', games, rows:[{ kind, item, share, alt|null, warn }] }
    function computeCoaching(mine, tables, role) {
        const bucket = mine && mine.items && mine.items[POS[role] || role];
        const games = bucket ? bucket.games : 0;
        if (games < C.minGames) return { status: 'few-games', games };
        const rows = [];
        for (const kind of ['legendaries', 'boots']) {
            const table = (tables && tables[kind]) || [];
            const byId = new Map(table.map(r => [String(r.id), r]));
            const yours = Object.entries(bucket.freq || {}).map(([id, n]) => ({ r: byId.get(String(id)), share: n / games })).filter(x => x.r && x.share >= C.minShare);
            const yourIds = new Set(yours.map(x => String(x.r.id)));
            for (const { r, share } of yours.sort((a, b) => b.share - a.share)) {
                const mineAdj = r.adj != null ? r.adj : r.wpa;
                const alt = table.filter(y => !yourIds.has(String(y.id)) && y.pp != null && y.pp >= C.pp && (y.buys || 0) >= C.minBuys && (y.adj != null ? y.adj : y.wpa) - mineAdj >= C.gain)
                    .sort((a, b) => (b.adj != null ? b.adj : b.wpa) - (a.adj != null ? a.adj : a.wpa))[0] || null;
                rows.push({ kind, item: r, share, alt, warn: r.pp != null && r.pp <= C.warnPp });
            }
        }
        return { status: rows.length ? 'ok' : 'no-items', games, rows };
    }

    if (typeof window === 'undefined' || !window.DD) { if (typeof module !== 'undefined') module.exports = { computeCoaching, THRESHOLDS: C }; return; }

    // ------------------------------------------------------------------------------------------------ window side
    const DD = window.DD;
    const api = window.electronAPI && window.electronAPI.feature;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const wpa = v => (v == null ? '–' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}`);
    const pp = v => (v == null ? '–' : `<span class="${DD.ppClass ? DD.ppClass(v) : ''}">${v > 0.995 ? '>99%' : v < 0.005 ? '<1%' : Math.round(v * 100) + '%'}</span>`);
    const cache = new Map();   // "champ|role" -> { loading } | { result, acct, games, champGames } | { error }
    let summaryCache = new Map(); // champ -> profile:champ-summary promise (one per session view)

    async function ownerAccount() {
        try { const r = await api.invoke('profile:me'); if (r && r.ok && r.me && r.me.platform) return { gameName: r.me.gameName, tagLine: r.me.tagLine, platform: r.me.platform }; } catch (e) { /* client down */ }
        try { const s = await window.electronAPI.getSettings(); if (s && s.profileAccount && s.profileAccount.gameName) return s.profileAccount; } catch (e) { /* none */ }
        return null;
    }
    async function load(champ, role) {
        const key = `${champ}|${role}`;
        cache.set(key, { loading: true });
        try {
            const c = (DD.getChampions() || []).find(x => x.id === champ);
            const acct = await ownerAccount();
            if (!acct || !c) { cache.set(key, { error: 'no-account' }); return; }
            if (!summaryCache.has(champ)) summaryCache.set(champ, api.invoke('profile:champ-summary', { champId: Number(c.key), ...acct }));
            const [mine, tables] = await Promise.all([summaryCache.get(champ), DD.buildsTables ? DD.buildsTables(champ, role) : null]);
            if (!mine || !mine.ok) { cache.set(key, { error: (mine && mine.error) || 'unavailable' }); return; }
            if (!tables || !tables.saved) { cache.set(key, { error: 'no-builds' }); return; }
            cache.set(key, { result: computeCoaching(mine, tables, role), acct, champGames: mine.games, patches: tables.patches });
        } catch (e) { cache.set(key, { error: e.message }); }
        finally { window.dispatchEvent(new CustomEvent('coach-updated', { detail: { champ, role } })); }
    }
    // the card for the Builds view / hub; '' until loaded (then 'coach-updated' asks the caller to repaint)
    function html(champ, role) {
        if (!champ || !role || !api) return '';
        const key = `${champ}|${role}`, e = cache.get(key);
        if (!e) { load(champ, role); return ''; }
        if (e.loading || e.error) return '';          // nothing to coach (no account, no builds, Profile unavailable): stay quiet
        const r = e.result, name = (DD.getChampions() || []).find(x => x.id === champ);
        const cname = esc(name ? name.name : champ), roleName = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', SUPPORT: 'Support' }[role] || role;
        const headFor = sub => `<div class="coach-h">Your build vs the data ${DD.help ? DD.help('coaching') : ''}${sub ? ` <span class="coach-m">${sub}</span>` : ''}</div>`;
        const head = headFor(`${r.games} of your ${cname} ${roleName} games in Profile`);
        if (r.status === 'few-games') return e.champGames ? `<div class="coach">${headFor('')}<div class="coach-m">Not enough of your ${cname} ${roleName} games saved in Profile yet (${r.games}; needs ${C.minGames}).</div></div>` : '';
        if (r.status === 'no-items') return `<div class="coach">${head}<div class="coach-m">No item you finish with in ${Math.round(C.minShare * 100)}%+ of these games is in the Coachless tables.</div></div>`;
        const icon = it => `<img class="coach-ico" src="${esc(it.img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
        const rows = r.rows.map(x => `<div class="coach-row${x.alt ? ' alt' : x.warn ? ' warn' : ''}">
            <div class="coach-you">${icon(x.item)}<b>${esc(x.item.name)}</b> <span class="coach-m">you: ${Math.round(x.share * 100)}% of games</span> · WPA <b class="${x.item.wpa >= 0 ? 'delta-pos' : 'delta-neg'}">${wpa(x.item.adj != null ? x.item.adj : x.item.wpa)}</b> · PP ${pp(x.item.pp)}</div>
            ${x.alt ? `<div class="coach-alt">→ ${icon(x.alt)}<b>${esc(x.alt.name)}</b>: WPA <b class="delta-pos">${wpa(x.alt.adj != null ? x.alt.adj : x.alt.wpa)}</b> · PP ${pp(x.alt.pp)} <span class="coach-m">(${Math.round(x.alt.buys).toLocaleString()} buys, ${Math.round((x.alt.pickRate || 0) * 1000) / 10}% of ${x.kind === 'boots' ? 'boots' : 'legendary'} purchases)</span></div>`
                : x.warn ? `<div class="coach-alt coach-m">Its WPA is very likely negative for ${cname} ${roleName}.</div>` : `<div class="coach-alt coach-m">In line with the data: nothing clearly better.</div>`}</div>`).join('');
        return `<div class="coach">${head}${rows}<div class="coach-m coach-foot">WPA adjusted for sample size, all item slots, patch${(e.patches || []).length > 1 ? 'es' : ''} ${esc((e.patches || []).join(' + '))}. A swap is suggested only with PP ≥ 90% and +0.5 WPA or more.</div></div>`;
    }
    window.addEventListener('builds-updated', () => { for (const k of [...cache.keys()]) if (!cache.get(k).loading) cache.delete(k); });
    // new games saved in Profile (after a game, or a backfill): read them again next time
    if (api) api.on('profile:update', ev => { if (ev && ['matches', 'ledger', 'personal'].includes(ev.kind)) { summaryCache = new Map(); for (const k of [...cache.keys()]) if (!cache.get(k).loading) cache.delete(k); } });
    window.DDCoach = { html, computeCoaching, THRESHOLDS: C, _cache: cache };
})();
