// json-store (settings.json, favorites.json, personal-history.json, window-state.json): atomic writes, a corrupt file is kept
// aside instead of being overwritten, a missing file is the fallback, other I/O errors are thrown (not swallowed into {}).
const assert = require('assert'), fs = require('fs'), path = require('path');
const { APP, scratch } = require('../lib/common');
const J = require(APP + 'json-store');

const dir = scratch('json-store'), f = path.join(dir, 'settings.json');

assert.deepStrictEqual(J.readJson(f, { a: 1 }), { a: 1 }, 'missing file: the fallback');

J.writeJsonAtomic(f, { x: 1, y: [1, 2] }, { pretty: true });
assert.deepStrictEqual(J.readJson(f), { x: 1, y: [1, 2] }, 'round trip');
assert(!fs.existsSync(f + '.tmp'), 'no temp file left behind');
assert(fs.readFileSync(f, 'utf8').includes('\n  "x"'), 'pretty-printed when asked');

J.writeJsonAtomic(f, { x: 2 });
assert.deepStrictEqual(J.readJson(f), { x: 2 }, 'overwrite replaces the whole file');

// a half-written file (crash mid-write under the old plain writeFileSync)
fs.writeFileSync(f, '{"x": 1, "y": [1,');
assert.deepStrictEqual(J.readJson(f, {}), {}, 'corrupt file: the fallback');
const aside = fs.readdirSync(dir).filter(n => n.startsWith('settings.json.corrupt-'));
assert.strictEqual(aside.length, 1, 'the corrupt file was moved aside');
assert(!fs.existsSync(f), 'and the broken original is gone');
J.writeJsonAtomic(f, { fresh: true });
assert.deepStrictEqual(J.readJson(f), { fresh: true }, 'a save after that works');
assert(fs.readFileSync(path.join(dir, aside[0]), 'utf8').startsWith('{"x": 1'), 'the bad copy survives the next save');

// null in the file is not an object: fallback too
fs.writeFileSync(f, 'null');
assert.deepStrictEqual(J.readJson(f, { d: 1 }), { d: 1 }, '"null" gives the fallback');

// other I/O errors propagate (a directory where the file should be)
const d = path.join(dir, 'asdir.json'); fs.mkdirSync(d);
assert.throws(() => J.readJson(d, {}), /EISDIR|EPERM|EACCES/, 'a directory in the way is thrown, not turned into {}');
assert.throws(() => J.writeJsonAtomic(f, undefined), /nothing to write/, 'undefined is refused');

console.log('json-store: ok');
