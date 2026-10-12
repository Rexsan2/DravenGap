// Skill order: the LoLalytics build page saved once (Ahri Mid, Emerald+, Summoner's Rift) and the ARAM page
// read by parseLolalyticsSkills; skills-main.js's build:skills with a stub fetch (no network) and a scratch cache.
const assert = require('assert');
const { APP, fixture, scratch } = require('../lib/common');
const P = require(APP + 'aram-parsers');
const SM = require(APP + 'skills-main');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };

const sr = P.parseLolalyticsSkills(fixture('lolalytics/ahri_middle_build.html'));
ok(sr && sr.queue === 420 && sr.lane === 'middle' && sr.games > 1000, 'Summoner\'s Rift page: ranked queue, lane, games');
ok(sr.priority.pick.order.join('') === 'QWE' && sr.priority.pick.games <= sr.games, 'max order Q > W > E (most played)');
ok(sr.order.pick.seq.length === 15 && sr.order.pick.seq.every(s => 'QWER'.includes(s)) && sr.order.pick.seq.filter(s => s === 'R').length === 2, 'the first 15 level-ups, R twice');
ok(sr.length.length === 7 && sr.length.map(b => b.label).join() === '<15,15-20,20-25,25-30,30-35,35-40,40+' && sr.length.reduce((t, b) => t + b.games, 0) === sr.games && sr.length.every(b => b.wr > 40 && b.wr < 60), 'win rate by game length: 7 buckets that add up to the page games');
const ar = P.parseLolalyticsSkills(fixture('aram/l_ahri_aram.html'));
ok(ar && ar.queue === 450 && ar.priority.pick.order.join('') === 'QWE', 'the ARAM page reads the same way');
ok(P.parseLolalyticsSkills('<html></html>') === null && P.parseLolalyticsSkills(null) === null, 'no page state: null');
ok(SM.skillsUrl('MonkeyKing', 'JUNGLE') === 'https://lolalytics.com/lol/wukong/build/?lane=jungle&tier=emerald_plus' && SM.skillsUrl('Ahri', 'SUPPORT').endsWith('lane=support&tier=emerald_plus'), 'URLs: LoLalytics slugs and lanes, Emerald+');

(async () => {
    const h = {}, fetched = [];
    SM.register({ ipcMain: { handle: (c, f) => { h[c] = f; } }, userDataPath: scratch('skills'), sendToWindow: () => {},
        skillsFetch: async url => { fetched.push(url); if (/\/ahri\//.test(url)) return fixture('lolalytics/ahri_middle_build.html'); return '<html>nothing</html>'; } });
    let r = await h['build:skills']({}, { champion: 'Ahri', role: 'MIDDLE' });
    ok(r.ok && r.data.priority.pick.order.join('') === 'QWE' && r.data.url.includes('/ahri/build/?lane=middle') && fetched.length === 1, 'build:skills fetches once');
    r = await h['build:skills']({}, { champion: 'Ahri', role: 'MIDDLE' });
    ok(r.ok && fetched.length === 1, 'then from the cache');
    r = await h['build:skills']({}, { champion: 'Zed', role: 'MIDDLE' });
    ok(!r.ok && r.code === 'PARSE', 'a page without the data is an error, not a crash');
    r = await h['build:skills']({}, { champion: '../x', role: 'MIDDLE' });
    const r2 = await h['build:skills']({}, { champion: 'Ahri', role: 'ADC' });
    ok(!r.ok && r.code === 'BAD_REQUEST' && !r2.ok && fetched.length === 2, 'bad champion or role: refused without a request');
    console.log('ALL OK', n, 'checks'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
