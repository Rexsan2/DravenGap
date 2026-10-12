// desktop-app/coachless-scraper.js
// Local scraper for Coachless WPA data (items, runes, summoner spells), one dataset per patch.
// Mirrors lolalytics-scraper.js: a main-process Node module with no dependencies that returns
// gzip Buffers, so only a few MB cross IPC and the renderer stores them in its archive.
//
// Personal use with explicit permission from Coachless's author (xPetu): the data stays local and is
// never committed or redistributed. Load on the API is capped process-wide: at most MAX_CONCURRENT requests
// in flight (about what one browser tab loading a page does), starts spaced by MIN_START_GAP_MS, back-off
// on 429/5xx (honouring Retry-After, and a 429 pauses every request), stop on 401/403.
// Endpoint and field details are below; the stored format is at buildDataset.
//
// Two levels of data per champion-role:
//  - bulk (scrapePatch / scrapeChampionRole): exactly the website's Builds "Overview" page plus Legendaries "All" and
//    Support items: spells, keystones, starter, boots (all), legendaries all/1st/2nd/3rd/4th+  (~9 requests)
//  - detail on demand (scrapeChampionRoleDetail): components (all slots), boots by slot, rune trees / sub-runes /
//    shards for the top keystones (~15-25 requests), fetched when the user asks for it in the Builds tab.

const https = require('https');
const zlib = require('zlib');
const { promisify } = require('util');
const gzip = promisify(zlib.gzip);

const API_HOST = 'api.coachless.gg';
const API_BASE = '/api';
const DDRAGON = 'https://ddragon.leagueoflegends.com';
const USER_AGENT = 'FirefoxClientv2'; // the identifier Coachless's author (xPetu) asked DraftDiff to use
const SCHEMA_VERSION = 1;
const RANK = 'emerald_plus';

// Load cap, shared by every client in this process (bulk download and on-demand detail together).
const MAX_CONCURRENT = 3;          // requests in flight at once
const MIN_START_GAP_MS = 350;      // between request starts
const JITTER_MS = 100;
const CONCURRENT_ROLES = 3;        // champion-roles worked on at once in scrapePatch (requests still capped above)
const REQUEST_TIMEOUT_MS = 60000;  // one comp_1 request once took 23 s
const MAX_ATTEMPTS = 5;
const MAX_RETRY_AFTER_MS = 120000;

const LEAGUE_TIERS = [5, 6, 7]; // Emerald, Diamond, Master+ (the site's Emerald+)
// Coachless role index <-> DraftDiff role
const ROLE_IDS = { TOP: 0, JUNGLE: 1, MIDDLE: 2, BOTTOM: 3, SUPPORT: 4 };
const ITEM_TYPES = { legendaries: 1, boots: 2, support: 3, components: 4, starter: 6 };
const ITEM_SLOT_TABS = [['all', null], ['1', [1]], ['2', [2]], ['3', [3]], ['4+', [4, 5, 6]]];
const SLOT_ITEM_TABS = ['legendaries', 'components', 'boots']; // tabs that have slot tabs on the site

// Rune requests per champion-role = 1 (keystones) + per kept keystone: 1 (secondary tree play counts) +
// 1 (primary sub-runes) + 1 (shards) + 1 per kept secondary tree (secondary sub-runes).
const DEFAULT_RUNE_OPTIONS = {
    maxKeystones: 3, minKeystoneShare: 0.08,
    maxSecondaryTrees: 2, minSecondaryTreeShare: 0.15
};

const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(new Error('cancelled')); return; }
    // Remove the abort listener when the timer fires (a leftover listener on a long-lived signal leaks).
    const onAbort = () => { clearTimeout(timer); reject(new Error('cancelled')); };
    const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
});

class CoachlessError extends Error {
    constructor(message, code, status) { super(message); this.name = 'CoachlessError'; this.code = code; this.status = status; }
}

// One HTTP request. Resolves { status, headers, text }. The abort listener is removed as soon as the
// request settles: the signal lives for the whole download, and a leftover listener keeps its request,
// response and body alive (the LoLalytics scraper leaked ~1 GB per dataset this way).
function httpRequest(method, path, bodyText, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) { reject(new Error('cancelled')); return; }
        const headers = { 'User-Agent': USER_AGENT, 'Accept': 'application/json' };
        if (bodyText !== null) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(bodyText);
        }
        const onAbort = () => req.destroy(new Error('cancelled'));
        const done = () => { if (signal) signal.removeEventListener('abort', onAbort); };
        const req = https.request({ host: API_HOST, path: API_BASE + path, method, headers, timeout: REQUEST_TIMEOUT_MS }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => { done(); resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }); });
            res.on('error', e => { done(); reject(e); });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', e => { done(); reject(e); });
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        if (bodyText !== null) req.write(bodyText);
        req.end();
    });
}

function retryAfterMs(headers) {
    const v = headers && headers['retry-after'];
    if (!v) return null;
    const secs = Number(v);
    if (Number.isFinite(secs)) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
    const date = Date.parse(v);
    return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS) : null;
}

// Process-wide limiter: every client shares it, so separate patches, getPatches and on-demand detail requests
// can never exceed the cap together. A 429 sets pausedUntil, which holds back every request, not just the retry.
const limiter = { inFlight: {}, lastStart: 0, pausedUntil: 0, blockedUntil: 0 }; // inFlight per pool
// A Retry-After longer than this is treated as a block: stop and report when to try again instead of retrying.
const BLOCK_THRESHOLD_MS = 5 * 60 * 1000;
function rateLimitedError(until) {
    const e = new CoachlessError(`Coachless rate limit reached; try again after ${new Date(until).toLocaleTimeString()}.`, 'RATE_LIMITED', 429);
    e.retryAt = until;
    return e;
}
// Two load profiles: BULK (the throttled background download) and BROWSER (one on-demand click: the same burst of parallel
// requests the website itself sends when a page opens). Blocks (Retry-After) and 429 pauses apply to both.
// Each profile has its own pool of in-flight requests, so slow detail queries (Coachless computes uncached tables live,
// ~30 s each) can never hold up the overview of another patch.
const BULK_LIMITS = { pool: 'bulk', maxConcurrent: MAX_CONCURRENT, minGap: MIN_START_GAP_MS };
const BROWSER_LIMITS = { pool: 'overview', maxConcurrent: 27, minGap: 0 }; // up to 3 patches' overviews (~9 each) at once
const DETAIL_LIMITS = { pool: 'detail', maxConcurrent: 9, minGap: 0 };
async function acquireSlot(signal, limits = BULK_LIMITS) {
    for (;;) {
        if (signal && signal.aborted) throw new Error('cancelled');
        if (Date.now() < limiter.blockedUntil) throw rateLimitedError(limiter.blockedUntil); // no requests while blocked
        const now = Date.now();
        const wait = Math.max(limiter.lastStart + limits.minGap - now, limiter.pausedUntil - now);
        const busy = limiter.inFlight[limits.pool] || 0;
        if (busy < limits.maxConcurrent && wait <= 0) {
            limiter.inFlight[limits.pool] = busy + 1;
            limiter.lastStart = now + (limits.minGap ? Math.random() * JITTER_MS : 0);
            return;
        }
        await sleep(wait > 0 ? wait : 40, signal);
    }
}
function releaseSlot(limits = BULK_LIMITS) { limiter.inFlight[limits.pool] = Math.max(0, (limiter.inFlight[limits.pool] || 0) - 1); }

// Rate-limited API client (counts requests/retries for one job; the limit itself is process-wide).
function createClient(signal, limits = BULK_LIMITS) {
    const client = { requests: 0, retries: 0 };
    client.call = async (method, path, body) => {
        const bodyText = body === undefined ? null : JSON.stringify(body);
        let lastError = null;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            await acquireSlot(signal, limits);
            client.requests++;
            let retryDelay = null;
            try {
                const r = await httpRequest(method, path, bodyText, signal);
                if (r.status === 200) {
                    try { return JSON.parse(r.text); }
                    catch (e) { throw new CoachlessError(`${path}: response is not JSON`, 'BAD_RESPONSE', 200); }
                }
                if (r.status === 401 || r.status === 403) throw new CoachlessError(`Coachless refused the request (HTTP ${r.status}) - stopping`, 'AUTH', r.status);
                if (r.status === 429) {
                    const raw = r.headers && r.headers['retry-after'];
                    const secs = Number(raw);
                    const waitMs = Number.isFinite(secs) ? secs * 1000 : (Date.parse(raw) - Date.now());
                    if (Number.isFinite(waitMs) && waitMs > BLOCK_THRESHOLD_MS) {
                        limiter.blockedUntil = Math.max(limiter.blockedUntil, Date.now() + waitMs);
                        throw rateLimitedError(limiter.blockedUntil);
                    }
                }
                if (r.status === 429 || r.status >= 500) {
                    lastError = new CoachlessError(`${path}: HTTP ${r.status}`, 'HTTP', r.status);
                    retryDelay = retryAfterMs(r.headers);
                    if (retryDelay === null) retryDelay = 5000 * Math.pow(2, attempt);
                    if (r.status === 429) limiter.pausedUntil = Math.max(limiter.pausedUntil, Date.now() + retryDelay);
                } else {
                    throw new CoachlessError(`${path}: unexpected HTTP ${r.status}`, 'HTTP', r.status);
                }
            } catch (e) {
                if (e.message === 'cancelled' || e instanceof CoachlessError) throw e;
                lastError = e; retryDelay = 3000 * (attempt + 1); // network error / timeout
            } finally {
                releaseSlot(limits);
            }
            if (attempt === MAX_ATTEMPTS - 1) break; // no point waiting after the last attempt
            client.retries++;
            await sleep(retryDelay, signal);
        }
        throw lastError || new CoachlessError(`${path}: failed`, 'HTTP');
    };
    return client;
}

// ---- Response validation -------------------------------------------------------------------------
function fail(what, why) { throw new CoachlessError(`Unexpected Coachless response for ${what}: ${why}`, 'BAD_RESPONSE'); }
const isNum = v => typeof v === 'number' && Number.isFinite(v);

function checkRows(what, rows, fields) {
    if (!Array.isArray(rows)) fail(what, 'expected an array');
    for (const r of rows) {
        if (!r || typeof r !== 'object') fail(what, 'row is not an object');
        for (const f of fields) if (!isNum(r[f])) fail(what, `row field "${f}" is missing or not a number`);
    }
    return rows;
}
// Stats tables: the response must be an array of objects, but a row with a missing / null number (e.g. a tiny-sample item
// without a win rate) is dropped instead of failing the whole champion-role.
function cleanRows(what, rows, fields) {
    if (!Array.isArray(rows)) fail(what, 'expected an array');
    return rows.filter(r => r && typeof r === 'object' && fields.every(f => isNum(r[f])));
}

// ---- Normalisation (percent -> fraction) ---------------------------------------------------------
const frac = pct => Number((pct / 100).toFixed(6));
const byGamesDesc = (a, b) => b.games - a.games || a.id - b.id;

// Items: pickRate = share of all purchases in this table (rows sum to 1), as the site's "Pick Rate".
function normItems(what, rows) {
    rows = cleanRows(what, rows, ['itemId', 'wpaOverall', 'occurrence', 'occurrenceRelative', 'winrateExpected', 'winrateObserved']);
    return rows.map(r => ({
        id: r.itemId, wpa: frac(r.wpaOverall), buys: r.occurrence, pickRate: frac(r.occurrenceRelative),
        preBuyWp: frac(r.winrateExpected), winRate: frac(r.winrateObserved)
    })).sort((a, b) => b.buys - a.buys || a.id - b.id);
}

// Spells: the API's occurrenceRelative sums to 50 % per player slot, so the site doubles it (done here too):
// pickRate = share of games in which the spell was taken.
function normSpells(rows) {
    rows = cleanRows('spells', rows, ['summonerSpell', 'wpaOverall', 'occurrence', 'occurrenceRelative', 'winrateExpected', 'winrateObserved']);
    return rows.map(r => ({
        id: r.summonerSpell, wpa: frac(r.wpaOverall), games: r.occurrence, pickRate: Math.min(1, frac(r.occurrenceRelative * 2)),
        preBuyWp: frac(r.winrateExpected), winRate: frac(r.winrateObserved)
    })).sort(byGamesDesc);
}

// Runes: no win rate fields. pickRate = share of the runes in the same group (keystones, one sub-rune row, one shard row).
function normRunes(what, rows) {
    rows = cleanRows(what, rows, ['rune', 'wpaOverall', 'occurrence']);
    const total = rows.reduce((s, r) => s + r.occurrence, 0);
    return rows.map(r => ({ id: r.rune, wpa: frac(r.wpaOverall), games: r.occurrence, pickRate: total > 0 ? Number((r.occurrence / total).toFixed(6)) : 0 }))
        .sort(byGamesDesc);
}

function normSubRunes(what, data) {
    if (!data || typeof data !== 'object') fail(what, 'expected an object');
    const out = {};
    for (const k of ['rowOnes', 'rowTwos', 'rowThrees']) out[k] = normRunes(`${what}.${k}`, data[k]);
    return out;
}

function normShards(what, data) {
    if (!data || typeof data !== 'object') fail(what, 'expected an object');
    const out = {};
    for (const k of ['offense', 'flex', 'defense']) out[k] = normRunes(`${what}.${k}`, data[k]);
    return out;
}

// Keystone id -> tree id (Precision 8000, Domination 8100, Sorcery 8200, Inspiration 8300, Resolve 8400).
// Not derivable from the id (9923, 8992 sit outside their tree's range), and an unknown tree makes the API answer HTTP 500,
// so a keystone missing from this map is kept in `keystones` (tree: null) but its sub-runes/shards are not requested.
// Source: Data Dragon runesReforged.json 16.19 (8992 Deathfire Touch is new this season).
const KEYSTONE_TREE = {
    8005: 8000, 8008: 8000, 8021: 8000, 8010: 8000,
    8112: 8100, 8128: 8100, 9923: 8100,
    8214: 8200, 8229: 8200, 8230: 8200, 8992: 8200,
    8351: 8300, 8360: 8300, 8369: 8300,
    8437: 8400, 8439: 8400, 8465: 8400
};
const treeOfKeystone = id => KEYSTONE_TREE[id] || null;

// ---- One champion-role ---------------------------------------------------------------------------
function parsePatch(patch) {
    if (patch && typeof patch === 'object') return { major: patch.major, patch: patch.patch };
    const m = /^(\d+)\.(\d+)$/.exec(String(patch));
    if (!m) throw new Error(`Bad patch "${patch}" (expected e.g. "16.18")`);
    return { major: Number(m[1]), patch: Number(m[2]) };
}

// matchupKey: only games against that champion (the website's "vs" filter); null = all games
function commonFilters(patch, championKey, roleId, matchupKey) {
    const p = parsePatch(patch);
    const vs = Number(matchupKey);
    return {
        patch: { major: p.major, patch: p.patch, patchAdditions: 0 }, championIds: [Number(championKey)],
        matchupChampionIds: Number.isInteger(vs) && vs > 0 ? [vs] : null,
        leagueTiers: LEAGUE_TIERS, regions: null, role: roleId
    };
}

async function fetchItems(client, cf, itemType, slots, what) {
    // Same body as the site; includeSupportItems is true only for the "1st" slot tab. Role/slot rewriting that the
    // site does client side is not repeated: the API already returns the support quest items for Support legendaries [1].
    const rows = await client.call('POST', '/ChampionWinprob/GetGlobalItemStatistics', {
        commonFilters: cf, itemSlots: slots, itemType, keystone: null, starterId: null, firstPurchaseId: null,
        firstLegendaryId: null, secondLegendaryId: null, loadFirstEpicPurchase: false,
        includeSupportItems: !!(slots && slots.length === 1 && slots[0] === 1)
    });
    return normItems(what, rows);
}

// Rune detail for one keystone: secondary tree play counts, primary sub-runes, shards, and secondary sub-runes for the top trees.
async function fetchKeystoneDetail(client, cf, k, ro, tag) {
    const [secRaw, subRaw, shardRaw] = await Promise.all([
        client.call('POST', '/Rune/GetSecondaryTreePlaycount', { commonFilters: cf, tree: k.tree, keystone: k.id }),
        client.call('POST', '/Rune/GetRunesForKeystoneAndTree', { commonFilters: cf, keystone: k.id, mainTree: k.tree, treeToLoad: k.tree }),
        client.call('POST', '/Rune/GetShardsForKeystoneAndTree', { commonFilters: cf, keystone: k.id })
    ]);
    const secondaryTrees = cleanRows(`${tag} secondaryTrees`, secRaw, ['tree', 'occurrence'])
        .map(r => ({ tree: r.tree, pickRate: frac(r.occurrence) })).sort((a, b) => b.pickRate - a.pickRate);
    const subRunes = normSubRunes(`${tag} subRunes`, subRaw);
    const shards = normShards(`${tag} shards`, shardRaw);
    const keptTrees = secondaryTrees.filter(t => t.pickRate >= ro.minSecondaryTreeShare).slice(0, ro.maxSecondaryTrees);
    if (!keptTrees.length && secondaryTrees.length) keptTrees.push(secondaryTrees[0]);
    const secondarySubRunes = {};
    await Promise.all(keptTrees.map(async t => {
        secondarySubRunes[t.tree] = normSubRunes(`${tag} secondarySubRunes`,
            await client.call('POST', '/Rune/GetRunesForKeystoneAndTree', { commonFilters: cf, keystone: k.id, mainTree: k.tree, treeToLoad: t.tree }));
    }));
    return { secondaryTrees, subRunes, secondarySubRunes, shards };
}

function keystonesWithTrees(tag, ksRows) {
    const keystones = normRunes(`${tag} keystones`, ksRows).map(k => Object.assign({ tree: treeOfKeystone(k.id) }, k));
    const primaryTrees = [];
    for (const k of keystones) {
        if (!k.tree) continue;
        let t = primaryTrees.find(x => x.tree === k.tree);
        if (!t) primaryTrees.push(t = { tree: k.tree, games: 0, pickRate: 0, wpa: 0 });
        t.wpa += k.wpa * k.games; t.games += k.games; t.pickRate += k.pickRate;
    }
    for (const t of primaryTrees) { t.wpa = t.games ? Number((t.wpa / t.games).toFixed(6)) : 0; t.pickRate = Number(t.pickRate.toFixed(6)); }
    primaryTrees.sort((a, b) => b.games - a.games);
    return { keystones, primaryTrees };
}

function roleContext(opts) {
    const { patch, championKey, role, signal } = opts;
    const roleId = ROLE_IDS[role];
    if (roleId === undefined) throw new Error(`Unknown role "${role}"`);
    if (!championKey) throw new Error('championKey (Riot key from Data Dragon) is required');
    return {
        client: opts.client || createClient(signal), cf: commonFilters(patch, championKey, roleId, opts.matchupKey),
        tag: `${opts.champion || championKey}|${role}${opts.matchupKey ? '|vs' + opts.matchupKey : ''}`, signal
    };
}

// BULK: what the website's Builds "Overview" page shows, plus Legendaries "All" and Support items (support role):
// spells, keystones (+ primary tree totals), starter, boots (all), legendaries all / 1st / 2nd / 3rd / 4th+.
// Returns the stored record, or null when the role has no games in this patch. The first request (spells) detects
// that; an empty answer is checked a second time before the role is treated as "no games".
// opts: { patch, champion?, championKey, role ('TOP'|'JUNGLE'|'MIDDLE'|'BOTTOM'|'SUPPORT'), client?, signal? }
async function scrapeChampionRole(opts) {
    const { client, cf, tag, signal } = roleContext(opts);
    const spellBody = { commonFilters: cf, pairedSpell: null };
    // Bulk: spells first, so a role without games costs one request. On demand (opts.parallel): everything at once, like the site.
    const spellsP = client.call('POST', '/ChampionWinprob/GetGlobalSummonerSpellStatistics', spellBody).then(normSpells);
    let spells = opts.parallel ? null : await spellsP;
    if (spells && !spells.length) {
        await sleep(2000, signal);
        spells = normSpells(await client.call('POST', '/ChampionWinprob/GetGlobalSummonerSpellStatistics', spellBody));
        if (!spells.length) return null;
    }

    const legendarySlots = ITEM_SLOT_TABS.map(([slotName, slots]) =>
        fetchItems(client, cf, ITEM_TYPES.legendaries, slots, `${tag} legendaries/${slotName}`).then(rows => [slotName, rows]));
    const [legendaries, bootsAll, starter, ksRows, support] = await Promise.all([
        Promise.all(legendarySlots),
        fetchItems(client, cf, ITEM_TYPES.boots, null, `${tag} boots/all`),
        fetchItems(client, cf, ITEM_TYPES.starter, null, `${tag} starter`),
        client.call('POST', '/Rune/GetKeystoneData', { commonFilters: cf }),
        opts.role === 'SUPPORT' ? fetchItems(client, cf, ITEM_TYPES.support, null, `${tag} support`) : Promise.resolve(null)
    ]);
    if (!spells) {
        spells = await spellsP;
        if (!spells.length) { // check once more before calling it "no games"
            spells = normSpells(await client.call('POST', '/ChampionWinprob/GetGlobalSummonerSpellStatistics', spellBody));
            if (!spells.length) return null;
        }
    }
    const items = { legendaries: Object.fromEntries(legendaries), boots: { all: bootsAll }, starter: { all: starter } };
    if (support) items.support = { all: support };

    // Games in this champion-role: every game has one starter purchase and each player takes a spell.
    const games = Math.max(starter.reduce((s, r) => s + r.buys, 0), spells.reduce((m, r) => Math.max(m, r.games), 0));
    const { keystones, primaryTrees } = keystonesWithTrees(tag, ksRows);
    return { games, items, spells, runes: { keystones, primaryTrees, byKeystone: {} } };
}

// DETAIL (on demand): components all / 1st / 2nd / 3rd / 4th+, boots by slot, and rune detail (secondary trees,
// sub-runes, shards) for the top keystones. Returns { items: { components, boots: { '1','2','3','4+' } },
// runes: { byKeystone } }; the renderer merges it into the bulk record of that patch.
// opts: { patch, champion?, championKey, role, client?, signal?, runeOptions? }
async function scrapeChampionRoleDetail(opts) {
    const { client, cf, tag } = roleContext(opts);
    const ro = Object.assign({}, DEFAULT_RUNE_OPTIONS, opts.runeOptions);
    const componentSlots = ITEM_SLOT_TABS.map(([slotName, slots]) =>
        fetchItems(client, cf, ITEM_TYPES.components, slots, `${tag} components/${slotName}`).then(rows => [slotName, rows]));
    const bootSlots = ITEM_SLOT_TABS.filter(([slotName]) => slotName !== 'all').map(([slotName, slots]) =>
        fetchItems(client, cf, ITEM_TYPES.boots, slots, `${tag} boots/${slotName}`).then(rows => [slotName, rows]));
    const runesP = (async () => {
        // keystones from the overview (opts.keystones) save a round trip
        const keystones = Array.isArray(opts.keystones) && opts.keystones.length ? opts.keystones
            : keystonesWithTrees(tag, await client.call('POST', '/Rune/GetKeystoneData', { commonFilters: cf })).keystones;
        const kept = keystones.filter(k => k.tree && k.pickRate >= ro.minKeystoneShare).slice(0, ro.maxKeystones);
        if (!kept.length) { const first = keystones.find(k => k.tree); if (first) kept.push(first); }
        const byKeystone = {};
        await Promise.all(kept.map(async k => { byKeystone[k.id] = await fetchKeystoneDetail(client, cf, k, ro, tag); }));
        return byKeystone;
    })();
    const [components, boots, byKeystone] = await Promise.all([Promise.all(componentSlots), Promise.all(bootSlots), runesP]);
    return {
        items: { components: Object.fromEntries(components), boots: Object.fromEntries(boots) },
        runes: { byKeystone }, requests: client.requests
    };
}

// Everything for one champion-role on demand: the overview record with the detail tables merged in (~27 requests).
// Returns null when the role has no games in that patch.
async function scrapeChampionRoleFull(opts) {
    const client = opts.client || createClient(opts.signal);
    const record = await scrapeChampionRole(Object.assign({}, opts, { client }));
    if (!record) return null;
    const detail = await scrapeChampionRoleDetail(Object.assign({}, opts, { client }));
    record.items.components = detail.items.components;
    record.items.boots = Object.assign({}, detail.items.boots, record.items.boots);
    record.runes.byKeystone = detail.runes.byKeystone;
    record.requests = client.requests;
    return record;
}
// On demand, in two steps like the website: the overview first (one parallel burst), then the detail tables.
function scrapeOverviewOnDemand(opts) {
    return scrapeChampionRole(Object.assign({}, opts, { parallel: true, client: createClient(opts.signal, BROWSER_LIMITS) }));
}
function scrapeDetailOnDemand(opts) {
    return scrapeChampionRoleDetail(Object.assign({}, opts, { client: createClient(opts.signal, DETAIL_LIMITS) }));
}
const rateLimitStatus = () => ({ blockedUntil: limiter.blockedUntil > Date.now() ? limiter.blockedUntil : 0 });

// ---- Patch list / champion list ------------------------------------------------------------------
// Returns [{ label: '16.18', major: 16, patch: 18, matchCount }] sorted oldest to newest.
async function getPatches(opts = {}) {
    const client = opts.client || createClient(opts.signal);
    const rows = await client.call('GET', '/ChampionWinprob/GetPatches');
    checkRows('GetPatches', rows, ['major', 'patch', 'matchCount']);
    return rows.map(r => ({ label: `${r.major}.${r.patch}`, major: r.major, patch: r.patch, matchCount: r.matchCount }))
        .sort((a, b) => a.major - b.major || a.patch - b.patch);
}

// Riot champion keys from Data Dragon: { keyByName: { Ahri: '103', ... }, nameByKey }. Names are Data Dragon ids (as LoLalytics scraper).
async function getChampionKeys() {
    const get = url => new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 30000 }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            res.on('error', reject);
        }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
    });
    const versions = JSON.parse(await get(`${DDRAGON}/api/versions.json`));
    const champs = JSON.parse(await get(`${DDRAGON}/cdn/${versions[0]}/data/en_US/champion.json`)).data;
    const keyByName = {}, nameByKey = {};
    for (const c of Object.values(champs)) { keyByName[c.id] = c.key; nameByKey[c.key] = c.id; }
    return { keyByName, nameByKey };
}

// ---- One patch -----------------------------------------------------------------------------------
// Resume state (plain JSON, persist it between sessions; safe to JSON.stringify at any onCheckpoint call):
//   { version: 1, patch: '16.18', champions: { 'Ahri|MIDDLE': <record>, ... }, skipped: ['Foo|TOP', ...] }
// `champions` holds finished champion-roles (normalised rows only); `skipped` holds roles with no games.
// A champion-role is atomic: an interrupted one is simply redone. Pass the state back as `resumeState`
// (it is ignored if its patch differs).
//
// CONCURRENT_ROLES champion-roles are worked on at once (the process-wide limiter still caps requests in flight).
// A champion-role that fails (after retries) is recorded in `failed` and the patch carries on; the next run of the
// patch retries only those. Only AUTH (401/403) and cancel stop the patch.
//
// opts: {
//   patch: '16.18' | { major, patch },
//   championRoles: [{ champion: 'Ahri', role: 'MIDDLE', championKey?: '103' }],  // key looked up in Data Dragon if absent
//   signal?, onProgress?({ done, total, champion, role, requests }), onCheckpoint?(state), resumeState?, patchMatchCount? }
// Returns { gz, state, champions, skipped, failed: [{ id, error }], requests, retries, bytes }.
// Throws Error('cancelled') on abort and CoachlessError 'AUTH' on refusal, both with err.resumeState set.
async function scrapePatch(opts) {
    const { championRoles, signal, onProgress = () => {}, onCheckpoint = () => {} } = opts;
    const label = typeof opts.patch === 'object' ? `${opts.patch.major}.${opts.patch.patch}` : String(opts.patch);
    parsePatch(label);
    const rs = opts.resumeState && opts.resumeState.patch === label ? opts.resumeState : null;
    const state = { version: SCHEMA_VERSION, patch: label, champions: rs ? rs.champions || {} : {}, skipped: rs ? (rs.skipped || []).slice() : [] };
    const client = createClient(signal);
    const failed = [];
    const total = championRoles.length;
    let done = 0, next = 0, fatal = null, keyByNameP = null;

    const worker = async () => {
        while (!fatal && next < championRoles.length) {
            const cr = championRoles[next++];
            const id = `${cr.champion}|${cr.role}`;
            if (!(state.champions[id] || state.skipped.includes(id))) {
                try {
                    let key = cr.championKey;
                    if (!key) {
                        if (!keyByNameP) keyByNameP = getChampionKeys().then(k => k.keyByName);
                        key = (await keyByNameP)[cr.champion];
                        if (!key) throw new Error(`Unknown champion "${cr.champion}"`);
                    }
                    const record = await scrapeChampionRole({ patch: label, champion: cr.champion, championKey: key, role: cr.role, client, signal });
                    if (record) state.champions[id] = record; else state.skipped.push(id);
                    onCheckpoint(state);
                } catch (e) {
                    if (e.message === 'cancelled' || e.code === 'AUTH' || e.code === 'RATE_LIMITED' || (signal && signal.aborted)) { fatal = fatal || e; return; }
                    failed.push({ id, error: e.message });
                }
            }
            onProgress({ done: ++done, total, champion: cr.champion, role: cr.role, requests: client.requests, failed: failed.length });
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENT_ROLES, Math.max(1, total)) }, worker));
    if (fatal) { fatal.resumeState = state; throw fatal; }

    if (!Object.keys(state.champions).length) {
        const e = new CoachlessError(`Coachless returned no data for ${label}${failed.length ? ` (${failed.length} champion-roles failed, e.g. ${failed[0].error})` : ''}`, 'NO_DATA');
        e.resumeState = state;
        throw e;
    }
    const dataset = buildDataset(label, state, opts.patchMatchCount);
    const gz = await gzip(Buffer.from(JSON.stringify(dataset)));
    return { gz, state, champions: Object.keys(state.champions).length, skipped: state.skipped.length, failed, requests: client.requests, retries: client.retries, bytes: gz.length };
}

// The stored dataset. Also exported so a caller can rebuild it from a saved resume state.
function buildDataset(label, state, patchMatchCount) {
    return {
        schema: SCHEMA_VERSION, patch: label, rank: RANK, source: 'coachless', scrapedAt: new Date().toISOString(),
        patchMatchCount: patchMatchCount || null, champions: state.champions
    };
}

module.exports = {
    getPatches, getChampionKeys, scrapeChampionRole, scrapeChampionRoleDetail, scrapeChampionRoleFull, rateLimitStatus,
    scrapeOverviewOnDemand, scrapeDetailOnDemand,
    scrapePatch, buildDataset, createClient,
    ROLE_IDS, SCHEMA_VERSION, DEFAULT_RUNE_OPTIONS, treeOfKeystone, MAX_CONCURRENT
};
