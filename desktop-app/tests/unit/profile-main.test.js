// profile-main IPC against the stub Riot API: lookup, typed errors, paging, cache (no second network load), live, backfill, limiter priority.
const assert = require('assert');
const { APP, scratch, waitFor } = require('../lib/common');
const { start } = require('../lib/riot-stub');

(async () => {
    const S = await start(); const dir = scratch('pm');
    const handlers = {}; const pushes = [];
    const rh = require(APP + 'riot-history');
    const lim = new rh.RateLimiter();
    const { register } = require(APP + 'profile-main');
    register({ ipcMain: { handle: (c, f) => handlers[c] = f }, userDataPath: dir, getRiotApiKey: () => 'ok', getLeagueCredentials: async () => { throw new Error('none'); }, lcuRequest: async () => null,
        sendToWindow: (c, p) => pushes.push([c, p]), riotBaseUrl: () => 'http://127.0.0.1:' + S.port, noPoll: true, limiter: lim, queuesUrl: 'http://127.0.0.1:1/x' });
    const call = (n, a) => handlers['profile:' + n]({}, a);
    const me = { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' };
    let r = await call('test-key'); assert(r.ok, JSON.stringify(r));
    r = await call('lookup', me);
    assert(r.ok && r.profile.ranked.length === 2 && r.profile.mastery.length === 5 && r.profile.summonerLevel === 321); console.log('lookup ok');
    const puuid = r.profile.puuid;
    r = await call('lookup', { gameName: 'Nobody', tagLine: 'X', platform: 'EUW1' }); assert(r.code === 'NOT_FOUND', JSON.stringify(r));
    let n0 = S.log.length;
    r = await call('lookup', me); assert(r.ok && S.log.length === n0, 'lookup cache hit'); console.log('lookup cached: 0 network');
    S.state.fail429 = 2;
    r = await call('matches', { puuid, platform: 'EUW1', group: 'all' }); assert(r.ok && r.matches.length === 20, JSON.stringify(r).slice(0, 200));
    r = await call('matches', { puuid, platform: 'EUW1', group: 'all', start: r.nextStart }); assert(r.matches.length === 20 && r.hasMore);
    r = await call('matches', { puuid, platform: 'EUW1', group: 'all', start: r.nextStart }); assert(r.matches.length === 5 && !r.hasMore, r.matches.length); console.log('paging ok (incl. 429 retry)');
    n0 = S.log.length;
    for (const s of [0, 20, 40]) await call('matches', { puuid, platform: 'EUW1', group: 'all', start: s });
    assert.strictEqual(S.log.length, n0, 'second load must be 0 network: ' + S.log.slice(n0).join('\n')); console.log('second load of 3 pages: 0 network calls');
    r = await call('matches', { puuid, platform: 'EUW1', group: 'solo' }); assert(r.matches.every(m => m.queueId === 420) && r.matches.length === 9, r.matches.length);
    r = await call('matches', { puuid, platform: 'EUW1', group: 'mayhem' }); assert(r.matches.every(m => m.queueId === 2400) && r.matches.length > 0); console.log('queue filters ok');
    r = await call('ledger', { puuid }); assert(r.rows.length >= 20, r.rows.length);
    S.state.fail429 = 99; r = await call('lookup', { gameName: 'Other', tagLine: 'EUW', platform: 'EUW1', force: true });
    assert(r.code === 'RATE_LIMITED' && r.retryAt, JSON.stringify(r)); S.state.fail429 = 0; lim.pausedUntil = 0;
    S.state.key = 'changed'; r = await call('lookup', { gameName: 'Zed', tagLine: 'EUW', platform: 'EUW1' }); assert(r.code === 'KEY_REJECTED'); S.state.key = 'ok';
    console.log('429 / 403 typed');
    pushes.length = 0;
    r = await call('live', me); assert(r.inGame && r.game.players.length === 10);
    await waitFor(() => pushes.some(p => p[1].finished));
    assert.strictEqual(pushes.filter(p => p[1].patch && p[1].patch.ranked).length, 10);
    S.state.live = false; r = await call('live', me); assert(r.inGame === false); console.log('live ok');
    pushes.length = 0; await call('backfill', { puuid, platform: 'EUW1', max: 100 });
    await waitFor(() => pushes.some(p => p[1].kind === 'backfill' && p[1].state !== 'running'), 20000);
    r = await call('ledger', { puuid }); assert(r.rows.length >= 45, 'after backfill rows ' + r.rows.length); console.log('backfill ok');
    const order = []; const l2 = new rh.RateLimiter([[1, 100]]);
    await l2.wait(); await Promise.all([l2.wait(2).then(() => order.push('bg')), l2.wait(0).then(() => order.push('live')), l2.wait(1).then(() => order.push('vis'))]);
    assert.deepStrictEqual(order, ['live', 'vis', 'bg']); console.log('priority order ok');
    S.srv.close(); console.log('ALL OK'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
