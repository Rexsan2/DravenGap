// Arena and the other non-5v5 modes are never summed into "All" (owner decision 2026-10-11), per-minute stats use Summoner's Rift games
// only, and Arena has its own tab with placement instead of win / loss. Pure helpers first, then the profile:* handlers over a seeded
// cache (no Riot requests: no key, and the base URL points at a closed port).
const assert = require('assert');
const { APP, scratch } = require('../lib/common');
const C = require(APP + 'profile-compact');
const I = require(APP + 'profile-insights');
const SC = require(APP + 'profile-score');
const riotHistory = require(APP + 'riot-history');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };

const ME = 'POWNER'.padEnd(78, 'x'), NOW = Date.now();
const POS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

// ---- a raw match-v5 game: 10 players (5v5) or 16 (Arena); the owner is participant 0
function raw(id, { queueId, mode = 'CLASSIC', cs = 240, dur = 1800, ageH = 1, champ = 103, win = true, placement = 0, positions = true, gold = 12000 }) {
    const arena = mode === 'CHERRY', count = arena ? 16 : 10;
    const parts = Array.from({ length: count }, (_, k) => ({
        puuid: k === 0 ? ME : 'P' + k + '_' + id, riotIdGameName: k === 0 ? 'TestOwner' : 'Mate' + k, riotIdTagline: k === 0 ? 'META' : 'EUW',
        championId: k === 0 ? champ : 200 + k, championName: 'C' + k, champLevel: 15, summoner1Id: 4, summoner2Id: 14,
        teamId: k < count / 2 ? 100 : 200, win: k === 0 ? win : (k < count / 2) === win,
        kills: k === 0 ? 6 : 2, deaths: k === 0 ? 3 : 4, assists: k === 0 ? 9 : 3,
        totalMinionsKilled: k === 0 ? cs - 40 : 150, neutralMinionsKilled: k === 0 ? 40 : 10, visionScore: 20 + k, wardsPlaced: 5, wardsKilled: 1, visionWardsBoughtInGame: 1,
        totalDamageDealtToChampions: 15000 + k * 500, totalDamageTaken: 14000, goldEarned: k === 0 ? gold : 9000 + k * 300,
        item0: 6653, item1: 3020, item2: 0, item3: 0, item4: 0, item5: 0, item6: 3340,
        teamPosition: positions && !arena ? POS[k % 5] : '', individualPosition: positions && !arena ? POS[k % 5] : '',
        participantId: k + 1, damageSelfMitigated: 4000, damageDealtToObjectives: 2000, damageDealtToTurrets: 500,
        ...(arena ? { placement: k === 0 ? placement : 1 + (k >> 1) % 8, playerSubteamId: 1 + (k >> 1) } : {})
    }));
    if (arena) { parts[1].placement = placement; parts[1].playerSubteamId = parts[0].playerSubteamId = 1; parts[0].playerSubteamId = 1; }
    return { metadata: { matchId: id }, info: { gameId: +id.replace(/\D/g, ''), queueId, gameMode: mode, gameDuration: dur, gameEndTimestamp: NOW - ageH * 3600e3, gameVersion: '16.19.1.2', participants: parts,
        teams: [100, 200].map(t => ({ teamId: t, win: t === 100 === win, objectives: {} })) } };
}
const cm = (id, o) => C.compactMatch(raw(id, o));

// ---- queue groups
ok(C.inGroup('all', 420) && C.inGroup('all', 450) && C.inGroup('all', 2400), 'All keeps ranked, normal, ARAM and Mayhem');
ok(![1700, 1710, 1750, 1810, 1820, 1830, 1840].some(q => C.inGroup('all', q)), 'All never holds Arena or Swarm');
ok(!C.inGroup('all', 9999, 'CHERRY') && !C.inGroup('all', 9999, 'STRAWBERRY') && C.inGroup('all', 9999, 'CLASSIC'), 'an unknown queue is excluded by its game mode');
ok(C.inGroup('arena', 1700) && C.inGroup('arena', 1710) && C.inGroup('arena', 9999, 'CHERRY') && !C.inGroup('arena', 420), 'the arena group is Arena only');
ok(C.QUEUE_GROUPS.arena.queue === null, 'Arena ids are not filtered by one queue (Arena is 1700, 1710 and 1750)');
ok(C.QUEUE_GROUPS.arena.label === 'Arena' && C.QUEUE_GROUPS.all.queues === null && C.QUEUE_GROUPS.all.queue === null && C.QUEUE_GROUPS.all.type === null, 'All still asks Riot for every id');
ok(C.isSrQueue(420) && C.isSrQueue(400) && C.isSrQueue(490) && !C.isSrQueue(450) && !C.isSrQueue(1700) && !C.isSrQueue(2400), 'Summoner\'s Rift queues');
console.log('queue groups ok');

// ---- compact match: Arena placement, no DD Score, non-SR games score without role weights
const a1 = cm('EUW1_5001', { queueId: 1700, mode: 'CHERRY', placement: 3, cs: 0, dur: 900 });
const me = C.findMe(a1, ME);
ok(a1.players.length === 16 && me.plc === 3 && me.sub === 1 && a1.players.every(p => p.sc === undefined), 'Arena: 16 players, placement kept, no DD Score');
ok(C.ledgerRow(a1, ME).pl === 3 && C.ledgerRow(cm('EUW1_5002', { queueId: 420 }), ME).pl === undefined, 'ledger rows keep the Arena placement only');
const ps = Array.from({ length: 10 }, (_, k) => ({ team: k < 5 ? 100 : 200, win: k < 5, pos: POS[k % 5], k: k, d: 3, a: 4, cs: 200, vis: 20, dmg: 10000 + k * 900, taken: 12000, mit: 3000, gold: 10000 + k * 300, obj: 2000, tur: 400 }));
const withRoles = SC.ddScores(ps, { dur: 1800 }), noRoles = SC.ddScores(ps, { dur: 1800, sr: false }), flat = SC.ddScores(ps.map(p => ({ ...p, pos: '' })), { dur: 1800 });
ok(withRoles.some((r, i) => r.score !== noRoles[i].score), 'role weights change the score in a Summoner\'s Rift queue');
ok(noRoles.every((r, i) => r.score === flat[i].score), 'sr:false = the lane-less weights, whatever positions the game reports');
ok(SC.ddScores(Array.from({ length: 16 }, (_, k) => ({ ...ps[k % 10] })), { dur: 900, sr: false }).every(x => x === null), 'Arena is never scored');
const aram = cm('EUW1_5003', { queueId: 450, mode: 'ARAM', positions: true });
ok(aram.players[0].sc === SC.ddScores(aram.players, { dur: aram.dur, sr: false })[0].score, 'ARAM games are scored without role expectations even if positions are present');
console.log('compact + score ok');

// ---- insights: 2 Summoner's Rift games at 8 CS/min + 1 Arena game -> CS/min stays 8.0
const sr1 = cm('EUW1_6001', { queueId: 420, cs: 240, ageH: 5 }), sr2 = cm('EUW1_6002', { queueId: 440, cs: 240, ageH: 3 }), ar = cm('EUW1_6003', { queueId: 1700, mode: 'CHERRY', placement: 2, cs: 0, dur: 900, ageH: 1 });
let r = I.insights([sr1, sr2, ar], ME);
ok(r.n === 2 && r.overall.g === 2 && r.overall.csMin.toFixed(1) === '8.0', 'Arena is left out: ' + JSON.stringify([r.n, r.overall.csMin]));
ok(!r.champions.some(c => c.g > 2) && r.champions.reduce((t, c) => t + c.g, 0) === 2 && r.trend.length === 2, 'champion table and form chart hold the 2 Rift games');
const am = cm('EUW1_6004', { queueId: 450, mode: 'ARAM', cs: 60, positions: false, ageH: 2, gold: 14000 });
r = I.insights([sr1, sr2, am, ar], ME);
ok(r.n === 3 && r.overall.csMin.toFixed(1) === '8.0' && r.overall.goldMin === (24000 / 60), 'an ARAM game counts as a game but not in CS, gold or vision per minute: ' + JSON.stringify([r.overall.csMin, r.overall.goldMin]));
r = I.insights([am], ME);
ok(r.n === 1 && r.overall.csMin === null && r.overall.goldMin === null && r.overall.visMin === null && r.champions[0].csMin === null, 'no Summoner\'s Rift game: no per-minute numbers');
ok(I.insights([ar], ME).n === 0, 'Arena alone gives no "All" insights');
console.log('insights ok');

// ---- arena insights: placement, top 4, distribution, champions
const arenaGames = [[1, 103], [2, 103], [4, 103], [5, 99], [8, 99], [3, 103]].map(([pl, c], i) => cm('EUW1_700' + i, { queueId: i % 2 ? 1700 : 1710, mode: 'CHERRY', placement: pl, champ: c, cs: 0, dur: 900, ageH: 10 - i }));
const AI = I.arenaInsights([...arenaGames, sr1, am], ME);
ok(AI.n === 6 && Math.abs(AI.avgPlace - 23 / 6) < 1e-9 && Math.abs(AI.topHalf - 4 / 6) < 1e-9 && AI.firsts === 1 && AI.places === 8, JSON.stringify([AI.n, AI.avgPlace, AI.topHalf, AI.firsts]));
ok(AI.dist.join() === '1,1,1,1,1,0,0,1' && AI.champions[0].c === 103 && AI.champions[0].g === 4 && Math.abs(AI.champions[0].avg - 2.5) < 1e-9 && AI.champions[1].c === 99, 'distribution and champions');
ok(AI.duos.length === 1 && AI.duos[0].g === 6 && AI.duos[0].name === 'Mate1', 'the duo partner is the other player of your subteam');
// 3-player teams (queue 1750, 6 teams): the better half is places 1-3, not 1-4
const trio = (id, pl) => {
    const r = raw(id, { queueId: 1750, mode: 'CHERRY', placement: pl, cs: 0, dur: 900, ageH: 30 });
    r.info.participants.push(...[16, 17].map(k => ({ ...r.info.participants[15], puuid: 'P' + k + '_' + id, participantId: k + 1 })));
    r.info.participants.forEach((p, k) => { p.playerSubteamId = 1 + Math.floor(k / 3); if (k) p.placement = 1 + Math.floor(k / 3); });
    r.info.participants[0].placement = pl;
    return C.compactMatch(r);
};
const t3 = trio('EUW1_7101', 3), t4 = trio('EUW1_7102', 4);
ok(t3.winPlaces === 3 && a1.winPlaces === 4 && C.ledgerRow(t3, ME).tp === 3 && C.ledgerRow(a1, ME).tp === 4, 'win places from the lobby: 6 trios -> 3, 8 pairs -> 4');
const AT = I.arenaInsights([t3, t4], ME);
ok(AT.topHalf === 0.5 && AT.places === 6 && AT.dist.length === 6 && AT.lobbies.join() === '6', '3rd of 6 is a top-half finish, 4th of 6 is not: ' + JSON.stringify([AT.topHalf, AT.places, AT.dist]));
ok(C.rowWinPlaces({ q: 1750, pl: 3 }) === 3 && C.rowWinPlaces({ q: 1700, pl: 4 }) === 4, 'old ledger rows without the lobby size fall back on the queue');
console.log('arena insights ok');

// ---- the "You" column only takes Summoner's Rift queues
ok(riotHistory.matchToGame(raw('EUW1_8001', { queueId: 1700, mode: 'CHERRY', placement: 1, dur: 900 }), ME) === null, 'Arena never reaches personal-history');
ok(riotHistory.matchToGame(raw('EUW1_8002', { queueId: 450, mode: 'ARAM' }), ME) === null && riotHistory.matchToGame(raw('EUW1_8003', { queueId: 420 }), ME).queueId === 420, 'ARAM neither, ranked yes');
console.log('You column ok');

// ---- the profile:* handlers over a seeded cache
(async () => {
    const dir = scratch('arena'), h = {};
    const reg = require(APP + 'profile-main').register({ ipcMain: { handle: (c, f) => { h[c] = f; } }, userDataPath: dir, getRiotApiKey: () => null, getLeagueCredentials: async () => { throw new Error('none'); }, lcuRequest: async () => null,
        sendToWindow: () => {}, riotBaseUrl: () => 'http://127.0.0.1:1', noPoll: true, queuesUrl: 'http://127.0.0.1:1/x', cdQueuesUrl: 'http://127.0.0.1:1/y' });
    const call = (name, a) => h['profile:' + name]({}, a);
    const cache = reg.cache, doc = cache.player(ME);
    const seed = async (id, o) => { const rw = raw(id, o), c = C.compactMatch(rw); await cache.putMatch(id, rw); doc.rows[id] = C.ledgerRow(c, ME, null); return id; };
    const srIds = [await seed('EUW1_9001', { queueId: 420, cs: 240, ageH: 6 }), await seed('EUW1_9002', { queueId: 440, cs: 240, ageH: 4, champ: 103 })];
    const aramId = await seed('EUW1_9003', { queueId: 450, mode: 'ARAM', cs: 40, positions: false, ageH: 3, champ: 17 });
    const arenaIds = [];
    for (let i = 0; i < 3; i++) arenaIds.push(await seed('EUW1_901' + i, { queueId: 1700, mode: 'CHERRY', placement: [2, 6, 1][i], champ: 17, cs: 0, dur: 900, ageH: 2 + i / 4 }));
    const now = Date.now();
    doc.idx.all = { ids: [...arenaIds, aramId, ...srIds.slice().reverse()], at: now, complete: true };   // newest first, Arena on top
    doc.idx.arena = { ids: arenaIds, at: now, complete: true };
    doc.idx.aram = { ids: [aramId], at: now, complete: true };
    cache.savePlayer(ME);

    let res = await call('matches', { puuid: ME, platform: 'EUW1', group: 'all' });
    ok(res.ok && res.matches.length === 3 && res.matches.every(m => m.queueId !== 1700) && !res.hasMore, 'matches(all): Arena rows left out: ' + JSON.stringify(res.matches.map(m => m.queueId)));
    res = await call('matches', { puuid: ME, platform: 'EUW1', group: 'arena' });
    ok(res.ok && res.matches.length === 3 && res.matches.every(m => m.queueId === 1700 && m.players.find(p => p.puuid === ME).plc > 0), 'matches(arena) lists the Arena games with placements');
    res = await call('matches', { puuid: ME, platform: 'EUW1', group: 'aram' });
    ok(res.matches.length === 1 && res.matches[0].queueId === 450, 'matches(aram) is unchanged');

    // a page made only of Arena games must not look empty: the next page is read too
    const many = [];
    for (let i = 0; i < 20; i++) many.push(await seed('EUW1_92' + String(i).padStart(2, '0'), { queueId: 1700, mode: 'CHERRY', placement: 4, champ: 17, cs: 0, dur: 900, ageH: 20 }));
    doc.idx.all = { ids: [...many, ...doc.idx.all.ids], at: Date.now(), complete: true };
    res = await call('matches', { puuid: ME, platform: 'EUW1', group: 'all' });
    ok(res.matches.length === 3 && res.nextStart === 26 && !res.hasMore, 'a page of only Arena games continues to the next one: ' + JSON.stringify([res.matches.length, res.nextStart, res.hasMore]));

    // champion filter (FEEDBACK item 11): the match list and Insights of one champion
    res = await call('matches', { puuid: ME, platform: 'EUW1', group: 'all', champId: 103 });
    ok(res.ok && res.champId === 103 && res.matches.length === 2 && res.matches.every(m => C.findMe(m, ME).champId === 103), 'matches(all, champion 103): its 2 games only');
    res = await call('matches', { puuid: ME, platform: 'EUW1', group: 'all', champId: 'x' });
    ok(res.ok && res.champId === null && res.matches.length === 3, 'a bad champion id means no filter');
    res = await call('insights', { puuid: ME, group: 'all', champId: 17 });
    ok(res.ok && res.n === 1 && res.champId === 17 && res.champions.length === 1 && res.champions[0].c === 17, 'insights(champion 17): its one ARAM game (Arena games stay out)');
    res = await call('ledger', { puuid: ME });
    ok(res.rows.length === 26 && res.rows.filter(x => x.q === 1700).length === 23 && res.rows.find(x => x.id === arenaIds[0]).pl === 2, 'the ledger keeps every row; Arena rows carry the placement');
    res = await call('insights', { puuid: ME, group: 'all' });
    ok(res.ok && res.n === 3 && res.overall.csMin.toFixed(1) === '8.0' && res.champions.every(c => c.c !== 17 || c.g === 1), 'insights(all): Arena out, CS/min 8.0 from the 2 Rift games: ' + JSON.stringify([res.n, res.overall && res.overall.csMin]));
    res = await call('insights', { puuid: ME, group: 'arena' });
    ok(res.ok && res.arena && res.n === 23 && res.arena.dist[3] === 20 && res.arena.dist[0] === 1 && res.arena.dist[1] === 1 && res.arena.dist[5] === 1, 'insights(arena): placements, not W / L: ' + JSON.stringify(res.arena && res.arena.dist));
    res = await call('played', { puuid: ME, platform: 'EUW1', group: 'all' });
    ok(res.ok && res.scanned === 3, 'played(all) scans only the 3 non-Arena games, not ' + res.scanned);
    res = await call('played', { puuid: ME, platform: 'EUW1', group: 'arena' });
    ok(res.ok && res.scanned === 23, 'played(arena) scans the Arena games');
    // champion 17 has 1 ARAM game and 23 Arena games: only the ARAM game counts; CS/min comes from Rift games only (champion 103: 2 Rift games)
    res = await call('champ-summary', { champId: 17, puuid: ME });
    ok(res.ok && res.games === 1 && res.mins === 0 && res.cs === 0 && res.totalCached === 3 && res.queues[450] === 1 && !res.queues[1700], 'champ-summary: no Arena, no ARAM CS: ' + JSON.stringify([res.games, res.mins, res.totalCached]));
    res = await call('champ-summary', { champId: 103, puuid: ME });
    ok(res.ok && res.games === 2 && Math.abs(res.cs / res.mins - 8) < 1e-9, 'champ-summary: CS/min from the Rift games = 8');
    // known by Riot ID only, no key and no cached account lookup: answered from the Riot IDs seen before
    cache.setMeta('puuid:' + ME, { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' });
    res = await call('champ-summary', { champId: 103, gameName: 'testowner', tagLine: 'meta', platform: 'EUW1' });
    ok(res.ok && res.puuid === ME && res.games === 2, 'champ-summary by Riot ID works without a key or a client');
    // which account is mine: no client here -> the last client account seen, else Settings > Default account, else nothing
    res = await call('owner', {});
    ok(res.ok === false, 'no client, no last owner, no setting: no owner');
    res = await call('owner', { fallback: { gameName: ' Typed ', tagLine: '#EUW', platform: 'euw1' } });
    ok(res.ok && res.source === 'settings' && res.owner.gameName === 'Typed' && res.owner.tagLine === 'EUW' && res.owner.platform === 'EUW1', 'owner from the renderer fallback: ' + JSON.stringify(res));
    cache.setMeta('owner-last', { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1', puuid: ME });
    res = await call('owner', { fallback: { gameName: 'Typed', tagLine: 'EUW' } });
    ok(res.ok && res.source === 'last' && res.owner.puuid === ME, 'the last client account beats the setting: ' + JSON.stringify(res));
    res = await call('test-key');
    ok(res.ok === false && res.code === 'NO_KEY', 'test-key without a key: NO_KEY');
    res = await call('static');
    ok(res.groups.arena && res.groups.all.exclude.includes(1700) && res.srQueues.includes(420), 'profile:static sends the group lists to the view');
    reg.flush();
    console.log('handlers ok');
    console.log('ALL OK', n, 'checks'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
