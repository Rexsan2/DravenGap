// Agent F tests: STALE_PUUID recovery, SEA routing, Wukong mapping, backfill wait/hang/cancel, empty player docs.
process.env.DD_BACKFILL_STEP_MS = '1500';
const assert = require('assert'); const fs = require('fs'); const path = require('path'); const os = require('os'); const http = require('http');
const { APP, scratch, fixture } = require('../lib/common');
const rh = require(APP + 'riot-history');
const { createRiotClient } = require(APP + 'profile-riot');
const pm = require(APP + 'profile-main');

const pu = (tag) => ('P' + tag).padEnd(78, 'x');
const OLD = pu('OLD'), NEW = pu('NEW');
const names = ['TestOwner', 'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India'];
function match(i, me) {
  const parts = names.map((n, k) => ({ puuid: k === 0 ? me : pu(n), riotIdGameName: n, riotIdTagline: k === 0 ? 'META' : 'EUW', championId: 10 + k, championName: 'C' + k, champLevel: 10, summoner1Id: 4, summoner2Id: 14, teamId: k < 5 ? 100 : 200, win: k < 5, kills: 3, deaths: 2, assists: 4, totalMinionsKilled: 100, neutralMinionsKilled: 0, visionScore: 5, teamPosition: k === 0 ? 'Invalid' : 'TOP', item0: 0, item1: 0, item2: 0, item3: 0, item4: 0, item5: 0, item6: 0, perks: { styles: [] } }));
  return { metadata: { matchId: 'EUW1_' + (9000 - i) }, info: { gameId: 9000 - i, queueId: 450, gameMode: 'ARAM', gameDuration: 1500, gameEndTimestamp: Date.now() - i * 3600e3, gameVersion: '16.19.1', participants: parts, teams: [100, 200].map(t => ({ teamId: t, win: t === 100, objectives: {} })) } };
}
function stub() {
  const st = { me: OLD, hang: new Set(), log: [], total: 30 };
  const srv = http.createServer((req, res) => {
    const u = req.url; st.log.push(req.headers.host + u);
    const send = (c, b) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (st.me === NEW && u.includes(OLD)) return send(400, { status: { message: 'Exception decrypting ' + OLD, status_code: 400 } });
    let m;
    if (u.includes('by-riot-id')) return send(200, { puuid: st.me, gameName: 'TestOwner', tagLine: 'META' });
    if (u.includes('/summoner/v4/')) return send(200, { profileIconId: 1, summonerLevel: 30 });
    if (u.includes('/league/v4/')) return send(200, []);
    if (u.includes('/top?')) return send(200, []);
    if ((m = u.match(/ids\?start=(\d+)&count=(\d+)/))) { const ids = Array.from({ length: st.total }, (_, i) => 'EUW1_' + (9000 - i)); return send(200, ids.slice(+m[1], +m[1] + +m[2])); }
    if ((m = u.match(/matches\/EUW1_(\d+)$/))) { if (st.hang.has(m[1])) return; return send(200, match(9000 - +m[1], st.me)); }
    send(404, {});
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, st, port: srv.address().port })));
}
function reg(S, extra = {}) {
  const handlers = {}, pushes = [];
  const dir = scratch('pf');
  const ctl = pm.register({ ipcMain: { handle: (c, f) => handlers[c] = f }, userDataPath: dir, getRiotApiKey: () => 'k', getLeagueCredentials: async () => { throw new Error('none'); }, lcuRequest: async () => null,
    sendToWindow: (c, p) => pushes.push([c, p]), riotBaseUrl: h => 'http://127.0.0.1:' + S.port + '/' + h, noPoll: true, queuesUrl: 'http://127.0.0.1:1/x', cdQueuesUrl: 'http://127.0.0.1:1/y', limiter: new rh.RateLimiter(), ...extra });
  return { call: (n, a) => handlers['profile:' + n]({}, a), pushes, ctl, dir };
}
const waitFor = (fn, ms = 8000) => new Promise((res, rej) => { const t0 = Date.now(); const iv = setInterval(() => { if (fn()) { clearInterval(iv); res(); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('waitFor timeout')); } }, 30); });

(async () => {
  // ---- SEA routing
  assert.strictEqual(rh.accountRoutingForPlatform('OC1'), 'asia'); assert.strictEqual(rh.routingForPlatform('OC1'), 'sea');
  for (const p of ['PH2', 'SG2', 'TH2', 'TW2', 'VN2']) assert.strictEqual(rh.accountRoutingForPlatform(p), 'asia');
  assert.strictEqual(rh.accountRoutingForPlatform('EUW1'), 'europe'); assert.strictEqual(rh.accountRoutingForPlatform('NA1'), 'americas');
  const hosts = []; const c = createRiotClient({ getKey: () => 'k', baseUrl: h => { hosts.push(h); return 'http://127.0.0.1:1/' + h; }, limiter: new rh.RateLimiter() });
  for (const [k, p] of [['account', 'OC1'], ['regional', 'OC1'], ['platform', 'OC1'], ['account', 'TW2']]) c.request(k, p, '/x').catch(() => {});
  assert.deepStrictEqual(hosts, ['asia', 'sea', 'oc1', 'asia']); console.log('SEA routing ok', hosts.join(','));
  // ---- Wukong
  const am = require(APP + 'aram-main')._internals;
  assert.strictEqual(am.lolalyticsSlug('monkeyking'), 'wukong'); assert.strictEqual(am.lolalyticsSlug('jarvaniv'), 'jarvaniv'); console.log('wukong mapping ok');
  // ---- parsers: card missing stats must not borrow the next card
  const P = require(APP + 'aram-parsers');
  const card = (s, app, wr) => `<a href="/augments/${s}/"><img src="/i/${s}.png"><div title="${s}">x</div>${app ? `Appearance rate: <span>${app}%</span>` : ''}${wr ? `Win rate: <span>${wr}%</span>` : ''}</a>`;
  const html = `<section id="best-augments"><div>Gold</div>${card('a', 10, null)}${card('b', 20, 55)}</section>`;
  const aug = P.parseChampionPage('Best Augments for X ' + html);
  assert.deepStrictEqual(aug.augments.gold.map(x => [x.slug, x.appearance, x.wr]), [['a', 10, null], ['b', 20, 55]]); console.log('augment card bounding ok');

  // ---- STALE_PUUID
  const S = await stub();
  let R = reg(S);
  let r = await R.call('lookup', { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' }); assert(r.ok && r.profile.puuid === OLD);
  r = await R.call('matches', { puuid: OLD, platform: 'EUW1', group: 'all' }); assert(r.ok && r.matches.length === 20);
  const ledgerOld = (await R.call('ledger', { puuid: OLD })).rows.length; assert(ledgerOld === 20);
  // key/project change: old puuid now undecryptable; account-v1 returns the new one
  S.st.me = NEW;
  r = await R.call('matches', { puuid: OLD, platform: 'EUW1', group: 'all', refresh: true });
  assert(r.ok && r.puuid === NEW, JSON.stringify(r).slice(0, 200));
  assert(r.matches.length === 20 && r.matches.every(m => m.players.some(p => p.puuid === NEW)), 'cached games (old puuid inside) still match "me"');
  r = await R.call('ledger', { puuid: NEW }); assert(r.rows.length >= 20, 'ledger carried over: ' + r.rows.length);
  console.log('matches recovery ok (puuid', r.rows.length, 'ledger rows)');
  // lookup path: parts missing + stale account
  S.st.me = OLD; R = reg(S);
  r = await R.call('lookup', { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' }); assert(r.profile.puuid === OLD);
  S.st.me = NEW; R.ctl.cache.dropMeta(k => k.startsWith('sum:'));
  r = await R.call('lookup', { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' }); assert(r.ok && r.profile.puuid === NEW && r.profile.summonerLevel === 30, JSON.stringify(r).slice(0, 200)); console.log('lookup recovery ok');
  // onRiotKeyChanged clears acct/sum/lg/ms but keeps matches; flush exists
  assert(R.ctl.cache.getMeta('acct:EUW1:testowner#meta')); const n = pm.onRiotKeyChanged(); assert(n >= 3 && !R.ctl.cache.getMeta('acct:EUW1:testowner#meta') && R.ctl.cache.getMeta('puuid:' + NEW)); pm.flush(); console.log('onRiotKeyChanged dropped', n, 'entries');
  // scout + backfill recovery
  S.st.me = OLD; R = reg(S); await R.call('lookup', { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' });
  S.st.me = NEW;
  r = await R.call('scout', { puuid: OLD, platform: 'EUW1', championId: 10 }); assert(r.ok && r.form.games === 5, JSON.stringify(r)); console.log('scout recovery ok');
  // ---- empty player docs: live scout of unknown puuid must not create a doc
  assert.strictEqual(R.ctl.cache.peekPlayer(pu('Zed')), null); console.log('peekPlayer null ok');
  // invalid position excluded at compact level
  const C = require(APP + 'profile-compact'); const cm = C.compactMatch(match(0, OLD)); assert.strictEqual(cm.players[0].pos, ''); assert.strictEqual(C.QUEUE_NAMES[1750], 'Arena'); console.log('Invalid pos + 1750 ok');

  // ---- backfill: limiter window full => waiting events
  S.st.me = OLD;
  const lim = new rh.RateLimiter([[1, 6000]]);
  R = reg(S, { limiter: lim }); await R.call('lookup', { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' }); // consumes the only slot for 6 s
  await R.call('backfill', { puuid: OLD, platform: 'EUW1', max: 10 });
  await waitFor(() => R.pushes.some(p => p[1].kind === 'backfill' && p[1].waitingMs > 3000));
  const w = R.pushes.find(p => p[1].waitingMs > 3000)[1]; assert(w.resumeAt > Date.now() && w.state === 'running'); console.log('waitingMs event ok', w.waitingMs);
  await R.call('backfill-cancel', { puuid: OLD });
  await waitFor(() => R.pushes.some(p => p[1].kind === 'backfill' && p[1].state === 'cancelled')); console.log('cancel while waiting on limiter ok');
  // ---- backfill: one match request never answers => final error event (watchdog) and header can clear
  S.st.hang.add('9000'); S.st.hang.add('8999');
  R = reg(S); await R.call('lookup', { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' });
  const t0 = Date.now(); await R.call('backfill', { puuid: OLD, platform: 'EUW1', max: 10 });
  await waitFor(() => R.pushes.some(p => p[1].kind === 'backfill' && p[1].state !== 'running'), 6000);
  const fin = R.pushes.filter(p => p[1].kind === 'backfill').pop()[1]; assert.strictEqual(fin.state, 'error'); assert.strictEqual(fin.error.code, 'TIMEOUT'); console.log('hung request -> error after', Date.now() - t0, 'ms');
  // restart is possible afterwards (not stuck as running), and Cancel works while hung
  R.pushes.length = 0; await R.call('backfill', { puuid: OLD, platform: 'EUW1', max: 10 });
  setTimeout(() => R.call('backfill-cancel', { puuid: OLD }), 300);
  await waitFor(() => R.pushes.some(p => p[1].kind === 'backfill' && p[1].state === 'cancelled'), 3000); console.log('cancel while hung ok');
  S.srv.close(); console.log('ALL OK'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
