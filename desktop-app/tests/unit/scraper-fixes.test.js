// Node test (ELECTRON_RUN_AS_NODE) for lolalytics-scraper.js (code review A2-F7): pages that keep failing (403 / 429 / 5xx / network)
// are counted as `failed`, while combos LoLalytics has no page for (another 4xx) are not; a dataset with some failures still comes
// back (the window keeps it only as partial), and transient failures are retried. No network: https.get is stubbed.
const path = require('path'), assert = require('assert'), https = require('https'), { EventEmitter } = require('events'), zlib = require('zlib');
const L = require(path.join(__dirname, '..', '..', 'lolalytics-scraper.js'));
L._timing.requestDelayMs = 0; L._timing.backoffMs = 1;

const ROLES = ['top', 'jungle', 'middle', 'bottom', 'support'];
const names = ['Aatrox', 'Ahri', 'Akali', 'Alistar', 'Amumu', 'Anivia', 'Annie', 'Ashe', 'Azir', 'Bard'];
const idToName = {}; names.forEach((n, i) => { idToName[String(100 + i)] = n; });
const championList = { names, idToName };
const page = (n = 500) => `<html><script type="qwik/json">${JSON.stringify({ objs: [{ analysed: true, enemy: '1', header: '2' }, { top: [[101, 52, 0, 1.5, 0, 300]] }, { n, wr: 51, pr: 5 }] })}</script></html>`;

let plan = () => 200, seen = {};
https.get = (url, opts, cb) => {
    const req = new EventEmitter();
    req.destroy = e => setImmediate(() => req.emit('error', e || new Error('destroyed')));
    setImmediate(() => {
        const u = new URL(url), team = u.hostname === 'a1.lolalytics.com';
        const champ = team ? u.searchParams.get('c') : u.pathname.split('/')[2], lane = team ? u.searchParams.get('lane') : u.searchParams.get('lane');
        const id = `${team ? 'team' : 'page'}|${champ}|${lane}`;
        seen[id] = (seen[id] || 0) + 1;
        const status = plan(team, names.findIndex(n => n.toLowerCase() === champ), ROLES.indexOf(lane), seen[id]);
        if (status === 'neterr') { req.emit('error', new Error('ECONNRESET')); return; }
        const res = new EventEmitter();
        res.statusCode = status; res.setEncoding = () => {};
        cb(res);
        res.emit('data', status !== 200 ? 'no' : team ? JSON.stringify({ team: { jungle: [[102, 50, 0, -0.5, 0, 200]] } }) : page());
        res.emit('end');
    });
    return req;
};

(async () => {
    try {
        // 1) 30% of champion pages answer 403 every time (failed), 10% answer 404 (no page for that combo: not a failure), the rest 200
        plan = (team, c, r) => { if (team) return 200; const k = (c * 5 + r) % 10; return k < 3 ? 403 : k === 3 ? 404 : 200; };
        seen = {};
        const a = await L.scrapeDataset({ period: '16.20', rank: 'emerald_plus', championList });
        assert.strictEqual(a.requested, 50, 'requested combos');
        assert.strictEqual(a.failed, 15, '403 pages counted as failed: ' + a.failed);
        assert.strictEqual(a.combos, 30, 'combos with data: ' + a.combos);
        assert.strictEqual(seen['page|aatrox|top'], 3, 'a 403 page is tried three times: ' + seen['page|aatrox|top']);
        assert.strictEqual(seen['page|aatrox|bottom'], 1, 'a 404 page is not retried: ' + seen['page|aatrox|bottom']);
        const st = JSON.parse(zlib.gunzipSync(a.statsGz));
        assert(st.length === 30 && st.every(s => s.games === 500), 'stats of the combos that worked');

        // 2) a 404-only dataset is "no data", with no failures mentioned; every page failing says how many failed
        plan = (team) => (team ? 200 : 404); seen = {};
        await assert.rejects(L.scrapeDataset({ period: '16.20', rank: 'emerald_plus', championList }), e => /no data/.test(e.message) && !/failed/.test(e.message));
        plan = (team) => (team ? 200 : 503); seen = {};
        await assert.rejects(L.scrapeDataset({ period: '16.20', rank: 'emerald_plus', championList }), e => /50 pages failed/.test(e.message));

        // 3) transient failures (a 429, a network error) are retried and then count as fine
        plan = (team, c, r, n) => (n === 1 && !team ? ((c + r) % 2 ? 429 : 'neterr') : 200); seen = {};
        const c = await L.scrapeDataset({ period: '16.20', rank: 'emerald_plus', championList });
        assert.strictEqual(c.failed, 0, 'retried pages are not failures: ' + c.failed);
        assert.strictEqual(c.combos, 50, 'all combos: ' + c.combos);

        // 4) a synergy request that keeps failing marks its combo failed, but its matchups are kept
        plan = (team, ci, r) => (team && ci === 0 && r === 0 ? 500 : 200); seen = {};
        const d = await L.scrapeDataset({ period: '16.20', rank: 'emerald_plus', championList });
        const m = JSON.parse(zlib.gunzipSync(d.matchupsGz));
        assert.strictEqual(d.failed, 1, 'one combo without synergies: ' + d.failed);
        assert(m[JSON.stringify(['Aatrox', 'TOP', 'Ahri', 'TOP', 'enemy'])], 'its matchups are kept');
        assert(!m[JSON.stringify(['Aatrox', 'TOP', 'Akali', 'JUNGLE', 'teammate'])] && m[JSON.stringify(['Aatrox', 'JUNGLE', 'Akali', 'JUNGLE', 'teammate'])], 'only its synergies are missing');

        // 5) latestPatch: a page that keeps failing is null, not an exception
        plan = () => 503; seen = {};
        assert.strictEqual(await L.latestPatch(), null);
        console.log('PASS | lolalytics scraper: failed pages counted, 4xx without a page not, retries, partial results (A2-F7)');
        console.log('SUMMARY 1 pass 0 fail');
    } catch (e) {
        console.log('FAIL | lolalytics scraper fixes | ' + (e && e.stack || e));
        process.exitCode = 1;
    }
})();
