// desktop-app/profile-seasons.js
// Past-season ranks for the Profile view, merged from three sources:
//   op.gg    the player's op.gg page embeds the "Past seasons" lists as Next.js RSC JSON (self.__next_f.push chunks):
//            arrays of { season:"S2024 S3", rank_entries:{ rank_info:{value:"EMERALD",division:2,lp:"81"}, high_rank_info:{...} } }
//            one array per queue (Solo/Duo first, Flex second). Fetched on demand, at most once per player per 7 days.
//   client   /lol-ranked/v1/ranked-stats previous-season fields (no extra request: stored when the ranked stats are read)
//   recorded local snapshots of every league fetch (the current season builds up history)
// Pure helpers are exported for tests; createOpgg() holds the polite fetcher (cache, back-off, serialisation).
const https = require('https');
const http = require('http');
const zlib = require('zlib');

const SOLO = 'RANKED_SOLO_5x5', FLEX = 'RANKED_FLEX_SR';
const TIER_ORDER = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
const APEX = ['MASTER', 'GRANDMASTER', 'CHALLENGER'];
const ROMAN = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV' };
const ROMAN_VAL = { I: 4, II: 3, III: 2, IV: 1 };
const OPGG_REGION = { EUW1: 'euw', EUN1: 'eune', NA1: 'na', KR: 'kr', BR1: 'br', LA1: 'lan', LA2: 'las', OC1: 'oce', TR1: 'tr', RU: 'ru', JP1: 'jp', PH2: 'ph', SG2: 'sg', TH2: 'th', TW2: 'tw', VN2: 'vn', ME1: 'me' };

const TTL = { ok: 7 * 24 * 3600e3, empty: 24 * 3600e3, fail: 3600e3, champs: 6 * 3600e3, action: 14 * 24 * 3600e3 };
const MAX_SNAPS = 600;

// ---------- op.gg page parsing ----------

// Concatenate the string chunks of every self.__next_f.push([1,"..."]) call (the RSC flight payload).
function extractRsc(html) {
    const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
    let m, out = '', n = 0;
    while ((m = re.exec(html))) { try { out += JSON.parse(m[1]); n++; } catch (e) { /* skip a damaged chunk */ } }
    return { text: out, chunks: n };
}

// Balanced-bracket slice of the JSON value that starts at text[start] ('[' or '{'); string aware. null if unbalanced.
function sliceJson(text, start) {
    let d = 0, inS = false;
    for (let j = start; j < text.length; j++) {
        const c = text[j];
        if (inS) { if (c === '\\') j++; else if (c === '"') inS = false; continue; }
        if (c === '"') inS = true;
        else if (c === '[' || c === '{') d++;
        else if (c === ']' || c === '}') { d--; if (d === 0) return text.slice(start, j + 1); }
    }
    return null;
}

function tierOf(info) {
    if (!info || typeof info !== 'object') return null;
    const t = String(info.value || '').toUpperCase();
    if (!TIER_ORDER.includes(t)) return null; // "Unranked", "" ...
    const dv = Number(info.division);
    const rank = APEX.includes(t) ? 'I' : (ROMAN[dv] || null);
    const lp = info.lp == null || info.lp === '' ? null : parseInt(info.lp, 10);
    return { tier: t, rank, lp: Number.isFinite(lp) ? lp : null };
}

function seasonEntry(raw) {
    if (!raw || typeof raw.season !== 'string') return null;
    const season = raw.season.trim();
    if (!season || season.length > 24) return null;
    const re = raw.rank_entries || {};
    const end = tierOf(re.rank_info), peak = tierOf(re.high_rank_info);
    if (!end && !peak) return null; // unranked that season
    return { season, end, peak };
}

// -> { ok, solo:[{season,end,peak}], flex:[...], hasRsc }.  ok=false means the page did not look like what we expect.
function parseOpgg(html) {
    const res = { ok: false, solo: [], flex: [], hasRsc: false };
    if (typeof html !== 'string' || html.length < 1000) return res;
    const { text, chunks } = extractRsc(html);
    res.hasRsc = chunks > 0;
    if (!chunks) return res;
    res.meta = parseMeta(text);
    res.chunkUrls = chunkUrls(html, text);
    const blocks = [];
    const re = /\[\{"season":"/g;
    let m;
    while ((m = re.exec(text))) {
        const js = sliceJson(text, m.index);
        if (!js) continue;
        let arr; try { arr = JSON.parse(js); } catch (e) { continue; }
        if (!Array.isArray(arr) || !arr.every(x => x && typeof x === 'object' && 'rank_entries' in x)) continue;
        // which queue? the nearest header text before the array
        const back = text.slice(Math.max(0, m.index - 12000), m.index);
        const si = back.lastIndexOf('Ranked Solo/Duo'), fi = back.lastIndexOf('Ranked Flex');
        const q = si < 0 && fi < 0 ? null : si > fi ? SOLO : FLEX;
        blocks.push({ q, entries: arr.map(seasonEntry).filter(Boolean), at: m.index });
        re.lastIndex = m.index + js.length;
    }
    if (!blocks.length) return res;
    // blocks without a recognisable header take the queues that are left, in page order (Solo/Duo first)
    const taken = new Set(blocks.map(b => b.q).filter(Boolean));
    const left = [SOLO, FLEX].filter(q => !taken.has(q));
    for (const b of blocks) if (!b.q) b.q = left.shift() || null;
    for (const b of blocks) {
        if (b.q === SOLO && !res.solo.length) res.solo = b.entries;
        else if (b.q === FLEX && !res.flex.length) res.flex = b.entries;
    }
    res.ok = true;
    return res;
}


// ---------- per-player meta on the same page: op.gg's own player id, current season, role share ----------
// The page also carries the id of the op.gg "season" the player view is on ("season":{"display_value":"S2026","season_id":33}),
// op.gg's own puuid for the account (needed by the champion-stats call) and the season's role share (tooltips of the play-style card).
const OPGG_ROLE = { top: 'TOP', jungle: 'JUNGLE', mid: 'MIDDLE', middle: 'MIDDLE', adc: 'BOTTOM', bot: 'BOTTOM', bottom: 'BOTTOM', support: 'UTILITY', utility: 'UTILITY' };
function parseRoles(text) {
    const t = String(text).replace(/\\"/g, '"').replace(/\\n/g, ' ');
    const re = /text-\[#ffc659\]">([^<]{2,16})<\/div>[\s\S]{0,500}?Pick share<\/span>\s*<strong[^>]*>(\d{1,3})%<\/strong>[\s\S]{0,300}?Games<\/span>\s*<strong[^>]*>(\d{1,4})G<\/strong>/g;
    const roles = {}; let m;
    while ((m = re.exec(t))) {
        const k = OPGG_ROLE[m[1].trim().toLowerCase()];
        if (k && !roles[k]) roles[k] = { pct: Number(m[2]), g: Number(m[3]) };
    }
    return Object.keys(roles).length ? roles : null;
}
function parseMeta(text) {
    const meta = {};
    const counts = new Map();
    const re = /"puuid":"([A-Za-z0-9_-]{40,110})"/g; let m;
    while ((m = re.exec(text))) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    let best = 0; for (const [k, n] of counts) if (n > best) { best = n; meta.opuid = k; }
    const se = text.match(/"season":\{"display_value":"(S[0-9]{4}[^"]{0,12})","season_id":(\d{1,3})\}/);
    if (se) meta.season = { label: se[1], id: Number(se[2]) };
    const roles = parseRoles(text);
    if (roles) meta.roles = roles;
    return meta;
}
// Script URLs of the page (for finding the server-action id again when op.gg redeploys)
function chunkUrls(html, text) {
    const src = [...String(html).matchAll(/<script[^>]+src="([^"]+\/static\/chunks\/[^"]+\.js)"/g)].map(x => x[1]);
    if (!src.length) return [];
    const base = src[0].slice(0, src[0].indexOf('static/chunks/'));
    const rel = [...String(text).matchAll(/static\/chunks\/[A-Za-z0-9%_\-\/.\[\]]+?\.js/g)].map(x => x[0]);
    const out = [];
    for (const u of [...rel.map(r => base + r), ...src]) if (!out.includes(u) && !/polyfills|webpack-|framework/.test(u)) out.push(u);
    return out.slice(0, 60);
}

// ---------- op.gg "most-played champions" (a Next.js server action called with the page's own player id) ----------
// POST <player page> with header Next-Action: <id> and body [{locale,region,season_id,puuid,game_type}] answers an RSC line
//   1:[{"is_all_champions":true,"play":12,"win":7,"lose":5,"win_rate":58,"kda":{"kda":2.92,"avg_kill":7,"avg_death":5.4,"avg_assist":8.8},"cs":204,"cs_per_min":7},
//      {"is_all_champions":false,"name":"Nilah","key":"nilah","play":3,"win":2,"lose":1,...}, ...]   (this season, one queue filter)
const ACTION_NAME = 'getSummaryRankedMostChampions';
const DEFAULT_ACTION_ID = '4028494596c44675d8e9f617b8f659312f3b678072';
const GAME_TYPES = ['RANKED', 'SOLORANKED', 'FLEXRANKED', 'RANKED5S'];
const f1 = v => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
function parseChampionsAction(body) {
    if (typeof body !== 'string') return { ok: false };
    for (const line of body.split('\n')) {
        const m = line.match(/^[0-9a-f]+:(\[.*\])\s*$/);
        if (!m) continue;
        let arr; try { arr = JSON.parse(m[1]); } catch (e) { continue; }
        if (!Array.isArray(arr) || !arr.every(x => x && typeof x === 'object')) continue;
        if (arr.length && !arr.some(x => 'play' in x && 'win' in x)) continue;
        const rows = arr.filter(x => 'play' in x).map(x => ({
            all: !!x.is_all_champions, key: String(x.key == null || x.key === '$undefined' ? '' : x.key).toLowerCase().slice(0, 40), name: String(x.name == null ? '' : x.name).slice(0, 40),
            g: f1(x.play) | 0, w: f1(x.win) | 0, l: f1(x.lose) | 0,
            k: f1(x.kda && x.kda.avg_kill), d: f1(x.kda && x.kda.avg_death), a: f1(x.kda && x.kda.avg_assist), kda: f1(x.kda && x.kda.kda), cs: f1(x.cs_per_min)
        }));
        const all = rows.find(r => r.all) || null;
        const list = rows.filter(r => !r.all && r.key).slice(0, 60).map(({ all: _a, ...r }) => r);
        return { ok: true, all: all ? (({ all: _a, key, name, ...r }) => r)(all) : null, list };
    }
    return { ok: false };
}
const normChamp = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function findActionId(code) {
    const m = String(code).match(/createServerReference\)?\("([0-9a-f]{20,})"[^)]{0,120}"getSummaryRankedMostChampions"\)/);
    return m ? m[1] : null;
}
// best rating across a past-season list -> { tier, rank, lp, season, kind:'end'|'peak' }
function bestOf(list) {
    let best = null;
    for (const e of list || []) for (const [kind, c] of [['end', e.end], ['peak', e.peak]]) if (c && rating(c) > rating(best)) best = { tier: c.tier, rank: c.rank, lp: c.lp, season: e.season, kind };
    return best;
}

// ---------- season labels ----------
function seasonYear(label) {
    const s = String(label || '');
    let m = s.match(/S(\d{4})/);
    if (m) return Number(m[1]);
    m = s.match(/^S(\d{1,2})\b/);              // legacy "S13" = 2023
    return m ? 2010 + Number(m[1]) : 0;
}
function seasonSort(label) {                  // bigger = newer
    const s = String(label || '');
    const y = seasonYear(s);
    const m = s.match(/S\d{4}\s*S(\d)/) || s.match(/\bS\d{1,2}\s*S(\d)\b/);
    const split = m ? Number(m[1]) : 5;       // a plain year label sits between splits (never mixed in practice)
    return y * 10 + split;
}
const currentSeasonLabel = (now = Date.now()) => 'S' + new Date(now - 7 * 86400e3).getUTCFullYear(); // seasons start in early January

// ---------- ratings / peak ----------
function rating(x) {
    if (!x || !x.tier) return -1;
    const t = TIER_ORDER.indexOf(x.tier);
    if (t < 0) return -1;
    return t * 1e6 + (APEX.includes(x.tier) ? 0 : (ROMAN_VAL[x.rank] || 0) * 1e4) + (x.lp || 0);
}

// ---------- local snapshots ----------
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
// doc.snaps: [{q, s, t, r, lp, w, l, d}] (q = queueType, s = season label, d = UTC date). One per queue per day (the latest),
// and nothing is stored when the queue looks exactly like the previous snapshot. Returns true when something changed.
function recordSnapshots(doc, entries, now = Date.now()) {
    if (!doc || !Array.isArray(entries)) return false;
    const snaps = doc.snaps || (doc.snaps = []);
    const d = dayOf(now), s = currentSeasonLabel(now);
    let changed = false;
    for (const e of entries) {
        if (!e || (e.queueType !== SOLO && e.queueType !== FLEX) || !TIER_ORDER.includes(e.tier)) continue;
        const snap = { q: e.queueType, s, t: e.tier, r: APEX.includes(e.tier) ? 'I' : (e.rank || null), lp: e.leaguePoints | 0, w: e.wins | 0, l: e.losses | 0, d };
        let lastIdx = -1;
        for (let i = snaps.length - 1; i >= 0; i--) if (snaps[i].q === snap.q) { lastIdx = i; break; }
        const last = lastIdx >= 0 ? snaps[lastIdx] : null;
        if (last && last.t === snap.t && last.r === snap.r && last.lp === snap.lp && last.w === snap.w && last.l === snap.l) continue;
        if (last && last.d === d) snaps[lastIdx] = snap; else snaps.push(snap);
        changed = true;
    }
    if (snaps.length > MAX_SNAPS) snaps.splice(0, snaps.length - MAX_SNAPS);
    return changed;
}

// ---------- LCU previous-season fields ----------
const lcuTier = t => { const u = String(t || '').toUpperCase(); return TIER_ORDER.includes(u) ? u : null; };
const lcuDiv = (t, d) => APEX.includes(t) ? 'I' : (['I', 'II', 'III', 'IV'].includes(String(d || '').toUpperCase()) ? String(d).toUpperCase() : null);
function lcuPair(q, ...names) {
    for (const n of names) {
        const t = lcuTier(q[n + 'Tier']);
        if (t) return { tier: t, rank: lcuDiv(t, q[n + 'Division']), lp: null };
    }
    return null;
}
// ranked-stats -> { RANKED_SOLO_5x5: {end, peak}, RANKED_FLEX_SR: {...} } or null when the client sent nothing useful.
function lcuPrevSeasons(stats) {
    if (!stats || !Array.isArray(stats.queues)) return null;
    const out = {}; let any = false;
    for (const q of stats.queues) {
        if (!q || (q.queueType !== SOLO && q.queueType !== FLEX)) continue;
        const end = lcuPair(q, 'previousSeasonEnd');
        const peak = lcuPair(q, 'highestPreviousSeasonEnd', 'previousSeasonHighest', 'previousSeasonAchieved')
            || (q.queueType === SOLO && stats ? lcuPair(stats, 'highestPreviousSeasonEnd') : null);
        if (end || peak) { out[q.queueType] = { end, peak }; any = true; }
    }
    return any ? out : null;
}

// ---------- merge ----------
// in: { opgg:{solo,flex}|null, lcuPrev, snaps, now } -> { seasons:[{season,queue,tier,rank,lp,source,peak}], peak:{queue:{tier,rank,lp,season}}, recorded:[...] }
function mergeSeasons({ opgg, lcuPrev, snaps, now = Date.now() }) {
    const seasons = [];
    const cur = currentSeasonLabel(now);
    const have = { [SOLO]: new Set(), [FLEX]: new Set() };      // years covered by op.gg per queue
    for (const [q, list] of [[SOLO, opgg && opgg.solo], [FLEX, opgg && opgg.flex]]) {
        for (const e of list || []) {
            const main = e.end || e.peak;
            seasons.push({ season: e.season, queue: q, tier: main.tier, rank: main.rank, lp: main.lp, source: 'opgg', peak: e.peak && e.end && rating(e.peak) > rating(e.end) ? e.peak : null });
            have[q].add(seasonYear(e.season));
        }
    }
    // recorded snapshots: the latest of each earlier season that op.gg does not list
    const bySeason = new Map();
    for (const s of snaps || []) {
        if (s.s === cur) continue;
        const k = s.q + '|' + s.s;
        const prev = bySeason.get(k);
        if (!prev || s.d > prev.d) bySeason.set(k, s);
    }
    for (const s of bySeason.values()) {
        if (have[s.q].has(seasonYear(s.s))) continue;
        seasons.push({ season: s.s, queue: s.q, tier: s.t, rank: s.r, lp: s.lp, source: 'recorded', peak: null });
        have[s.q].add(seasonYear(s.s));
    }
    // client: only when op.gg gave nothing for that queue ("Last season" has no label)
    for (const q of [SOLO, FLEX]) {
        const lp = lcuPrev && lcuPrev[q];
        if (!lp) continue;
        if (!seasons.some(x => x.queue === q && x.source === 'opgg') && lp.end) {
            seasons.push({ season: 'Last season', queue: q, tier: lp.end.tier, rank: lp.end.rank, lp: null, source: 'client', peak: null });
        }
    }
    seasons.sort((a, b) => (a.season === 'Last season' ? 1 : 0) - (b.season === 'Last season' ? 1 : 0) || seasonSort(b.season) - seasonSort(a.season) || (a.queue < b.queue ? 1 : -1));
    const peak = {};
    for (const q of [SOLO, FLEX]) {
        let best = null;
        for (const x of seasons) {
            if (x.queue !== q) continue;
            for (const c of [x, x.peak]) if (c && rating(c) > rating(best)) best = { tier: c.tier, rank: c.rank, lp: c.lp, season: x.season };
        }
        const lp = lcuPrev && lcuPrev[q];
        if (lp && lp.peak && rating(lp.peak) > rating(best)) best = { tier: lp.peak.tier, rank: lp.peak.rank, lp: null, season: 'Previous seasons' };
        if (best) peak[q] = best;
    }
    const recorded = (snaps || []).filter(s => s.s === cur).sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0)).slice(0, 40)
        .map(s => ({ queue: s.q, date: s.d, tier: s.t, rank: s.r, lp: s.lp, wins: s.w, losses: s.l }));
    return { seasons, peak, recorded };
}

// ---------- polite op.gg fetch ----------
const safeKey = s => String(s).toLowerCase();
function opggUrl(platform, gameName, tagLine, origin = 'https://op.gg') {
    const region = OPGG_REGION[String(platform).toUpperCase()];
    if (!region) return null;
    return `${origin}/lol/summoners/${region}/${encodeURIComponent(gameName)}-${encodeURIComponent(tagLine)}`;
}

function defaultFetchHtml(url, init) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https:') ? https : http;
        const post = init && init.method === 'POST';
        const req = lib.request(url, {
            method: post ? 'POST' : 'GET',
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate',
                ...((init && init.headers) || {}),
                ...(post && init.body ? { 'Content-Length': Buffer.byteLength(init.body) } : {})
            }
        }, res => {
            const enc = String(res.headers['content-encoding'] || '').toLowerCase();
            let stream = res;
            if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
            else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
            const ch = []; let n = 0;
            stream.on('data', c => { n += c.length; if (n > 8 * 1024 * 1024) req.destroy(new Error('too large')); else ch.push(c); });
            stream.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }));
            stream.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        if (post && init.body) req.write(init.body);
        req.end();
        const hard = setTimeout(() => req.destroy(new Error('timeout')), 30000);
        req.on('close', () => clearTimeout(hard));
    });
}

// opts: { cache (profile-cache: getMeta/setMeta), fetchHtml(url, init?)->{status,body} (tests), origin (tests), minGapMs, chunkGapMs, now() }
function createOpgg(opts) {
    const cache = opts.cache;
    const fetchHtml = opts.fetchHtml || defaultFetchHtml;
    const origin = opts.origin || 'https://op.gg';
    const minGap = opts.minGapMs == null ? 1500 : opts.minGapMs;
    const chunkGap = opts.chunkGapMs == null ? 250 : opts.chunkGapMs;
    const now = opts.now || Date.now;
    const inflight = new Map(), inflightC = new Map();
    let chain = Promise.resolve(), lastAt = 0, lastChunks = [], discovering = null, lastDiscovery = null;
    const stats = { pages: 0, actions: 0, chunks: 0 };
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // Serialise every op.gg request app-wide with a minimum gap between them.
    const slot = fn => {
        const run = chain.then(async () => {
            const wait = lastAt + minGap - now();
            if (wait > 0) await sleep(wait);
            try { return await fn(); } finally { lastAt = now(); }
        });
        chain = run.catch(() => {});
        return run;
    };
    // op.gg refusing us (403/429) is not about one player: stop asking for everybody for an hour
    const blocked = () => { const b = cache.getMeta('opgg-block'); return b && now() - b.at < TTL.fail ? b : null; };
    const noteBlock = e => { if (e && (e.status === 403 || e.status === 429)) cache.setMeta('opgg-block', { error: e.message }); };
    const okUrl = u => typeof u === 'string' && (u.startsWith(origin + '/') || /^https:\/\/[a-z0-9.-]+\.op\.gg\/[^\s"'<>]+\.js$/.test(u));

    // -> { ok, cached, data:{solo,flex,opuid,season,roles}|null, error?, retryAt? }
    // needMeta: the cached page must carry op.gg's player id (older cache entries do not; they are fetched again once)
    function get(platform, gameName, tagLine, { force = false, needMeta = false } = {}) {
        const url = opggUrl(platform, gameName, tagLine, origin);
        if (!url) return Promise.resolve({ ok: false, cached: false, data: null, error: 'Region not supported by op.gg.' });
        const key = `${String(platform).toUpperCase()}:${safeKey(gameName)}#${safeKey(tagLine)}`;
        const hit = cache.getMeta('opgg:' + key);
        const t = now();
        const metaOk = !needMeta || !!(hit && hit.data && (hit.data.opuid || hit.data.reason === 'not-found'));
        if (hit && hit.data && metaOk && !(force && t - hit.at > 10 * 60e3)) {
            const ttl = hit.data.empty ? TTL.empty : TTL.ok;
            if (t - hit.at < ttl) return Promise.resolve({ ok: true, cached: true, data: hit.data, fetchedAt: hit.at });
        }
        const fail = cache.getMeta('opgg-fail:' + key), blk = blocked();
        if (blk) return Promise.resolve({ ok: false, cached: !!(hit && hit.data), data: hit && hit.data || null, error: blk.data && blk.data.error || 'op.gg unavailable', retryAt: blk.at + TTL.fail, backoff: true });
        if (fail && t - fail.at < TTL.fail) {
            return Promise.resolve({ ok: false, cached: !!(hit && hit.data), data: hit && hit.data || null, error: fail.data && fail.data.error || 'op.gg unavailable', retryAt: fail.at + TTL.fail, backoff: true });
        }
        if (inflight.has(key)) return inflight.get(key);
        const p = slot(async () => {
            try {
                stats.pages++;
                const r = await fetchHtml(url);
                if (r.status === 404) {
                    const data = { empty: true, solo: [], flex: [], reason: 'not-found' };
                    cache.setMeta('opgg:' + key, data);
                    return { ok: true, cached: false, data, fetchedAt: now() };
                }
                if (r.status !== 200) throw Object.assign(new Error(r.status === 403 || r.status === 429 ? `op.gg refused the request (HTTP ${r.status})` : `op.gg HTTP ${r.status}`), { status: r.status });
                const parsed = parseOpgg(r.body);
                if (parsed.chunkUrls && parsed.chunkUrls.length) lastChunks = parsed.chunkUrls;
                const meta = parsed.meta || {};
                if (!parsed.ok) {
                    if (parsed.hasRsc && /past_seasons|Past seasons/.test(r.body)) {
                        // a normal page that simply lists no past seasons (new account)
                        const data = { empty: true, solo: [], flex: [], ...meta };
                        cache.setMeta('opgg:' + key, data);
                        return { ok: true, cached: false, data, fetchedAt: now() };
                    }
                    throw new Error('Could not read the op.gg page (layout changed?)');
                }
                const data = { solo: parsed.solo, flex: parsed.flex, empty: !parsed.solo.length && !parsed.flex.length, ...meta };
                cache.setMeta('opgg:' + key, data);
                return { ok: true, cached: false, data, fetchedAt: now() };
            } catch (e) {
                cache.setMeta('opgg-fail:' + key, { error: e.message }); noteBlock(e);
                return { ok: false, cached: !!(hit && hit.data), data: hit && hit.data || null, error: e.message, retryAt: now() + TTL.fail };
            }
        }).finally(() => inflight.delete(key));
        inflight.set(key, p);
        return p;
    }

    // ---- server-action id: stored, found again in op.gg's script files when a call stops working ----
    const actionId = () => { const h = cache.getMeta('opgg-action'); return h && h.data && h.data.id && now() - h.at < TTL.action ? h.data.id : DEFAULT_ACTION_ID; };
    // Scans the page's script files (static assets, short gap) for createServerReference("<id>", ..., "getSummaryRankedMostChampions").
    // Called inside a request slot so it stays serialised with everything else. Returns the id or null.
    function discoverActionId(pageUrl) {
        if (discovering) return discovering;
        if (lastDiscovery && now() - lastDiscovery.at < 30 * 60e3) return Promise.resolve(lastDiscovery.id);   // do not rescan for every player
        discovering = (async () => {
            let urls = lastChunks.slice();
            if (!urls.length) {
                stats.pages++;
                const r = await fetchHtml(pageUrl);
                const parsed = r.status === 200 ? parseOpgg(r.body) : null;
                urls = parsed && parsed.chunkUrls || [];
            }
            for (const u of urls.filter(okUrl).slice(0, 45)) {
                await sleep(chunkGap);
                try {
                    stats.chunks++;
                    const r = await fetchHtml(u);
                    if (r.status !== 200) continue;
                    const id = findActionId(r.body);
                    if (id) { cache.setMeta('opgg-action', { id }); return id; }
                } catch (e) { /* next file */ }
            }
            return null;
        })().then(id => { lastDiscovery = { at: now(), id }; return id; }).finally(() => { discovering = null; });
        return discovering;
    }
    async function callAction(pageUrl, id, body) {
        stats.actions++;
        const r = await fetchHtml(pageUrl, {
            method: 'POST', body,
            headers: { 'Next-Action': id, 'Content-Type': 'text/plain;charset=UTF-8', 'Accept': 'text/x-component', 'Origin': origin }
        });
        if (r.status === 429 || r.status === 403) throw Object.assign(new Error(`op.gg refused the request (HTTP ${r.status})`), { status: r.status });
        const parsed = r.status === 200 ? parseChampionsAction(r.body) : { ok: false };
        if (!parsed.ok) throw Object.assign(new Error(r.status === 200 ? 'op.gg champion list not understood' : `op.gg HTTP ${r.status}`), { stale: r.status === 404 || r.status === 400 || r.status === 200, status: r.status });
        return parsed;
    }

    // Champion stats of one player this season: -> { ok, cached, data:{season,gameType,all,list[],peak,roles}|null, error?, retryAt?, backoff? }
    // The page (get) supplies op.gg's player id, so a player costs one page request (7 days) plus one champion request (6 h).
    function champions(platform, gameName, tagLine, { gameType = 'SOLORANKED', force = false } = {}) {
        if (!GAME_TYPES.includes(gameType)) gameType = 'SOLORANKED';
        const url = opggUrl(platform, gameName, tagLine, origin);
        if (!url) return Promise.resolve({ ok: false, cached: false, data: null, error: 'Region not supported by op.gg.' });
        const key = `${String(platform).toUpperCase()}:${safeKey(gameName)}#${safeKey(tagLine)}`;
        const ck = `opchamps:${key}:${gameType}`;
        const hit = cache.getMeta(ck), t = now();
        const fresh = hit && hit.data && t - hit.at < TTL.champs && !(force && t - hit.at > 10 * 60e3);
        if (fresh) return Promise.resolve({ ok: true, cached: true, data: hit.data, fetchedAt: hit.at });
        const stale = hit && hit.data || null;
        const fail = cache.getMeta('opgg-fail:c:' + key + ':' + gameType), gfail = cache.getMeta('opgg-actfail') || blocked();
        if (fail && t - fail.at < TTL.fail) return Promise.resolve({ ok: false, cached: !!stale, data: stale, error: fail.data && fail.data.error || 'op.gg unavailable', retryAt: fail.at + TTL.fail, backoff: true });
        if (gfail && t - gfail.at < TTL.fail) return Promise.resolve({ ok: false, cached: !!stale, data: stale, error: gfail.data && gfail.data.error || 'op.gg unavailable', retryAt: gfail.at + TTL.fail, backoff: true });
        if (inflightC.has(ck)) return inflightC.get(ck);
        const p = (async () => {
            const pg = await get(platform, gameName, tagLine, { needMeta: true });
            if (!pg.ok || !pg.data) return { ok: false, cached: !!stale, data: stale, error: pg.error || 'op.gg unavailable', retryAt: pg.retryAt, backoff: pg.backoff };
            const pd = pg.data;
            const base = { peak: bestOf(pd.solo), roles: pd.roles || null, season: pd.season || null };
            if (!pd.opuid) {
                const data = { ...base, gameType, empty: true, all: null, list: [], reason: pd.reason || 'no-id' };
                cache.setMeta(ck, data);
                return { ok: true, cached: false, data, fetchedAt: now() };
            }
            const region = OPGG_REGION[String(platform).toUpperCase()];
            const body = JSON.stringify([{ locale: 'en', region, season_id: pd.season ? pd.season.id : 0, puuid: pd.opuid, game_type: gameType }]);
            return slot(async () => {
                try {
                    let parsed;
                    try { parsed = await callAction(url, actionId(), body); }
                    catch (e) {
                        if (!e.stale) throw e;
                        const before = actionId();
                        const id = await discoverActionId(url);       // op.gg redeployed: find the new id once
                        if (!id) { cache.setMeta('opgg-actfail', { error: 'op.gg changed (champion stats unavailable)' }); throw new Error('op.gg changed (champion stats unavailable)'); }
                        if (id === before) throw e;
                        parsed = await callAction(url, id, body);
                    }
                    const data = { ...base, gameType, empty: !parsed.list.length, all: parsed.all, list: parsed.list };
                    cache.setMeta(ck, data);
                    return { ok: true, cached: false, data, fetchedAt: now() };
                } catch (e) {
                    cache.setMeta('opgg-fail:c:' + key + ':' + gameType, { error: e.message }); noteBlock(e);
                    return { ok: false, cached: !!stale, data: stale, error: e.message, retryAt: now() + TTL.fail };
                }
            });
        })().finally(() => inflightC.delete(ck));
        inflightC.set(ck, p);
        return p;
    }
    // cached champion stats without any request (null when missing or older than 6 h)
    function peek(platform, gameName, tagLine, gameType = 'SOLORANKED') {
        if (!opggUrl(platform, gameName, tagLine, origin) || !GAME_TYPES.includes(gameType)) return null;
        const hit = cache.getMeta(`opchamps:${String(platform).toUpperCase()}:${safeKey(gameName)}#${safeKey(tagLine)}:${gameType}`);
        return hit && hit.data && now() - hit.at < TTL.champs ? { data: hit.data, fetchedAt: hit.at } : null;
    }
    return { get, champions, peek, discoverActionId, stats, actionId };
}

module.exports = {
    SOLO, FLEX, TIER_ORDER, OPGG_REGION, TTL,
    extractRsc, sliceJson, parseOpgg, parseMeta, parseRoles, parseChampionsAction, findActionId, bestOf, normChamp, chunkUrls, GAME_TYPES, DEFAULT_ACTION_ID, seasonYear, seasonSort, currentSeasonLabel, rating,
    recordSnapshots, lcuPrevSeasons, mergeSeasons, opggUrl, createOpgg
};
