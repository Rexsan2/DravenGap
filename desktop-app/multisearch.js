// desktop-app/multisearch.js
// Multi-search (view 'scout', #scout-root; op.gg / u.gg style): paste champion-select chat ("Name#TAG joined the lobby"), a list
// of Riot IDs, or take your client lobby, and see every player at once: rank and win rate, level, top mastery, the last 5 games
// and the live-game tags (profile:multi; needs a Riot API key). Two players are looked up at a time; the app's shared Riot
// limiter keeps the whole search inside the key's budget. Click a card for the full profile.
// Loading / empty / error states come from DD.ui (ui-states.js): a rate-limited player shows "Resumes in 1:12" and looks up again by itself.
(function () {
    'use strict';
    const DD = window.DD, root = document.getElementById('scout-root');
    const api = window.electronAPI && window.electronAPI.feature;
    if (!DD || !root || !api) return;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const PLATFORMS = ['EUW1', 'EUN1', 'NA1', 'KR', 'BR1', 'LA1', 'LA2', 'OC1', 'TR1', 'RU', 'JP1', 'PH2', 'SG2', 'TH2', 'TW2', 'VN2', 'ME1'];
    const MAX = 10;
    const S = { text: '', platform: null, players: [], seq: 0 };
    const champByKey = k => (DD.getChampions() || []).find(c => Number(c.key) === Number(k)) || null;
    const icon = (k, cls = 'ms-ico') => { const c = champByKey(k), v = DD.getLatestPatch && DD.getLatestPatch(); return c && v ? `<img class="${cls}" src="${DD.ddragonBase}/cdn/${v}/img/champion/${c.image.full}" alt="${esc(c.name)}" title="${esc(c.name)}" loading="lazy" onerror="this.style.visibility='hidden'">` : ''; };
    const RANK = { RANKED_SOLO_5x5: 'Solo/Duo', RANKED_FLEX_SR: 'Flex' };

    // "Name#TAG joined the lobby", "Name #TAG", "Name#TAG, Other#TAG": one Riot ID per match, duplicates removed
    function parse(text) {
        const out = [], seen = new Set();
        for (let line of String(text || '').split(/[\r\n,;]+/)) {
            line = line.replace(/\s+(joined|left)\s+the\s+lobby.*$/i, '').replace(/\s+has\s+(joined|left).*$/i, '').trim();
            const m = line.match(/([^#:]{3,16}?)\s*#\s*([A-Za-z0-9]{2,5})\b/);
            if (!m) continue;
            const id = { gameName: m[1].trim(), tagLine: m[2] };
            const k = `${id.gameName.toLowerCase()}#${id.tagLine.toLowerCase()}`;
            if (seen.has(k)) continue;
            seen.add(k); out.push(id);
            if (out.length >= MAX) break;
        }
        return out;
    }
    async function defaultPlatform() {
        if (S.platform) return S.platform;
        try { const r = await api.invoke('profile:me'); if (r && r.ok && r.me && r.me.platform) return (S.platform = r.me.platform); } catch (e) { /* no client */ }
        try { const s = await window.electronAPI.getSettings(); if (s && s.profileAccount && s.profileAccount.platform) return (S.platform = s.profileAccount.platform); } catch (e) { /* none */ }
        return (S.platform = 'EUW1');
    }
    async function search() {
        const ids = parse(S.text), seq = ++S.seq, platform = await defaultPlatform();
        S.players = ids.map(id => ({ ...id, platform, state: 'loading' }));
        paint();
        let next = 0;
        const worker = async () => {
            while (next < S.players.length && seq === S.seq) await lookup(S.players[next++], seq);
        };
        await Promise.all([worker(), worker()]);
    }
    async function lookup(p, seq) {
        const r = await api.invoke('profile:multi', { gameName: p.gameName, tagLine: p.tagLine, platform: p.platform }).catch(e => ({ ok: false, error: e.message }));
        if (seq !== S.seq) return;
        Object.assign(p, r && r.ok ? { state: 'ok', data: r } : { state: 'error', error: (r && r.error) || 'Lookup failed.', code: r && r.code, retryAt: r && r.retryAt });
        paintCards();
    }
    function retry(p) {
        p.state = 'loading';
        paintCards();
        return lookup(p, S.seq);
    }
    async function fromLobby() {
        DD.showView('scout');
        if (!root.firstChild) paint();
        const r = await api.invoke('profile:duo').catch(() => null);
        if (!r || !r.ok || !r.lcu) { S.note = 'League client not detected: paste the lobby chat instead.'; paint(); return; }
        const ids = [r.me && r.me.gameName ? `${r.me.gameName}#${r.me.tagLine}` : null, ...(r.partners || []).map(p => `${p.gameName}#${p.tagLine}`)].filter(Boolean);
        if (r.me && r.me.platform) S.platform = r.me.platform;
        S.note = ids.length > 1 ? '' : 'Only you are in the lobby. In ranked champion select names are hidden: paste the chat lines once they appear.';
        S.text = ids.join('\n');
        paint();
        if (ids.length) search();
    }

    function paint() {
        root.innerHTML = `<div class="ms-wrap"><div class="ms-top">
                <textarea id="ms-text" class="ms-text" rows="4" spellcheck="false" placeholder="Paste the champion select chat (&quot;Name#TAG joined the lobby&quot;) or Riot IDs, one per line">${esc(S.text)}</textarea>
                <div class="ms-side"><select id="ms-platform" aria-label="Region">${PLATFORMS.map(p => `<option${p === (S.platform || 'EUW1') ? ' selected' : ''}>${p}</option>`).join('')}</select>
                    <button id="ms-go" class="ms-btn main">Search</button><button id="ms-lobby" class="ms-btn" title="Fill in the players of your League client lobby">Use my lobby</button></div></div>
                <div class="ms-note">${esc(S.note || `Up to ${MAX} players. Needs a Riot API key (Settings); players looked up recently come from the cache.`)} ${DD.help ? DD.help('tags') : ''}</div>
                <div class="ms-cards" id="ms-cards"></div></div>`;
        paintCards();
    }
    function card(p) {
        const head = `<div class="ms-name">${esc(p.gameName)}<span>#${esc(p.tagLine)}</span></div>`;
        if (p.state === 'loading') return `<div class="ms-card loading">${head}${DD.ui.loading('Looking up…')}</div>`;
        if (p.state === 'error') {
            const e = p.code === 'NOT_FOUND' ? { code: p.code, error: `Not found on ${p.platform}.` } : { code: p.code, error: p.error, retryAt: p.retryAt };
            return `<div class="ms-card err">${head}${DD.ui.error(e, { compact: true, onRetry: p.code === 'NOT_FOUND' ? null : () => retry(p), autoRetry: true })}</div>`;
        }
        const d = p.data, pr = d.profile;
        const solo = (pr.ranked || []).find(e => e.queueType === 'RANKED_SOLO_5x5'), flex = (pr.ranked || []).find(e => e.queueType === 'RANKED_FLEX_SR');
        const rk = e => { const g = e.wins + e.losses; return `<span class="ms-tier t-${esc(e.tier)}">${esc(e.tier.charAt(0) + e.tier.slice(1).toLowerCase())}${['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(e.tier) ? '' : ' ' + esc(e.rank)}</span> ${e.leaguePoints} LP · <b class="${e.wins / g >= 0.5 ? 'delta-pos' : 'delta-neg'}">${Math.round(e.wins / g * 100)}%</b> <span class="ms-m">${g} games</span>`; };
        const form = d.form && d.form.results ? d.form.results.slice(0, 5) : [];
        return `<div class="ms-card" data-acct="${esc(JSON.stringify({ gameName: pr.gameName, tagLine: pr.tagLine, platform: pr.platform }))}" title="Open the full profile">${head}
            <div class="ms-m">Level ${pr.summonerLevel || '?'}</div>
            <div class="ms-rank">${solo ? `${RANK[solo.queueType]}: ${rk(solo)}` : '<span class="ms-m">Solo/Duo: unranked</span>'}</div>
            ${flex ? `<div class="ms-rank ms-m">${RANK[flex.queueType]}: ${rk(flex)}</div>` : ''}
            <div class="ms-row"><span class="ms-m">Mastery</span>${(pr.mastery || []).slice(0, 3).map(m => `<span class="ms-mast">${icon(m.championId)}<em>${Math.round(m.championPoints / 1000)}k</em></span>`).join('') || '<span class="ms-m">–</span>'}</div>
            <div class="ms-row"><span class="ms-m">Last ${form.length}</span>${form.map(g => `<span class="ms-g ${g.win ? 'w' : 'l'}" title="${g.k}/${g.d}/${g.a}">${icon(g.champId, 'ms-ico sm')}</span>`).join('') || `<span class="ms-m">${d.formError ? esc(d.formError.error || 'unavailable') : 'no recent games'}</span>`}</div>
            <div class="ms-tags">${(d.tags || []).map(t => `<span class="ms-tag ${esc(t.cls)}" title="${esc(t.tip)}">${esc(t.label)}</span>`).join('')}</div></div>`;
    }
    function paintCards() {
        const el = root.querySelector('#ms-cards');
        if (!el) return;
        el.innerHTML = S.players.length ? S.players.map(card).join('')
            : DD.ui.empty('Nothing searched yet', 'Paste the champion select chat or a list of Riot IDs above, or press "Use my lobby".');
    }
    root.addEventListener('input', e => { if (e.target.id === 'ms-text') S.text = e.target.value; });
    root.addEventListener('change', e => { if (e.target.id === 'ms-platform') S.platform = e.target.value; });
    root.addEventListener('keydown', e => { if (e.target.id === 'ms-text' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); search(); } });
    root.addEventListener('click', e => {
        if (e.target.closest('#ms-go')) { search(); return; }
        if (e.target.closest('#ms-lobby')) { fromLobby(); return; }
        const c = e.target.closest('.ms-card[data-acct]');
        if (c && window.DDProfile) { try { window.DDProfile.openFromOutside(JSON.parse(c.dataset.acct), 'summary'); } catch (err) { /* bad data */ } }
    });
    DD.onView(name => { if (name === 'scout' && !root.firstChild) paint(); });
    window.DDScout = { fromLobby, search, parse, state: S, setText: t => { S.text = t; paint(); } };
})();
