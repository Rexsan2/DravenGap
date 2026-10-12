// Stubbed Riot API on 127.0.0.1 with documented-shape responses. Player 0 ("TestOwner#META") is the account under test.
const http = require('http');
const { timeline } = require('./timeline-fixture');

const CH = [266, 103, 84, 12, 32, 1, 22, 136, 268, 432, 53, 63, 201, 51, 164, 69, 31, 42, 122, 131, 119, 36, 245, 60, 28, 81, 9, 114, 105, 3];
const OWNER = 'TestOwner';
const names = [OWNER, 'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India'];
const puuidOf = n => ('P' + n).padEnd(78, 'x').replace(/[^A-Za-z0-9_-]/g, '_');
const QS = [420, 440, 450, 2400, 400];

function match(i, me) {
    const ts = Date.now() - i * 3600e3 * 5;
    const parts = names.map((n, k) => ({
        puuid: k === 0 ? me : puuidOf(n), riotIdGameName: n, riotIdTagline: k === 0 ? 'META' : 'EUW', championId: CH[(i + k) % CH.length], championName: 'Champ' + CH[(i + k) % CH.length],
        champLevel: 14 + k, summoner1Id: 4, summoner2Id: 14, teamId: k < 5 ? 100 : 200, win: (k < 5) === (i % 3 !== 0),
        kills: (i + k) % 9, deaths: (i * 2 + k) % 7, assists: (k + 3) % 11, totalMinionsKilled: 150 + k * 9, neutralMinionsKilled: 10, visionScore: 12 + k,
        wardsPlaced: 8, wardsKilled: 2, visionWardsBoughtInGame: 2, totalDamageDealtToChampions: 12000 + k * 1500, totalDamageTaken: 15000, goldEarned: 9000 + k * 400,
        item0: 6653, item1: 3020, item2: 3089, item3: 0, item4: 3157, item5: 0, item6: 3340, teamPosition: ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'][k % 5],
        perks: { statPerks: { offense: 5008, flex: 5010, defense: 5011 }, styles: [{ style: 8100, selections: [{ perk: 8112 }, { perk: 8126 }, { perk: 8138 }, { perk: 8135 }] }, { style: 8300, selections: [{ perk: 8304 }, { perk: 8345 }] }] },
        participantId: k + 1, damageSelfMitigated: 5000 + k * 900, damageDealtToObjectives: 3000 + k * 700, damageDealtToTurrets: 800 + k * 100
    }));
    const q = QS[((i % 5) + 5) % 5];
    return { metadata: { matchId: 'EUW1_' + (9000 - i) }, info: { gameId: 9000 - i, queueId: q, gameMode: 'CLASSIC', gameDuration: 1500 + i * 20, gameEndTimestamp: ts, gameVersion: '16.19.1.2', participants: parts,
        teams: [100, 200].map(t => ({ teamId: t, win: parts.find(p => p.teamId === t).win, objectives: { baron: { kills: 1 }, dragon: { kills: 2 }, tower: { kills: 6 }, riftHerald: { kills: 1 }, inhibitor: { kills: 1 } } })) } };
}

function start() {
    const log = []; const state = { fail429: 0, live: true, total: 45, delay: 0, key: 'ok', me: puuidOf(OWNER) };
    const srv = http.createServer((req, res) => {
        log.push(req.url);
        const send = (code, body, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(body)); };
        if (req.headers['x-riot-token'] !== state.key) return send(403, { status: { message: 'Forbidden', status_code: 403 } });
        if (state.fail429 > 0) { state.fail429--; return send(429, { status: { message: 'rate limit', status_code: 429 } }, { 'retry-after': '1' }); }
        const u = req.url, h = { 'x-app-rate-limit': '20:1,100:120' };
        const go = (code, b) => setTimeout(() => send(code, b, h), state.delay);
        let m;
        if ((m = u.match(/by-riot-id\/([^/]+)\/([^/?]+)/))) {
            const n = decodeURIComponent(m[1]); if (n === 'Nobody') return go(404, { status: { message: 'Data not found' } });
            return go(200, { puuid: puuidOf(n), gameName: n, tagLine: decodeURIComponent(m[2]) });
        }
        if (u.includes('/summoner/v4/')) return go(200, { profileIconId: 4568, summonerLevel: 321, revisionDate: Date.now() });
        if (u.includes('/league/v4/entries')) return go(200, [{ queueType: 'RANKED_SOLO_5x5', tier: 'EMERALD', rank: 'II', leaguePoints: 54, wins: 120, losses: 101 }, { queueType: 'RANKED_FLEX_SR', tier: 'GOLD', rank: 'I', leaguePoints: 12, wins: 20, losses: 18 }]);
        if (u.includes('/top?')) return go(200, CH.slice(0, 5).map((c, i) => ({ championId: c, championLevel: 30 - i * 3, championPoints: 250000 - i * 40000, lastPlayTime: Date.now() - i * 864e5 })));
        if (u.includes('/by-champion/')) return go(200, { championLevel: 7, championPoints: 88000, lastPlayTime: Date.now() });
        if ((m = u.match(/by-puuid\/([^/]+)\/ids\?start=(\d+)&count=(\d+)(.*)/))) {
            const s = +m[2], c = +m[3], q = (m[4].match(/queue=(\d+)/) || [])[1];
            const all = Array.from({ length: state.total }, (_, i) => i).filter(i => !q || QS[i % 5] === +q);
            const idl = (state.newer && !q ? ['EUW1_9001'] : []).concat(all.map(i => 'EUW1_' + (9000 - i))); return go(200, idl.slice(s, s + c));
        }
        if ((m = u.match(/matches\/EUW1_(\d+)\/timeline$/))) { if (state.tlFail) { state.tlFail--; return go(500, {}); } return go(200, timeline('EUW1_' + m[1])); }
        if ((m = u.match(/matches\/EUW1_(\d+)$/))) { const i = 9000 - +m[1]; return go(200, match(i, state.me)); }
        if (u.includes('/spectator/')) {
            if (!state.live) return go(404, { status: { message: 'Data not found' } });
            return go(200, { gameId: 777, gameMode: 'CLASSIC', gameQueueConfigId: 420, gameStartTime: Date.now() - 300e3, gameLength: 330, bannedChampions: [{ championId: 11, teamId: 100, pickTurn: 1 }],
                participants: names.map((n, k) => ({ puuid: puuidOf(n), teamId: k < 5 ? 100 : 200, spell1Id: 4, spell2Id: 11, championId: CH[k], riotId: n + '#' + (k ? 'EUW' : 'META'), bot: false, profileIconId: 10 + k, perks: { perkIds: [8112, 8126, 8138, 8135, 8304, 8345, 5008, 5008, 5002], perkStyle: 8100, perkSubStyle: 8300 } })) });
        }
        if (u.includes('platform-data')) return go(200, { id: 'EUW1', name: 'EUW' });
        go(404, {});
    });
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, log, state, port: srv.address().port, puuidOf })));
}

module.exports = { start, puuidOf, OWNER, names, match };
