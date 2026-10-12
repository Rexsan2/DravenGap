// profile:duo (who is in your lobby, their lane in champion select) and profile:duo-history (your games together, from cache).
const assert = require('assert');
const { APP, scratch } = require('../lib/common');
const { start } = require('../lib/riot-stub');

(async () => {
    const S = await start(); const dir = scratch('pduo');
    const handlers = {};
    let lobby = { gameConfig: { queueId: 420 }, members: [
        { puuid: 'lcu-me', summonerId: 1, gameName: 'TestOwner', gameTag: 'META', firstPositionPreference: 'MIDDLE', secondPositionPreference: 'UNSELECTED' },
        { puuid: 'lcu-alpha', summonerId: 2, gameName: 'Alpha', gameTag: 'EUW', firstPositionPreference: 'JUNGLE', secondPositionPreference: 'TOP' }] };
    let cs = { localPlayerCellId: 0, myTeam: [{ cellId: 0, puuid: 'lcu-me', summonerId: 1, assignedPosition: 'middle', championId: 0 }, { cellId: 1, summonerId: 2, assignedPosition: 'jungle', championId: 64 }] };
    const lcuRequest = async p => {
        if (p === '/lol-summoner/v1/current-summoner') return { gameName: 'TestOwner', tagLine: 'META', puuid: 'lcu-me', profileIconId: 1, summonerLevel: 30 };
        if (p === '/riotclient/get_region_locale') return { region: 'EUW' };
        if (p === '/lol-lobby/v2/lobby') return lobby;
        if (p === '/lol-champ-select/v1/session') return cs;
        return null;
    };
    const rh = require(APP + 'riot-history');
    require(APP + 'profile-main').register({ ipcMain: { handle: (c, f) => handlers[c] = f }, userDataPath: dir, getRiotApiKey: () => 'ok', getLeagueCredentials: async () => ({ port: 1, password: 'x' }), lcuRequest,
        sendToWindow: () => {}, riotBaseUrl: () => 'http://127.0.0.1:' + S.port, noPoll: true, limiter: new rh.RateLimiter(), queuesUrl: 'http://127.0.0.1:1/x' });
    const call = (n, a) => handlers['profile:' + n]({}, a);

    let r = await call('duo');
    assert(r.ok && r.lcu && r.inLobby && r.partners.length === 1, JSON.stringify(r));
    assert.deepStrictEqual(r.partners[0], { gameName: 'Alpha', tagLine: 'EUW', positions: ['JUNGLE', 'TOP'], assigned: 'JUNGLE', championId: 64 });
    assert.deepStrictEqual([r.me.positions, r.me.assigned], [['MIDDLE'], 'MIDDLE']);
    lobby = { members: [lobby.members[0]] }; cs = null;
    r = await call('duo'); assert(r.ok && r.partners.length === 0 && r.me.assigned === null, 'solo: no partner');
    console.log('duo detection ok');

    // history: the stub's owner always has Alpha (k=1) on the same team and Foxtrot (k=6) on the other
    const me = { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' };
    const puuid = (await call('lookup', me)).profile.puuid;
    for (const s of [0, 20, 40]) await call('matches', { puuid, platform: 'EUW1', group: 'all', start: s });
    r = await call('duo-history', { owner: me, partner: { gameName: 'alpha', tagLine: 'euw' } });
    assert(r.ok && r.games === 45 && r.w === 30 && r.scanned === 45, JSON.stringify(r).slice(0, 200));
    assert.deepStrictEqual(r.lanes, [{ myPos: 'TOP', theirPos: 'JUNGLE', games: 45, w: 30 }]);
    assert(r.pairs.length === 20 && r.pairs[0].games === 2 && r.pairs.every(p => p.myPos === 'TOP'), 'champion pairs, most played first (capped at 20)');
    assert(Object.values(r.partnerChamps.JUNGLE).reduce((a, b) => a + b, 0) === 45, 'partner champions per lane');
    r = await call('duo-history', { owner: { puuid }, partner: { gameName: 'Foxtrot', tagLine: 'EUW' } }); assert(r.ok && r.games === 0, 'enemy team does not count');
    r = await call('duo-history', { owner: { puuid }, partner: { gameName: '' } }); assert(!r.ok && r.code === 'BAD_INPUT');
    console.log('duo history ok');
    S.srv.close(); console.log('ALL OK'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
