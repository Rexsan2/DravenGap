// Settings > Diagnostics, main-process side: store sizes, coachless-resume clear, the report (no keys), the log ring,
// profile:diag / profile:cache-clear and the ARAM cache clear.
const assert = require('assert'), fs = require('fs'), path = require('path');
const { APP, scratch } = require('../lib/common');
const { start } = require('../lib/riot-stub');
const D = require(APP + 'diagnostics-main');

(async () => {
    // ---- store sizes + clear + export
    const ud = scratch('diag'), out = scratch('diag-out');
    fs.mkdirSync(path.join(ud, 'profile-cache', 'matches'), { recursive: true });
    fs.writeFileSync(path.join(ud, 'profile-cache', 'matches', 'EUW1_1.json.gz'), Buffer.alloc(3000, 1));
    fs.writeFileSync(path.join(ud, 'profile-cache', 'matches', 'EUW1_2.json.gz'), Buffer.alloc(2000, 1));
    fs.writeFileSync(path.join(ud, 'personal-history.json'), '{"x":[]}');
    fs.mkdirSync(path.join(ud, 'coachless-resume'), { recursive: true });
    fs.writeFileSync(path.join(ud, 'coachless-resume', '16.18.json'), '{}');
    const ring = D.createLogRing(5);
    for (let i = 0; i < 8; i++) ring.add('log', ['line', i]);
    ring.add('error', ['key RGAPI-12345678-aaaa-bbbb-cccc-1234567890ab rejected', new Error('boom')]);
    assert.strictEqual(ring.lines().length, 5, 'ring keeps the last N');
    assert(!ring.lines().some(l => l.includes('12345678-aaaa')) && ring.lines().some(l => l.includes('RGAPI-[redacted]')), 'keys redacted in the ring');
    const handlers = {}; let revealed = null, running = false;
    D.register({ ipcMain: { handle: (c, f) => handlers[c] = f }, userDataPath: ud, getLogs: ring.lines,
        coachless: { rateLimitStatus: () => ({ blockedUntil: 0 }), isRunning: () => running }, appInfo: () => ({ version: '9.9.9', electron: 'x' }),
        exportDir: () => out, reveal: f => { revealed = f; } });
    const call = (c, a) => handlers['diag:' + c]({}, a);
    let r = await call('info');
    const st = id => r.stores.find(s => s.id === id);
    assert(r.ok && st('profile-matches').bytes === 5000 && st('profile-matches').files === 2 && st('personal-history').files === 1 && st('aram').bytes === 0, JSON.stringify(r.stores));
    assert(st('profile-matches').newest > Date.now() - 60e3 && r.app.version === '9.9.9');
    console.log('info ok', r.stores.length, 'stores');
    running = true; r = await call('clear', { id: 'coachless-resume' }); assert(!r.ok && /running/.test(r.error), 'not while a download runs');
    running = false; r = await call('clear', { id: 'coachless-resume' }); assert(r.ok && r.removed === 1 && fs.readdirSync(path.join(ud, 'coachless-resume')).length === 0);
    r = await call('clear', { id: 'profile-matches' }); assert(!r.ok, 'other stores are cleared by their own module');
    console.log('clear ok');
    r = await call('export', { renderer: { draft: { selected: 'Current Patch · Emerald+', games: 1234 }, note: 'RGAPI-abcdef12-3456-7890-abcd-ef1234567890' } });
    assert(r.ok && r.file.startsWith(out) && revealed === r.file, JSON.stringify(r));
    const text = fs.readFileSync(r.file, 'utf8');
    assert(/version: 9\.9\.9/.test(text) && /Profile: downloaded matches: 5 KB in 2 file/.test(text) && /draft\.selected: Current Patch/.test(text), text.slice(0, 400));
    assert(!/abcdef12-3456/.test(text) && !/12345678-aaaa/.test(text), 'no key in the report');
    console.log('export ok', path.basename(r.file));

    // ---- profile:diag / profile:cache-clear
    const S = await start(); const pdir = scratch('pdiag');
    const ph = {}; const rh = require(APP + 'riot-history');
    require(APP + 'profile-main').register({ ipcMain: { handle: (c, f) => ph[c] = f }, userDataPath: pdir, getRiotApiKey: () => 'ok', getLeagueCredentials: async () => { throw new Error('none'); }, lcuRequest: async () => null,
        sendToWindow: () => {}, riotBaseUrl: () => 'http://127.0.0.1:' + S.port, noPoll: true, limiter: new rh.RateLimiter(), queuesUrl: 'http://127.0.0.1:1/x' });
    const pc = (n, a) => ph['profile:' + n]({}, a);
    await pc('lookup', { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' });
    r = await pc('diag');
    assert(r.ok && r.riot.keySet && r.riot.requests >= 3 && r.riot.windows.length === 2 && r.riot.windows[0].used >= 3 && r.opgg.blockedUntil === 0 && r.lcu.up === false, JSON.stringify(r));
    let n0 = S.log.length;
    await pc('lookup', { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' }); assert.strictEqual(S.log.length, n0, 'cached lookup');
    r = await pc('cache-clear', { what: 'lookups' }); assert(r.ok && r.removed >= 4, JSON.stringify(r));
    n0 = S.log.length; await pc('lookup', { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' }); assert(S.log.length > n0, 'after clearing, the lookup goes to the network again');
    r = await pc('cache-clear', { what: 'nope' }); assert(!r.ok && r.code === 'BAD_INPUT');
    r = await pc('cache-clear', { what: 'opgg-backoff' }); assert(r.ok);
    console.log('profile diag + cache-clear ok');
    S.srv.close();

    // ---- ARAM cache clear
    const am = require(APP + 'aram-main')._internals;
    const adir = scratch('aram');
    const cache = am.createCache(adir);
    cache.set('tier-list', { a: 1 }); cache.set('champ-teemo', { b: 2 });
    assert.strictEqual(cache.list().length, 2); assert(cache.list()[0].at > 0, 'list has file times');
    assert.strictEqual(cache.clear(), 2); assert.strictEqual(cache.list().length, 0); assert.strictEqual(cache.get('tier-list'), null, 'memory dropped too');
    console.log('aram cache clear ok');
    console.log('ALL OK'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
