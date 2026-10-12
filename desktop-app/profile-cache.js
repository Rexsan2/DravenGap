// desktop-app/profile-cache.js
// Disk caches for the Profile view under <userData>/profile-cache:
//   matches/<matchId>.json.gz   permanent (matches are immutable)
//   meta.json                   TTL cache (account / summoner / league / mastery / queues)
//   players/<puuid>.json        per-player ledger of compact match rows (season stats) + match-id index
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const gzip = promisify(zlib.gzip), gunzip = promisify(zlib.gunzip);

const safe = s => String(s).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);

function atomicWrite(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
}

// A directory of small JSON documents, kept in memory and written back (debounced).
class JsonDocs {
    constructor(dir, delay = 400) { this.dir = dir; this.delay = delay; this.mem = new Map(); this.dirty = new Set(); this.timer = null; fs.mkdirSync(dir, { recursive: true }); }
    file(name) { return path.join(this.dir, safe(name) + '.json'); }
    get(name) {
        if (this.mem.has(name)) return this.mem.get(name);
        let v = null;
        try { v = JSON.parse(fs.readFileSync(this.file(name), 'utf8')); } catch (e) { /* missing or corrupt: start fresh */ }
        this.mem.set(name, v);
        return v;
    }
    set(name, value) {
        this.mem.set(name, value);
        this.dirty.add(name);
        if (!this.timer) { this.timer = setTimeout(() => this.flush(), this.delay); if (this.timer.unref) this.timer.unref(); }
    }
    // in-memory only: an empty doc is not written until something is stored (savePlayer)
    put(name, value) { this.mem.set(name, value); }
    flush() {
        clearTimeout(this.timer); this.timer = null;
        for (const name of this.dirty) {
            try { atomicWrite(this.file(name), JSON.stringify(this.mem.get(name))); } catch (e) { console.error('profile-cache write failed', e.message); }
        }
        this.dirty.clear();
    }
}

function createCache(rootDir) {
    const matchDir = path.join(rootDir, 'matches');
    fs.mkdirSync(matchDir, { recursive: true });
    const tlDir = path.join(rootDir, 'timelines');
    const meta = new JsonDocs(rootDir);
    const players = new JsonDocs(path.join(rootDir, 'players'));
    const lru = new Map(); // matchId -> raw match
    const LRU_MAX = 300;

    const matchFile = id => path.join(matchDir, safe(id) + '.json.gz');
    const remember = (id, m) => { lru.delete(id); lru.set(id, m); if (lru.size > LRU_MAX) lru.delete(lru.keys().next().value); };

    return {
        rootDir,
        async getMatch(id) {
            if (lru.has(id)) { const m = lru.get(id); remember(id, m); return m; }
            try {
                const m = JSON.parse((await gunzip(await fs.promises.readFile(matchFile(id)))).toString('utf8'));
                remember(id, m);
                return m;
            } catch (e) { return null; }
        },
        hasMatch(id) { return lru.has(id) || fs.existsSync(matchFile(id)); },
        async putMatch(id, raw) {
            remember(id, raw);
            try { const f = matchFile(id); await fs.promises.writeFile(f + '.tmp', await gzip(JSON.stringify(raw))); await fs.promises.rename(f + '.tmp', f); }
            catch (e) { console.error('profile-cache match write failed', e.message); }
        },
        // compacted match timelines (permanent; written only when one is opened)
        async getTimeline(id) {
            try { return JSON.parse((await gunzip(await fs.promises.readFile(path.join(tlDir, safe(id) + '.json.gz')))).toString('utf8')); } catch (e) { return null; }
        },
        async putTimeline(id, tl) {
            try {
                await fs.promises.mkdir(tlDir, { recursive: true });
                const f = path.join(tlDir, safe(id) + '.json.gz');
                await fs.promises.writeFile(f + '.tmp', await gzip(JSON.stringify(tl))); await fs.promises.rename(f + '.tmp', f);
            } catch (e) { console.error('profile-cache timeline write failed', e.message); }
        },
        // TTL entries: { at, data }
        getMeta(key) { const all = meta.get('meta') || {}; return all[key] || null; },
        setMeta(key, data) { const all = meta.get('meta') || {}; all[key] = { at: Date.now(), data }; meta.set('meta', all); },
        // per-player doc: { rows: { matchId: row }, idx: { queueKey: { ids, at, complete } } }
        player(puuid) { let d = players.get(puuid); if (!d) { d = { rows: {}, idx: {} }; players.put(puuid, d); } return d; },
        // the existing doc or null; never creates one
        peekPlayer(puuid) { return players.get(puuid) || null; },
        // delete TTL entries for which pred(key, entry) is true; returns how many were removed
        dropMeta(pred) {
            const all = meta.get('meta') || {}; let n = 0;
            for (const k of Object.keys(all)) if (pred(k, all[k])) { delete all[k]; n++; }
            if (n) meta.set('meta', all);
            return n;
        },
        savePlayer(puuid) { players.set(puuid, players.get(puuid)); },
        flush() { meta.flush(); players.flush(); }
    };
}

module.exports = { createCache };
