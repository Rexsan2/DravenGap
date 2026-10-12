// Packed data of a personal build (resources/seed, written by tools/export-seed.js): serves the manifest and its files to
// seed-import.js, which copies them into the window's IndexedDB on the first start. Builds without a seed answer { ok: false }.
const fs = require('fs');
const path = require('path');

function register({ ipcMain, seedDir }) {
    const dir = seedDir || (process.resourcesPath ? path.join(process.resourcesPath, 'seed') : null);
    const manifestPath = dir && path.join(dir, 'manifest.json');
    ipcMain.handle('seed:manifest', () => {
        try {
            if (!manifestPath || !fs.existsSync(manifestPath)) return { ok: false };
            return { ok: true, manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) };
        } catch (e) { return { ok: false, error: e.message }; }
    });
    ipcMain.handle('seed:file', (event, name) => {
        if (!/^b\/\d+\.bin$/.test(String(name))) return null;      // only the seed's own blob files
        try { return new Uint8Array(fs.readFileSync(path.join(dir, name))); } catch (e) { return null; }
    });
}

module.exports = { register };
