// Small JSON files in userData (settings.json, favorites.json, personal-history.json, window-state.json).
//
// writeJsonAtomic: the text goes to <file>.tmp first (written and flushed), then renamed over the target, so a crash or power
// cut mid-write leaves the previous file whole instead of an empty or half-written one.
// readJson: a missing file gives the fallback. A file that does not parse is moved aside as <file>.corrupt-<time> and the
// fallback is returned, so the next save cannot overwrite the only copy of the user's data. Any other error (permissions, a
// directory in the way) is thrown: the caller decides, and the renderer's DD.patchSettings then refuses to save a patch over
// settings it could not read (main.js used to return {} for every failure, and one bad read wiped every other setting).
const fs = require('fs');

function readJson(file, fallback = {}) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) { if (e && e.code === 'ENOENT') return fallback; throw e; }
    try { const v = JSON.parse(text); return v == null ? fallback : v; }
    catch (e) {
        const aside = `${file}.corrupt-${Date.now()}`;
        try { fs.renameSync(file, aside); } catch (e2) { /* leave it in place; the next write is atomic anyway */ }
        console.error(`Could not parse ${file} (moved to ${aside}):`, e.message);
        return fallback;
    }
}

function writeJsonAtomic(file, value, { pretty = false } = {}) {
    const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
    if (typeof text !== 'string') throw new TypeError('writeJsonAtomic: nothing to write');
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.renameSync(tmp, file); }
    catch (e) {
        // Windows can refuse the rename while another process holds the file open (an antivirus scan): plain write instead
        if (e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) {
            fs.writeFileSync(file, text);
            try { fs.unlinkSync(tmp); } catch (e2) { /* already gone */ }
        } else throw e;
    }
}

module.exports = { readJson, writeJsonAtomic };
