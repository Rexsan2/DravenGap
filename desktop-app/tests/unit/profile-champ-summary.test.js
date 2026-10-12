// profile:champ-summary: one champion's games of a player from the cached matches (champion hub "My stats", build coaching).
const assert = require('assert');
const { APP, scratch } = require('../lib/common');
const { start } = require('../lib/riot-stub');

(async () => {
    const S = await start(); const dir = scratch('pcs');
    const handlers = {};
    const rh = require(APP + 'riot-history');
    require(APP + 'profile-main').register({ ipcMain: { handle: (c, f) => handlers[c] = f }, userDataPath: dir, getRiotApiKey: () => 'ok', getLeagueCredentials: async () => { throw new Error('none'); }, lcuRequest: async () => null,
        sendToWindow: () => {}, riotBaseUrl: () => 'http://127.0.0.1:' + S.port, noPoll: true, limiter: new rh.RateLimiter(), queuesUrl: 'http://127.0.0.1:1/x' });
    const call = (n, a) => handlers['profile:' + n]({}, a);
    const me = { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' };
    const puuid = (await call('lookup', me)).profile.puuid;
    for (const s of [0, 20, 40]) await call('matches', { puuid, platform: 'EUW1', group: 'all', start: s });   // 45 games cached
    // the stub's owner plays champion CH[i % 30]: 266 (Aatrox) in games 0 and 30, both losses, TOP, ranked solo
    let r = await call('champ-summary', { champId: 266, puuid });
    assert(r.ok && r.games === 2 && r.w === 0 && r.k === 0 + 3 && r.d === 0 + 4 && r.a === 6 && r.roles.TOP === 2 && r.queues[420] === 2, JSON.stringify(r).slice(0, 300));
    assert.strictEqual(r.totalCached, 45);
    assert(r.last.length === 2 && r.last[0].end > r.last[1].end && typeof r.last[0].sc === 'number', 'newest first, with DD Score');
    assert(typeof r.score === 'number' && r.score >= 0 && r.score <= 10);
    assert.deepStrictEqual(r.items.TOP.freq, { 6653: 2, 3020: 2, 3089: 2, 3157: 2 }, 'final items (slot 6 trinket left out), counted once per game');
    assert.strictEqual(r.items.TOP.games, 2);
    console.log('by puuid ok', JSON.stringify({ games: r.games, score: r.score.toFixed(2), items: r.items.TOP.freq }));
    const n0 = S.log.length;
    r = await call('champ-summary', { champId: 266, ...me });
    assert(r.ok && r.games === 2 && r.puuid === puuid && S.log.length === n0, 'by Riot ID: cached account, no request');
    r = await call('champ-summary', { champId: 999, puuid }); assert(r.ok && r.games === 0 && r.score === null);
    r = await call('champ-summary', { champId: 'x', puuid }); assert(!r.ok && r.code === 'BAD_INPUT');
    r = await call('champ-summary', { champId: 266 }); assert(!r.ok && r.code === 'BAD_INPUT', 'needs a player');
    console.log('by Riot ID / empty / validation ok');
    S.srv.close(); console.log('ALL OK'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
