// desktop-app/arena-main.js
// Main-process side of the Arena mode (queues 1700 / 1710 / 1750). Registers 'arena:*' IPC channels:
//   arena:tier-list     {tier?, force?}        -> LoLalytics Arena tier list: rank, tier, top-half rate ("win"), pick, ban, games per champion
//   arena:champion      {slug, tier?, force?}  -> LoLalytics Arena build page of one champion: placement split, augments, items, best partners
//   arena:augments      {force?}               -> CommunityDragon's Arena augment list: id -> name, rarity, icon (icons only; optional)
//   arena:champ-select  {}                     -> normalised LCU champ-select state (own champion, teammates, taken / banned / pickable)
//   arena:cache-info    {}                     -> what is cached (for diagnostics)
//   arena:cache-clear   {}                     -> { ok, removed } drops the cache (Settings > Diagnostics)
// `tier` is the rank bracket: 'all' (default, all ranks) or 'emerald_plus'. Every data channel answers
// { ok:true, data, fetchedAt, stale, error? } or { ok:false, code, error }. Push event: 'arena:updated' { kind, key, fetchedAt }
// after a background refresh replaced stale cache data. Where the data comes from and how it is read: see arena-parsers.js.
//
// Network etiquette (same as aram-main.js): fetched only when asked for (opening the view, picking a champion; nothing in bulk, no
// timers), at most 2 requests in flight per host, an honest User-Agent, a failed URL is not retried for 60 s (Retry-After honoured),
// and a disk cache (userData/arena-cache/*.json.gz, TTL 6 h; the augment list 24 h). A cached entry is served at once; when it is
// older than its TTL it is returned with stale:true and refreshed in the background. Entries written by an older PARSER_VERSION are
// ignored. Riot policy: this module reads the champion-select state only; it shows nothing in game and has no timers.

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const parsers = require('./arena-parsers');
const { getSharedLcu } = require('./profile-lcu');

const TTL_MS = 6 * 3600 * 1000;
const AUGMENTS_TTL_MS = 24 * 3600 * 1000;
const PARSER_VERSION = 1;            // bump when a parser changes shape: older cache entries are then ignored
const MAX_PER_HOST = 2;
const USER_AGENT = 'DraftDiff-personal/1.0 (personal desktop tool; on-demand fetches, 6h cache)';
const SLUG_RE = /^[a-z0-9]{1,30}$/;
const ORIGIN = 'https://lolalytics.com';
const AUGMENTS_URL = 'https://raw.communitydragon.org/latest/cdragon/arena/en_us.json';
const ARENA_QUEUES = { 1700: 'Arena', 1710: 'Arena', 1750: 'Arena 3x6' };
const IN_GAME_PHASES = new Set(['GameStart', 'InProgress', 'Reconnect']);
const bracketOf = a => (a && a.tier === 'emerald_plus' ? 'emerald_plus' : 'all');
const tierUrl = b => `${ORIGIN}/lol/tierlist/arena/${b === 'all' ? '?tier=all' : ''}`;
const champUrl = (slug, b) => `${ORIGIN}/lol/${slug}/arena/build/${b === 'all' ? '?tier=all' : ''}`;

// ---- HTTP with a per-host concurrency limit ----------------------------------------------------------------------------------
const hostBusy = new Map();   // host -> { active, queue: [] }
function acquire(host) {
    let h = hostBusy.get(host);
    if (!h) { h = { active: 0, queue: [] }; hostBusy.set(host, h); }
    if (h.active < MAX_PER_HOST) { h.active++; return Promise.resolve(); }
    return new Promise(res => h.queue.push(res));
}
function release(host) {
    const h = hostBusy.get(host);
    if (!h) return;
    const next = h.queue.shift();
    if (next) next(); else h.active--;
}

// A failed fetch (429 / network / HTTP error) is not retried for a while: per URL, honoring Retry-After.
const BACKOFF_MS = 60000;
const backoff = new Map();   // url -> { until, error }

function httpGet(url, redirects = 3) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.get(u, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/json', 'Accept-Encoding': 'gzip, deflate' }, timeout: 20000 }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
                res.resume();
                const next = new URL(res.headers.location, u).toString();
                if (new URL(next).protocol !== 'https:') return reject(Object.assign(new Error('redirect to non-https'), { code: 'NETWORK' }));
                return httpGet(next, redirects - 1).then(resolve, reject);
            }
            const enc = (res.headers['content-encoding'] || '').toLowerCase();
            const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
            const chunks = []; let size = 0;
            stream.on('data', c => { size += c.length; if (size > 8 * 1024 * 1024) { req.destroy(new Error('response too large')); } else chunks.push(c); });
            stream.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), retryAfter: Number(res.headers['retry-after']) || 0 }));
            stream.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

async function fetchPage(url) {
    const host = new URL(url).host;
    const bo = backoff.get(url);
    if (bo && bo.until > Date.now()) throw Object.assign(new Error(bo.error.message + ' (not retrying yet)'), { code: bo.error.code });
    await acquire(host);
    try {
        let r;
        const fail = (err, ms = BACKOFF_MS) => { backoff.set(url, { until: Date.now() + ms, error: err }); return err; };
        try { r = await httpGet(url); }
        catch (e) { throw fail(Object.assign(new Error('Network error: ' + e.message), { code: 'NETWORK' })); }
        if (r.status === 404) throw Object.assign(new Error('Page not found (404)'), { code: 'NOT_FOUND' });
        if (r.status === 429) throw fail(Object.assign(new Error('Rate limited by the site (429); try again later'), { code: 'RATE_LIMITED' }), Math.max(BACKOFF_MS, r.retryAfter * 1000));
        if (r.status !== 200) throw fail(Object.assign(new Error('HTTP ' + r.status), { code: 'HTTP_' + r.status }));
        backoff.delete(url);
        return r.text;
    } finally {
        release(host);
    }
}

// ---- Disk cache (gzip JSON) + in-memory layer --------------------------------------------------------------------------------
function createCache(dir, version = PARSER_VERSION) {
    const mem = new Map();   // key -> { fetchedAt, data }
    const fileFor = key => path.join(dir, key.replace(/[^a-z0-9._-]/gi, '_') + '.json.gz');
    return {
        dir,
        get(key) {
            if (mem.has(key)) return mem.get(key);
            try {
                const o = JSON.parse(zlib.gunzipSync(fs.readFileSync(fileFor(key))).toString('utf8'));
                if (o && o.v === version && typeof o.fetchedAt === 'number') { const e = { fetchedAt: o.fetchedAt, data: o.data }; mem.set(key, e); return e; }
            } catch (e) { /* missing or corrupt: treated as a miss */ }
            return null;
        },
        set(key, data) {
            const e = { fetchedAt: Date.now(), data };
            mem.set(key, e);
            try {
                fs.mkdirSync(dir, { recursive: true });
                const tmp = fileFor(key) + '.tmp';
                fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify({ v: version, fetchedAt: e.fetchedAt, data })));
                fs.renameSync(tmp, fileFor(key));
            } catch (err) { /* cache is best effort */ }
            return e;
        },
        list() {
            try { return fs.readdirSync(dir).filter(f => f.endsWith('.json.gz')).map(f => ({ file: f, bytes: fs.statSync(path.join(dir, f)).size, at: fs.statSync(path.join(dir, f)).mtimeMs })); }
            catch (e) { return []; }
        },
        // Settings > Diagnostics: drop everything (memory and disk); the next view fetches again
        clear() {
            mem.clear();
            let n = 0;
            for (const f of this.list()) { try { fs.unlinkSync(path.join(dir, f.file)); n++; } catch (e) { /* in use or gone */ } }
            return n;
        }
    };
}

// ---- Cached loader: fresh -> as is; stale -> return at once + refresh in the background; miss -> fetch ----------------------
function createLoader(cache, notify, defaultTtl = TTL_MS) {
    const inflight = new Map();   // key -> Promise<entry>
    function refresh(key, produce) {
        if (inflight.has(key)) return inflight.get(key);
        const p = (async () => {
            try { return cache.set(key, await produce()); }
            finally { inflight.delete(key); }
        })();
        inflight.set(key, p);
        return p;
    }
    return async function load(key, kind, produce, force, ttl = defaultTtl) {
        const hit = cache.get(key);
        const age = hit ? Date.now() - hit.fetchedAt : Infinity;
        if (hit && !force && age < ttl) return { ok: true, data: hit.data, fetchedAt: hit.fetchedAt, stale: false };
        if (hit && !force) {
            refresh(key, produce).then(e => notify && notify({ kind, key, fetchedAt: e.fetchedAt }), () => { /* keep serving the stale copy */ });
            return { ok: true, data: hit.data, fetchedAt: hit.fetchedAt, stale: true };
        }
        try {
            const e = await refresh(key, produce);
            return { ok: true, data: e.data, fetchedAt: e.fetchedAt, stale: false };
        } catch (err) {
            if (hit) return { ok: true, data: hit.data, fetchedAt: hit.fetchedAt, stale: true, error: err.message };
            return { ok: false, code: err.code || 'ERROR', error: err.message || String(err) };
        }
    };
}

// ---- LCU champ select --------------------------------------------------------------------------------------------------------
const posInts = list => (Array.isArray(list) ? list : []).map(x => (x && typeof x === 'object' ? x.championId : x)).filter(id => Number.isInteger(id) && id > 0);

// Who is on your Arena team. The client may send only your team in myTeam, or the whole lobby with a team marker per player
// (subteamIndex, or team). Returns the other members of your team, and whether we could tell.
function teammatesOf(local, myTeam) {
    if (!local) return { mates: [], known: false };
    const others = myTeam.filter(p => p !== local);
    if (Number.isInteger(local.subteamIndex)) return { mates: others.filter(p => p.subteamIndex === local.subteamIndex), known: true };
    if (local.team != null && new Set(myTeam.map(p => p.team)).size > 1) return { mates: others.filter(p => p.team === local.team), known: true };
    if (myTeam.length <= 3) return { mates: others, known: true };   // myTeam is just your own pair (or trio)
    return { mates: [], known: false };                              // the whole lobby, with no sign of who your team is
}

// Hovered (not yet locked) champion of a cell, from the pick actions.
function hoveredBy(session, cellId) {
    for (const group of Array.isArray(session.actions) ? session.actions : []) {
        for (const a of Array.isArray(group) ? group : []) {
            if (a && a.type === 'pick' && a.actorCellId === cellId && Number.isInteger(a.championId) && a.championId > 0) return a.championId;
        }
    }
    return 0;
}

async function normaliseChampSelect(session, flow, getPickable) {
    const queue = (flow && flow.gameData && flow.gameData.queue) || {};
    const queueId = typeof queue.id === 'number' ? queue.id : (typeof queue.queueId === 'number' ? queue.queueId : null);
    const gameMode = queue.gameMode || (flow && flow.gameData && flow.gameData.gameMode) || null;
    const isArena = ARENA_QUEUES[queueId] != null || gameMode === 'CHERRY';
    const myTeam = Array.isArray(session.myTeam) ? session.myTeam : [];
    const theirTeam = Array.isArray(session.theirTeam) ? session.theirTeam : [];
    const local = myTeam.find(p => p.cellId === session.localPlayerCellId) || null;
    const { mates, known } = teammatesOf(local, myTeam);
    const lockedMine = local && local.championId > 0 ? local.championId : 0;
    const hover = !lockedMine && local ? hoveredBy(session, local.cellId) : 0;
    const bans = session.bans || {};
    const pickable = await getPickable();
    return {
        connected: true, phase: 'ChampSelect', inChampSelect: true,
        queueId, queueName: queue.name || ARENA_QUEUES[queueId] || null, gameMode, isArena,
        mine: lockedMine || hover, mineLocked: !!lockedMine,
        mates: mates.map(p => ({ cellId: p.cellId, championId: p.championId > 0 ? p.championId : 0 })),
        teamKnown: known,
        taken: [...new Set(myTeam.concat(theirTeam).filter(p => p !== local).map(p => p.championId).filter(id => Number.isInteger(id) && id > 0))],
        banned: [...new Set(posInts(bans.myTeamBans).concat(posInts(bans.theirTeamBans)))],
        pickable: Array.isArray(pickable) && pickable.length ? pickable.filter(id => Number.isInteger(id) && id > 0) : null
    };
}

function createLcu(deps) {
    // Shared with the Profile and ARAM views: cached credentials, and the lookup (which spawns a process) backs off 8 -> 60 s while the client is closed.
    const shared = getSharedLcu(deps);
    async function get(p) {
        const r = await shared.get(p);
        if (r == null && !shared.isUp()) throw new Error('League client not found');
        return r;
    }
    // Loading screen / in game: champ select is over, but the gameflow session lists every player's champion with their puuid
    // (gameData.playerChampionSelections), so the view can keep showing yours.
    let myPuuid = null;
    async function inGameState(phase) {
        const flow = await get('/lol-gameflow/v1/session').catch(() => null);
        const g = (flow && flow.gameData) || {};
        const queue = g.queue || {};
        if (!myPuuid) { const me = await get('/lol-summoner/v1/current-summoner').catch(() => null); myPuuid = me && me.puuid; }
        const sel = (g.playerChampionSelections || []).find(p => myPuuid && p.puuid === myPuuid);
        const queueId = typeof queue.id === 'number' ? queue.id : null;
        return {
            connected: true, phase, inChampSelect: false, inGame: true,
            queueId, queueName: queue.name || ARENA_QUEUES[queueId] || null, gameMode: queue.gameMode || null,
            isArena: ARENA_QUEUES[queueId] != null || queue.gameMode === 'CHERRY',
            mine: sel && sel.championId > 0 ? sel.championId : 0
        };
    }
    return {
        get,
        async champSelect() {
            let phase;
            try { phase = await get('/lol-gameflow/v1/gameflow-phase'); }
            catch (e) { return { connected: false, inChampSelect: false, error: e.message }; }
            if (phase == null) { shared.invalidate(); return { connected: false, inChampSelect: false }; }   // 200-less reply: stale credentials
            if (IN_GAME_PHASES.has(phase)) return inGameState(phase);
            if (phase !== 'ChampSelect') return { connected: true, phase, inChampSelect: false };
            const [session, flow] = await Promise.all([get('/lol-champ-select/v1/session'), get('/lol-gameflow/v1/session').catch(() => null)]);
            if (!session) return { connected: true, phase, inChampSelect: false };
            return normaliseChampSelect(session, flow, () => get('/lol-champ-select/v1/pickable-champion-ids').catch(() => null));
        }
    };
}

// ---- Registration ------------------------------------------------------------------------------------------------------------
const parseFail = what => Object.assign(new Error(`Could not read the ${what} (the site layout may have changed)`), { code: 'PARSE' });

function register(deps) {
    const { ipcMain, userDataPath, sendToWindow } = deps;
    const fetchText = deps.arenaFetch || fetchPage;     // tests inject a stub
    const cache = createCache(path.join(userDataPath, 'arena-cache'));
    const load = createLoader(cache, ev => { try { sendToWindow && sendToWindow('arena:updated', ev); } catch (e) { /* window gone */ } });
    const lcu = createLcu(deps);
    const bad = (code, error) => ({ ok: false, code, error });
    const slugOf = a => { const s = String((a && a.slug) || '').toLowerCase(); return SLUG_RE.test(s) ? s : null; };

    ipcMain.handle('arena:tier-list', (e, a) => {
        const b = bracketOf(a);
        return load('tier-' + b, 'tier-list', async () => {
            const d = parsers.parseTierList(await fetchText(tierUrl(b)));
            if (!d) throw parseFail('Arena tier list page');
            d.url = tierUrl(b);
            return d;
        }, !!(a && a.force));
    });
    ipcMain.handle('arena:champion', (e, a) => {
        const slug = slugOf(a); if (!slug) return bad('BAD_REQUEST', 'Invalid champion slug');
        const b = bracketOf(a);
        return load(`champ-${slug}-${b}`, 'champion', async () => {
            const d = parsers.parseChampionPage(await fetchText(champUrl(slug, b)));
            if (!d) throw parseFail('Arena build page');
            d.url = champUrl(slug, b);
            return d;
        }, !!a.force);
    });
    ipcMain.handle('arena:augments', (e, a) => load('augments', 'augments', async () => {
        const d = parsers.parseAugmentMeta(await fetchText(AUGMENTS_URL));
        if (!d) throw parseFail('Arena augment list');
        return d;
    }, !!(a && a.force), AUGMENTS_TTL_MS));
    ipcMain.handle('arena:champ-select', async () => {
        try { return { ok: true, data: await lcu.champSelect(), fetchedAt: Date.now(), stale: false }; }
        catch (err) { return { ok: true, data: { connected: false, inChampSelect: false, error: err.message }, fetchedAt: Date.now(), stale: false }; }
    });
    ipcMain.handle('arena:cache-info', () => ({ ok: true, data: { dir: cache.dir, ttlMs: TTL_MS, files: cache.list() }, fetchedAt: Date.now(), stale: false }));
    ipcMain.handle('arena:cache-clear', () => ({ ok: true, removed: cache.clear() }));
}

module.exports = { register, ARENA_QUEUES, _internals: { createCache, createLoader, normaliseChampSelect, teammatesOf, fetchPage, tierUrl, champUrl, resetBackoff: () => backoff.clear(), TTL_MS, AUGMENTS_TTL_MS, PARSER_VERSION } };
