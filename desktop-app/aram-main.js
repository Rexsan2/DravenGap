// desktop-app/aram-main.js
// Main-process side of the ARAM Mayhem mode. Registers 'aram:*' IPC channels:
//   aram:tier-list     {force?}               -> arammayhem.com tier list (win rate / tier / rank per champion)
//   aram:champion      {slug, force?}         -> arammayhem.com build page: augments (Prismatic/Gold/Silver), meta (items come from LoLalytics only)
//   aram:items         {slug, tier?, force?}  -> LoLalytics ARAM build (regular ARAM, not Mayhem): spells, start, core, boots, item 4/5/6
//   aram:champ-select  {}                     -> normalised LCU champ-select state (own champ, bench, teammates, rerolls, queue)
//                                                (own champ = myTeam championId, else /lol-champ-select/v1/current-champion, else championPickIntent; `mineSource` says which)
//   aram:champ-snapshot {}                    -> { ok, text, copied, lines } the raw champ-select session as JSON with names / puuids / Riot IDs removed, also put on
//                                                the clipboard (Settings > Diagnostics: "Copy champion select snapshot")
//   aram:cache-info    {}                     -> what is cached (for diagnostics)
//   aram:cache-clear   {}                     -> { ok, removed } drops the cache (Settings > Diagnostics)
// Every data channel answers { ok:true, data, fetchedAt, stale, error? } or { ok:false, code, error }.
// Push event: 'aram:updated' { kind, key, fetchedAt } after a background refresh replaced stale cache data.
//
// Network etiquette: fetched only when asked for (no crawling), at most 2 requests in flight per host, an honest User-Agent,
// and a disk cache (userData/aram-cache/*.json.gz, TTL 6 h). A cached entry is served at once; when it is older than the TTL it
// is returned with stale:true and refreshed in the background.

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const parsers = require('./aram-parsers');
const { getSharedLcu } = require('./profile-lcu');

const TTL_MS = 6 * 3600 * 1000;
const PARSER_VERSION = 3;            // bump when a parser changes shape: older cache entries are then ignored
const MAX_PER_HOST = 2;
const USER_AGENT = 'DraftDiff-personal/1.0 (personal desktop tool; on-demand fetches, 6h cache)';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
// arammayhem.com slug -> LoLalytics slug where they differ (verified against lolalytics.com/lol/<slug>/aram/build/:
// every other slug, e.g. jarvaniv, nunu, renata, belveth, velkoz, chogath, khazix, kaisa, ksante, drmundo, leesin, masteryi,
// missfortune, twistedfate, xinzhao, tahmkench, aurelionsol, reksai, kogmaw, answers 200 with the same name; monkeyking is a 404).
const LOLALYTICS_SLUG = { monkeyking: 'wukong' };
const lolalyticsSlug = slug => LOLALYTICS_SLUG[slug] || slug;
const ARAM_QUEUES = { 450: 'ARAM', 2400: 'ARAM: Mayhem' };
const IN_GAME_PHASES = new Set(['GameStart', 'InProgress', 'Reconnect']);

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
        const req = https.get(u, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Encoding': 'gzip, deflate' }, timeout: 20000 }, res => {
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
function createCache(dir) {
    const mem = new Map();   // key -> { fetchedAt, data }
    const fileFor = key => path.join(dir, key.replace(/[^a-z0-9._-]/gi, '_') + '.json.gz');
    return {
        dir,
        get(key) {
            if (mem.has(key)) return mem.get(key);
            try {
                const o = JSON.parse(zlib.gunzipSync(fs.readFileSync(fileFor(key))).toString('utf8'));
                if (o && o.v === PARSER_VERSION && typeof o.fetchedAt === 'number') { const e = { fetchedAt: o.fetchedAt, data: o.data }; mem.set(key, e); return e; }
            } catch (e) { /* missing or corrupt: treated as a miss */ }
            return null;
        },
        set(key, data) {
            const e = { fetchedAt: Date.now(), data };
            mem.set(key, e);
            try {
                fs.mkdirSync(dir, { recursive: true });
                const tmp = fileFor(key) + '.tmp';
                fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify({ v: PARSER_VERSION, fetchedAt: e.fetchedAt, data })));
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
function createLoader(cache, notify) {
    const inflight = new Map();   // key -> Promise<entry>
    function refresh(key, kind, produce) {
        if (inflight.has(key)) return inflight.get(key);
        const p = (async () => {
            try { return cache.set(key, await produce()); }
            finally { inflight.delete(key); }
        })();
        inflight.set(key, p);
        return p;
    }
    return async function load(key, kind, produce, force) {
        const hit = cache.get(key);
        const age = hit ? Date.now() - hit.fetchedAt : Infinity;
        if (hit && !force && age < TTL_MS) return { ok: true, data: hit.data, fetchedAt: hit.fetchedAt, stale: false };
        if (hit && !force) {
            refresh(key, kind, produce).then(e => notify && notify({ kind, key, fetchedAt: e.fetchedAt }), () => { /* keep serving the stale copy */ });
            return { ok: true, data: hit.data, fetchedAt: hit.fetchedAt, stale: true };
        }
        try {
            const e = await refresh(key, kind, produce);
            return { ok: true, data: e.data, fetchedAt: e.fetchedAt, stale: false };
        } catch (err) {
            if (hit) return { ok: true, data: hit.data, fetchedAt: hit.fetchedAt, stale: true, error: err.message };
            return { ok: false, code: err.code || 'ERROR', error: err.message || String(err) };
        }
    };
}

// ---- Producers ---------------------------------------------------------------------------------------------------------------
const parseFail = what => Object.assign(new Error(`Could not read the ${what} page (the site layout may have changed)`), { code: 'PARSE' });
const produceTierList = async () => { const d = parsers.parseTierList(await fetchPage('https://arammayhem.com/tier-list/')); if (!d) throw parseFail('ARAM Mayhem tier list'); return d; };
const produceChampion = slug => async () => { const d = parsers.parseChampionPage(await fetchPage(`https://arammayhem.com/build/${slug}/`)); if (!d) throw parseFail('ARAM Mayhem build'); d.slug = slug; return d; };
const produceItems = (slug, tier) => async () => {
    const url = `https://lolalytics.com/lol/${lolalyticsSlug(slug)}/aram/build/?patch=30${tier === 'all' ? '&tier=all' : ''}`;
    const d = parsers.parseLolalytics(await fetchPage(url));
    if (!d) throw parseFail('LoLalytics ARAM build');
    d.slug = slug; d.url = url;
    return d;
};

// ---- LCU champ select --------------------------------------------------------------------------------------------------------
function createLcu(deps) {
    // Shared with the Profile view: cached credentials, and the lookup (which spawns a process) backs off 8 -> 60 s while the client is closed.
    const shared = getSharedLcu(deps);
    async function get(p) {
        const r = await shared.get(p);
        if (r == null && !shared.isUp()) throw new Error('League client not found');
        return r;
    }
    // Loading screen / in game: champ select is over, but the gameflow session lists every player's champion with their
    // puuid (gameData.playerChampionSelections, checked against a live Mayhem game), so the view can keep showing yours.
    let myPuuid = null;
    async function inGameState(phase) {
        const flow = await get('/lol-gameflow/v1/session').catch(() => null);
        const g = (flow && flow.gameData) || {};
        const queue = g.queue || {};
        if (!myPuuid) { const me = await get('/lol-summoner/v1/current-summoner').catch(() => null); myPuuid = me && me.puuid; }
        const sel = (g.playerChampionSelections || []).find(p => myPuuid && p.puuid === myPuuid);
        const queueId = typeof queue.id === 'number' ? queue.id : null;
        const isMayhem = queueId === 2400 || queue.gameMode === 'KIWI';
        return {
            connected: true, phase, inChampSelect: false, inGame: true,
            queueId, queueName: queue.name || ARAM_QUEUES[queueId] || null, gameMode: queue.gameMode || null,
            isAram: isMayhem || queueId === 450 || queue.gameMode === 'ARAM', isMayhem,
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
            return normaliseChampSelect(session, flow, rerollPointsFn, currentChampionFn);
        },
        // Settings > Diagnostics: what the client reports in champion select, without names, for checking which field holds your champion
        async snapshot() {
            let phase;
            try { phase = await get('/lol-gameflow/v1/gameflow-phase'); }
            catch (e) { return { ok: false, error: 'League client not found.' }; }
            if (phase !== 'ChampSelect') return { ok: false, error: `Not in champion select (${phase || 'client not found'}): open this during champion select.` };
            const [session, flow, current] = await Promise.all([get('/lol-champ-select/v1/session').catch(() => null), get('/lol-gameflow/v1/session').catch(() => null), currentChampionFn()]);
            if (!session) return { ok: false, error: 'The client has no champion select session right now.' };
            const normalised = await normaliseChampSelect(session, flow, rerollPointsFn, async () => current);
            return { ok: true, text: JSON.stringify(buildSnapshot({ session, flow, current, normalised }), null, 2) };
        }
    };
    async function rerollPointsFn() { return get('/lol-summoner/v1/current-summoner/rerollPoints').catch(() => null); }
    async function currentChampionFn() { return get('/lol-champ-select/v1/current-champion').catch(() => null); }
}

// ---- Champ-select snapshot (names removed) -----------------------------------------------------------------------------------
// Keys whose values identify a player (or carry a chat / login token) are replaced; strings elsewhere are scrubbed for puuid-like
// tokens, JWTs and Name#TAG. Champion ids, cell ids, rerolls, the bench and timers stay: that is what the owner needs to read.
const SENSITIVE_KEYS = new Set(['summonername', 'gamename', 'tagline', 'gametag', 'riotid', 'displayname', 'internalname', 'playername', 'nickname', 'playeralias', 'alias',
    'puuid', 'obfuscatedpuuid', 'summonerid', 'obfuscatedsummonerid', 'accountid', 'chatdetails', 'mucjwtdto', 'chatroomname', 'chatroompassword']);
const REMOVED = '[removed]';
function scrubString(v) {
    return v.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, REMOVED).replace(/\b[A-Za-z0-9_-]{50,}\b/g, REMOVED).replace(/[\w .'-]{3,16}#[A-Za-z0-9]{3,5}\b/g, REMOVED);
}
function redactSnapshot(value) {
    let removed = 0;
    const walk = v => {
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') {
            const o = {};
            for (const [k, x] of Object.entries(v)) {
                if (SENSITIVE_KEYS.has(k.toLowerCase()) && x !== null && x !== undefined && x !== '') { o[k] = REMOVED; removed++; } else o[k] = walk(x);
            }
            return o;
        }
        if (typeof v === 'string') { const t = scrubString(v); if (t !== v) removed++; return t; }
        return v;
    };
    return { value: walk(value), removed };
}
function buildSnapshot({ session, flow, current, normalised }) {
    const q = (flow && flow.gameData && flow.gameData.queue) || null;
    const r = redactSnapshot({ session, queue: q ? { id: q.id, gameMode: q.gameMode, name: q.name, mapId: q.mapId } : null, currentChampion: current === undefined ? null : current });
    return {
        note: 'DravenGap champion select snapshot. Summoner names, Riot IDs, puuids and chat tokens are removed.', capturedAt: new Date().toISOString(), removedFields: r.removed,
        readAs: normalised ? { mine: normalised.mine, mineSource: normalised.mineSource, bench: normalised.bench, benchEnabled: normalised.benchEnabled, rerolls: normalised.rerolls, rerollSource: normalised.rerollSource, queueId: normalised.queueId } : null,
        ...r.value
    };
}

// Your champion in champion select. Early in ARAM the myTeam entry can still say championId 0 while the client already knows the
// champion: read, in order, myTeam[you].championId, the current-champion endpoint, then championPickIntent.
const champId = v => {
    const n = v && typeof v === 'object' ? Number(v.championId) : Number(v);
    return Number.isInteger(n) && n > 0 ? n : 0;
};
async function ownChampion(local, currentChampion) {
    const direct = champId(local && local.championId);
    if (direct) return { id: direct, source: 'championId' };
    let cur = 0;
    if (typeof currentChampion === 'function') { try { cur = champId(await currentChampion()); } catch (e) { /* endpoint missing or client busy */ } }
    if (cur) return { id: cur, source: 'current-champion' };
    const intent = champId(local && local.championPickIntent);
    if (intent) return { id: intent, source: 'pick-intent' };
    return { id: 0, source: null };
}

// currentChampion (optional): async () => the client's /lol-champ-select/v1/current-champion answer, asked only when myTeam has no champion for you
async function normaliseChampSelect(session, flow, rerollPoints, currentChampion) {
    const queue = (flow && flow.gameData && flow.gameData.queue) || {};
    const queueId = typeof queue.id === 'number' ? queue.id : (typeof queue.queueId === 'number' ? queue.queueId : null);
    const gameMode = queue.gameMode || (flow && flow.gameData && flow.gameData.gameMode) || null;
    const isMayhem = queueId === 2400 || gameMode === 'KIWI';
    const isAram = isMayhem || queueId === 450 || gameMode === 'ARAM';
    const myTeam = Array.isArray(session.myTeam) ? session.myTeam : [];
    const local = myTeam.find(p => p.cellId === session.localPlayerCellId) || null;
    const bench = (Array.isArray(session.benchChampions) ? session.benchChampions : [])
        .map(b => (b && typeof b === 'object') ? b.championId : b).filter(id => Number.isInteger(id) && id > 0);
    let rerolls = [session.rerollsRemaining, local && local.rerollsRemaining].find(n => Number.isInteger(n));
    let rerollSource = rerolls != null ? 'session' : null;
    if (rerolls == null) {
        const rp = await rerollPoints();
        if (rp && Number.isInteger(rp.numberOfRolls)) { rerolls = rp.numberOfRolls; rerollSource = 'reroll-points'; }
    }
    const own = await ownChampion(local, currentChampion);
    return {
        connected: true, phase: 'ChampSelect', inChampSelect: true,
        queueId, queueName: queue.name || ARAM_QUEUES[queueId] || null, gameMode, isAram, isMayhem,
        benchEnabled: !!session.benchEnabled || bench.length > 0,
        mine: own.id, mineSource: own.source,
        bench,
        team: myTeam.filter(p => p !== local && p.championId > 0).map(p => ({ cellId: p.cellId, championId: p.championId })),
        rerolls: rerolls == null ? null : rerolls, rerollSource,
        timer: session.timer && session.timer.phase ? session.timer.phase : null
    };
}

// Electron's clipboard from the main process (works without window focus); false when not running inside Electron
function copyToClipboard(text) {
    try { const { clipboard } = require('electron'); if (clipboard && typeof clipboard.writeText === 'function') { clipboard.writeText(text); return true; } } catch (e) { /* plain Node */ }
    return false;
}

// ---- Registration ------------------------------------------------------------------------------------------------------------
function register(deps) {
    const { ipcMain, userDataPath, sendToWindow } = deps;
    const cache = createCache(path.join(userDataPath, 'aram-cache'));
    const load = createLoader(cache, ev => { try { sendToWindow && sendToWindow('aram:updated', ev); } catch (e) { /* window gone */ } });
    const lcu = createLcu(deps);
    const bad = (code, error) => ({ ok: false, code, error });
    const slugOf = a => { const s = String((a && a.slug) || '').toLowerCase(); return SLUG_RE.test(s) ? s : null; };

    ipcMain.handle('aram:tier-list', (e, a) => load('tier-list', 'tier-list', produceTierList, !!(a && a.force)));
    ipcMain.handle('aram:champion', (e, a) => {
        const slug = slugOf(a); if (!slug) return bad('BAD_REQUEST', 'Invalid champion slug');
        return load('champion-' + slug, 'champion', produceChampion(slug), !!a.force);
    });
    ipcMain.handle('aram:items', (e, a) => {
        const slug = slugOf(a); if (!slug) return bad('BAD_REQUEST', 'Invalid champion slug');
        const tier = a.tier === 'emerald' ? 'emerald' : 'all';
        return load(`items-${slug}-${tier}`, 'items', produceItems(slug, tier), !!a.force);
    });
    ipcMain.handle('aram:champ-select', async () => {
        try { return { ok: true, data: await lcu.champSelect(), fetchedAt: Date.now(), stale: false }; }
        catch (err) { return { ok: true, data: { connected: false, inChampSelect: false, error: err.message }, fetchedAt: Date.now(), stale: false }; }
    });
    ipcMain.handle('aram:champ-snapshot', async () => {
        try {
            const r = await lcu.snapshot();
            if (!r.ok) return r;
            let copied = false;
            try { copied = !!(deps.clipboardWrite || copyToClipboard)(r.text); } catch (e) { /* the window copies it instead */ }
            return { ok: true, text: r.text, copied, lines: r.text.split('\n').length };
        } catch (err) { return { ok: false, error: err.message }; }
    });
    ipcMain.handle('aram:cache-info', () => ({ ok: true, data: { dir: cache.dir, ttlMs: TTL_MS, files: cache.list() }, fetchedAt: Date.now(), stale: false }));
    ipcMain.handle('aram:cache-clear', () => ({ ok: true, removed: cache.clear() }));
}

module.exports = { register, _internals: { lolalyticsSlug, resetBackoff: () => backoff.clear(), createCache, createLoader, normaliseChampSelect, redactSnapshot, buildSnapshot, fetchPage, TTL_MS } };
