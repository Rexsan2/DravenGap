// Patch notes for the buff / nerf / adjust marks (patch-notes.js in the window): 'patch:notes' (patch '16.20') reads Riot's notes
// for that patch once, classifies every champion (patchnotes-parse.js) and keeps the result in <userData>/patchnotes/<patch>.json.
// On demand only: one page per patch, re-read at most once a day while it is the newest patch asked for (mid-patch updates are
// added to the same page), and not again for an hour after a failure.
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { parsePatchNotes, notesUrls } = require('./patchnotes-parse');

const PARSER_VERSION = 1;
const REFRESH_MS = 24 * 3600e3, RETRY_MS = 3600e3;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function httpGet(url, redirects = 3) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.get(u, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html', 'Accept-Encoding': 'gzip, deflate' }, timeout: 20000 }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
                res.resume();
                const next = new URL(res.headers.location, u).toString();
                if (new URL(next).protocol !== 'https:') return reject(new Error('redirect to non-https'));
                return httpGet(next, redirects - 1).then(resolve, reject);
            }
            const enc = (res.headers['content-encoding'] || '').toLowerCase();
            const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
            const chunks = []; let size = 0;
            stream.on('data', c => { size += c.length; if (size > 8 * 1024 * 1024) req.destroy(new Error('response too large')); else chunks.push(c); });
            stream.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
            stream.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

function register({ ipcMain, userDataPath, fetchPage = httpGet }) {
    const dir = path.join(userDataPath, 'patchnotes');
    const failedAt = new Map();   // patch -> time of the last failed read
    const pending = new Map();    // patch -> in-flight promise
    const file = patch => path.join(dir, `${patch}.json`);
    const readCache = patch => { try { const c = JSON.parse(fs.readFileSync(file(patch), 'utf8')); return c && c.v === PARSER_VERSION ? c : null; } catch (e) { return null; } };

    async function load(patch) {
        for (const url of notesUrls(patch)) {
            const r = await fetchPage(url);
            if (r.status === 404) continue;
            if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
            const { champions } = parsePatchNotes(r.text);
            if (!Object.keys(champions).length) continue;
            const rec = { v: PARSER_VERSION, patch, url, fetchedAt: Date.now(), champions };
            try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file(patch), JSON.stringify(rec)); } catch (e) { /* cache is optional */ }
            return rec;
        }
        return null;
    }

    ipcMain.handle('patch:notes', async (event, req) => {
        const patch = String((req && req.patch) || '');
        if (!/^\d+\.\d+$/.test(patch)) return { ok: false, error: 'bad patch' };
        const cached = readCache(patch);
        const stale = cached && req && req.latest && Date.now() - cached.fetchedAt > REFRESH_MS;
        if (cached && !stale) return { ok: true, ...cached };
        if (Date.now() - (failedAt.get(patch) || 0) < RETRY_MS) return cached ? { ok: true, ...cached } : { ok: false, error: 'not available yet' };
        if (!pending.has(patch)) pending.set(patch, load(patch).finally(() => pending.delete(patch)));
        try {
            const rec = await pending.get(patch);
            if (rec) return { ok: true, ...rec };
            failedAt.set(patch, Date.now());
            return cached ? { ok: true, ...cached } : { ok: false, error: 'no patch notes found' };
        } catch (e) {
            failedAt.set(patch, Date.now());
            return cached ? { ok: true, ...cached } : { ok: false, error: e.message };
        }
    });
}

module.exports = { register };
