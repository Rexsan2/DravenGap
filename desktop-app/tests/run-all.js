// Runs every test: tests/unit/*.test.js with Electron's Node (ELECTRON_RUN_AS_NODE) and tests/renderer/*.test.js in a hidden
// Electron window. Usage:  npm test            (everything)
//                          npm test -- profile (only files whose name contains "profile")
//                          npm test -- --unit  /  --renderer
const fs = require('fs'), path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const electron = require('electron');           // under Node this is the path to electron.exe
const args = process.argv.slice(2);
const only = args.filter(a => !a.startsWith('--'));
const kinds = args.includes('--unit') ? ['unit'] : args.includes('--renderer') ? ['renderer'] : ['unit', 'renderer'];

const list = kind => {
    const dir = path.join(ROOT, kind);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.test.js') && (!only.length || only.some(o => f.includes(o)))).map(f => ({ kind, file: path.join(dir, f), name: kind + '/' + f }));
};

function run(t) {
    return new Promise(resolve => {
        const env = { ...process.env };
        if (t.kind === 'unit') env.ELECTRON_RUN_AS_NODE = '1'; else delete env.ELECTRON_RUN_AS_NODE;
        const t0 = Date.now();
        const p = spawn(electron, [t.file], { env, cwd: ROOT, windowsHide: true });
        let out = '';
        p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
        const limit = t.kind === 'unit' ? 120e3 : 240e3;
        const timer = setTimeout(() => { out += `\n(timed out after ${limit / 1000} s)`; p.kill(); }, limit);
        p.on('close', code => { clearTimeout(timer); resolve({ ...t, code, out, ms: Date.now() - t0 }); });
    });
}

(async () => {
    const tests = kinds.flatMap(list);
    if (!tests.length) { console.log('no tests match', only.join(' ')); process.exit(1); }
    const results = [];
    // unit tests are independent (random ports, own temp dirs): run 4 at a time; renderer tests one by one
    const unit = tests.filter(t => t.kind === 'unit'), rend = tests.filter(t => t.kind === 'renderer');
    for (let i = 0; i < unit.length; i += 4) results.push(...await Promise.all(unit.slice(i, i + 4).map(run)));
    for (const t of rend) results.push(await run(t));
    let failed = 0;
    for (const r of results) {
        const ok = r.code === 0 && !/^FAIL\b|\| FAIL \||SUMMARY \d+ pass [1-9]/m.test(r.out);
        if (!ok) failed++;
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.name}  (${(r.ms / 1000).toFixed(1)} s)`);
        if (!ok || args.includes('--verbose')) console.log(r.out.split(/\r?\n/).slice(-25).map(l => '    ' + l).join('\n'));
    }
    console.log(`\n${results.length - failed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
