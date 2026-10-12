// Champion pool planner: the greedy choice on made-up numbers, then the Tier list's "Pool planner" tab
// with a personal pool from the client (3+ games or 20,000+ mastery): only your champions of that role are chosen, gaps and a
// champion to learn are listed, and "All roles" asks for one role.
const H = require('../lib/renderer-harness');
const R = H.results();
// your games: Ahri x4, Syndra x3, Garen x5 (top laner), Zed x1 (too few); mastery: LeBlanc 60k, Lux 5k (too little)
const games = [...Array(4).fill(103), ...Array(3).fill(134), ...Array(5).fill(86), 238].map((c, i) => ({ championId: c, queueId: 420, win: i % 2 === 0, gameId: 5000 + i, role: null }));
const personal = { summoner: { name: 'TestOwner' }, games, mastery: { 7: { level: 7, points: 60000 }, 99: { level: 3, points: 5000 } } };

(async () => {
    try {
        const h = await H.boot({ size: [1400, 900], ipc: { 'get-personal-stats': () => personal } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        // the greedy choice: B is the best blind pick, A answers what B does not, C adds nothing
        const c = await h.ev(`(() => { const r = DDPool.choose({ A: [0.52, 0.48, 0.5], B: [0.47, 0.55, 0.5], C: [0.5, 0.5, 0.5] }, [0.4, 0.4, 0.2], ['A', 'B', 'C']); return { chosen: r.chosen, value: r.value }; })()`);
        R.ok('greedy: best blind pick first, then the one that covers the rest, and no third that adds nothing', c.chosen.join() === 'B,A' && Math.abs(c.value - 0.528) < 1e-9, c);
        await h.waitFor(`Array.isArray(DD.myPool()) && DD.myPool().length >= 4`, 10000);
        R.ok('My pool: 3+ games or 20,000+ mastery', (await h.ev(`DD.myPool().sort().join()`)) === 'Ahri,Garen,Leblanc,Syndra', await h.ev(`DD.myPool()`));

        await h.ev(`DD.showView('tierlist'); 1`);
        await h.waitFor(`!!document.querySelector('#tierlist-root .tl-tab[data-tab="pool"]')`, 8000);
        await h.ev(`document.querySelector('#tierlist-root .tl-tab[data-tab="pool"]').click(); 1`);
        R.ok('"All roles" asks for one role', await h.waitFor(`/Pick a role/.test(document.getElementById('tl-body').textContent)`, 5000));
        await h.ev(`document.querySelector('#tierlist-root .tl-role[data-role="MIDDLE"]').click(); 1`);
        R.ok('Mid: the plan appears', await h.waitFor(`!!document.querySelector('#tl-body .pp-steps')`, 20000), await h.ev(`document.getElementById('tl-body').textContent.slice(0, 300)`));
        const P = await h.ev(`DDPool.plan('MIDDLE').then(p => ({ chosen: p.chosen, pool: p.pool, gaps: p.gaps.length, learn: p.learn && p.learn.champ, value: p.value, blind: p.blind }))`);
        R.ok('only your Mid champions are chosen (Ahri, Syndra, LeBlanc; not Garen or Zed)', P.chosen.length >= 1 && P.chosen.every(x => ['Ahri', 'Syndra', 'Leblanc'].includes(x)) && !P.pool.includes('Garen'), P);
        R.ok('the pool value is at least the best single blind pick', P.value >= Math.max(...Object.values(P.blind)) - 1e-12, P);
        R.ok('a champion to learn that is not already yours', P.learn && !['Ahri', 'Syndra', 'Leblanc'].includes(P.learn), P.learn);
        const text = await h.ev(`document.getElementById('tl-body').textContent`);
        R.ok('the card names your best pick and the lane win rate with the best of them', /Your best (pick|pair|trio) for Mid/.test(text) && /expected win rate in lane matchups/.test(text), text.slice(0, 400));
        const errs = h.logs.filter(l => /Uncaught|TypeError|ReferenceError/.test(l));
        R.ok('no uncaught errors', errs.length === 0, errs);
    } catch (e) { R.ok('test ran', false, String(e && e.stack || e)); }
    R.finish();
})();
