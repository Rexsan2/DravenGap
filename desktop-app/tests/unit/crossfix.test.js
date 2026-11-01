// Cross-owner hand-offs (fixer XO, 2026-11-01): main-process changes other fixers asked for in files they did not own.
//   B1-F22 / B2-F14  profile-main.js matchesFor: a game recorded from the client that is older than the last row kept on a page but
//                    newer than a dropped Arena game at the end of it lands on that page (it used to fall between two pages)
//   D1-F16           profile-main.js profile:me returns the queue of the current phase (champion select / in game)
//   B2-F16           main.js getLeagueCredentials: both process spawns (wmic, PowerShell) are killed after 10 s
const assert = require('assert'); const fs = require('fs'); const http = require('http');
const { APP, scratch, waitFor } = require('../lib/common');
const RS = require('../lib/riot-stub');
const rh = require(APP + 'riot-history');
const C = require(APP + 'profile-compact');
const pm = require(APP + 'profile-main');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };

const OWN = ('PXO').padEnd(78, 'x');
// a match-v5 game of OWN (riot-stub's shape), ending at `end`, in queue q
const mk = (gameId, end, q = 420) => { const r = RS.match(0, OWN); r.metadata.matchId = 'EUW1_' + gameId; r.info.gameId = gameId; r.info.gameEndTimestamp = end; r.info.queueId = q; if (q === 1700) r.info.gameMode = 'CHERRY'; return r; };

// A Riot stub serving `ids` (newest first) and `matches`
function stub(ids, matches) {
    const srv = http.createServer((req, res) => {
        const u = req.url, send = (c, b) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
        let m;
        if ((m = u.match(/ids\?start=(\d+)&count=(\d+)/))) return send(200, ids.slice(+m[1], +m[1] + +m[2]));
        if ((m = u.match(/matches\/([A-Z0-9]+_\d+)$/))) { const raw = matches.get(m[1]); return raw ? send(200, raw) : send(404, {}); }
        send(404, {});
    });
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}
function reg(port, extra = {}) {
    const handlers = {}, pushes = [];
    const ctl = pm.register({ ipcMain: { handle: (c, f) => handlers[c] = f }, userDataPath: scratch('xofix'), getRiotApiKey: () => 'ok', getLeagueCredentials: async () => { throw new Error('none'); }, lcuRequest: async () => null,
        sendToWindow: (c, p) => pushes.push([c, p]), riotBaseUrl: () => 'http://127.0.0.1:' + port, noPoll: true, queuesUrl: 'http://127.0.0.1:1/x', cdQueuesUrl: 'http://127.0.0.1:1/y', limiter: new rh.RateLimiter(), ...extra });
    return { call: (c, a) => handlers['profile:' + c]({}, a), pushes, ctl };
}

(async () => {
    // ---------- B1-F22 / B2-F14: 30 games; the first page's last 5 ids are Arena (dropped from "All"), and an ARAM Mayhem game recorded
    // from the client ended between the last game kept (15 h ago) and those Arena games (16-20 h ago)
    {
        const H = 3600e3, now = Date.now(), ids = [], matches = new Map();
        for (let i = 0; i < 30; i++) { const id = 'EUW1_' + (5000 - i); ids.push(id); matches.set(id, mk(5000 - i, now - (i + 1) * H, i >= 15 && i < 20 ? 1700 : 420)); }
        const S = await stub(ids, matches), R = reg(S.port);
        const LCU_ID = 'EUW1_7777', lraw = mk(7777, now - 15.5 * H, 2400);
        lraw.metadata.src = 'lcu';
        await R.ctl.cache.putMatch(LCU_ID, lraw);
        const doc = R.ctl.cache.player(OWN);
        doc.rows[LCU_ID] = C.ledgerRow(C.compactMatch(lraw), OWN); doc.lcu = [LCU_ID];
        R.ctl.cache.savePlayer(OWN);
        const p1 = await R.call('matches', { puuid: OWN, platform: 'EUW1', group: 'all' });
        ok(p1.ok && p1.hasMore && p1.nextStart === 20, 'page 1 scanned 20 ids and has more: ' + JSON.stringify({ ok: p1.ok, hasMore: p1.hasMore, next: p1.nextStart, err: p1.error }));
        ok(!p1.matches.some(m => m.queueId === 1700), 'the Arena games are not in "All"');
        const p2 = await R.call('matches', { puuid: OWN, platform: 'EUW1', group: 'all', start: p1.nextStart });
        const seen = [...p1.matches, ...p2.matches].filter(m => m.id === LCU_ID).length;
        ok(seen === 1, `the client-recorded game is on exactly one page (page 1: ${p1.matches.some(m => m.id === LCU_ID)}, page 2: ${p2.matches.some(m => m.id === LCU_ID)})`);
        ok(p1.matches.some(m => m.id === LCU_ID), 'and it is on page 1, after the last game kept, in time order: ' + p1.matches.map(m => m.id).slice(-3).join(','));
        // a client game older than the last id of page 1 still goes to page 2 (no duplicate, nothing lost)
        const OLD_ID = 'EUW1_7778', oraw = mk(7778, now - 22.5 * H, 2400); oraw.metadata.src = 'lcu';
        await R.ctl.cache.putMatch(OLD_ID, oraw);
        doc.rows[OLD_ID] = C.ledgerRow(C.compactMatch(oraw), OWN); doc.lcu.push(OLD_ID); R.ctl.cache.savePlayer(OWN);
        const q1 = await R.call('matches', { puuid: OWN, platform: 'EUW1', group: 'all' }), q2 = await R.call('matches', { puuid: OWN, platform: 'EUW1', group: 'all', start: q1.nextStart });
        ok(!q1.matches.some(m => m.id === OLD_ID) && q2.matches.filter(m => m.id === OLD_ID).length === 1 && q2.matches.findIndex(m => m.id === OLD_ID) === 2,
            'an older client game is on page 2, between the games around it: ' + q2.matches.map(m => m.id).slice(0, 4).join(','));
        S.srv.close(); console.log('B1-F22 / B2-F14 client games between two pages ok');
    }

    // ---------- D1-F16: profile:me carries the queue of the current phase
    {
        let phase = 'None', queue = null;
        const lcuRequest = async p => {
            if (p.includes('gameflow-phase')) return phase;
            if (p.includes('/lol-gameflow/v1/session')) return queue ? { phase, gameData: { gameId: 42, queue: { id: queue }, teamOne: [], teamTwo: [] } } : null;
            return null;
        };
        const R = reg(1, { noPoll: false, pollMs: 50, pollStartDelay: 10, getLeagueCredentials: async () => ({ port: 1 }), lcuRequest });
        const phasePushed = next => waitFor(() => R.pushes.some(p => p[0] === 'profile:phase' && p[1].next === next), 3000);
        await phasePushed('None');
        let r = await R.call('me', {});
        ok(r.ok && r.phase === 'None' && r.queueId === null, 'no game: no queue: ' + JSON.stringify(r));
        phase = 'ChampSelect'; queue = 2400;
        await phasePushed('ChampSelect');
        r = await R.call('me', {});
        ok(r.phase === 'ChampSelect' && r.queueId === 2400, 'ARAM Mayhem champion select: queueId 2400: ' + JSON.stringify(r));
        phase = 'Lobby'; queue = 1700;   // (the lobby's queue is not read: the bar has no mode action there)
        await phasePushed('Lobby');
        r = await R.call('me', {});
        ok(r.phase === 'Lobby' && r.queueId === null, 'back in the lobby: no queue: ' + JSON.stringify(r));
        phase = 'InProgress';
        await phasePushed('InProgress');
        r = await R.call('me', {});
        ok(r.phase === 'InProgress' && r.queueId === 1700, 'in an Arena game: queueId 1700: ' + JSON.stringify(r));
        R.ctl.poller.stop();
        console.log('D1-F16 profile:me queueId ok');
    }

    // ---------- B2-F16: main.js getLeagueCredentials passes { timeout: 10000 } to both exec calls (run from main.js's own source)
    {
        const src = fs.readFileSync(APP + 'main.js', 'utf8');
        const a = src.indexOf('async function getLeagueCredentials()'), b = src.indexOf('const httpsAgent', a);
        ok(a > 0 && b > a, 'getLeagueCredentials found in main.js');
        // exec(cmd[, opts], cb) as child_process has it, so a call without options is reported, not a crash
        const load = exec => new Function('exec', src.slice(a, b) + '\nreturn getLeagueCredentials;')((cmd, opts, cb) => (typeof opts === 'function' ? exec(cmd, undefined, opts) : exec(cmd, opts, cb)));
        // both spawns hang until exec's timeout kills them (exec then calls back with an error): the lookup fails instead of hanging
        let calls = [];
        const killed = (cmd, opts, cb) => { calls.push({ cmd, opts }); setTimeout(() => cb(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), ''), 5); };
        const e = await load(killed)().then(() => null, err => err);
        ok(e && /not found/.test(e.message) && calls.length === 2, 'two attempts, then a rejection: ' + (e && e.message));
        ok(calls.every(c => typeof c.cmd === 'string' && c.opts && c.opts.timeout === 10000), 'wmic and PowerShell each get { timeout: 10000 }: ' + JSON.stringify(calls.map(c => c.opts)));
        ok(/wmic/.test(calls[0].cmd) && /powershell/i.test(calls[1].cmd), 'wmic first, PowerShell second');
        // the PowerShell answer still works
        calls = [];
        const ps = (cmd, opts, cb) => { calls.push({ cmd, opts }); setTimeout(() => (/wmic/.test(cmd) ? cb(new Error('wmic removed'), '') : cb(null, 'LeagueClientUx.exe --app-port=51234 --remoting-auth-token=abc-DEF_1')), 5); };
        const c = await load(ps)();
        ok(c && c.port === '51234' && c.password === 'abc-DEF_1', 'credentials read from the PowerShell output: ' + JSON.stringify(c));
        console.log('B2-F16 exec timeouts ok');
    }

    console.log('ALL OK', n, 'checks'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
