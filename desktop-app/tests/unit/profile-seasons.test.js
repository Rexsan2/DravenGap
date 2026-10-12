// Agent G tests: op.gg parser, snapshots, merge/sort, op.gg failure fallback, emblem cache, IPC validation.
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { APP, scratch } = require('../lib/common');
const OG = require('../lib/opgg-fixture');
const SE = require(APP + 'profile-seasons'), EM = require(APP + 'profile-emblems');
const { start } = require('../lib/riot-stub');
const html = OG.page({ opuid: 'OPGG'.padEnd(80, 'z') });

(async () => {
    // ---- parser
    const p = SE.parseOpgg(html);
    assert(p.ok && p.solo.length === 5 && p.flex.length === 4, 'counts ' + p.solo.length + '/' + p.flex.length);
    assert.deepStrictEqual(p.solo[0], { season: 'S2025', end: { tier: 'EMERALD', rank: 'I', lp: 75 }, peak: { tier: 'DIAMOND', rank: 'IV', lp: 91 } });
    assert.strictEqual(p.flex[1].season, 'S2024 S3');
    assert(!SE.parseOpgg('<html>' + 'x'.repeat(2000) + '</html>').ok, 'no rsc');
    assert(!SE.parseOpgg(null).ok);
    console.log('parser ok');

    // ---- sorting / labels
    assert(SE.seasonSort('S2024 S3') > SE.seasonSort('S2024 S1'));
    assert(SE.seasonSort('S2025') > SE.seasonSort('S2024 S3'));
    assert(SE.seasonSort('S13') < SE.seasonSort('S2024 S1') && SE.seasonSort('S13') > SE.seasonSort('S12'));
    assert.strictEqual(SE.seasonYear('S13'), 2023); assert.strictEqual(SE.seasonYear('S2021 '), 2021);

    // ---- merge
    const now = Date.UTC(2026, 9, 5);
    let m = SE.mergeSeasons({ opgg: p, now });
    const solo = m.seasons.filter(x => x.queue === SE.SOLO).map(x => x.season);
    assert.deepStrictEqual(solo, ['S2025', 'S2023 S2', 'S2023 S1', 'S2022', 'S2021']);
    assert.deepStrictEqual(m.seasons.filter(x => x.queue === SE.FLEX).map(x => x.season), ['S2025', 'S2024 S3', 'S2024 S1', 'S2023 S2']);
    assert.strictEqual(m.peak[SE.SOLO].tier, 'MASTER'); assert.strictEqual(m.peak[SE.FLEX].tier, 'DIAMOND');
    // client + recorded when op.gg has nothing
    const lcu = SE.lcuPrevSeasons({ queues: [{ queueType: SE.SOLO, previousSeasonEndTier: 'PLATINUM', previousSeasonEndDivision: 'II', highestPreviousSeasonEndTier: 'DIAMOND', highestPreviousSeasonEndDivision: 'IV' }, { queueType: SE.FLEX, previousSeasonEndTier: 'NONE', previousSeasonEndDivision: 'NA' }] });
    assert.deepStrictEqual(lcu[SE.SOLO].end, { tier: 'PLATINUM', rank: 'II', lp: null }); assert(!lcu[SE.FLEX]);
    assert.strictEqual(SE.lcuPrevSeasons({ queues: [] }), null);
    const snaps = [{ q: SE.SOLO, s: 'S2025', t: 'GOLD', r: 'I', lp: 10, w: 1, l: 1, d: '2025-11-01' }, { q: SE.SOLO, s: 'S2025', t: 'GOLD', r: 'I', lp: 50, w: 9, l: 5, d: '2025-12-01' }, { q: SE.SOLO, s: 'S2026', t: 'EMERALD', r: 'II', lp: 5, w: 2, l: 1, d: '2026-09-30' }];
    m = SE.mergeSeasons({ opgg: null, lcuPrev: lcu, snaps, now });
    assert.deepStrictEqual(m.seasons.map(x => x.source + ':' + x.season + ':' + x.tier), ['recorded:S2025:GOLD', 'client:Last season:PLATINUM']);
    assert.strictEqual(m.seasons[0].lp, 50); assert.strictEqual(m.peak[SE.SOLO].tier, 'DIAMOND'); assert.strictEqual(m.recorded.length, 1);
    // recorded year already on op.gg is not repeated
    m = SE.mergeSeasons({ opgg: p, lcuPrev: lcu, snaps, now });
    assert(!m.seasons.some(x => x.source !== 'opgg'), 'op.gg wins');
    console.log('merge ok');

    // ---- snapshots
    const doc = {};
    const e1 = [{ queueType: SE.SOLO, tier: 'GOLD', rank: 'II', leaguePoints: 40, wins: 10, losses: 9 }, { queueType: 'RANKED_TFT', tier: 'GOLD' }];
    assert(SE.recordSnapshots(doc, e1, Date.UTC(2026, 3, 1, 10)) && doc.snaps.length === 1);
    assert(!SE.recordSnapshots(doc, e1, Date.UTC(2026, 3, 2)), 'identical -> no new snapshot'); assert.strictEqual(doc.snaps.length, 1);
    e1[0].leaguePoints = 55; e1[0].wins = 11;
    assert(SE.recordSnapshots(doc, e1, Date.UTC(2026, 3, 1, 20)) && doc.snaps.length === 1 && doc.snaps[0].lp === 55, 'same day replaces');
    e1[0].leaguePoints = 70;
    SE.recordSnapshots(doc, e1, Date.UTC(2026, 3, 3)); assert.strictEqual(doc.snaps.length, 2);
    assert.strictEqual(doc.snaps[0].s, 'S2026');
    console.log('snapshots ok');

    // ---- IPC end to end
    const S = await start();
    const hits = { opgg: [], cd: [] };
    let opggMode = 'ok';
    const web = http.createServer((req, res) => {
        if (req.url.startsWith('/lol/summoners/')) {
            hits.opgg.push(req.url);
            if (opggMode === '403' || req.url.includes('Blocked')) { res.writeHead(403); return res.end('Forbidden'); }
            res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html);
        }
        hits.cd.push(req.url);
        if (/\.svg$/.test(req.url)) { res.writeHead(200); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>' + ' '.repeat(80)); }
        if (/\.png$/.test(req.url)) { res.writeHead(200); return res.end(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)])); }
        res.writeHead(404); res.end();
    });
    await new Promise(r => web.listen(0, '127.0.0.1', r));
    const wport = web.address().port;
    const dir = scratch('pg');
    const handlers = {};
    const rh = require(APP + 'riot-history');
    const lcuStats = { queues: [{ queueType: SE.SOLO, tier: 'EMERALD', division: 'II', leaguePoints: 61, wins: 121, losses: 101, previousSeasonEndTier: 'GOLD', previousSeasonEndDivision: 'I' }, { queueType: SE.FLEX, tier: 'NONE', division: 'NA' }] };
    const lcuRequest = async pth => {
        if (pth === '/lol-summoner/v1/current-summoner') return { gameName: 'TestOwner', tagLine: 'META', puuid: 'lcu-puuid', profileIconId: 1, summonerLevel: 300 };
        if (pth === '/riotclient/get_region_locale') return { region: 'EUW' };
        if (pth.startsWith('/lol-ranked/v1/ranked-stats/')) return lcuStats;
        return null;
    };
    require(APP + 'profile-main').register({ ipcMain: { handle: (c, f) => handlers[c] = f }, userDataPath: dir, getRiotApiKey: () => 'ok', getLeagueCredentials: async () => ({ port: 1, password: 'x' }), lcuRequest,
        sendToWindow: () => {}, riotBaseUrl: () => 'http://127.0.0.1:' + S.port, noPoll: true, limiter: new rh.RateLimiter(), queuesUrl: 'http://127.0.0.1:1/x',
        opggOrigin: 'http://127.0.0.1:' + wport, opggMinGapMs: 10, emblemBaseUrl: 'http://127.0.0.1:' + wport });
    const call = (n, a) => handlers['profile:' + n]({}, a);

    // owner lookup records a snapshot and the LCU previous season
    let r = await call('lookup', { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' });
    assert(r.ok && r.profile.isOwner && r.profile.ranked[0].source === 'lcu', JSON.stringify(r).slice(0, 200));
    const puuid = r.profile.puuid;
    r = await call('seasons', { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1', puuid });
    assert(r.ok && r.opgg.ok && !r.opgg.cached && r.seasons.length === 9, JSON.stringify(r).slice(0, 300));
    assert.strictEqual(hits.opgg.length, 1); assert(/\/lol\/summoners\/euw\/TestOwner-META$/.test(hits.opgg[0]), hits.opgg[0]);
    assert.strictEqual(r.recorded.length, 1, 'snapshot recorded by lookup'); assert.strictEqual(r.recorded[0].tier, 'EMERALD');
    assert(!r.seasons.some(x => x.source === 'client'), 'op.gg wins over client');
    r = await call('seasons', { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1', puuid, force: true });
    assert(r.opgg.ok && r.opgg.cached && hits.opgg.length === 1, 'cache hit, no second request'); console.log('opgg fetch + cache ok');

    // blocked player: soft failure, back-off, still recorded/other sources
    r = await call('seasons', { gameName: 'Blocked', tagLine: 'EUW', platform: 'EUW1' });
    assert(r.ok && !r.opgg.ok && /403/.test(r.opgg.error) && r.seasons.length === 0, JSON.stringify(r)); const n = hits.opgg.length;
    r = await call('seasons', { gameName: 'Blocked', tagLine: 'EUW', platform: 'EUW1' });
    assert(!r.opgg.ok && r.opgg.backoff && hits.opgg.length === n, 'back-off: no new request');
    // owner while op.gg is down for them: client + recorded still render
    opggMode = '403';
    r = await call('seasons', { gameName: 'Zed', tagLine: 'EUW', platform: 'EUW1' }); assert(!r.opgg.ok);
    console.log('403 fallback ok');
    // validation
    for (const bad of [{ gameName: 'a', tagLine: 'b', platform: 'XX9' }, { gameName: '', tagLine: 'b', platform: 'EUW1' }, { gameName: 'x'.repeat(60), tagLine: 'b', platform: 'EUW1' }]) {
        const x = await call('seasons', bad); assert(!x.ok && /BAD_/.test(x.code), JSON.stringify(x));
    }
    r = await call('seasons', { gameName: 'a/../b?x=1', tagLine: 'EUW', platform: 'EUW1' });
    assert(hits.opgg.every(u => u.split('/').length === 5 && !u.includes('?')), 'name is URL-encoded: ' + hits.opgg.join(','));
    console.log('validation ok');

    // emblems
    r = await call('emblems', { tiers: ['gold', 'EMERALD', 'UNRANKED', '../../etc', 'http://x', 42], size: 'mini' });
    assert(r.ok && Object.keys(r.emblems).sort().join() === 'EMERALD,GOLD,UNRANKED' && r.emblems.GOLD.startsWith('data:image/svg+xml;base64,'), JSON.stringify(Object.keys(r.emblems)));
    const c0 = hits.cd.length;
    r = await call('emblems', { tiers: ['GOLD', 'EMERALD'], size: 'mini' }); assert.strictEqual(hits.cd.length, c0, 'memory cache');
    r = await call('emblems', { tiers: ['GOLD', 'UNRANKED'], size: 'big' });
    assert(r.emblems.GOLD.startsWith('data:image/png;base64,') && r.emblems.UNRANKED.startsWith('data:image/svg+xml'), 'big uses png, unranked falls to svg');
    assert(hits.cd.includes('/ranked-emblem/emblem-gold.png') && !hits.cd.some(u => /unranked.png|emblem-unranked/.test(u)));
    assert(fs.existsSync(path.join(dir, 'profile-cache', 'emblems', 'big-gold.png')), 'on disk');
    // fresh instance reads from disk
    const nSrv = hits.cd.length;
    const em2 = EM.createEmblems({ dir: path.join(dir, 'profile-cache', 'emblems'), baseUrl: 'http://127.0.0.1:1' });
    const o = await em2.getMany(['GOLD'], 'big'); assert(o.GOLD && hits.cd.length === nSrv, 'disk cache after restart');
    const bad = await em2.getMany(['SILVER'], 'big'); assert(!bad.SILVER, 'unreachable -> omitted, no throw');
    console.log('emblems ok');
    web.close(); S.srv && S.srv.close && S.srv.close();
    console.log('ALL G TESTS PASSED');
    process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
