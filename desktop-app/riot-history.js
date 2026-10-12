// desktop-app/riot-history.js
// Backfills the personal history ('You' column) from the Riot API (match-v5) using the
// player's own API key. The League client only exposes its recently loaded games, while
// match-v5 goes back much further.
//
// Notes:
// - The client's puuid is NOT valid for the public API (each API key sees an encrypted
//   puuid), so the player is looked up by Riot ID via account-v1 first.
// - Development keys expire after 24 hours and are limited to 20 req/s and 100 req/2 min.
// - Match ids look like 'EUW1_8003081446'; info.gameId (8003081446) equals the client's
//   gameId, so records from both sources de-duplicate in the shared history store.

const https = require('https');
const { mapPositionString, SR_QUEUES } = require('./lcu-history');

const ROUTING = {
    americas: ['NA1', 'BR1', 'LA1', 'LA2'],
    europe: ['EUW1', 'EUN1', 'TR1', 'RU', 'ME1'],
    asia: ['KR', 'JP1'],
    sea: ['OC1', 'PH2', 'SG2', 'TH2', 'TW2', 'VN2']
};
const MIN_GAME_SECONDS = 300;      // same remake cut-off as the client history
const IDS_PAGE = 100;              // match-v5 max count per ids request
const MAX_IDS_PER_QUEUE = 1000;

const RIOT_KEY_PATTERN = /^RGAPI-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function routingForPlatform(platformId) {
    const p = String(platformId || '').toUpperCase();
    return Object.keys(ROUTING).find(r => ROUTING[r].includes(p)) || null;
}

// account-v1 is only served on americas / asia / europe; SEA platforms use 'asia' for it (match-v5 stays on 'sea').
function accountRoutingForPlatform(platformId) {
    const r = routingForPlatform(platformId);
    return r === 'sea' ? 'asia' : r;
}

// match-v5 match -> the same record shape lcu-history produces. null for games that
// shouldn't count (not our queues, remakes, player missing).
function matchToGame(match, puuid) {
    const info = match && match.info;
    if (!info || !SR_QUEUES.has(info.queueId)) return null;
    // Before patch 11.20 gameDuration was in milliseconds; gameEndTimestamp marks the newer format
    const seconds = info.gameEndTimestamp ? info.gameDuration : info.gameDuration / 1000;
    if (!(seconds >= MIN_GAME_SECONDS)) return null;
    const me = (info.participants || []).find(p => p.puuid === puuid);
    if (!me || me.gameEndedInEarlySurrender || typeof me.win !== 'boolean') return null;
    return {
        gameId: info.gameId,
        queueId: info.queueId,
        championId: me.championId,
        role: mapPositionString(me.teamPosition || me.individualPosition),
        win: me.win,
        creation: info.gameCreation || null,
        source: 'riot'
    };
}

// Sliding-window limiter for the dev-key limits (kept slightly under 20/1s and 100/120s).
// One shared instance (sharedLimiter) is used by the whole app so the history sync and the Profile view never
// exceed the key's budget together. Waiters are served by priority (lower number first, FIFO within a priority);
// wait() with no argument is the lowest priority, so existing callers behave as before.
const PRIORITY = { LIVE: 0, VISIBLE: 1, BACKGROUND: 2 };
class RateLimiter {
    constructor(windows = [[19, 1000], [95, 120000]]) {
        this.windows = windows;
        this.stamps = [];
        this.queue = [];
        this.seq = 0;
        this.pausedUntil = 0;
        this.timer = null;
    }
    wait(priority = PRIORITY.BACKGROUND) {
        return new Promise(resolve => {
            this.queue.push({ priority, seq: this.seq++, resolve });
            this._pump();
        });
    }
    // Stop handing out slots for `ms` (after a 429 / Retry-After).
    pause(ms) {
        this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
        this._pump();
    }
    // Adopt the limits the API reports ("20:1,100:120" = 20 per 1 s, 100 per 120 s), kept one under the cap.
    configureFromHeader(header) {
        const parsed = String(header || '').split(',').map(x => x.split(':').map(Number))
            .filter(([n, s]) => n > 0 && s > 0).map(([n, s]) => [Math.max(1, n - 1), s * 1000]);
        if (parsed.length) this.windows = parsed;
    }
    pendingCount() { return this.queue.length; }
    // Milliseconds until the limiter would hand out a slot right now (0 = free): rate-limit window full or paused after a 429.
    nextSlotIn() { return this._delay(Date.now()); }
    _delay(now) {
        let delay = Math.max(0, this.pausedUntil - now);
        for (const [limit, ms] of this.windows) {
            const inWindow = this.stamps.filter(t => now - t < ms);
            if (inWindow.length >= limit) delay = Math.max(delay, inWindow[0] + ms - now + 5);
        }
        return delay;
    }
    _pump() {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        for (;;) {
            if (!this.queue.length) return;
            const now = Date.now();
            const longest = Math.max(...this.windows.map(w => w[1]));
            this.stamps = this.stamps.filter(t => now - t < longest);
            const delay = this._delay(now);
            if (delay > 0) {
                this.timer = setTimeout(() => { this.timer = null; this._pump(); }, delay);
                return;
            }
            let best = 0;
            for (let i = 1; i < this.queue.length; i++) {
                const q = this.queue[i], b = this.queue[best];
                if (q.priority < b.priority || (q.priority === b.priority && q.seq < b.seq)) best = i;
            }
            const [next] = this.queue.splice(best, 1);
            this.stamps.push(now);
            next.resolve();
        }
    }
}
const sharedLimiter = new RateLimiter();

class RiotApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

function createClient(apiKey, limiter = sharedLimiter) {
    const getJson = url => new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'X-Riot-Token': apiKey }, timeout: 15000 }, res => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch (e) { /* non-JSON error body */ }
                resolve({ status: res.statusCode, json, retryAfter: Number(res.headers['retry-after']) || 0 });
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });

    return async function request(url) {
        for (let attempt = 0; attempt < 4; attempt++) {
            await limiter.wait();
            const r = await getJson(url);
            if (r.status === 200) return r.json;
            if (r.status === 429 || r.status >= 500) {
                const waitMs = (r.retryAfter || 2 ** attempt) * 1000;
                if (r.status === 429) limiter.pause(waitMs); // every other caller backs off too
                await new Promise(res => setTimeout(res, waitMs));
                continue;
            }
            if (r.status === 404) return null;
            throw new RiotApiError(r.status, (r.json && r.json.status && r.json.status.message) || `HTTP ${r.status}`);
        }
        throw new RiotApiError(429, 'Rate limited by the Riot API, try again in a few minutes');
    };
}

// Fetch every Summoner's Rift game not already in `knownIds` (gameIds already checked via
// the Riot API). Returns { games, checkedIds }: checkedIds includes skipped matches (remakes)
// so they aren't downloaded again next time. Reports progress via onProgress({ phase, done, total }).
async function fetchRiotGames({ apiKey, gameName, tagLine, platformId, knownIds, onProgress = () => {} }) {
    const route = routingForPlatform(platformId);
    if (!route) throw new RiotApiError(0, `Unknown platform '${platformId}'`);
    const base = `https://${route}.api.riotgames.com`;
    const accountBase = `https://${accountRoutingForPlatform(platformId)}.api.riotgames.com`;
    const request = createClient(apiKey);

    onProgress({ phase: 'account', done: 0, total: 0 });
    const account = await request(`${accountBase}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`);
    if (!account || !account.puuid) throw new RiotApiError(404, 'Riot ID not found');

    const ids = [];
    for (const queue of SR_QUEUES) {
        for (let start = 0; start < MAX_IDS_PER_QUEUE; start += IDS_PAGE) {
            onProgress({ phase: 'ids', done: ids.length, total: 0 });
            const page = await request(`${base}/lol/match/v5/matches/by-puuid/${account.puuid}/ids?queue=${queue}&start=${start}&count=${IDS_PAGE}`);
            if (!Array.isArray(page) || page.length === 0) break;
            ids.push(...page);
            if (page.length < IDS_PAGE) break;
        }
    }

    const missing = [...new Set(ids)].filter(id => !knownIds.has(Number(String(id).split('_').pop())));
    // Partial results are returned with `error` set, so an interrupted sync (expired key,
    // network drop) still keeps the matches fetched so far.
    const games = [];
    const checkedIds = [];
    let error = null;
    for (let i = 0; i < missing.length; i++) {
        onProgress({ phase: 'matches', done: i, total: missing.length });
        let match;
        try {
            match = await request(`${base}/lol/match/v5/matches/${missing[i]}`);
        } catch (e) {
            error = e;
            break;
        }
        checkedIds.push(Number(String(missing[i]).split('_').pop()));
        const game = matchToGame(match, account.puuid);
        if (game) games.push(game);
    }
    onProgress({ phase: 'done', done: checkedIds.length, total: missing.length });
    return { games, checkedIds, error };
}

module.exports = { RIOT_KEY_PATTERN, routingForPlatform, accountRoutingForPlatform, matchToGame, RateLimiter, sharedLimiter, PRIORITY, ROUTING, RiotApiError, fetchRiotGames };
