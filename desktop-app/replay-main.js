// Replay review: download / open a game's replay from the League client and jump the replay to a moment (a death, a fight).
// Registers 'lcu:replay-*' channels.
//   lcu:replay-state  ({gameId})            -> { ok, state: 'watch'|'download'|'downloading'|'incompatible'|'missingOrExpired'|..., apiEnabled,
//                                              running: THIS game's replay, opened from here, is open now }
//   lcu:replay-open   ({gameId})            -> starts the download if needed (waits while it is checked or downloaded), then opens the replay
//   lcu:replay-seek   ({time, player?})     -> jumps the running replay to `time` (seconds) and follows `player` (name) if given
//   lcu:replay-enable-api ()                -> turns on the game's local Replay API (game.cfg: [General] EnableReplayApi=1), asked for
//                                              by the user with a button; needed once, before a replay can be moved from here
// The client only keeps replays of the current patch; the Replay API (127.0.0.1:2999) only answers while a replay is open.
const https = require('https');
const fs = require('fs');
const path = require('path');
const { getSharedLcu } = require('./profile-lcu');
const { _internals: { lcuSend } } = require('./lcu-apply');

const agent = new https.Agent({ rejectUnauthorized: false }); // the game's local API uses a self-signed certificate
const COMPONENT = { componentType: 'replay-button_match-history' };

function replayApi(method, p, body) {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise(resolve => {
        const req = https.request({ hostname: '127.0.0.1', port: 2999, path: p, method, agent, timeout: 3000,
            headers: { Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, res => {
            let t = ''; res.on('data', c => { t += c; }); res.on('end', () => { let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, json: j }); });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', () => resolve({ status: 0, json: null }));
        if (data) req.write(data);
        req.end();
    });
}

function register({ ipcMain, getLeagueCredentials, lcuRequest }) {
    const lcu = getSharedLcu({ getLeagueCredentials, lcuRequest });
    const gid = v => { const n = Number(String(v || '').replace(/^[A-Z0-9]+_/, '')); return Number.isSafeInteger(n) && n > 0 ? n : null; };
    async function withClient(fn) {
        const creds = await lcu.creds();
        if (!creds) return { ok: false, code: 'NO_CLIENT', error: 'Open the League client to watch replays.' };
        try { return await fn(creds); }
        catch (e) { lcu.invalidate(); return { ok: false, code: 'NO_CLIENT', error: `League client not reachable (${e.message}).` }; }
    }
    async function gameCfg(creds) {
        const r = await lcuSend(creds, 'GET', '/data-store/v1/install-dir');
        const dir = r.status === 200 && typeof r.json === 'string' ? r.json : null;
        return dir ? path.join(dir, 'Config', 'game.cfg') : null;
    }
    const apiOn = file => { try { return /^\s*EnableReplayApi\s*=\s*1\s*$/mi.test(fs.readFileSync(file, 'utf8')); } catch (e) { return false; } };

    // `running` is per game: the Replay API answers for whichever replay is open, so it counts only for the game this app last opened
    // (a replay the user closed, or another game's, is opened again instead of being moved)
    let openedId = null;
    ipcMain.handle('lcu:replay-state', (e, req) => withClient(async creds => {
        const id = gid(req && req.gameId);
        if (!id) return { ok: false, error: 'No game id.' };
        const m = await lcuSend(creds, 'GET', `/lol-replays/v1/metadata/${id}`);
        const file = await gameCfg(creds);
        const running = openedId === id && (await replayApi('GET', '/replay/playback')).status === 200;
        return { ok: m.status === 200, state: m.json && m.json.state || 'unknown', progress: m.json && m.json.downloadProgress, apiEnabled: file ? apiOn(file) : false, running };
    }));

    ipcMain.handle('lcu:replay-open', (e, req) => withClient(async creds => {
        const id = gid(req && req.gameId);
        if (!id) return { ok: false, error: 'No game id.' };
        let m = await lcuSend(creds, 'GET', `/lol-replays/v1/metadata/${id}`);
        let state = m.json && m.json.state;
        // still being checked or downloaded (a second click), or to download: wait for it, asking for the download once
        let asked = false;
        for (let i = 0; i < 90 && ['checking', 'download', 'downloading'].includes(state); i++) {   // up to ~3 minutes
            if (state === 'download' && !asked) { asked = true; await lcuSend(creds, 'POST', `/lol-replays/v1/rofls/${id}/download`, COMPONENT); }
            await new Promise(r => setTimeout(r, 2000));
            m = await lcuSend(creds, 'GET', `/lol-replays/v1/metadata/${id}`);
            state = m.json && m.json.state;
        }
        if (state !== 'watch') return { ok: false, state, error: state === 'incompatible' || state === 'missingOrExpired' ? 'This replay is from an older patch or has expired: the client only keeps replays of the current patch.' : `The replay is not available (${state || 'unknown'}).` };
        const w = await lcuSend(creds, 'POST', `/lol-replays/v1/rofls/${id}/watch`, COMPONENT);
        if (w.status >= 200 && w.status < 300) { openedId = id; return { ok: true }; }
        return { ok: false, error: `The client did not open the replay (${w.status}).` };
    }));

    ipcMain.handle('lcu:replay-seek', async (e, req) => {
        const t = Number(req && req.time);
        if (!(t >= 0 && t < 4 * 3600)) return { ok: false, error: 'Bad time.' };
        // the replay takes a while to load after "watch": wait for its API
        let up = false;
        for (let i = 0; i < 60 && !up; i++) { up = (await replayApi('GET', '/replay/playback')).status === 200; if (!up) await new Promise(r => setTimeout(r, 2000)); }
        if (!up) return { ok: false, error: 'The replay is not open, or its Replay API is off (turn it on below, then reopen the replay).' };
        const p = await replayApi('POST', '/replay/playback', { time: t, paused: false, speed: 1 });
        if (req && req.player) await replayApi('POST', '/replay/render', { cameraAttached: true, selectionName: String(req.player).slice(0, 40) });
        return p.status === 200 ? { ok: true } : { ok: false, error: `The replay did not move (${p.status}).` };
    });

    ipcMain.handle('lcu:replay-enable-api', () => withClient(async creds => {
        const file = await gameCfg(creds);
        if (!file || !fs.existsSync(file)) return { ok: false, error: 'Could not find the game settings file (game.cfg).' };
        let text = fs.readFileSync(file, 'utf8');
        if (apiOn(file)) return { ok: true, already: true };
        const nl = text.includes('\r\n') ? '\r\n' : '\n';
        if (/^\s*EnableReplayApi\s*=.*$/mi.test(text)) text = text.replace(/^\s*EnableReplayApi\s*=.*$/mi, 'EnableReplayApi=1');
        else if (/^\[General\]\s*$/mi.test(text)) text = text.replace(/^\[General\]\s*$/mi, m => `${m}${nl}EnableReplayApi=1`);
        else text += `${nl}[General]${nl}EnableReplayApi=1${nl}`;
        fs.copyFileSync(file, file + '.dravengap-backup');   // the original is kept next to it
        fs.writeFileSync(file, text);
        return { ok: true };
    }));
}

module.exports = { register };
