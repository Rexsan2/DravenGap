// Stub servers on 127.0.0.1 for live-game scouting: a Riot API (10-player spectator game, varied ranks, shared match ids)
// and an op.gg lookalike (synthetic player pages + the champion-stats server action + the script files that name it).
const http = require('http');
const OG = require('./opgg-fixture');

const NAMES = ['TestOwner', 'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India'];
const CHAMPS = [[266, 'Aatrox'], [103, 'Ahri'], [84, 'Akali'], [12, 'Alistar'], [32, 'Amumu'], [1, 'Annie'], [22, 'Ashe'], [136, 'Aurelion Sol'], [268, 'Azir'], [432, 'Bard']];
const puuidOf = n => ('P' + n).padEnd(78, 'x').replace(/[^A-Za-z0-9_-]/g, '_');
const opuidOf = n => ('OPGG' + n).padEnd(80, 'z').replace(/[^A-Za-z0-9_-]/g, '_');
const TIERS = [['EMERALD', 'II', 54, 120, 101, true], ['GOLD', 'I', 80, 240, 230, false], ['PLATINUM', 'III', 12, 60, 38, false], ['DIAMOND', 'IV', 33, 300, 280, false], ['SILVER', 'II', 70, 25, 15, false],
    ['EMERALD', 'IV', 5, 90, 70, false], ['PLATINUM', 'I', 99, 150, 160, false], ['MASTER', 'I', 210, 400, 350, false], ['GOLD', 'III', 44, 18, 6, false], ['BRONZE', 'I', 9, 30, 34, false]];
const PERKS = [[8112, 8126, 8138, 8135, 8304, 8345, 5008, 5008, 5002, 8100, 8300], [8005, 9111, 9104, 8014, 8139, 8135, 5005, 5008, 5001, 8000, 8100], [8214, 8226, 8210, 8237, 8473, 8453, 5008, 5010, 5011, 8200, 8400],
    [9923, 8126, 8105, 8106, 8226, 8210, 5005, 5008, 5001, 8100, 8200], [8465, 8463, 8473, 8451, 8345, 8347, 5011, 5013, 5001, 8400, 8300]];

function match(i, me) {
    const ts = Date.now() - i * 3600e3 * 5;
    const parts = NAMES.map((n0, k) => {
        const n = k === 0 ? n0 : 'Rand' + (i * 9 + k);
        return ({ puuid: k === 0 ? me : puuidOf(n), riotIdGameName: n, riotIdTagline: k === 0 ? 'META' : 'EUW', championId: CHAMPS[(i + k) % 10][0], championName: 'Champ', champLevel: 14 + k, summoner1Id: 4, summoner2Id: 14,
            teamId: k < 5 ? 100 : 200, win: (k < 5) === (i % 3 !== 0), kills: (i + k) % 9, deaths: (i * 2 + k) % 7, assists: (k + 3) % 11, totalMinionsKilled: 150 + k * 9, neutralMinionsKilled: 10, visionScore: 12 + k, wardsPlaced: 8, wardsKilled: 2,
            visionWardsBoughtInGame: 2, totalDamageDealtToChampions: 12000 + k * 1500, totalDamageTaken: 15000, goldEarned: 9000 + k * 400, item0: 6653, item1: 3020, item2: 3089, item3: 0, item4: 3157, item5: 0, item6: 3340, teamPosition: ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'][k % 5],
            perks: { styles: [{ style: 8100, selections: [{ perk: 8112 }] }, { style: 8300, selections: [{ perk: 8304 }] }] } });
    });
    return { metadata: { matchId: 'EUW1_' + (9000 - i) }, info: { gameId: 9000 - i, queueId: 420, gameMode: 'CLASSIC', gameDuration: 1500 + i * 20, gameEndTimestamp: ts, gameVersion: '16.19.1.2', participants: parts,
        teams: [100, 200].map(t => ({ teamId: t, win: parts.find(p => p.teamId === t).win, objectives: {} })) } };
}

// op.gg champion list per player (index into NAMES); the owner gets the fixture's list.
function champList(k) {
    const mk = OG.champRow;
    const nm = CHAMPS[k][1], key = nm.toLowerCase().replace(/[^a-z]/g, '');
    if (k === 0) return { list: OG.OWNER_CHAMPS, extra: 0 };
    if (k === 4) return { list: [mk(nm, key, 30, 21, 3.4, 6, 4, 5, 7.1), mk('Jinx', 'jinx', 6, 3, 2.4, 6, 4, 5, 7.0), mk('Zed', 'zed', 4, 1, 1.9, 6, 4, 5, 8.1)], extra: 0 };   // one-trick: 30 of 40
    if (k === 3) return { list: [mk('Jinx', 'jinx', 20, 9, 2.1, 6, 4, 5, 7.0), mk('Zed', 'zed', 16, 8, 2.2, 6, 4, 5, 8.0), mk('Lux', 'lux', 11, 6, 2.5, 6, 4, 5, 6.1)], extra: 25 }; // champion not listed
    if (k === 5) return { list: [], extra: 0 };                                                                                                     // no ranked games this season
    if (k === 6) return { list: [mk('Jinx', 'jinx', 2, 1, 2, 6, 4, 5, 7), mk(nm, key, 1, 0, 1.1, 6, 4, 5, 5.9)], extra: 0 };                    // 1 game on the champ
    return { list: [mk(nm, key, 4 + k * 3, 2 + k, 2.5 + k / 4, 6, 4, 5, 6.5 + k / 10), mk('Jinx', 'jinx', 9, 5, 3, 6, 4, 5, 7.4)], extra: 0 };
}

function start() {
    const log = [], olog = [];
    const state = { live: true, liveAfter: 0, key: 'ok', me: puuidOf(NAMES[0]), startedAt: Date.now(), total: 45, ogBlockAll: false, newActionId: null, chunksEmpty: false };
    const srv = http.createServer((req, res) => {
        log.push(req.url);
        const send = (code, body, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(body)); };
        if (req.headers['x-riot-token'] !== state.key) return send(403, { status: { message: 'Forbidden', status_code: 403 } });
        const u = req.url, h = { 'x-app-rate-limit': '20:1,100:120' };
        const go = (c, b) => setTimeout(() => send(c, b, h), 5);
        let m;
        if ((m = u.match(/by-riot-id\/([^/]+)\/([^/?]+)/))) { const n = decodeURIComponent(m[1]); return go(200, { puuid: puuidOf(n), gameName: n, tagLine: decodeURIComponent(m[2]) }); }
        if (u.includes('/summoner/v4/')) return go(200, { profileIconId: 4568, summonerLevel: 321, revisionDate: Date.now() });
        if ((m = u.match(/league\/v4\/entries\/by-puuid\/([^/?]+)/))) {
            const k = NAMES.findIndex(n => puuidOf(n) === m[1]); const t = TIERS[k < 0 ? 0 : k];
            return go(200, [{ queueType: 'RANKED_SOLO_5x5', tier: t[0], rank: t[1], leaguePoints: t[2], wins: t[3], losses: t[4], hotStreak: t[5] }]);
        }
        if (u.includes('/top?')) return go(200, []);
        if ((m = u.match(/by-puuid\/([^/]+)\/by-champion\/(\d+)/))) { const k = NAMES.findIndex(n => puuidOf(n) === m[1]); return go(200, { championLevel: k === 4 ? 1 : 7, championPoints: k === 4 ? 1200 : k === 3 ? 0 : k === 6 ? 8000 : 88000 + k * 5000, lastPlayTime: Date.now() }); }
        if ((m = u.match(/by-puuid\/([^/]+)\/ids\?start=(\d+)&count=(\d+)/))) {
            const k = NAMES.findIndex(n => puuidOf(n) === m[1]);
            const uniq = Array.from({ length: 8 }, (_, i) => 'EUW1_' + (7000 + k * 20 + i));
            // shared recent matches: Foxtrot(6), Golf(7), Hotel(8) all played EUW1_5002; Echo(5) and India(9) none; Alpha(1) & Charlie(3) EUW1_5003
            const sh = [[6, 7, 8].includes(k) ? ['EUW1_5002'] : [], [1, 3].includes(k) ? ['EUW1_5003'] : []].flat();
            if (k === 0) return go(200, Array.from({ length: +m[3] }, (_, i) => 'EUW1_' + (9000 - (+m[2] + i))).slice(0, 45));
            return go(200, [...sh, ...uniq].slice(+m[2], +m[2] + +m[3]));
        }
        if ((m = u.match(/matches\/EUW1_(\d+)$/))) { const i = 9000 - +m[1]; return go(200, match(i, state.me)); }
        if (u.includes('/spectator/')) {
            if (!state.live || Date.now() - state.startedAt < state.liveAfter) return go(404, { status: { message: 'Data not found' } });
            return go(200, { gameId: 777, gameMode: 'CLASSIC', gameQueueConfigId: 420, gameStartTime: Date.now() - 300e3, gameLength: 330,
                bannedChampions: [11, 24, 51, 777, 67, 1, 238, 64, 59, 4].map((c, i) => ({ championId: c, teamId: i < 5 ? 100 : 200, pickTurn: i + 1 })),
                participants: NAMES.map((n, k) => ({ puuid: puuidOf(n), teamId: k < 5 ? 100 : 200, spell1Id: k === 1 ? 11 : 4, spell2Id: k === 1 ? 4 : 14, championId: CHAMPS[k][0], riotId: n + '#' + (k ? 'EUW' : 'META'), bot: false, profileIconId: 10 + k,
                    perks: { perkIds: PERKS[k % 5].slice(0, 9), perkStyle: PERKS[k % 5][9], perkSubStyle: PERKS[k % 5][10] } })) });
        }
        if (u.includes('platform-data')) return go(200, { id: 'EUW1', name: 'EUW' });
        go(404, {});
    });

    const og = http.createServer((req, res) => {
        olog.push(req.method + ' ' + req.url);
        let m;
        if (state.ogBlockAll) { res.writeHead(403); return res.end('blocked'); }
        const want = state.newActionId || OG.ACTION_ID;
        if ((m = req.url.match(/^\/__chunks\/_next\/static\/chunks\/([^/]+)\.js$/))) {
            res.writeHead(200, { 'content-type': 'application/javascript' });
            return res.end(state.chunksEmpty ? '// nothing here' : OG.chunk(m[1], want));
        }
        if (!(m = req.url.match(/^\/lol\/summoners\/euw\/([^/?]+)-([^-/?]+)$/))) { res.writeHead(404); return res.end(); }
        const name = decodeURIComponent(m[1]);
        if (req.method === 'POST') {
            if (req.headers['next-action'] !== want) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Server action not found.'); }
            const ch = []; req.on('data', c => ch.push(c)); req.on('end', () => {
                let body; try { body = JSON.parse(Buffer.concat(ch).toString())[0]; } catch (e) { res.writeHead(400); return res.end(); }
                const k = NAMES.findIndex(n => opuidOf(n) === body.puuid);
                const { list, extra } = champList(k < 0 ? 1 : k);
                res.writeHead(200, { 'content-type': 'text/x-component' });
                res.end(OG.actionBody(list, extra));
            });
            return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(OG.page({ opuid: opuidOf(name), chunkBase: 'http://127.0.0.1:' + og.address().port + '/__chunks/_next/' }));
    });
    return new Promise(r => srv.listen(0, '127.0.0.1', () => og.listen(0, '127.0.0.1', () => r({ srv, og, log, olog, state, port: srv.address().port, ogPort: og.address().port }))));
}

module.exports = { start, puuidOf, opuidOf, NAMES, CHAMPS, TIERS };
