// desktop-app/arena-parsers.js
// Pure parsers for the Arena mode (no I/O, no dependencies; unit-tested against recorded pages in tests/fixtures/arena).
//
// DATA SOURCE (researched 2026-10-11, plain HTTPS GET, no browser, no key):
//   LoLalytics serves Arena as server-rendered Qwik pages (queue 1750 "Arena 3x6" at the time of writing). Two pages are enough, and
//   both carry their data as the page's own Qwik state (<script type="qwik/json">), the same trick aram-parsers.js uses for boots:
//     https://lolalytics.com/lol/tierlist/arena/[?tier=all]        one request = the whole tier list (173 champions): rank, tier,
//                                                                   "Win" (top-half rate), pick, ban, games. (The visible HTML table
//                                                                   has only the first 20 rows; the state has all of them.)
//     https://lolalytics.com/lol/<champ>/arena/build/[?tier=all]   one champion: placement split (1st..6th), augments (all / by pick),
//                                                                   items (start / prismatic / by slot), best partners.
//   Default bracket of both pages is Emerald+; ?tier=all gives all ranks (about 4x the games). "Win" there means a finish in the better
//   half of the lobby (top 3 of 6 teams today: 1st+2nd+3rd equals the win rate), not first place.
//   Augment ids are Riot's own ids (checked against CommunityDragon's cdragon/arena/en_us.json: same ids, names and rarity), so the
//   icons come from that file:  https://raw.communitydragon.org/latest/cdragon/arena/en_us.json  (parseAugmentMeta).
//   Other sites listed Arena augments too (augments only, no per-champion placement or items); LoLalytics is the one with all of it.
//
//   parseTierList(html)       lolalytics.com/lol/tierlist/arena/     -> { patch, bracket, queue, avgWr, analysed, champions: [...] }
//   parseChampionPage(html)   lolalytics.com/lol/<c>/arena/build/    -> { slug, cid, name, patch, header, places, augments, items, partners }
//   parseAugmentMeta(json)    CommunityDragon arena/en_us.json       -> { [id]: { name, rarity, icon } }
// Parsers are tolerant (a missing section gives an empty list); only a page without the expected markers returns null, so the caller
// can say "the site layout may have changed".

const RARITY = { 0: 'silver', 1: 'gold', 2: 'prismatic' };    // Riot's rarity codes, same in LoLalytics' table
const CDRAGON_GAME = 'https://raw.communitydragon.org/latest/game/';

const isObj = o => o && typeof o === 'object' && !Array.isArray(o);

// ---- Qwik state ----------------------------------------------------------------------------------------------------------------
// The state is a flat list `objs`; objects hold other values as base-36 indices into it. get() resolves ONE level; call it once
// per raw value (a resolved string such as "all" could look like an index again).
function qwikState(html) {
    const m = /<script\s+type="qwik\/json"[^>]*>([\s\S]*?)<\/script>/.exec(String(html || ''));
    if (!m) return null;
    let objs;
    try { objs = JSON.parse(m[1]).objs; } catch (e) { return null; }
    if (!Array.isArray(objs)) return null;
    const get = id => {
        if (typeof id === 'string' && /^[0-9a-z]+$/.test(id)) { const i = parseInt(id, 36); if (i >= 0 && i < objs.length) return objs[i]; }
        return id;
    };
    return { objs, get };
}

// ---- tier list (Qwik state) ----------------------------------------------------------------------------------------------------
// The HTML table only renders the first 20 rows (the rest is filled in by the browser while scrolling), but the page state holds all of
// them: one object per row { cid, row: { rank, tier (index into TIERS), wr, avgWrDelta, pr, games, br } }. cid is Riot's champion id (the
// Data Dragon "key"), so the view needs no name matching. champPath maps cid -> LoLalytics slug, champions maps slug -> display name.
const TIERS = ['', 'S+', 'S', 'S-', 'A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-'];
function parseTierList(html) {
    const q = qwikState(html);
    if (!q) return null;
    const { objs, get } = q;
    const route = objs.find(o => isObj(o) && 'champName' in o && 'api' in o && 'mode' in o);
    const stat = objs.find(o => isObj(o) && 'champPath' in o && 'champions' in o);
    const meta = objs.find(o => isObj(o) && 'queue' in o && 'fields' in o && 'avgWr' in o);
    if (!route || !stat || get(route.mode) !== 'arena') return null;
    const paths = get(stat.champPath) || {}, names = get(stat.champions) || {};
    const champions = [];
    for (const o of objs) {
        if (!isObj(o) || !('cid' in o && 'row' in o && '$$nav' in o)) continue;
        const cid = get(o.cid), rr = get(o.row);
        if (typeof cid !== 'number' || !isObj(rr)) continue;
        const r = {}; for (const k of Object.keys(rr)) r[k] = get(rr[k]);
        const slug = paths[cid] != null ? get(paths[cid]) : null;
        if (typeof slug !== 'string' || typeof r.wr !== 'number' || typeof r.games !== 'number') continue;
        const name = names[slug] != null ? get(names[slug]) : null;
        champions.push({
            cid, slug, name: typeof name === 'string' ? name : slug, rank: r.rank, tier: TIERS[r.tier] || null,
            wr: r.wr, wrDelta: r.avgWrDelta, pick: r.pr, ban: r.br, games: r.games
        });
    }
    if (!champions.length) return null;
    champions.sort((x, y) => x.rank - y.rank);
    const bracket = get(route.tier);
    return {
        patch: get(route.patch), bracket, queue: meta ? get(meta.queue) : null,
        avgWr: meta ? get(meta.avgWr) : null, analysed: meta ? get(meta.analysed) : null,
        champions
    };
}

// ---- champion page (Qwik state) ----------------------------------------------------------------------------------------------
// Placement split: place1..place8 in percent, cut after the last non-zero entry. "Win" = the better half, so the number of winning
// places is the k whose running total matches the win rate (3 of 6 today; 4 of 8 in the older eight-team format).
function placements(hdr) {
    const p = [];
    for (let i = 1; i <= 8; i++) p.push(typeof hdr['place' + i] === 'number' ? hdr['place' + i] : 0);
    while (p.length > 1 && p[p.length - 1] === 0) p.pop();
    let cum = 0, winPlaces = null;
    for (let k = 0; k < p.length; k++) { cum += p[k]; if (typeof hdr.wr === 'number' && Math.abs(cum - hdr.wr) <= 0.6) { winPlaces = k + 1; break; } }
    if (winPlaces == null) winPlaces = Math.max(1, Math.floor(p.length / 2));
    const total = p.reduce((a, b) => a + b, 0);
    const avgPlace = total > 0 ? p.reduce((a, v, i) => a + v * (i + 1), 0) / total : null;
    return { places: p, winPlaces, avgPlace: avgPlace == null ? null : Math.round(avgPlace * 100) / 100 };
}

function parseChampionPage(html) {
    const q = qwikState(html);
    if (!q) return null;
    const { objs, get } = q;
    const route = objs.find(o => isObj(o) && 'champName' in o && 'cid' in o && 'path' in o && 'mode' in o);
    const main = objs.find(o => isObj(o) && 'augment' in o && 'header' in o && 'startItem' in o);
    const stat = objs.find(o => isObj(o) && 'champPath' in o && 'augments' in o && 'items' in o);
    if (!route || !main || !stat || get(route.mode) !== 'arena') return null;

    const hdrRaw = get(main.header);
    if (!isObj(hdrRaw)) return null;
    const hdr = {}; for (const k of Object.keys(hdrRaw)) hdr[k] = get(hdrRaw[k]);
    if (typeof hdr.wr !== 'number' || typeof hdr.n !== 'number') return null;

    const augTable = get(stat.augments) || {};
    const augMeta = id => {
        const e = augTable[id] != null ? get(augTable[id]) : null;
        if (!Array.isArray(e)) return null;
        const name = get(e[0]), rarity = RARITY[get(e[1])];
        return typeof name === 'string' && rarity ? { name, rarity } : null;
    };
    const itemTable = get(stat.items) || {};
    const itemName = id => { const n = itemTable[id] != null ? get(itemTable[id]) : null; return typeof n === 'string' ? n : null; };
    // rows of arrays [id, wr, pick, games, (time)] under main[key]
    const rows = (src, key) => {
        const list = src && src[key] != null ? get(src[key]) : null;
        if (!Array.isArray(list)) return [];
        const out = [];
        for (const r of list) {
            const row = get(r);
            if (!Array.isArray(row)) continue;
            const v = row.map(get);
            if (typeof v[0] === 'number' && typeof v[1] === 'number' && typeof v[3] === 'number') out.push(v);
        }
        return out;
    };
    const augs = (src, key, minGames) => rows(src, key).filter(v => v[0] > 0 && v[3] >= minGames).map(v => ({ id: v[0], ...augMeta(v[0]), wr: v[1], pick: v[2], games: v[3] })).filter(a => a.name);
    const items = key => rows(main, key).filter(v => v[0] > 0).map(v => ({ id: v[0], name: itemName(v[0]), wr: v[1], pick: v[2], games: v[3], round: typeof v[4] === 'number' ? v[4] : null }));

    const augRaw = get(main.augment);
    const rounds = {};
    for (let r = 1; r <= 4; r++) rounds[r] = augs(augRaw, 'augment' + r, 5);
    const slots = {};
    for (let s = 1; s <= 6; s++) slots[s] = items('item' + s);

    // partners: [id, wr together, synergy delta, normalised delta, pick, games] per lane key (Arena has one: "middle")
    const teamRaw = get(main.team);
    const lane = isObj(teamRaw) ? Object.keys(teamRaw)[0] : null;
    const partners = [];
    // (rows() insists on v[3] being a number: for this table that is the normalised delta, so it passes)
    for (const v of rows({ t: lane ? teamRaw[lane] : null }, 't')) if (typeof v[5] === 'number') partners.push({ id: v[0], wr: v[1], delta: v[2], pick: v[4], games: v[5] });

    const pl = placements(hdr);
    return {
        slug: get(route.champion), cid: get(route.cid), name: get(route.champName), patch: get(route.patch), bracket: get(route.tier),
        analysed: get(main.analysed), avgWr: get(main.avgWr),
        header: { games: hdr.n, wr: hdr.wr, pick: hdr.pr, ban: hdr.br, rank: hdr.rank, rankTotal: hdr.rankTotal, tier: hdr.tier },
        places: pl.places, winPlaces: pl.winPlaces, avgPlace: pl.avgPlace,
        augments: { all: augs(augRaw, 'augment0', 1), rounds },
        items: { all: items('item'), start: items('startItem'), prismatic: items('prismatic'), slots },
        partners
    };
}

// ---- CommunityDragon Arena augment list -> icons ------------------------------------------------------------------------------
function parseAugmentMeta(json) {
    let j = json;
    if (typeof j === 'string') { try { j = JSON.parse(j); } catch (e) { return null; } }
    if (!j || !Array.isArray(j.augments)) return null;
    const out = {};
    for (const a of j.augments) {
        if (!a || !Number.isInteger(a.id) || typeof a.name !== 'string') continue;
        const icon = typeof a.iconSmall === 'string' && /^assets\/[\w\/.-]+\.(png|jpg|webp)$/i.test(a.iconSmall) ? CDRAGON_GAME + a.iconSmall.toLowerCase() : null;
        out[a.id] = { name: a.name, rarity: RARITY[a.rarity] || null, icon };
    }
    return Object.keys(out).length ? out : null;
}

module.exports = { parseTierList, parseChampionPage, parseAugmentMeta, placements, qwikState, RARITY, TIERS };
