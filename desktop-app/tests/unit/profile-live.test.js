// Agent I tests: op.gg champion-stats parser, tags, premades, team averages, op.gg fetcher (stub), live scouting via profile-main (stub).
const assert = require('assert'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { APP, scratch } = require('../lib/common');
const OG = require('../lib/opgg-fixture');
const SE = require(APP + 'profile-seasons'); const LV = require(APP + 'profile-live');
const { start, puuidOf, NAMES, TIERS } = require('../lib/live-stub');
let asserts = 0; const ok = (c, m) => { asserts++; assert(c, m); }; const eq = (a, b, m) => { asserts++; assert.deepStrictEqual(a, b, m); };

(async () => {
  // ---------- 1. parsers on the synthetic op.gg fixtures ----------
  const html = OG.page({ opuid: 'OPGG'.padEnd(80, 'z') }), action = OG.actionBody();
  const pg = SE.parseOpgg(html);
  ok(pg.ok && pg.meta.opuid.length > 60, 'op.gg player id'); eq(pg.meta.season, { label: 'S2026', id: 33 });
  eq(Object.keys(pg.meta.roles).sort(), ['BOTTOM', 'JUNGLE', 'MIDDLE', 'TOP', 'UTILITY']); ok(pg.meta.roles.BOTTOM.pct === 80 && pg.meta.roles.BOTTOM.g === 12, JSON.stringify(pg.meta.roles));
  ok(pg.solo.length >= 4 && pg.chunkUrls.length > 20, 'past seasons still parse + chunk list');
  const ca = SE.parseChampionsAction(action);
  ok(ca.ok && ca.all.g === 12 && ca.all.w === 7 && ca.list.length === 7, JSON.stringify(ca.all));
  eq(ca.list[0], { key: 'caitlyn', name: 'Caitlyn', g: 3, w: 2, l: 1, k: 9, d: 5, a: 6.7, kda: 3.13, cs: 7.6 });
  ok(!SE.parseChampionsAction('Server action not found.').ok && !SE.parseChampionsAction('0:{"a":1}\n').ok, 'garbage rejected');
  ok(SE.parseChampionsAction('0:{}\n1:[]\n').ok && SE.parseChampionsAction('0:{}\n1:[]\n').list.length === 0, 'empty list is valid');
  ok(!SE.parseChampionsAction('1:[{"x":1}]\n').ok, 'wrong shape rejected');
  eq(SE.findActionId('x.createServerReference)("4028494596c44675d8e9f617b8f659312f3b678072",i.callServer,void 0,i.findSourceMapURL,"getSummaryRankedMostChampions")'), '4028494596c44675d8e9f617b8f659312f3b678072');
  eq(SE.findActionId('createServerReference("aabbccddeeff00112233aabbccddeeff00112233","getOther")'), null);
  const peak = SE.bestOf(pg.solo); ok(peak && peak.tier === 'MASTER', JSON.stringify(peak));
  ok(SE.parseMeta('nothing here') && !SE.parseMeta('nothing here').opuid, 'meta of garbage');
  console.log('parsers ok');

  // ---------- 2. champion resolution ----------
  const list = ca.list;
  let r = LV.resolveChamp(ca, { name: 'Caitlyn', id: 'Caitlyn' }); ok(r.champ.g === 3 && r.champ.exact && r.all.g === 12);
  r = LV.resolveChamp(ca, { name: 'Xayah', id: 'Xayah' }); ok(r.champ.g === 1);
  r = LV.resolveChamp(ca, { name: 'Ahri', id: 'Ahri' }); ok(r.champ.g === 0 && r.champ.exact, 'listed games add up to the season total -> exactly 0');
  const big = { all: { g: 100 }, list: [{ key: 'yone', name: 'Yone', g: 30 }, { key: 'ahri', name: 'Ahri', g: 20 }] };
  r = LV.resolveChamp(big, { name: 'Kai\'Sa', id: 'Kaisa' }); ok(r.champ.g === null && r.champ.max === 20 && !r.champ.exact, JSON.stringify(r.champ));
  r = LV.resolveChamp({ all: { g: 100 }, list: [{ key: 'kaisa', name: "Kai'Sa", g: 9 }] }, { name: "Kai'Sa", id: 'Kaisa' }); ok(r.champ.g === 9, 'punctuation-insensitive match');
  r = LV.resolveChamp({ empty: true, list: [] }, { name: 'Ahri', id: 'Ahri' }); ok(r.champ.g === 0);
  r = LV.resolveChamp(ca, null); ok(r.champ === null && r.all.g === 12, 'unknown champion mapping keeps the season totals');
  console.log('champion resolution ok');

  // ---------- 3. tag rules ----------
  const solo = (w, l, extra = {}) => ({ ranked: [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', leaguePoints: 30, wins: w, losses: l, ...extra }] });
  const ids = p => LV.computeTags(p).map(t => t.id).sort();
  eq(ids({ ...solo(60, 60), form: { results: [true, true, true, false] } }), ['hot', 'veteran']);
  eq(ids({ ...solo(60, 60), form: { results: [true, true, false, true] } }), ['veteran'], '2 wins is not a streak');
  eq(ids({ ...solo(40, 40), form: { results: [false, false, false, true] } }), ['tilt']);
  eq(ids({ ...solo(40, 40, { hotStreak: true }) }), ['hot'], 'league hotStreak flag when no form');
  eq(ids({ ...solo(40, 40, { hotStreak: true }), form: { results: [false, false, true] } }), [], 'recent results win over the flag');
  eq(ids({ ...solo(99, 0) }).includes('veteran'), false); eq(ids({ ...solo(50, 50) }).includes('veteran'), true, '100 games = veteran');
  eq(ids({ ...solo(30, 30), mastery: { level: 1, points: 0 } }), ['first']);
  eq(ids({ ...solo(30, 30), mastery: { level: 2, points: 3000 } }), ['newchamp']);
  eq(ids({ ...solo(30, 30), mastery: { level: 6, points: 40000 } }), []);
  const og = (c, all, extra = {}) => ({ og: { state: 'ok', champ: c, all, ...extra } });
  eq(ids({ ...solo(30, 30), mastery: { points: 90000 }, ...og({ g: 0, exact: true }, { g: 60 }) }), [], 'high mastery: not new even with 0 ranked games');
  eq(ids({ ...solo(30, 30), mastery: { points: 2000 }, ...og({ g: 1, exact: true }, { g: 60 }) }), ['newchamp']);
  eq(ids({ ...solo(30, 30), mastery: { points: 0 }, ...og({ g: 0, exact: true }, { g: 60 }) }), ['first']);
  eq(ids({ ...solo(30, 30), ...og({ g: null, max: 1, exact: false }, { g: 60 }) }), ['newchamp'], 'unlisted champion capped at 1 game');
  eq(ids({ ...solo(30, 30), ...og({ g: null, max: 6, exact: false }, { g: 60 }) }), [], 'unlisted champion may have up to 6 games: no tag');
  eq(ids({ ...solo(30, 30), mastery: { points: 99999 }, ...og({ g: 36, exact: true }, { g: 60 }) }), ['onetrick'], '60% share');
  eq(ids({ ...solo(30, 30), mastery: { points: 99999 }, ...og({ g: 35, exact: true }, { g: 60 }) }), [], '58% is not enough');
  eq(ids({ ...solo(30, 30), mastery: { points: 99999 }, ...og({ g: 9, exact: true }, { g: 10 }) }), [], 'too few games for a one-trick');
  const roles = { TOP: { pct: 80, g: 40 }, JUNGLE: { pct: 2, g: 1 }, MIDDLE: { pct: 10, g: 5 }, BOTTOM: { pct: 4, g: 2 }, UTILITY: { pct: 4, g: 2 } };
  eq(ids({ ...solo(30, 30), mastery: { points: 99999 }, spell1Id: 4, spell2Id: 11, ...og({ g: 10, exact: true }, { g: 50 }, { roles }) }), ['autofill'], 'Smite but a top main');
  eq(ids({ ...solo(30, 30), mastery: { points: 99999 }, spell1Id: 4, spell2Id: 14, ...og({ g: 10, exact: true }, { g: 50 }, { roles }) }), [], 'no Smite, top main: not flagged (lane unknown)');
  const jg = { ...roles, TOP: { pct: 5, g: 2 }, JUNGLE: { pct: 85, g: 43 } };
  eq(ids({ ...solo(30, 30), mastery: { points: 99999 }, spell1Id: 4, spell2Id: 14, ...og({ g: 10, exact: true }, { g: 50 }, { roles: jg }) }), ['autofill'], 'jungle main without Smite');
  eq(ids({ ...solo(30, 30), mastery: { points: 99999 }, spell1Id: 4, spell2Id: 11, ...og({ g: 10, exact: true }, { g: 50 }, { roles: jg }) }), [], 'jungle main with Smite');
  eq(ids({ ...solo(30, 30), mastery: { points: 99999 }, spell1Id: 11, spell2Id: 4, ...og({ g: 3, exact: true }, { g: 10 }, { roles: { TOP: { pct: 80, g: 8 }, JUNGLE: { pct: 0, g: 0 }, MIDDLE: { pct: 20, g: 2 } } }) }), [], 'too few games for autofill');
  eq(ids({ ...solo(40, 15), mastery: { points: 99999 } }), ['smurf'], '73% over 55 games');
  eq(ids({ ...solo(70, 40), mastery: { points: 99999 } }), ['veteran'], '64% over 110 games: not a smurf');
  eq(ids({ ...solo(9, 2), mastery: { points: 99999 } }), [], 'under 15 games');
  eq(ids({ ...solo(30, 20), summonerLevel: 38, mastery: { points: 99999 } }), ['smurf'], 'level 38 with 60%');
  eq(ids({ ...solo(30, 30), summonerLevel: 38, mastery: { points: 99999 } }), [], 'level 38 with 50%');
  eq(ids({ bot: true, ...solo(100, 0) }), []); eq(ids({}), []);
  ok(LV.computeTags({ ...solo(60, 60), form: { results: [true, true, true] } })[0].tip.includes('3 wins'), 'tooltip explains the rule');
  eq(LV.streakOf([true, true, false]), { win: 2, loss: 0 }); eq(LV.streakOf([false, false, false, false]), { win: 0, loss: 4 }); eq(LV.streakOf([]), { win: 0, loss: 0 });
  console.log('tags ok');

  // ---------- 4. premades + team overviews ----------
  const pls = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => ({ idx: i, teamId: i < 5 ? 100 : 200 }));
  let g = LV.detectPremades(pls, [{ a: 0, b: 1, src: 'party' }, { a: 6, b: 7, src: 'ids' }, { a: 7, b: 8, src: 'match' }]);
  eq(g.map(x => [x.kind, x.members, x.team]), [['Duo', [0, 1], 100], ['Premade 3', [6, 7, 8], 200]]); ok(g[0].color !== g[1].color, 'distinct colours');
  eq(g[1].src.sort(), ['ids', 'match']);
  eq(LV.detectPremades(pls, [{ a: 0, b: 6, src: 'ids' }]), [], 'pairs across teams are ignored');
  eq(LV.detectPremades(pls, [{ a: 1, b: 1, src: 'x' }, { a: 1, b: 99, src: 'x' }, null]), [], 'garbage evidence ignored');
  eq(LV.detectPremades(pls, [{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }, { a: 3, b: 4 }])[0].kind, 'Premade 5');
  const pi = LV.pairsFromIds(new Map([[1, ['a', 'b', 'c']], [2, ['c', 'd']], [3, ['x']]]), null); eq(pi.map(e => [e.a, e.b, e.n]), [[1, 2, 1]]);
  eq(LV.pairsFromIds(new Map([[1, ['a']], [2, ['a']]]), () => false), [], 'opposite teams in a cached match');
  const tp = (tier, rank, lp, w, l) => ({ ranked: [{ queueType: 'RANKED_SOLO_5x5', tier, rank, leaguePoints: lp, wins: w, losses: l }] });
  let ts = LV.teamSummary([tp('GOLD', 'II', 50, 60, 40), tp('PLATINUM', 'IV', 0, 50, 50), { ranked: [] }, { bot: true }]);
  eq(ts.avgRank, { tier: 'GOLD', rank: 'I', lp: 25 }, JSON.stringify(ts)); eq(ts.avgWr, 55); eq([ts.ranked, ts.players, ts.loaded], [2, 3, 3]);
  ts = LV.teamSummary([tp('MASTER', 'I', 100, 5, 5), tp('CHALLENGER', 'I', 500, 5, 5)]); ok(ts.avgRank.tier === 'MASTER' && ts.avgRank.apex && ts.avgRank.lp === 300, JSON.stringify(ts.avgRank));
  eq(LV.teamSummary([{ ranked: [] }, { ranked: [] }]).avgRank, null); eq(LV.teamSummary([{}, {}]).loaded, 0, 'players without data yet'); eq(LV.teamSummary([]).avgWr, null);
  eq(LV.scoreToRank(LV.rankScore({ tier: 'IRON', rank: 'IV', leaguePoints: 0 })), { tier: 'IRON', rank: 'IV', lp: 0 }); eq(LV.scoreToRank(LV.rankScore({ tier: 'DIAMOND', rank: 'I', leaguePoints: 99 })), { tier: 'DIAMOND', rank: 'I', lp: 99 });
  console.log('premades + team averages ok');

  // ---------- 5. fetcher against the stub ----------
  const S = await start();
  const mkCache = () => { const m = {}; return { m, getMeta: k => m[k] || null, setMeta: (k, d) => { m[k] = { at: Date.now(), data: d }; } }; };
  const origin = 'http://127.0.0.1:' + S.ogPort;
  let cache = mkCache(), og1 = SE.createOpgg({ cache, origin, minGapMs: 5, chunkGapMs: 1 });
  let res = await og1.champions('EUW1', 'TestOwner', 'META', { gameType: 'SOLORANKED' });
  ok(res.ok && !res.cached && res.data.all.g === 12 && res.data.list[0].key === 'caitlyn' && res.data.peak.tier === 'MASTER' && res.data.roles.BOTTOM.g === 12 && res.data.season.id === 33, JSON.stringify(res).slice(0, 200));
  eq(S.olog.map(x => x.split(' ')[0]), ['GET', 'POST'], 'one page + one champion call per player'); eq([og1.stats.pages, og1.stats.actions], [1, 1]);
  res = await og1.champions('EUW1', 'TestOwner', 'META', { gameType: 'SOLORANKED' }); ok(res.cached && S.olog.length === 2, 'second call: cached, no request');
  res = await og1.champions('EUW1', 'TestOwner', 'META', { gameType: 'FLEXRANKED' }); ok(res.ok && S.olog.length === 3, 'other queue: champion call only (page cached); ' + S.olog.join('|'));
  ok(og1.peek('EUW1', 'TestOwner', 'META', 'SOLORANKED') && !og1.peek('EUW1', 'Nobody', 'x', 'SOLORANKED'), 'peek');
  const before = S.olog.length; const sp = await og1.get('EUW1', 'TestOwner', 'META'); ok(sp.cached && S.olog.length === before && sp.data.solo.length >= 4, 'past seasons served from the same cached page');
  // a pre-existing cache entry without the player id is refreshed once
  cache = mkCache(); cache.setMeta('opgg:EUW1:testowner#meta', { solo: [], flex: [], empty: true }); og1 = SE.createOpgg({ cache, origin, minGapMs: 5 });
  const n0 = S.olog.length; res = await og1.champions('EUW1', 'TestOwner', 'META'); ok(res.ok && res.data.all && S.olog.length === n0 + 2, 'legacy cache entry refetched');
  // serialised + gap
  cache = mkCache(); const gapped = SE.createOpgg({ cache, origin, minGapMs: 120 }); const t0 = Date.now();
  await Promise.all(['Alpha', 'Bravo', 'Charlie'].map(n => gapped.champions('EUW1', n, 'EUW'))); ok(Date.now() - t0 >= 5 * 120 - 40, 'six requests serialised with the gap: ' + (Date.now() - t0));
  // redeploy: the action id changed -> found again in the page scripts
  S.state.newActionId = 'aaaabbbbccccddddeeeeffff0000111122223333'; cache = mkCache(); const redeployed = SE.createOpgg({ cache, origin, minGapMs: 5, chunkGapMs: 1 });
  res = await redeployed.champions('EUW1', 'TestOwner', 'META'); ok(res.ok && res.data.all.g === 12 && redeployed.actionId() === S.state.newActionId && redeployed.stats.chunks > 0, JSON.stringify(res).slice(0, 200) + ' ' + redeployed.stats.chunks);
  const nChunks = redeployed.stats.chunks; res = await redeployed.champions('EUW1', 'Alpha', 'EUW'); ok(res.ok && redeployed.stats.chunks === nChunks, 'new id remembered: no rescan');
  // failure -> 1 h back-off, no more requests; the page backoff is per player, an action failure is global
  S.state.ogBlockAll = true; cache = mkCache(); const failing = SE.createOpgg({ cache, origin, minGapMs: 5 }); const n1 = S.olog.length;
  res = await failing.champions('EUW1', 'Alpha', 'EUW'); ok(!res.ok && /403/.test(res.error) && res.retryAt > Date.now() + 3000e3, JSON.stringify(res));
  res = await failing.champions('EUW1', 'Alpha', 'EUW'); ok(!res.ok && res.backoff && S.olog.length === n1 + 1, 'second attempt within the hour makes no request');
  S.state.ogBlockAll = false;
  // action stale and not discoverable -> global 1 h back-off for everyone
  S.state.newActionId = 'ffffffffffffffffffffffffffffffffffffffff'; S.state.chunksEmpty = true; cache = mkCache(); const lost = SE.createOpgg({ cache, origin, minGapMs: 5, chunkGapMs: 1 });
  res = await lost.champions('EUW1', 'Alpha', 'EUW'); ok(!res.ok && /changed/.test(res.error), JSON.stringify(res));
  const n2 = S.olog.length; const res2 = await lost.champions('EUW1', 'Bravo', 'EUW'); ok(!res2.ok && res2.backoff && S.olog.length === n2, 'global back-off: no further requests');
  S.state.chunksEmpty = false; S.state.newActionId = null;
  console.log('fetcher ok', JSON.stringify(S.olog.length));
  S.og.close(); S.srv.close();

  // ---------- 6. profile-main live scouting (10 players) ----------
  const S2 = await start();
  const dir = scratch('pi');
  const handlers = {}, pushes = [];
  const rh = require(APP + 'riot-history'); const lim = new rh.RateLimiter();
  const lcuRank = { 'lcu-p1': ['GOLD', 'I', 80, 240, 230, true] };
  const lcuRequest = async (p) => {
    if (p === '/lol-gameflow/v1/gameflow-phase') return 'InProgress';
    if (p === '/lol-summoner/v1/current-summoner') return { gameName: 'TestOwner', tagLine: 'META', puuid: 'lcu-p0', profileIconId: 4568, summonerLevel: 321 };
    if (p === '/riotclient/get_region_locale') return { region: 'EUW' };
    if (p === '/lol-gameflow/v1/session') return { phase: 'InProgress', gameData: { gameId: 777, queue: { id: 420 }, teamOne: NAMES.slice(0, 5).map((n, k) => ({ puuid: 'lcu-p' + k, gameName: n, tagLine: k ? 'EUW' : 'META', championId: [266, 103, 84, 12, 32][k], spell1Id: 4, spell2Id: 14 })), teamTwo: NAMES.slice(5).map((n, k) => ({ puuid: 'lcu-p' + (k + 5), gameName: n, tagLine: 'EUW', championId: [1, 22, 136, 268, 432][k], spell1Id: 4, spell2Id: 14 })) } };
    if (p === '/lol-lobby/v2/lobby') return { members: [{ puuid: 'lcu-p0' }, { puuid: 'lcu-p1' }] };
    if (p.startsWith('/lol-ranked/v1/ranked-stats/')) { const t = TIERS[+p.split('lcu-p')[1]]; return { queues: t ? [{ queueType: 'RANKED_SOLO_5x5', tier: t[0], division: t[1], leaguePoints: t[2], wins: t[3], losses: t[4], isHotStreak: t[5] }] : [] }; }
    return null;
  };
  const { register } = require(APP + 'profile-main');
  register({ ipcMain: { handle: (c, f) => handlers[c] = f }, userDataPath: dir, getRiotApiKey: () => 'ok', getLeagueCredentials: async () => ({ port: 1, password: 'x' }), lcuRequest, sendToWindow: (c, p) => pushes.push([c, p]),
    riotBaseUrl: () => 'http://127.0.0.1:' + S2.port, noPoll: true, limiter: lim, queuesUrl: 'http://127.0.0.1:1/x', opggOrigin: 'http://127.0.0.1:' + S2.ogPort, opggMinGapMs: 5 });
  const call = (n, a) => handlers['profile:' + n]({}, a);
  const champs = [[266, 'Aatrox', 'Aatrox'], [103, 'Ahri', 'Ahri'], [84, 'Akali', 'Akali'], [12, 'Alistar', 'Alistar'], [32, 'Amumu', 'Amumu'], [1, 'Annie', 'Annie'], [22, 'Ashe', 'Ashe'], [136, 'Aurelion Sol', 'AurelionSol'], [268, 'Azir', 'Azir'], [432, 'Bard', 'Bard']];
  const t1 = Date.now();
  const live = await call('live', { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1', champs });
  ok(live.ok && live.inGame && live.game.players.length === 10 && live.game.bans.length === 10 && live.game.opgg === true, 'roster');
  ok(live.game.players[1].perks.ids.length === 9 && live.game.players[0].me, 'perks + me');
  const prog = () => pushes.filter(p => p[0] === 'profile:progress' && p[1].kind === 'live').map(p => p[1]);
  await new Promise((res_, rej) => { const iv = setInterval(() => { if (prog().some(e => e.finished)) { clearInterval(iv); res_(); } }, 50); setTimeout(() => rej(new Error('scouting did not finish: ' + prog().length)), 25000); });
  const evs = prog(); const patches = evs.filter(e => e.patch);
  eq(patches.filter(e => e.patch.stage === 'core' && e.patch.ranked).length, 10, 'ten core patches');
  eq(patches.filter(e => e.patch.stage === 'opgg').length, 10, 'ten op.gg patches');
  const final = {}; for (const e of patches) final[e.patch.idx] = { ...(final[e.patch.idx] || {}), ...e.patch };
  ok(final[0].og.state === 'ok' && final[0].og.champ.g === 0, 'owner plays Aatrox: 0 listed games, adds up -> exact 0: ' + JSON.stringify(final[0].og.champ));
  ok(final[1].og.champ.g === 4 + 3 && final[1].og.champ.exact, 'Alpha: stats on Ahri'); ok(final[3].og.champ.g === null && final[3].og.champ.max === 11, 'Delta: Alistar not in the list: ' + JSON.stringify(final[3].og.champ));
  ok(final[5].og.champ.g === 0 && final[5].og.all === null, 'Echo: no ranked games this season'); ok(final[0].og.peak.tier === 'MASTER' && final[0].og.roles.BOTTOM.pct === 80, 'peak + roles forwarded');
  const tagOf = i => (final[i].tags || []).map(t => t.id);
  ok(tagOf(1).includes('autofill') && tagOf(1).includes('veteran'), 'Alpha: Smite with a bot-lane main + veteran: ' + tagOf(1)); // owner page roles are 80% bot
  ok(tagOf(4).includes('onetrick') && tagOf(4).includes('newchamp') === false, 'Amumu one-trick: ' + tagOf(4)); ok(tagOf(3).includes('first'), 'Alistar mastery 0 => first time: ' + tagOf(3));
  ok(tagOf(4).length >= 1 && final[4].mastery.level === 1, 'low mastery level');
  ok(tagOf(6).includes('newchamp'), 'Ashe 1 game: ' + tagOf(6)); ok(tagOf(0).includes('hot') && tagOf(2).includes('hot') === false, 'LCU isHotStreak -> Hot streak: ' + tagOf(0));
  ok(tagOf(8).includes('smurf'), 'Hotel: 24 games 75% => smurf: ' + tagOf(8));
  const last = evs.filter(e => e.premades).pop(); const fin = evs.find(e => e.finished);
  eq(last.premades.map(x => [x.kind, x.members]), [['Premade 3', [0, 1, 3]], ['Premade 3', [6, 7, 8]]], JSON.stringify(last.premades));
  ok(last.premades[0].src.includes('party') && last.premades[1].src.includes('ids'), 'evidence sources');
  ok(fin.teams[100].ranked === 5 && fin.teams[100].avgRank && fin.teams[200].avgWr != null, 'team summaries ' + JSON.stringify(fin.teams));
  const riotReq = S2.log.filter(u => !u.includes('by-riot-id') && !u.includes('/spectator/')).length;
  console.log('live budget:', JSON.stringify(fin.budget), '| riot requests', S2.log.length, '(incl. account + spectator) |', 'op.gg', S2.olog.length, '|', Date.now() - t1, 'ms');
  ok(S2.log.length <= 34, 'Riot requests within the live budget: ' + S2.log.length);
  // with the client running the league entries are free: account + spectate + 10 mastery + 10 id lists
  eq(S2.olog.filter(x => x.startsWith('GET')).length, 10, 'one op.gg page per player'); eq(S2.olog.filter(x => x.startsWith('POST')).length, 10, 'one champion call per player');
  // again: everything cached
  const nR = S2.log.length, nO = S2.olog.length; pushes.length = 0;
  const live2 = await call('live', { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1', champs });
  await new Promise((res_, rej) => { const iv = setInterval(() => { if (prog().some(e => e.finished)) { clearInterval(iv); res_(); } }, 50); setTimeout(() => rej(new Error('2nd scouting did not finish')), 15000); });
  eq(S2.olog.length, nO, 'second live game: zero op.gg requests (6 h cache)'); console.log('second pass riot requests', S2.log.length - nR, '(spectate only expected)');
  ok(S2.log.length - nR <= 3, 'cached league/mastery/ids');
  // scout feeds tags
  const gk = live2.gameKey; pushes.length = 0;
  const sc = await call('scout', { puuid: puuidOf('Bravo'), platform: 'EUW1', championId: 84, gameKey: gk, idx: 2 }); ok(sc.ok);
  const sp2 = prog().filter(e => e.patch && e.patch.stage === 'scout'); eq(sp2.length, 1, 'scout patch pushed'); ok(sp2[0].patch.form.results.length === sc.form.games);
  // input validation
  for (const bad of [{ puuid: 'x', platform: 'EUW1', championId: 1 }, { puuid: puuidOf('Bravo'), platform: 'NOPE', championId: 1 }]) { const rr = await call('scout', bad); ok(rr.ok === false, 'rejects ' + JSON.stringify(bad)); }
  const rr = await call('scout', { puuid: puuidOf('Bravo'), platform: 'EUW1', championId: 84, gameKey: 'bogus', idx: '1; DROP' }); ok(rr.ok, 'bad gameKey/idx are ignored, not fatal');
  const rl = await call('live', { gameName: 'x', tagLine: 'y', platform: 'MARS' }); ok(rl.ok === false && rl.code === 'BAD_REGION');
  const rl2 = await call('live', { gameName: 'Bravo', tagLine: 'EUW', platform: 'EUW1', champs: 'not-a-list' }); ok(rl2.ok, 'junk champs ignored');
  S2.og.close(); S2.srv.close();

  // ---------- 7. op.gg blocked: Riot-only fallback, one refused request instead of ten ----------
  {
    const S3 = await start(); S3.state.ogBlockAll = true;
    const dir3 = scratch('pi3'); const h3 = {}, pu3 = [];
    register({ ipcMain: { handle: (c, f) => h3[c] = f }, userDataPath: dir3, getRiotApiKey: () => 'ok', getLeagueCredentials: async () => { throw new Error('none'); }, lcuRequest: async () => null, sendToWindow: (c, p) => pu3.push([c, p]),
      riotBaseUrl: () => 'http://127.0.0.1:' + S3.port, noPoll: true, limiter: new rh.RateLimiter(), queuesUrl: 'http://127.0.0.1:1/x', opggOrigin: 'http://127.0.0.1:' + S3.ogPort, opggMinGapMs: 5 });
    const l3 = await h3['profile:live']({}, { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1', champs });
    ok(l3.inGame && l3.game.players.length === 10);
    await new Promise((res_, rej) => { const iv = setInterval(() => { if (pu3.some(p => p[1].finished)) { clearInterval(iv); res_(); } }, 50); setTimeout(() => rej(new Error('blocked scouting did not finish')), 20000); });
    const pa = pu3.filter(p => p[1].patch).map(p => p[1].patch);
    eq(pa.filter(p => p.stage === 'opgg' && p.og.state === 'fail').length, 10, 'all rows end with an op.gg failure marker');
    ok(pa.filter(p => p.stage === 'core' && p.ranked).length === 10, 'Riot data unaffected');
    eq(S3.olog.length, 1, 'only the first request reached op.gg: ' + S3.olog.join(','));
    ok(pa.find(p => p.stage === 'opgg').og.error.includes('403'), 'error text kept for the tooltip');
    const f3 = pu3.find(p => p[1].finished)[1]; ok(f3.budget.riot <= 34, JSON.stringify(f3.budget));
    console.log('no-LCU live budget (account+spectate not counted):', JSON.stringify(f3.budget), 'total riot requests', S3.log.length);
    S3.og.close(); S3.srv.close();
  }
  console.log(`t_i OK (${asserts} assertions)`);
  process.exit(0);
})().catch(e => { console.error('FAIL', e.stack || e); process.exit(1); });
