// desktop-app/duo-view.js
// Duo / premade synergy (C6): the draft's Duo tab (#duo-view). The partner comes from the League client lobby (profile:duo),
// from the players you often play with (profile:played) or a typed Riot ID. Champion pairs for your two lanes are ranked with
// DD.duoPairs (the draft verdict's own model), and your games together come from your saved Profile matches
// (profile:duo-history). Recomputed while the tab is open when the draft changes.
//
// The controls are built once and only their parts are repainted (and only when their HTML changed), so the Riot ID box keeps its
// text, cursor and focus while the 2.5 s timer or a result repaints the rest. A typed Riot ID is applied on Enter, on leaving the
// box or with the Use button, never per keystroke (applying looks the partner up, which costs Riot requests).
// Pools: "My pool" (on by default) = DD.myPool(); "Partner's champions" = the champions they played with you in that lane, else
// (no games together) their mastery and last games from profile:multi: 3+ of the last games or 20,000+ mastery, like My pool.
(function () {
    'use strict';
    const DD = window.DD, el = document.getElementById('duo-view');
    const api = window.electronAPI && window.electronAPI.feature;
    if (!DD || !el || !api) return;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ROLE_LABEL = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', SUPPORT: 'Support' };
    const POS_ROLE = { TOP: 'TOP', JUNGLE: 'JUNGLE', MIDDLE: 'MIDDLE', MID: 'MIDDLE', BOTTOM: 'BOTTOM', BOT: 'BOTTOM', UTILITY: 'SUPPORT', SUPPORT: 'SUPPORT' };
    const ROLE_POS = { TOP: 'TOP', JUNGLE: 'JUNGLE', MIDDLE: 'MIDDLE', BOTTOM: 'BOTTOM', SUPPORT: 'UTILITY' };
    const DUO_OF = { BOTTOM: 'SUPPORT', SUPPORT: 'BOTTOM', JUNGLE: 'MIDDLE', MIDDLE: 'JUNGLE', TOP: 'JUNGLE' };
    const RIOT_ID = /^(.{3,16}?)\s*#\s*([A-Za-z0-9]{2,5})$/;
    const POOL_MIN_GAMES = 3, POOL_MIN_MASTERY = 20000;     // the same rule as My pool in the draft
    const S = { partner: null, partnerSrc: '', roleA: null, roleB: null, poolA: true, poolB: true, detected: null, played: [], owner: null, ownerPuuid: null,
        hist: null, histKey: '', data: null, sig: '', busy: false, rerun: false, timer: null, typed: '', typedNote: '', userRoles: false, pinfo: {}, relaxed: null };
    const pts = v => (v == null || !isFinite(v) ? '–' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}`);
    const pct = v => (v == null ? '–' : (v * 100).toFixed(1) + '%');
    const pp = p => (p == null ? '–' : `<span class="${DD.ppClass ? DD.ppClass(p) : ''}">${p > 0.995 ? '>99%' : p < 0.005 ? '<1%' : Math.round(p * 100) + '%'}</span>`);
    const champs = () => DD.getChampions() || [];
    const byKey = k => champs().find(c => Number(c.key) === Number(k)) || null;
    const byId = id => champs().find(c => c.id === id) || null;
    const icon = id => { const c = byId(id), v = DD.getLatestPatch && DD.getLatestPatch(); return c && v ? `<img class="duo-ico" src="${DD.ddragonBase}/cdn/${v}/img/champion/${c.image.full}" alt="" onerror="this.style.visibility='hidden'">` : ''; };
    const roleOf = p => POS_ROLE[String(p || '').toUpperCase()] || null;
    const partnerKey = p => (p ? `${String(p.gameName).toLowerCase()}#${String(p.tagLine || '').toLowerCase()}` : '');
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

    // Small styles for the parts this file adds (the rest of the tab is styled in index.html)
    if (!document.getElementById('duo-view-style')) {
        const st = document.createElement('style');
        st.id = 'duo-view-style';
        st.textContent = '.duo-row .duo-use { padding: 4px 10px; font-size: 0.85rem; } .duo-note { color: var(--text-secondary); font-size: 0.78rem; } .duo-note.warn { color: var(--yellow-warn); } .duo-pools { display: flex; flex-direction: column; gap: 2px; }';
        document.head.appendChild(st);
    }

    // ---- who you are: profile:owner (client account, else the last one seen, else Settings), else the older lookups ----------
    let ownerPending = null;
    async function resolveOwner() {
        try {
            const r = await api.invoke('profile:owner');
            const o = r && r.ok && r.owner;
            if (o && o.gameName && o.tagLine && o.platform) {
                S.owner = { gameName: o.gameName, tagLine: o.tagLine, platform: o.platform };
                if (o.puuid) S.ownerPuuid = o.puuid;
                return S.owner;
            }
        } catch (e) { /* the channel is missing or failed: use the older lookups below */ }
        try { const r = await api.invoke('profile:me'); if (r && r.ok && r.me && r.me.platform) S.owner = { gameName: r.me.gameName, tagLine: r.me.tagLine, platform: r.me.platform }; } catch (e) { /* client down */ }
        if (!S.owner) { try { const s = await window.electronAPI.getSettings(); if (s && s.profileAccount && s.profileAccount.gameName) S.owner = s.profileAccount; } catch (e) { /* none */ } }
        return S.owner;
    }
    function owner() {
        if (S.owner) return Promise.resolve(S.owner);
        if (!ownerPending) ownerPending = resolveOwner().finally(() => { ownerPending = null; });
        return ownerPending;
    }
    async function detect() {
        const r = await api.invoke('profile:duo').catch(() => null);
        S.detected = r && r.ok ? r : null;
        const partners = (S.detected && S.detected.partners) || [];
        if (partners.length && (!S.partner || S.partnerSrc === 'lobby' || S.partnerSrc === '')) {
            const keep = S.partner && partners.find(p => partnerKey(p) === partnerKey(S.partner));
            S.partner = keep || partners[0]; S.partnerSrc = 'lobby';
        }
        if (!S.userRoles) {
            const me = S.detected && S.detected.me;
            const mate = S.partner && S.partnerSrc === 'lobby' ? partners.find(p => partnerKey(p) === partnerKey(S.partner)) : null;
            S.roleA = (DD.liveLane && DD.liveLane()) || roleOf(me && me.assigned) || roleOf(me && me.positions && me.positions[0]) || S.roleA || 'BOTTOM';
            S.roleB = roleOf(mate && mate.assigned) || roleOf(mate && mate.positions && mate.positions[0]) || (S.roleB && S.roleB !== S.roleA ? S.roleB : DUO_OF[S.roleA]);
            if (S.roleB === S.roleA) S.roleB = DUO_OF[S.roleA];
        }
    }
    async function loadPlayed() {
        if (S.played.length || S.playedTried) return;
        S.playedTried = true;
        const o = await owner();
        if (!o) return;
        if (!S.ownerPuuid) {
            const look = await api.invoke('profile:lookup', o).catch(() => null);
            if (!look || !look.ok) return;
            S.ownerPuuid = look.profile.puuid;
        }
        const r = await api.invoke('profile:played', { puuid: S.ownerPuuid, platform: o.platform, group: 'all' }).catch(() => null);
        S.played = r && r.ok ? r.list : [];
    }
    async function loadHistory() {
        const key = partnerKey(S.partner);
        if (!key || S.histKey === key) return;
        S.histKey = key; S.hist = { loading: true };
        const o = await owner();
        const r = o ? await api.invoke('profile:duo-history', { owner: S.ownerPuuid ? { puuid: S.ownerPuuid } : o, partner: { gameName: S.partner.gameName, tagLine: S.partner.tagLine } }).catch(e => ({ ok: false, error: e.message }))
            : { ok: false, error: 'No account: start the League client or set your Riot ID in Settings.' };
        if (S.histKey === key) S.hist = r;
    }

    // ---- the partner's champions ---------------------------------------------------------------------------------------------
    // 1) champions they played with you in that lane (your saved Profile games), 2) else profile:multi: 3+ of their recent games
    // or 20,000+ mastery. Returns { ids: [champion id] | null, text, cls } (ids null = no filter, with the reason in text).
    function togetherIds() {
        if (!S.hist || !S.hist.ok) return [];
        const byPos = (S.hist.partnerChamps || {})[ROLE_POS[S.roleB]] || {};
        return Object.keys(byPos).map(k => byKey(k)).filter(Boolean).map(c => c.id);
    }
    function partnerPoolInfo() {
        if (!S.poolB || !S.partner) return { ids: null, text: '', cls: '' };
        const name = esc(S.partner.gameName), lane = ROLE_LABEL[S.roleB];
        if (!S.hist || S.hist.loading) return { ids: null, text: 'Reading your games together…', cls: '' };
        const tog = togetherIds();
        if (tog.length) return { ids: tog, text: `Partner's champions: ${plural(tog.length, 'champion')} ${name} played as ${lane} in your ${plural(S.hist.games, 'game')} together.`, cls: '' };
        const why = S.hist && S.hist.ok && S.hist.games ? `none as ${lane} in your games together` : 'no games together yet';
        const pi = S.pinfo[partnerKey(S.partner)];
        if (!pi || pi.state === 'loading') return { ids: null, text: `Looking up ${name}'s mastery and recent games (${why})… showing every champion for now.`, cls: '' };
        if (pi.state === 'error') return { ids: null, text: `Partner's champions: ${esc(pi.error)} Showing every champion for ${name}.`, cls: 'warn' };
        const ids = pi.ids.map(k => byKey(k)).filter(Boolean).map(c => c.id);
        if (!ids.length) return { ids: null, text: `${name} has no champion with ${POOL_MIN_MASTERY.toLocaleString('en-US')}+ mastery${pi.games ? ` or ${POOL_MIN_GAMES}+ of their last ${pi.games} games` : ''}: showing every champion for them.`, cls: 'warn' };
        return { ids, text: `Partner's champions: from their mastery${pi.games ? ` and last ${plural(pi.games, 'game')}` : ''} (${why}), ${plural(ids.length, 'champion')}.`, cls: '' };
    }
    const partnerPool = () => partnerPoolInfo().ids;
    // profile:multi returns the profile (mastery) and the last 5 games; one lookup per partner, kept for the session
    function startPartnerLookup() {
        if (!S.poolB || !S.partner || !S.hist || S.hist.loading || togetherIds().length) return;
        const p = S.partner, key = partnerKey(p), cur = S.pinfo[key];
        if (cur) return;
        S.pinfo[key] = { state: 'loading' };
        (async () => {
            let info;
            try {
                const o = await owner();
                const platform = p.platform || (o && o.platform);
                if (!platform) throw new Error('No region known: start the League client or set your Riot ID in Settings.');
                const r = await api.invoke('profile:multi', { gameName: p.gameName, tagLine: p.tagLine, platform });
                if (!r || !r.ok) {
                    const code = r && r.code;
                    throw new Error(code === 'NO_KEY' || code === 'KEY_REJECTED' ? 'Needs a valid Riot API key (Settings) to look them up.' : code === 'NOT_FOUND' ? `Not found on ${platform} (same region as you).` : ((r && r.error) || 'The lookup failed.'));
                }
                const results = (r.form && r.form.results) || [], counts = {}, ids = new Set();
                for (const g of results) counts[g.champId] = (counts[g.champId] || 0) + 1;
                for (const [id, n] of Object.entries(counts)) if (n >= POOL_MIN_GAMES) ids.add(Number(id));
                for (const m of (r.profile && r.profile.mastery) || []) if (m.championPoints >= POOL_MIN_MASTERY) ids.add(Number(m.championId));
                info = { state: 'ready', ids: [...ids], games: results.length };
            } catch (e) { info = { state: 'error', error: String(e.message || e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '') }; }
            S.pinfo[key] = info;
            if (partnerKey(S.partner) === key) { S.sig = ''; compute(true); }
        })();
    }

    function boardSig() { return [...document.querySelectorAll('.role-slot')].map(s => s.dataset.champion || s.dataset.hover || '-').join(','); }
    async function compute(force) {
        if (S.busy) { if (force) S.rerun = true; return; }
        const mp = DD.myPool && DD.myPool();
        const pi = S.partner && S.pinfo[partnerKey(S.partner)];
        const sig = [boardSig(), S.roleA, S.roleB, S.poolA, S.poolB, partnerKey(S.partner), S.hist && S.hist.games, mp ? mp.length : -1, pi ? pi.state : ''].join('|');
        if (!force && sig === S.sig) return;
        S.busy = true; S.sig = sig;
        try {
            await loadHistory();
            startPartnerLookup();
            const poolA = S.poolA ? DD.myPool() : null, poolB = partnerPool();
            let data = await DD.duoPairs({ roleA: S.roleA, roleB: S.roleB, poolA, poolB });
            S.relaxed = null;
            if (data && !data.error && !data.pairs.length && (poolA || poolB)) {     // the pools leave nothing: show every pair and say so
                const all = await DD.duoPairs({ roleA: S.roleA, roleB: S.roleB });
                if (all && all.pairs.length) { S.relaxed = { a: data.candidatesA, b: data.candidatesB, poolA: !!poolA, poolB: !!poolB }; data = all; }
            }
            S.data = data;
        } catch (e) { S.data = { error: e.message }; }
        S.busy = false;
        render();
        if (S.rerun) { S.rerun = false; compute(true); }
    }

    // ---- drawing: built once, then each part is repainted only when its HTML changed ------------------------------------------
    const part = k => el.querySelector(`[data-part="${k}"]`);
    const paint = (k, html) => { const n = part(k); if (n && n._html !== html) { n.innerHTML = html; n._html = html; } };
    function skeleton() {
        if (el.querySelector('.duo-wrap')) return;
        el.innerHTML = `<div class="duo-wrap"><div class="dg-prov-row" data-part="prov"></div><div class="duo-head" data-part="head"></div>
            <div class="duo-row"><label>Partner <select data-duo="partner"></select></label>
                <input type="text" data-duo="typed" placeholder="or Name#TAG" spellcheck="false" autocomplete="off" title="Type a Riot ID, then press Enter or Use">
                <button type="button" class="duo-use" data-duo="use" title="Use this Riot ID as your partner (Enter does the same)">Use</button>
                <span class="duo-note" data-part="typed-note"></span></div>
            <div class="duo-row" data-part="controls"></div><div class="duo-pools" data-part="pools"></div>
            <div data-part="together"></div><div data-part="pairs"></div></div>`;
        const input = el.querySelector('[data-duo="typed"]');
        input.value = S.typed;
    }

    function render() {
        skeleton();
        const d = S.data, h = S.hist, partners = (S.detected && S.detected.partners) || [];
        const opts = [];
        for (const p of partners) opts.push({ p, src: 'lobby', label: `${p.gameName}#${p.tagLine} · in your lobby${p.assigned ? ' (' + (ROLE_LABEL[roleOf(p.assigned)] || p.assigned) + ')' : ''}` });
        for (const p of S.played) if (!opts.some(o => partnerKey(o.p) === partnerKey({ gameName: p.name, tagLine: p.tag }))) opts.push({ p: { gameName: p.name, tagLine: p.tag }, src: 'played', label: `${p.name}#${p.tag} · ${p.games} games together (${p.wr}%)` });
        if (S.partner && !opts.some(o => partnerKey(o.p) === partnerKey(S.partner))) opts.push({ p: S.partner, src: S.partnerSrc, label: `${S.partner.gameName}#${S.partner.tagLine}` });
        S.opts = opts;
        const cur = opts.findIndex(o => partnerKey(o.p) === partnerKey(S.partner));
        const roleSel = (k, v) => `<select data-duo="${k}">${Object.keys(ROLE_LABEL).map(r => `<option value="${r}"${r === v ? ' selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>`;
        paint('prov', DD.provChip && DD.draftProv ? DD.provChip('duo', DD.draftProv()) : '');
        paint('head', `<b>Duo synergy</b> ${DD.help ? DD.help('duo') : ''} <span class="duo-m">${S.detected && S.detected.lcu ? (partners.length ? 'partner found in your lobby' : 'no partner in your lobby') : 'League client not detected'}</span>`);
        const sel = el.querySelector('[data-duo="partner"]'), optHtml = `<option value="-1">${opts.length ? 'Choose…' : 'No partner yet'}</option>${opts.map((o, i) => `<option value="${i}"${i === cur ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}`;
        if (sel._html !== optHtml) { sel.innerHTML = optHtml; sel._html = optHtml; }
        paint('typed-note', esc(S.typedNote));
        paint('controls', `<label>You ${roleSel('roleA', S.roleA)}</label><span>+</span><label>Partner ${roleSel('roleB', S.roleB)}</label>
            <label class="duo-check" title="Only champions you play (3+ games in your history or 20,000+ mastery)"><input type="checkbox" data-duo="poolA"${S.poolA ? ' checked' : ''}> My pool</label>
            <label class="duo-check" title="Only champions your partner plays: those they played with you in that lane, else their mastery and recent games"><input type="checkbox" data-duo="poolB"${S.poolB ? ' checked' : ''}${S.partner ? '' : ' disabled'}> Partner's champions</label>`);
        // where each pool comes from
        const mine = S.poolA ? (DD.myPool && DD.myPool()) : undefined, pl = [];
        if (S.poolA) pl.push(mine == null ? '<div class="duo-note warn">Your pool needs your stats (League client or Riot key): showing every champion for you.</div>'
            : `<div class="duo-note">${mine.length ? `Your pool: ${plural(mine.length, 'champion')} (3+ games in your history or 20,000+ mastery).` : 'Your pool is empty: no champion with 3+ games in your history or 20,000+ mastery.'}</div>`);
        const pb = partnerPoolInfo();
        if (pb.text) pl.push(`<div class="duo-note${pb.cls ? ' ' + pb.cls : ''}">${pb.text.replace(/^Partner's champions:/, "<b>Partner's champions:</b>")}</div>`);
        paint('pools', pl.join(''));
        // together
        let together = '';
        if (S.partner) {
            if (!h || h.loading) together = '<div class="duo-box duo-m">Reading your games together…</div>';
            else if (!h.ok) together = `<div class="duo-box duo-m">${esc(h.error || 'Your games together are not available.')}</div>`;
            else if (!h.games) together = `<div class="duo-box duo-m">No games with ${esc(S.partner.gameName)} in the ${h.scanned} games saved in Profile.</div>`;
            else {
                const lanes = h.lanes.slice(0, 3).map(l => `${ROLE_LABEL[roleOf(l.myPos)] || '?'} + ${ROLE_LABEL[roleOf(l.theirPos)] || '?'} ${l.games} (${Math.round(l.w / l.games * 100)}%)`).join(' · ');
                together = `<div class="duo-box"><div><b>Together:</b> ${h.games} game${h.games === 1 ? '' : 's'}, <b class="${h.w / h.games >= 0.5 ? 'delta-pos' : 'delta-neg'}">${Math.round(h.w / h.games * 100)}%</b> (${h.w}W ${h.games - h.w}L) <span class="duo-m">from your games saved in Profile · lanes: ${esc(lanes)}</span></div>
                    <div class="duo-hist">${h.pairs.slice(0, 6).map(p => { const a = byKey(p.mine), b = byKey(p.theirs); return a && b ? `<span class="duo-pair" title="${p.games} games, ${p.w} won">${icon(a.id)}${icon(b.id)}<b class="${p.w / p.games >= 0.5 ? 'delta-pos' : 'delta-neg'}">${p.w}-${p.games - p.w}</b></span>` : ''; }).join('')}</div></div>`;
            }
        }
        paint('together', together);
        // pairs
        let html = '';
        if (!d) html += '<div class="duo-box duo-m">Ranking pairs…</div>';
        else if (d.error) html += `<div class="duo-box duo-m">${esc(d.error)}</div>`;
        else if (!d.pairs.length) html += `<div class="duo-box duo-m">No pairs: ${!d.candidatesA ? `nobody for ${ROLE_LABEL[S.roleA]}` : `nobody for ${ROLE_LABEL[S.roleB]}`} with these filters.</div>`;
        else {
            if (S.relaxed) {
                const x = S.relaxed, why = [];
                if (x.poolA && !x.a) why.push(`nobody in your pool has ${ROLE_LABEL[S.roleA]} data`);
                if (x.poolB && !x.b) why.push(`nobody in your partner's pool has ${ROLE_LABEL[S.roleB]} data`);
                html += `<div class="duo-box duo-note warn"><b>No pair in both pools</b>${why.length ? ` (${why.join('; ')})` : ''}: showing all pairs.</div>`;
            }
            html += `<table class="bans-table duo-table"><thead><tr><th>#</th><th>You (${ROLE_LABEL[S.roleA]})</th><th>Partner (${ROLE_LABEL[S.roleB]})</th>
                <th title="(Exp WR you - 50) + (Exp WR partner - 50) + synergy: how much the pair adds, in points">Pair edge</th><th title="Half of each direction's adjusted Δ, as in the draft verdict">Synergy</th><th>PP</th><th>Exp WR you</th><th>Exp WR partner</th></tr></thead><tbody>
                ${d.pairs.map((p, i) => `<tr><td>${i + 1}</td><td class="bans-champ">${icon(p.a)}${esc(p.aName)}</td><td class="bans-champ">${icon(p.b)}${esc(p.bName)}</td>
                    <td class="${p.edge >= 0 ? 'delta-pos' : 'delta-neg'}"><b>${pts(p.edge)}</b></td><td class="${p.syn >= 0 ? 'delta-pos' : 'delta-neg'}">${pts(p.syn)} <span class="duo-m">± ${(p.synSd * 100).toFixed(1)}</span></td>
                    <td>${pp(p.synPp)}</td><td>${pct(p.expA)}</td><td>${pct(p.expB)}</td></tr>`).join('')}</tbody></table>
                <p class="bans-note">${d.draftPicks ? `Takes the ${d.draftPicks} champion${d.draftPicks === 1 ? '' : 's'} already in the draft into account. ` : ''}Top ${d.candidatesA} for you and ${d.candidatesB} for your partner by Exp WR, then every pair of them. Synergy ${S.roleA === 'BOTTOM' || S.roleA === 'SUPPORT' ? 'for Bot + Support uses the duo prior' : 'uses the ally prior'}; it is shrunk like Shrunk Δ.</p>`;
        }
        paint('pairs', html);
    }

    // ---- input ------------------------------------------------------------------------------------------------------------------
    function setPartner(p, src) {
        S.partner = p; S.partnerSrc = src; S.hist = null; S.histKey = ''; S.data = null; S.relaxed = null;
        const key = partnerKey(p);
        if (S.pinfo[key] && S.pinfo[key].state === 'error') delete S.pinfo[key];     // choosing someone again retries a failed lookup
    }
    // Typed Riot ID -> partner. Called on Enter, on leaving the box and from the Use button.
    function applyTyped() {
        const text = S.typed.trim();
        if (!text) { S.typedNote = ''; render(); return; }
        const m = text.match(RIOT_ID);
        if (!m) { S.typedNote = 'Use the form Name#TAG.'; render(); return; }
        S.typedNote = '';
        const p = { gameName: m[1].trim(), tagLine: m[2] };
        if (S.partner && S.partnerSrc === 'typed' && partnerKey(p) === partnerKey(S.partner)) {     // already in use: Use again retries a failed lookup
            const pi = S.pinfo[partnerKey(p)];
            if (pi && pi.state === 'error') { delete S.pinfo[partnerKey(p)]; render(); compute(true); } else render();
            return;
        }
        setPartner(p, 'typed');
        render(); compute(true);
    }
    el.addEventListener('change', e => {
        const k = e.target.dataset && e.target.dataset.duo;
        if (!k) return;
        if (k === 'partner') {
            const o = S.opts && S.opts[+e.target.value];
            setPartner(o ? o.p : null, o ? o.src : '');
            S.typed = ''; S.typedNote = ''; const i = el.querySelector('[data-duo="typed"]'); if (i) i.value = '';
        }
        else if (k === 'roleA' || k === 'roleB') { S[k] = e.target.value; S.userRoles = true; if (S.roleA === S.roleB) S[k === 'roleA' ? 'roleB' : 'roleA'] = DUO_OF[e.target.value]; }
        else if (k === 'poolA' || k === 'poolB') {
            S[k] = e.target.checked;
            if (k === 'poolB' && S.partner && S.pinfo[partnerKey(S.partner)] && S.pinfo[partnerKey(S.partner)].state === 'error') delete S.pinfo[partnerKey(S.partner)];
        }
        else return;
        S.data = null; render(); compute(true);
    });
    el.addEventListener('input', e => {
        if (!e.target.dataset || e.target.dataset.duo !== 'typed') return;
        S.typed = e.target.value;     // only remembered: the box is never rebuilt, so the cursor stays where the user put it
        if (S.typedNote) { S.typedNote = ''; paint('typed-note', ''); }
    });
    el.addEventListener('keydown', e => {
        if (e.key === 'Enter' && e.target.dataset && e.target.dataset.duo === 'typed') { e.preventDefault(); applyTyped(); }
    });
    el.addEventListener('focusout', e => {
        if (e.target.dataset && e.target.dataset.duo === 'typed' && S.typed.trim() && RIOT_ID.test(S.typed.trim())) applyTyped();
    });
    el.addEventListener('click', e => {
        if (e.target.closest && e.target.closest('[data-duo="use"]')) applyTyped();
    });

    async function show() {
        clearInterval(S.timer);
        render();
        await Promise.all([detect(), loadPlayed()]);
        render();
        await compute(true);
        S.timer = setInterval(async () => {
            if (el.style.display === 'none' || DD.currentView() !== 'draft') { clearInterval(S.timer); S.timer = null; return; }
            await detect(); compute(false);
        }, 2500);
    }
    window.DDDuo = { show, state: S, compute, render };
})();
