// Time Period "Adaptive": every statistic gets its own patch window (newest first, until its minimum effective games, at most 5
// patches of the season, older patches weighted by the measured drift, buffs / nerfs from the patch notes corrected, reworks and
// unexplained jumps end the window; off-roles keep the current patch alone).
//  - the pure functions on synthetic data (champion windows, corrections, played roles, pair minimums, effective games),
//  - in the real window: the option appears once older patches are saved, the header says so, and the loaded dataset
//    pools a rare pair over three patches and a common one over at most two.
const H = require('../lib/renderer-harness');
const { fixture } = require('../lib/common');
const R = H.results();

const stats = JSON.parse(fixture('data/champion_stats_patch_platplus.json'));
const idb = body => `(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('draftdiff-datasets'); r.onsuccess = () => res(r.result); r.onerror = rej; });
    const put = (store, rec) => new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete = res; tx.onerror = rej; });
    ${body} })()`;

(async () => {
    try {
        const h = await H.boot({ settings: { timePeriod: 'patch', rank: 'platinum_plus' } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50 && !!window.DD && !!DD.adaptive`, 30000);

        // ---------- champion windows ----------
        // effective games of an older patch = q / (q / n + drift(age) + correction variance), q = wr(1 - wr); drift(age) = (0.09 + 0.072 age) pt²
        const c = await h.ev(`(() => {
            const row = (champion, role, games, win_rate) => ({ champion, role, games, win_rate, pick_rate: 0.01, role_frequency: 0.9 });
            const patch = (i, extra) => ({ patch: '16.' + (20 - i), age: i, totalGames: 100000, statsList: [
                row('Rare', 'MIDDLE', 2000, 0.5), row('Rare', 'TOP', 100, 0.5),          // TOP is ~5% of Rare's games: an off-role
                row('Common', 'MIDDLE', 6000, 0.52), ...extra ] });
            const extra = i => [row('Jumpy', 'JUNGLE', 3000, i ? 0.56 : 0.50), row('Nerfed', 'TOP', 1500, i ? 0.505 : 0.49), row('Reworked', 'SUPPORT', 1500, 0.5)];
            const parts = [0, 1, 2].map(i => patch(i, extra(i)));
            const notes = { 'Nerfed': { '16.20': { kind: 'nerf', rework: false } }, 'Reworked': { '16.20': { kind: 'buff', rework: true } } };
            const r = DD.adaptive.championStats(parts, (ch, p) => (notes[ch] ? notes[ch][p] || null : null));
            const get = k => { const [ch, ro] = k.split(','); const s = r.statsList.find(x => x.champion === ch && x.role === ro); return { ...r.windows.get(k), games: s && s.games, wr: s && s.win_rate }; };
            const capped = DD.adaptive.championStats(parts, () => null, 5000);   // with a 5,000-game cap (no longer the default)
            const cs = capped.statsList.find(x => x.champion === 'Common' && x.role === 'MIDDLE');
            return { rare: get('Rare,MIDDLE'), off: get('Rare,TOP'), common: get('Common,MIDDLE'), jumpy: get('Jumpy,JUNGLE'), nerfed: get('Nerfed,TOP'), rework: get('Reworked,SUPPORT'), cappedCommon: cs && cs.window_patches };
        })()`);
        const eff = (g, wr, age, extra = 0) => { const q = wr * (1 - wr); return q / (q / g + (age ? (0.09 + 0.072 * age) * 1e-4 : 0) + extra); };
        R.ok('a rare champion-role pools three patches: 2,000 + 1,771 + 1,685 effective games', c.rare.used === 3 && c.rare.games === Math.round(2000 + eff(2000, 0.5, 1) + eff(2000, 0.5, 2)) && c.rare.played, c.rare);
        R.ok('no minimum: a common one also pools all three, older patches weighted down by drift', c.common.used === 3 && c.common.games === Math.round(6000 + eff(6000, 0.52, 1) + eff(6000, 0.52, 2)), c.common);
        R.ok('a cap can still be passed in: with 5,000 the common one stops at the current patch', c.cappedCommon === 1, c.cappedCommon);
        R.ok('a 6-point jump the notes don\'t explain stops the win-rate window at the current patch (its pairs keep all patches)', c.jumpy.depth === 1 && c.jumpy.used === 1 && Math.abs(c.jumpy.wr - 0.5) < 1e-9 && c.jumpy.pairDepth === 3, c.jumpy);
        R.ok('an off-role (5% of the champion\'s games) keeps the current patch alone', !c.off.played && c.off.depth === 1 && c.off.used === 1 && c.off.games === 100, c.off);
        // nerf in 16.20: jump -1.5 points, prior -0.84 ± 0.86, noise + drift -> shrunk estimate between the two, added to 16.19 and 16.18
        R.ok('a nerf from the notes is corrected, not cut off: all three patches, one correction between the prior and the jump',
            c.nerfed.depth === 3 && c.nerfed.used === 3 && c.nerfed.changes.length === 1 && c.nerfed.changes[0].kind === 'nerf' && c.nerfed.changes[0].patch === '16.20'
            && c.nerfed.changes[0].d < -0.0084 && c.nerfed.changes[0].d > -0.015, c.nerfed);
        R.ok('the corrected older patches pull the win rate toward the nerfed level (below the uncorrected 49.9%)', c.nerfed.wr > 0.49 && c.nerfed.wr < 0.495, c.nerfed.wr);
        R.ok('a rework ends the window, for its pairs too', c.rework.depth === 1 && c.rework.used === 1 && c.rework.pairDepth === 1, c.rework);
        R.ok('an off-role keeps the current patch for its win rate, but its pairs pool every patch', c.off.pairDepth === 3, c.off);

        // ---------- pair windows ----------
        // an older patch's n pair games count n q / (q + n 0.09 pt²): pair deltas showed no drift, so nearly all of them
        const p = await h.ev(`(() => {
            const K = (a, ra, b, rb, rel) => JSON.stringify([a, ra, b, rb, rel]);
            const lane = K('Rare', 'MIDDLE', 'Common', 'MIDDLE', 'enemy'), syn = K('Rare', 'MIDDLE', 'Other', 'JUNGLE', 'teammate'),
                  off = K('Rare', 'TOP', 'Common', 'TOP', 'enemy'), common = K('Common', 'MIDDLE', 'Rare', 'MIDDLE', 'enemy');
            const m = n => new Map([[lane, { win_rate: 0.5, delta2: 0.01 * n, total_games: 600 }], [syn, { win_rate: 0.5, delta2: 0.02, total_games: 600 }],
                [off, { win_rate: 0.5, delta2: 0.03, total_games: 600 }], [common, { win_rate: 0.5, delta2: 0.04, total_games: n === 1 ? 2500 : 10 }]]);
            const cols = [1, 2, 3].map(n => { const x = m(n); return DD.adaptive.toCols(x, x.size); });
            const depth = { 'Rare,MIDDLE': 5, 'Common,MIDDLE': 5, 'Other,JUNGLE': 5, 'Rare,TOP': 1, 'Common,TOP': 5 };
            const out = DD.adaptive.toMap(DD.adaptive.poolCols(cols, [0, 1, 2], (n, r) => depth[n + ',' + r] || 1));
            const capped = DD.adaptive.toMap(DD.adaptive.poolCols(cols, [0, 1, 2], (n, r) => depth[n + ',' + r] || 1, { lane: 1000, pair: 2000 }));
            return { lane: out.get(lane), syn: out.get(syn), off: out.get(off), common: out.get(common), cappedLane: capped.get(lane) };
        })()`);
        const pe = n => n * 0.25 / (0.25 + n * 0.09e-4);
        const E = 600 + 2 * pe(600);
        R.ok('lane matchup: every patch pooled (600 + 587 + 587), delta averaged by effective games', p.lane.patches === 3 && p.lane.total_games === Math.round(E) && Math.abs(p.lane.delta2 - (600 * 0.01 + pe(600) * 0.02 + pe(600) * 0.03) / E) < 1e-12, p.lane);
        R.ok('synergy: all three patches', p.syn.patches === 3 && p.syn.total_games === Math.round(E), p.syn);
        R.ok('a pair whose champion\'s window is cut (depth 1) keeps the current patch', p.off.patches === 1 && p.off.total_games === 600, p.off);
        R.ok('a common lane matchup pools the older patches too', p.common.patches === 3 && p.common.total_games === Math.round(2500 + 2 * pe(10)), p.common);
        R.ok('with a cap (1,000 lane) the lane matchup stops after two patches', p.cappedLane.patches === 2 && p.cappedLane.total_games === Math.round(600 + pe(600)), p.cappedLane);

        // ---------- in the app ----------
        R.ok('no Adaptive option without saved patches', !(await h.ev(`[...document.getElementById('time-period-select').options].some(o => o.value === 'adaptive')`)));
        // a mid pair outside the harness' current-patch table (only in the saved patches), and a lane pair that is in it
        const mids = stats.filter(s => s.role === 'MIDDLE' && s.role_frequency > 0.6);
        const top60 = new Set(stats.slice(0, 60).map(s => s.champion + s.role));
        const rare = mids.filter(s => !top60.has(s.champion + s.role)).slice(0, 2);
        const lane = stats.slice(0, 60).filter(s => s.role === stats[0].role && s.role_frequency > 0.6).slice(0, 2); // both main roles (an off-role keeps one patch)
        const rareKey = JSON.stringify([rare[0].champion, 'MIDDLE', rare[1].champion, 'MIDDLE', 'enemy']);
        const laneKey = JSON.stringify([lane[0].champion, lane[0].role, lane[1].champion, lane[1].role, 'enemy']);
        const saved = { [rareKey]: { win_rate: 0.52, delta2: 0.02, total_games: 700 }, [laneKey]: { win_rate: 0.5, delta2: 0.01, total_games: 5000 } };
        const entry = p => `await put('archive', { key: '${p}|platinum_plus', patch: '${p}', rank: 'platinum_plus', enc: 'raw', stats: new Blob([${JSON.stringify(JSON.stringify(stats))}]),
            matchups: new Blob([${JSON.stringify(JSON.stringify(saved))}]), bytes: 100, totalGames: 120000, savedAt: Date.now(), source: 'scraped', last_updated_utc: new Date(Date.now() - 864e6).toISOString() });`;
        await h.ev(idb(`${entry('16.18')} ${entry('16.17')} return 1;`));
        await h.ev(`window.__before = 1; location.reload(); 1`);
        await h.waitFor(`!window.__before && document.querySelectorAll('.champion-tile').length > 50 && !!window.DD && !!DD.adaptive`, 40000);
        const opt = await h.waitFor(`[...document.getElementById('time-period-select').options].find(o => o.value === 'adaptive')`, 10000);
        const o = await h.ev(`(() => { const x = [...document.getElementById('time-period-select').options].find(o => o.value === 'adaptive'); return { t: x.textContent, title: x.title, group: x.parentElement.label }; })()`);
        R.ok('the option sits under Combined and explains itself', opt && o.group === 'Combined' && /Adaptive/.test(o.t) && /pool every saved patch/.test(o.title) && /16\.17–16\.19/.test(o.title), o);
        await h.ev(`(() => { const s = document.getElementById('time-period-select'); s.value = 'adaptive'; s.dispatchEvent(new Event('change')); return 1; })()`);
        const hdr = await h.waitFor(`/Adaptive · up to patches 16\\.17–16\\.19/.test(document.getElementById('patch-info').textContent)`, 25000);
        R.ok('header: "Adaptive · up to patches 16.17–16.19"', hdr, await h.ev(`document.getElementById('patch-info').textContent`));
        const ds = await h.ev(`(async () => { const d = await DD.adaptive.load('adaptive', 'platinum_plus'); const r = d.matchup_stats.get(${JSON.stringify(rareKey)}), l = d.matchup_stats.get(${JSON.stringify(laneKey)});
            const c = d.champion_ratings.get(${JSON.stringify(rare[0].champion + ',MIDDLE')});
            return { rare: r, lane: l, champ: c && { games: c.games, patches: c.patches }, ref: d.ref_spec || null, info: { adaptive: d.info.adaptive, patches: d.info.patches } }; })()`);
        const e700 = 700 * 0.52 * 0.48 / (0.52 * 0.48 + 700 * 0.09e-4);
        R.ok('the rare pair (saved patches only) pools both: 2 × 683 effective games over 3 patches', ds.rare && ds.rare.total_games === Math.round(2 * e700) && ds.rare.patches === 3, ds.rare);
        R.ok('the common lane pair pools all three patches', ds.lane && ds.lane.total_games >= 1000 && ds.lane.patches === 3, ds.lane);
        R.ok('champion ratings carry their games and window', ds.champ && ds.champ.games > 0 && ds.champ.patches >= 1, ds.champ);
        R.ok('no reference prior for the adaptive period, info lists the patches', ds.ref === null && ds.info.adaptive && JSON.stringify(ds.info.patches) === '["16.19","16.18","16.17"]', ds);
        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.slice(-6));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
