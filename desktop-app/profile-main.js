// desktop-app/profile-main.js
// Main-process side of the Profile view (op.gg-style summoner profiles + live game). Registers 'profile:*' IPC channels.
//
//   profile:test-key  ()                                  -> { ok, ... } | { ok:false, code, error }
//   profile:me        ()                                  -> { ok, me: {gameName,tagLine,platform,...}|null, lcu:boolean, phase }
//   profile:owner     ({fallback?:{gameName,tagLine,platform}}) -> { ok:true, owner:{gameName,tagLine,platform,puuid|null}, source:'client'|'last'|'settings' } | { ok:false }
//                     "which account is mine": the client's account when it has a platform, else the last client account seen
//                     (cache meta 'owner-last'), else settings.profileAccount (settings.json, else the renderer's `fallback`). No requests.
//   profile:static    ()                                  -> { ok, queues:{id:name}, groups, mayhemQueue, seasonStart }
//   profile:lookup    ({gameName,tagLine,platform,force}) -> { ok, profile, stale }   (cache first; push profile:update when refreshed)
//   profile:matches   ({puuid,platform,group,start,refresh,champId?}) -> { ok, matches[], nextStart, hasMore, stale }
//                     champId: only that champion's games (Riot's list has no champion filter: up to 4 pages are read per call)
//                     games recorded from the client (ARAM Mayhem, not in Riot's API; match.src 'lcu') are merged in by time
//                     group 'all' fetches every id from Riot but leaves Arena and the other non-5v5 modes out of the rows; group 'arena' lists them
//   profile:match     ({id,platform})                     -> { ok, match }
//   profile:timeline  ({id,platform,minVersion?})       -> { ok, timeline:{id,players:{pid:{items:[{m,items:[{i,s?}]}],skills:{seq,prio}}},gold:[{m,d}]}, cached }  (1 request, only when a match's Build/Analysis tab opens; compacted + cached forever)
//   profile:played    ({puuid,platform,group})           -> { ok, list:[{name,tag,puuid,games,w,l,wr}], scanned }  (teammates in >=2 cached games; no requests)
//   profile:ledger    ({puuid})                           -> { ok, rows[] (this season, compact), total }
//   profile:lp-history ()                                 -> { ok, list:[{at,q,win,before,after,delta,dodge?}], current }   (your LP per ranked game, read from the client)
//   profile:session   ()                                  -> { ok, lcu, games today [{q,champId,win,k,d,a,at,dur}], w, l, lp:{queueType:delta} }   (client match history; no Riot requests)
//   profile:duo       ()                                  -> { ok, lcu, inLobby, partners:[{gameName,tagLine,positions,assigned,championId}], me:{...,positions,assigned} }  (client lobby; no Riot requests)
//   profile:duo-history ({owner, partner:{gameName,tagLine}}) -> { ok, games, w, pairs:[{mine,theirs,games,w,myPos,theirPos}], lanes[], partnerChamps:{POS:{champId:n}} }  (cached games only)
//   profile:champ-summary ({champId, puuid | gameName,tagLine,platform}) -> { ok, puuid, games, w, k, d, a, cs, mins, kp, roles, queues,
//                     last[10], score, mvp, ace, items:{POS:{games, freq:{itemId:n}}}, itemGames, curve, vsOpp:{champId:{g,w}} }   (cached games only; items and lane opponents of the newest 60)
//   profile:insights  ({puuid,group,champId?})            -> { ok, ...profile-insights.js result, scanned }  (cached games only; no requests; group 'arena' -> { ok, n, arena:{avgPlace,top4,dist,champions,...}, scanned })
//   profile:backfill  ({puuid,platform,max}) / profile:backfill-cancel ({puuid})
//   profile:live      ({gameName,tagLine,platform,champs?} | {}) -> { ok, inGame, game } then pushes profile:progress {kind:'live'}:
//                     { patch:{idx,stage:'core'|'opgg'|'scout',...,tags}, teams:{100,200}, premades, done,total } per player as data arrives,
//                     { upgrade:{game} } when spectator-v5 knows a game that was first seen from the client only, { finished, budget }
//                     (champs: [[championId, name, ddragonId], ...] lets the main process match op.gg's champion names)
//   profile:scout     ({puuid,platform,championId,gameKey?,idx?}) -> { ok, form }  (last 5 games of one live player; ~6 requests)
//   profile:multi     ({gameName,tagLine,platform})     -> { ok, profile, form, tags }  (multi-search: one player of a pasted lobby; ~10 requests when not cached)
//   profile:refresh   ()                                  -> owner's new matches now
//   profile:seasons   ({gameName,tagLine,platform,puuid?,force?}) -> { ok, seasons[{season,queue,tier,rank,lp,source,peak}], peak, recorded[], opgg:{ok,cached,error?,retryAt?}, fetchedAt }
//   profile:emblems   ({tiers:[...], size:'mini'|'big'})  -> { ok, emblems:{TIER:dataUrl} }   (tier whitelist; disk cached)
//   profile:diag      ()                                  -> { ok, riot:{keySet,windows[{limit,ms,used}],pausedUntil,waiting,requests,rateLimited}, opgg:{blockedUntil,...}, lcu:{up,phase} }
//   profile:cache-clear ({what:'lookups'|'opgg-backoff'}) -> { ok, removed }   (Settings > Diagnostics; downloaded matches are kept)
// Pushes (sendToWindow): profile:update {kind:'profile'|'matches', ...}, profile:live {active, phase, ...}, profile:progress.
const fs = require('fs');
const path = require('path');
const https = require('https');
const riotHistory = require('./riot-history');
const lcuHistory = require('./lcu-history');
const { createRiotClient, ProfileError, errorToResult, PRIORITY, PLATFORMS } = require('./profile-riot');
const { createCache } = require('./profile-cache');
const { getSharedLcu, createPhasePoller, ACTIVE_PHASES } = require('./profile-lcu');
const { insights, arenaInsights, learningCurve } = require('./profile-insights');
const C = require('./profile-compact');
const TL = require('./profile-timeline');
const SE = require('./profile-seasons');
const LV = require('./profile-live');
const { createEmblems } = require('./profile-emblems');

const PAGE = 20;
const BACKFILL_STEP_MS = deps_stepMs();
function deps_stepMs() { return Number(process.env.DD_BACKFILL_STEP_MS) || 4 * 60e3; } // watchdog per backfill step (env override is for tests)
const TTL = { account: 24 * 3600e3, summoner: 10 * 60e3, league: 2 * 60e3, mastery: 10 * 60e3, ids: 90e3, queues: 7 * 24 * 3600e3 };
const PUUID_RE = /^[A-Za-z0-9_-]{20,100}$/;
const MATCH_RE = /^[A-Z0-9]+_\d+$/;

const pool = async (items, n, fn) => {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
};
const normPlatform = p => { const u = String(p || '').toUpperCase(); if (!PLATFORMS.includes(u)) throw new ProfileError('BAD_REGION', `Unknown region '${p}'.`); return u; };
const cleanPuuid = p => { if (!PUUID_RE.test(String(p))) throw new ProfileError('BAD_INPUT', 'Invalid player id.'); return String(p); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let activeCache = null; // the cache of the registered instance (for onRiotKeyChanged / flush)

// deps: { ipcMain, userDataPath, getRiotApiKey, getLeagueCredentials, lcuRequest, sendToWindow }
// test-only extras: riotBaseUrl(host) -> origin, queuesUrl, pollMs, autoRefreshDelays, limiter
function register(deps) {
    const { ipcMain, userDataPath, getRiotApiKey, sendToWindow } = deps;
    const cache = createCache(path.join(userDataPath, 'profile-cache'));
    activeCache = cache;
    const riot = createRiotClient({ getKey: getRiotApiKey, baseUrl: deps.riotBaseUrl, limiter: deps.limiter });
    const lcu = getSharedLcu({ getLeagueCredentials: deps.getLeagueCredentials, lcuRequest: deps.lcuRequest });
    const push = (ch, payload) => { try { sendToWindow(ch, payload); } catch (e) { /* window gone */ } };
    const log = deps.log || (() => {});

    const handle = (name, fn) => ipcMain.handle('profile:' + name, async (event, args) => {
        try { return await fn(args || {}); } catch (e) { return errorToResult(e); }
    });

    // ---------- helpers: Riot calls ----------
    const platformGet = (platform, p, o) => riot.request('platform', platform, p, o);
    const regionalGet = (platform, p, o) => riot.request('regional', platform, p, o);
    const accountGet = (platform, p, o) => riot.request('account', platform, p, o); // account-v1: americas/asia/europe only

    // Riot ID of a puuid we have seen (in memory first, then the cache); used for stale-puuid recovery and match matching
    const identMem = new Map();
    const identOf = puuid => { if (identMem.has(puuid)) return identMem.get(puuid); const h = cache.getMeta('puuid:' + puuid); return h ? h.data : null; };
    const rememberIdent = (puuid, gameName, tagLine, platform) => { if (puuid && gameName) identMem.set(puuid, { gameName, tagLine, platform }); };

    // Drop everything keyed to one (stale) puuid; the Riot ID entry (puuid:) is kept so the account can be re-resolved.
    function dropAccountCache(puuid) {
        return cache.dropMeta((k, e) => k === 'sum:' + puuid || k === 'lg:' + puuid || k === 'ms:' + puuid || k.startsWith('mc:' + puuid + ':') || (k.startsWith('acct:') && e && e.data && e.data.puuid === puuid));
    }

    // Re-resolve a stale puuid by its Riot ID; carries the ledger rows / id lists over to the new puuid. Returns the new puuid.
    async function recoverPuuid(oldPuuid, platform, priority = PRIORITY.VISIBLE) {
        const id = identOf(oldPuuid);
        dropAccountCache(oldPuuid);
        if (!id || !id.gameName) throw new ProfileError('STALE_PUUID', 'This player id belongs to a different API key. Search the Riot ID again.');
        const a = await getAccount(id.gameName, id.tagLine, id.platform || platform, { priority, force: true, noStale: true });
        if (a.puuid !== oldPuuid) {
            const od = cache.peekPlayer(oldPuuid);
            if (od) {
                const nd = cache.player(a.puuid);
                nd.rows = { ...od.rows, ...nd.rows };
                for (const g of Object.keys(od.idx)) if (!nd.idx[g]) nd.idx[g] = od.idx[g];
                cache.savePlayer(a.puuid);
            }
        }
        return a.puuid;
    }
    // fn(puuid); on STALE_PUUID recover once and run again with the new puuid
    async function withRecovery(puuid, platform, fn, priority) {
        try { return await fn(puuid); }
        catch (e) {
            if (!e || e.code !== 'STALE_PUUID') throw e;
            const np = await recoverPuuid(puuid, platform, priority);
            if (np === puuid) throw e;
            return await fn(np);
        }
    }

    async function getAccount(gameName, tagLine, platform, { priority = PRIORITY.VISIBLE, force = false, noStale = false } = {}) {
        const key = `acct:${platform}:${gameName.toLowerCase()}#${tagLine.toLowerCase()}`;
        const hit = cache.getMeta(key);
        if (hit && !force && Date.now() - hit.at < TTL.account) { rememberIdent(hit.data.puuid, hit.data.gameName, hit.data.tagLine, platform); return hit.data; }
        try {
            const a = await accountGet(platform, `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`, { priority, nullOn404: true });
            if (!a || !a.puuid) throw new ProfileError('NOT_FOUND', `Riot ID ${gameName}#${tagLine} was not found on ${platform}.`);
            cache.setMeta(key, a);
            cache.setMeta('puuid:' + a.puuid, { gameName: a.gameName, tagLine: a.tagLine, platform });
            rememberIdent(a.puuid, a.gameName, a.tagLine, platform);
            return a;
        } catch (e) {
            if (hit && !noStale && e.code !== 'NOT_FOUND') return hit.data; // stale beats an error
            throw e;
        }
    }

    // ---------- LCU: me / ranked ----------
    let meCache = { at: 0, v: null };
    async function getMe() {
        if (Date.now() - meCache.at < 10000) return meCache.v;
        const s = await lcu.get('/lol-summoner/v1/current-summoner');
        let v = null;
        if (s && (s.gameName || s.displayName)) {
            let platform = null;
            const rl = await lcu.get('/riotclient/get_region_locale');
            if (rl && rl.region) platform = C.LCU_REGION_TO_PLATFORM[String(rl.region).toUpperCase()] || null;
            v = { gameName: s.gameName || s.displayName, tagLine: s.tagLine || '', platform, lcuPuuid: s.puuid || null, profileIconId: s.profileIconId, summonerLevel: s.summonerLevel };
            noteOwner(v);
        }
        meCache = { at: Date.now(), v };
        return v;
    }
    // ---------- the owner: one answer to "which account is mine?" (profile:owner) ----------
    // The client's account when it has a platform; else the last client account seen (cache meta 'owner-last', written whenever the
    // client account is read with a platform); else Settings > Default account. Cache and settings only: no Riot requests.
    function cachedPuuid(g, t, platform) {
        const h = cache.getMeta(`acct:${platform}:${String(g).toLowerCase()}#${String(t).toLowerCase()}`);
        return (h && h.data && h.data.puuid) || null;
    }
    function noteOwner(me) {
        if (!me || !me.platform || !me.gameName || !me.tagLine) return;
        const prev = cache.getMeta('owner-last'), d = prev && prev.data;
        if (d && d.gameName === me.gameName && d.tagLine === me.tagLine && d.platform === me.platform) return;   // unchanged: no write
        cache.setMeta('owner-last', { gameName: me.gameName, tagLine: me.tagLine, platform: me.platform, puuid: cachedPuuid(me.gameName, me.tagLine, me.platform) });
    }
    // a Riot ID from outside (settings file, the renderer's fallback): trimmed, length-checked, platform defaults to EUW1
    function cleanAcct(x) {
        if (!x || typeof x !== 'object') return null;
        const gameName = String(x.gameName || '').trim(), tagLine = String(x.tagLine || '').trim().replace(/^#/, '');
        if (!gameName || !tagLine || gameName.length > 40 || tagLine.length > 10) return null;
        const platform = String(x.platform || 'EUW1').toUpperCase();
        return { gameName, tagLine, platform: PLATFORMS.includes(platform) ? platform : 'EUW1' };
    }
    function settingsAccount() {
        try {
            const st = deps.readSettings ? deps.readSettings() : JSON.parse(fs.readFileSync(path.join(userDataPath, 'settings.json'), 'utf8'));
            return cleanAcct(st && st.profileAccount);
        } catch (e) { return null; }
    }
    // The puuid of a Riot ID: the account lookup (cache first, then Riot); when that cannot answer (no key, offline) the Riot IDs
    // seen before ('puuid:' cache entries) do, so views that read the local cache keep working without a key or a client.
    function knownPuuid(g, t, platform) {
        let found = null;
        const gl = String(g).toLowerCase(), tl = String(t).toLowerCase();
        cache.dropMeta((k, e) => {   // read-only scan (the predicate never asks for removal)
            if (!found && k.startsWith('puuid:') && e && e.data && e.data.platform === platform && String(e.data.gameName).toLowerCase() === gl && String(e.data.tagLine).toLowerCase() === tl) found = k.slice(6);
            return false;
        });
        return found;
    }
    async function resolvePuuid(g, t, platform) {
        try { return (await getAccount(g, t, platform, { priority: PRIORITY.VISIBLE })).puuid; }
        catch (e) { const known = knownPuuid(g, t, platform); if (known) return known; throw e; }
    }
    // Owner test: Riot ID (case-insensitive) AND platform must match. A client whose region could not be detected is
    // not assumed to be the owner; only the explicit "my live game" request (live with no Riot ID) uses the LCU me directly.
    const sameId = (me, g, t, p) => !!me && !!me.platform && !!p && me.platform === p && String(me.gameName).toLowerCase() === String(g).toLowerCase() && String(me.tagLine).toLowerCase() === String(t).toLowerCase();

    // ---------- season history helpers (no extra requests: they piggy-back on league / ranked-stats results) ----------
    function noteLcuPrev(puuid, rs) {
        try { const pv = SE.lcuPrevSeasons(rs); if (pv && puuid) cache.setMeta('lcuprev:' + puuid, pv); } catch (e) { /* best effort */ }
    }
    function recordLeague(puuid, entries) {
        try {
            if (!puuid || !Array.isArray(entries) || !entries.length) return;
            const doc = cache.player(puuid);
            if (SE.recordSnapshots(doc, entries)) cache.savePlayer(puuid);
        } catch (e) { /* best effort */ }
    }

    // ---------- profile (summoner + league + mastery) ----------
    const part = (name, puuid) => cache.getMeta(`${name}:${puuid}`);
    const refreshing = new Map();

    async function fetchParts(acct, platform, { priority, me, force, only }) {
        const puuid = acct.puuid;
        const owner = sameId(me, acct.gameName, acct.tagLine, platform);
        const want = n => !only || only.includes(n);
        const jobs = {};
        if (want('summoner')) jobs.summoner = (async () => {
            if (owner && me.summonerLevel) return { profileIconId: me.profileIconId, summonerLevel: me.summonerLevel, revisionDate: Date.now() };
            return platformGet(platform, `/lol/summoner/v4/summoners/by-puuid/${puuid}`, { priority });
        })();
        if (want('league')) jobs.league = (async () => {
            if (owner && me.lcuPuuid) {
                const rs = await lcu.get(`/lol-ranked/v1/ranked-stats/${me.lcuPuuid}`);
                if (rs && rs.queues) { noteLcuPrev(puuid, rs); return C.lcuRankedToEntries(rs); }
            }
            return platformGet(platform, `/lol/league/v4/entries/by-puuid/${puuid}`, { priority, nullOn404: true });
        })();
        if (want('mastery')) jobs.mastery = platformGet(platform, `/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/top?count=10`, { priority, nullOn404: true });
        const names = Object.keys(jobs);
        const res = await Promise.allSettled(names.map(n => jobs[n]));
        let firstErr = null, okCount = 0;
        res.forEach((r, i) => {
            if (r.status === 'fulfilled') { cache.setMeta(`${names[i] === 'summoner' ? 'sum' : names[i] === 'league' ? 'lg' : 'ms'}:${puuid}`, r.value == null ? [] : r.value); okCount++; if (names[i] === 'league') recordLeague(puuid, r.value); }
            else if (!firstErr) firstErr = r.reason;
        });
        const stale = res.find(r => r.status === 'rejected' && r.reason && r.reason.code === 'STALE_PUUID');
        if (stale) throw stale.reason;
        if (firstErr && (okCount === 0 || ['KEY_REJECTED', 'NO_KEY'].includes(firstErr.code))) throw firstErr;
    }
    // fetchParts with one stale-puuid recovery (drop the account's cache, re-resolve by Riot ID, retry). Returns the account used.
    async function fetchPartsRecovering(acct, platform, o) {
        try { await fetchParts(acct, platform, o); return acct; }
        catch (e) {
            if (e.code !== 'STALE_PUUID') throw e;
            dropAccountCache(acct.puuid);
            const fresh = await getAccount(acct.gameName, acct.tagLine, platform, { priority: o.priority, force: true, noStale: true });
            if (fresh.puuid === acct.puuid) throw e;
            await fetchParts(fresh, platform, { ...o, only: null });
            return fresh;
        }
    }

    function buildProfile(acct, platform, me) {
        const sum = part('sum', acct.puuid), lg = part('lg', acct.puuid), ms = part('ms', acct.puuid);
        const ages = [sum, lg, ms].map(x => x ? x.at : 0);
        return {
            gameName: acct.gameName, tagLine: acct.tagLine, platform, puuid: acct.puuid,
            profileIconId: sum && sum.data ? sum.data.profileIconId : null,
            summonerLevel: sum && sum.data ? sum.data.summonerLevel : null,
            ranked: lg && Array.isArray(lg.data) ? lg.data : [],
            mastery: ms && Array.isArray(ms.data) ? ms.data : [],
            updatedAt: Math.min(...ages),
            isOwner: sameId(me, acct.gameName, acct.tagLine, platform)
        };
    }
    const partState = puuid => {
        const now = Date.now();
        const s = part('sum', puuid), l = part('lg', puuid), m = part('ms', puuid);
        return {
            missing: [!s && 'summoner', !l && 'league', !m && 'mastery'].filter(Boolean),
            stale: [s && now - s.at > TTL.summoner && 'summoner', l && now - l.at > TTL.league && 'league', m && now - m.at > TTL.mastery && 'mastery'].filter(Boolean)
        };
    }

    handle('lookup', async a => {
        const gameName = String(a.gameName || '').trim(), tagLine = String(a.tagLine || '').trim().replace(/^#/, '');
        if (!gameName || !tagLine) throw new ProfileError('BAD_INPUT', 'Enter a Riot ID like Name#TAG.');
        const platform = normPlatform(a.platform);
        const me = await getMe();
        let acct = await getAccount(gameName, tagLine, platform, { force: !!a.force });
        const st = partState(acct.puuid);
        let stale = false;
        if (a.force) acct = await fetchPartsRecovering(acct, platform, { priority: PRIORITY.VISIBLE, me });
        else if (st.missing.length) acct = await fetchPartsRecovering(acct, platform, { priority: PRIORITY.VISIBLE, me, only: st.missing.length === 3 ? null : st.missing });
        else if (st.stale.length) {
            stale = true;
            const k = acct.puuid, acct0 = acct;
            if (!refreshing.has(k)) {
                refreshing.set(k, fetchPartsRecovering(acct0, platform, { priority: PRIORITY.VISIBLE, me, only: st.stale })
                    .then(acctNow => push('profile:update', { kind: 'profile', puuid: acct0.puuid, profile: buildProfile(acctNow, platform, me) }))
                    .catch(e => push('profile:update', { kind: 'profile-error', puuid: acct0.puuid, error: errorToResult(e) }))
                    .finally(() => refreshing.delete(k)));
            }
        }
        return { ok: true, profile: buildProfile(acct, platform, me), stale };
    });

    // ---------- matches ----------
    const compactLru = new Map();
    function compactOf(raw) {
        const id = raw && raw.metadata && raw.metadata.matchId;
        if (compactLru.has(id)) return compactLru.get(id);
        const c = C.compactMatch(raw);
        if (c) { compactLru.set(id, c); if (compactLru.size > 400) compactLru.delete(compactLru.keys().next().value); }
        return c;
    }
    async function getMatch(id, platform, priority) {
        let raw = await cache.getMatch(id);
        if (raw) return { raw, cached: true };
        raw = await regionalGet(platform, `/lol/match/v5/matches/${id}`, { priority, nullOn404: true });
        if (!raw || !raw.info) return { raw: null };
        await cache.putMatch(id, raw);
        return { raw, cached: false };
    }
    const noteRow = (puuid, cm) => {
        const doc = cache.player(puuid);
        const old = doc.rows[cm.id];
        if (old) {   // Arena rows saved before placements (or the lobby size) were recorded get them now
            if ((old.pl == null || old.tp == null) && C.ARENA_QUEUES.includes(cm.queueId)) { const r = C.ledgerRow(cm, puuid, identOf(puuid)); if (r && r.pl) { old.pl = r.pl; old.tp = r.tp; return true; } }
            return false;
        }
        const row = C.ledgerRow(cm, puuid, identOf(puuid));
        if (!row) return false;
        doc.rows[cm.id] = row;
        return true;
    };
    async function loadMatches(ids, puuid, platform, priority, conc = 5) {
        const out = new Array(ids.length).fill(null);
        let firstErr = null, changed = false;
        await pool(ids, conc, async (id, i) => {
            if (firstErr && ['KEY_REJECTED', 'NO_KEY', 'RATE_LIMITED', 'OFFLINE'].includes(firstErr.code)) return;
            try {
                const { raw } = await getMatch(id, platform, priority);
                if (!raw) return;
                const cm = compactOf(raw);
                if (!cm) return;
                out[i] = cm;
                if (noteRow(puuid, cm)) changed = true;
            } catch (e) { firstErr = firstErr || e; }
        });
        if (changed) cache.savePlayer(puuid);
        const got = out.filter(Boolean);
        if (firstErr && !got.length) throw firstErr;
        return { matches: got, error: firstErr };
    }
    const idsPath = (puuid, group, start, count) => {
        const g = C.QUEUE_GROUPS[group];
        return `/lol/match/v5/matches/by-puuid/${puuid}/ids?start=${start}&count=${count}` + (g.queue ? `&queue=${g.queue}` : '') + (g.type ? `&type=${g.type}` : '');
    };
    const inGroup = (cm, group) => C.inGroup(group, cm.queueId, cm.mode);   // "All" leaves Arena and the other non-5v5 modes out
    // the champion filter of the match list and Insights (a Riot champion id, or null)
    const champOf = v => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
    const isChamp = (cm, puuid, ident, champId) => { if (!champId) return true; const me = C.findMe(cm, puuid, ident); return !!me && me.champId === champId; };

    // Refresh the head of a puuid's id list; returns the ids that are new.
    async function refreshHead(puuid, platform, group, priority, count = PAGE) {
        const doc = cache.player(puuid);
        const idx = doc.idx[group] || (doc.idx[group] = { ids: [], at: 0, complete: false });
        const fresh = await regionalGet(platform, idsPath(puuid, group, 0, count), { priority, nullOn404: true }) || [];
        const known = new Set(idx.ids);
        const added = fresh.filter(x => !known.has(x));
        const overlap = fresh.length > added.length;
        if (idx.ids.length && !overlap && fresh.length) { idx.ids = fresh.slice(); idx.complete = false; }
        else { const fs_ = new Set(fresh); idx.ids = [...fresh, ...idx.ids.filter(x => !fs_.has(x))]; }
        if (fresh.length < count && !idx.ids.length) idx.complete = true;
        idx.at = Date.now();
        cache.savePlayer(puuid);
        return added;
    }

    handle('matches', async a => {
        const platform = normPlatform(a.platform);
        return withRecovery(cleanPuuid(a.puuid), platform, puuid => matchesFor(puuid, platform, a));
    });
    async function matchesFor(puuid, platform, a) {
        const group = C.QUEUE_GROUPS[a.group] ? a.group : 'all';
        const start = Math.max(0, parseInt(a.start, 10) || 0);
        const champId = champOf(a.champId);
        const doc = cache.player(puuid);
        let idx = doc.idx[group];
        let stale = false;
        if (!idx || !idx.ids.length) {
            await refreshHead(puuid, platform, group, PRIORITY.VISIBLE);
            idx = doc.idx[group];
        } else if (start === 0 && (a.refresh || Date.now() - idx.at > TTL.ids)) {
            if (a.refresh) await refreshHead(puuid, platform, group, PRIORITY.VISIBLE);
            else {
                stale = true;
                const k = `ids:${puuid}:${group}`;
                if (!refreshing.has(k)) {
                    refreshing.set(k, (async () => {
                        const added = await refreshHead(puuid, platform, group, PRIORITY.VISIBLE);
                        if (added.length) {
                            await loadMatches(added, puuid, platform, PRIORITY.VISIBLE);
                            push('profile:update', { kind: 'matches', puuid, group, added: added.length });
                        }
                    })().catch(e => push('profile:update', { kind: 'matches-error', puuid, error: errorToResult(e) })).finally(() => refreshing.delete(k)));
                }
            }
            idx = doc.idx[group];
        }
        // The id list of "All" holds every game (Riot's list has no queue filter); the rows leave Arena and the other non-5v5 modes out.
        // When a page loses most of its rows that way, read on (a few pages at most) so the list never looks empty.
        const ident = identOf(puuid);
        const rows = [];
        let pos = start, error = null;
        for (let page = 0; page < 4; page++) {
            // extend the id list when this page runs past it
            if (idx.ids.length < pos + PAGE && !idx.complete) {
                const more = await regionalGet(platform, idsPath(puuid, group, idx.ids.length, PAGE), { priority: PRIORITY.VISIBLE, nullOn404: true }) || [];
                const known = new Set(idx.ids);
                for (const x of more) if (!known.has(x)) idx.ids.push(x);
                if (more.length < PAGE) idx.complete = true;
                cache.savePlayer(puuid);
            }
            const slice = idx.ids.slice(pos, pos + PAGE);
            let got;
            try { got = await loadMatches(slice, puuid, platform, PRIORITY.VISIBLE); }
            catch (e) { if (page === 0) throw e; error = e; break; }
            error = error || got.error;
            const kept = got.matches.filter(m => inGroup(m, group) && isChamp(m, puuid, ident, champId)).map(m => C.forViewer(m, puuid, ident));
            rows.push(...kept);
            pos += slice.length;
            if (!(got.matches.length > kept.length && rows.length < 8 && slice.length > 0 && (!idx.complete || pos < idx.ids.length))) break;
        }
        const nextStart = pos, hasMore = !idx.complete || nextStart < idx.ids.length;
        // games recorded from the client (ARAM Mayhem): the ones that fall between the previous page and this one, by time
        const inIdx = new Set(idx.ids), lcuIds = (doc.lcu || []).filter(id => !inIdx.has(id));
        if (lcuIds.length) {
            const prevRow = start > 0 ? doc.rows[idx.ids[start - 1]] : null;
            const upper = prevRow && prevRow.end ? prevRow.end : Infinity, lower = hasMore && rows.length ? Math.min(...rows.map(m => m.end)) : -Infinity;
            for (const id of lcuIds) {
                const r = doc.rows[id];
                if (!r || !(r.end < upper && r.end >= lower) || !C.inGroup(group, r.q) || (champId && r.c !== champId)) continue;
                const raw = await cache.getMatch(id), cm = raw && compactOf(raw);
                if (cm) rows.push(C.forViewer(cm, puuid, ident));
            }
            rows.sort((x, y) => y.end - x.end);
        }
        return { ok: true, puuid, group, champId, start, nextStart, hasMore, matches: rows, stale, warning: error ? errorToResult(error) : null };
    }

    handle('match', async a => {
        const id = String(a.id || ''); if (!MATCH_RE.test(id)) throw new ProfileError('BAD_INPUT', 'Invalid match id.');
        const { raw } = await getMatch(id, normPlatform(a.platform), PRIORITY.VISIBLE);
        if (!raw) throw new ProfileError('NOT_FOUND', 'Match not found.');
        const puuid = PUUID_RE.test(String(a.puuid || '')) ? String(a.puuid) : null;
        return { ok: true, match: puuid ? C.forViewer(compactOf(raw), puuid, identOf(puuid)) : compactOf(raw) };
    });

    // timeline of one match: disk cache first, else a single match-v5 timeline request (visible priority); de-duplicated in flight
    const tlInflight = new Map();
    handle('timeline', async a => {
        const id = String(a.id || ''); if (!MATCH_RE.test(id)) throw new ProfileError('BAD_INPUT', 'Invalid match id.');
        const platform = normPlatform(a.platform);
        const flightKey = `${id}|${Number(a.minVersion) || 1}`;
        let p = tlInflight.get(flightKey);
        if (!p) {
            p = (async () => {
                let tl = await cache.getTimeline(id), cached = !!tl;
                if (tl && (tl.v || 1) < Math.min(TL.TL_VERSION, Number(a.minVersion) || 1)) { tl = null; cached = false; }   // an older form without what the view needs (kills): fetch once more
                if (!tl) {
                    const raw = await regionalGet(platform, `/lol/match/v5/matches/${id}/timeline`, { priority: PRIORITY.VISIBLE, nullOn404: true });
                    tl = raw && TL.compactTimeline(raw);
                    if (!tl) throw new ProfileError('NOT_FOUND', 'No timeline is available for this match (Riot only keeps timelines for recent games).');
                    await cache.putTimeline(id, tl);
                }
                const m = await cache.getMatch(id);
                const teams = m && m.info && m.info.participants ? m.info.participants.map(x => x.teamId) : null;
                return { ok: true, timeline: TL.deriveTimeline(tl, teams), cached };
            })().finally(() => tlInflight.delete(flightKey));
            tlInflight.set(flightKey, p);
        }
        return p;
    });

    // teammates seen in >= 2 cached games (cache only, no Riot requests)
    const playedMemo = new Map();
    handle('played', async a => {
        const puuid = cleanPuuid(a.puuid);
        const group = C.QUEUE_GROUPS[a.group] ? a.group : 'all';
        const doc = cache.peekPlayer(puuid);
        if (!doc) return { ok: true, list: [], scanned: 0 };
        const rows = Object.values(doc.rows).filter(r => !r.rm && C.inGroup(group, r.q)).sort((x, y) => y.end - x.end).slice(0, 400);
        const key = `${puuid}|${group}|${rows.length}|${rows[0] ? rows[0].id : ''}`;
        if (playedMemo.has(key)) return playedMemo.get(key);
        const cms = new Array(rows.length).fill(null);
        await pool(rows, 6, async (r, i) => { const raw = await cache.getMatch(r.id); if (raw) cms[i] = compactOf(raw); });
        const got = cms.filter(Boolean);
        const out = { ok: true, list: C.playedWith(got, puuid, identOf(puuid), 2).slice(0, 12), scanned: got.length };
        playedMemo.clear(); playedMemo.set(key, out);
        return out;
    });

    // Insights tab: aggregates over the cached games of this season (up to 600, newest first), cache only
    const insightsMemo = new Map();
    handle('insights', async a => {
        const puuid = cleanPuuid(a.puuid);
        const group = C.QUEUE_GROUPS[a.group] ? a.group : 'all', champId = champOf(a.champId);
        const doc = cache.peekPlayer(puuid);
        if (!doc) return { ok: true, n: 0, scanned: 0, group, champId };
        const since = C.seasonStart();
        const rows = Object.values(doc.rows).filter(r => !r.rm && r.end >= since && C.inGroup(group, r.q) && (!champId || r.c === champId)).sort((x, y) => y.end - x.end).slice(0, 600);
        const key = `${puuid}|${group}|${champId || ''}|${rows.length}|${rows[0] ? rows[0].id : ''}`;
        if (insightsMemo.has(key)) return insightsMemo.get(key);
        const cms = new Array(rows.length).fill(null);
        await pool(rows, 6, async (r, i) => { const raw = await cache.getMatch(r.id); if (raw) cms[i] = compactOf(raw); });
        const got = cms.filter(Boolean);
        let out;
        if (group === 'arena') { const arena = arenaInsights(got, puuid, identOf(puuid)); out = { ok: true, n: arena.n, arena, scanned: got.length, group, champId }; }   // placement, not win / loss
        else out = { ok: true, ...insights(got, puuid, identOf(puuid)), scanned: got.length, group, champId };
        insightsMemo.clear(); insightsMemo.set(key, out);
        return out;
    });

    // One champion's games of a player, from the cached matches only (champion hub "My stats", build coaching).
    // The player is { puuid } or a Riot ID { gameName, tagLine, platform } (resolved like a lookup: cache first).
    handle('champ-summary', async a => {
        const champId = Number(a.champId);
        if (!Number.isInteger(champId) || champId <= 0) throw new ProfileError('BAD_INPUT', 'Invalid champion.');
        let puuid = a.puuid && PUUID_RE.test(String(a.puuid)) ? String(a.puuid) : null;
        if (!puuid) {
            const gameName = String(a.gameName || '').trim(), tagLine = String(a.tagLine || '').trim().replace(/^#/, '');
            if (!gameName || !tagLine) throw new ProfileError('BAD_INPUT', 'No account to read.');
            puuid = await resolvePuuid(gameName, tagLine, normPlatform(a.platform));   // cache first; works without a key or the client once the Riot ID was seen
        }
        const doc = cache.peekPlayer(puuid);
        // Arena and the other non-5v5 modes are not part of your numbers on a champion; CS / min comes from Summoner's Rift games only
        const rows = doc ? Object.values(doc.rows).filter(r => !r.rm && r.c === champId && !C.isExcludedFromAll(r.q)).sort((x, y) => y.end - x.end) : [];
        const out = { ok: true, puuid, games: rows.length, w: 0, k: 0, d: 0, a: 0, cs: 0, mins: 0, kp: 0, roles: {}, queues: {}, last: [], score: null, mvp: 0, ace: 0, items: {}, itemGames: 0, totalCached: doc ? Object.values(doc.rows).filter(r => !C.isExcludedFromAll(r.q)).length : 0,
            curve: learningCurve(rows.slice().reverse().map(r => ({ c: r.c, w: !!r.w }))), vsOpp: {} };
        for (const r of rows) {
            out.w += r.w; out.k += r.k; out.d += r.d; out.a += r.a; out.kp += r.kp || 0;
            if (C.isSrQueue(r.q)) { out.cs += r.cs || 0; out.mins += (r.dur || 0) / 60; }
            const pos = r.pos || 'NONE'; out.roles[pos] = (out.roles[pos] || 0) + 1; out.queues[r.q] = (out.queues[r.q] || 0) + 1;
        }
        // DD Score, badges and final items need the matches themselves: the newest 60 games on the champion
        const recent = rows.slice(0, 60), cms = new Array(recent.length).fill(null);
        await pool(recent, 6, async (r, i) => { const raw = await cache.getMatch(r.id); if (raw) cms[i] = C.forViewer(compactOf(raw), puuid, identOf(puuid)); });
        let scoreSum = 0, scoreN = 0;
        recent.forEach((r, i) => {
            const cm = cms[i], me = cm && C.findMe(cm, puuid, identOf(puuid));
            if (me && typeof me.sc === 'number') { scoreSum += me.sc; scoreN++; if (me.bd === 'MVP') out.mvp++; if (me.bd === 'ACE') out.ace++; }
            const opp = me && me.pos ? cm.players.find(p => p.team !== me.team && p.pos === me.pos) : null;   // your lane opponent
            if (opp) { const v = out.vsOpp[opp.champId] = out.vsOpp[opp.champId] || { g: 0, w: 0 }; v.g++; if (me.win) v.w++; }
            if (me && Array.isArray(me.items)) {
                const pos = me.pos || 'NONE', bucket = out.items[pos] = out.items[pos] || { games: 0, freq: {} };
                bucket.games++; out.itemGames++;
                for (const id of new Set(me.items.slice(0, 6).filter(x => x > 0))) bucket.freq[id] = (bucket.freq[id] || 0) + 1;
            }
            if (out.last.length < 10) out.last.push({ id: r.id, win: !!r.w, k: r.k, d: r.d, a: r.a, end: r.end, pos: r.pos || '', q: r.q, sc: me && typeof me.sc === 'number' ? me.sc : null, bd: me ? me.bd || null : null });
        });
        if (scoreN) out.score = scoreSum / scoreN;
        return out;
    });

    // Duo (draft's Duo tab): who is in your party, from the client lobby, and the partner's lane in champion select. No Riot requests.
    handle('duo', async () => {
        const me = await getMe();
        if (!me) return { ok: true, lcu: false, partners: [] };
        const [lob, cs] = await Promise.all([lcu.get('/lol-lobby/v2/lobby').catch(() => null), lcu.get('/lol-champ-select/v1/session').catch(() => null)]);
        const members = lob && Array.isArray(lob.members) ? lob.members.filter(Boolean) : [];
        const pos = m => [m.firstPositionPreference, m.secondPositionPreference].filter(p => p && !['UNSELECTED', 'FILL', ''].includes(p));
        const cellOf = m => (cs && Array.isArray(cs.myTeam) ? cs.myTeam.find(c => (m.puuid && c.puuid === m.puuid) || (m.summonerId && c.summonerId === m.summonerId)) : null) || null;
        const self = members.find(m => m.puuid && m.puuid === me.lcuPuuid);
        const myCell = cs && Array.isArray(cs.myTeam) ? cs.myTeam.find(c => c.cellId === cs.localPlayerCellId) : null;
        const partners = members.filter(m => m !== self && (m.puuid || m.summonerId)).map(m => {
            const cell = cellOf(m);
            return { gameName: String(m.gameName || m.summonerName || '').slice(0, 40), tagLine: String(m.gameTag || m.tagLine || '').slice(0, 10), positions: pos(m),
                assigned: cell && cell.assignedPosition ? String(cell.assignedPosition).toUpperCase() : null, championId: cell ? (cell.championId || cell.championPickIntent || 0) : 0 };
        }).filter(p => p.gameName);
        return { ok: true, lcu: true, inLobby: !!lob, partyType: lob && lob.gameConfig ? lob.gameConfig.queueId : null, partners,
            me: { gameName: me.gameName, tagLine: me.tagLine, platform: me.platform, positions: self ? pos(self) : [], assigned: myCell && myCell.assignedPosition ? String(myCell.assignedPosition).toUpperCase() : null } };
    });
    // Games you and a partner played on the same team, from your cached matches only: totals, champion pairs and both lanes.
    // { owner: {puuid} | {gameName,tagLine,platform}, partner: {gameName,tagLine} }
    handle('duo-history', async a => {
        const o = a.owner || {};
        let puuid = o.puuid && PUUID_RE.test(String(o.puuid)) ? String(o.puuid) : null;
        if (!puuid) {
            const g = String(o.gameName || '').trim(), t = String(o.tagLine || '').trim().replace(/^#/, '');
            if (!g || !t) throw new ProfileError('BAD_INPUT', 'No account to read.');
            puuid = await resolvePuuid(g, t, normPlatform(o.platform));
        }
        const pg = String(a.partner && a.partner.gameName || '').trim().toLowerCase(), pt = String(a.partner && a.partner.tagLine || '').trim().replace(/^#/, '').toLowerCase();
        if (!pg) throw new ProfileError('BAD_INPUT', 'No partner.');
        const doc = cache.peekPlayer(puuid);
        const rows = doc ? Object.values(doc.rows).filter(r => !r.rm && !C.isExcludedFromAll(r.q)).sort((x, y) => y.end - x.end).slice(0, 400) : [];
        const cms = new Array(rows.length).fill(null);
        await pool(rows, 6, async (r, i) => { const raw = await cache.getMatch(r.id); if (raw) cms[i] = compactOf(raw); });
        const out = { ok: true, puuid, scanned: 0, games: 0, w: 0, pairs: [], lanes: [], partnerChamps: {} };
        const pairs = new Map(), lanes = new Map();
        for (const cm of cms) {
            if (!cm || cm.remake) continue;
            out.scanned++;
            const me = C.findMe(cm, puuid, identOf(puuid));
            if (!me) continue;
            const mate = cm.players.find(p => p !== me && p.team === me.team && String(p.name || '').toLowerCase() === pg && (!pt || String(p.tag || '').toLowerCase() === pt));
            if (!mate) continue;
            out.games++; if (me.win) out.w++;
            const pk = `${me.champId}|${mate.champId}`, lk = `${me.pos || ''}|${mate.pos || ''}`;
            const p = pairs.get(pk) || { mine: me.champId, theirs: mate.champId, games: 0, w: 0, myPos: me.pos || '', theirPos: mate.pos || '' };
            p.games++; if (me.win) p.w++; pairs.set(pk, p);
            const l = lanes.get(lk) || { myPos: me.pos || '', theirPos: mate.pos || '', games: 0, w: 0 };
            l.games++; if (me.win) l.w++; lanes.set(lk, l);
            const pc = out.partnerChamps[mate.pos || 'NONE'] = out.partnerChamps[mate.pos || 'NONE'] || {};
            pc[mate.champId] = (pc[mate.champId] || 0) + 1;
        }
        out.pairs = [...pairs.values()].sort((x, y) => y.games - x.games || y.w - x.w).slice(0, 20);
        out.lanes = [...lanes.values()].sort((x, y) => y.games - x.games);
        return out;
    });

    handle('ledger', async a => {
        const doc = cache.player(cleanPuuid(a.puuid));
        const since = C.seasonStart();
        const all = Object.values(doc.rows);
        return { ok: true, rows: all.filter(r => r.end >= since && !r.rm), total: all.length, seasonStart: since };
    });

    // ---------- background backfill (lowest priority) ----------
    const backfills = new Map();
    handle('backfill', async a => {
        const puuid = cleanPuuid(a.puuid), platform = normPlatform(a.platform); // `puuid` is what the view knows; events use it
        if (backfills.has(puuid)) return { ok: true, running: true };
        let fireAbort;
        const ctl = { cancel: false, abort: new Promise(r => { fireAbort = r; }), fire: () => fireAbort() };
        backfills.set(puuid, ctl);
        const max = Math.min(400, Math.max(10, parseInt(a.max, 10) || 100));
        (async () => {
            const since = C.seasonStart();
            let done = 0, state = 'done', err = null;
            // A step that never settles (stalled socket, limiter stuck) ends the run instead of hanging the header forever;
            // Cancel also ends it at once.
            const guard = (p, ms) => {
                let t;
                return Promise.race([
                    p,
                    new Promise((_, rej) => { t = setTimeout(() => rej(new ProfileError('TIMEOUT', 'The Riot API stopped responding.')), ms); }),
                    ctl.abort.then(() => { throw new ProfileError('CANCELLED', 'Cancelled.'); })
                ]).finally(() => clearTimeout(t));
            };
            // tell the view when the shared rate limiter will hold the next request for a while
            const announceWait = () => {
                const ms = riot.limiter.nextSlotIn ? riot.limiter.nextSlotIn() : 0;
                if (ms > 3000) push('profile:progress', { kind: 'backfill', puuid, done, total: max, state: 'running', waitingMs: ms, resumeAt: Date.now() + ms });
            };
            const run = async pu => {
                const doc = cache.player(pu);
                done = 0;
                for (let start = 0; start < 1000 && !ctl.cancel && done < max; start += 100) {
                    announceWait();
                    const ids = await guard(regionalGet(platform, idsPath(pu, 'all', start, 100), { priority: PRIORITY.BACKGROUND, nullOn404: true }), BACKFILL_STEP_MS) || [];
                    if (!ids.length) break;
                    const need = ids.filter(id => !doc.rows[id]);
                    let reachedOld = false;
                    for (let i = 0; i < need.length && !ctl.cancel && done < max; i += 5) {
                        const batch = need.slice(i, i + 5);
                        announceWait();
                        const { matches } = await guard(loadMatches(batch, pu, platform, PRIORITY.BACKGROUND, 5), BACKFILL_STEP_MS);
                        done += batch.length;
                        if (matches.some(m => m.end < since)) reachedOld = true;
                        push('profile:progress', { kind: 'backfill', puuid, done, total: max, state: 'running' });
                    }
                    if (reachedOld || ids.length < 100) break;
                }
            };
            try {
                await withRecovery(puuid, platform, run, PRIORITY.BACKGROUND);
                if (ctl.cancel) state = 'cancelled';
            } catch (e) {
                if (e && e.code === 'CANCELLED') state = 'cancelled';
                else { state = 'error'; err = errorToResult(e); }
            }
            backfills.delete(puuid);
            push('profile:progress', { kind: 'backfill', puuid, done, total: max, state, error: err });
            push('profile:update', { kind: 'ledger', puuid });
            // your own season games also feed the draft's "You" column (personal-history.json); others' profiles are untouched
            if (done > 0) syncOwnerHistory(puuid, platform).then(n => { if (n) push('profile:update', { kind: 'personal', puuid, added: n }); }).catch(() => {});
        })();
        return { ok: true, running: true };
    });
    handle('backfill-cancel', async a => { const c = backfills.get(a.puuid); if (c) { c.cancel = true; c.fire(); } return { ok: true }; });

    // ---------- live game ----------
    // Budget per game (Riot): spectate 1 + account 1 + (league + champion mastery) x10 = 22 (league is free for every player
    // when the client runs: LCU ranked-stats) + match-id lists for premade detection x10 = about 32, never more than LIVE_BUDGET.
    // op.gg (separate, polite, serialised, cached): per player one page (7 days) + one champion-stats call (6 h).
    let liveGen = 0, liveSt = null;
    const champNames = new Map();                    // championId -> { name, id } (from the view's Data Dragon data)
    const OPGG_LIVE = deps.opggLive != null ? !!deps.opggLive : !(deps.riotBaseUrl && !deps.opggOrigin); // a stubbed Riot API never talks to the real op.gg
    const liveIds = new Map();                       // puuid -> { at, ids } short-lived match-id lists (premade detection)
    function setChampNames(list) {
        if (!Array.isArray(list)) return;
        for (const x of list.slice(0, 500)) if (Array.isArray(x) && Number.isInteger(x[0]) && typeof x[1] === 'string' && typeof x[2] === 'string') champNames.set(x[0], { name: x[1].slice(0, 40), id: x[2].slice(0, 40) });
    }

    const championRows = (puuid, champId) => {
        const doc = cache.peekPlayer(puuid); // never create a player doc just to look
        if (!doc) return {};
        const rows = Object.values(doc.rows).filter(r => !r.rm && !C.isExcludedFromAll(r.q));   // no Arena / Swarm games in anyone's numbers
        if (!rows.length) return {};
        const mine = rows.filter(r => r.c === champId);
        const recent = rows.sort((x, y) => y.end - x.end).slice(0, 10);
        const sm = k => mine.reduce((s, r) => s + (r[k] || 0), 0);
        const smSr = k => mine.reduce((s, r) => s + (C.isSrQueue(r.q) ? (r[k] || 0) : 0), 0);   // cs / dur: Summoner's Rift games only
        return {
            champ: { games: mine.length, wins: mine.filter(r => r.w).length, k: sm('k'), d: sm('d'), a: sm('a'), cs: smSr('cs'), dur: smSr('dur') },
            form: { games: recent.length, wins: recent.filter(r => r.w).length, cached: true, results: recent.map(r => !!r.w) }
        };
    };

    async function lcuRoster() {
        const s = await lcu.get('/lol-gameflow/v1/session');
        const gd = s && s.gameData;
        if (!gd || (!(gd.teamOne || []).length && !(gd.teamTwo || []).length)) return null;
        const mk = (p, teamId) => ({
            lcuPuuid: p.puuid || null, name: p.gameName || p.summonerName || p.summonerInternalName || '', tag: p.tagLine || '',
            teamId, championId: p.championId || 0, spell1Id: p.spell1Id, spell2Id: p.spell2Id, bot: !!p.isBot
        });
        return { phase: s.phase, gameId: gd.gameId, queueId: gd.queue && gd.queue.id, players: [...(gd.teamOne || []).map(p => mk(p, 100)), ...(gd.teamTwo || []).map(p => mk(p, 200))] };
    }
    const splitRiotId = id => { const s = String(id || ''); const i = s.lastIndexOf('#'); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]; };

    // spectator-v5 participants (+ the client's roster for LCU puuids) -> the view's players
    function playersFromGame(game, roster, ownPuuid) {
        // LCU roster -> Riot participants: by Riot ID when the client gives one, else by team + champion (never champion alone)
        const rp = roster ? roster.players : [];
        const byName = new Map(rp.filter(p => p.name).map(p => [`${p.name}#${p.tag}`.toLowerCase(), p]));
        const byTeamChamp = new Map(rp.filter(p => p.championId).map(p => [`${p.teamId}:${p.championId}`, p]));
        return game.participants.map((p, i) => {
            const [n, t] = splitRiotId(p.riotId);
            const l = (n && byName.get(`${n}#${t}`.toLowerCase())) || byTeamChamp.get(`${p.teamId}:${p.championId}`);
            return {
                puuid: p.bot ? null : p.puuid, lcuPuuid: l ? l.lcuPuuid : null, name: n, tag: t, teamId: p.teamId, championId: p.championId,
                spell1Id: p.spell1Id, spell2Id: p.spell2Id, bot: !!p.bot, profileIconId: p.profileIconId,
                perks: p.perks ? { ids: p.perks.perkIds || [], style: p.perks.perkStyle, sub: p.perks.perkSubStyle } : null,
                idx: i, me: p.puuid === ownPuuid
            };
        });
    }
    const metaFromGame = game => ({ gameId: game.gameId, queueId: game.gameQueueConfigId, mode: game.gameMode, startTime: game.gameStartTime || 0, length: game.gameLength || 0, bans: game.bannedChampions || [], source: 'riot' });

    handle('live', async a => {
        setChampNames(a.champs);
        const me = await getMe();
        let gameName = String(a.gameName || '').trim(), tagLine = String(a.tagLine || '').trim(), platform = a.platform ? normPlatform(a.platform) : null;
        const useOwner = !gameName;
        if (useOwner) {
            if (!me) return { ok: true, inGame: false, reason: 'no-client' };
            ({ gameName, tagLine } = me); platform = platform || me.platform;
            if (!platform) throw new ProfileError('BAD_REGION', 'Could not detect your region from the client.');
        } else if (!platform) throw new ProfileError('BAD_REGION', 'Pick a region.');
        const owner = useOwner || sameId(me, gameName, tagLine, platform);
        const gen = ++liveGen;
        let acct = await getAccount(gameName, tagLine, platform, { priority: PRIORITY.LIVE });
        const spectate = pu => platformGet(platform, `/lol/spectator/v5/active-games/by-summoner/${pu}`, { priority: PRIORITY.LIVE, nullOn404: true });
        let game;
        try { game = await spectate(acct.puuid); }
        catch (e) {
            if (e.code !== 'STALE_PUUID') throw e;
            dropAccountCache(acct.puuid);
            acct = await getAccount(gameName, tagLine, platform, { priority: PRIORITY.LIVE, force: true, noStale: true });
            game = await spectate(acct.puuid);
        }
        const roster = owner ? await lcuRoster() : null;

        let players, meta;
        if (game && Array.isArray(game.participants)) {
            players = playersFromGame(game, roster, acct.puuid);
            meta = metaFromGame(game);
        } else if (roster && roster.players.some(p => p.championId)) {
            players = roster.players.map((p, i) => ({ ...p, puuid: null, perks: null, idx: i, me: false }));
            meta = { gameId: roster.gameId, queueId: roster.queueId, mode: null, startTime: 0, length: 0, bans: [], source: 'lcu', phase: roster.phase };
        } else return { ok: true, inGame: false, reason: 'not-in-game' };
        meta.opgg = OPGG_LIVE;
        meta.owner = !!owner;
        if (meta.source === 'lcu') {   // the owner is somewhere in the roster: match by Riot ID
            const mine = players.find(p => p.name && p.name.toLowerCase() === gameName.toLowerCase() && String(p.tag).toLowerCase() === tagLine.toLowerCase());
            if (mine) mine.me = true;
        }

        const gameKey = `${meta.gameId}:${gen}`;
        const st = { gen, gameKey, platform, acct, owner: !!owner, hasLcu: !!roster, meta, players, evidence: [], premades: [], riot0: riot.stats.requests, opgg0: { ...opgg.stats } };
        liveSt = st;
        const result = { ok: true, inGame: true, gameKey, game: { ...meta, players } };

        // Stream the per-player details after the roster has been returned
        setTimeout(() => runScouting(st), 0);
        if (meta.source === 'lcu') setTimeout(() => spectatorRetry(st, spectate, roster, 0), 10000).unref();
        return result;
    });

    // The game is in the client but spectator-v5 does not know it yet (loading screen): ask again a few times (<= 4 requests),
    // then upgrade the roster with runes, bans and the start time.
    const RETRY_MS = [10000, 15000, 25000, 40000];
    async function spectatorRetry(st, spectate, roster, n) {
        if (st.gen !== liveGen || !getRiotApiKey()) return;
        let game = null;
        try { game = await spectate(st.acct.puuid); } catch (e) { if (['KEY_REJECTED', 'NO_KEY'].includes(e.code)) return; }
        if (st.gen !== liveGen) return;
        if (game && Array.isArray(game.participants)) {
            const players = playersFromGame(game, roster, st.acct.puuid);
            st.players = players; st.meta = { ...metaFromGame(game), opgg: OPGG_LIVE, owner: st.owner }; st.evidence = []; st.premades = [];
            push('profile:progress', { kind: 'live', gameKey: st.gameKey, upgrade: { game: { ...st.meta, players } } });
            st.riot0 = riot.stats.requests;
            runScouting(st);
            return;
        }
        if (n + 1 < RETRY_MS.length) setTimeout(() => spectatorRetry(st, spectate, roster, n + 1), RETRY_MS[n + 1]).unref();
    }

    const summaries = st => ({ 100: LV.teamSummary(st.players.filter(p => p.teamId === 100)), 200: LV.teamSummary(st.players.filter(p => p.teamId === 200)) });
    // merge a partial update into the player, recompute its tags and stream it (and the team overviews)
    function emitPatch(st, idx, partial, extra = {}) {
        if (st.gen !== liveGen) return;
        const p = st.players[idx]; if (!p) return;
        Object.assign(p, partial);
        p.tags = LV.computeTags(p);
        push('profile:progress', { kind: 'live', gameKey: st.gameKey, patch: { idx, ...partial, tags: p.tags }, teams: summaries(st), ...extra });
    }
    const gameTypeOf = q => (q === 440 ? 'FLEXRANKED' : 'SOLORANKED');

    async function runScouting(st) {
        const tasks = [scoutRoster(st)];
        if (OPGG_LIVE) tasks.push(opggStage(st).catch(e => log('live op.gg stage: ' + (e && e.message))));
        await Promise.all(tasks);
        if (st.gen !== liveGen) return;
        try { await premadeStage(st); } catch (e) { log('live premade stage: ' + (e && e.message)); }
        if (st.gen !== liveGen) return;
        const budget = { riot: riot.stats.requests - st.riot0, opggPages: opgg.stats.pages - st.opgg0.pages, opggActions: opgg.stats.actions - st.opgg0.actions };
        log(`live budget: ${JSON.stringify(budget)}`);
        push('profile:progress', { kind: 'live', gameKey: st.gameKey, finished: true, budget, teams: summaries(st), premades: st.premades });
    }

    // core: league + mastery per player (+ the client's ranked-stats), as soon as each player is known
    async function scoutRoster(st) {
        const { gen, gameKey, platform, players, hasLcu } = st;
        let done = 0;
        const total = players.filter(p => !p.bot).length;
        await Promise.all(players.map(async p => {
            if (p.bot) return;
            const patch = {};
            try {
                if (p.puuid) {
                    Object.assign(patch, championRows(p.puuid, p.championId));
                    const sm = part('sum', p.puuid); if (sm && sm.data && sm.data.summonerLevel) patch.summonerLevel = sm.data.summonerLevel;
                }
                let ranked = null;
                if (p.lcuPuuid && hasLcu) {
                    const rs = await lcu.get(`/lol-ranked/v1/ranked-stats/${p.lcuPuuid}`);
                    if (rs && rs.queues) { ranked = C.lcuRankedToEntries(rs); if (p.puuid) noteLcuPrev(p.puuid, rs); }
                }
                if (gen !== liveGen) return;
                if (p.puuid) {
                    const cachedLg = part('lg', p.puuid);
                    const jobs = [];
                    if (!ranked) jobs.push((cachedLg && Date.now() - cachedLg.at < TTL.league)
                        ? Promise.resolve(cachedLg.data)
                        : platformGet(platform, `/lol/league/v4/entries/by-puuid/${p.puuid}`, { priority: PRIORITY.LIVE, nullOn404: true }).then(d => { cache.setMeta('lg:' + p.puuid, d || []); return d || []; }));
                    else jobs.push(Promise.resolve(ranked));
                    const mk = `mc:${p.puuid}:${p.championId}`;
                    const cachedM = cache.getMeta(mk);
                    jobs.push(cachedM && Date.now() - cachedM.at < TTL.mastery
                        ? Promise.resolve(cachedM.data)
                        : platformGet(platform, `/lol/champion-mastery/v4/champion-masteries/by-puuid/${p.puuid}/by-champion/${p.championId}`, { priority: PRIORITY.LIVE, nullOn404: true }).then(d => { cache.setMeta(mk, d || {}); return d || {}; }));
                    const [lg, ms] = await Promise.all(jobs);
                    recordLeague(p.puuid, lg);
                    patch.ranked = lg; patch.mastery = ms && ms.championPoints != null ? { level: ms.championLevel, points: ms.championPoints, lastPlayTime: ms.lastPlayTime } : { level: 0, points: 0 };
                } else if (ranked) patch.ranked = ranked;
            } catch (e) { patch.error = errorToResult(e); }
            if (gen !== liveGen) return;
            done++;
            patch.stage = 'core';
            emitPatch(st, p.idx, patch, { done, total });
        }));
        if (gen === liveGen) push('profile:progress', { kind: 'live', gameKey, coreDone: true, done, total });
    }

    // op.gg: this season's stats on the played champion + role share + best past-season rank, one player at a time
    async function opggStage(st) {
        const { gen, platform } = st;
        const gt = gameTypeOf(st.meta.queueId);
        const label = gt === 'FLEXRANKED' ? 'Ranked Flex' : 'Ranked Solo/Duo';
        const ps = st.players.filter(p => !p.bot && p.name && p.tag);
        const show = (p, r) => {
            if (gen !== liveGen) return;
            let og;
            if (r && r.data) {
                const rs = LV.resolveChamp(r.data, champNames.get(p.championId) || null);
                og = { state: 'ok', stale: !r.ok, queue: label, season: r.data.season ? r.data.season.label : null, ...rs, roles: r.data.roles || null, peak: r.data.peak || null, at: r.fetchedAt || Date.now() };
            } else og = { state: 'fail', error: String((r && r.error) || 'op.gg unavailable').slice(0, 200), retryAt: r && r.retryAt || null, backoff: !!(r && r.backoff) };
            emitPatch(st, p.idx, { og, stage: 'opgg' });
        };
        const todo = [];
        for (const p of ps) {                  // cached ones first: no waiting
            const hit = opgg.peek(platform, p.name, p.tag, gt);
            if (hit) show(p, { ok: true, data: hit.data, fetchedAt: hit.fetchedAt }); else todo.push(p);
        }
        todo.sort((x, y) => (y.me ? 1 : 0) - (x.me ? 1 : 0));   // the owner first
        for (const p of todo) {
            if (gen !== liveGen) return;
            show(p, await opgg.champions(platform, p.name, p.tag, { gameType: gt }));
        }
        for (const p of st.players) if (!p.bot && !(p.name && p.tag)) emitPatch(st, p.idx, { og: { state: 'fail', error: 'No Riot ID for this player.' }, stage: 'opgg' });
    }

    // premades: cached matches (free), the client's party (free), then match-id lists (<= 10 Riot requests, budget permitting)
    const LIVE_BUDGET = 34;
    const lowId = p => (p.name ? `${p.name}#${p.tag}`.toLowerCase() : '');
    async function premadeStage(st) {
        const { gen, platform, players } = st;
        const real = players.filter(p => !p.bot);
        const publish = () => {
            st.premades = LV.detectPremades(players.map(p => ({ idx: p.idx, teamId: p.teamId })), st.evidence);
            push('profile:progress', { kind: 'live', gameKey: st.gameKey, premades: st.premades, teams: summaries(st) });
        };
        // 1. cached matches of every live player we have a ledger for
        const byPuuid = new Map(real.filter(p => p.puuid).map(p => [p.puuid, p]));
        const byId = new Map(real.filter(p => p.name && p.tag).map(p => [lowId(p), p]));
        const seenPair = new Set();
        const addPair = (a, b, src, n, ids) => {
            const k = (a < b ? a + '|' + b : b + '|' + a) + '|' + src;
            if (a === b || seenPair.has(k)) return; seenPair.add(k);
            st.evidence.push({ a, b, src, n, ids });
        };
        for (const p of real) {
            if (gen !== liveGen) return;
            const doc = p.puuid ? cache.peekPlayer(p.puuid) : null;
            if (!doc) continue;
            const ids = Object.values(doc.rows).filter(r => !r.rm).sort((x, y) => y.end - x.end).slice(0, 60).map(r => r.id);
            const counts = new Map(), recent = new Map();
            await pool(ids, 6, async id => {
                const raw = await cache.getMatch(id);
                const parts = raw && raw.info && raw.info.participants;
                if (!parts) return;
                const endTs = raw.info.gameEndTimestamp || raw.info.gameCreation || 0;
                const mineP = parts.find(x => x.puuid === p.puuid || (x.riotIdGameName && `${x.riotIdGameName}#${x.riotIdTagline || ''}`.toLowerCase() === lowId(p)));
                if (!mineP) return;
                for (const x of parts) {
                    if (x === mineP || x.teamId !== mineP.teamId) continue;
                    const other = byPuuid.get(x.puuid) || byId.get(`${x.riotIdGameName || ''}#${x.riotIdTagline || ''}`.toLowerCase());
                    if (other && other !== p && other.teamId === p.teamId) {
                        counts.set(other.idx, (counts.get(other.idx) || 0) + 1);
                        if (Date.now() - endTs < LV.THRESHOLDS.premadeRecentMs) recent.set(other.idx, true);
                    }
                }
            });
            // one old shared game proves little; two, or one from the last day, is a premade
            for (const [o, n] of counts) if (n >= LV.THRESHOLDS.premadeMinShared || recent.get(o)) addPair(p.idx, o, 'match', n);
        }
        if (st.evidence.length) publish();
        // 2. the owner's party (client lobby)
        if (st.hasLcu && st.owner) {
            const lob = await lcu.get('/lol-lobby/v2/lobby').catch(() => null);
            const ids = lob && Array.isArray(lob.members) ? lob.members.map(m => m && m.puuid).filter(Boolean) : [];
            const mem = real.filter(p => p.lcuPuuid && ids.includes(p.lcuPuuid));
            for (let i = 0; i < mem.length; i++) for (let j = i + 1; j < mem.length; j++) addPair(mem[i].idx, mem[j].idx, 'party', 1);
            if (mem.length > 1) publish();
        }
        // 3. recent match ids: two teammates sharing a recent match played it together
        const withP = real.filter(p => p.puuid);
        if (withP.length < 2) { publish(); return; }
        const lists = new Map();
        for (const p of withP) {
            if (gen !== liveGen) return;
            const memo = liveIds.get(p.puuid);
            if (memo && Date.now() - memo.at < 5 * 60e3) { lists.set(p.idx, memo.ids); continue; }
            if (riot.stats.requests - st.riot0 >= LIVE_BUDGET) break;
            try {
                const ids = await regionalGet(platform, idsPath(p.puuid, 'all', 0, 10), { priority: PRIORITY.VISIBLE, nullOn404: true }) || [];
                liveIds.set(p.puuid, { at: Date.now(), ids });
                if (liveIds.size > 200) liveIds.delete(liveIds.keys().next().value);
                lists.set(p.idx, ids);
            } catch (e) { if (['KEY_REJECTED', 'NO_KEY', 'RATE_LIMITED', 'OFFLINE'].includes(e.code)) break; }
        }
        const teamOf = new Map(players.map(p => [p.idx, p.teamId]));
        const cand = LV.pairsFromIds(lists, null).filter(e => teamOf.get(e.a) === teamOf.get(e.b));
        for (const e of cand) {          // a cached match settles whether the two were really on the same team
            let n = 0;
            for (const id of e.ids) {
                const raw = await cache.getMatch(id);
                const parts = raw && raw.info && raw.info.participants;
                const find = pl => parts && parts.find(x => x.puuid === pl.puuid || (x.riotIdGameName && `${x.riotIdGameName}#${x.riotIdTagline || ''}`.toLowerCase() === lowId(pl)));
                const A = find(players[e.a]), B = find(players[e.b]);
                if (A && B && A.teamId !== B.teamId) continue;
                n++;
            }
            if (n > 0) addPair(e.a, e.b, 'ids', n, e.ids);
        }
        publish();
    }

    // Deeper scout on click: last 5 games (1 ids + up to 5 matches at live priority)
    handle('scout', async a => {
        const platform = normPlatform(a.platform), champId = Number(a.championId) || 0;
        const r = await withRecovery(cleanPuuid(a.puuid), platform, puuid => scoutOne(puuid, platform, champId), PRIORITY.LIVE);
        // the live view passes its game key + row: feed the result into that row's tags (hot streak / loss streak)
        const idx = Number.isInteger(a.idx) ? a.idx : -1;
        if (liveSt && typeof a.gameKey === 'string' && a.gameKey === liveSt.gameKey && liveSt.players[idx] && liveSt.players[idx].championId === champId) {
            const res = r.form.results.map(x => !!x.win);
            emitPatch(liveSt, idx, { form: { games: r.form.games, wins: r.form.wins, cached: false, results: res }, stage: 'scout' });
        }
        return r;
    });
    // Multi-search (op.gg / u.gg style): one player of a pasted lobby. Profile (cache first), last 5 games and the live-game tags.
    // About 10 Riot requests for a player nobody looked up recently; the shared limiter keeps several players inside the key's budget.
    handle('multi', async a => {
        const gameName = String(a.gameName || '').trim(), tagLine = String(a.tagLine || '').trim().replace(/^#/, '');
        if (!gameName || !tagLine || gameName.length > 40 || tagLine.length > 10) throw new ProfileError('BAD_INPUT', 'Enter a Riot ID like Name#TAG.');
        const platform = normPlatform(a.platform);
        const me = await getMe();
        let acct = await getAccount(gameName, tagLine, platform, { priority: PRIORITY.VISIBLE });
        const st = partState(acct.puuid);
        if (st.missing.length || st.stale.length) acct = await fetchPartsRecovering(acct, platform, { priority: PRIORITY.VISIBLE, me, only: [...new Set([...st.missing, ...st.stale])] });
        const profile = buildProfile(acct, platform, me);
        let form = null, formError = null;
        try { form = (await withRecovery(acct.puuid, platform, p => scoutOne(p, platform, 0), PRIORITY.VISIBLE)).form; }
        catch (e) { formError = errorToResult(e); }
        const tags = LV.computeTags({ ranked: profile.ranked, summonerLevel: profile.summonerLevel, form: form ? { results: form.results.map(x => !!x.win) } : null });
        return { ok: true, profile, form, formError, tags };
    });

    async function scoutOne(puuid, platform, champId) {
        const ids = await regionalGet(platform, idsPath(puuid, 'all', 0, 5), { priority: PRIORITY.LIVE, nullOn404: true }) || [];
        const { matches } = await loadMatches(ids, puuid, platform, PRIORITY.LIVE);
        const mine = matches.map(m => ({ m, p: C.findMe(m, puuid, identOf(puuid)) })).filter(x => x.p && !C.isExcludedFromAll(x.m.queueId, x.m.mode));
        return {
            ok: true,
            form: { games: mine.length, wins: mine.filter(x => x.p.win).length, onChamp: mine.filter(x => x.p.champId === champId).length, results: mine.map(x => ({ win: x.p.win, champId: x.p.champId, k: x.p.k, d: x.p.d, a: x.p.a, queueId: x.m.queueId })) }
        };
    }

    // ---------- rank emblems + past seasons ----------
    const emblems = createEmblems({ dir: path.join(cache.rootDir, 'emblems'), baseUrl: deps.emblemBaseUrl, fetchBuf: deps.emblemFetch });
    const opgg = SE.createOpgg({ cache, origin: deps.opggOrigin, fetchHtml: deps.opggFetch, minGapMs: deps.opggMinGapMs });

    handle('emblems', async a => ({ ok: true, emblems: await emblems.getMany(a.tiers, a.size === 'big' ? 'big' : 'mini') }));

    handle('seasons', async a => {
        const gameName = String(a.gameName || '').trim(), tagLine = String(a.tagLine || '').trim().replace(/^#/, '');
        if (!gameName || !tagLine || gameName.length > 40 || tagLine.length > 10) throw new ProfileError('BAD_INPUT', 'Invalid Riot ID.');
        const platform = normPlatform(a.platform);
        const puuid = a.puuid && PUUID_RE.test(String(a.puuid)) ? String(a.puuid) : null;
        // op.gg first (network, may take a second); the local sources are read afterwards so a fresh snapshot is included
        const og = await opgg.get(platform, gameName, tagLine, { force: !!a.force });
        const prev = puuid ? cache.getMeta('lcuprev:' + puuid) : null;
        const doc = puuid ? cache.peekPlayer(puuid) : null;
        const merged = SE.mergeSeasons({ opgg: og.data, lcuPrev: prev && prev.data, snaps: doc && doc.snaps || [] });
        return {
            ok: true, ...merged,
            opgg: { ok: !!og.ok, cached: !!og.cached, error: og.error || null, retryAt: og.retryAt || null, backoff: !!og.backoff },
            fetchedAt: og.fetchedAt || null
        };
    });

    // ---------- misc ----------
    handle('test-key', async () => {
        if (!getRiotApiKey()) return { ok: false, code: 'NO_KEY', error: 'No Riot API key saved.' };
        const t = Date.now();
        await platformGet('EUW1', '/lol/status/v4/platform-data', { priority: PRIORITY.VISIBLE });
        return { ok: true, ms: Date.now() - t, limits: riot.limiter.windows.map(([n, ms]) => `${n + 1}/${ms / 1000}s`).join(', '), message: 'Riot API key accepted.' };
    });
    handle('me', async () => ({ ok: true, me: await getMe(), lcu: lcu.isUp(), phase: poller.phase() }));
    handle('owner', async a => {
        const me = await getMe().catch(() => null);
        const out = (acct, source) => ({ ok: true, owner: { gameName: acct.gameName, tagLine: acct.tagLine, platform: acct.platform, puuid: cachedPuuid(acct.gameName, acct.tagLine, acct.platform) || acct.puuid || null }, source });
        if (me && me.platform) return out(me, 'client');
        const last = cache.getMeta('owner-last'), lastAcct = last && cleanAcct(last.data);
        if (lastAcct) return out({ ...lastAcct, puuid: last.data.puuid }, 'last');
        const st = settingsAccount() || cleanAcct(a.fallback);
        if (st) return out(st, 'settings');
        return { ok: false };
    });
    handle('refresh', async () => ({ ok: true, ...(await refreshOwner()) }));

    // Settings > Diagnostics: rate-limit usage of the shared Riot limiter, op.gg back-off, client connection (no requests)
    const OPGG_BACKOFF_MS = SE.TTL.fail;
    handle('diag', async () => {
        const now = Date.now(), lim = riot.limiter;
        const stamps = Array.isArray(lim.stamps) ? lim.stamps : [];
        const until = e => (e && now - e.at < OPGG_BACKOFF_MS ? e.at + OPGG_BACKOFF_MS : 0);
        const blk = cache.getMeta('opgg-block'), act = cache.getMeta('opgg-actfail');
        let playerFails = 0;
        cache.dropMeta((k, e) => { if (k.startsWith('opgg-fail') && e && now - e.at < OPGG_BACKOFF_MS) playerFails++; return false; }); // count only
        return {
            ok: true,
            riot: { keySet: !!getRiotApiKey(), windows: lim.windows.map(([limit, ms]) => ({ limit, ms, used: stamps.filter(t => now - t < ms).length })),
                pausedUntil: lim.pausedUntil > now ? lim.pausedUntil : 0, waiting: lim.pendingCount ? lim.pendingCount() : 0, requests: riot.stats.requests, rateLimited: riot.stats.rateLimited },
            opgg: { blockedUntil: until(blk), error: blk && blk.data ? blk.data.error : null, actionFailedUntil: until(act), playersBackingOff: playerFails },
            lcu: { up: lcu.isUp(), phase: poller.phase() }
        };
    });
    // what: 'lookups' (accounts, ranks, mastery, op.gg pages: fetched again when needed; downloaded matches are kept)
    //       'opgg-backoff' (forget op.gg failures so it is asked again now)
    handle('cache-clear', async a => {
        const what = String(a.what || '');
        if (what === 'lookups') return { ok: true, removed: cache.dropMeta(k => !k.startsWith('puuid:') && k !== 'owner-last' && k !== 'queues' && k !== 'queues-cd' && k !== 'opgg-action') };
        if (what === 'opgg-backoff') return { ok: true, removed: cache.dropMeta(k => k === 'opgg-block' || k === 'opgg-actfail' || k.startsWith('opgg-fail')) };
        throw new ProfileError('BAD_INPUT', 'Unknown cache.');
    });

    let queueNames = { ...C.QUEUE_NAMES };
    function mergeQd(map) { if (map) for (const [id, name] of Object.entries(map)) if (name && !queueNames[id]) queueNames[id] = name; }
    function mergeQueues(list) { if (Array.isArray(list)) for (const q of list) if (q.queueId != null && q.description && !queueNames[q.queueId]) queueNames[q.queueId] = String(q.description).replace(/^\d+v\d+\s+/, '').replace(/\s+games?$/i, ''); }
    const hit = cache.getMeta('queues'); if (hit) mergeQueues(hit.data);
    const hitCd = cache.getMeta('queues-cd'); if (hitCd) mergeQd(hitCd.data);
    const fetchJson = (url, done) => {
        const lib = url.startsWith('https') ? https : require('http');
        lib.get(url, { timeout: 8000 }, res => {
            const ch = []; res.on('data', c => ch.push(c));
            res.on('end', () => { try { done(JSON.parse(Buffer.concat(ch).toString())); } catch (e) { done(null); } });
            res.on('error', () => done(null));
        }).on('error', () => done(null)).on('timeout', function () { this.destroy(); });
    };
    // Riot's queues.json first; ids it lacks (new modes such as 1750 "Arena 3x6") fall back to CommunityDragon's names.
    let queuesRefresh = null;
    function refreshQueues() {
        if (queuesRefresh) return queuesRefresh;
        const jobs = [];
        if (!hit || Date.now() - hit.at >= TTL.queues) jobs.push(new Promise(res => fetchJson(deps.queuesUrl || 'https://static.developer.riotgames.com/docs/lol/queues.json', j => {
            if (Array.isArray(j)) { cache.setMeta('queues', j.map(q => ({ queueId: q.queueId, description: q.description }))); mergeQueues(j); }
            res();
        })));
        if (!hitCd || Date.now() - hitCd.at >= TTL.queues) jobs.push(new Promise(res => fetchJson(deps.cdQueuesUrl || 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/queues.json', j => {
            if (Array.isArray(j)) {
                const m = {}; for (const q of j) if (q && q.id != null && (q.name || q.shortName || q.description)) m[q.id] = String(q.name || q.shortName || q.description);
                if (Object.keys(m).length) { cache.setMeta('queues-cd', m); mergeQd(m); }
            }
            res();
        })));
        queuesRefresh = Promise.all(jobs).then(() => { setTimeout(() => { queuesRefresh = null; }, 60000).unref(); });
        return queuesRefresh;
    }
    handle('static', async () => {
        const p = refreshQueues();
        if (!hit || !hitCd) await Promise.race([p, sleep(2500)]); // first run: give the name lists a moment
        return { ok: true, queues: queueNames, groups: C.QUEUE_GROUPS, mayhemQueue: C.MAYHEM_QUEUE, srQueues: C.SR_QUEUES, seasonStart: C.seasonStart() };
    });

    // ---------- auto refresh after games ----------
    function updatePersonalHistory(lcuPuuid, apiPuuid, raw) { return updatePersonalHistoryMany(lcuPuuid, apiPuuid, [raw]); }
    // Adds Summoner's Rift games (raw match-v5) to personal-history.json, the store behind the draft's "You" column.
    // One read and one write for the whole batch. Returns the number of games handed over.
    function updatePersonalHistoryMany(lcuPuuid, apiPuuid, raws) {
        try {
            const games = (raws || []).map(raw => riotHistory.matchToGame(raw, apiPuuid)).filter(Boolean);
            if (!games.length || !lcuPuuid) return 0;
            const file = path.join(userDataPath, 'personal-history.json');
            let store = {};
            try { store = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { return 0; } // no store yet: main.js creates it
            store[lcuPuuid] = lcuHistory.mergeGameHistory(store[lcuPuuid], games);
            store._riotChecked = store._riotChecked || {};
            store._riotChecked[lcuPuuid] = [...new Set([...(store._riotChecked[lcuPuuid] || []), ...games.map(g => g.gameId)])];
            fs.writeFileSync(file, JSON.stringify(store));
            return games.length;
        } catch (e) { return 0; /* history file is best effort */ }
    }
    // After "Load season history" on the owner's own profile: every cached game of the season also feeds the "You" column
    async function syncOwnerHistory(puuid, platform) {
        const me = await getMe().catch(() => null);
        const ident = identOf(puuid);
        if (!me || !me.lcuPuuid || !ident || !sameId(me, ident.gameName, ident.tagLine, platform)) return 0;
        const doc = cache.peekPlayer(puuid);
        if (!doc) return 0;
        const raws = [];
        for (const id of Object.keys(doc.rows)) { const raw = await cache.getMatch(id).catch(() => null); if (raw) raws.push(raw); }
        return updatePersonalHistoryMany(me.lcuPuuid, puuid, raws);
    }
    async function refreshOwner() {
        if (!getRiotApiKey()) return { added: 0, skipped: 'no-key' };
        const me = await getMe();
        if (!me || !me.platform) return { added: 0, skipped: 'no-client' };
        let acct = await getAccount(me.gameName, me.tagLine, me.platform, { priority: PRIORITY.VISIBLE });
        try { return await refreshOwnerWith(acct, me); }
        catch (e) {
            if (e.code !== 'STALE_PUUID') throw e;
            dropAccountCache(acct.puuid);
            acct = await getAccount(me.gameName, me.tagLine, me.platform, { priority: PRIORITY.VISIBLE, force: true, noStale: true });
            return await refreshOwnerWith(acct, me);
        }
    }
    async function refreshOwnerWith(acct, me) {
        const added = await refreshHead(acct.puuid, me.platform, 'all', PRIORITY.VISIBLE, 5);
        if (added.length) {
            const { matches } = await loadMatches(added, acct.puuid, me.platform, PRIORITY.VISIBLE);
            for (const id of added) { const raw = await cache.getMatch(id); if (raw) updatePersonalHistory(me.lcuPuuid, acct.puuid, raw); }
            // other queue lists are now out of date
            const doc = cache.player(acct.puuid);
            for (const g of Object.keys(doc.idx)) if (g !== 'all') doc.idx[g].at = 0;
            cache.savePlayer(acct.puuid);
            await fetchParts(acct, me.platform, { priority: PRIORITY.VISIBLE, me, only: ['league', 'summoner'] }).catch(e => { if (e.code === 'STALE_PUUID') throw e; });
            push('profile:update', { kind: 'matches', owner: true, puuid: acct.puuid, group: 'all', added: added.length, ids: added });
            push('profile:update', { kind: 'profile', puuid: acct.puuid, profile: buildProfile(acct, me.platform, me) });
            return { added: added.length, matches: matches.length, puuid: acct.puuid };
        }
        return { added: 0, puuid: acct.puuid };
    }
    // After a game: ask Riot for the owner's newest games until the game that just ended is in the list (Riot can take 10+ minutes
    // to publish it). Only a missing or rejected key stops it early; a moment without the client's region ('no-client') is retried.
    // ARAM Mayhem is never in Riot's API: that game is read from the client instead (recordClientGame).
    let wasInGame = false, refreshRun = 0, lastGame = null;
    const delays = deps.autoRefreshDelays || [20000, 60000, 120000, 240000, 600000, 1200000];
    const hasGame = (puuid, gameId) => { const doc = puuid && cache.peekPlayer(puuid); const idx = doc && doc.idx.all; return !!idx && idx.ids.some(id => id.endsWith('_' + gameId)); };
    async function scheduleAutoRefresh(game = {}) {
        const run = ++refreshRun;
        if (game.queueId === C.MAYHEM_QUEUE) { await recordClientGame(game).catch(() => null); return; }
        const target = game.gameId ? String(game.gameId) : null;
        for (const d of delays) {
            await sleep(d);
            if (run !== refreshRun) return;
            let r;
            try { r = await refreshOwner(); } catch (e) { if (['KEY_REJECTED', 'NO_KEY'].includes(e.code)) return; continue; }
            if (r.skipped === 'no-key') return;
            if (r.skipped) continue;
            if (target ? hasGame(r.puuid, target) : r.added) return;
        }
    }

    // ---------- games Riot's API does not return (ARAM Mayhem): recorded from the client ----------
    // The client's record of the finished game (/lol-match-history/v1/games/{id}: every player) becomes a cached match with
    // metadata.src = 'lcu' and a ledger row, and its id goes into the player's `lcu` list; profile:matches merges those games into
    // the match list by time. Needs the owner's API puuid: from the cache when known (no key needed), else one account lookup.
    const clientGameDelays = deps.clientGameDelays || [5000, 15000, 30000, 60000, 120000];
    async function ownerApiPuuid(me) {
        const last = cache.getMeta('owner-last'), d = last && last.data;
        const fromLast = d && d.puuid && String(d.gameName).toLowerCase() === String(me.gameName).toLowerCase() && String(d.tagLine).toLowerCase() === String(me.tagLine).toLowerCase() && d.platform === me.platform ? d.puuid : null;
        const known = cachedPuuid(me.gameName, me.tagLine, me.platform) || fromLast || knownPuuid(me.gameName, me.tagLine, me.platform);
        if (known) return known;
        if (!getRiotApiKey()) return null;
        try { return (await getAccount(me.gameName, me.tagLine, me.platform, { priority: PRIORITY.VISIBLE })).puuid; } catch (e) { return null; }
    }
    async function recordClientGame(game) {
        const me = await getMe().catch(() => null);
        if (!me || !me.platform || !me.lcuPuuid || !game || !game.gameId) return { ok: false, skipped: 'no-client' };
        const puuid = await ownerApiPuuid(me);
        if (!puuid) return { ok: false, skipped: 'no-account' };
        let g = null;
        for (const d of clientGameDelays) {        // the client writes the game into its history a few seconds after the end
            await sleep(d);
            g = await lcu.get(`/lol-match-history/v1/games/${game.gameId}`).catch(() => null);
            if (g && Array.isArray(g.participants) && g.participants.length) break;
            g = null;
        }
        if (!g) return { ok: false, skipped: 'not-found' };
        const raw = C.lcuGameToMatch(g, { platform: me.platform, ownerLcuPuuid: me.lcuPuuid, ownerApiPuuid: puuid });
        const cm = raw && compactOf(raw);
        if (!cm || !C.findMe(cm, puuid)) return { ok: false, skipped: 'not-yours' };
        await cache.putMatch(cm.id, raw);
        const doc = cache.player(puuid);
        noteRow(puuid, cm);
        doc.lcu = [cm.id, ...(doc.lcu || []).filter(x => x !== cm.id)].slice(0, 300);
        cache.savePlayer(puuid);
        push('profile:update', { kind: 'matches', owner: true, puuid, group: 'all', added: 1, ids: [cm.id], src: 'lcu' });
        return { ok: true, id: cm.id };
    }
    // ---------- LP tracker: your rank before and after every ranked game, from the client (no Riot requests) ----------
    // Before: read when champion select (or, if the app started mid-game, the game) begins. After: the client updates LP a few
    // seconds after the end of the game, so it is read again until the queue's wins + losses change. A champion select that ends
    // without a game is checked for a dodge penalty. Kept per client account in the cache meta 'lp:<lcuPuuid>' (last 400).
    const RANKED_Q = { 420: 'RANKED_SOLO_5x5', 440: 'RANKED_FLEX_SR' };
    const LP_DELAYS = deps.lpDelays || [4000, 15000, 45000, 120000];
    let lpPending = null;
    async function rankedNow() {
        const s = await lcu.get('/lol-ranked/v1/current-ranked-stats').catch(() => null);
        const out = {};
        for (const e of C.lcuRankedToEntries(s)) out[e.queueType] = { tier: e.tier, rank: e.rank, lp: e.leaguePoints, wins: e.wins, losses: e.losses };
        return out;
    }
    const lpScore = x => (x ? LV.rankScore({ tier: x.tier, rank: x.rank, leaguePoints: x.lp }) : null);
    const lpGames = x => (x ? x.wins + x.losses : 0);
    function lpRecord(puuid, entry) {
        const key = 'lp:' + puuid, hit = cache.getMeta(key);
        const list = hit && Array.isArray(hit.data) ? hit.data : [];
        list.push(entry);
        cache.setMeta(key, list.slice(-400));
        cache.setMeta('lp-last', puuid);
        push('profile:update', { kind: 'lp', entry });
    }
    async function lpBefore(queueId) {
        const queue = RANKED_Q[queueId];
        if (!queue) { lpPending = null; return; }
        const me = await getMe();
        if (!me || !me.lcuPuuid) return;
        lpPending = { at: Date.now(), queue, puuid: me.lcuPuuid, before: (await rankedNow())[queue] || null };
    }
    async function lpAfter(dodge) {
        const p = lpPending;
        if (!p || p.checking) return;   // WaitingForStats / PreEndOfGame / EndOfGame all arrive: check once
        p.checking = true;
        for (const wait of dodge ? LP_DELAYS.slice(0, 2) : LP_DELAYS) {
            await sleep(wait);
            if (lpPending !== p) return;
            const a = (await rankedNow())[p.queue];
            if (!a) continue;
            const strip = x => x && { tier: x.tier, rank: x.rank, lp: x.lp };
            if (dodge) {
                if (p.before && lpGames(a) === lpGames(p.before) && lpScore(a) !== lpScore(p.before)) { lpRecord(p.puuid, { at: Date.now(), q: p.queue, dodge: true, before: strip(p.before), after: strip(a), delta: lpScore(a) - lpScore(p.before) }); break; }
                continue;
            }
            if (p.before && lpGames(a) === lpGames(p.before)) continue;   // the result is not counted yet
            lpRecord(p.puuid, { at: Date.now(), q: p.queue, win: p.before ? a.wins > p.before.wins : null, before: strip(p.before), after: strip(a), delta: p.before ? lpScore(a) - lpScore(p.before) : null });
            break;
        }
        if (lpPending === p) lpPending = null;
    }
    const lpListOf = puuid => { const h = puuid ? cache.getMeta('lp:' + puuid) : null; return h && Array.isArray(h.data) ? h.data : []; };
    handle('lp-history', async () => {
        const me = await getMe();
        const last = cache.getMeta('lp-last');
        const puuid = (me && me.lcuPuuid) || (last && last.data) || null;
        return { ok: true, list: lpListOf(puuid), lcu: !!me, current: me ? await rankedNow() : null };
    });

    // ---------- today's session: your games since midnight from the client's own match history (all queues) + LP ----------
    handle('session', async () => {
        const me = await getMe();
        const day = new Date(); day.setHours(0, 0, 0, 0);
        const since = day.getTime(), out = { ok: true, lcu: !!me, since, games: [], w: 0, l: 0, lp: {} };
        if (!me) return out;
        const [summoner, page] = await Promise.all([lcu.get('/lol-summoner/v1/current-summoner'), lcu.get('/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=20')]);
        const list = page && page.games && Array.isArray(page.games.games) ? page.games.games : [];
        for (const g of list) {
            if (!g || !(g.gameCreation >= since) || (typeof g.gameDuration === 'number' && g.gameDuration < 300)) continue;
            if (C.isExcludedFromAll(g.queueId, g.gameMode)) continue;   // Arena and the other non-5v5 modes are not part of the W / L counter
            const p = lcuHistory.findLocalParticipant(g, summoner);
            if (!p || !p.stats || typeof p.stats.win !== 'boolean') continue;
            out.games.push({ id: g.gameId, q: g.queueId, champId: p.championId, win: p.stats.win, k: p.stats.kills || 0, d: p.stats.deaths || 0, a: p.stats.assists || 0, at: g.gameCreation, dur: g.gameDuration || 0 });
            if (p.stats.win) out.w++; else out.l++;
        }
        out.games.sort((x, y) => y.at - x.at);
        for (const e of lpListOf(me.lcuPuuid)) if (e.at >= since && typeof e.delta === 'number') out.lp[e.q] = (out.lp[e.q] || 0) + e.delta;
        return out;
    });

    const poller = createPhasePoller(lcu, async (prev, next) => {
        meCache.at = 0;
        const active = ACTIVE_PHASES.has(next);
        // every phase change, with the queue (for "Follow my game": champ select / game / end -> the matching view)
        let queueId = null;
        if (next === 'ChampSelect' || active) {
            const fs = await lcu.get('/lol-gameflow/v1/session').catch(() => null);
            queueId = fs && fs.gameData && fs.gameData.queue && typeof fs.gameData.queue.id === 'number' ? fs.gameData.queue.id : null;
        }
        push('profile:phase', { prev, next, queueId });
        if (next === 'ChampSelect' || (active && !lpPending)) lpBefore(queueId).catch(() => {});
        else if (prev === 'ChampSelect' && !active && lpPending) lpAfter(true).catch(() => {});   // left champion select: dodge?
        if ((next === 'EndOfGame' || next === 'PreEndOfGame' || next === 'WaitingForStats') && lpPending) lpAfter(false).catch(() => {});
        if (active) {
            wasInGame = true;
            const s = await lcuRoster().catch(() => null);
            if (s && s.gameId) lastGame = { gameId: s.gameId, queueId: s.queueId != null ? s.queueId : queueId };
            push('profile:live', { active: true, phase: next, gameId: s ? s.gameId : null, queueId: s ? s.queueId : null });
        } else {
            if (ACTIVE_PHASES.has(prev)) push('profile:live', { active: false, phase: next });
            if (wasInGame && next !== null) { wasInGame = false; const g = lastGame || {}; lastGame = null; scheduleAutoRefresh(g); }
        }
    }, deps.pollMs || 5000);
    if (!deps.noPoll) poller.start(deps.pollStartDelay == null ? 2000 : deps.pollStartDelay);

    return { cache, riot, lcu, poller, refreshOwner, flush: () => cache.flush() };
}

// Call when the Riot API key changes (a key from another project encrypts puuids differently): forgets the cached
// accounts and per-puuid parts (acct:, sum:, lg:, ms:, mc:) but keeps the downloaded matches and ledgers.
function onRiotKeyChanged() {
    if (!activeCache) return 0;
    return activeCache.dropMeta(k => /^(acct|sum|lg|ms|mc):/.test(k));
}
// Write the pending cache documents to disk (call before quitting).
function flush() { if (activeCache) activeCache.flush(); }

module.exports = { register, onRiotKeyChanged, flush };
