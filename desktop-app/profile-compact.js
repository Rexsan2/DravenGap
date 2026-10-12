// desktop-app/profile-compact.js
// Pure helpers: queue tables, match-v5 MatchDto -> compact shapes for the view, ledger rows, LCU/league conversions.

// Names for the queues the view cares about (Riot's queues.json; the list is refreshed at runtime for unknown ids).
const QUEUE_NAMES = {
    400: 'Normal Draft', 420: 'Ranked Solo/Duo', 430: 'Normal Blind', 440: 'Ranked Flex', 450: 'ARAM', 480: 'Swiftplay',
    490: 'Quickplay', 700: 'Clash', 720: 'ARAM Clash', 900: 'ARURF', 1020: 'One for All', 1300: 'Nexus Blitz', 1400: 'Ultimate Spellbook',
    1700: 'Arena', 1710: 'Arena', 1750: 'Arena', // 1750 = "Arena 3x6" (CommunityDragon; missing from Riot's queues.json)
     1900: 'URF', 2400: 'ARAM Mayhem', 830: 'Co-op vs AI', 840: 'Co-op vs AI', 850: 'Co-op vs AI'
};
const { ddScores } = require('./profile-score');
const MAYHEM_QUEUE = 2400; // queues.json: "Howling Abyss ARAM: Mayhem" (verified against static.developer.riotgames.com)
// Summoner's Rift queues: CS, gold and vision per minute (and the DD Score's role expectations) only mean something here.
// ARAM, Arena and the other modes keep their own numbers (the queue tabs) and never drag these averages.
const SR_QUEUES = [400, 420, 430, 440, 480, 490, 700, 830, 840, 850, 1400];
// Owner decision 2026-10-11: Arena and the other non-5v5 modes are never summed into "All" (match list, played-with, Insights,
// champion table, post-game "usual" numbers, session counter). The Riot id list for "All" is still fetched unfiltered; the rows are filtered.
const ARENA_QUEUES = [1700, 1710, 1750];
const EXCLUDED_FROM_ALL = [...ARENA_QUEUES, 1800, 1810, 1820, 1830, 1840, 2000, 2010, 2020]; // + Swarm and the tutorials
// Queue tabs. `type`/`queue` are the match-v5 ids-endpoint filters; `queues` filters the returned games client-side
// (`exclude` instead of `queues` for "All": everything except those queues).
const QUEUE_GROUPS = {
    all: { label: 'All', queue: null, type: null, queues: null, exclude: EXCLUDED_FROM_ALL },
    solo: { label: 'Ranked Solo', queue: 420, queues: [420] },
    flex: { label: 'Flex', queue: 440, queues: [440] },
    normal: { label: 'Normal', type: 'normal', queues: [400, 430, 480, 490] },
    aram: { label: 'ARAM', queue: 450, queues: [450] },
    mayhem: { label: 'ARAM Mayhem', queue: MAYHEM_QUEUE, queues: [MAYHEM_QUEUE] },
    // Arena: placement instead of win / loss. Riot's id list takes one queue and Arena has several (1700, 1710, 1750 = 3x6, the current
    // one), so the ids are fetched unfiltered (like "All") and the rows keep Arena games only.
    arena: { label: 'Arena', queue: null, type: null, queues: ARENA_QUEUES }
};
// match-v5 gameMode of Arena ('CHERRY') and Swarm ('STRAWBERRY'): catches queue ids that are not in the lists yet
const NON_5V5_MODES = ['CHERRY', 'STRAWBERRY'];
const isExcludedFromAll = (queueId, mode) => EXCLUDED_FROM_ALL.includes(queueId) || NON_5V5_MODES.includes(mode);
const isSrQueue = queueId => SR_QUEUES.includes(queueId);
// Does a game (queue id, and the game mode when known) belong to the queue tab `group`?
function inGroup(group, queueId, mode) {
    const g = QUEUE_GROUPS[group];
    if (!g) return false;
    if (g.queues) return g.queues.includes(queueId) || (group === 'arena' && mode === 'CHERRY');
    return !isExcludedFromAll(queueId, mode);
}

// Arena's "win" is a finish in the better half of the lobby: top 4 of 8 pairs (2v2), top 3 of 6 trios ("Arena 3x6", queue 1750).
// The lobby size comes from the game's subteams; games without them fall back on the queue.
function arenaWinPlaces(players, queueId) {
    const subs = new Set((players || []).map(p => p.sub).filter(Boolean));
    const teams = subs.size >= 2 ? subs.size : queueId === 1750 ? 6 : 8;
    return Math.max(1, Math.floor(teams / 2));
}
// the same for a ledger row (rows written before 2026-10-11 have no `tp`)
const rowWinPlaces = r => r.tp || (r.q === 1750 ? 3 : 4);

function seasonStart(now = Date.now()) { // League seasons begin in early January
    const d = new Date(now);
    let start = Date.UTC(d.getUTCFullYear(), 0, 8);
    if (start > now) start = Date.UTC(d.getUTCFullYear() - 1, 0, 8);
    return start;
}

function durationSeconds(info) {
    if (!info) return 0;
    return info.gameEndTimestamp ? info.gameDuration : (info.gameDuration || 0) / 1000; // pre-11.20 games were in ms
}

// ARAM and other modes report 'Invalid' (or NONE/empty) positions
const validPos = x => (['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'].includes(x) ? x : '');

// Full rune page of one participant: [primary style, [4 perk ids], secondary style, [2 perk ids], [offense, flex, defense]]
function compactPerks(perks) {
    if (!perks || !Array.isArray(perks.styles)) return null;
    const sel = st => ((st && st.selections) || []).map(x => x.perk);
    const sp = perks.statPerks || {};
    return [perks.styles[0] ? perks.styles[0].style : 0, sel(perks.styles[0]), perks.styles[1] ? perks.styles[1].style : 0, sel(perks.styles[1]), [sp.offense || 0, sp.flex || 0, sp.defense || 0]];
}

function compactMatch(raw) {
    const info = raw && raw.info;
    if (!info) return null;
    const dur = durationSeconds(info);
    const teamKills = {};
    for (const p of info.participants || []) teamKills[p.teamId] = (teamKills[p.teamId] || 0) + (p.kills || 0);
    const players = (info.participants || []).map(p => ({
        puuid: p.puuid, name: p.riotIdGameName || p.summonerName || '', tag: p.riotIdTagline || '',
        champId: p.championId, champ: p.championName, lvl: p.champLevel, s1: p.summoner1Id, s2: p.summoner2Id,
        keystone: p.perks && p.perks.styles && p.perks.styles[0] && p.perks.styles[0].selections && p.perks.styles[0].selections[0] ? p.perks.styles[0].selections[0].perk : null,
        pStyle: p.perks && p.perks.styles && p.perks.styles[0] ? p.perks.styles[0].style : null,
        sStyle: p.perks && p.perks.styles && p.perks.styles[1] ? p.perks.styles[1].style : null,
        items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6].map(x => x || 0),
        k: p.kills || 0, d: p.deaths || 0, a: p.assists || 0,
        cs: (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0), vis: p.visionScore || 0,
        wp: p.wardsPlaced || 0, wk: p.wardsKilled || 0, cw: p.visionWardsBoughtInGame || 0,
        dmg: p.totalDamageDealtToChampions || 0, taken: p.totalDamageTaken || 0, gold: p.goldEarned || 0,
        pos: validPos(p.teamPosition) || validPos(p.individualPosition), team: p.teamId, win: !!p.win, multi: p.largestMultiKill || 0,
        kp: teamKills[p.teamId] ? Math.round(((p.kills || 0) + (p.assists || 0)) / teamKills[p.teamId] * 100) : 0,
        early: !!p.gameEndedInEarlySurrender,
        pid: p.participantId || 0, mit: p.damageSelfMitigated || 0, obj: p.damageDealtToObjectives || 0, tur: p.damageDealtToTurrets || 0,
        plc: p.placement || 0, sub: p.playerSubteamId || 0,   // Arena: final placement (1-8, or 1-6 with trios) and the team (subteam) you played in
        pk: compactPerks(p.perks)
    }));
    const teams = (info.teams || []).map(t => {
        const o = t.objectives || {};
        const g = k => (o[k] && o[k].kills) || 0;
        return { id: t.teamId, win: !!t.win, kills: teamKills[t.teamId] || 0, baron: g('baron'), dragon: g('dragon'), herald: g('riftHerald'), tower: g('tower'), inhib: g('inhibitor'), grubs: g('horde') };
    });
    const remake = dur < 300 || players.some(p => p.early);
    const sc = ddScores(players, { dur, remake, sr: isSrQueue(info.queueId) });   // role expectations (CS, vision) only in Summoner's Rift queues
    players.forEach((p, i) => { if (sc[i]) { p.sc = sc[i].score; p.rk = sc[i].rank; p.bd = sc[i].badge; } });
    const arena = players.some(p => p.plc > 0);
    return {
        id: raw.metadata && raw.metadata.matchId, queueId: info.queueId, mode: info.gameMode, dur,
        ...(raw.metadata && raw.metadata.src === 'lcu' ? { src: 'lcu' } : {}),   // recorded from the client (not in Riot's API)
        ...(arena ? { winPlaces: arenaWinPlaces(players, info.queueId) } : {}),   // Arena: places 1..winPlaces count as a "win"
        end: info.gameEndTimestamp || ((info.gameStartTimestamp || info.gameCreation || 0) + dur * 1000),
        patch: String(info.gameVersion || '').split('.').slice(0, 2).join('.'),
        remake, teams, players
    };
}

// The participant that is `puuid`. Cached games hold the puuids of the API key that fetched them; after a key/project
// change those no longer match, so fall back to the Riot ID (case-insensitive) in `ident` = { gameName, tagLine }.
function findMe(cm, puuid, ident) {
    if (!cm || !cm.players) return null;
    const hit = cm.players.find(p => p.puuid === puuid);
    if (hit || !ident || !ident.gameName) return hit || null;
    const g = String(ident.gameName).toLowerCase(), t = String(ident.tagLine || '').toLowerCase();
    return cm.players.find(p => p.name && String(p.name).toLowerCase() === g && String(p.tag || '').toLowerCase() === t) || null;
}
// A copy of the match whose "me" participant carries the viewer's current puuid (same object when nothing changes).
function forViewer(cm, puuid, ident) {
    if (!cm || !cm.players || cm.players.some(p => p.puuid === puuid)) return cm;
    const me = findMe(cm, puuid, ident);
    return me ? { ...cm, players: cm.players.map(p => p === me ? { ...p, puuid } : p) } : cm;
}

// "Recently played with": teammates (same team as `puuid`) in >= minGames of the given compact matches.
// A teammate is identified by puuid; puuids of old cached games may belong to an older API key, so identities that share a
// Riot ID (case-insensitive name#tag) are merged. Remakes are skipped. Returns [{ name, tag, puuid, games, w, l, wr }].
function playedWith(matches, puuid, ident, minGames = 2) {
    const groups = [];                 // { name, tag, puuid, games, w, last }
    const byPuuid = new Map(), byTag = new Map();
    const merge = (a, b) => {
        if (a === b) return a;
        a.games += b.games; a.w += b.w; if (b.last > a.last) { a.last = b.last; a.name = b.name; a.tag = b.tag; a.puuid = b.puuid || a.puuid; }
        for (const [k, v] of byPuuid) if (v === b) byPuuid.set(k, a);
        for (const [k, v] of byTag) if (v === b) byTag.set(k, a);
        b.dead = true;
        return a;
    };
    for (const cm of matches || []) {
        if (!cm || cm.remake) continue;
        const me = findMe(cm, puuid, ident);
        if (!me) continue;
        for (const p of cm.players) {
            if (p === me || p.team !== me.team) continue;
            const nt = p.name ? (String(p.name) + '#' + String(p.tag || '')).toLowerCase() : null;
            if (!nt && !p.puuid) continue;
            const gp = p.puuid ? byPuuid.get(p.puuid) : null, gt = nt ? byTag.get(nt) : null;
            let g = gp || gt;
            if (gp && gt && gp !== gt) g = merge(gp, gt);
            if (!g) { g = { name: p.name || '', tag: p.tag || '', puuid: p.puuid, games: 0, w: 0, last: 0 }; groups.push(g); }
            g.games++; if (p.win) g.w++;
            if ((cm.end || 0) >= g.last) { g.last = cm.end || 0; if (p.name) { g.name = p.name; g.tag = p.tag || ''; } if (p.puuid) g.puuid = p.puuid; }
            if (p.puuid) byPuuid.set(p.puuid, g);
            if (nt) byTag.set(nt, g);
        }
    }
    return groups.filter(g => !g.dead && g.games >= minGames && g.name)
        .map(g => ({ name: g.name, tag: g.tag, puuid: g.puuid, games: g.games, w: g.w, l: g.games - g.w, wr: Math.round(g.w / g.games * 100) }))
        .sort((x, y) => y.games - x.games || y.wr - x.wr || x.name.localeCompare(y.name));
}

function ledgerRow(cm, puuid, ident) {
    const me = findMe(cm, puuid, ident);
    if (!me) return null;
    return { id: cm.id, q: cm.queueId, c: me.champId, w: me.win ? 1 : 0, k: me.k, d: me.d, a: me.a, cs: me.cs, dur: cm.dur, end: cm.end, pos: me.pos, vis: me.vis, kp: me.kp, rm: cm.remake ? 1 : 0, ...(me.plc ? { pl: me.plc, tp: cm.winPlaces || arenaWinPlaces(cm.players, cm.queueId) } : {}) };
}

// The client's own record of a finished game (/lol-match-history/v1/games/{gameId}, the older match-v4 shape) -> a match-v5-like
// raw match, so compactMatch, the match list and the ledger handle it like any other game. Used for games Riot's API never returns
// (ARAM Mayhem). metadata.src = 'lcu' marks it. The owner's participant gets the API puuid (`ownerApiPuuid`) so the Profile finds it;
// the others keep the client's puuid (their links use the Riot ID). Returns null for anything unexpected.
function lcuGameToMatch(game, { platform, ownerLcuPuuid, ownerApiPuuid } = {}) {
    if (!game || !Number.isFinite(game.gameId) || !Array.isArray(game.participants) || !game.participants.length || !platform) return null;
    const ids = new Map((game.participantIdentities || []).map(pi => [pi && pi.participantId, (pi && pi.player) || {}]));
    const winOf = w => (typeof w === 'boolean' ? w : String(w || '').toLowerCase() === 'win');
    const dur = Number(game.gameDuration) || 0;                       // seconds in the client's history
    const start = Number(game.gameCreation) || 0;
    const participants = game.participants.map(p => {
        const s = p.stats || {}, who = ids.get(p.participantId) || {};
        const perkIds = [s.perk0, s.perk1, s.perk2, s.perk3, s.perk4, s.perk5];
        const perks = s.perkPrimaryStyle ? { statPerks: { offense: s.statPerk0 || 0, flex: s.statPerk1 || 0, defense: s.statPerk2 || 0 },
            styles: [{ style: s.perkPrimaryStyle, selections: perkIds.slice(0, 4).map(perk => ({ perk: perk || 0 })) }, { style: s.perkSubStyle || 0, selections: perkIds.slice(4).map(perk => ({ perk: perk || 0 })) }] } : null;
        const mine = ownerLcuPuuid && who.puuid === ownerLcuPuuid;
        return {
            puuid: mine ? ownerApiPuuid : (who.puuid || ''), riotIdGameName: who.gameName || who.summonerName || '', riotIdTagline: who.tagLine || '',
            championId: p.championId, champLevel: s.champLevel || 0, summoner1Id: p.spell1Id, summoner2Id: p.spell2Id, teamId: p.teamId, win: winOf(s.win),
            kills: s.kills || 0, deaths: s.deaths || 0, assists: s.assists || 0, largestMultiKill: s.largestMultiKill || 0,
            totalMinionsKilled: s.totalMinionsKilled || 0, neutralMinionsKilled: s.neutralMinionsKilled || 0, visionScore: s.visionScore || 0,
            wardsPlaced: s.wardsPlaced || 0, wardsKilled: s.wardsKilled || 0, visionWardsBoughtInGame: s.visionWardsBoughtInGame || 0,
            totalDamageDealtToChampions: s.totalDamageDealtToChampions || 0, totalDamageTaken: s.totalDamageTaken || 0, goldEarned: s.goldEarned || 0,
            damageSelfMitigated: s.damageSelfMitigated || 0, damageDealtToObjectives: s.damageDealtToObjectives || 0, damageDealtToTurrets: s.damageDealtToTurrets || 0,
            item0: s.item0 || 0, item1: s.item1 || 0, item2: s.item2 || 0, item3: s.item3 || 0, item4: s.item4 || 0, item5: s.item5 || 0, item6: s.item6 || 0,
            gameEndedInEarlySurrender: !!s.gameEndedInEarlySurrender, participantId: p.participantId, teamPosition: '', individualPosition: '', perks
        };
    });
    const teams = (game.teams || []).map(t => ({ teamId: t.teamId, win: winOf(t.win), objectives: {} }));
    return { metadata: { matchId: `${platform}_${game.gameId}`, src: 'lcu' },
        info: { gameId: game.gameId, queueId: game.queueId, gameMode: game.gameMode, gameDuration: dur, gameCreation: start, gameStartTimestamp: start,
            gameEndTimestamp: start + dur * 1000, gameVersion: game.gameVersion || '', platformId: platform, participants, teams } };
}

// LCU /lol-ranked/v1/ranked-stats -> league-v4 LeagueEntryDTO-like array
function lcuRankedToEntries(stats) {
    const out = [];
    for (const q of (stats && stats.queues) || []) {
        if (!['RANKED_SOLO_5x5', 'RANKED_FLEX_SR'].includes(q.queueType)) continue;
        if (!q.tier || q.tier === 'NONE' || q.tier === '') continue;
        out.push({ queueType: q.queueType, tier: q.tier, rank: q.division && q.division !== 'NA' ? q.division : 'I', leaguePoints: q.leaguePoints || 0, wins: q.wins || 0, losses: q.losses || 0, hotStreak: !!q.isHotStreak, source: 'lcu' });
    }
    return out;
}

const LCU_REGION_TO_PLATFORM = { TW: 'TW2', VN: 'VN2', PH: 'PH2', SG: 'SG2', TH: 'TH2', EUW: 'EUW1', EUNE: 'EUN1', NA: 'NA1', BR: 'BR1', LAN: 'LA1', LAS: 'LA2', OCE: 'OC1', TR: 'TR1', RU: 'RU', JP: 'JP1', KR: 'KR', PBE: 'NA1', SG2: 'SG2', PH2: 'PH2', TH2: 'TH2', TW2: 'TW2', VN2: 'VN2', ME1: 'ME1' };

module.exports = { compactPerks, playedWith, QUEUE_NAMES, QUEUE_GROUPS, MAYHEM_QUEUE, SR_QUEUES, ARENA_QUEUES, EXCLUDED_FROM_ALL, inGroup, isExcludedFromAll, isSrQueue, arenaWinPlaces, rowWinPlaces, lcuGameToMatch, seasonStart, compactMatch, ledgerRow, findMe, forViewer, lcuRankedToEntries, LCU_REGION_TO_PLATFORM, durationSeconds };
