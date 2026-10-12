// Unit tests for Agent H modules (run with ELECTRON_RUN_AS_NODE=1).
const assert = require('assert');
const { APP, scratch, fixture } = require('../lib/common');
const TLm = require(APP + 'profile-timeline'), SC = require(APP + 'profile-score'), C = require(APP + 'profile-compact');
const { timeline } = require('../lib/timeline-fixture');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };

// ---- timeline ----
const tl = TLm.compactTimeline(timeline('EUW1_1'));
ok(tl.frames.length === 31 && tl.frames[5].g.length === 10, 'frames');
ok(tl.frames[10].c[0] === 59 + 30, 'cs = minions + jungle');
ok(tl.v === 2 && tl.ev.every(e => ['B', 'S', 'U', 'K'].includes(e.k)) && tl.ev.filter(e => e.k === 'K').length === 1, 'only needed events kept: purchases, sales, undos and (v2) kills; no destroyed items');
ok(tl.sk.length === 18 && tl.sk.every(s => s.p === 1), 'EVOLVE skill-ups skipped');
const g = TLm.itemsByMinute(tl.ev, 1);
console.log(JSON.stringify(g));
ok(g[0].m === 0 && g[0].items.map(x => x.i).join() === '1055,2003', 'minute 0 group');
ok(g[1].m === 3 && g[1].items.map(x => x.i).join() === '1036,1037', 'undo removed 1038 (and not 1036/1037)');
ok(g.find(x => x.m === 8).items.map(x => x.i).join() === '3006', 'sale undone -> no sold item shown');
ok(g.find(x => x.m === 14).items[0].i === 3031, 'minute 14');
const sold = TLm.itemsByMinute([{ t: 1000, p: 1, k: 'B', i: 1 }, { t: 61000, p: 1, k: 'S', i: 1 }, { t: 62000, p: 2, k: 'B', i: 7 }], 1);
ok(sold.length === 2 && sold[1].items[0].s === 1 && sold[1].m === 1, 'sale flagged');
const twice = TLm.itemsByMinute([{ t: 0, p: 1, k: 'B', i: 2003 }, { t: 5000, p: 1, k: 'B', i: 2003 }, { t: 6000, p: 1, k: 'U', b: 2003, a: 0 }], 1);
ok(twice[0].items.length === 1, 'undo removes only one of two potions');
ok(TLm.itemsByMinute(tl.ev, 2)[0].items[0].i === 3340, 'other participant isolated');
const sk = TLm.skillOrder(tl.sk, 1);
ok(sk.seq.length === 18 && sk.seq[0] === 1 && sk.seq.filter(x => x === 4).length === 3, 'skill seq');
ok(sk.prio === 'Q > W > E', 'prio ' + sk.prio);
const d = TLm.deriveTimeline(tl, [100, 100, 100, 100, 100, 200, 200, 200, 200, 200]);
ok(d.gold.length === 31 && d.gold[30].d > 0, 'blue ahead at end: ' + d.gold[30].d);
ok(Object.keys(d.players).length === 10, '10 players');
ok(d.v === 2 && d.series.length === 31 && d.series[10].m === 10 && d.series[10].c[0] === 89 && d.series[10].g.length === 10, 'per-minute gold / xp / CS of everyone (Review tab)');
ok(d.kills.length === 1 && d.kills[0].p === 1 && d.kills[0].v === 6 && d.kills[0].m === 9 && Array.isArray(d.kills[0].as), 'kills (v2)');
ok(TLm.deriveTimeline({ ...tl, v: 1 }, null).kills === null, 'a v1 timeline has no kills (the Review tab fetches it again)');
ok(TLm.compactTimeline({}) === null && TLm.deriveTimeline(null) === null, 'null-safe');

// ---- score ----
const R = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
function fakeGame(aram) {
    const dur = 1200 + rnd() * 1200, mins = dur / 60, blueWin = rnd() < 0.5;
    const edge = gauss() * 0.15;     // stomp factor
    const ps = [];
    for (let i = 0; i < 10; i++) {
        const team = i < 5 ? 100 : 200, role = R[i % 5], win = (team === 100) === blueWin, f = Math.exp(gauss() * 0.28 + (win ? 0.08 : -0.08) + edge * (win ? 1 : -1));
        const rolek = { TOP: [2.2, 1.0, 0.9, 6.5, 0.7], JUNGLE: [2.6, 1.3, 0.7, 5, 1], MIDDLE: [3.2, 1.2, 0.55, 7, 0.8], BOTTOM: [3.6, 1.2, 0.5, 7.5, 0.8], UTILITY: [0.8, 2.4, 0.5, 1.2, 2.2] }[role];
        const k = Math.max(0, Math.round(rolek[0] * f * (mins / 25) * (0.5 + rnd()))), a = Math.max(0, Math.round(rolek[1] * 4 * f * (mins / 25) * (0.5 + rnd())));
        const dd = Math.max(0, Math.round((win ? 3.5 : 6) / f * (mins / 25) * (0.5 + rnd())));
        ps.push({ team, win, pos: aram ? '' : role, k, d: dd, a, cs: aram ? 40 : Math.round(rolek[3] * mins * f * 0.95), vis: Math.round(rolek[4] * mins * f * (0.7 + rnd() * 0.6)),
            dmg: Math.round((role === 'UTILITY' ? 8000 : 22000) * f * (mins / 25) * (0.7 + rnd() * 0.6)), taken: Math.round((role === 'TOP' || role === 'JUNGLE' ? 28000 : 17000) * (mins / 25) * (0.7 + rnd() * 0.6)),
            mit: Math.round(8000 * rnd() * (role === 'TOP' ? 3 : 1)), gold: Math.round((role === 'UTILITY' ? 8000 : 12500) * f * (mins / 25)), obj: Math.round(6000 * f * rnd() * (role === 'JUNGLE' ? 3 : 1)), tur: Math.round(2500 * rnd() * f) });
    }
    return { ps, dur };
}
const best = [], worst = [], all = [], winners = [], losers = [];
let mvps = 0, aces = 0, bounds = true;
for (let i = 0; i < 2000; i++) {
    const { ps, dur } = fakeGame(i % 7 === 0), sc = SC.ddScores(ps, { dur, remake: false });
    const ss = sc.map(x => x.score);
    if (ss.some(v => v < 0 || v > 10 || !isFinite(v))) bounds = false;
    best.push(Math.max(...ss)); worst.push(Math.min(...ss)); ss.forEach((v, k) => { all.push(v); (ps[k].win ? winners : losers).push(v); });
    const bd = sc.map(x => x.badge);
    mvps += bd.filter(b => b === 'MVP').length; aces += bd.filter(b => b === 'ACE').length;
    const mv = bd.indexOf('MVP'), ac = bd.indexOf('ACE');
    ok(ps[mv].win && !ps[ac].win, 'MVP on winners, ACE on losers');
    ok(sc.map(x => x.rank).sort((a, b) => a - b).join() === '1,2,3,4,5,6,7,8,9,10', 'ranks 1-10');
    const top = sc.findIndex(x => x.rank === 1); ok(sc[top].badge === 'MVP' || sc[top].badge === 'ACE', 'rank 1 holds a badge');
}
const avg = a => a.reduce((x, y) => x + y, 0) / a.length, q = (a, p) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)];
console.log('score distribution n=%d: mean %s median %s p10 %s p90 %s | best-of-game mean %s (p10 %s) | worst-of-game mean %s | winners %s losers %s | MVP/game %s ACE/game %s',
    all.length, avg(all).toFixed(2), q(all, .5), q(all, .1), q(all, .9), avg(best).toFixed(2), q(best, .1), avg(worst).toFixed(2), avg(winners).toFixed(2), avg(losers).toFixed(2), mvps / 2000, aces / 2000);
ok(bounds, '0-10 bounds');
ok(avg(all) > 5.2 && avg(all) < 5.8, 'typical ~5.5'); ok(avg(best) > 8.3 && avg(best) < 9.7, 'best near 9'); ok(avg(winners) > avg(losers), 'winners score higher');
ok(mvps === 2000 && aces === 2000, 'exactly one MVP and one ACE per game');
const gm = fakeGame(false);
ok(SC.ddScores(gm.ps, { dur: 250, remake: true }).every(x => x === null), 'remake no score');
ok(SC.ddScores(gm.ps, { dur: 250, remake: false }).every(x => x === null), '<300s no score');
ok(SC.ddScores(gm.ps.slice(0, 8), { dur: 1500 }).every(x => x === null), 'non-5v5 no score');
ok(SC.ddScores(gm.ps.map(p => ({ ...p, k: 0, d: 0, a: 0, cs: 0, vis: 0, dmg: 0, taken: 0, mit: 0, gold: 0, obj: 0, tur: 0 })), { dur: 1500 }).every(x => x && x.score >= 0 && x.score <= 10), 'all-zero game safe');

// ---- compactMatch end to end ----
const part = (k, extra = {}) => ({ puuid: 'P' + k, riotIdGameName: 'N' + k, riotIdTagline: 'T', championId: k + 1, teamId: k < 5 ? 100 : 200, win: k < 5, kills: k, deaths: 1, assists: 2, totalMinionsKilled: 100, visionScore: 10, goldEarned: 9000, totalDamageDealtToChampions: 10000 + k * 100, totalDamageTaken: 9000,
    teamPosition: R[k % 5], participantId: k + 1, damageSelfMitigated: 100, damageDealtToObjectives: 500, damageDealtToTurrets: 100,
    perks: { statPerks: { offense: 5008, flex: 5010, defense: 5011 }, styles: [{ style: 8100, selections: [{ perk: 8112 }, { perk: 8126 }, { perk: 8138 }, { perk: 8135 }] }, { style: 8300, selections: [{ perk: 8304 }, { perk: 8345 }] }] }, ...extra });
const raw = (id, over = {}, pex = {}) => ({ metadata: { matchId: id }, info: { queueId: 420, gameDuration: 1500, gameEndTimestamp: 1e12, gameVersion: '16.1.1', participants: Array.from({ length: 10 }, (_, k) => part(k, pex[k])), teams: [], ...over } });
const cm = C.compactMatch(raw('EUW1_1'));
ok(JSON.stringify(cm.players[0].pk) === '[8100,[8112,8126,8138,8135],8300,[8304,8345],[5008,5010,5011]]', 'perks kept');
ok(cm.players[3].pid === 4 && cm.players.every(p => typeof p.sc === 'number' && p.bd), 'pid + score on every player');
ok(cm.players.filter(p => p.bd === 'MVP').length === 1, 'one MVP');
ok(C.compactMatch(raw('EUW1_2', { gameDuration: 200 })).players.every(p => p.sc == null), 'remake: no score fields');
ok(C.compactMatch(raw('EUW1_3', {}, { 4: { gameEndedInEarlySurrender: true } })).players.every(p => p.sc == null), 'early surrender: no score');
ok(C.compactPerks(null) === null, 'perks null-safe');

// ---- played with ----
const mk = (id, mine, mates, win = true, end = 1000) => ({ id, queueId: 420, end, remake: false,
    players: [{ puuid: mine.puuid, name: mine.name, tag: 'X', team: 100, win }, ...mates.map(m => ({ puuid: m.puuid, name: m.name, tag: m.tag || 'EUW', team: 100, win })), { puuid: 'ENEMY', name: 'Foe', tag: 'EUW', team: 200, win: !win }] });
const me = { puuid: 'NEW', name: 'Me' };
const old = { puuid: 'OLD', name: 'Me' };               // same person under an older key
const A = { puuid: 'a1', name: 'Alpha' }, A_old = { puuid: 'a-old', name: 'alpha' }, B = { puuid: 'b1', name: 'Bravo' };
const ms = [mk('1', me, [A, B], true, 5), mk('2', old, [A_old], false, 4), mk('3', me, [A], true, 6), mk('4', old, [B], false, 3), mk('5', me, [{ puuid: 'z', name: 'Once' }], true, 2),
    { ...mk('6', me, [A], true, 1), remake: true }, mk('7', me, [{ puuid: 'nm', name: '' }], true, 1)];
const list = C.playedWith(ms, 'NEW', { gameName: 'Me', tagLine: 'X' });
console.log(JSON.stringify(list));
ok(list.length === 2, 'only >=2 games, no enemy/self/once/remake');
ok(list[0].name === 'Alpha' && list[0].games === 3 && list[0].w === 2 && list[0].l === 1 && list[0].wr === 67, 'puuid change merged by Riot ID (Alpha 3 games 2-1)');
ok(list[1].name === 'Bravo' && list[1].games === 2 && list[1].w === 1, 'Bravo via old match');
ok(C.playedWith(ms, 'NEW', null).find(x => x.name === 'Alpha').games === 2, 'without ident the old-key games are not mine (3 -> 2)');
ok(C.playedWith([], 'NEW', null).length === 0, 'empty');
console.log('t_h OK', n, 'assertions');
