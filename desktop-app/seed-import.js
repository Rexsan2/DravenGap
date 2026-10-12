// First start of a personal build: copies the packed data (seed-main.js) into IndexedDB before the draft loads, so every
// saved patch, the 30-day data and the downloaded builds are there offline from the first launch. Records the user already
// has are kept (never overwritten); runs once per packed version (localStorage 'dg-seed-version').
window.DDSeed = (function () {
    const api = window.electronAPI && window.electronAPI.feature;
    const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

    async function dec(v) {
        if (Array.isArray(v)) { const a = []; for (const x of v) a.push(await dec(x)); return a; }
        if (!v || typeof v !== 'object') return v;
        const file = async name => { const u8 = await api.invoke('seed:file', name); if (!u8) throw new Error('missing ' + name); return u8; };
        if (v.$blob) return new Blob([await file(v.$blob)], { type: v.type || '' });
        if (v.$buf) { const u = await file(v.$buf); return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength); }
        if (v.$typed) { const u = await file(v.file); const C = globalThis[v.$typed]; return new C(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength)); }
        if (v.$map) return new Map(await dec(v.$map));
        if (v.$date != null) return new Date(v.$date);
        const o = {};
        for (const k of Object.keys(v)) o[k] = await dec(v[k]);
        return o;
    }

    // openDb(name) -> the app's own IDBDatabase for that name (dsOpen creates the stores), or null to skip that database
    async function importOnce(openDb, onProgress) {
        if (!api) return { ok: false };
        let r;
        try { r = await api.invoke('seed:manifest'); } catch (e) { return { ok: false }; }
        if (!r || !r.ok || !r.manifest) return { ok: false };
        const m = r.manifest;
        if (localStorage.getItem('dg-seed-version') === m.version) return { ok: true, skipped: true };
        let total = 0, done = 0, added = 0;
        for (const d of Object.values(m.dbs)) for (const s of Object.values(d.stores)) total += s.records.length;
        for (const [name, d] of Object.entries(m.dbs)) {
            const db = await openDb(name);
            if (!db) continue;
            for (const [store, s] of Object.entries(d.stores)) {
                if (!db.objectStoreNames.contains(store)) { done += s.records.length; continue; }
                for (const rec of s.records) {
                    done++;
                    const key = s.keyPath ? rec.v[s.keyPath] : await dec(rec.k);
                    const have = await req(db.transaction(store).objectStore(store).get(key));
                    if (have === undefined) {
                        const value = await dec(rec.v);
                        const tx = db.transaction(store, 'readwrite');
                        if (s.keyPath) tx.objectStore(store).put(value); else tx.objectStore(store).put(value, key);
                        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
                        added++;
                    }
                    if (onProgress) onProgress(done, total);
                }
            }
        }
        localStorage.setItem('dg-seed-version', m.version);
        return { ok: true, added, total };
    }
    return { importOnce };
})();
