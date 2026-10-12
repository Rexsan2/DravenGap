// desktop-app/lcu-history.js
// Pure helpers (no Electron / network) for turning LCU match-history and
// champion-mastery payloads into the compact shape the renderer uses.
// Kept separate from main.js so they can be unit-tested under plain Node.

// Summoner's Rift PvP queues, ranked and normal. The dataset's win rates are
// Summoner's Rift stats, so ARAM / Arena / co-op vs AI games would not compare.
const SR_QUEUES = new Set([
    400, // Normal Draft
    420, // Ranked Solo/Duo
    430, // Normal Blind
    440, // Ranked Flex
    480, // Swiftplay
    490  // Quickplay
]);
const MIN_GAME_SECONDS = 300;              // ignore remakes / very early surrenders
const MAX_STORED_GAMES = 1000;             // per account, in the local history store

// Accepts the known queues, plus any other matchmade 5v5 Summoner's Rift game so
// a renumbered or new normal queue isn't silently dropped. 8xx queues are co-op vs AI.
function isSummonersRiftPvp(game) {
    if (!game) return false;
    if (SR_QUEUES.has(game.queueId)) return true;
    return game.mapId === 11 && game.gameMode === 'CLASSIC' && game.gameType === 'MATCHED_GAME' &&
        !(game.queueId >= 800 && game.queueId < 900);
}

// Map the LCU timeline {lane, role} to the app's roles
// (TOP / JUNGLE / MIDDLE / BOTTOM / SUPPORT).
//
// UNCERTAINTY: these labels are Riot's *heuristic* position guess, not the
// assigned role. The live client reports e.g. TOP/SOLO, JUNGLE/NONE,
// MIDDLE/SOLO, BOTTOM/CARRY and NONE/SUPPORT (supports often get lane NONE).
// Lane wins for TOP / JUNGLE / MIDDLE; otherwise a SUPPORT role means support
// and a CARRY role in the bot lane means ADC. Anything else (e.g. NONE/DUO) is
// returned as null; callers must treat null as "role unknown".
function mapLcuRole(timeline) {
    if (!timeline) return null;
    const lane = String(timeline.lane || '').toUpperCase();
    const role = String(timeline.role || '').toUpperCase();
    switch (lane) {
        case 'TOP': return 'TOP';
        case 'JUNGLE': return 'JUNGLE';
        case 'MIDDLE':
        case 'MID': return 'MIDDLE';
        case 'UTILITY': return 'SUPPORT'; // some payloads use the newer position names
    }
    if (role === 'SUPPORT' || role === 'DUO_SUPPORT') return 'SUPPORT';
    if ((lane === 'BOTTOM' || lane === 'BOT') && (role === 'CARRY' || role === 'DUO_CARRY')) return 'BOTTOM';
    return null;
}

// Newer payloads may carry teamPosition / individualPosition strings instead.
function mapPositionString(pos) {
    switch (String(pos || '').toUpperCase()) {
        case 'TOP': return 'TOP';
        case 'JUNGLE': return 'JUNGLE';
        case 'MIDDLE': case 'MID': return 'MIDDLE';
        case 'BOTTOM': case 'BOT': return 'BOTTOM';
        case 'UTILITY': case 'SUPPORT': return 'SUPPORT';
        default: return null;
    }
}

// Pull the local player's participant out of one LCU game object.
function findLocalParticipant(game, summoner) {
    const parts = game && Array.isArray(game.participants) ? game.participants : [];
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    const ids = Array.isArray(game.participantIdentities) ? game.participantIdentities : [];
    const me = ids.find(pi => {
        const p = pi && pi.player;
        if (!p || !summoner) return false;
        return (summoner.puuid && p.puuid === summoner.puuid) ||
               (summoner.summonerId && p.summonerId === summoner.summonerId) ||
               (summoner.accountId && p.accountId === summoner.accountId);
    });
    if (!me) return null;
    return parts.find(p => p.participantId === me.participantId) || null;
}

// Convert one page-response (or an array of already-unwrapped games) into
// Summoner's Rift game records (ranked + normals). Returns [] on anything unexpected.
function extractGames(payload, summoner) {
    let games = [];
    if (Array.isArray(payload)) games = payload;
    else if (payload && payload.games && Array.isArray(payload.games.games)) games = payload.games.games;
    else if (payload && Array.isArray(payload.games)) games = payload.games;

    const out = [];
    for (const g of games) {
        if (!isSummonersRiftPvp(g)) continue;
        if (typeof g.gameDuration === 'number' && g.gameDuration < MIN_GAME_SECONDS) continue;
        const p = findLocalParticipant(g, summoner);
        if (!p || !Number.isFinite(p.championId) || p.championId <= 0) continue;
        const stats = p.stats || {};
        let win;
        if (typeof stats.win === 'boolean') win = stats.win;
        else if (typeof stats.win === 'string') win = stats.win.toLowerCase() === 'win';
        else continue; // can't tell the result: skip
        const role = mapPositionString(p.teamPosition || p.individualPosition) || mapLcuRole(p.timeline);
        out.push({
            gameId: g.gameId,
            queueId: g.queueId,
            championId: p.championId,
            role,
            win,
            creation: g.gameCreation || null
        });
    }
    return out;
}

// Mastery payload: array of {championId, championLevel, championPoints, ...}
// -> { [championId]: { level, points } }
function extractMastery(payload) {
    const out = {};
    if (!Array.isArray(payload)) return out;
    for (const m of payload) {
        if (m && Number.isFinite(m.championId)) {
            out[m.championId] = { level: m.championLevel || 0, points: m.championPoints || 0 };
        }
    }
    return out;
}

// The client only exposes its recently loaded games (~20-100), so DraftDiff keeps its own
// store and merges each fetch into it. Newest first, de-duplicated by gameId. A record from
// the Riot API (source 'riot', real assigned position) always beats the client's version.
function mergeGameHistory(stored, fresh, max = MAX_STORED_GAMES) {
    const byId = new Map();
    for (const g of [...(Array.isArray(fresh) ? fresh : []), ...(Array.isArray(stored) ? stored : [])]) {
        if (!g || g.gameId == null) continue;
        const existing = byId.get(g.gameId);
        if (existing && !(g.source === 'riot' && existing.source !== 'riot')) continue;
        byId.set(g.gameId, g);
    }
    return [...byId.values()]
        .sort((a, b) => (b.creation || 0) - (a.creation || 0))
        .slice(0, max);
}

module.exports = { SR_QUEUES, isSummonersRiftPvp, mapLcuRole, mapPositionString, findLocalParticipant, extractGames, extractMastery, mergeGameHistory };
