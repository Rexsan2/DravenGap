// desktop-app/premades-view.js
// Premades (view 'premades', #premades-root): the players you queue with most, from your games saved in Profile (profile:played),
// and for each one (profile:duo-history, cached games only, no requests):
//   - your record together, by lane pairing, and the champion pairs you actually played (best first);
//   - untried strong pairs: the draft model's best pairs (DD.duoPairs on an empty board: both champions' strength + their synergy)
//     from your pool and the champions they played with you in that lane, that you two have never played together;
//   - pairs beating / missing the stats: your record in a pair against what the model expects for it, marked only when the gap is
//     beyond the noise of that many games (2 SE);
//   - pair details: a click on any pair row opens a panel with both champions' numbers, the synergy each way, how often the pair
//     is played in the data, your record with it, each one's hardest / easiest lane opponents and the best third champion
//     (DD.duoPairDetail). The portraits themselves open the champion page (app-shell.js).
//   - stack planner (2-5 players): you + up to 4 friends ticked in the list. Each gets the role they play most with you (the
//     assignment with the most games in role; change it with the role menus), your record when all of you played together
//     (profile:group-history), and the best champion combos from everyone's pool (DD.stackCombos: each champion's strength plus
//     the synergy of every two of them), with each player's best picks for this stack. Click a combo for its details.
// Time Period (header): your games together are the ones played in its patches (DD.periodPatches), unless "All my saved games" is
// ticked (settings.premadesAllGames); the model numbers always come from its dataset and Rank, like the draft.
(function () {
    'use strict';
    const DD = window.DD, root = document.getElementById('premades-root');
    const api = window.electronAPI && window.electronAPI.feature;
    if (!DD || !root || !api) return;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const POS_ROLE = { TOP: 'TOP', JUNGLE: 'JUNGLE', MIDDLE: 'MIDDLE', BOTTOM: 'BOTTOM', UTILITY: 'SUPPORT' };
    const ROLE_POS = { TOP: 'TOP', JUNGLE: 'JUNGLE', MIDDLE: 'MIDDLE', BOTTOM: 'BOTTOM', SUPPORT: 'UTILITY' };
    const ROLE_LABEL = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', SUPPORT: 'Support' };
    const ROLES = Object.keys(ROLE_LABEL);
    const S = { owner: null, list: null, err: null, loading: false, sel: null, hist: {}, model: {}, stack: new Set(), seq: 0, allGames: false,
        roles: {}, poolMode: 'played', plan: null, group: null, detail: null };
    // the patches your games must be from (null = every saved game)
    const period = () => (S.allGames || !DD.periodPatches ? null : DD.periodPatches());
    const patchesArg = () => { const p = period(); return p ? p.patches : null; };
    const keyOf = f => `${String(f.name).toLowerCase()}#${String(f.tag).toLowerCase()}`;
    const champs = () => DD.getChampions() || [];
    const byKey = k => champs().find(c => Number(c.key) === Number(k)) || null;
    const byId = id => champs().find(c => c.id === id) || null;
    const nameOf = id => (byId(id) || {}).name || id;
    const img = id => { const c = byId(id), v = DD.getLatestPatch && DD.getLatestPatch(); return c && v ? `${DD.ddragonBase}/cdn/${v}/img/champion/${c.image.full}` : ''; };
    // a portrait; with a role, a click opens that champion's page in that role (app-shell.js)
    const ico = (id, cls = 'pm-ico', role = '') => `<img class="${cls}" src="${esc(img(id))}" alt="" loading="lazy"${role ? ` data-role="${esc(role)}"` : ''} onerror="this.style.visibility='hidden'">`;
    const pct = (v, d = 0) => (v == null || !isFinite(v) ? '–' : (v * 100).toFixed(d) + '%');
    const pts = v => (v == null || !isFinite(v) ? '–' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}`);
    const sgn = v => (v >= 0 ? 'delta-pos' : 'delta-neg');
    const wrCls = (w, n) => (n ? (w / n >= 0.5 ? 'delta-pos' : 'delta-neg') : '');
    const rec = (w, n) => `<b class="${wrCls(w, n)}">${w}-${n - w}</b>`;

    // ------------------------------------------------------------------ data
    async function owner() {
        if (S.owner) return S.owner;
        let fb = null;
        try { const s = await window.electronAPI.getSettings(); if (s && s.profileAccount && s.profileAccount.gameName) fb = s.profileAccount; } catch (e) { /* none */ }
        const r = await api.invoke('profile:owner', fb ? { fallback: fb } : {}).catch(() => null);
        const o = r && r.ok && r.owner;
        if (!o) return null;
        let puuid = o.puuid;
        if (!puuid) { const look = await api.invoke('profile:lookup', { gameName: o.gameName, tagLine: o.tagLine, platform: o.platform }).catch(() => null); puuid = look && look.ok ? look.profile.puuid : null; }
        if (!puuid) return null;
        S.owner = { gameName: o.gameName, tagLine: o.tagLine, platform: o.platform, puuid };
        return S.owner;
    }
    async function load() {
        const seq = ++S.seq;
        S.loading = true; S.err = null; paint();
        try {
            const o = await owner();
            if (!o) throw new Error('No account yet: start the League client once, or set your Riot ID in Settings > Default account (and open your Profile so your games are saved).');
            const r = await api.invoke('profile:played', { puuid: o.puuid, platform: o.platform, group: 'all', patches: patchesArg() });
            if (!r || !r.ok) throw new Error((r && r.error) || 'Could not read your games.');
            if (seq !== S.seq) return;
            S.list = r.list || [];
            S.scanned = r.scanned || 0;
            S.periodKey = periodKey();
            if (!S.sel && S.list.length) S.sel = keyOf(S.list[0]);
            for (const k of [...S.stack]) if (!S.list.some(f => keyOf(f) === k)) S.stack.delete(k);   // not in this period's list
        } catch (e) { S.err = String(e.message || e).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''); }
        S.loading = false; paint();
        const f = selected();
        if (f) loadFriend(f);
        for (const k of S.stack) { const g = S.list && S.list.find(x => keyOf(x) === k); if (g) loadFriend(g, true); }
    }
    const selected = () => (S.list || []).find(f => keyOf(f) === S.sel) || null;
    async function loadFriend(f, quiet) {
        const k = keyOf(f);
        if (S.hist[k]) { if (!quiet) computeModel(f); return; }
        S.hist[k] = { loading: true }; if (!quiet) paint();
        const r = await api.invoke('profile:duo-history', { owner: { puuid: S.owner.puuid }, partner: { gameName: f.name, tagLine: f.tag }, patches: patchesArg() }).catch(e => ({ ok: false, error: e.message }));
        S.hist[k] = r;
        paint();
        if (!quiet) computeModel(f);
    }
    // Summoner's Rift lane pairings with you, most played first
    const lanesOf = h => (h && h.ok ? h.lanes.filter(l => POS_ROLE[l.myPos] && POS_ROLE[l.theirPos] && l.myPos !== l.theirPos) : []);
    async function computeModel(f) {
        const k = keyOf(f), h = S.hist[k];
        const lane = lanesOf(h)[0];
        if (!lane || !DD.duoPairs) { S.model[k] = { none: true }; paint(); return; }
        const roleA = POS_ROLE[lane.myPos], roleB = POS_ROLE[lane.theirPos];
        const mk = `${k}|${roleA}|${roleB}`;
        if (S.model[k] && S.model[k].key === mk) return;
        S.model[k] = { key: mk, loading: true }; paint();
        const theirs = Object.keys((h.partnerChamps || {})[lane.theirPos] || {}).map(byKey).filter(Boolean).map(c => c.id);
        const mine = [...new Set([...(DD.myPool && DD.myPool() || []), ...h.pairs.filter(p => p.myPos === lane.myPos).map(p => (byKey(p.mine) || {}).id).filter(Boolean)])];
        let res = null;
        try { res = await DD.duoPairs({ roleA, roleB, poolA: mine.length ? mine : null, poolB: theirs.length ? theirs : null, perSide: 15, limit: 400, blank: true }); } catch (e) { res = { error: e.message }; }
        S.model[k] = { key: mk, roleA, roleB, lane, res, theirs, mine };
        paint();
    }

    // ------------------------------------------------------------------ paint
    function paint() {
        if (DD.currentView && DD.currentView() !== 'premades' && root.firstChild) return;
        if (!root.firstChild) {
            root.innerHTML = `<div class="pm-wrap"><div class="pm-side" id="pm-side"></div><div class="pm-main" id="pm-main"></div><div class="pm-detail" id="pm-detail" hidden></div></div>`;
            root.addEventListener('click', onClick);
            root.addEventListener('change', onChange);
        }
        root.querySelector('#pm-side').innerHTML = sideHtml();
        const main = root.querySelector('#pm-main'), top = main.scrollTop;
        main.innerHTML = mainHtml();
        main.scrollTop = top;
        paintDetail();
    }
    function sideHtml() {
        const p = period();
        const head = `<div class="pm-h">Premades <span class="pm-m">${S.owner ? esc(S.owner.gameName) : ''}</span></div>
            <div class="pm-period"><span class="pm-m">Your games: <b>${p ? esc(p.label) : 'all saved games'}</b>${p && p.patches.length > 1 ? ` (${esc(p.patches.slice().reverse().join(', '))})` : ''}</span>
            <label class="pm-m" title="Ignore the Time Period for your games together (the champion numbers still follow it)"><input type="checkbox" data-allgames${S.allGames ? ' checked' : ''}> All my saved games</label></div>`;
        if (S.loading && !S.list) return head + '<div class="pm-m">Reading your saved games…</div>';
        if (S.err) return head + `<div class="pm-m">${esc(S.err)}</div>`;
        if (!S.list || !S.list.length) return head + `<div class="pm-m">No one in 2+ of your ${S.scanned || 0} saved games${period() ? ' in this Time Period (pick a longer one, or tick "All my saved games")' : ''}. Open your Profile and use "Load season history" to save more of them.</div>`;
        return head + `<div class="pm-m pm-hint">From your last ${S.scanned} saved games. Tick up to 4 players to plan a 2-5 stack.</div>` + S.list.map(f => {
            const k = keyOf(f);
            return `<div class="pm-friend${k === S.sel ? ' on' : ''}" data-friend="${esc(k)}"><input type="checkbox" data-stack="${esc(k)}"${S.stack.has(k) ? ' checked' : ''} title="Add to the stack planner">
                <span class="pm-fn">${esc(f.name)}<em>#${esc(f.tag)}</em></span><b class="${wrCls(f.w, f.games)}">${f.w}-${f.l}</b><span class="pm-m">${f.games}g</span></div>`;
        }).join('');
    }
    function mainHtml() {
        const f = selected();
        let h = '';
        if (S.stack.size) h += stackHtml();
        if (f) h += friendHtml(f);
        else if (!S.loading && !S.err) h += '<div class="pm-empty">Pick a player on the left.</div>';
        return h;
    }
    // data-pair: "champA|roleA|champB|roleB|you" (you = 1 when A is your champion, so the panel shows your record with it)
    const pairAttr = (a, ra, b, rb, you = true) => `data-pair="${esc(`${a}|${ra}|${b}|${rb}|${you ? 1 : 0}`)}"`;
    function friendHtml(f) {
        const k = keyOf(f), hi = S.hist[k];
        let h = `<div class="pm-title"><h2>${esc(f.name)} <span class="pm-m">#${esc(f.tag)}</span></h2>
            <button class="pm-btn" data-profile="${esc(k)}">Profile ›</button></div>`;
        if (!hi || hi.loading) return h + '<div class="pm-m">Reading your games together…</div>';
        if (!hi.ok) return h + `<div class="pm-m">${esc(hi.error || 'Could not read your games together.')}</div>`;
        h += `<div class="pm-grid"><div class="pm-card"><div class="pm-card-h">Together</div>
            <div class="pm-big ${wrCls(hi.w, hi.games)}">${hi.w}-${hi.games - hi.w}</div><div class="pm-m">${pct(hi.games ? hi.w / hi.games : null)} in ${hi.games} games (all modes)</div>
            ${hi.lanes.filter(l => POS_ROLE[l.myPos] && POS_ROLE[l.theirPos]).slice(0, 5).map(l => `<div class="pm-kv"><span>You ${ROLE_LABEL[POS_ROLE[l.myPos]]} + ${ROLE_LABEL[POS_ROLE[l.theirPos]]}</span><b class="${wrCls(l.w, l.games)}">${l.w}-${l.games - l.w}</b></div>`).join('')}</div>`;
        const played = hi.pairs.filter(p => POS_ROLE[p.myPos] && POS_ROLE[p.theirPos] && p.myPos !== p.theirPos);
        h += `<div class="pm-card"><div class="pm-card-h">Your pairs <span class="pm-m">most played · click for details</span></div>${played.slice(0, 8).map(p => {
            const a = byKey(p.mine), b = byKey(p.theirs), ra = POS_ROLE[p.myPos], rb = POS_ROLE[p.theirPos];
            return a && b ? `<div class="pm-pair pm-click" ${pairAttr(a.id, ra, b.id, rb)}>${ico(a.id, undefined, ra)}${ico(b.id, undefined, rb)}<span>${esc(a.name)} + ${esc(b.name)} <span class="pm-m">${ROLE_LABEL[ra]} + ${ROLE_LABEL[rb]}</span></span><b class="${wrCls(p.w, p.games)}">${p.w}-${p.games - p.w}</b></div>` : '';
        }).join('') || '<div class="pm-m">No Summoner\'s Rift games together.</div>'}</div></div>`;
        h += modelHtml(f, played);
        return h;
    }
    function modelHtml(f, played) {
        const k = keyOf(f), m = S.model[k];
        if (!m || m.loading) return '<div class="pm-m">Working out your best pairs…</div>';
        if (m.none) return '<div class="pm-m">No Summoner\'s Rift lane pairing with this player yet, so there is nothing to compare.</div>';
        if (!m.res || m.res.error) return `<div class="pm-m">${esc((m.res && m.res.error) || 'The draft data is not loaded yet.')}</div>`;
        const ra = ROLE_LABEL[m.roleA], rb = ROLE_LABEL[m.roleB];
        const playedSet = new Set(played.filter(p => p.myPos === m.lane.myPos && p.theirPos === m.lane.theirPos).map(p => `${(byKey(p.mine) || {}).id}|${(byKey(p.theirs) || {}).id}`));
        const untried = m.res.pairs.filter(p => !playedSet.has(`${p.a}|${p.b}`)).slice(0, 6);
        const row = (p, extra = '') => `<div class="pm-pair pm-click" ${pairAttr(p.a, m.roleA, p.b, m.roleB)}>${ico(p.a, undefined, m.roleA)}${ico(p.b, undefined, m.roleB)}<span>${esc(p.aName)} + ${esc(p.bName)}</span>
            <b class="${sgn(p.edge)}" title="Both champions' strength plus their synergy, in win-rate points">${pts(p.edge)}</b><span class="pm-m">synergy ${pts(p.syn)}</span>${extra}</div>`;
        // pairs you played 3+ times in this lane pairing: record vs the model's expectation
        const model = new Map(m.res.pairs.map(p => [`${p.a}|${p.b}`, p]));
        const perf = played.filter(p => p.games >= 3 && p.myPos === m.lane.myPos && p.theirPos === m.lane.theirPos).map(p => {
            const a = byKey(p.mine), b = byKey(p.theirs), x = a && b && model.get(`${a.id}|${b.id}`);
            if (!x) return null;
            const exp = Math.min(0.85, Math.max(0.15, 0.5 + x.edge)), wr = p.w / p.games, se = Math.sqrt(exp * (1 - exp) / p.games);
            return { ...x, games: p.games, w: p.w, wr, exp, gap: wr - exp, real: Math.abs(wr - exp) > 2 * se };
        }).filter(Boolean).sort((x, y) => y.gap - x.gap);
        return `<div class="pm-grid">
            <div class="pm-card pm-wide"><div class="pm-card-h">Untried strong pairs ${DD.help ? DD.help('pair-edge') : ''} <span class="pm-m">you ${esc(ra)} + ${esc(f.name)} ${esc(rb)}, never played together</span></div>
                ${untried.map(p => row(p)).join('') || '<div class="pm-m">Every strong pair from both pools has been played already.</div>'}
                <div class="pm-m pm-foot">Your pool: ${m.mine.length ? `${m.mine.length} champions (My pool + what you played together)` : 'everyone'} · theirs: ${m.theirs.length ? `the ${m.theirs.length} champions they played as ${esc(rb)} with you` : 'everyone'} · ${esc(m.res.label)}. Click a pair for its details, a picture for that champion's page.</div></div>
            <div class="pm-card pm-wide"><div class="pm-card-h">Beating or missing the stats <span class="pm-m">pairs you played 3+ times</span></div>
                ${perf.map(p => `<div class="pm-pair pm-click" ${pairAttr(p.a, m.roleA, p.b, m.roleB)}>${ico(p.a, undefined, m.roleA)}${ico(p.b, undefined, m.roleB)}<span>${esc(p.aName)} + ${esc(p.bName)}</span><b class="${wrCls(p.w, p.games)}">${p.w}-${p.games - p.w}</b>
                    <span class="pm-m">expected ${pct(p.exp)} · </span><b class="${p.real ? sgn(p.gap) : 'pm-m'}">${pts(p.gap)}${p.real ? (p.gap > 0 ? ' beats the stats' : ' below the stats') : ' (within noise)'}</b></div>`).join('')
                    || '<div class="pm-m">No pair played 3+ times in this lane pairing yet.</div>'}
                <div class="pm-m pm-foot">Expected = 50% + both champions' strength + their synergy. Marked only when your record is more than twice its noise away from it.</div></div></div>`;
    }

    // ------------------------------------------------------------------ stack planner (2-5 players)
    // the players: you first, then the ticked friends (in list order); each with the roles / champions they played in your games
    function stackPeople() {
        const friends = (S.list || []).filter(f => S.stack.has(keyOf(f))).slice(0, 4);
        const you = { key: 'me', name: S.owner ? S.owner.gameName : 'You', you: true, roles: {}, champs: {} };
        const people = [you];
        for (const f of friends) {
            const hi = S.hist[keyOf(f)];
            if (!hi || !hi.ok) return { waiting: f, error: hi && !hi.loading && !hi.ok ? hi.error : null };
            const p = { key: keyOf(f), name: f.name, tag: f.tag, roles: {}, champs: {} };
            for (const [pos, cs] of Object.entries(hi.partnerChamps || {})) {
                const r = POS_ROLE[pos]; if (!r) continue;
                for (const [ck, n] of Object.entries(cs)) { p.roles[r] = (p.roles[r] || 0) + n; const c = byKey(ck); if (c) (p.champs[r] = p.champs[r] || {})[c.id] = n; }
            }
            for (const pr of hi.pairs) {   // your own lanes and champions from the same games
                const r = POS_ROLE[pr.myPos], c = byKey(pr.mine); if (!r) continue;
                you.roles[r] = (you.roles[r] || 0) + pr.games;
                if (c) (you.champs[r] = you.champs[r] || {})[c.id] = (you.champs[r][c.id] || 0) + pr.games;
            }
            people.push(p);
        }
        // roles: the ones you set, then the assignment with the most games in role for the rest (log-weighted so one big count
        // doesn't swamp the others)
        const fixed = {};
        for (const p of people) if (S.roles[p.key] && !Object.values(fixed).includes(S.roles[p.key])) fixed[p.key] = S.roles[p.key];
        let best = null;
        const perm = (i, used, acc, score) => {
            if (i === people.length) { if (!best || score > best.score) best = { roles: acc.slice(), score }; return; }
            const p = people[i], opts = fixed[p.key] ? [fixed[p.key]] : ROLES;
            for (const r of opts) if (!used.has(r)) { used.add(r); acc.push(r); perm(i + 1, used, acc, score + Math.log(1 + (p.roles[r] || 0))); acc.pop(); used.delete(r); }
        };
        perm(0, new Set(), [], 0);
        people.forEach((p, i) => { p.role = best.roles[i]; p.set = !!fixed[p.key]; });
        return { people };
    }
    const poolOf = p => {
        if (S.poolMode === 'any') return null;
        const played = Object.keys(p.champs[p.role] || {});
        return p.you ? [...new Set([...(DD.myPool && DD.myPool() || []), ...played])] : played;
    };
    const planKey = people => [people.map(p => `${p.key}:${p.role}`).join(','), S.poolMode, periodKey(), (DD.myPool && DD.myPool() || []).length].join('|');
    async function computePlan(people) {
        const key = planKey(people);
        if (S.plan && S.plan.key === key) return;
        S.plan = { key, loading: true };
        const gk = [people.map(p => p.key).join(','), patchesArg() ? patchesArg().join(',') : 'all'].join('|');
        if (!S.group || S.group.key !== gk) {
            S.group = { key: gk, loading: true };
            api.invoke('profile:group-history', { owner: { puuid: S.owner.puuid }, partners: people.slice(1).map(p => ({ gameName: p.name, tagLine: p.tag })), patches: patchesArg() })
                .catch(e => ({ ok: false, error: e.message })).then(r => { if (S.group && S.group.key === gk) { S.group = { key: gk, res: r }; paint(); } });
        }
        let res = null;
        try { res = DD.stackCombos ? await DD.stackCombos({ slots: people.map(p => ({ role: p.role, pool: poolOf(p) })), limit: 8 }) : null; } catch (e) { res = { error: e.message }; }
        if (S.plan && S.plan.key === key) { S.plan = { key, res, people: people.map(p => ({ key: p.key, name: p.name, role: p.role, you: !!p.you })) }; paint(); }
    }
    // your record when all of these players were on your team with exactly these champions (ignoring lanes)
    function groupRecord(champIds) {
        const g = S.group && S.group.res;
        if (!g || !g.ok) return null;
        const want = champIds.join('|');
        let games = 0, w = 0;
        for (const c of g.combos) if (c.champs.map(k => (byKey(k) || {}).id).join('|') === want) { games += c.games; w += c.w; }
        return games ? { games, w } : null;
    }
    function stackHtml() {
        const st = stackPeople();
        const n = S.stack.size + 1, title = `${n}-stack planner`;
        if (st.waiting) {
            if (!st.error && !S.hist[keyOf(st.waiting)]) loadFriend(st.waiting, true);
            return `<div class="pm-card pm-wide"><div class="pm-card-h">${title}</div><div class="pm-m">${st.error ? esc(st.error) : `Reading games with ${esc(st.waiting.name)}…`}</div></div>`;
        }
        const people = st.people;
        if (!S.plan || S.plan.key !== planKey(people)) setTimeout(() => computePlan(people), 0);
        const plan = S.plan && S.plan.key === planKey(people) ? S.plan : null;
        const roleSel = p => `<select class="pm-rsel" data-role-for="${esc(p.key)}" title="${p.set ? 'Role you set' : 'Role they play most with you'}">${ROLES.map(r => `<option value="${r}"${r === p.role ? ' selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>`;
        // who plays where, their most played champions there, and their best picks for this stack
        const rows = people.map((p, i) => {
            const top = Object.entries(p.champs[p.role] || {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
            const slot = plan && plan.res && plan.res.slots ? plan.res.slots[i] : null;
            const picks = slot ? slot.candidates.filter(c => c.best != null).slice(0, 5) : [];
            const open = (plan && plan.res && plan.res.open && plan.res.open.includes(i)) || (S.poolMode === 'played' && !p.you && !top.length);
            return `<div class="pm-stack-row"><b>${esc(p.name)}${p.you ? ' <span class="pm-m">(you)</span>' : ''}</b>${roleSel(p)}
                <span class="pm-m">${p.roles[p.role] || 0} games there</span>
                <span class="pm-stack-champs" title="Most played there in your games together">${top.map(([id, k]) => `<span title="${esc(nameOf(id))}: ${k} games">${ico(id, undefined, p.role)}</span>`).join('') || '<span class="pm-m">no games here together</span>'}</span>
                <span class="pm-best">${picks.length ? `<span class="pm-m">best for this stack${open ? ' (from anyone: no games here)' : ''}:</span> ${picks.map(c => `<span class="pm-bp" title="${esc(c.name)}: Exp WR ${pct(c.exp, 1)}, best combo with it ${pts(c.best)}">${ico(c.id, undefined, p.role)}<em class="${sgn(c.best)}">${pts(c.best)}</em></span>`).join('')}` : ''}</span></div>`;
        }).join('');
        // your record with all of them
        const g = S.group && S.group.res;
        const together = !g ? '<span class="pm-m">Reading your games together…</span>' : !g.ok ? `<span class="pm-m">${esc(g.error || 'Could not read your games together.')}</span>`
            : g.games ? `<span>All ${n} of you together: ${rec(g.w, g.games)} <span class="pm-m">${pct(g.w / g.games)} in ${g.games} games${g.lineups[0] && g.lineups[0].pos.every(x => POS_ROLE[x]) ? ` · most as ${g.lineups[0].pos.map(x => ROLE_LABEL[POS_ROLE[x]]).join(' / ')}` : ''}</span></span>`
                : `<span class="pm-m">No saved game with all ${n} of you on one team${period() ? ' in this Time Period' : ''}.</span>`;
        let combos = '';
        if (!plan || plan.loading) combos = '<div class="pm-m">Working out the best combos…</div>';
        else if (!plan.res || plan.res.error) combos = `<div class="pm-m">${esc((plan.res && plan.res.error) || 'The draft data is not loaded yet.')}</div>`;
        else if (!plan.res.combos.length) combos = '<div class="pm-m">No combo found for these roles.</div>';
        else combos = plan.res.combos.map((c, ci) => {
            const r = groupRecord(c.champs);
            return `<div class="pm-pair pm-click pm-combo" data-combo="${ci}">${c.champs.map((id, i) => ico(id, undefined, plan.people[i].role)).join('')}<span>${c.names.map(esc).join(' + ')}</span>
                <b class="${sgn(c.edge)}" title="Every champion's strength plus the synergy of every two of them, in win-rate points">${pts(c.edge)}</b><span class="pm-m">synergy ${pts(c.syn)}</span>${r ? `<span class="pm-m">you: </span>${rec(r.w, r.games)}` : ''}</div>`;
        }).join('');
        // the combos you actually played together
        const playedCombos = g && g.ok ? g.combos.filter(c => c.pos.every(x => POS_ROLE[x])).slice(0, 5) : [];
        const playedHtml = playedCombos.length ? `<div class="pm-sub">Most played together</div>${playedCombos.map((c, ci) => `<div class="pm-pair pm-click" data-played="${ci}">${c.champs.map((k, i) => { const ch = byKey(k); return ch ? ico(ch.id, undefined, POS_ROLE[c.pos[i]]) : ''; }).join('')}
            <span>${c.champs.map(k => esc((byKey(k) || {}).name || k)).join(' + ')}</span>${rec(c.w, c.games)}</div>`).join('')}` : '';
        return `<div class="pm-card pm-wide pm-stack"><div class="pm-card-h">${title} ${DD.help ? DD.help('pair-edge') : ''} <span class="pm-m">${n} players</span>
                <span class="pm-pool"><label class="pm-m"><input type="radio" name="pm-pool" value="played"${S.poolMode === 'played' ? ' checked' : ''}> Champions we played</label>
                <label class="pm-m"><input type="radio" name="pm-pool" value="any"${S.poolMode === 'any' ? ' checked' : ''}> Anyone</label></span></div>
            ${rows}<div class="pm-together">${together}</div>
            <div class="pm-sub">Best combos <span class="pm-m">${plan && plan.res && plan.res.label ? esc(plan.res.label) : ''} · click one for details</span></div>${combos}${playedHtml}
            <div class="pm-m pm-foot">Roles: what each player plays most with you (change them with the menus). Pools: ${S.poolMode === 'any' ? 'everyone played 5%+ in that role' : 'your My pool + what you played there together, and what each friend played there with you'}.
                Combo value = every champion's strength + the synergy of every two of them, in win-rate points, on an empty board (the enemy team is unknown).</div></div>`;
    }

    // ------------------------------------------------------------------ details panel (pair or combo)
    async function openPair(a, ra, b, rb, you = true) {
        S.detail = { kind: 'pair', a, ra, b, rb, you, loading: true };
        paintDetail();
        let res = null;
        try { res = DD.duoPairDetail ? await DD.duoPairDetail({ a, roleA: ra, b, roleB: rb }) : null; } catch (e) { res = { error: e.message }; }
        if (S.detail && S.detail.kind === 'pair' && S.detail.a === a && S.detail.b === b) { S.detail = { kind: 'pair', a, ra, b, rb, you, res }; paintDetail(); }
    }
    function closeDetail() { S.detail = null; paintDetail(); }
    function paintDetail() {
        const el = root.querySelector('#pm-detail');
        if (!el) return;
        if (!S.detail) { el.hidden = true; el.innerHTML = ''; return; }
        el.hidden = false;
        el.innerHTML = `<button class="pm-x" data-close title="Close (Esc)">×</button>` + (S.detail.kind === 'loading' ? '<div class="pm-m">Reading the numbers…</div>'
            : S.detail.kind === 'pair' ? pairDetailHtml(S.detail) : comboDetailHtml(S.detail));
    }
    // your record with this pair: with the selected friend (or anyone ticked) when you were A in roleA and they were B in roleB
    function yourPairRecord(d) {
        const ka = (byId(d.a) || {}).key, kb = (byId(d.b) || {}).key, pa = ROLE_POS[d.ra], pb = ROLE_POS[d.rb];
        const out = [];
        for (const f of S.list || []) {
            const h = S.hist[keyOf(f)];
            if (!h || !h.ok) continue;
            let games = 0, w = 0, onA = { games: 0, w: 0 }, onB = 0;
            for (const p of h.pairs) {
                if (p.myPos === pa && Number(p.mine) === Number(ka)) { onA.games += p.games; onA.w += p.w; }
                if (p.theirPos === pb && Number(p.theirs) === Number(kb)) onB += p.games;
                if (p.myPos === pa && p.theirPos === pb && Number(p.mine) === Number(ka) && Number(p.theirs) === Number(kb)) { games += p.games; w += p.w; }
            }
            if (games || keyOf(f) === S.sel) out.push({ name: f.name, games, w, onA, onB });
        }
        return out;
    }
    function pairDetailHtml(d) {
        const head = `<div class="pm-dh">${ico(d.a, 'pm-dico', d.ra)}${ico(d.b, 'pm-dico', d.rb)}<div><b>${esc(nameOf(d.a))} + ${esc(nameOf(d.b))}</b><div class="pm-m">${ROLE_LABEL[d.ra]} + ${ROLE_LABEL[d.rb]}</div></div></div>`;
        if (d.loading) return head + '<div class="pm-m">Reading the numbers…</div>';
        const r = d.res;
        if (!r || r.error) return head + `<div class="pm-m">${esc((r && r.error) || 'The draft data is not loaded yet.')}</div>`;
        const champRow = c => `<tr><td>${ico(c.id, 'pm-ico', c.role)} ${esc(c.name)}</td><td>${pct(c.exp, 1)}</td><td>${pct(c.base, 1)}</td><td>${(c.games || 0).toLocaleString()}</td><td>${pct(c.pick, 1)}</td></tr>`;
        const dir = (x, from, to) => x ? `<div class="pm-kv"><span>${esc(from)} with ${esc(to)}</span><span><b class="${sgn(x.mean)}">${pts(x.mean)}</b> <span class="pm-m">(raw ${pts(x.raw)}, ${x.games.toLocaleString()} games)</span></span></div>` : `<div class="pm-kv"><span>${esc(from)} with ${esc(to)}</span><span class="pm-m">no games in the data</span></div>`;
        const lane = c => `<div class="pm-lane"><div class="pm-m">${esc(c.name)} in lane</div>
            <div><span class="pm-m">hardest:</span> ${c.worst.map(x => `<span class="pm-lc" title="${esc(x.name)}: ${pts(x.mean)} (${x.games} games)">${ico(x.champion, 'pm-ico', c.role)}<em class="${sgn(x.mean)}">${pts(x.mean)}</em></span>`).join('') || '<span class="pm-m">–</span>'}</div>
            <div><span class="pm-m">easiest:</span> ${c.best.map(x => `<span class="pm-lc" title="${esc(x.name)}: ${pts(x.mean)} (${x.games} games)">${ico(x.champion, 'pm-ico', c.role)}<em class="${sgn(x.mean)}">${pts(x.mean)}</em></span>`).join('') || '<span class="pm-m">–</span>'}</div></div>`;
        const mine = yourPairRecord(d);
        const you = mine.length ? mine.map(m => `<div class="pm-kv"><span>With ${esc(m.name)}</span><span>${m.games ? `${rec(m.w, m.games)} <span class="pm-m">on this pair</span>` : '<span class="pm-m">never on this pair</span>'}
                <span class="pm-m"> · you on ${esc(nameOf(d.a))}: ${m.onA.games ? `${m.onA.w}-${m.onA.games - m.onA.w}` : '0 games'} · they on ${esc(nameOf(d.b))}: ${m.onB} games</span></span></div>`).join('')
            : '<div class="pm-m">No saved games with this pair.</div>';
        const exp = r.edge != null ? Math.min(0.85, Math.max(0.15, 0.5 + r.edge)) : null;
        return head + `<div class="pm-dsum"><div><div class="pm-big ${sgn(r.edge || 0)}">${pts(r.edge)}</div><div class="pm-m">pair edge ${DD.help ? DD.help('pair-edge') : ''} · about ${pct(exp)} with an average rest of team</div></div>
                <div><div class="pm-big ${sgn(r.syn.mean)}">${pts(r.syn.mean)}</div><div class="pm-m">synergy${r.syn.pp != null ? ` · ${pct(r.syn.pp)} sure it helps` : ''}</div></div></div>
            <table class="pm-tab"><tr><th></th><th>Exp WR</th><th>Win rate</th><th>Games</th><th>Pick</th></tr>${champRow(r.a)}${champRow(r.b)}</table>
            <div class="pm-sub">Synergy each way</div>${dir(r.syn.ab, r.a.name, r.b.name)}${dir(r.syn.ba, r.b.name, r.a.name)}
            <div class="pm-kv"><span>Played together in the data</span><span>${r.pair ? `${r.pair.games.toLocaleString()} games · ${pct(r.pair.wr, 1)}` : '<span class="pm-m">not seen</span>'}</span></div>
            ${d.you ? `<div class="pm-sub">You</div>${you}` : ''}
            <div class="pm-sub">Lane matchups</div>${lane(r.a)}${lane(r.b)}
            <div class="pm-sub">Best third <span class="pm-m">synergy with both, other roles</span></div>
            ${r.thirds.map(t => `<div class="pm-pair"><span>${ico(t.champion, 'pm-ico', t.role)}</span><span>${esc(t.name)} <span class="pm-m">${ROLE_LABEL[t.role]}</span></span><b class="${sgn(t.syn)}">${pts(t.syn)}</b><span class="pm-m">${pts(t.withA)} / ${pts(t.withB)}</span></div>`).join('') || '<div class="pm-m">Not enough games.</div>'}
            <div class="pm-m pm-foot">${esc(r.label)}. Exp WR: each champion on an empty board. Pair edge = both champions' strength + synergy (synergy = half of each direction, adjusted for sample size). Click a picture for that champion's page.</div>`;
    }
    function comboDetailHtml(d) {
        const c = d.combo, people = d.people;
        const r = groupRecord(c.champs);
        return `<div class="pm-dh">${c.champs.map((id, i) => ico(id, 'pm-dico', people[i].role)).join('')}</div>
            <div class="pm-dsum"><div><div class="pm-big ${sgn(c.edge)}">${pts(c.edge)}</div><div class="pm-m">combo value · strength ${pts(c.edge - c.syn)} + synergy ${pts(c.syn)}</div></div>
                <div><div class="pm-big ${r ? wrCls(r.w, r.games) : ''}">${r ? `${r.w}-${r.games - r.w}` : '–'}</div><div class="pm-m">${r ? 'your record with exactly these' : 'never played together'}</div></div></div>
            <table class="pm-tab"><tr><th>Player</th><th>Role</th><th>Champion</th><th>Exp WR</th></tr>${c.champs.map((id, i) => `<tr><td>${esc(people[i].name)}</td><td>${ROLE_LABEL[people[i].role]}</td><td>${ico(id, 'pm-ico', people[i].role)} ${esc(c.names[i])}</td><td>${pct(c.exp[i], 1)}</td></tr>`).join('')}</table>
            <div class="pm-sub">Synergy of every two <span class="pm-m">click one for the pair</span></div>
            ${c.pairs.slice().sort((x, y) => y.syn - x.syn).map(p => `<div class="pm-pair pm-click" ${pairAttr(c.champs[p.i], people[p.i].role, c.champs[p.j], people[p.j].role, p.i === 0)}>${ico(c.champs[p.i], undefined, people[p.i].role)}${ico(c.champs[p.j], undefined, people[p.j].role)}
                <span>${esc(c.names[p.i])} + ${esc(c.names[p.j])}</span><b class="${sgn(p.syn)}">${pts(p.syn)}</b><span class="pm-m">${p.games ? `${p.games.toLocaleString()} games` : 'no games'}</span></div>`).join('')}
            <div class="pm-m pm-foot">${esc(d.label || '')}. On an empty board: the enemy team is unknown.</div>`;
    }

    // ------------------------------------------------------------------ events
    function onClick(e) {
        if (e.target.closest('[data-stack], select, input')) return;   // handled in onChange
        if (e.target.closest('[data-close]')) { closeDetail(); return; }
        const fr = e.target.closest('[data-friend]');
        if (fr) { S.sel = fr.dataset.friend; paint(); const f = selected(); if (f) loadFriend(f); return; }
        const pr = e.target.closest('[data-profile]');
        if (pr) { const f = selected(); if (f && window.DDProfile && window.DDProfile.openFromOutside) window.DDProfile.openFromOutside({ gameName: f.name, tagLine: f.tag, platform: S.owner.platform }, 'summary'); return; }
        const pair = e.target.closest('[data-pair]');
        if (pair) { const [a, ra, b, rb, you] = pair.dataset.pair.split('|'); openPair(a, ra, b, rb, you !== '0'); return; }
        const cb = e.target.closest('[data-combo]');
        if (cb && S.plan && S.plan.res && S.plan.res.combos) {
            const c = S.plan.res.combos[Number(cb.dataset.combo)];
            if (c) { S.detail = { kind: 'combo', combo: c, people: S.plan.people, label: S.plan.res.label }; paintDetail(); }
            return;
        }
        const pl = e.target.closest('[data-played]');
        if (pl && S.group && S.group.res && S.group.res.ok) {
            // a combo you played: its numbers from the model (your roles and champions in that game)
            const g = S.group.res.combos[Number(pl.dataset.played)], ids = g && g.champs.map(k => (byKey(k) || {}).id);
            if (!g || ids.some(x => !x)) return;
            const rs = g.pos.map(x => POS_ROLE[x]);
            if (ids.length === 2) { openPair(ids[0], rs[0], ids[1], rs[1]); return; }
            const people = stackPeople().people || [];
            S.detail = { kind: 'loading' };
            paintDetail();
            DD.stackCombos({ slots: ids.map((id, i) => ({ role: rs[i], pool: [id] })), perSide: 1, limit: 1 }).then(res => {
                const c = res && res.combos && res.combos[0];
                S.detail = c ? { kind: 'combo', combo: c, people: rs.map((role, i) => ({ role, name: (people[i] || {}).name || '' })), label: res.label } : null;
                paintDetail();
            }).catch(() => closeDetail());
        }
    }
    function reset() { S.list = null; S.hist = {}; S.model = {}; S.plan = null; S.group = null; S.seq++; }
    function onChange(e) {
        const t = e.target, ds = t.dataset || {};
        if (ds.allgames !== undefined) {
            S.allGames = t.checked;
            DD.patchSettings({ premadesAllGames: S.allGames }).catch(() => {});
            reset(); load(); return;
        }
        if (t.name === 'pm-pool') { S.poolMode = t.value === 'any' ? 'any' : 'played'; paint(); return; }
        if (ds.roleFor) {
            // a role you set; whoever had it takes this player's old role
            const st = stackPeople();
            if (st.people) {
                const me = st.people.find(p => p.key === ds.roleFor), other = st.people.find(p => p.key !== ds.roleFor && p.role === t.value);
                if (other && me) S.roles[other.key] = me.role;
            }
            S.roles[ds.roleFor] = t.value;
            paint(); return;
        }
        const k = ds.stack;
        if (!k) return;
        if (t.checked) { if (S.stack.size >= 4) { t.checked = false; DD.toast && DD.toast('A stack is at most 5: you + 4.'); return; } S.stack.add(k); } else { S.stack.delete(k); delete S.roles[k]; }
        const f = (S.list || []).find(x => keyOf(x) === k);
        if (f && t.checked) loadFriend(f, true);
        paint();
    }
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.detail && DD.currentView() === 'premades') closeDetail(); });
    DD.onView((name, prev) => { if (name === 'premades' && prev !== 'premades') { if (!S.list || S.err || S.periodKey !== periodKey()) load(); else paint(); } });
    // Time Period / Rank changed: your games together and the model numbers are read again (now, or when the view is next shown)
    const periodKey = () => { const p = period(); return [p ? p.patches.join(',') : 'all', document.getElementById('time-period-select') && document.getElementById('time-period-select').value, document.getElementById('rank-select') && document.getElementById('rank-select').value].join('|'); };
    for (const id of ['time-period-select', 'rank-select']) {
        const sel = document.getElementById(id);
        if (sel) sel.addEventListener('change', () => { if (sel.value === 'range-pick') return; reset(); S.detail = null; if (DD.currentView() === 'premades') setTimeout(load, 0); });
    }
    (async () => { try { const s = await window.electronAPI.getSettings(); S.allGames = !!(s && s.premadesAllGames); } catch (e) { /* default: follow the Time Period */ } })();
    window.DDPremades = { reload: () => { S.owner = null; reset(); return load(); }, state: S, openPair };
})();
