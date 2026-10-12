// desktop-app/profile-insights.js
// Profile "Insights": aggregates over a player's cached compact matches (profile-compact.js). Pure: no I/O, no Electron.
//   overall / champions / roles      games, WR, KDA, kill participation, per-minute damage / gold / CS / vision, damage
//                                    share of the team, deaths per 10 min, DD Score average, MVP/ACE count
//   trend                            the last 60 games in order (for the form chart)
//   lane                             end-of-game gold / CS / damage against the enemy in the same position, and the
//                                    lane opponents met most often
//   habits                           win rate after a win vs after a loss (same session), by game number in a session,
//                                    by time of day and by game length; current streak
//   curve                            win rate by how many times you had played the champion (learning curve)
//   vsLane                           strengths / areas to improve: your stats minus your lane opponent's, per minute
//   draft                            for full Summoner's Rift 5v5 games: both teams' champions by position, so the renderer
//                                    can score each draft with the draft model (backtest)
// Arena (queues 1700 / 1710) and the other non-5v5 modes are never part of these numbers (owner decision 2026-10-11): they have
// their own summary, arenaInsights(): placement instead of win / loss. CS, gold and vision per minute are Summoner's Rift only
// (SR_QUEUES in profile-compact.js): ARAM and other modes count for win rate, KDA, damage and score, but not for those averages
// (null = no Summoner's Rift game in the selection).
const { findMe, isExcludedFromAll, isSrQueue, ARENA_QUEUES, arenaWinPlaces } = require('./profile-compact');

const POSITIONS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const SESSION_GAP_MS = 60 * 60 * 1000;   // a new session starts after a 60 min break

function newAgg() { return { g: 0, w: 0, k: 0, d: 0, a: 0, kp: 0, cs: 0, dmg: 0, gold: 0, vis: 0, sec: 0, srSec: 0, srCs: 0, srGold: 0, srVis: 0, sc: 0, scN: 0, share: 0, shareN: 0, mvp: 0, ace: 0 }; }
function add(a, g) {
    a.g++; a.w += g.w ? 1 : 0; a.k += g.k; a.d += g.d; a.a += g.a; a.kp += g.kp || 0;
    a.cs += g.cs; a.dmg += g.dmg; a.gold += g.gold; a.vis += g.vis; a.sec += g.dur;
    if (g.sr) { a.srSec += g.dur; a.srCs += g.cs; a.srGold += g.gold; a.srVis += g.vis; }
    if (typeof g.sc === 'number') { a.sc += g.sc; a.scN++; }
    if (g.share != null) { a.share += g.share; a.shareN++; }
    if (g.bd === 'MVP') a.mvp++; else if (g.bd === 'ACE') a.ace++;
}
function fin(a) {
    const min = a.sec / 60, srMin = a.srSec / 60;
    return {
        g: a.g, w: a.w, wr: a.g ? a.w / a.g : 0,
        k: a.g ? a.k / a.g : 0, d: a.g ? a.d / a.g : 0, a: a.g ? a.a / a.g : 0,
        kda: a.d ? (a.k + a.a) / a.d : null,               // null = perfect (no deaths)
        kp: a.g ? a.kp / a.g / 100 : 0,
        csMin: srMin ? a.srCs / srMin : null, dmgMin: min ? a.dmg / min : 0, goldMin: srMin ? a.srGold / srMin : null, visMin: srMin ? a.srVis / srMin : null,
        deaths10: min ? a.d / min * 10 : 0,
        score: a.scN ? a.sc / a.scN : null,
        share: a.shareN ? a.share / a.shareN : null,
        mvp: a.mvp, ace: a.ace
    };
}
function groupBy(games, keyOf) {
    const m = new Map();
    for (const g of games) { const k = keyOf(g); if (k == null) continue; if (!m.has(k)) m.set(k, newAgg()); add(m.get(k), g); }
    return m;
}
function rate(list) { const n = list.length, w = list.filter(Boolean).length; return { n, w, wr: n ? w / n : null }; }

function gameOf(cm, puuid, ident) {
    if (!cm || cm.remake || !Array.isArray(cm.players)) return null;
    const me = findMe(cm, puuid, ident);
    if (!me) return null;
    const team = cm.players.filter(p => p.team === me.team), enemy = cm.players.filter(p => p.team !== me.team);
    const teamDmg = team.reduce((t, p) => t + (p.dmg || 0), 0);
    const opp = me.pos ? enemy.find(p => p.pos === me.pos) : null;
    const dur = cm.dur || 0;
    const g = {
        id: cm.id, q: cm.queueId, sr: isSrQueue(cm.queueId), end: cm.end || 0, start: (cm.end || 0) - dur * 1000, dur, patch: cm.patch || '',
        c: me.champId, pos: POSITIONS.includes(me.pos) ? me.pos : null, w: !!me.win,
        k: me.k || 0, d: me.d || 0, a: me.a || 0, kp: me.kp || 0, cs: me.cs || 0, dmg: me.dmg || 0, gold: me.gold || 0, vis: me.vis || 0,
        sc: typeof me.sc === 'number' ? me.sc : null, bd: me.bd || null, share: teamDmg > 0 ? (me.dmg || 0) / teamDmg : null,
        opp: opp ? { c: opp.champId, gold: (me.gold || 0) - (opp.gold || 0), cs: (me.cs || 0) - (opp.cs || 0), dmg: (me.dmg || 0) - (opp.dmg || 0),
            vis: (me.vis || 0) - (opp.vis || 0), deaths: (me.d || 0) - (opp.d || 0), kp: (me.kp || 0) - (opp.kp || 0) } : null,
        draft: null
    };
    const full = cm.mode === 'CLASSIC' && cm.players.length === 10 && cm.players.every(p => POSITIONS.includes(p.pos));
    if (full) {
        const side = ps => { const o = {}; for (const p of ps) o[p.pos] = p.champId; return o; };
        const my = side(team), en = side(enemy);
        if (Object.keys(my).length === 5 && Object.keys(en).length === 5) g.draft = { my, enemy: en };
    }
    return g;
}

// Learning curve (leagueofgraphs-style): win rate by how many times you had already played the champion (among the saved
// games, oldest first). games: oldest first, each with c (champion) and w.
const CURVE_BUCKETS = [['Games 1–3', 1, 3], ['Games 4–10', 4, 10], ['Games 11–25', 11, 25], ['Game 26+', 26, Infinity]];
function learningCurve(games) {
    const seen = new Map();
    const nth = games.map(g => { const n = (seen.get(g.c) || 0) + 1; seen.set(g.c, n); return { n, w: g.w }; });
    return CURVE_BUCKETS.map(([label, lo, hi]) => ({ label, ...rate(nth.filter(x => x.n >= lo && x.n <= hi).map(x => x.w)) }));
}

// Strengths and areas to improve: your stat minus your lane opponent's in the same games (same position, other team), per
// minute where that makes sense. A stat counts as a strength / weakness when the average gap is at least 0.2 of its spread
// (a small but real effect) and at least 2 standard errors away from 0 (not just a few lucky games).
const LANE_STATS = [
    { k: 'cs', label: 'CS per minute', unit: '/min', perMin: true, digits: 2 },
    { k: 'gold', label: 'Gold per minute', unit: '/min', perMin: true, digits: 0 },
    { k: 'dmg', label: 'Damage to champions per minute', unit: '/min', perMin: true, digits: 0 },
    { k: 'vis', label: 'Vision score per minute', unit: '/min', perMin: true, digits: 2 },
    { k: 'kp', label: 'Kill participation', unit: ' pts', perMin: false, digits: 1 },
    { k: 'deaths', label: 'Deaths', unit: '', perMin: false, digits: 2, lowerBetter: true }
];
const VS_MIN_GAMES = 8, VS_MIN_EFFECT = 0.2, VS_MIN_Z = 2;
function vsLaneOpponents(laned) {
    const list = laned.filter(g => g.dur >= 600);   // 10+ minutes so per-minute numbers mean something
    const stats = LANE_STATS.map(s => {
        const xs = list.map(g => (s.perMin ? g.opp[s.k] / (g.dur / 60) : g.opp[s.k])).filter(v => Number.isFinite(v));
        const n = xs.length;
        if (n < VS_MIN_GAMES) return { ...s, n, mean: null };
        const mean = xs.reduce((t, v) => t + v, 0) / n;
        const sd = Math.sqrt(xs.reduce((t, v) => t + (v - mean) ** 2, 0) / (n - 1)) || 0;
        const good = s.lowerBetter ? -mean : mean;                 // positive = better than the opponent
        const effect = sd > 0 ? good / sd : 0, z = sd > 0 ? good / (sd / Math.sqrt(n)) : 0;
        const ahead = xs.filter(v => (s.lowerBetter ? v < 0 : v > 0)).length / n;
        return { ...s, n, mean, sd, effect, z, ahead, verdict: Math.abs(effect) >= VS_MIN_EFFECT && Math.abs(z) >= VS_MIN_Z ? (effect > 0 ? 'strength' : 'weakness') : 'even' };
    });
    return { n: list.length, stats, strengths: stats.filter(s => s.verdict === 'strength').sort((a, b) => b.effect - a.effect), weaknesses: stats.filter(s => s.verdict === 'weakness').sort((a, b) => a.effect - b.effect) };
}

function insights(matches, puuid, ident) {
    const games = (matches || []).filter(cm => cm && !isExcludedFromAll(cm.queueId, cm.mode)).map(cm => gameOf(cm, puuid, ident)).filter(Boolean).sort((a, b) => a.end - b.end);
    const overall = newAgg();
    for (const g of games) add(overall, g);

    const champions = [...groupBy(games, g => g.c)].map(([c, a]) => ({ c, ...fin(a) })).sort((x, y) => y.g - x.g || y.wr - x.wr);
    const roles = [...groupBy(games, g => g.pos)].map(([pos, a]) => ({ pos, ...fin(a) })).sort((x, y) => y.g - x.g);

    // lane: against the enemy in the same position
    const laned = games.filter(g => g.opp);
    const lane = {
        n: laned.length,
        aheadGold: laned.length ? laned.filter(g => g.opp.gold > 0).length / laned.length : null,
        avgGold: laned.length ? laned.reduce((t, g) => t + g.opp.gold, 0) / laned.length : null,
        avgCs: laned.length ? laned.reduce((t, g) => t + g.opp.cs, 0) / laned.length : null,
        avgDmg: laned.length ? laned.reduce((t, g) => t + g.opp.dmg, 0) / laned.length : null,
        wrAhead: rate(laned.filter(g => g.opp.gold > 0).map(g => g.w)).wr,
        wrBehind: rate(laned.filter(g => g.opp.gold <= 0).map(g => g.w)).wr,
        opponents: [...groupBy(laned, g => g.opp.c)].map(([c, a]) => {
            const gs = laned.filter(g => g.opp.c === c);
            return { c, g: a.g, w: a.w, wr: a.w / a.g, gold: gs.reduce((t, x) => t + x.opp.gold, 0) / gs.length };
        }).sort((x, y) => y.g - x.g || x.wr - y.wr).slice(0, 10)
    };

    // habits: sessions (60 min break), after a win / loss in the same session, time of day, game length
    let session = 0, pos = 0;
    games.forEach((g, i) => {
        const prev = games[i - 1];
        if (!prev || g.start - prev.end > SESSION_GAP_MS) { session++; pos = 1; } else pos++;
        g.session = session; g.inSession = pos; g.prevW = prev && g.session === prev.session ? prev.w : null;
    });
    const sessionPos = [1, 2, 3].map(n => ({ label: `Game ${n}`, ...rate(games.filter(g => g.inSession === n).map(g => g.w)) }))
        .concat([{ label: 'Game 4+', ...rate(games.filter(g => g.inSession >= 4).map(g => g.w)) }]);
    const tod = [['Night', 0, 6], ['Morning', 6, 12], ['Afternoon', 12, 18], ['Evening', 18, 24]].map(([label, a, b]) => ({
        label, hours: `${String(a).padStart(2, '0')}–${String(b).padStart(2, '0')}`,
        ...rate(games.filter(g => { const h = new Date(g.start).getHours(); return h >= a && h < b; }).map(g => g.w))
    }));
    const length = [['Under 25 min', 0, 1500], ['25–35 min', 1500, 2100], ['Over 35 min', 2100, Infinity]]
        .map(([label, a, b]) => ({ label, ...rate(games.filter(g => g.dur >= a && g.dur < b).map(g => g.w)) }));
    let streak = null;
    for (let i = games.length - 1; i >= 0; i--) {
        if (!streak) streak = { win: games[i].w, n: 1 };
        else if (games[i].w === streak.win) streak.n++;
        else break;
    }
    const habits = {
        afterWin: rate(games.filter(g => g.prevW === true).map(g => g.w)),
        afterLoss: rate(games.filter(g => g.prevW === false).map(g => g.w)),
        sessionPos, timeOfDay: tod, length, streak,
        sessions: session, avgSession: session ? games.length / session : 0
    };

    return {
        n: games.length,
        overall: fin(overall),
        champions, roles, lane, habits,
        curve: learningCurve(games),
        vsLane: vsLaneOpponents(laned),
        trend: games.slice(-60).map(g => ({ id: g.id, end: g.end, w: g.w, sc: g.sc, c: g.c, k: g.k, d: g.d, a: g.a, bd: g.bd })),
        draft: games.filter(g => g.draft).map(g => ({ id: g.id, end: g.end, patch: g.patch, q: g.q, w: g.w, my: g.draft.my, enemy: g.draft.enemy }))
    };
}

// Arena: placement instead of win / loss. The "win" of the mode is a finish in the better half of the lobby (top 4 of 8 pairs, top 3
// of 6 trios: per game, from its own lobby). matches: compact matches (any queue; only Arena games are used). Returns the average
// placement, the top-half rate (`topHalf`), how often each place was reached (`dist`, as many places as the largest lobby) and a
// champion table.
function arenaInsights(matches, puuid, ident) {
    const games = [];
    for (const cm of matches || []) {
        if (!cm || cm.remake || !Array.isArray(cm.players) || !(cm.mode === 'CHERRY' || ARENA_QUEUES.includes(cm.queueId))) continue;
        const me = findMe(cm, puuid, ident);
        if (!me || !(me.plc >= 1 && me.plc <= 8)) continue;
        const duo = me.sub ? cm.players.find(p => p !== me && p.sub === me.sub) : null;
        const wp = cm.winPlaces || arenaWinPlaces(cm.players, cm.queueId);
        games.push({ id: cm.id, end: cm.end || 0, c: me.champId, plc: me.plc, win: me.plc <= wp, places: wp * 2, k: me.k || 0, d: me.d || 0, a: me.a || 0, dmg: me.dmg || 0, dur: cm.dur || 0, duo: duo ? { name: duo.name, tag: duo.tag, c: duo.champId } : null });
    }
    games.sort((x, y) => x.end - y.end);
    const sum = (list, f) => list.reduce((t, g) => t + f(g), 0);
    const stat = list => ({ g: list.length, avg: list.length ? sum(list, g => g.plc) / list.length : null, topHalf: list.length ? list.filter(g => g.win).length / list.length : null,
        first: list.filter(g => g.plc === 1).length, k: sum(list, g => g.k), d: sum(list, g => g.d), a: sum(list, g => g.a) });
    const byChamp = new Map();
    for (const g of games) { if (!byChamp.has(g.c)) byChamp.set(g.c, []); byChamp.get(g.c).push(g); }
    const o = stat(games);
    return {
        n: games.length, avgPlace: o.avg, topHalf: o.topHalf, firsts: o.first,
        kda: o.d ? (o.k + o.a) / o.d : null,
        places: Math.max(0, ...games.map(g => g.places)) || 8,
        dist: Array.from({ length: Math.max(0, ...games.map(g => g.places)) || 8 }, (_, i) => games.filter(g => g.plc === i + 1).length),
        lobbies: [...new Set(games.map(g => g.places))].sort((a, b) => a - b),   // 6 and / or 8 teams
        champions: [...byChamp].map(([c, list]) => ({ c, ...stat(list) })).sort((x, y) => y.g - x.g || x.avg - y.avg),
        duos: arenaDuos(games),
        trend: games.slice(-60).map(g => ({ id: g.id, end: g.end, plc: g.plc, win: g.win, c: g.c }))
    };
}
function arenaDuos(games) {
    const m = new Map();
    for (const g of games) {
        if (!g.duo || !g.duo.name) continue;
        const k = (g.duo.name + '#' + g.duo.tag).toLowerCase();
        const e = m.get(k) || { name: g.duo.name, tag: g.duo.tag, g: 0, plc: 0, wins: 0 };
        e.g++; e.plc += g.plc; if (g.win) e.wins++;
        m.set(k, e);
    }
    return [...m.values()].filter(e => e.g >= 2).map(e => ({ name: e.name, tag: e.tag, g: e.g, avg: e.plc / e.g, topHalf: e.wins / e.g })).sort((x, y) => y.g - x.g || x.avg - y.avg).slice(0, 5);
}

module.exports = { insights, arenaInsights, gameOf, learningCurve, vsLaneOpponents, SESSION_GAP_MS, CURVE_BUCKETS, VS_MIN_GAMES };
