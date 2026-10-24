// Patch notes: Riot's 26.20 notes page saved once, read by parsePatchNotes (champions only, buff / nerf / adjust from the change
// lines and the developer context), and patchnotes-main.js's patch:notes with a stub fetch (no network) and a scratch cache.
const assert = require('assert');
const { APP, fixture, scratch } = require('../lib/common');
const P = require(APP + 'patchnotes-parse');
const PM = require(APP + 'patchnotes-main');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };

const page = fixture('patchnotes/patch_26_20.html');
const { champions } = P.parsePatchNotes(page);
const ids = Object.keys(champions);
ok(ids.length === 16 && ids.includes('KSante') && ids.includes('TahmKench') && !ids.includes('3073'), 'the 16 champions of the Champions section, by Data Dragon id (items are left out)');
ok(champions.KSante.name === "K'Sante" && /pro staples|K'Sante/.test(page) && champions.Ambessa.context.startsWith('Ambessa has been too reliable'), 'name and developer context');
const kinds = Object.fromEntries(ids.map(id => [id, champions[id].kind]));
ok(['Ambessa', 'Ashe', 'Cassiopeia', 'KSante', 'Yunara'].every(id => kinds[id] === 'nerf'), 'nerfs: lower damage / stats, higher costs');
ok(['Diana', 'Kennen', 'Kindred', 'Lucian', 'Neeko', 'Swain', 'TahmKench', 'Vayne'].every(id => kinds[id] === 'buff'), 'buffs (Swain: mixed lines, the context says buff)');
const amb = champions.Ambessa.changes[0];
ok(amb.section === "Passive - Drakehound's Step" && amb.attr === 'Damage' && amb.before === '5 - 30 (+25% bonus AD)' && amb.after === '5 - 25 (+20% bonus AD)' && amb.dir === -1, 'a change line: section, attribute, before ⇒ after, worse');
ok(P.lineDirection('Cooldown', '10 seconds', '8 seconds') === 1 && P.lineDirection('Mana Cost', '50', '60') === -1 && P.lineDirection('Base Mana', '480', '450') === -1, 'lower is better only for cooldowns and costs');
ok(P.classify([{ dir: 1 }, { dir: -1 }], '') === 'adjust' && P.classify([], 'compensation for the item changes') === 'buff' && P.classify([], '') === 'adjust', 'mixed = adjust, text-only changes follow the context');
ok(Object.keys(P.parsePatchNotes('<html></html>').champions).length === 0, 'a page without a Champions section: nothing');
ok(P.notesUrls('16.20')[0].endsWith('/league-of-legends-patch-26-20-notes/') && P.notesUrls('x').length === 0, 'URL of a game patch');

(async () => {
    const h = {}, fetched = [];
    PM.register({ ipcMain: { handle: (c, f) => { h[c] = f; } }, userDataPath: scratch('pn'),
        fetchPage: async url => { fetched.push(url); return /26-20/.test(url) ? { status: 200, text: page } : { status: 404, text: '' }; } });
    let r = await h['patch:notes']({}, { patch: '16.20', latest: true });
    ok(r.ok && Object.keys(r.champions).length === 16 && r.url.includes('26-20') && fetched.length === 1, 'patch:notes reads the page once');
    r = await h['patch:notes']({}, { patch: '16.20' });
    ok(r.ok && fetched.length === 1, 'then from the cache');
    r = await h['patch:notes']({}, { patch: '16.21' });
    ok(!r.ok && fetched.length === 3, 'not published yet: both URLs tried, an error');
    r = await h['patch:notes']({}, { patch: '16.21' });
    ok(!r.ok && fetched.length === 3, 'and not asked again for an hour');
    r = await h['patch:notes']({}, { patch: '../x' });
    ok(!r.ok && fetched.length === 3, 'a bad patch label is refused without a request');
    console.log('ALL OK', n, 'checks'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
