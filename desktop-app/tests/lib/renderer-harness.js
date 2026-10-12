// Renderer harness: boots the real index.html + preload.js in a hidden Electron window with
//  - a scratch userData folder (never %APPDATA%\draftdiff),
//  - stub IPC handlers for every channel the window calls (override any of them with `ipc`),
//  - a fake R2 bucket + Data Dragon on 127.0.0.1; every other http(s) request is cancelled (no real network).
const { app, BrowserWindow, ipcMain, session } = require('electron');
const http = require('http'), fs = require('fs'), path = require('path');
const { APP, fixture, scratch } = require('./common');

const R2_HOST = 'pub-1efd88d862814361909e5510d7af1c1a.r2.dev';
const stats = JSON.parse(fixture('data/champion_stats_patch_platplus.json'));
const champJson = fixture('data/ddragon_champion.json', null);

// small deterministic matchup table from the first 60 champion-roles of the stats file
function makeMatchups(seed) {
    const out = {};
    const top = stats.slice(0, 60);
    let r = seed;
    const rnd = () => { r = (r * 1103515245 + 12345) & 0x7fffffff; return r / 0x7fffffff; };
    for (const a of top) for (const b of top) {
        if (a.champion === b.champion) continue;
        const rel = a.role === b.role ? 'enemy' : 'teammate';
        out[JSON.stringify([a.champion, a.role, b.champion, b.role, rel])] = { win_rate: 0.45 + rnd() * 0.1, delta2: (rnd() - 0.5) * 0.04, total_games: 300 + Math.floor(rnd() * 3000) };
    }
    return out;
}
const makeMeta = (iso, patch) => ({ last_updated_utc: iso, patch, total_games_by_dataset: { patch_platinum_plus: 120000, '30_platinum_plus': 900000, patch_all: 400000, '30_all': 1500000, patch_gold: 80000 } });

const S = { meta: makeMeta(new Date().toISOString(), '16.19.1'), log: [], delay: 0, down: false, ddVersions: ['16.19.1', '16.18.1', '16.17.1'], seed: 1 };

function startServer() {
    return new Promise(res => {
        const srv = http.createServer((req, rsp) => {
            const u = new URL(req.url, 'http://x');
            const h = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
            if (S.down && u.pathname.startsWith('/r2')) { rsp.destroy(); return; }
            const send = (code, body, type = 'application/json') => { rsp.writeHead(code, { ...h, 'Content-Type': type }); rsp.end(body); };
            if (u.pathname.startsWith('/r2')) {
                const p = u.pathname.slice(3);
                S.log.push('R2 ' + p);
                if (p === '/metadata.json') return send(200, JSON.stringify(S.meta));
                const later = fn => setTimeout(fn, S.delay);
                if (/^\/(patch|days_30)\/[a-z_]+\/all\/champion_stats\.json$/.test(p)) return later(() => send(200, JSON.stringify(stats)));
                if (/^\/(patch|days_30)\/[a-z_]+\/all\/matchup_winrates\.json$/.test(p)) return later(() => send(200, JSON.stringify(makeMatchups(S.seed))));
                return send(404, '{}');
            }
            if (u.pathname.startsWith('/dd')) {
                const p = u.pathname.slice(3);
                S.log.push('DD ' + p);
                if (p === '/api/versions.json') return send(200, JSON.stringify(S.ddVersions));
                if (/champion\.json$/.test(p)) return send(200, champJson);
                return send(404, '{}');
            }
            send(404, '{}');
        });
        srv.listen(0, '127.0.0.1', () => res(srv));
    });
}

const MAIN_CHANNELS = ['get-favorites', 'save-favorites', 'get-settings', 'save-settings', 'get-champ-select', 'get-pickable-champions', 'get-personal-stats',
    'get-riot-key-status', 'set-riot-key', 'sync-riot-history', 'scrape-start', 'scrape-cancel', 'coachless-patches', 'coachless-start', 'coachless-cancel',
    'coachless-stored', 'coachless-status', 'coachless-detail', 'coachless-champion', 'coachless-rate-status'];
const FEATURE_CHANNELS = ['profile:backfill', 'profile:backfill-cancel', 'profile:emblems', 'profile:insights', 'profile:ledger', 'profile:live', 'profile:lookup',
    'profile:matches', 'profile:match', 'profile:me', 'profile:played', 'profile:progress', 'profile:refresh', 'profile:scout', 'profile:seasons', 'profile:static',
    'profile:test-key', 'profile:timeline', 'profile:owner', 'profile:session', 'profile:lp-history', 'profile:duo', 'profile:duo-history', 'profile:champ-summary', 'profile:multi',
    'aram:champ-snapshot', 'build:skills', 'arena:tier-list', 'arena:champ-select',   // (mini:* and diag:* are left out: some tests register the real mini-main / diagnostics-main)
    'aram:cache-info', 'aram:champ-select', 'aram:champion', 'aram:items', 'aram:tier-list', 'lcu:status', 'lcu:apply-runes', 'lcu:apply-spells', 'lcu:apply-itemset'];

// userData: reuse a folder across restarts (several boots of one test); default is a new scratch folder.
// offscreen: render without a visible window but keep painting, so screenshots (shot) are current
// onboarding: true = leave settings.onboardingDone unset, so the first-run setup card runs (default: marked done)
exports.boot = async function boot({ userData, meta, ipc = {}, show = false, offscreen = false, size = [1280, 800], settings = { timePeriod: 'patch', rank: 'platinum_plus' }, onboarding = false, builtinKey = false } = {}) {
    const ud = userData || scratch('ui');
    app.setPath('userData', ud);
    if (meta) S.meta = meta;
    await app.whenReady();
    const srv = await startServer();
    const port = srv.address().port;
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (d, cb) => {
        const u = new URL(d.url);
        if (u.hostname === '127.0.0.1') return cb({});
        if (u.hostname === R2_HOST) return cb({ redirectURL: `http://127.0.0.1:${port}/r2${u.pathname}${u.search}` });
        if (u.hostname === 'ddragon.leagueoflegends.com') return cb({ redirectURL: `http://127.0.0.1:${port}/dd${u.pathname}${u.search}` });
        cb({ cancel: true });
    });
    // the first-run setup card (onboarding.js) is off unless a test asks for it (onboarding: true leaves onboardingDone unset)
    let saved = JSON.parse(JSON.stringify(onboarding ? settings : { onboardingDone: true, ...settings }));
    const calls = [], scrapeCalls = [];
    const defaults = {
        'get-favorites': () => ({}), 'save-favorites': () => true,
        'get-settings': () => JSON.parse(JSON.stringify(saved)), 'save-settings': (e, s) => { saved = s; return true; },
        'get-riot-key-status': () => ({ set: false, hint: null }), 'set-riot-key': () => ({ ok: true, set: false, hint: null }),
        'sync-riot-history': () => ({ added: 0, games: [] }), 'scrape-cancel': () => true,
        'scrape-start': (e, jobs, opts) => { scrapeCalls.push({ jobs, opts }); return ipc.scrapeStart ? ipc.scrapeStart(jobs, opts) : { ok: true }; },
        'coachless-status': () => ({ running: false, jobs: [], index: 0 }), 'coachless-rate-status': () => ({ blockedUntil: 0 }), 'coachless-patches': () => [],
        'lcu:status': () => ({ ok: false, code: 'NO_CLIENT', error: 'League client not running (test)' })
    };
    ipcMain.removeAllListeners('is-builtin-key');
    ipcMain.on('is-builtin-key', e => { e.returnValue = !!builtinKey; });   // personal build (builtin-mode.js)
    for (const ch of new Set([...MAIN_CHANNELS, ...FEATURE_CHANNELS, ...Object.keys(ipc).filter(k => k.includes(':') || k.includes('-'))])) {
        const fn = ipc[ch] || defaults[ch] || (() => (ch.includes(':') ? { ok: false, code: 'TEST', error: 'not available in tests' } : null));
        ipcMain.removeHandler(ch);   // a second boot in the same test replaces the first one's handlers
        ipcMain.handle(ch, async (e, ...a) => { calls.push([ch, a]); return fn(e, ...a); });
    }
    const w = new BrowserWindow({ show, width: size[0], height: size[1], webPreferences: { preload: APP + 'preload.js', contextIsolation: true, sandbox: false, offscreen } });
    if (offscreen) w.webContents.setFrameRate(30);
    const logs = [];
    w.webContents.on('console-message', (e, ...a) => { const m = (e && e.message) ? e.message : a[1]; if (!/Security Warning|^For more|Policy|this app|once the|^$/.test(m || '')) logs.push(String(m).slice(0, 300)); });
    await w.loadFile(APP + 'index.html');
    const ev = code => w.webContents.executeJavaScript(code);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const waitFor = async (code, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(code)) return true; } catch (e) { /* page reloading */ } await sleep(50); } return false; };
    const shot = async file => { const img = await w.webContents.capturePage(); fs.writeFileSync(file, img.toPNG()); };
    // close(): destroys the window so the same test can boot again (e.g. a second start with the same userData)
    // (the page is unloaded, not the window: destroying the last window quits Electron)
    const close = async () => { await w.loadURL('about:blank'); w.hide(); };
    return { w, ev, sleep, waitFor, shot, close, S, calls, scrapeCalls, logs, srv, userData: ud, settings: () => saved, send: (ch, p) => w.webContents.send(ch, p) };
};

// Collects PASS/FAIL lines; finish() prints them and quits with a matching exit code.
exports.results = function results() {
    const rows = [];
    return {
        ok: (name, cond, extra) => rows.push([cond ? 'PASS' : 'FAIL', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 600)]),
        finish: () => {
            for (const r of rows) console.log(r.join(' | '));
            const fails = rows.filter(r => r[0] === 'FAIL').length;
            console.log('SUMMARY', rows.length - fails, 'pass', fails, 'fail');
            app.exit(fails ? 1 : 0);
        }
    };
};
exports.makeMeta = makeMeta;
exports.S = S;
exports.R2_HOST = R2_HOST;
