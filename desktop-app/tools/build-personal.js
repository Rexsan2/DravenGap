// Personal build: one installer with the owner's Riot key and all saved data inside. NEVER publish its output: the key can be
// read back out of the exe by anyone who has it. Output: dist/DravenGap Personal Setup <version>.exe
//
//   cd desktop-app
//   npm run build:personal                 # export (tools/export-seed.js) + build
//   npm run build:personal -- --no-export  # reuse .personal/ from the last export
//
// The app must have the key saved in Settings and the data downloaded on this PC before the export.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const P = path.join(APP, '.personal');
const run = (cmd, args, opts = {}) => { const r = spawnSync(cmd, args, { cwd: APP, stdio: 'inherit', shell: opts.shell || false, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } }); if (r.status !== 0) { console.error(`${path.basename(cmd)} failed (${r.status})`); process.exit(1); } };

if (!process.argv.includes('--no-export')) {
    const electron = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
    if (!fs.existsSync(electron)) { console.error('Electron is not installed (npm install).'); process.exit(1); }
    run(electron, [path.join(__dirname, 'export-seed.js')]);
}
for (const f of ['seed/manifest.json', 'app-data.bin']) {
    if (!fs.existsSync(path.join(P, f))) { console.error(`Missing .personal/${f}: run the export first (and save the key in Settings).`); process.exit(1); }
}

const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
const config = {
    ...pkg.build,
    productName: 'DravenGap',
    artifactName: 'DravenGap Personal Setup ${version}.${ext}',
    extraResources: [{ from: '.personal/seed', to: 'seed' }, { from: '.personal/app-data.bin', to: 'app-data.bin' }]
};
const cfgFile = path.join(P, 'builder-config.json');
fs.writeFileSync(cfgFile, JSON.stringify(config, null, 1));
run(path.join(APP, 'node_modules', '.bin', 'electron-builder.cmd'), ['--win', 'nsis', '--config', cfgFile], { shell: true });
console.log(`\nDone: dist/DravenGap Personal Setup ${pkg.version}.exe (personal: do not share or upload it)`);
