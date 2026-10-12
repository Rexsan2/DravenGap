// Goals: on your own profile's Insights, CS / min, deaths / 10 and vision / min for your main role, today,
// last 7 days and the season, from the saved games (Summoner's Rift only), against a target you can type (saved in settings.goals).
const H = require('../lib/renderer-harness');
const R = H.results();
const PU = 'P'.padEnd(78, 'x');
const DAY = 864e5, now = Date.now();
// 12 Mid games this season: 10 CS/min, 2 deaths / 10 min, 1 vision / min; 2 of them today (better: 12 CS/min). 6 Top games, 3 Arena games.
const row = (i, o) => ({ id: 'EUW1_' + i, q: 420, c: 103, w: 1, k: 5, d: 4, a: 6, cs: 200, dur: 1200, end: now - (i + 1) * 3 * DAY, pos: 'MIDDLE', vis: 20, kp: 50, rm: 0, ...o });
const rows = [
    ...Array.from({ length: 10 }, (_, i) => row(i)),
    row(100, { end: now - 3600e3, cs: 240 }), row(101, { end: now - 7200e3, cs: 240 }),
    ...Array.from({ length: 6 }, (_, i) => row(200 + i, { pos: 'TOP', end: now - 50 * DAY })),
    ...Array.from({ length: 3 }, (_, i) => row(300 + i, { q: 1700, pos: '', cs: 0, end: now - 3600e3 }))
];

(async () => {
    try {
        const h = await H.boot({ ipc: {
            'profile:owner': () => ({ ok: true, owner: { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1', puuid: PU }, source: 'client' }),
            'profile:lookup': (e, a) => ({ ok: true, profile: { puuid: PU, gameName: a.gameName, tagLine: a.tagLine, platform: 'EUW1', isOwner: true, summonerLevel: 100, profileIconId: 29, ranked: [], mastery: [] } }),
            'profile:matches': (e, a) => ({ ok: true, puuid: a.puuid, group: a.group, start: 0, nextStart: 0, hasMore: false, matches: [] }),
            'profile:ledger': () => ({ ok: true, rows, total: rows.length }),
            'profile:insights': (e, a) => ({ ok: true, n: 0, scanned: 0, group: a.group })
        } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        await h.ev(`DD.showView('profile'); 1`);
        await h.waitFor(`!!DDProfile.state.profile && !!DDProfile.state.ledger`, 10000);
        await h.ev(`DDProfile.showTab('insights'); 1`);
        R.ok('the Goals card shows on your own profile', await h.waitFor(`!!document.querySelector('#profile-root .pf-goals')`, 5000));
        const read = () => h.ev(`[...document.querySelectorAll('#profile-root .pf-goals tbody tr')].map(tr => [...tr.children].map(td => { const i = td.querySelector('input'); return i ? 'goal:' + i.value : td.textContent.trim() + (td.className ? '|' + td.className : ''); }))`);
        let t = await read();
        const head = await h.ev(`document.querySelector('#profile-root .pf-goals').textContent`);
        R.ok('main role = the most played in the last 30 days (Mid), Top selectable', /Mid/.test(await h.ev(`document.querySelector('#profile-root .pf-goals select').selectedOptions[0].textContent`)) && /Top/.test(head), head.slice(0, 120));
        R.ok('three goals, suggested from the season (CS 10.3 -> 10.8, deaths 2.0 -> 1.8, vision 1.00 -> 1.1)',
            t.length === 3 && t[0][1] === 'goal:10.8' && t[1][1] === 'goal:1.8' && t[2][1] === 'goal:1.1', t);
        R.ok('CS: today 12.0 and last 7 days 11.0 (met), season 10.3 (not met); 12 Mid games, Arena left out', t[0][2] === '12.0|pf-pos' && t[0][3] === '11.0|pf-pos' && t[0][4] === '10.3|pf-neg' && /Season \(12\)/.test(head), t[0]);
        R.ok('deaths: lower is better (2.0 against a 1.8 target is red)', t[1][4] === '2.0|pf-neg', t[1]);
        // your own target is saved and used
        await h.ev(`(() => { const i = document.querySelector('#profile-root .pf-goal-in[data-k="csMin"]'); i.value = '11'; i.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
        await h.waitFor(`(() => { const i = document.querySelector('#profile-root .pf-goal-in[data-k="csMin"]'); return i && i.value === '11'; })()`, 3000);
        await h.sleep(300);
        R.ok('a typed target is saved in settings.goals', JSON.stringify(h.settings().goals) === JSON.stringify({ MIDDLE: { csMin: 11 } }), h.settings().goals);
        t = await read();
        R.ok('and colours the row (today 12.0 still met)', t[0][1] === 'goal:11' && t[0][2] === '12.0|pf-pos', t[0]);
        await h.ev(`(() => { const s = document.querySelector('#profile-root .pf-goals select'); s.value = 'TOP'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
        await h.sleep(200);
        t = await read();
        R.ok('switching to Top: its own numbers (no games today or this week)', t[0][2] === '–|pf-muted' && t[0][4] === '10.0|pf-neg', t[0]);
        const errs = h.logs.filter(l => /Uncaught|TypeError|ReferenceError/.test(l));
        R.ok('no uncaught errors', errs.length === 0, errs);
    } catch (e) { R.ok('test ran', false, String(e && e.stack || e)); }
    R.finish();
})();
