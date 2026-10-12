// desktop-app/pool-planner.js
// Champion pool planner: for one role, which 2-3 of your champions cover the
// lane opponents best, which opponents your pool has no answer to, and which champion would add the most if you learned it.
// Rendered as the "Pool planner" tab of the Tier list view (tierlist.js calls DDPool.render).
//
// Numbers are the draft's own (DD.championData: the same dataset, shrinkage and Exp WR as the recommendations):
//   e(c, o)  = Exp WR of champion c against lane opponent o (c's base WR when the matchup has too few games)
//   w(o)     = how often o is played in the role (its pick rate, normalised over the opponents listed)
//   pool value V(P) = Σ_o w(o) · max_{c in P} e(c, o)       "you see your opponent first and answer with the best of your pool"
//   blind value of c = Σ_o w(o) · e(c, o)                    "you pick first"
// The pool is chosen greedily from your champions (DD.myPool: 3+ games in your history or 20,000+ mastery, played in that role):
// the best blind pick first, then whichever champion raises V the most, up to 3. A gap is an opponent seen in 2%+ of games that
// the chosen pool answers below 49%. The max over a few noisy estimates flatters a pool a little; the shrinkage keeps that small,
// so differences under about half a point are not worth acting on.
(function () {
    'use strict';
    const DD = window.DD;
    if (!DD) return;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const LANE = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', SUPPORT: 'Support' };
    const MAX_POOL = 3, GAP_SHARE = 0.02, GAP_WR = 0.49, MIN_FREQ = 0.1, MIN_PICK = 0.005;
    const pct = (v, d = 1) => (v * 100).toFixed(d) + '%';
    const champ = id => (DD.getChampions() || []).find(c => c.id === id) || null;
    const img = id => { const c = champ(id), v = DD.getLatestPatch && DD.getLatestPatch(); return c && v ? `${DD.ddragonBase}/cdn/${v}/img/champion/${c.image.full}` : ''; };
    const icon = id => `<img class="pp-ico" src="${esc(img(id))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
    const memo = new Map();   // "label|role" -> plan

    // The pure part (tests call it with made-up numbers): vecs = { champ: [e per opponent] }, w = [weights], pool = [champ ids]
    function choose(vecs, w, pool, max = MAX_POOL) {
        const value = P => w.reduce((t, wi, i) => t + wi * Math.max(...P.map(c => vecs[c][i])), 0);
        const chosen = [], steps = [];
        const left = pool.filter(c => vecs[c]);
        while (chosen.length < max && left.length) {
            let best = null, bv = -Infinity;
            for (const c of left) { const v = value([...chosen, c]); if (v > bv + 1e-12) { bv = v; best = c; } }
            if (chosen.length && bv - steps[steps.length - 1].value < 0.0005) break;   // adds under 0.05 pts: not worth a third champion
            chosen.push(best); left.splice(left.indexOf(best), 1); steps.push({ champ: best, value: bv });
        }
        return { chosen, steps, value: chosen.length ? value(chosen) : null, valueOf: value };
    }

    async function plan(role) {
        const tier = DD.tierData ? await DD.tierData() : null;
        if (!tier || tier.error) return { error: (tier && tier.error) || 'No draft data loaded.' };
        const key = `${tier.label}|${tier.games}|${role}`;
        if (memo.has(key)) return memo.get(key);
        const cands = tier.rows.filter(r => r.role === role && r.freq >= MIN_FREQ && r.pick >= MIN_PICK);
        const opps = cands.slice().sort((a, b) => b.pick - a.pick);
        const tot = opps.reduce((t, o) => t + o.pick, 0) || 1;
        const w = opps.map(o => o.pick / tot);
        const vecs = {}, base = {};
        for (const c of cands) {
            const d = await DD.championData(c.champion, role);
            if (!d || !d.roles[role]) continue;
            const b = d.roles[role].wr, by = new Map(d.matchups.map(m => [m.champion, m.exp]));
            base[c.champion] = b;
            vecs[c.champion] = opps.map(o => (o.champion === c.champion ? b : by.has(o.champion) ? by.get(o.champion) : b));
        }
        const mine = DD.myPool ? DD.myPool() : null;
        const poolKnown = Array.isArray(mine);
        const pool = poolKnown ? mine.filter(c => vecs[c]) : [];
        const pick = choose(vecs, w, pool);
        const blind = c => w.reduce((t, wi, i) => t + wi * vecs[c][i], 0);
        // gaps: common opponents the chosen pool answers badly, with the best answer anywhere
        const gaps = [];
        if (pick.chosen.length) opps.forEach((o, i) => {
            if (w[i] < GAP_SHARE) return;
            const bestMine = Math.max(...pick.chosen.map(c => vecs[c][i]));
            if (bestMine >= GAP_WR) return;
            let ans = null; for (const c of Object.keys(vecs)) if (c !== o.champion && (!ans || vecs[c][i] > vecs[ans][i])) ans = c;
            gaps.push({ opp: o.champion, share: w[i], mine: bestMine, answer: ans, answerWr: ans ? vecs[ans][i] : null });
        });
        // the champion that adds the most to your pool (or the best blind pick when the pool is empty)
        let learn = null;
        for (const c of Object.keys(vecs)) {
            if (pick.chosen.includes(c) || pool.includes(c)) continue;
            const gain = pick.chosen.length ? pick.valueOf([...pick.chosen, c]) - pick.value : blind(c) - 0.5;
            if (!learn || gain > learn.gain) learn = { champ: c, gain };
        }
        const out = { role, label: tier.label, poolKnown, pool, chosen: pick.chosen, steps: pick.steps, value: pick.value, blind: Object.fromEntries(pick.chosen.map(c => [c, blind(c)])),
            gaps: gaps.sort((a, b) => b.share - a.share).slice(0, 8), learn, opponents: opps.length };
        memo.clear(); memo.set(key, out);
        return out;
    }

    function html(P) {
        if (P.error) return DD.ui ? DD.ui.error(P.error) : `<div>${esc(P.error)}</div>`;
        const lane = LANE[P.role] || P.role;
        const name = c => esc((champ(c) || {}).name || c);
        let h = `<div class="pp-wrap"><p class="pp-intro">Which of your champions cover the ${esc(lane)} lane best when you see your opponent first, and what is missing. Same numbers as the draft (${esc(P.label)}), ${P.opponents} lane opponents weighted by how often they are played. Edges under about half a point are noise.</p>`;
        if (!P.poolKnown) return h + `<div class="pp-note">Your pool is not known yet: it comes from your games (League client, or a Riot key in Settings) and mastery, like <b>My pool</b> in the draft.</div></div>`;
        if (!P.chosen.length) {
            h += `<div class="pp-note">None of your champions (3+ games or 20,000+ mastery) is played in ${esc(lane)} often enough to plan with.</div>`;
            if (P.learn) h += `<div class="pp-card"><b>Best blind pick to learn for ${esc(lane)}:</b> ${icon(P.learn.champ)} ${name(P.learn.champ)} (${(P.learn.gain * 100 >= 0 ? '+' : '') + (P.learn.gain * 100).toFixed(1)} pts against an average opponent)</div>`;
            return h + '</div>';
        }
        h += `<div class="pp-card"><div class="pp-h">Your best ${P.chosen.length === 1 ? 'pick' : P.chosen.length === 2 ? 'pair' : 'trio'} for ${esc(lane)}</div><div class="pp-steps">`;
        P.steps.forEach((s, i) => {
            const gain = i ? (s.value - P.steps[i - 1].value) * 100 : null;
            h += `<div class="pp-step">${icon(s.champ)}<div><b>${name(s.champ)}</b><span class="pp-m">${i === 0 ? `best blind pick: ${pct(P.blind[s.champ])} against an average opponent` : `answers what the others don't: +${gain.toFixed(1)} pts`}</span></div></div>`;
        });
        h += `</div><div class="pp-m">With the best of them against each opponent: <b>${pct(P.value)}</b> expected win rate in lane matchups.${P.pool.length > P.chosen.length ? ` Your other ${P.pool.length - P.chosen.length} ${esc(lane)} champion${P.pool.length - P.chosen.length === 1 ? '' : 's'} add less than 0.05 pts.` : ''}</div></div>`;
        if (P.gaps.length) {
            h += `<div class="pp-card"><div class="pp-h">Gaps: common opponents your pool answers below 49%</div><table class="pp-t"><thead><tr><th class="l">Opponent</th><th>Seen</th><th>Your best</th><th class="l">Best answer</th></tr></thead><tbody>`;
            h += P.gaps.map(g => `<tr><td class="l">${icon(g.opp)} ${name(g.opp)}</td><td>${pct(g.share)}</td><td class="delta-neg">${pct(g.mine)}</td><td class="l">${g.answer ? `${icon(g.answer)} ${name(g.answer)} <span class="pp-m">${pct(g.answerWr)}</span>` : '–'}</td></tr>`).join('');
            h += '</tbody></table></div>';
        } else h += `<div class="pp-card pp-ok">No gaps: your pool answers every opponent seen in 2%+ of games at 49% or better.</div>`;
        if (P.learn && P.learn.gain > 0.0005) h += `<div class="pp-card"><b>Most useful to learn next:</b> ${icon(P.learn.champ)} ${name(P.learn.champ)} <span class="pp-m">(+${(P.learn.gain * 100).toFixed(1)} pts to your pool's lane win rate)</span></div>`;
        return h + '</div>';
    }

    async function render(el, role) {
        if (!el) return;
        if (!LANE[role]) { el.innerHTML = DD.ui ? DD.ui.empty('Pick a role', 'The pool planner works one role at a time: choose Top, Jungle, Mid, Bot or Support above.') : 'Pick a role.'; return; }
        el.innerHTML = DD.ui ? DD.ui.loading('Working out your pool…') : 'Working…';
        let P;
        try { P = await plan(role); } catch (e) { P = { error: e.message }; }
        if (el.isConnected) el.innerHTML = html(P);
        return P;
    }
    window.DDPool = { plan, render, choose };
})();
