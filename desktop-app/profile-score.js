// desktop-app/profile-score.js
// "DD Score": an op.gg-style 0-10 performance score computed per game for all 10 players (op.gg's exact formula is not public).
// Pure functions, no I/O.
//
// Per player, nine components are each expressed relative to the game (value / game mean, so an average player is ~1.0):
//   kda   (k + 0.8a + 1) / (d + 1)             kp    (k + a) / team kills           dmg   damage to champions
//   tank  damage taken + self-mitigated         gold  gold earned                    obj   damage to objectives + turrets
//   cs    cs/min vs a role expectation          vis   vision score/min vs role expectation      surv  2 - deaths / mean deaths
// Components are capped (2.5; cs/vis 1.6/2.2) and combined with ROLE-AWARE weights (each row sums to 1, see W below):
// carries weight damage/gold/cs, junglers kills+objectives, supports vision/KP/tank, tops tank+objective damage.
// A win adds +0.07 to the combined value R. R is standardised inside the game (z = (R - mean) / sd) and mapped to
// score = 5.4 + 2.3 z, clamped to [0, 10] -> the best player of a game lands near 9-10, a typical one ~5-6, the worst ~1-3.
// Rank 1-10 by score; badge: MVP = best on the winning team, ACE = best on the losing team, others get their game rank.
// Remakes (< 300 s or early surrender) and non 5v5 modes (Arena...) get no score.

const W = {
    //            kda   kp    dmg   tank  gold  cs    vis   obj   surv
    TOP:      [0.18, 0.10, 0.16, 0.12, 0.12, 0.08, 0.05, 0.12, 0.07],
    JUNGLE:   [0.18, 0.16, 0.14, 0.08, 0.10, 0.04, 0.08, 0.16, 0.06],
    MIDDLE:   [0.20, 0.12, 0.22, 0.04, 0.14, 0.08, 0.05, 0.08, 0.07],
    BOTTOM:   [0.20, 0.10, 0.24, 0.03, 0.14, 0.10, 0.04, 0.09, 0.06],
    UTILITY:  [0.18, 0.20, 0.06, 0.12, 0.04, 0.00, 0.24, 0.06, 0.10],
    ANY:      [0.24, 0.14, 0.24, 0.10, 0.12, 0.00, 0.00, 0.08, 0.08] // ARAM and other modes without lanes
};
const CS_EXP = { TOP: 6.5, JUNGLE: 5.0, MIDDLE: 7.0, BOTTOM: 7.5, UTILITY: 1.2 };   // expected cs/min by role
const VIS_EXP = { TOP: 0.7, JUNGLE: 1.0, MIDDLE: 0.8, BOTTOM: 0.8, UTILITY: 2.2 };  // expected vision score/min by role
const BASE = 5.4, SPREAD = 2.3, WIN_BONUS = 0.07;
const ORD = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);

// players: compact players ({k,d,a,cs,vis,dmg,taken,mit,gold,obj,tur,pos,team,win}); returns an array aligned with `players`
// of { score, rank, badge } or null (no score). opts: { dur (seconds), remake, sr }
// sr === false (not a Summoner's Rift queue: ARAM, URF, ...) turns the role weights and the CS / vision expectations off: such games
// are scored with the lane-less weights (ANY). Arena (16 players) and the other non-5v5 modes are never scored.
function ddScores(players, opts) {
    const none = () => (players || []).map(() => null);
    if (!players || players.length !== 10 || !opts || opts.remake || !(opts.dur >= 300)) return none();
    const teams = new Set(players.map(p => p.team));
    if (teams.size !== 2) return none();
    const mins = opts.dur / 60;
    const teamKills = {};
    for (const p of players) teamKills[p.team] = (teamKills[p.team] || 0) + (p.k || 0);
    const lanes = opts.sr !== false && players.filter(p => W[p.pos] && p.pos).length >= 8;
    const rel = vals => { const m = mean(vals); return vals.map(v => (m > 0 ? v / m : 1)); };
    const kda = rel(players.map(p => ((p.k || 0) + 0.8 * (p.a || 0) + 1) / ((p.d || 0) + 1)));
    const kp = rel(players.map(p => ((p.k || 0) + (p.a || 0)) / Math.max(1, teamKills[p.team])));
    const dmg = rel(players.map(p => p.dmg || 0));
    const tank = rel(players.map(p => (p.taken || 0) + (p.mit || 0)));
    const gold = rel(players.map(p => p.gold || 0));
    const obj = rel(players.map(p => (p.obj || 0) + (p.tur || 0)));
    const meanD = mean(players.map(p => p.d || 0));
    const R = players.map((p, i) => {
        const role = lanes && W[p.pos] ? p.pos : 'ANY', w = W[role];
        const c = [
            Math.min(2.5, kda[i]), Math.min(2.5, kp[i]), Math.min(2.5, dmg[i]), Math.min(2.5, tank[i]), Math.min(2.5, gold[i]),
            role === 'ANY' ? 0 : Math.min(1.6, ((p.cs || 0) / mins) / CS_EXP[role]),
            role === 'ANY' ? 0 : Math.min(2.2, ((p.vis || 0) / mins) / VIS_EXP[role]),
            Math.min(2.5, obj[i]),
            meanD > 0 ? clamp(2 - (p.d || 0) / meanD, 0, 2) : 1
        ];
        let r = 0;
        for (let k = 0; k < 9; k++) r += w[k] * c[k];
        return r + (p.win ? WIN_BONUS : 0);
    });
    const m = mean(R), sd = Math.sqrt(mean(R.map(x => (x - m) ** 2))) || 1;
    const score = R.map(x => Math.round(clamp(BASE + SPREAD * (x - m) / sd, 0, 10) * 10) / 10);
    const order = players.map((_, i) => i).sort((x, y) => R[y] - R[x] || x - y);
    const rank = new Array(10);
    order.forEach((i, pos) => { rank[i] = pos + 1; });
    const best = {};
    for (const i of order) if (best[players[i].team] == null) best[players[i].team] = i;
    return players.map((p, i) => ({
        score: score[i], rank: rank[i],
        badge: best[p.team] === i ? (p.win ? 'MVP' : 'ACE') : ORD[rank[i]]
    }));
}

module.exports = { ddScores, W, CS_EXP, VIS_EXP, BASE, SPREAD, WIN_BONUS };
