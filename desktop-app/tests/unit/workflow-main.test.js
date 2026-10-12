// Wave 1 main-process pieces: learning curve and strengths / weaknesses (profile-insights), LP tracker, today's session.
const assert = require('assert');
const { APP, scratch, sleep } = require('../lib/common');
const I = require(APP + 'profile-insights');

// ---- learning curve: game number per champion, oldest first
const games = [];
for (let i = 0; i < 30; i++) games.push({ c: i < 26 ? 1 : 2, w: i >= 3 });   // champion 1: first 3 lost, rest won
let curve = I.learningCurve(games);
assert.deepStrictEqual(curve.map(b => [b.n, b.w]), [[6, 3], [8, 8], [15, 15], [1, 1]], JSON.stringify(curve));
console.log('learning curve ok');

// ---- strengths / weaknesses: clear vision lead, clear deaths deficit, cs level
const laned = [];
for (let i = 0; i < 20; i++) laned.push({ dur: 1800, opp: { cs: (i % 2 ? 6 : -6), gold: 30 + (i % 3) * 10, dmg: 0, vis: 12 + (i % 4), deaths: 2 + (i % 2), kp: 0 } });
const v = I.vsLaneOpponents(laned);
const st = k => v.stats.find(s => s.k === k);
assert.strictEqual(v.n, 20);
assert.strictEqual(st('vis').verdict, 'strength'); assert.strictEqual(st('deaths').verdict, 'weakness'); assert.strictEqual(st('cs').verdict, 'even');
assert(v.strengths.some(s => s.k === 'vis') && v.weaknesses.some(s => s.k === 'deaths'));
assert.strictEqual(I.vsLaneOpponents(laned.slice(0, 5)).stats[0].mean, null, 'too few games');
console.log('vs lane opponents ok');

// ---- LP tracker + session through profile-main with a fake client
(async () => {
    const dir = scratch('lp');
    let phase = 'None', ranked = { tier: 'GOLD', division: 'II', leaguePoints: 40, wins: 10, losses: 10 };
    const day = Date.now();
    const lcuRequest = async p => {
        if (p.includes('gameflow-phase')) return phase;
        if (p === '/lol-gameflow/v1/session') return { gameData: { queue: { id: 420 } } };
        if (p === '/lol-summoner/v1/current-summoner') return { gameName: 'TestOwner', tagLine: 'META', puuid: 'lcu-me', summonerId: 1 };
        if (p === '/riotclient/get_region_locale') return { region: 'EUW' };
        if (p === '/lol-ranked/v1/current-ranked-stats') return { queues: [{ queueType: 'RANKED_SOLO_5x5', ...ranked }] };
        if (p.startsWith('/lol-match-history')) return { games: { games: [
            { gameId: 1, queueId: 420, gameCreation: day - 3600e3 > new Date().setHours(0, 0, 0, 0) ? day - 3600e3 : day, gameDuration: 1800, participants: [{ participantId: 1, championId: 103, stats: { win: true, kills: 5, deaths: 2, assists: 7 } }], participantIdentities: [{ participantId: 1, player: { puuid: 'lcu-me' } }] },
            { gameId: 2, queueId: 420, gameCreation: day - 5 * 86400e3, gameDuration: 1800, participants: [{ participantId: 1, championId: 1, stats: { win: false } }], participantIdentities: [{ participantId: 1, player: { puuid: 'lcu-me' } }] }] } };
        return null;
    };
    const h = {}, pushes = [];
    require(APP + 'profile-main').register({ ipcMain: { handle: (c, f) => h[c] = f }, userDataPath: dir, getRiotApiKey: () => null, getLeagueCredentials: async () => ({ port: 1, password: 'x' }),
        lcuRequest, sendToWindow: (c, p) => pushes.push([c, p]), pollMs: 60, pollStartDelay: 10, lpDelays: [50, 50, 50], autoRefreshDelays: [999999] });
    const call = (n, a) => h['profile:' + n]({}, a);
    await sleep(150);
    phase = 'ChampSelect'; await sleep(250);
    phase = 'InProgress'; await sleep(200);
    ranked = { ...ranked, leaguePoints: 61, wins: 11 };          // won: +21 LP
    phase = 'EndOfGame'; await sleep(400);
    let r = await call('lp-history');
    assert(r.ok && r.list.length === 1, JSON.stringify(r));
    assert.deepStrictEqual([r.list[0].q, r.list[0].win, r.list[0].delta, r.list[0].after.lp], ['RANKED_SOLO_5x5', true, 21, 61]);
    assert(pushes.some(p => p[1] && p[1].kind === 'lp'));
    console.log('LP after a win ok');
    // dodge: champion select back to the lobby, LP down with the same games
    phase = 'Lobby'; await sleep(150);
    phase = 'ChampSelect'; await sleep(200);
    ranked = { ...ranked, leaguePoints: 56 };
    phase = 'Lobby'; await sleep(400);
    r = await call('lp-history');
    assert(r.list.length === 2 && r.list[1].dodge === true && r.list[1].delta === -5, JSON.stringify(r.list[1]));
    console.log('dodge ok');
    r = await call('session');
    assert(r.ok && r.lcu && r.games.length === 1 && r.w === 1 && r.l === 0 && r.lp.RANKED_SOLO_5x5 === 16, JSON.stringify(r));
    console.log('session ok');
    console.log('ALL OK'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
