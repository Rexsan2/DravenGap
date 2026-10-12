// After a game (FEEDBACK item 5): the owner's profile refresh keeps trying through a moment without the client's region and stops
// once the game that just ended is in Riot's list; an ARAM Mayhem game (never in Riot's API) is read from the client instead, with no
// Riot request, stored as a cached match marked 'lcu', and shows in the match list by time.
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const { APP, scratch, sleep, waitFor } = require('../lib/common');
const { start } = require('../lib/riot-stub');
const C = require(APP + 'profile-compact');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };

// a finished game as the client's /lol-match-history/v1/games/{id} returns it (match-v4 shape): 10 players, the owner first
function lcuGame(gameId, queueId, ownerWins, endAgoMin = 20) {
    const participants = [], participantIdentities = [];
    for (let k = 0; k < 10; k++) {
        const teamId = k < 5 ? 100 : 200, win = (teamId === 100) === ownerWins;
        participants.push({ participantId: k + 1, teamId, championId: k === 0 ? 17 : 30 + k, spell1Id: 4, spell2Id: 32,
            stats: { win, kills: k === 0 ? 11 : 3, deaths: 4, assists: k === 0 ? 20 : 6, champLevel: 18, totalDamageDealtToChampions: 30000 + k * 100, totalDamageTaken: 25000,
                goldEarned: 13000, totalMinionsKilled: 40, neutralMinionsKilled: 0, visionScore: 5, item0: 3020, item1: 6653, item6: 2052,
                perk0: 8128, perk1: 8126, perk2: 8138, perk3: 8135, perk4: 8226, perk5: 8210, perkPrimaryStyle: 8100, perkSubStyle: 8200, statPerk0: 5008, statPerk1: 5008, statPerk2: 5001 } });
        participantIdentities.push({ participantId: k + 1, player: k === 0 ? { puuid: 'lcu-puuid', gameName: 'TestOwner', tagLine: 'META' } : { puuid: 'lcu-' + k, gameName: 'Mate' + k, tagLine: 'EUW' } });
    }
    return { gameId, queueId, gameMode: 'KIWI', gameDuration: 1080, gameCreation: Date.now() - (endAgoMin + 18) * 60e3, gameVersion: '16.20.1.1', platformId: 'EUW1',
        participants, participantIdentities, teams: [{ teamId: 100, win: ownerWins ? 'Win' : 'Fail' }, { teamId: 200, win: ownerWins ? 'Fail' : 'Win' }] };
}

// ---- the converter
const raw = C.lcuGameToMatch(lcuGame(7001, 2400, true), { platform: 'EUW1', ownerLcuPuuid: 'lcu-puuid', ownerApiPuuid: 'API-OWNER' });
const cm = C.compactMatch(raw);
const me = C.findMe(cm, 'API-OWNER');
ok(raw.metadata.matchId === 'EUW1_7001' && cm.src === 'lcu' && cm.queueId === 2400 && cm.dur === 1080 && cm.players.length === 10, 'id, source, queue, duration (seconds)');
ok(me && me.champId === 17 && me.win && me.k === 11 && me.a === 20 && me.items[0] === 3020 && me.keystone === 8128 && me.name === 'TestOwner', 'your row: champion, result, K/D/A, items, keystone');
ok(cm.players.filter(p => p.win).length === 5 && cm.players[5].puuid === 'lcu-5' && cm.players[5].name === 'Mate5', 'teams and the other players');
ok(C.lcuGameToMatch(null, { platform: 'EUW1' }) === null && C.lcuGameToMatch(lcuGame(1, 2400, true), {}) === null, 'nothing unexpected is converted');
console.log('converter ok');

(async () => {
    const S = await start(); const dir = scratch('postgame');
    fs.writeFileSync(path.join(dir, 'personal-history.json'), JSON.stringify({ 'lcu-puuid': [] }));
    const handlers = {}, pushes = [], lcuCalls = [];
    let phase = 'None', game = null, regionDown = false, historyReady = 0;
    const lcuRequest = async p => {
        lcuCalls.push(p);
        if (p.includes('gameflow-phase')) return phase;
        if (p.includes('/lol-gameflow/v1/session')) return game ? { phase, gameData: { gameId: game.id, queue: { id: game.q }, teamOne: [{ puuid: 'lcu-puuid', gameName: 'TestOwner', tagLine: 'META', championId: 17 }], teamTwo: [] } } : null;
        if (p.includes('current-summoner')) return { gameName: 'TestOwner', tagLine: 'META', puuid: 'lcu-puuid', summonerLevel: 5, profileIconId: 1 };
        if (p.includes('region')) return regionDown ? null : { region: 'EUW' };
        const m = p.match(/\/lol-match-history\/v1\/games\/(\d+)$/);
        if (m) return historyReady-- > 0 ? null : lcuGame(+m[1], 2400, true, 2);   // the client writes the game a moment after the end
        return null;
    };
    require(APP + 'profile-main').register({ ipcMain: { handle: (c, f) => handlers[c] = f }, userDataPath: dir, getRiotApiKey: () => 'ok',
        getLeagueCredentials: async () => ({ port: 1 }), lcuRequest, sendToWindow: (c, p) => pushes.push([c, p]), riotBaseUrl: () => 'http://127.0.0.1:' + S.port,
        pollMs: 100, pollStartDelay: 50, autoRefreshDelays: [200, 400, 400], clientGameDelays: [100, 150, 150] });
    await sleep(300);
    const look = await handlers['profile:lookup']({}, { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' });
    const puuid = look.profile.puuid;
    await handlers['profile:matches']({}, { puuid, platform: 'EUW1', group: 'all' });

    // ---- ranked game 9001: the first refresh after the game cannot read the client's region; the next one finds the game
    game = { id: 9001, q: 420 }; phase = 'InProgress'; await sleep(350);
    pushes.length = 0; regionDown = true; S.state.newer = true;
    phase = 'EndOfGame'; await sleep(150); phase = 'None';
    await sleep(350);                                         // attempt 1 (200 ms): no region -> 'no-client'
    ok(!pushes.some(p => p[1] && p[1].owner), 'no update while the region is unknown');
    regionDown = false; phase = 'Lobby';                      // a phase change makes the main process read the client again
    await waitFor(() => pushes.some(p => p[1] && p[1].owner && p[1].ids && p[1].ids.includes('EUW1_9001')), 4000);
    ok(true, 'a "no-client" read does not end the refresh: the game arrives on a later try');
    const after = pushes.filter(p => p[1] && p[1].owner).length;
    await sleep(900);
    ok(pushes.filter(p => p[1] && p[1].owner).length === after, 'it stops once the game that ended is in the list');
    console.log('ranked refresh ok');

    // ---- ARAM Mayhem game 7777: no Riot request; read from the client (after it has written the game), merged into the list
    phase = 'Lobby'; await sleep(150);
    game = { id: 7777, q: 2400 }; phase = 'InProgress'; await sleep(350);
    pushes.length = 0; historyReady = 1; const riotBefore = S.log.length;
    phase = 'EndOfGame'; await sleep(150); phase = 'None';
    await waitFor(() => pushes.some(p => p[1] && p[1].src === 'lcu'), 5000);
    const upd = pushes.find(p => p[1] && p[1].src === 'lcu')[1];
    ok(upd.owner && upd.puuid === puuid && upd.ids[0] === 'EUW1_7777', 'the window hears about the client game: ' + JSON.stringify(upd));
    ok(lcuCalls.filter(p => p.endsWith('/games/7777')).length === 2, 'the client was asked again until the game was there');
    ok(S.log.length === riotBefore, 'no Riot request for a Mayhem game: ' + S.log.slice(riotBefore).join(', '));
    let r = await handlers['profile:matches']({}, { puuid, platform: 'EUW1', group: 'all' });
    ok(r.ok && r.matches.some(m => m.id === 'EUW1_7777' && m.src === 'lcu') && r.matches.every((m, i) => !i || m.end <= r.matches[i - 1].end), 'match list: the client game merged in, in time order');
    r = await handlers['profile:matches']({}, { puuid, platform: 'EUW1', group: 'mayhem' });
    ok(r.matches.some(m => m.id === 'EUW1_7777'), 'and in the ARAM Mayhem tab');
    r = await handlers['profile:matches']({}, { puuid, platform: 'EUW1', group: 'solo' });
    ok(!r.matches.some(m => m.id === 'EUW1_7777'), 'not in Ranked Solo');
    r = await handlers['profile:ledger']({}, { puuid });
    ok(r.rows.some(x => x.id === 'EUW1_7777' && x.q === 2400 && x.c === 17 && x.w === 1), 'a ledger row (champion stats, Insights)');
    console.log('Mayhem from the client ok');
    console.log('ALL OK', n, 'checks'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
