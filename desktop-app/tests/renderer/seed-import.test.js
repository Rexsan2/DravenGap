// Personal build: data packed in the exe (resources/seed) is copied into IndexedDB on the first start, before the draft loads.
// A small seed is built here in the export format: a Coachless builds record (gzip blob), a typed array, a kv entry without
// a keyPath. The second start (same userData) does not import again, and records the user already has are not overwritten.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { ipcMain } = require('electron');
const H = require('../lib/renderer-harness');
const { APP, scratch, fixture } = require('../lib/common');
const R = H.results();

const seed = scratch('seed');
fs.mkdirSync(path.join(seed, 'b'), { recursive: true });
const ds = JSON.parse(fixture('data/coachless_builds_16.18.json'));
fs.writeFileSync(path.join(seed, 'b/1.bin'), zlib.gzipSync(JSON.stringify(ds)));
fs.writeFileSync(path.join(seed, 'b/2.bin'), Buffer.from(new Float32Array([0.5, 0.25]).buffer));
const manifest = { format: 1, version: '2026-10-12T00:00:00.000Z', dbs: { 'draftdiff-datasets': { version: 3, stores: {
    builds: { keyPath: 'key', records: [{ v: { key: 'builds|16.18|emerald_plus', patch: '16.18', rank: 'emerald_plus', enc: 'gzip', data: { $blob: 'b/1.bin', type: '' }, champions: 3, complete: true, cols: { $typed: 'Float32Array', file: 'b/2.bin' } } }] },
    kv: { keyPath: null, records: [{ k: 'seed-test', v: { hello: 'world', at: { $date: 1760000000000 } } }, { k: 'mine', v: 'from the seed' }] } } } } };
fs.writeFileSync(path.join(seed, 'manifest.json'), JSON.stringify(manifest));

(async () => {
    try {
        require(APP + 'seed-main').register({ ipcMain, seedDir: seed });
        const ud = scratch('seed-ud');
        let h = await H.boot({ userData: ud });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        const read = `(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('draftdiff-datasets'); r.onsuccess = () => res(r.result); r.onerror = rej; });
            const get = (s, k) => new Promise(res => { const r = db.transaction(s).objectStore(s).get(k); r.onsuccess = () => res(r.result); });
            const b = await get('builds', 'builds|16.18|emerald_plus'), kv = await get('kv', 'seed-test');
            const txt = b ? await new Response(b.data.stream().pipeThrough(new DecompressionStream('gzip'))).text() : '';
            return { builds: !!b, champs: txt ? Object.keys(JSON.parse(txt).champions || JSON.parse(txt)).length : 0, typed: b && b.cols instanceof Float32Array ? [...b.cols] : null,
                kv: kv && kv.hello, date: kv && kv.at instanceof Date, mine: await get('kv', 'mine'), flag: localStorage.getItem('dg-seed-version') }; })()`;
        let r = await h.ev(read);
        R.ok('first start imports blobs, typed arrays and keyless kv entries', r.builds && r.champs > 0 && JSON.stringify(r.typed) === '[0.5,0.25]' && r.kv === 'world' && r.date && r.flag === manifest.version, r);
        // the user's own value must survive a newer seed
        await h.ev(`(async () => { const db = await new Promise(res => { const q = indexedDB.open('draftdiff-datasets'); q.onsuccess = () => res(q.result); });
            await new Promise(res => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put('my own', 'mine'); tx.oncomplete = res; }); localStorage.setItem('dg-seed-version', 'older'); db.close(); return 1; })()`);
        await h.close(); await new Promise(r => setTimeout(r, 500));
        let calls = 0;
        ipcMain.removeHandler('seed:file');
        ipcMain.handle('seed:file', (e, n) => { calls++; return new Uint8Array(fs.readFileSync(path.join(seed, n))); });
        h = await H.boot({ userData: ud });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        r = await h.ev(read);
        R.ok('a newer seed never overwrites what the user has', r.mine === 'my own' && calls === 0, { mine: r.mine, calls });
        await h.close(); await new Promise(r => setTimeout(r, 500));
        h = await H.boot({ userData: ud });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        R.ok('same seed version: skipped on later starts', (await h.ev(`localStorage.getItem('dg-seed-version')`)) === manifest.version && !h.calls.some(c => c[0] === 'seed:file'));
        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError|not imported/.test(l)), h.logs.slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
