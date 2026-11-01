// Node test (ELECTRON_RUN_AS_NODE) for replay-main.js against a stub LCU on 127.0.0.1 (code review 2026-11-01, B1-F5 / C-F15):
// `running` is per game (only the game this app opened, while the Replay API answers), and replay-open waits while the
// replay is still being checked or downloaded instead of failing with "not available (checking)".
const https = require('https'), fs = require('fs'), path = require('path'), assert = require('assert');
const tls = { key: fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'lcu', 'key.pem')), cert: fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'lcu', 'cert.pem')) };
const st = { meta: {}, log: [] };   // meta[gameId]: states returned one per GET (the last one repeats)
const lcuSrv = https.createServer(tls, (req, res) => {
    req.resume();
    req.on('end', () => {
        st.log.push(req.method + ' ' + req.url);
        const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
        let m;
        if ((m = req.url.match(/^\/lol-replays\/v1\/metadata\/(\d+)$/))) { const q = st.meta[m[1]]; if (!q) return send(404, {}); return send(200, { state: q.length > 1 ? q.shift() : q[0] }); }
        if ((m = req.url.match(/^\/lol-replays\/v1\/rofls\/(\d+)\/(watch|download)$/)) && req.method === 'POST') return send(204);
        send(404, { message: 'nope' });
    });
});
// the game's Replay API (127.0.0.1:2999) while a replay is open
const replaySrv = https.createServer(tls, (req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"time":1}'); }); });
const listen = (srv, port) => new Promise(res => { srv.once('error', () => res(false)); srv.listen(port, '127.0.0.1', () => res(true)); });

(async () => {
    await listen(lcuSrv, 0);
    const port = lcuSrv.address().port;
    const handlers = {};
    require(path.join(__dirname, '..', '..', 'replay-main.js')).register({ ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, getLeagueCredentials: async () => ({ port, password: 'pw' }), lcuRequest: async () => null });
    const call = (ch, a) => handlers[ch]({}, a);
    st.meta['101'] = ['watch']; st.meta['102'] = ['watch'];

    const apiUp = await listen(replaySrv, 2999);
    if (apiUp) {
        let r = await call('lcu:replay-state', { gameId: 'EUW1_101' });
        assert.strictEqual(r.ok, true); assert.strictEqual(r.state, 'watch');
        assert.strictEqual(r.running, false, 'a replay answers on :2999, but this app opened none: not "running" for this game');
        r = await call('lcu:replay-open', { gameId: 'EUW1_101' });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.strictEqual((await call('lcu:replay-state', { gameId: 'EUW1_101' })).running, true, 'the game just opened is running');
        assert.strictEqual((await call('lcu:replay-state', { gameId: 'EUW1_102' })).running, false, 'another game is not (its "Watch from" opens its own replay)');
        await new Promise(res => replaySrv.close(res));
        assert.strictEqual((await call('lcu:replay-state', { gameId: 'EUW1_101' })).running, false, 'replay closed (API down): not running any more');
        console.log('running: per game, and only while the Replay API answers');
    } else console.log('SKIP the running checks: port 2999 is in use on this machine');

    // still being checked, then to download: replay-open waits, asks for the download once, then opens it
    st.meta['103'] = ['checking', 'download', 'downloading', 'watch'];
    st.log.length = 0;
    const r3 = await call('lcu:replay-open', { gameId: 'EUW1_103' });
    assert.strictEqual(r3.ok, true, JSON.stringify(r3));
    assert.strictEqual(st.log.filter(l => l === 'POST /lol-replays/v1/rofls/103/download').length, 1, 'the download is asked for once: ' + st.log.join(', '));
    assert(st.log.includes('POST /lol-replays/v1/rofls/103/watch'), 'then the replay is opened');
    console.log('replay-open waits through checking / download / downloading');
    // a replay that is gone still fails at once with the patch message
    st.meta['104'] = ['missingOrExpired'];
    const r4 = await call('lcu:replay-open', { gameId: 'EUW1_104' });
    assert.strictEqual(r4.ok, false); assert(/older patch or has expired/.test(r4.error), r4.error);
    console.log('an expired replay fails at once');
})().then(() => { console.log('ALL OK'); process.exit(0); }).catch(e => { console.error('FAIL', e); process.exit(1); });
