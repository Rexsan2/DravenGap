// Syntax check: every desktop-app/*.js (CommonJS and ES modules) and every inline <script> in index.html.
const fs = require('fs'), path = require('path'), vm = require('vm'), Module = require('module'), os = require('os');
const { spawnSync } = require('child_process');
const { APP, scratch } = require('../lib/common');

let bad = 0;
const fail = (name, e) => { bad++; console.log('SYNTAX ERROR', name, '\n', String(e && e.message || e).slice(0, 600)); };
const tmp = scratch('syntax');

for (const f of fs.readdirSync(APP).filter(f => f.endsWith('.js')).sort()) {
    const src = fs.readFileSync(APP + f, 'utf8');
    if (/^\s*(import|export)\s/m.test(src)) {
        // ES module: let the runtime parse it as one
        const copy = path.join(tmp, f.replace(/\.js$/, '.mjs'));
        fs.writeFileSync(copy, src);
        const r = spawnSync(process.execPath, ['--check', copy], { env: process.env, encoding: 'utf8' });
        if (r.status !== 0) fail(f, r.stderr);
        continue;
    }
    try { new vm.Script(Module.wrap(src), { filename: f }); } catch (e) { fail(f, e); }
}

const html = fs.readFileSync(APP + 'index.html', 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
inline.forEach((src, i) => { try { new vm.Script('(function(){\n' + src + '\n})', { filename: 'index.html#script' + (i + 1) }); } catch (e) { fail('index.html inline script ' + (i + 1), e); } });

console.log(`checked ${fs.readdirSync(APP).filter(f => f.endsWith('.js')).length} files + ${inline.length} inline scripts`);
if (bad) { console.log('FAIL', bad, 'syntax errors'); process.exit(1); }
console.log('ALL OK');
