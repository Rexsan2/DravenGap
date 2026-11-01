// A raw match-v5 game for tests: 10 players (5v5) or 16 (Arena); the owner (puuid ME) is participant 0.
// Usage: const raw = require('../lib/raw-match')(ME, NOW); raw('EUW1_1', { queueId: 420, dur: 1500, win: false })
const POS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
module.exports = (ME, NOW) => function raw(id, { queueId, mode = 'CLASSIC', cs = 240, dur = 1800, ageH = 1, champ = 103, win = true, placement = 0, positions = true, gold = 12000 }) {
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
};
