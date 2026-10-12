// desktop-app/profile-live.js
// Pure helpers for the Live game view: player tags, premade detection and team overviews. No I/O, so it is unit tested.
//
// Player shape these functions read (everything is optional, a missing field just means "unknown"):
//   { idx, teamId, championId, bot, spell1Id, spell2Id,
//     ranked:[league entries], mastery:{level,points}, summonerLevel,
//     champ:{games,wins,...}            champion stats from cached matches (all queues, recent)
//     og:{state, champ:{g,w,...}, all:{g,w}, roles:{TOP:{pct,g}}, peak}   op.gg data (ranked solo, current season)
//     form:{results:[true|false,...]}   most recent game first (cached games or the "Last 5" scout) }

// ---- tag thresholds: the single place to tune the rules -------------------------------------------------------------
const THRESHOLDS = {
    streak: 3,                 // Hot streak / Loss streak: this many wins (losses) in a row among the most recent games
    veteranGames: 100,         // Veteran: ranked solo games this season (league-v4 wins + losses)
    newChampMaxGames: 1,       // New to champ: at most this many ranked games on the champion this season (op.gg)
    newChampLowMastery: 10000, // ... or, without op.gg numbers, champion mastery points below this
    newChampKnownMastery: 50000, // a player with this many mastery points is not "new" even if ranked games are few
    oneTrickShare: 0.6,        // One-trick: share of this season's ranked games on this champion ...
    oneTrickMinGames: 10,      // ... with at least this many games on it ...
    oneTrickMinTotal: 15,      // ... out of at least this many ranked games
    autofillMainShare: 0.5,    // Autofill: the player's main role has at least this share of ranked games ...
    autofillOffShare: 0.15,    // ... and the role they are playing now has less than this share (needs >= autofillMinGames)
    autofillMinGames: 15,
    smurfLevel: 40,            // Smurf?: account level at most this (only known for cached profiles) with a winning record ...
    smurfLevelMinGames: 10,
    smurfLevelWr: 55,
    smurfGamesMin: 15,         // ... or a short ranked record (smurfGamesMin..smurfGamesMax games) with a very high win rate
    smurfGamesMax: 60,
    smurfWr: 65,
    premadeMinShared: 2,       // Premade: two teammates seen together in at least this many cached matches ...
    premadeRecentMs: 24 * 3600e3 // ... or in one cached match that ended within this long ago (match-id lists: one shared recent match is enough)
};

const SMITE = 11;
const TAG_DEFS = {
    hot: { label: 'Hot streak', cls: 'good' },
    tilt: { label: 'Loss streak', cls: 'bad' },
    veteran: { label: 'Veteran', cls: 'info' },
    first: { label: 'First time', cls: 'warn' },
    newchamp: { label: 'New to champ', cls: 'warn' },
    autofill: { label: 'Autofill', cls: 'warn' },
    onetrick: { label: 'One-trick', cls: 'purple' },
    smurf: { label: 'Smurf?', cls: 'bad' }
};
const ROLE_NAME = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', UTILITY: 'Support' };

const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
const soloOf = p => (Array.isArray(p.ranked) ? p.ranked.find(e => e && e.queueType === 'RANKED_SOLO_5x5') : null) || null;

function streakOf(results) {      // { win:n } or { loss:n } for the most recent games, results[0] = latest
    if (!Array.isArray(results) || !results.length) return { win: 0, loss: 0 };
    const first = !!results[0];
    let n = 0;
    for (const r of results) { if (!!r === first) n++; else break; }
    return first ? { win: n, loss: 0 } : { win: 0, loss: n };
}

// Most played role of a player from op.gg's role share, or null when unknown / too few games.
function mainRole(roles) {
    if (!roles || typeof roles !== 'object') return null;
    let best = null, total = 0;
    for (const [k, v] of Object.entries(roles)) {
        const g = num(v && v.g) || 0; total += g;
        if (!best || g > best.g) best = { role: k, g, pct: num(v && v.pct) };
    }
    return best && total > 0 ? { ...best, total } : null;
}

// Tags for one player -> [{ id, label, cls, tip }]
function computeTags(p, T = THRESHOLDS) {
    const out = [];
    if (!p || p.bot) return out;
    const add = (id, tip) => out.push({ id, label: TAG_DEFS[id].label, cls: TAG_DEFS[id].cls, tip });
    const solo = soloOf(p);
    const games = solo ? (solo.wins | 0) + (solo.losses | 0) : null;
    const wr = games ? (solo.wins / games) * 100 : null;
    const og = p.og && p.og.state === 'ok' ? p.og : null;

    // streaks: recent results when known, else the league flag (hotStreak = 3+ wins in a row)
    const st = streakOf(p.form && p.form.results);
    const nForm = p.form && p.form.results ? p.form.results.length : 0;
    if (st.win >= T.streak) add('hot', `${st.win} wins in a row in the most recent ${nForm} games (rule: ${T.streak}+ in a row).`);
    else if (st.loss >= T.streak) add('tilt', `${st.loss} losses in a row in the most recent ${nForm} games (rule: ${T.streak}+ in a row).`);
    else if (!nForm && solo && solo.hotStreak) add('hot', 'Riot reports a win streak in ranked solo (3+ wins in a row).');

    if (games != null && games >= T.veteranGames) add('veteran', `${games} ranked solo games this season (rule: ${T.veteranGames}+).`);

    // champion experience: op.gg season numbers first, then mastery
    const m = p.mastery && num(p.mastery.points) != null ? p.mastery : null;
    // op.gg lists only a player's most-played champions: an unlisted champion has an unknown count, at most the smallest listed one
    const cg = og && og.champ ? (og.champ.g != null ? og.champ.g : (og.champ.max != null && og.champ.max <= T.newChampMaxGames ? og.champ.max : null)) : null;
    if (cg != null) {
        if (cg === 0 && m && m.points === 0) add('first', 'No ranked games on this champion this season and no mastery points.');
        else if (cg <= T.newChampMaxGames && !(m && m.points >= T.newChampKnownMastery)) add('newchamp', `${cg} ranked solo game${cg === 1 ? '' : 's'} on this champion this season${m ? ` and ${m.points.toLocaleString('en-US')} mastery points` : ''} (rule: at most ${T.newChampMaxGames} game).`);
    } else if (m) {
        if (m.points === 0) add('first', 'No mastery points on this champion.');
        else if (m.points < T.newChampLowMastery) add('newchamp', `Only ${m.points.toLocaleString('en-US')} mastery points on this champion (rule: under ${T.newChampLowMastery.toLocaleString('en-US')}).`);
    }

    // one-trick: share of the season's ranked games on this champion
    if (og && og.champ && og.champ.g != null && og.all && og.all.g >= T.oneTrickMinTotal && og.champ.g >= T.oneTrickMinGames && og.champ.g / og.all.g >= T.oneTrickShare) {
        add('onetrick', `${og.champ.g} of ${og.all.g} ranked solo games this season (${Math.round(og.champ.g / og.all.g * 100)}%) are on this champion (rule: ${Math.round(T.oneTrickShare * 100)}%+).`);
    }

    // autofill: the live APIs carry no lane, so Jungle is read from Smite; other lanes are not guessed
    const mr = og ? mainRole(og.roles) : null;
    if (mr && mr.total >= T.autofillMinGames) {
        const hasSmite = p.spell1Id === SMITE || p.spell2Id === SMITE;
        const share = r => (og.roles[r] && num(og.roles[r].g) ? og.roles[r].g / mr.total : 0);
        if (hasSmite && mr.role !== 'JUNGLE' && mr.g / mr.total >= T.autofillMainShare && share('JUNGLE') < T.autofillOffShare) {
            add('autofill', `Playing Jungle (Smite) but mostly ${ROLE_NAME[mr.role] || mr.role} this season (${Math.round(mr.g / mr.total * 100)}% of ranked games; Jungle ${Math.round(share('JUNGLE') * 100)}%).`);
        } else if (!hasSmite && mr.role === 'JUNGLE' && mr.g / mr.total >= T.autofillMainShare && p.spell1Id != null) {
            add('autofill', `Jungle main (${Math.round(mr.g / mr.total * 100)}% of ranked games) without Smite, so probably on another lane.`);
        }
    }

    // smurf?
    const lvl = num(p.summonerLevel);
    if (wr != null) {
        if (lvl != null && lvl <= T.smurfLevel && games >= T.smurfLevelMinGames && wr >= T.smurfLevelWr) add('smurf', `Account level ${lvl} (rule: ${T.smurfLevel} or less) with ${Math.round(wr)}% win rate over ${games} ranked games.`);
        else if (games >= T.smurfGamesMin && games <= T.smurfGamesMax && wr >= T.smurfWr) add('smurf', `${Math.round(wr)}% win rate over only ${games} ranked solo games (rule: ${T.smurfWr}%+ within ${T.smurfGamesMin}-${T.smurfGamesMax} games).`);
    }
    return out;
}

// ---- op.gg champion list -> the live player's champion ------------------------------------------------------------------
const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// data: { all, list[{key,name,g,w,l,k,d,a,kda,cs}], empty }, champ: { name, id } (Data Dragon). -> { champ, all, top }
// champ.g is null when the champion is not among the listed ones and the listed games do not add up to the season total.
function resolveChamp(data, champ) {
    if (!data) return null;
    const list = data.list || [];
    const out = { all: data.all || null, top: list.slice(0, 5) };
    if (data.empty || !list.length) { out.champ = { g: 0, w: 0, l: 0, exact: true }; return out; }
    if (!champ) { out.champ = null; return out; }
    const names = new Set([normName(champ.name), normName(champ.id)].filter(Boolean));
    const hit = list.find(x => names.has(normName(x.key)) || names.has(normName(x.name)));
    if (hit) { out.champ = { ...hit, exact: true }; return out; }
    const listed = list.reduce((a, x) => a + x.g, 0);
    if (data.all && listed >= data.all.g) out.champ = { g: 0, w: 0, l: 0, exact: true };
    else out.champ = { g: null, max: Math.min(...list.map(x => x.g)), exact: false };
    return out;
}

// ---- ranks ------------------------------------------------------------------------------------------------------------
const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
const DIV = { IV: 0, III: 1, II: 2, I: 3 }, DIV_NAME = ['IV', 'III', 'II', 'I'];
const APEX_BASE = 7 * 400;
function rankScore(e) {
    if (!e) return null;
    const t = TIERS.indexOf(e.tier); if (t < 0) return null;
    const lp = e.leaguePoints | 0;
    if (t >= 7) return APEX_BASE + lp;       // Master/Grandmaster/Challenger are one band (LP only)
    return t * 400 + (DIV[e.rank] != null ? DIV[e.rank] : 0) * 100 + Math.min(99, lp);
}
function scoreToRank(s) {
    if (s == null) return null;
    if (s >= APEX_BASE) {
        return { tier: 'MASTER', rank: 'I', lp: Math.round(s - APEX_BASE), apex: true };   // shown as Master+
    }
    const t = Math.min(6, Math.floor(s / 400)), r = s - t * 400;
    return { tier: TIERS[t], rank: DIV_NAME[Math.min(3, Math.floor(r / 100))], lp: Math.round(r % 100) };
}
// Per team: average solo rank (unranked players are left out), average ranked WR, how many were counted.
function teamSummary(players) {
    const ps = (players || []).filter(p => p && !p.bot);
    const scores = [], wrs = [];
    let known = 0;
    for (const p of ps) {
        const solo = soloOf(p);
        if (p.ranked !== undefined && p.ranked !== null) known++;
        if (!solo) continue;
        const sc = rankScore(solo); if (sc != null) scores.push(sc);
        const g = (solo.wins | 0) + (solo.losses | 0);
        if (g > 0) wrs.push(solo.wins / g * 100);
    }
    const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const as = avg(scores), aw = avg(wrs);
    return {
        players: ps.length, loaded: known, ranked: scores.length,
        avgRank: as == null ? null : scoreToRank(as),
        avgWr: aw == null ? null : Math.round(aw)
    };
}

// ---- premades ---------------------------------------------------------------------------------------------------------
// players: [{idx, teamId}]; evidence: [{a, b, src:'party'|'match'|'ids', n}] pairs of idx.
// Players of one team joined through evidence form a group: 2 = Duo, 3+ = Premade n. Pairs across teams are ignored.
const GROUP_COLORS = ['#f59e0b', '#22d3ee', '#a78bfa', '#f472b6', '#84cc16', '#fb7185'];
function detectPremades(players, evidence) {
    const team = new Map((players || []).map(p => [p.idx, p.teamId]));
    const parent = new Map();
    const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const ev = new Map();     // component -> sources
    const edges = [];
    for (const e of evidence || []) {
        if (!e || e.a === e.b || !team.has(e.a) || !team.has(e.b) || team.get(e.a) !== team.get(e.b)) continue;
        for (const x of [e.a, e.b]) if (!parent.has(x)) parent.set(x, x);
        edges.push(e);
        const ra = find(e.a), rb = find(e.b);
        if (ra !== rb) parent.set(ra, rb);
    }
    const groups = new Map();
    for (const x of parent.keys()) { const r = find(x); (groups.get(r) || groups.set(r, []).get(r)).push(x); }
    const out = [];
    for (const members of groups.values()) {
        if (members.length < 2) continue;
        members.sort((a, b) => a - b);
        const set = new Set(members);
        const src = [...new Set(edges.filter(e => set.has(e.a)).map(e => e.src))];
        out.push({ team: team.get(members[0]), members, size: members.length, kind: members.length === 2 ? 'Duo' : `Premade ${members.length}`, src });
    }
    out.sort((a, b) => a.members[0] - b.members[0]);
    out.forEach((g, i) => { g.id = i; g.color = GROUP_COLORS[i % GROUP_COLORS.length]; });
    return out;
}

// Pair evidence from recent match-id lists: two same-team players sharing a match id played that game together
// (or, vanishingly rarely, against each other; a cached match settles it). idLists: Map idx -> string[]; sameTeam(id, a, b)
// -> true | false | null (null: match not cached, assume same team).
function pairsFromIds(idLists, sameTeam) {
    const out = [];
    const keys = [...idLists.keys()];
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
        const A = idLists.get(keys[i]) || [], B = new Set(idLists.get(keys[j]) || []);
        const shared = [];
        for (const id of A) if (B.has(id)) { const st = sameTeam ? sameTeam(id, keys[i], keys[j]) : null; if (st !== false) shared.push(id); }
        if (shared.length > 0) out.push({ a: keys[i], b: keys[j], src: 'ids', n: shared.length, ids: shared });
    }
    return out;
}

module.exports = { resolveChamp, normName, THRESHOLDS, TAG_DEFS, ROLE_NAME, computeTags, streakOf, mainRole, rankScore, scoreToRank, teamSummary, detectPremades, pairsFromIds, GROUP_COLORS };
