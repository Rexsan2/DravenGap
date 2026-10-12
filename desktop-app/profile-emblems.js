// desktop-app/profile-emblems.js
// Rank emblems for the Profile view. Official Riot art from CommunityDragon, fetched by the main process once and cached on
// disk (<userData>/profile-cache/emblems/), handed to the renderer as data: URLs. The renderer only ever names a tier from a
// whitelist; it never supplies a URL or path.
//   mini: ranked-mini-crests/<tier>.svg  (about 1-2 KB each; used next to text)
//   big : ranked-emblem/emblem-<tier>.png (30-230 KB; used on the ranked cards). There is no big UNRANKED emblem, so the
//         mini crest is used for it (it is a vector and scales).
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER', 'UNRANKED'];
const BASE = 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images';
const MAX_BYTES = 2 * 1024 * 1024;
const RETRY_AFTER_FAIL_MS = 10 * 60e3;

const normTier = t => { const u = String(t == null ? '' : t).toUpperCase(); return TIERS.includes(u) ? u : null; };

function defaultFetch(url) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https:') ? https : http;
        const req = lib.get(url, { timeout: 15000, headers: { 'User-Agent': 'DraftDiff/personal' } }, res => {
            if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
            const ch = []; let n = 0;
            res.on('data', c => { n += c.length; if (n > MAX_BYTES) req.destroy(new Error('too large')); else ch.push(c); });
            res.on('end', () => resolve(Buffer.concat(ch)));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

// The official emblems are 2560 px canvases with the crest in the middle and wide transparent margins. In Electron, trim
// the margins and keep a small copy (elsewhere, e.g. in plain-node tests, the original is used as it is).
function shrink(buf) {
    try {
        const { nativeImage } = require('electron');
        if (!nativeImage) return buf;
        const img = nativeImage.createFromBuffer(buf);
        if (img.isEmpty()) return buf;
        const small = img.getSize().width > 512 ? img.resize({ width: 512, quality: 'best' }) : img;
        const { width: w, height: h } = small.getSize();
        const bm = small.toBitmap();                       // BGRA
        let x0 = w, y0 = h, x1 = -1, y1 = -1;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bm[(y * w + x) * 4 + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        let out = small;
        if (x1 >= x0 && y1 >= y0) out = small.crop({ x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 });
        if (out.getSize().height > 192) out = out.resize({ height: 192, quality: 'best' });
        const png = out.toPNG();
        return png && png.length > 64 ? png : buf;
    } catch (e) { return buf; }
}

// opts: { dir, baseUrl (tests), fetchBuf(url) -> Buffer (tests) }
function createEmblems(opts) {
    const dir = opts.dir;
    const base = opts.baseUrl || BASE;
    const fetchBuf = opts.fetchBuf || defaultFetch;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* read-only: memory only */ }
    const mem = new Map();        // 'mini:GOLD' -> data URL
    const inflight = new Map();
    const failedAt = new Map();

    const kindFor = (tier, size) => (size === 'big' && tier !== 'UNRANKED') ? 'big' : 'mini';
    const lc = t => t.toLowerCase();
    const urlOf = (tier, kind) => kind === 'big' ? `${base}/ranked-emblem/emblem-${lc(tier)}.png` : `${base}/ranked-mini-crests/${lc(tier)}.svg`;
    const fileOf = (tier, kind) => path.join(dir, `${kind}-${lc(tier)}.${kind === 'big' ? 'png' : 'svg'}`);
    const toData = (buf, kind) => `data:${kind === 'big' ? 'image/png' : 'image/svg+xml'};base64,${buf.toString('base64')}`;
    const valid = (buf, kind) => buf && buf.length > 64 && (kind === 'big' ? buf.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) : /^\s*(<\?xml|<svg)/.test(buf.slice(0, 80).toString('utf8')));

    async function load(tier, size) {
        const kind = kindFor(tier, size), key = kind + ':' + tier;
        if (mem.has(key)) return mem.get(key);
        try {
            const buf = fs.readFileSync(fileOf(tier, kind));
            if (valid(buf, kind)) { const d = toData(buf, kind); mem.set(key, d); return d; }
        } catch (e) { /* not cached yet */ }
        if (failedAt.has(key) && Date.now() - failedAt.get(key) < RETRY_AFTER_FAIL_MS) return null;
        if (inflight.has(key)) return inflight.get(key);
        const p = (async () => {
            try {
                let buf = await fetchBuf(urlOf(tier, kind));
                if (!valid(buf, kind)) throw new Error('bad image');
                if (kind === 'big') buf = shrink(buf);
                try { const f = fileOf(tier, kind); fs.writeFileSync(f + '.tmp', buf); fs.renameSync(f + '.tmp', f); } catch (e) { /* cache write is best effort */ }
                const d = toData(buf, kind); mem.set(key, d); failedAt.delete(key); return d;
            } catch (e) { failedAt.set(key, Date.now()); return null; }
            finally { inflight.delete(key); }
        })();
        inflight.set(key, p);
        return p;
    }

    // tiers: array of tier names (anything not on the whitelist is dropped). Returns { TIER: dataUrl } for those that loaded.
    async function getMany(tiers, size) {
        const want = [...new Set((Array.isArray(tiers) ? tiers : []).slice(0, 16).map(normTier).filter(Boolean))];
        const out = {};
        await Promise.all(want.map(async t => { const d = await load(t, size === 'big' ? 'big' : 'mini'); if (d) out[t] = d; }));
        return out;
    }
    return { getMany, load, TIERS };
}

module.exports = { createEmblems, normTier, TIERS };
