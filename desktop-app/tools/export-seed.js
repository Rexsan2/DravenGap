// Personal build, step 1 (run with Electron, see tools/build-personal.js): packs the data this PC has saved into .personal/
//  - .personal/seed/: every IndexedDB record of the app (draft stats of every saved patch and rank, 30-day data, builds,
//    matchups), blobs as separate files, manifest.json describing them. seed-import.js loads it on a new install.
//  - .personal/app-data.bin: the Riot key from Settings, encoded (builtin-key.js).
// Works on a COPY of the app's folder (the running app is never touched) and prints no secret.
const { app, BrowserWindow, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const OUT = path.join(APP, '.personal');
const SRC = process.env.DG_SOURCE_USERDATA || path.join(app.getPath('appData'), 'draftdiff');
const WORK = path.join(app.getPath('temp'), 'dravengap-export-' + process.pid);

// copies left by earlier runs (Electron keeps its own userData open until exit, so a run cannot delete its copy)
for (const d of fs.readdirSync(app.getPath('temp'))) if (/^dravengap-export-\d+$/.test(d) && d !== path.basename(WORK)) { try { fs.rmSync(path.join(app.getPath('temp'), d), { recursive: true, force: true }); } catch (e) { /* in use */ } }
const copyDir = (from, to) => { if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true, force: true }); };
fs.mkdirSync(WORK, { recursive: true });
copyDir(path.join(SRC, 'IndexedDB'), path.join(WORK, 'IndexedDB'));
for (const f of ['Local State', 'riot-api-key.bin']) if (fs.existsSync(path.join(SRC, f))) fs.copyFileSync(path.join(SRC, f), path.join(WORK, f));
app.setPath('userData', WORK);

app.whenReady().then(async () => {
    try {
        fs.rmSync(path.join(OUT, 'seed'), { recursive: true, force: true });
        fs.mkdirSync(path.join(OUT, 'seed', 'b'), { recursive: true });
        // the key: decrypted with this Windows user's keychain (the copied Local State holds the wrapped key)
        let keyNote = 'no key saved in Settings';
        const kf = path.join(WORK, 'riot-api-key.bin');
        if (fs.existsSync(kf) && safeStorage.isEncryptionAvailable()) {
            const key = safeStorage.decryptString(fs.readFileSync(kf));
            if (/^RGAPI-[0-9a-f-]{36}$/i.test(key)) { fs.writeFileSync(path.join(OUT, 'app-data.bin'), require('../builtin-key').encode(key)); keyNote = 'key packed'; }
            else keyNote = 'saved key has an unexpected format: not packed';
        }
        fs.writeFileSync(path.join(WORK, 'blank.html'), '<!doctype html><title>export</title>');
        const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
        await w.loadFile(path.join(WORK, 'blank.html'));   // file:// origin, same IndexedDB as index.html
        const result = await w.webContents.executeJavaScript(`(${dump.toString()})(${JSON.stringify(path.join(OUT, 'seed'))})`);
        console.log(JSON.stringify({ ...result, key: keyNote }, null, 1));
        w.destroy();
    } catch (e) {
        console.error('EXPORT FAILED', e && e.message); process.exitCode = 1;
    } finally {
        try { fs.rmSync(path.join(WORK, 'riot-api-key.bin'), { force: true }); } catch (e) { /* removed with the folder next run */ }
        app.quit();
    }
});

// Runs in the hidden window (Node enabled): reads every store of every database and writes the seed folder.
async function dump(outDir) {
    const fs = require('fs'), path = require('path');
    let n = 0, bytes = 0;
    const put = (buf, ext) => { const name = `b/${++n}${ext}`; fs.writeFileSync(path.join(outDir, name), buf); bytes += buf.length; return name; };
    // Blob / ArrayBuffer / typed arrays become files; everything else stays JSON
    async function enc(v) {
        if (v instanceof Blob) return { $blob: put(Buffer.from(await v.arrayBuffer()), '.bin'), type: v.type };
        if (v instanceof ArrayBuffer) return { $buf: put(Buffer.from(v), '.bin') };
        if (ArrayBuffer.isView(v)) return { $typed: v.constructor.name, file: put(Buffer.from(v.buffer, v.byteOffset, v.byteLength), '.bin') };
        if (v instanceof Map) return { $map: await enc([...v]) };
        if (v instanceof Date) return { $date: v.getTime() };
        if (Array.isArray(v)) { const a = []; for (const x of v) a.push(await enc(x)); return a; }
        if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = await enc(v[k]); return o; }
        return v;
    }
    const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const manifest = { format: 1, createdAt: new Date().toISOString(), dbs: {} };
    const summary = {};
    for (const info of await indexedDB.databases()) {
        const db = await req(indexedDB.open(info.name));
        const d = manifest.dbs[info.name] = { version: db.version, stores: {} };
        for (const store of db.objectStoreNames) {
            const os = db.transaction(store).objectStore(store);
            const [keys, values] = await Promise.all([req(os.getAllKeys()), req(os.getAll())]);
            const recs = [];
            for (let i = 0; i < values.length; i++) recs.push({ k: os.keyPath ? undefined : await enc(keys[i]), v: await enc(values[i]) });
            d.stores[store] = { keyPath: os.keyPath, records: recs };
            summary[`${info.name}/${store}`] = recs.length;
        }
        db.close();
    }
    manifest.version = manifest.createdAt;
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest));
    return { files: n, mb: Math.round(bytes / 1048576), stores: summary };
}
