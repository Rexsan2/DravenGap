// Fixes from the 2026-11 review, ARAM / Arena / patch notes (main-process side, no network, no real client):
//  - D1-F2  patch notes: ".55" is 0.55, "40-200" / "levels 1-18" / "+0-9%" are ranges, "Cooldown Refund" is higher-is-better
//  - D1-F3  a failed background refresh is pushed ({ kind, key, error }) so the view can stop saying "refreshing"
//  - D1-F13 Arena: a hover during your pick turn is not "locked"; the declared pick (championPickIntent) counts before your turn
//  - D1-F17 ARAM / Arena in game: the puuid is read again when another account logged in
//  - D1-F18 a 429 pauses the whole host, so queued requests to that site are not sent
const assert = require('assert');
const https = require('https');
const { EventEmitter } = require('events');
const { APP, fixture, scratch } = require('../lib/common');
const P = require(APP + 'patchnotes-parse');
const ARAM = require(APP + 'aram-main');
const ARENA = require(APP + 'arena-main');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };

// ---- D1-F2: patch note line directions
ok(P.lineDirection('Base Health Regen', '7.5 + .55/Level', '7.5 + .6/Level') === 1, 'leading-dot decimals: .55 -> .6 is up');
ok(P.lineDirection('Shield', '40-200', '50-220') === 1, 'a range "40-200" is two numbers, not 40 and -200');
ok(P.lineDirection('Shield', '60-180 (levels 1-18)', '70-190 (levels 1-18)') === 1, '"levels 1-18" on both sides does not cancel the change');
ok(P.lineDirection('Bonus Damage', '25 - 55% (+0-9% with IE)', '25 - 60% (+0-10.5% with IE)') === 1, 'Smolder-style "+0-9%" range');
ok(P.lineDirection('Cooldown Refund on Takedown', '50%', '75%') === 1, 'a bigger cooldown refund is better');
ok(P.lineDirection('Cooldown', '10 seconds', '8 seconds') === 1 && P.lineDirection('Refund Threshold', '10%', '15%') === -1, 'cooldowns and refund thresholds stay lower-is-better');
ok(P.lineDirection('Slow', '-10%', '-15%') === -1 && P.lineDirection('Damage', '5 - 30 (+25% bonus AD)', '5 - 25 (+20% bonus AD)') === -1, 'a leading minus is still a minus; real nerfs stay nerfs');
const { champions } = P.parsePatchNotes(fixture('patchnotes/patch_26_20.html'));
const smolderDp = ((champions.Smolder || {}).changes || []).filter(c => /Dragon Practice/i.test(c.section + ' ' + c.attr));
ok(smolderDp.length === 2 && smolderDp.every(c => c.dir === 1), 'the saved 26.20 notes: both Smolder "Dragon Practice" lines are buffs ' + JSON.stringify(smolderDp.map(c => [c.attr, c.before, c.after, c.dir])));
console.log('patch notes ok');

(async () => {
    // ---- D1-F3: a failed background refresh is pushed with its error (both modules)
    for (const [name, M] of [['aram', ARAM], ['arena', ARENA]]) {
        const store = new Map(), pushes = [];
        const cache = { get: k => store.get(k) || null, set: (k, data) => { const e = { fetchedAt: Date.now(), data }; store.set(k, e); return e; } };
        store.set('k', { fetchedAt: Date.now() - M._internals.TTL_MS - 1000, data: { v: 1 } });
        const load = M._internals.createLoader(cache, ev => pushes.push(ev));
        const r = await load('k', 'tier-list', async () => { throw new Error('Network error: down'); }, false);
        ok(r.ok && r.stale && r.data.v === 1, name + ': stale copy served at once');
        for (let i = 0; i < 50 && !pushes.length; i++) await new Promise(res => setTimeout(res, 10));
        ok(pushes.length === 1 && pushes[0].kind === 'tier-list' && pushes[0].key === 'k' && /Network error: down/.test(pushes[0].error) && !pushes[0].fetchedAt, name + ': the failed refresh is pushed with its error ' + JSON.stringify(pushes));
    }
    console.log('failed refresh push ok');

    // ---- D1-F13: Arena hover vs lock, declared pick
    const flow = { gameData: { queue: { id: 1750, gameMode: 'CHERRY', name: 'Arena' } } };
    const cs = (local, actions) => ARENA._internals.normaliseChampSelect({ localPlayerCellId: 0, myTeam: [Object.assign({ cellId: 0, championId: 0 }, local), { cellId: 1, championId: 0 }], actions }, flow, async () => null);
    let r = await cs({ championId: 103 }, [[{ type: 'pick', actorCellId: 0, championId: 103, completed: false }]]);
    ok(r.mine === 103 && r.mineLocked === false, 'championId filled by a hover during your turn: not locked ' + JSON.stringify(r));
    r = await cs({ championId: 103 }, [[{ type: 'pick', actorCellId: 0, championId: 103, completed: true }]]);
    ok(r.mine === 103 && r.mineLocked === true, 'completed pick action: locked');
    r = await cs({ championId: 0, championPickIntent: 17 }, [[{ type: 'pick', actorCellId: 0, championId: 0, completed: false }]]);
    ok(r.mine === 17 && r.mineLocked === false, 'before your turn: the declared pick, not locked');
    r = await cs({ championId: 103 }, []);
    ok(r.mine === 103 && r.mineLocked === true, 'no pick action for you at all: championId counts as locked (as before)');
    console.log('arena lock ok');

    // ---- D1-F17: in game after switching accounts, the champion follows the new account
    for (const [name, M, queue] of [['aram', ARAM, { id: 2400, gameMode: 'KIWI' }], ['arena', ARENA, { id: 1750, gameMode: 'CHERRY' }]]) {
        let me = 'puuid-A'; const h = {}; let asked = 0;
        const table = { '/lol-gameflow/v1/gameflow-phase': 'InProgress',
            '/lol-gameflow/v1/session': { gameData: { queue, playerChampionSelections: [{ puuid: 'puuid-A', championId: 17 }, { puuid: 'puuid-B', championId: 99 }] } } };
        M.register({ ipcMain: { handle: (c, f) => { h[c] = f; } }, userDataPath: scratch(name + '-fix'), sendToWindow: () => {},
            getLeagueCredentials: async () => ({ port: 1, password: 'x' }),
            lcuRequest: async p => { if (p === '/lol-summoner/v1/current-summoner') { asked++; return { puuid: me }; } return p in table ? JSON.parse(JSON.stringify(table[p])) : null; } });
        let res = await h[name + ':champ-select']();
        ok(res.ok && res.data.inGame && res.data.mine === 17, name + ': first account in game -> its champion ' + JSON.stringify(res.data));
        res = await h[name + ':champ-select']();
        ok(res.data.mine === 17 && asked === 1, name + ': the puuid is remembered while it matches (asked once)');
        me = 'puuid-B';   // logged out and into another account, app not restarted
        table['/lol-gameflow/v1/session'].gameData.playerChampionSelections = [{ puuid: 'puuid-B', championId: 99 }, { puuid: 'puuid-C', championId: 5 }];
        res = await h[name + ':champ-select']();
        ok(res.data.mine === 99 && asked === 2, name + ': another account -> the puuid is read again and its champion found ' + JSON.stringify(res.data));
    }
    console.log('account switch ok');

    // ---- D1-F18: a 429 pauses the host (stub https.get, no network)
    const realGet = https.get;
    try {
        for (const [name, M] of [['aram', ARAM], ['arena', ARENA]]) {
            M._internals.resetBackoff();
            const sent = [];
            https.get = (u, opts, cb) => {
                const url = String(u); sent.push(url);
                const req = new EventEmitter(); req.destroy = e => req.emit('error', e || new Error('destroyed'));
                setTimeout(() => {
                    const res = new EventEmitter(); res.statusCode = /limited/.test(url) ? 429 : 200; res.headers = {}; res.resume = () => {};
                    cb(res); res.emit('data', Buffer.from('ok')); res.emit('end');
                }, 20);
                return req;
            };
            const f = M._internals.fetchPage;
            const host = `https://${name}.test.invalid`;
            // three at once to one host: two get a slot (at most 2 per host), the third waits; the first answers 429
            const out = await Promise.all([f(host + '/limited/1'), f(host + '/page/2'), f(host + '/page/3')].map(p => p.then(t => ({ t }), e => ({ e }))));
            ok(out[0].e && out[0].e.code === 'RATE_LIMITED', name + ': the 429 is an error');
            ok(out[2].e && /not retrying yet/.test(out[2].e.message) && !sent.includes(host + '/page/3'), name + ': the request queued behind the 429 is not sent ' + JSON.stringify(sent));
            const later = await f(host + '/page/4').then(t => ({ t }), e => ({ e }));
            ok(later.e && later.e.code === 'RATE_LIMITED' && !sent.includes(host + '/page/4'), name + ': nor a later one to the same site within the back-off');
            const other = await f(`https://other-${name}.test.invalid/page/1`).then(t => ({ t }), e => ({ e }));
            ok(other.t === 'ok', name + ': other sites are not paused');
            M._internals.resetBackoff();
        }
    } finally { https.get = realGet; }
    console.log('host back-off ok');
    console.log('ALL OK', n, 'checks'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
