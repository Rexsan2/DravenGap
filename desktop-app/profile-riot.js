// desktop-app/profile-riot.js
// Riot API client for the Profile view: shared app-wide limiter (riot-history.sharedLimiter) with priorities,
// X-App-Rate-Limit / Retry-After handling, in-flight de-duplication and typed errors.
const https = require('https');
const http = require('http');
const { sharedLimiter, PRIORITY, routingForPlatform, accountRoutingForPlatform } = require('./riot-history');

// Error codes the view understands.
class ProfileError extends Error {
    constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
    toJSON() { return { ok: false, code: this.code, error: this.message, retryAt: this.retryAt || null, status: this.status || null }; }
}

function errorToResult(e) {
    if (e instanceof ProfileError) return e.toJSON();
    return { ok: false, code: 'ERROR', error: (e && e.message) || 'Unexpected error', retryAt: null };
}

const PLATFORMS = ['EUW1', 'EUN1', 'NA1', 'KR', 'BR1', 'LA1', 'LA2', 'OC1', 'TR1', 'RU', 'JP1', 'PH2', 'SG2', 'TH2', 'TW2', 'VN2', 'ME1'];

// opts: { getKey, limiter, baseUrl(host) -> origin override (tests), maxAutoWaitSec }
function createRiotClient(opts) {
    const limiter = opts.limiter || sharedLimiter;
    const maxAutoWait = opts.maxAutoWaitSec == null ? 15 : opts.maxAutoWaitSec;
    const inflight = new Map();
    const stats = { requests: 0, rateLimited: 0 };

    function rawGet(url, key) {
        return new Promise((resolve, reject) => {
            const lib = url.startsWith('https:') ? https : http;
            const req = lib.get(url, { headers: { 'X-Riot-Token': key, 'Accept': 'application/json' }, timeout: 15000 }, res => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    let json = null;
                    try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* non-JSON body */ }
                    resolve({ status: res.statusCode, json, headers: res.headers });
                });
                res.on('error', reject);
            });
            req.on('timeout', () => req.destroy(new Error('timeout')));   // idle socket
            req.on('error', reject);
            const hard = setTimeout(() => req.destroy(new Error('timeout')), 30000);   // overall deadline (a slow trickle never idles)
            req.on('close', () => clearTimeout(hard));
        });
    }

    async function doRequest(url, priority, nullOn404) {
        const key = opts.getKey();
        if (!key) throw new ProfileError('NO_KEY', 'No Riot API key saved. Add one in Settings.');
        let netFails = 0, serverFails = 0, rateWaits = 0;
        for (;;) {
            await limiter.wait(priority);
            let r;
            stats.requests++;
            try { r = await rawGet(url, key); }
            catch (e) {
                if (++netFails < 2) { await sleep(400); continue; }
                throw new ProfileError('OFFLINE', 'Could not reach the Riot API. Check your internet connection.');
            }
            const h = r.headers || {};
            if (h['x-app-rate-limit']) limiter.configureFromHeader(h['x-app-rate-limit']);
            if (r.status === 200) return r.json;
            if (r.status === 404) {
                if (nullOn404) return null;
                throw new ProfileError('NOT_FOUND', 'Not found.', { status: 404 });
            }
            if (r.status === 401 || r.status === 403) {
                throw new ProfileError('KEY_REJECTED', 'Riot API key rejected. Personal keys can expire or be revoked; paste a fresh one in Settings.', { status: r.status });
            }
            if (r.status === 400 && /decrypt/i.test(JSON.stringify(r.json || ''))) {
                // puuid was encrypted by another API key / project: the caller re-resolves the account by Riot ID
                throw new ProfileError('STALE_PUUID', 'Stored player id belongs to a different API key.', { status: 400 });
            }
            if (r.status === 429) {
                stats.rateLimited++;
                const wait = Math.max(1, Number(h['retry-after']) || 1);
                limiter.pause(wait * 1000);
                if (wait <= maxAutoWait && rateWaits++ < 3) continue; // short waits are absorbed transparently
                throw new ProfileError('RATE_LIMITED', `Rate limited by the Riot API. Try again in ${wait}s.`, { status: 429, retryAt: Date.now() + wait * 1000 });
            }
            if (r.status >= 500) {
                if (++serverFails < 3) { await sleep(500 * serverFails); continue; }
                throw new ProfileError('HTTP', `Riot API error (HTTP ${r.status}). Try again shortly.`, { status: r.status });
            }
            throw new ProfileError('HTTP', (r.json && r.json.status && r.json.status.message) || `HTTP ${r.status}`, { status: r.status });
        }
    }

    // kind: 'platform' (platformId host, e.g. euw1), 'regional' (match-v5 host: europe, sea...) or 'account'
    // (account-v1 host: americas/asia/europe only). `platform` is the platform id (always).
    function urlFor(kind, platform, pathAndQuery) {
        const p = String(platform || '').toUpperCase();
        const host = kind === 'regional' ? routingForPlatform(p) : kind === 'account' ? accountRoutingForPlatform(p) : p.toLowerCase();
        if (!host) throw new ProfileError('BAD_REGION', `Unknown region '${platform}'.`);
        const origin = opts.baseUrl ? opts.baseUrl(host) : `https://${host}.api.riotgames.com`;
        return origin + pathAndQuery;
    }

    // request(kind, platform, pathAndQuery, { priority, nullOn404 })
    function request(kind, platform, pathAndQuery, o = {}) {
        const url = urlFor(kind, platform, pathAndQuery);
        const priority = o.priority == null ? PRIORITY.VISIBLE : o.priority;
        const k = (o.nullOn404 ? 'n:' : 'e:') + url;
        if (inflight.has(k)) return inflight.get(k);
        const p = doRequest(url, priority, !!o.nullOn404).finally(() => inflight.delete(k));
        inflight.set(k, p);
        return p;
    }
    return { request, limiter, stats };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { createRiotClient, ProfileError, errorToResult, PRIORITY, PLATFORMS };
