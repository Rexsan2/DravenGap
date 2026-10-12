// desktop-app/lolalytics-scraper.js
// Local scraper for periods the public DraftDiff bucket doesn't provide: finished past patches
// (e.g. 16.10 - 16.18) and the 7 / 14 day windows. Node port of scripts/scrape_lolalytics.py:
// same LoLalytics requests, same parsing and the same champion_stats / matchup_winrates format,
// so the renderer stores the results in its patch archive like any other dataset.
//
// Load on LoLalytics: one dataset (period x rank) is ~1,700 requests. Requests run with low
// concurrency plus a delay, and the team-synergy request is skipped for champion/role combos
// with almost no games (their matchups would fall below any Min Games filter anyway).

const https = require('https');
const zlib = require('zlib');
const { promisify } = require('util');
const gzip = promisify(zlib.gzip);

const BUILD_PAGE_URL = 'https://lolalytics.com/lol/{champion}/build/';
const TEAM_API_URL = 'https://a1.lolalytics.com/mega/';
const DDRAGON = 'https://ddragon.leagueoflegends.com';
const ROLES = ['top', 'jungle', 'middle', 'bottom', 'support'];
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
};
const CONCURRENCY = 4;
const REQUEST_DELAY_MS = 150;
const MIN_GAMES_FOR_TEAM_DATA = 100;

function getText(url, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) { reject(new Error('cancelled')); return; }
        // The abort listener must be removed when the request settles: the signal lives for the whole
        // download, and a leftover listener keeps its request, response and page text (~0.6 MB) alive.
        const onAbort = () => req.destroy(new Error('cancelled'));
        const done = () => { if (signal) signal.removeEventListener('abort', onAbort); };
        const req = https.get(url, { headers: HEADERS, timeout: 30000 }, res => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', c => { data += c; });
            res.on('end', () => { done(); resolve({ status: res.statusCode, text: data }); });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', e => { done(); reject(e); });
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Retries transient failures (timeouts, 429, 5xx) with backoff; returns null on a final failure.
async function fetchText(url, signal) {
    for (let attempt = 0; attempt < 3; attempt++) {
        if (signal && signal.aborted) throw new Error('cancelled');
        try {
            await sleep(REQUEST_DELAY_MS);
            const r = await getText(url, signal);
            if (r.status === 200) return r.text;
            if (r.status !== 429 && r.status < 500) return null;
        } catch (e) {
            if (e.message === 'cancelled') throw e;
        }
        await sleep(2000 * (attempt + 1));
    }
    return null;
}

// LoLalytics embeds the page data as Qwik's serialised object graph: objects reference each
// other by base-36 indices into `objs`. Same algorithm as parse_qwik_json in the Python scraper.
function parseQwikJson(html) {
    const m = /<script\s+type="qwik\/json"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    if (!m) return null;
    let json;
    try { json = JSON.parse(m[1]); } catch (e) { return null; }
    const objs = json.objs || [];
    if (!objs.length) return null;

    const getObj = id => {
        if (typeof id === 'string') {
            const index = parseInt(id, 36);
            if (/^[0-9a-z]+$/.test(id) && index >= 0 && index < objs.length) return objs[index];
        }
        return id;
    };
    const reconstruct = (id, depth = 0) => {
        if (depth > 50) return null; // guards against reference cycles
        const obj = getObj(id);
        if (Array.isArray(obj)) return obj.map(v => reconstruct(v, depth + 1));
        if (obj && typeof obj === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(obj)) out[k] = reconstruct(v, depth + 1);
            return out;
        }
        return obj;
    };
    const mainIndex = objs.findIndex(o => o && typeof o === 'object' && !Array.isArray(o) && 'analysed' in o && 'enemy' in o);
    return mainIndex < 0 ? null : reconstruct(mainIndex.toString(36));
}

async function getChampionList() {
    const versions = JSON.parse((await getText(`${DDRAGON}/api/versions.json`)).text);
    const champs = JSON.parse((await getText(`${DDRAGON}/cdn/${versions[0]}/data/en_US/champion.json`)).text).data;
    const idToName = {};
    for (const c of Object.values(champs)) idToName[c.key] = c.id;
    return { names: Object.values(champs).map(c => c.id), idToName };
}

function urlName(champion) {
    const n = champion.toLowerCase().replace(/'/g, '').replace(/ /g, '');
    return n === 'monkeyking' ? 'wukong' : n;
}

async function fetchChampionRole(champion, role, period, rank, signal) {
    const name = urlName(champion);
    const buildQs = new URLSearchParams({ tier: rank, patch: period, lane: role, region: 'all' });
    const html = await fetchText(`${BUILD_PAGE_URL.replace('{champion}', name)}?${buildQs}`, signal);
    const enemyData = html ? parseQwikJson(html) : null;
    if (!enemyData) return null;

    let teamData = null;
    const header = enemyData.header || {};
    if ((header.n || 0) >= MIN_GAMES_FOR_TEAM_DATA) {
        const teamQs = new URLSearchParams({ ep: 'build-team', v: '1', patch: period, c: name, lane: role, tier: rank, queue: 'ranked', region: 'all' });
        const text = await fetchText(`${TEAM_API_URL}?${teamQs}`, signal);
        try { teamData = text ? JSON.parse(text) : null; } catch (e) { teamData = null; }
    }
    // Keep only what buildDataset uses; the full page data (builds, runes, graphs...) is ~3x larger
    return {
        champion, role: role.toUpperCase(),
        enemyData: { header: { n: header.n, wr: header.wr, pr: header.pr }, enemy: enemyData.enemy },
        teamData: teamData && teamData.team ? { team: teamData.team } : null
    };
}

// Same aggregation as process_and_upload_dataset in the Python scraper (including the `games` field).
function buildDataset(results, idToName) {
    const rolesByChampion = new Map();
    const matchups = {};
    let headerGames = 0;

    const addMatchups = (p1, p1Role, byRole, relationship) => {
        for (const [p2RoleStr, rows] of Object.entries(byRole || {})) {
            if (!Array.isArray(rows)) continue;
            for (const row of rows) {
                if (!Array.isArray(row) || row.length < 6) continue;
                const [p2Key, wr, , d2, , n] = row;
                const p2 = idToName[String(p2Key)];
                if (!p2) continue;
                matchups[JSON.stringify([p1, p1Role, p2, p2RoleStr.toUpperCase(), relationship])] = {
                    win_rate: wr / 100,
                    delta2: typeof d2 === 'number' ? d2 / 100 : 0,
                    total_games: n
                };
            }
        }
    };

    for (const r of results) {
        if (!r || !r.enemyData || typeof r.enemyData !== 'object') continue;
        const header = r.enemyData.header || {};
        headerGames += header.n || 0;
        if (!rolesByChampion.has(r.champion)) rolesByChampion.set(r.champion, []);
        rolesByChampion.get(r.champion).push({ role: r.role, win_rate: (header.wr || 0) / 100, pick_rate: (header.pr || 0) / 100, games: header.n || 0 });
        addMatchups(r.champion, r.role, r.enemyData.enemy, 'enemy');
        if (r.teamData && r.teamData.team) addMatchups(r.champion, r.role, r.teamData.team, 'teammate');
    }

    const statsList = [];
    for (const [champion, roles] of rolesByChampion) {
        const totalPick = roles.reduce((s, x) => s + x.pick_rate, 0);
        for (const x of roles) {
            statsList.push({
                champion, role: x.role, win_rate: x.win_rate, pick_rate: x.pick_rate,
                role_frequency: totalPick > 0 ? x.pick_rate / totalPick : 0, games: x.games
            });
        }
    }
    // Each game has 10 players, each counted once in some champion/role header
    return { statsList, matchups, totalGames: Math.floor(headerGames / 10) };
}

// Scrapes one dataset. period: a patch label ('16.15') or a day window ('7', '14').
// onProgress({ done, total }) is called as requests complete. Throws 'cancelled' if the signal aborts.
async function scrapeDataset({ period, rank, signal, onProgress = () => {}, championList, concurrency = CONCURRENCY }) {
    const { names, idToName } = championList || await getChampionList();
    const combos = [];
    for (const champion of names) for (const role of ROLES) combos.push([champion, role]);

    const results = [];
    let next = 0, done = 0;
    const worker = async () => {
        while (next < combos.length) {
            const [champion, role] = combos[next++];
            results.push(await fetchChampionRole(champion, role, period, rank, signal));
            onProgress({ done: ++done, total: combos.length });
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, CONCURRENCY)) }, worker));

    const dataset = buildDataset(results, idToName);
    if (dataset.statsList.length === 0) throw new Error(`LoLalytics returned no data for ${period} / ${rank}`);
    // Compressed here so only ~10-15 MB crosses IPC instead of a ~150 MB object
    const [statsGz, matchupsGz] = await Promise.all([
        gzip(Buffer.from(JSON.stringify(dataset.statsList))),
        gzip(Buffer.from(JSON.stringify(dataset.matchups)))
    ]);
    return { statsGz, matchupsGz, totalGames: dataset.totalGames, combos: dataset.statsList.length, matchupCount: Object.keys(dataset.matchups).length };
}

module.exports = { parseQwikJson, buildDataset, scrapeDataset, getChampionList, urlName };
