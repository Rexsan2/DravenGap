// desktop-app/diagnostics-main.js
// Settings > Diagnostics (E4), main-process side. Registers 'diag:*' IPC channels:
//   diag:info   ()            -> { ok, app:{version,electron,chrome,os}, stores:[{id,label,path,bytes,files,newest}], coachless:{blockedUntil,running}, logLines }
//   diag:clear  ({id})        -> { ok, removed }   only 'coachless-resume' here (each feature module clears its own caches)
//   diag:export ({renderer})  -> { ok, file }      a plain-text report: versions, store sizes, the renderer's summary, recent
//                                                  log lines. Secrets are never included (Riot keys are redacted from every line).
// deps: { ipcMain, userDataPath, getLogs: () => string[], coachless: { rateLimitStatus, isRunning }, appInfo: () => {...},
//         exportDir: () => folder, reveal: file => void }
const fs = require('fs');
const path = require('path');
const os = require('os');

// Sizes of the folders / files the app keeps under userData (Chromium's own storage is reported by the window).
const STORES = [
    { id: 'profile-matches', label: 'Profile: downloaded matches', rel: 'profile-cache/matches' },
    { id: 'profile-timelines', label: 'Profile: match timelines', rel: 'profile-cache/timelines' },
    { id: 'profile-players', label: 'Profile: player ledgers', rel: 'profile-cache/players' },
    { id: 'profile-lookups', label: 'Profile: look-ups (accounts, ranks, op.gg)', rel: 'profile-cache/meta.json' },
    { id: 'profile-emblems', label: 'Profile: rank emblems', rel: 'profile-cache/emblems' },
    { id: 'aram', label: 'ARAM Mayhem cache', rel: 'aram-cache' },
    { id: 'coachless-resume', label: 'Builds: unfinished download state', rel: 'coachless-resume' },
    { id: 'personal-history', label: 'Your game history ("You" column)', rel: 'personal-history.json' }
];

async function sizeOf(p) {
    let st;
    try { st = await fs.promises.stat(p); } catch (e) { return { bytes: 0, files: 0, newest: 0 }; }
    if (!st.isDirectory()) return { bytes: st.size, files: 1, newest: st.mtimeMs };
    let bytes = 0, files = 0, newest = 0;
    const walk = async dir => {
        let ents = [];
        try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of ents) {
            const f = path.join(dir, e.name);
            if (e.isDirectory()) { await walk(f); continue; }
            try { const s = await fs.promises.stat(f); bytes += s.size; files++; if (s.mtimeMs > newest) newest = s.mtimeMs; } catch (err) { /* removed meanwhile */ }
        }
    };
    await walk(p);
    return { bytes, files, newest };
}

const KEY_RE = /RGAPI-[0-9a-f-]{8,}/gi;
const redact = s => String(s).replace(KEY_RE, 'RGAPI-[redacted]');
const fmtBytes = b => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(b > 0 ? 1 : 0, Math.round(b / 1024)) + ' KB');
const iso = t => (t ? new Date(t).toISOString() : '-');

function register(deps) {
    const { ipcMain, userDataPath } = deps;
    const handle = (ch, fn) => ipcMain.handle('diag:' + ch, async (e, a) => { try { return await fn(a || {}); } catch (err) { return { ok: false, error: err.message }; } });

    async function info() {
        const stores = [];
        for (const s of STORES) stores.push({ id: s.id, label: s.label, path: s.rel, ...(await sizeOf(path.join(userDataPath, s.rel))) });
        const cl = deps.coachless || {};
        return {
            ok: true,
            app: deps.appInfo ? deps.appInfo() : {},
            stores,
            coachless: { blockedUntil: cl.rateLimitStatus ? (cl.rateLimitStatus().blockedUntil || 0) : 0, running: cl.isRunning ? !!cl.isRunning() : false },
            logLines: deps.getLogs ? deps.getLogs().length : 0
        };
    }
    handle('info', info);

    handle('clear', async a => {
        if (a.id !== 'coachless-resume') return { ok: false, error: 'This store is cleared by its own view.' };
        if (deps.coachless && deps.coachless.isRunning && deps.coachless.isRunning()) return { ok: false, error: 'A Builds download is running: stop it first.' };
        const dir = path.join(userDataPath, 'coachless-resume');
        let removed = 0;
        try { for (const f of await fs.promises.readdir(dir)) { await fs.promises.unlink(path.join(dir, f)); removed++; } } catch (e) { /* none */ }
        return { ok: true, removed };
    });

    handle('export', async a => {
        const d = await info();
        const r = a.renderer && typeof a.renderer === 'object' ? a.renderer : {};
        const lines = [];
        lines.push('DravenGap diagnostics', `Written ${new Date().toISOString()}`, '');
        lines.push('== App');
        for (const [k, v] of Object.entries(d.app || {})) lines.push(`${k}: ${v}`);
        lines.push(`os: ${os.type()} ${os.release()} ${os.arch()}`, '');
        lines.push('== Stores (userData)');
        for (const s of d.stores) lines.push(`${s.label}: ${fmtBytes(s.bytes)} in ${s.files} file(s), newest ${iso(s.newest)}`);
        lines.push('', '== Coachless', `blocked until: ${iso(d.coachless.blockedUntil)}  download running: ${d.coachless.running}`);
        lines.push('', '== Window (renderer) summary');
        // the window's own summary: flattened, one "key: value" per line, strings only (no nested data dumps)
        const flat = (o, pre = '') => { for (const [k, v] of Object.entries(o || {})) { if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, pre + k + '.'); else lines.push(`${pre}${k}: ${Array.isArray(v) ? v.join(', ') : v}`); } };
        flat(r);
        lines.push('', '== Recent log lines');
        for (const l of (deps.getLogs ? deps.getLogs() : []).slice(-500)) lines.push(l);
        const text = redact(lines.join('\n')) + '\n';
        const dir = deps.exportDir ? deps.exportDir() : userDataPath;
        await fs.promises.mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
        const file = path.join(dir, `DravenGap-diagnostics-${stamp}.txt`);
        await fs.promises.writeFile(file, text, 'utf8');
        if (deps.reveal) { try { deps.reveal(file); } catch (e) { /* no file manager */ } }
        return { ok: true, file };
    });
}

// A ring buffer of log lines: console output of the main process plus anything the windows log (see main.js).
function createLogRing(max = 800) {
    const lines = [];
    const add = (level, args) => {
        const text = args.map(x => (x instanceof Error ? x.stack || x.message : typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch (e) { return String(x); } })())).join(' ');
        lines.push(`${new Date().toISOString()} ${level} ${redact(text).slice(0, 2000)}`);
        if (lines.length > max) lines.splice(0, lines.length - max);
    };
    return { add, lines: () => lines.slice() };
}

module.exports = { register, createLogRing, redact, sizeOf, STORES };
