// Shared bits for the test scripts: app path, fixture reader (.gz aware), scratch dirs, a tiny assertion counter.
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const APP = path.resolve(__dirname, '..', '..') + path.sep;
const FIXTURES = path.resolve(__dirname, '..', 'fixtures');

// fixture('aram/tier.html') reads tier.html or tier.html.gz
function fixture(rel, enc = 'utf8') {
    const p = path.join(FIXTURES, rel);
    if (fs.existsSync(p)) return fs.readFileSync(p, enc);
    const gz = zlib.gunzipSync(fs.readFileSync(p + '.gz'));
    return enc ? gz.toString(enc) : gz;
}

// Scratch folder under the OS temp dir. Tests never touch %APPDATA%\draftdiff.
const scratch = prefix => fs.mkdtempSync(path.join(os.tmpdir(), 'dravengap-test-' + prefix + '-'));

const waitFor = (fn, ms = 8000, step = 30) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
        let v; try { v = fn(); } catch (e) { v = false; }
        if (v) { clearInterval(iv); res(); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('waitFor timeout')); }
    }, step);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { APP, FIXTURES, fixture, scratch, waitFor, sleep };
