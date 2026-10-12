// loadingMatches race: runs profile-view.js against a fake DOM + scripted IPC.
const vm = require('vm'), fs = require('fs'), assert = require('assert');
const src = fs.readFileSync(require('../lib/common').APP + 'profile-view.js', 'utf8');
const mkEl = () => {
  const store = { addEventListener: (t, f) => { (global.__ls = global.__ls || {})[t] = f; }, value: '', innerHTML: '', dataset: {}, style: {}, children: [] };
  const p = new Proxy(function () {}, {
    get: (t, k) => k in store ? store[k] : k === 'querySelectorAll' ? () => [] : k === 'closest' ? () => null : k === 'contains' ? () => true : k === Symbol.toPrimitive ? () => '' : (() => p),
    set: (t, k, v) => { store[k] = v; return true; }, apply: () => p
  });
  return p;
};
const root = mkEl();
const calls = []; let handlers = {};
const pending = [];   // controllable matches responses
const api = {
  invoke: (ch, a) => {
    calls.push([ch, a]);
    if (ch === 'profile:lookup') return Promise.resolve({ ok: true, stale: false, profile: { gameName: a.gameName, tagLine: a.tagLine, platform: a.platform, puuid: 'PU_' + a.gameName, ranked: [], mastery: [], isOwner: false, summonerLevel: 1, profileIconId: 1 } });
    if (ch === 'profile:matches') return new Promise(res => pending.push({ a, res }));
    if (ch === 'profile:ledger') return Promise.resolve({ ok: true, rows: [] });
    if (ch === 'profile:static') return Promise.resolve({ ok: true, queues: {} });
    return Promise.resolve({ ok: true });
  },
  on: (c, f) => { handlers[c] = f; }
};
const window = { electronAPI: { feature: api, getSettings: async () => ({}), saveSettings: async () => true }, DD: { ready: Promise.resolve(), currentView: () => 'profile', onView: () => {}, getChampions: () => [], getLatestPatch: () => '16.19.1', ddragonBase: 'http://x' } };
const document = { getElementById: () => root, createElement: () => mkEl(), body: mkEl(), documentElement: mkEl() };
const ctx = vm.createContext({ window, document, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, fetch: async () => ({ ok: false, json: async () => ({}) }), Date, Promise, Map, Set, Math, JSON, Object, Array, String, Number, encodeURIComponent });
vm.runInContext(src, ctx);
const tick = () => new Promise(r => setTimeout(r, 20));
const matchRes = (id, a) => ({ ok: true, puuid: a.puuid, group: a.group, start: 0, nextStart: 1, hasMore: false, matches: [{ id, queueId: 450, players: [{ puuid: a.puuid, champId: 1, win: true, items: [0,0,0,0,0,0,0], k: 1, d: 1, a: 1, cs: 1, vis: 1, kp: 1, dmg: 1, gold: 1, lvl: 1, team: 100, name: 'x', tag: 'y', pos: '' }], teams: [], dur: 1500, end: 1 }] });
(async () => {
  await tick(); await tick();
  const S = window.DDProfile.state;
  // initial default account load is pending; supersede with A then B
  for (const n of ['A', 'B']) { window.DDProfile.open({ gameName: n, tagLine: 'T', platform: 'EUW1' }); await tick(); }
  const pend = pending.filter(p => !p.done);
  assert(pend.length >= 2, 'two matches loads in flight: ' + pend.length);
  const forA = pend.filter(p => p.a.puuid === 'PU_A'), forB = pend.filter(p => p.a.puuid === 'PU_B');
  assert(forA.length === 1 && forB.length === 1, 'B started its own load while A was loading (' + forA.length + ',' + forB.length + ')');
  forB[0].res(matchRes('B1', forB[0].a)); await tick();
  forA[0].res(matchRes('A1', forA[0].a)); await tick();
  assert.strictEqual(JSON.stringify(S.matches.map(m => m.id)), JSON.stringify(['B1'])); assert.strictEqual(S.loadingMatches, false);
  console.log('account switch mid-load: B shows its games, stale A response ignored, flag cleared');
  // queue tab switch mid-load
  pending.length = 0;
  window.DDProfile.open({ gameName: 'C', tagLine: 'T', platform: 'EUW1' }); await tick();
  const c0 = pending.pop(); c0.res(matchRes('C1', c0.a)); await tick();
  const click = (g) => { const t = { dataset: { act: 'group', g }, closest: () => t }; return global.__ls.click({ target: t, stopPropagation() {} }); };
  click('aram'); await tick(); click('solo'); await tick();
  const reqs = pending.splice(0);
  const solo = reqs.find(r => r.a.group === 'solo'), aram = reqs.find(r => r.a.group === 'aram');
  assert(solo && aram, 'both tab loads were issued (second not dropped by the loading guard)');
  solo.res({ ...matchRes('S1', solo.a), group: 'solo' }); await tick(); aram.res({ ...matchRes('R1', aram.a), group: 'aram' }); await tick();
  assert.strictEqual(JSON.stringify(S.matches.map(m => m.id)), JSON.stringify(['S1'])); assert.strictEqual(S.loadingMatches, false);
  console.log('tab switch mid-load: latest tab wins, stale response ignored');
})().then(() => { console.log('ALL OK'); process.exit(0); }).catch(e => { console.error('FAIL', e); process.exit(1); });
