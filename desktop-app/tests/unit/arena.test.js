// Arena mode (arena-parsers.js, arena-main.js): the LoLalytics Arena pages saved once in tests/fixtures/arena, the arena:* handlers
// with a stub fetch (no network) and a scratch cache folder, and the champion-select reading (your champion, your partner, taken /
// banned champions; a whole-lobby myTeam with subteams).
const assert = require('assert');
const fs = require('fs'), path = require('path');
const { APP, fixture, scratch } = require('../lib/common');
const P = require(APP + 'arena-parsers');
const AM = require(APP + 'arena-main');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };

// ---- parsers
const tAll = P.parseTierList(fixture('arena/tier_all.html')), tEm = P.parseTierList(fixture('arena/tier_emerald.html'));
ok(tAll.champions.length === 173 && tAll.bracket === 'all' && tEm.bracket === 'emerald_plus' && tAll.queue === 1750 && tAll.patch === '16.20', 'tier lists: 173 champions, both brackets, queue 1750');
ok(tAll.champions.every((c, i) => Number.isInteger(c.cid) && c.slug && c.name && typeof c.wr === 'number' && c.games > 0 && (!i || c.rank >= tAll.champions[i - 1].rank)), 'every row has id, slug, name, rate, games; sorted by rank');
ok(tAll.champions.find(c => c.slug === 'ahri').cid === 103 && tAll.champions[0].tier === 'S+', 'Riot ids (Ahri = 103) and tiers');
const ahri = P.parseChampionPage(fixture('arena/ahri_emerald.html'));
ok(ahri.cid === 103 && ahri.bracket === 'emerald_plus' && ahri.header.games === 5061 && ahri.header.wr === 58.82, 'Ahri page header');
ok(ahri.places.length === 6 && ahri.winPlaces === 3 && Math.abs(ahri.places.slice(0, 3).reduce((a, b) => a + b, 0) - ahri.header.wr) <= 0.6, 'six teams: 1st-3rd add up to the top-half rate: ' + JSON.stringify([ahri.places, ahri.winPlaces]));
ok(ahri.avgPlace > 1 && ahri.avgPlace < 6, 'average place in range');
ok(ahri.augments.all.length > 50 && ahri.augments.all.every(a => a.name && ['silver', 'gold', 'prismatic'].includes(a.rarity) && a.games >= 1), 'augments with names and rarities');
ok([1, 2, 3, 4].every(r => ahri.augments.rounds[r].length > 10 && ahri.augments.rounds[r].every(a => a.games >= 5)), 'augments by pick (5+ games)');
ok(ahri.items.start.length && ahri.items.prismatic.length && [1, 2, 3, 4, 5, 6].every(s => ahri.items.slots[s].length), 'items: start, prismatic, every slot');
ok(ahri.partners.length > 100 && ahri.partners.every(p => Number.isInteger(p.id) && typeof p.delta === 'number' && p.games > 0), 'partners with the pair delta');
const meta = P.parseAugmentMeta(fixture('arena/cdragon_augments.json'));
ok(Object.keys(meta).length > 200 && Object.values(meta).every(m => !m.icon || /^https:\/\/raw\.communitydragon\.org\/latest\/game\/assets\//.test(m.icon)), 'augment icons only from CommunityDragon assets');
ok(meta[ahri.augments.all[0].id] && meta[ahri.augments.all[0].id].name === ahri.augments.all[0].name, 'LoLalytics augment ids = Riot ids (same name in CommunityDragon)');
ok(P.parseTierList('<html></html>') === null && P.parseChampionPage('x') === null && P.parseAugmentMeta('{}') === null, 'pages without the markers -> null');
ok(P.placements({ wr: 50, place1: 15, place2: 13, place3: 12, place4: 10, place5: 14, place6: 12, place7: 12, place8: 12 }).winPlaces === 4, 'eight teams: the top half is 4 places');
// the tier page's own aram mode is not Arena
ok(P.parseTierList(fixture('arena/tier_all.html').replace(/"arena"/g, '"aram"')) === null, 'a page of another mode is rejected');
console.log('parsers ok');

// ---- champion select
(async () => {
    const pick = async (session, flow, pickable = null) => AM._internals.normaliseChampSelect(session, flow, async () => pickable);
    const flow = { gameData: { queue: { id: 1750, gameMode: 'CHERRY', name: 'Arena' } } };
    let cs = await pick({ localPlayerCellId: 0, myTeam: [{ cellId: 0, championId: 103 }, { cellId: 1, championId: 0 }, { cellId: 2, championId: 17 }], theirTeam: [{ cellId: 3, championId: 86 }],
        bans: { myTeamBans: [55], theirTeamBans: [{ championId: 64 }] }, actions: [] }, flow, [103, 17, 86, 1, 2]);
    ok(cs.isArena && cs.mine === 103 && cs.mineLocked && cs.teamKnown && cs.mates.length === 2 && cs.taken.join() === '17,86' && cs.banned.join() === '55,64', 'your trio, taken and banned: ' + JSON.stringify(cs));
    cs = await pick({ localPlayerCellId: 4, myTeam: [0, 1, 2, 3, 4, 5].map(c => ({ cellId: c, championId: c === 5 ? 99 : 0, subteamIndex: c >> 1 })),
        actions: [[{ type: 'pick', actorCellId: 4, championId: 266, completed: false }]] }, flow);
    ok(cs.mine === 266 && !cs.mineLocked && cs.teamKnown && cs.mates.length === 1 && cs.mates[0].championId === 99 && cs.pickable === null, 'a whole lobby with subteams: your hover, your partner only');
    cs = await pick({ localPlayerCellId: 0, myTeam: [0, 1, 2, 3, 4, 5].map(c => ({ cellId: c, championId: 0 })), actions: [] }, { gameData: { queue: { id: 420 } } });
    ok(!cs.isArena && !cs.teamKnown && cs.mates.length === 0, 'Ranked is not Arena; a lobby without team marks: partner unknown');
    console.log('champion select ok');

    // ---- handlers: stub fetch, scratch cache, 6 h TTL, stale -> background refresh, bad slugs
    const dir = scratch('arena'), h = {}, fetched = [], pushes = [];
    let fail = false;
    const pages = { [AM._internals.tierUrl('all')]: fixture('arena/tier_all.html'), [AM._internals.tierUrl('emerald_plus')]: fixture('arena/tier_emerald.html'),
        [AM._internals.champUrl('ahri', 'emerald_plus')]: fixture('arena/ahri_emerald.html'), 'https://raw.communitydragon.org/latest/cdragon/arena/en_us.json': fixture('arena/cdragon_augments.json') };
    AM.register({ ipcMain: { handle: (c, f) => { h[c] = f; } }, userDataPath: dir, sendToWindow: (c, p) => pushes.push([c, p]),
        getLeagueCredentials: async () => { throw new Error('none'); }, lcuRequest: async () => null,
        arenaFetch: async url => { fetched.push(url); if (fail) throw Object.assign(new Error('Network error: down'), { code: 'NETWORK' }); if (!pages[url]) throw Object.assign(new Error('Page not found (404)'), { code: 'NOT_FOUND' }); return pages[url]; } });
    const call = (c, a) => h['arena:' + c]({}, a);
    ok(['tier-list', 'champion', 'augments', 'champ-select', 'cache-info', 'cache-clear'].every(c => typeof h['arena:' + c] === 'function'), 'all arena:* channels registered');
    let r = await call('tier-list', {});
    ok(r.ok && r.data.champions.length === 173 && r.data.bracket === 'all' && !r.stale && fetched.length === 1 && /\?tier=all$/.test(fetched[0]), 'tier list: all ranks by default, one request');
    r = await call('tier-list', {});
    ok(r.ok && fetched.length === 1, 'second call: from the cache, no request');
    r = await call('tier-list', { tier: 'emerald_plus' });
    ok(r.ok && r.data.bracket === 'emerald_plus' && fetched.length === 2, 'Emerald+ is its own entry');
    r = await call('champion', { slug: 'ahri', tier: 'emerald_plus' });
    ok(r.ok && r.data.cid === 103 && r.data.url === AM._internals.champUrl('ahri', 'emerald_plus'), 'champion page');
    r = await call('champion', { slug: '../x' });
    ok(!r.ok && r.code === 'BAD_REQUEST' && fetched.length === 3, 'a bad slug is refused without a request');
    r = await call('champion', { slug: 'zed', tier: 'emerald_plus' });
    ok(!r.ok && r.code === 'NOT_FOUND', 'a missing page is an error, not a crash');
    r = await call('augments');
    ok(r.ok && Object.keys(r.data).length > 200, 'augment list');
    const files = fs.readdirSync(path.join(dir, 'arena-cache'));
    ok(files.length === 4 && files.every(f => f.endsWith('.json.gz')), 'cached on disk under userData/arena-cache: ' + files.join(', '));

    // stale: served at once (stale:true), refreshed in the background, the window told
    const f = path.join(dir, 'arena-cache', 'tier-all.json.gz'), zlib = require('zlib');
    const o = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString()); o.fetchedAt -= AM._internals.TTL_MS + 1000; fs.writeFileSync(f, zlib.gzipSync(JSON.stringify(o)));
    // a fresh registration reads the file again (the first one keeps it in memory)
    const h2 = {}; AM.register({ ipcMain: { handle: (c, fn) => { h2[c] = fn; } }, userDataPath: dir, sendToWindow: (c, p) => pushes.push([c, p]), getLeagueCredentials: async () => { throw new Error('none'); }, lcuRequest: async () => null,
        arenaFetch: async url => { fetched.push(url); return pages[url]; } });
    const before = fetched.length;
    r = await h2['arena:tier-list']({}, {});
    ok(r.ok && r.stale && r.data.champions.length === 173, 'older than 6 h: served at once, marked stale');
    for (let i = 0; i < 50 && !pushes.length; i++) await new Promise(res => setTimeout(res, 20));
    ok(fetched.length === before + 1 && pushes.some(p => p[0] === 'arena:updated' && p[1].kind === 'tier-list'), 'and refreshed once in the background, with arena:updated');
    // offline with a cached copy: the copy, with the error
    fail = true;
    r = await call('tier-list', { force: true });
    ok(r.ok && r.stale && /Network/.test(r.error), 'forced refresh while offline: the cached copy plus the error');
    r = await call('cache-info');
    ok(r.ok && r.data.files.length === 4, 'cache-info lists the files');
    r = await call('cache-clear');
    ok(r.ok && r.removed === 4 && fs.readdirSync(path.join(dir, 'arena-cache')).filter(x => x.endsWith('.json.gz')).length === 0, 'cache-clear empties the folder');
    r = await call('champ-select');
    ok(r.ok && r.data.connected === false && !r.data.inChampSelect, 'no client: not connected, no error thrown');
    console.log('handlers ok');
    console.log('ALL OK', n, 'checks'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
