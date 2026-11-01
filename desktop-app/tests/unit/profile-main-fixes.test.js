// Code-review fixes in profile-main.js / profile-lcu.js / profile-compact.js (fixer P2, 2026-11-01):
//   B2-F4  the keyless client import never overwrites a match already downloaded from Riot
//   V3-M1  keyless first, then a key: the client-puuid player is carried over and the client copies Riot serves are healed
//   B2-F6  a key from another project: the old player (ledger, client games, season snapshots) is carried over on the next lookup
//   B2-F5  "Clear look-ups" keeps the LP history        D2-F3  duo / group history match a renamed partner by puuid
//   B2-F7  meta.json drops old op.gg / live entries     B2-F8  "Load season history" asks for this season only
//   B2-F9  the ARAM Mayhem tab never asks Riot          B2-F12 a failed league part is reported (partial), not "Unranked"
//   B2-F13 the post-game refresh waits for the match file  V3-M2 a Mayhem game does not cancel the ranked refresh
//   B2-F11 a rejected key is pushed once                B2-F1  a Mayhem game survives a moment without the client's region
//   B2-F16 LCU credential lookups are shared and time out  B2-F15 LA1 / OC1 style region codes and the platformId fallback
const assert = require('assert'); const fs = require('fs'); const path = require('path'); const http = require('http');
const { APP, scratch, sleep, waitFor } = require('../lib/common');
const RS = require('../lib/riot-stub');
const rh = require(APP + 'riot-history');
const C = require(APP + 'profile-compact');
const pm = require(APP + 'profile-main');
const { PLATFORMS } = require(APP + 'profile-riot');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };

const pu = tag => ('P' + tag).padEnd(78, 'x');
const LCU = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';   // the client's own puuid is a UUID

// a finished game as the client's /lol-match-history/v1/games/{id} returns it (match-v4 shape): 10 players, the owner first
function lcuGame(gameId, queueId, ownerWins, endAgoMin = 20, ownerLcu = LCU) {
    const participants = [], participantIdentities = [];
    for (let k = 0; k < 10; k++) {
        const teamId = k < 5 ? 100 : 200, win = (teamId === 100) === ownerWins;
        participants.push({ participantId: k + 1, teamId, championId: k === 0 ? 17 : 30 + k, spell1Id: 4, spell2Id: 32,
            stats: { win, kills: 3, deaths: 4, assists: 6, champLevel: 18, totalDamageDealtToChampions: 30000, totalDamageTaken: 25000, goldEarned: 13000, totalMinionsKilled: 40, visionScore: 5, item0: 3020 } });
        participantIdentities.push({ participantId: k + 1, player: k === 0 ? { puuid: ownerLcu, gameName: 'TestOwner', tagLine: 'META' } : { puuid: 'lcu-' + k, gameName: 'Mate' + k, tagLine: 'EUW' } });
    }
    return { gameId, queueId, gameMode: queueId === 2400 ? 'KIWI' : 'CLASSIC', gameDuration: 1080, gameCreation: Date.now() - (endAgoMin + 18) * 60e3, gameVersion: '16.20.1.1', platformId: 'EUW1',
        participants, participantIdentities, teams: [{ teamId: 100, win: ownerWins ? 'Win' : 'Fail' }, { teamId: 200, win: ownerWins ? 'Fail' : 'Win' }] };
}
// a match-v5 game of the owner `me` (riot-stub's shape: the owner is TestOwner#META, TOP, team 100)
const mk = (gameId, me, end, q = 420) => { const r = RS.match(0, me); r.metadata.matchId = 'EUW1_' + gameId; r.info.gameId = gameId; r.info.gameEndTimestamp = end; r.info.queueId = q; return r; };

// A Riot stub whose ids, matches, failures and accounts each test sets up itself
function flexStub() {
    const st = { key: 'ok', log: [], ids: [], matches: new Map(), fail404: new Map(), league500: false, honorStart: true, accounts: {}, byPuuid: {}, decrypt: new Set() };
    const srv = http.createServer((req, res) => {
        const u = req.url; st.log.push(u);
        const send = (c, b) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
        if (req.headers['x-riot-token'] !== st.key) return send(403, { status: { message: 'Forbidden', status_code: 403 } });
        for (const p of st.decrypt) if (u.includes(p)) return send(400, { status: { message: 'Exception decrypting ' + p, status_code: 400 } });
        let m;
        if ((m = u.match(/by-riot-id\/([^/]+)\/([^/?]+)/))) { const nm = decodeURIComponent(m[1]), a = st.accounts[nm.toLowerCase()]; return a ? send(200, { puuid: a, gameName: nm, tagLine: decodeURIComponent(m[2]) }) : send(404, {}); }
        if ((m = u.match(/\/accounts\/by-puuid\/([^/?]+)$/))) { const a = st.byPuuid[decodeURIComponent(m[1])]; return a ? send(200, a) : send(404, {}); }
        if (u.includes('/summoner/v4/')) return send(200, { profileIconId: 1, summonerLevel: 30 });
        if (u.includes('/league/v4/')) return st.league500 ? send(500, {}) : send(200, [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', leaguePoints: 40, wins: 10, losses: 9 }]);
        if (u.includes('/top?')) return send(200, []);
        if ((m = u.match(/ids\?start=(\d+)&count=(\d+)(.*)$/))) {
            const since = (m[3].match(/startTime=(\d+)/) || [])[1];
            let ids = st.ids.slice();
            if (since && st.honorStart) ids = ids.filter(id => { const r = st.matches.get(id); return r && r.info.gameEndTimestamp >= +since * 1000; });
            return send(200, ids.slice(+m[1], +m[1] + +m[2]));
        }
        if ((m = u.match(/matches\/([A-Z0-9]+_\d+)$/))) {
            const left = st.fail404.get(m[1]) || 0;
            if (left > 0) { st.fail404.set(m[1], left - 1); return send(404, {}); }
            const raw = st.matches.get(m[1]); return raw ? send(200, raw) : send(404, {});
        }
        send(404, {});
    });
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, st, port: srv.address().port })));
}
function reg(port, extra = {}) {
    const handlers = {}, pushes = [], dir = extra.dir || scratch('pmfix');
    const ctl = pm.register({ ipcMain: { handle: (c, f) => handlers[c] = f }, userDataPath: dir, getRiotApiKey: () => 'ok', getLeagueCredentials: async () => { throw new Error('none'); }, lcuRequest: async () => null,
        sendToWindow: (c, p) => pushes.push([c, p]), riotBaseUrl: () => 'http://127.0.0.1:' + port, noPoll: true, queuesUrl: 'http://127.0.0.1:1/x', cdQueuesUrl: 'http://127.0.0.1:1/y', limiter: new rh.RateLimiter(), ...extra });
    return { call: (c, a) => handlers['profile:' + c]({}, a), pushes, ctl, dir };
}
const ME = { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' };
// the client: TestOwner#META on EUW with its puuid LCU, and a history of `hist` (gameId -> queue)
const clientLcu = (hist, o = {}) => async p => {
    if (p === '/lol-summoner/v1/current-summoner') return { gameName: 'TestOwner', tagLine: 'META', puuid: LCU, summonerLevel: 5, profileIconId: 1 };
    if (p === '/riotclient/get_region_locale') return { region: o.region || 'EUW' };
    if (p.startsWith('/lol-match-history/v1/products/lol/current-summoner/matches')) return { platformId: o.platformId, games: { games: Object.keys(hist).map(id => ({ gameId: +id })) } };
    const m = p.match(/\/lol-match-history\/v1\/games\/(\d+)$/);
    if (m && hist[m[1]]) return lcuGame(+m[1], hist[m[1]], true);
    return null;
};

(async () => {
    // ---------- B2-F4: no key, client running: a game already downloaded from Riot keeps Riot's version
    {
        const S = await RS.start(); let key = 'ok';
        const R = reg(S.port, { riotBaseUrl: () => 'http://127.0.0.1:' + S.port, getRiotApiKey: () => key, getLeagueCredentials: async () => ({ port: 1 }), lcuRequest: clientLcu({ 9000: 420, 7777: 2400 }) });
        const api = (await R.call('lookup', ME)).profile.puuid;
        await R.call('matches', { puuid: api, platform: 'EUW1', group: 'all' });
        ok((await R.ctl.cache.getMatch('EUW1_9000')).info.participants[0].teamPosition === 'TOP', 'Riot version cached');
        key = null;   // Settings > Remove key
        const r = await R.call('matches', { puuid: api, platform: 'EUW1', group: 'all' });
        const raw = await R.ctl.cache.getMatch('EUW1_9000');
        ok(r.ok && r.keyless && raw.metadata.src === undefined && raw.info.participants[0].teamPosition === 'TOP', 'the client import left the Riot file alone: ' + JSON.stringify(raw.metadata));
        ok(r.matches.some(m => m.id === 'EUW1_9000' && !m.src) && r.matches.some(m => m.id === 'EUW1_7777' && m.src === 'lcu'), 'keyless list: the Riot game (listed from the cache) and the client-only game');
        const row = (await R.call('ledger', { puuid: api })).rows.find(x => x.id === 'EUW1_9000');
        ok(row && row.pos === 'TOP' && !row.src, 'ledger row keeps its lane: ' + JSON.stringify(row));
        S.srv.close(); console.log('B2-F4 keyless import keeps Riot matches ok');
    }

    // ---------- V3-M1 + B2-F9: keyless first run, then a key
    {
        const S = await RS.start(); let key = null;
        const R = reg(S.port, { riotBaseUrl: () => 'http://127.0.0.1:' + S.port, getRiotApiKey: () => key, getLeagueCredentials: async () => ({ port: 1 }), lcuRequest: clientLcu({ 9000: 420, 7777: 2400 }) });
        let r = await R.call('lookup', ME);
        ok(r.ok && r.profile.keyless && r.profile.puuid === LCU, 'keyless: the player id is the client puuid');
        r = await R.call('matches', { puuid: LCU, platform: 'EUW1', group: 'all' });
        ok(r.matches.length === 2 && r.matches.every(m => m.src === 'lcu'), 'both games read from the client');
        key = 'ok';
        r = await R.call('lookup', ME);
        const api = r.profile.puuid;
        ok(r.ok && api === RS.puuidOf('TestOwner'), 'with the key: the API puuid');
        let rows = (await R.call('ledger', { puuid: api })).rows;
        ok(rows.some(x => x.id === 'EUW1_9000') && rows.some(x => x.id === 'EUW1_7777' && x.q === 2400), 'the client-puuid player was carried over: ' + rows.map(x => x.id).join(','));
        ok(R.ctl.cache.getMeta('puuid:' + LCU).data.movedTo === api, 'its Riot ID entry points at the new puuid (adopted once)');
        r = await R.call('matches', { puuid: api, platform: 'EUW1', group: 'all' });
        ok(r.matches.some(m => m.id === 'EUW1_7777' && m.src === 'lcu') && r.matches.some(m => m.id === 'EUW1_9000' && !m.src), 'match list: Mayhem game kept, ranked game now Riot\'s');
        const raw = await R.ctl.cache.getMatch('EUW1_9000');
        ok(!raw.metadata.src && raw.info.participants[0].teamPosition === 'TOP', 'the client copy of the ranked game was replaced by Riot\'s');
        rows = (await R.call('ledger', { puuid: api })).rows;
        const rk = rows.find(x => x.id === 'EUW1_9000');
        ok(rk && rk.pos === 'TOP' && !rk.src, 'and its ledger row gained the lane: ' + JSON.stringify(rk));
        // B2-F9: the ARAM Mayhem tab is the client's games only, without a Riot request, even with a rejected key
        let n0 = S.log.length;
        r = await R.call('matches', { puuid: api, platform: 'EUW1', group: 'mayhem' });
        ok(r.ok && r.matches.map(m => m.id).join() === 'EUW1_7777' && S.log.length === n0, 'Mayhem tab: client games, no Riot request: ' + S.log.slice(n0).join(' '));
        S.state.key = 'expired';
        r = await R.call('matches', { puuid: api, platform: 'EUW1', group: 'mayhem' });
        ok(r.ok && r.matches.length === 1, 'Mayhem tab still works with a rejected key: ' + JSON.stringify(r).slice(0, 120));
        S.srv.close(); console.log('V3-M1 keyless -> key adoption + heal ok; B2-F9 Mayhem tab ok');
    }

    const F = await flexStub();
    const seed = (owner, count, base = 9000) => { F.st.matches.clear(); F.st.ids = []; for (let i = 0; i < count; i++) { const id = 'EUW1_' + (base - i); F.st.ids.push(id); F.st.matches.set(id, mk(base - i, owner, Date.now() - (i + 1) * 3600e3)); } };

    // ---------- B2-F6: a key from another project; the next lookup carries the player over (and only when Riot can't decrypt the old id)
    {
        const OLD = pu('OLD'), NEW = pu('NEW');
        F.st.accounts.testowner = OLD; seed(OLD, 25);
        const R = reg(F.port);
        ok((await R.call('lookup', ME)).profile.puuid === OLD, 'first key: OLD');
        await R.call('matches', { puuid: OLD, platform: 'EUW1', group: 'all' });
        const od = R.ctl.cache.player(OLD);
        od.lcu = ['EUW1_8990']; od.snaps = [{ q: 'RANKED_SOLO_5x5', s: '2026', t: 'GOLD', r: 'I', lp: 10, w: 1, l: 1, d: '2026-10-01' }]; R.ctl.cache.savePlayer(OLD);
        R.ctl.cache.setMeta('owner-last', { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1', puuid: OLD });
        F.st.accounts.testowner = NEW; F.st.decrypt.add(OLD);
        pm.onRiotKeyChanged();
        ok((await R.call('lookup', ME)).profile.puuid === NEW, 'new key: NEW');
        const nd = R.ctl.cache.peekPlayer(NEW);
        ok((await R.call('ledger', { puuid: NEW })).rows.length >= 20, 'ledger carried over');
        ok(nd.lcu.includes('EUW1_8990') && nd.snaps.some(s => s.d === '2026-10-01' && s.t === 'GOLD'), 'client games and recorded season ranks carried over: ' + JSON.stringify([nd.lcu, nd.snaps]));
        ok(R.ctl.cache.getMeta('owner-last').data.puuid === NEW && R.ctl.cache.getMeta('puuid:' + OLD).data.movedTo === NEW, 'owner-last follows; the old id is marked moved');
        F.st.decrypt.clear();
        // the same Riot ID now belongs to another (valid) account: nothing is carried over
        const OLD2 = pu('OLD2'), OTHER = pu('OTHER');
        F.st.accounts.testowner = OLD2; seed(OLD2, 25);
        const R2 = reg(F.port);
        await R2.call('lookup', ME); await R2.call('matches', { puuid: OLD2, platform: 'EUW1', group: 'all' });
        F.st.accounts.testowner = OTHER; F.st.byPuuid[OLD2] = { puuid: OLD2, gameName: 'Renamed', tagLine: 'EUW' };
        pm.onRiotKeyChanged();
        ok((await R2.call('lookup', ME)).profile.puuid === OTHER, 'lookup: OTHER');
        const od2 = R2.ctl.cache.peekPlayer(OTHER), h2 = R2.ctl.cache.getMeta('puuid:' + OLD2).data;
        ok((!od2 || !Object.keys(od2.rows).length) && h2.gameName === 'Renamed' && !h2.movedTo, 'another account keeps its own games; the old id gets its new Riot ID');
        console.log('B2-F6 adoption on a project change ok');
    }

    // ---------- B2-F5: Clear look-ups keeps the LP history (and the client's previous-season ranks)
    {
        const R = reg(1);
        R.ctl.cache.setMeta('lp:abc', [{ at: Date.now(), q: 'RANKED_SOLO_5x5', win: true, delta: 21 }]); R.ctl.cache.setMeta('lp-last', 'abc');
        R.ctl.cache.setMeta('lcuprev:xyz', { s1: 'GOLD' }); R.ctl.cache.setMeta('sum:xyz', { summonerLevel: 1 });
        const r = await R.call('cache-clear', { what: 'lookups' });
        ok(r.ok && r.removed >= 1 && !R.ctl.cache.getMeta('sum:xyz'), 'look-ups cleared');
        ok((await R.call('lp-history', {})).list.length === 1 && R.ctl.cache.getMeta('lcuprev:xyz'), 'LP history and lcuprev kept');
        console.log('B2-F5 cache clear keeps LP ok');
    }

    // ---------- D2-F3: a partner who renamed: matched by puuid, like the Premades list
    {
        const S = await RS.start();
        const R = reg(S.port, { riotBaseUrl: () => 'http://127.0.0.1:' + S.port });
        const api = (await R.call('lookup', ME)).profile.puuid, doc = R.ctl.cache.player(api);
        for (let i = 100; i < 106; i++) {
            const raw = RS.match(i, api);
            if (i >= 103) raw.info.participants[1].riotIdGameName = 'Old';   // Alpha's older games, under the old name
            await R.ctl.cache.putMatch(raw.metadata.matchId, raw);
            doc.rows[raw.metadata.matchId] = C.ledgerRow(C.compactMatch(raw), api);
        }
        R.ctl.cache.savePlayer(api);
        const alpha = { gameName: 'Alpha', tagLine: 'EUW', puuid: RS.puuidOf('Alpha') };
        let r = await R.call('duo-history', { owner: { puuid: api }, partner: alpha });
        ok(r.ok && r.games === 6, 'duo-history counts the games before the rename: ' + r.games);
        r = await R.call('duo-history', { owner: { puuid: api }, partner: { gameName: 'Alpha', tagLine: 'EUW' } });
        ok(r.ok && r.games === 3, 'without the puuid: the current name only (as before)');
        r = await R.call('group-history', { owner: { puuid: api }, partners: [alpha] });
        ok(r.ok && r.games === 6, 'group-history too');
        r = await R.call('played', { puuid: api, platform: 'EUW1', group: 'all' });
        const a = r.list.find(x => x.puuid === alpha.puuid);
        ok(a && a.name === 'Alpha' && a.games === 6, 'and played (the Premades list) reports the same total');
        S.srv.close(); console.log('D2-F3 partner by puuid ok');
    }

    // ---------- B2-F7: meta.json drops old op.gg / live entries, caps the rest, keeps LP / Riot IDs / the owner's own entries
    {
        const dir = scratch('pmfix-prune'), now = Date.now(), old = now - 40 * 864e5, meta = {};
        for (let i = 0; i < 2000; i++) meta[`opchamps:EUW1:p${i}#x:SOLORANKED`] = { at: old, data: { rows: [] } };
        for (let i = 0; i < 60; i++) meta[`opgg:EUW1:f${i}#x`] = { at: now - i * 1000, data: {} };
        Object.assign(meta, { 'lp:abc': { at: old, data: [{ delta: 1 }] }, 'lp-last': { at: old, data: 'abc' }, ['puuid:' + pu('S')]: { at: old, data: { gameName: 'S', tagLine: 'X', platform: 'EUW1' } },
            'owner-last': { at: old, data: { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1', puuid: pu('OWN') } }, ['sum:' + pu('OWN')]: { at: old, data: {} }, ['mc:' + pu('OWN') + ':17']: { at: old, data: {} },
            ['sum:' + pu('S')]: { at: old, data: {} }, 'opgg-fail:c:x': { at: old, data: {} } });
        fs.mkdirSync(path.join(dir, 'profile-cache'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'profile-cache', 'meta.json'), JSON.stringify(meta));
        const R = reg(1, { dir, metaPruneMax: 50 });
        const g = k => R.ctl.cache.getMeta(k);
        ok(!g('opchamps:EUW1:p0#x:SOLORANKED') && !g('sum:' + pu('S')) && !g('opgg-fail:c:x'), 'old op.gg and stranger entries dropped');
        ok(g('opgg:EUW1:f0#x') && g('opgg:EUW1:f49#x') && !g('opgg:EUW1:f50#x'), 'fresh ones capped at the newest 50');
        ok(g('lp:abc') && g('lp-last') && g('puuid:' + pu('S')) && g('owner-last') && g('sum:' + pu('OWN')) && g('mc:' + pu('OWN') + ':17'), 'LP history, Riot IDs and the owner\'s entries kept');
        console.log('B2-F7 meta prune ok');
    }

    // ---------- B2-F8: "Load season history" asks Riot for this season only, and stops at the first old game otherwise
    {
        const since = C.seasonStart(), OWN = pu('BF');
        const build = () => { F.st.matches.clear(); F.st.ids = []; for (let i = 0; i < 100; i++) { const id = 'EUW1_' + (5000 - i), end = i < 30 ? Date.now() - (i + 1) * 3600e3 : since - (i - 29) * 3600e3; F.st.ids.push(id); F.st.matches.set(id, mk(5000 - i, OWN, end)); } };
        const oldReqs = from => F.st.log.slice(from).filter(u => { const m = u.match(/matches\/EUW1_(\d+)$/); return m && 5000 - +m[1] >= 30; }).length;
        const runBf = async () => { const R = reg(F.port); await R.call('backfill', { puuid: OWN, platform: 'EUW1', max: 100 }); await waitFor(() => R.pushes.some(p => p[1].kind === 'backfill' && p[1].state !== 'running'), 15000); return R; };
        build(); F.st.honorStart = true; let n0 = F.st.log.length;
        let R = await runBf();
        ok(F.st.log.slice(n0).some(u => u.includes('&startTime=' + Math.floor(since / 1000))), 'the id list asks for this season (startTime in seconds)');
        ok(oldReqs(n0) === 0 && (await R.call('ledger', { puuid: OWN })).rows.length === 30, 'no last-season match downloaded: ' + oldReqs(n0));
        F.st.honorStart = false; n0 = F.st.log.length;   // a list that still runs into last season: the run stops at the first old batch
        R = await runBf();
        ok(oldReqs(n0) <= 5, 'at most one batch of last-season games: ' + oldReqs(n0));
        F.st.honorStart = true; console.log('B2-F8 season backfill ok');
    }

    // ---------- B2-F12: only the league request fails -> partial.league, not a silent "Unranked"
    {
        F.st.accounts.testowner = pu('PART'); seed(pu('PART'), 5); F.st.league500 = true;
        const R = reg(F.port);
        const r = await R.call('lookup', ME);
        ok(r.ok && r.partial && r.partial.league && r.partial.league.code === 'HTTP' && r.profile.ranked.length === 0 && r.profile.summonerLevel === 30, JSON.stringify(r).slice(0, 300));
        F.st.league500 = false;
        const r2 = await R.call('lookup', { ...ME, force: true });
        ok(r2.ok && !r2.partial && r2.profile.ranked.length === 1, 'the next lookup has the rank and no partial');
        console.log('B2-F12 partial league ok');
    }

    // ---------- post-game: B2-F13, V3-M2, B2-F1, B2-F11 (phase poller, the client and the flex stub)
    {
        const OWN = pu('PG'); F.st.accounts.testowner = OWN; seed(OWN, 20);
        for (const id of [9001, 9002, 9003, 9004]) F.st.matches.set('EUW1_' + id, mk(id, OWN, Date.now()));
        let phase = 'None', game = null, regionDown = false, regionMisses = 0;
        const lcuRequest = async p => {
            if (p.includes('gameflow-phase')) return phase;
            if (p.includes('/lol-gameflow/v1/session')) return game ? { phase, gameData: { gameId: game.id, queue: { id: game.q }, teamOne: [{ puuid: LCU, gameName: 'TestOwner', tagLine: 'META', championId: 17 }], teamTwo: [] } } : null;
            if (p === '/lol-summoner/v1/current-summoner') return { gameName: 'TestOwner', tagLine: 'META', puuid: LCU, summonerLevel: 5, profileIconId: 1 };
            if (p === '/riotclient/get_region_locale') { if (regionDown) { regionMisses++; return null; } return { region: 'EUW' }; }
            const m = p.match(/\/lol-match-history\/v1\/games\/(\d+)$/);
            if (m) return lcuGame(+m[1], 2400, true, 2);
            return null;
        };
        const dir = scratch('pmfix-pg');
        fs.writeFileSync(path.join(dir, 'personal-history.json'), JSON.stringify({}));
        const R = reg(F.port, { dir, noPoll: false, getLeagueCredentials: async () => ({ port: 1 }), lcuRequest, pollMs: 80, pollStartDelay: 30,
            autoRefreshDelays: [200, 400, 400, 400, 400, 400], clientGameDelays: [100, 150, 150] });
        await sleep(200);
        await R.call('lookup', ME); await R.call('matches', { puuid: OWN, platform: 'EUW1', group: 'all' });
        const endGame = async (id, q) => { game = { id, q }; phase = 'InProgress'; await sleep(300); phase = 'EndOfGame'; await sleep(150); phase = 'None'; await sleep(120); };
        const owned = () => R.pushes.filter(p => p[0] === 'profile:update' && p[1].kind === 'matches' && p[1].owner && !p[1].src);

        // B2-F13: the id is listed before Riot serves the match: the refresh goes on until the file is there
        F.st.ids.unshift('EUW1_9001'); F.st.fail404.set('EUW1_9001', 1); R.pushes.length = 0;
        await endGame(9001, 420);
        await waitFor(() => owned().some(p => p[1].ids.includes('EUW1_9001')), 4000);
        await sleep(500);
        ok(owned().length === 1 && owned()[0][1].added === 1 && R.ctl.cache.hasMatch('EUW1_9001'), 'one push, once the match was downloaded: ' + JSON.stringify(owned().map(p => p[1].ids)));
        console.log('B2-F13 refresh waits for the match file ok');

        // V3-M2: a ranked game Riot is slow to list, then an ARAM Mayhem game: the ranked refresh keeps going
        R.pushes.length = 0;
        await endGame(9002, 420);
        await endGame(7777, 2400);
        await waitFor(() => R.pushes.some(p => p[1] && p[1].src === 'lcu' && p[1].ids[0] === 'EUW1_7777'), 4000);
        F.st.ids.unshift('EUW1_9002');   // Riot lists the ranked game only now
        await waitFor(() => owned().some(p => p[1].ids.includes('EUW1_9002')), 4000);
        ok(true, 'the ranked game still arrived after the Mayhem game');
        console.log('V3-M2 Mayhem does not cancel the ranked refresh ok');

        // B2-F1: the client's region can't be read right after a Mayhem game: the game is still recorded
        R.pushes.length = 0; game = { id: 7778, q: 2400 }; phase = 'InProgress'; await sleep(300);
        regionDown = true; regionMisses = 0; phase = 'EndOfGame'; await sleep(150); phase = 'None';
        await waitFor(() => regionMisses >= 1, 3000);
        regionDown = false;
        await waitFor(() => R.pushes.some(p => p[1] && p[1].src === 'lcu' && p[1].ids[0] === 'EUW1_7778'), 4000);
        ok(R.ctl.cache.peekPlayer(OWN).lcu.includes('EUW1_7778'), 'the Mayhem game is in the lcu list');
        console.log('B2-F1 Mayhem survives a region glitch ok');

        // B2-F11: the key is rejected: one key-rejected push, not one per game
        F.st.key = 'expired'; R.pushes.length = 0;
        await endGame(9003, 420); await sleep(400);
        await endGame(9004, 420); await sleep(500);
        const kr = R.pushes.filter(p => p[1] && p[1].kind === 'key-rejected');
        ok(kr.length === 1 && kr[0][1].owner === true, 'one key-rejected push: ' + kr.length);
        F.st.key = 'ok'; console.log('B2-F11 key-rejected push ok');
    }

    // ---------- B2-F16: credential lookups are shared and time out
    {
        const { createLcu, createPhasePoller } = require(APP + 'profile-lcu');
        let calls = 0;
        const hung = createLcu({ getLeagueCredentials: () => { calls++; return new Promise(() => {}); }, lcuRequest: async () => 'Lobby', credTimeoutMs: 300 });
        const t0 = Date.now();
        const rs = await Promise.all([hung.get('/a'), hung.get('/b'), hung.get('/c')]);
        ok(calls === 1 && rs.every(x => x === null) && Date.now() - t0 < 1500, 'one shared lookup, given up after the timeout: ' + calls + ' calls, ' + (Date.now() - t0) + ' ms');
        let changes = 0;
        const poller = createPhasePoller(createLcu({ getLeagueCredentials: () => new Promise(() => {}), lcuRequest: async () => 'Lobby', credTimeoutMs: 200 }), () => { changes++; });
        ok(await Promise.race([poller.tick().then(() => 'done'), sleep(2000).then(() => 'stuck')]) === 'done', 'a hung lookup does not stop the phase poller');
        calls = 0;
        const good = createLcu({ getLeagueCredentials: async () => { calls++; await sleep(50); return { port: 1 }; }, lcuRequest: async () => 'Lobby' });
        const rs2 = await Promise.all([good.get('/a'), good.get('/b')]);
        ok(calls === 1 && rs2.every(x => x === 'Lobby') && good.isUp(), 'concurrent callers share one lookup');
        console.log('B2-F16 credential lookups ok');
    }

    // ---------- B2-F15: platform-style region codes, and the match history's platformId when the region is unknown
    {
        for (const p of PLATFORMS) assert.strictEqual(C.LCU_REGION_TO_PLATFORM[p], p, 'alias ' + p);
        ok(C.LCU_REGION_TO_PLATFORM.ME === 'ME1' && C.LCU_REGION_TO_PLATFORM.LAN === 'LA1', 'every platform id maps to itself (plus ME)');
        for (const [region, platformId, want] of [['LA1', undefined, 'LA1'], ['OC1', undefined, 'OC1'], ['XX', 'LA2', 'LA2'], ['XX', undefined, null]]) {
            const R = reg(1, { getLeagueCredentials: async () => ({ port: 1 }), lcuRequest: clientLcu({}, { region, platformId }) });
            const r = await R.call('me', {});
            ok(r.ok && r.me && r.me.platform === want, `region ${region} / platformId ${platformId} -> ${r.me && r.me.platform}`);
        }
        console.log('B2-F15 region codes ok');
    }

    F.srv.close();
    console.log('ALL OK', n, 'checks'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
