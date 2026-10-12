// Champion hub (C1): opens from the sidebar / grid right-click / palette / why panel; its matchup numbers equal the draft's
// own pairing numbers; Synergies, Builds, My stats (stubbed Profile) and ARAM (stubbed arammayhem) tabs render.
const H = require('../lib/renderer-harness');
const { APP, fixture } = require('../lib/common');
const R = H.results();
const skills = require(APP + 'aram-parsers').parseLolalyticsSkills(fixture('lolalytics/ahri_middle_build.html'));

const tier = { patch: '26.19', dataDate: '2026-10-03', avgWr: 50.1, champions: [
    { slug: 'ahri', name: 'Ahri', wr: 51.7, tier: 'A', rank: 31, tags: ['Mage'], image: '', search: 'ahri' },
    { slug: 'teemo', name: 'Teemo', wr: 53.4, tier: 'S+', rank: 1, tags: ['Marksman'], image: '', search: 'teemo' }] };
const aug = (name, wr, app) => ({ slug: name.toLowerCase(), name, wr, appearance: app, icon: '' });
const ahriPage = { meta: { name: 'Ahri', wr: 51.7, pick: 3.2, tier: 'A', rank: 31, patch: '26.19', dataDate: '2026-10-03' }, balance: [],
    augments: { prismatic: [aug('Archmage', 55.1, 12), aug('Rare', 60, 0.5)], gold: [aug('Blade Waltz', 53.2, 8)], silver: [] } };
const summary = { ok: true, puuid: 'P'.padEnd(78, 'x'), games: 12, w: 8, k: 90, d: 40, a: 70, cs: 2400, mins: 360, kp: 660, roles: { MIDDLE: 11, NONE: 1 }, queues: { 420: 12 },
    last: [{ id: 'EUW1_1', win: true, k: 9, d: 2, a: 7, end: Date.now() - 3600e3, pos: 'MIDDLE', q: 420, sc: 8.7, bd: 'MVP' }, { id: 'EUW1_2', win: false, k: 3, d: 6, a: 4, end: Date.now() - 7200e3, pos: 'MIDDLE', q: 420, sc: 4.1, bd: null }],
    score: 6.4, mvp: 3, ace: 1, items: {}, itemGames: 0, totalCached: 120 };

(async () => {
    try {
        const h = await H.boot({ ipc: {
            'profile:me': () => ({ ok: true, me: { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' }, lcu: true, phase: 'None' }),
            // the hub asks the main process which account is the owner's (client, else the last one seen, else Settings)
            'profile:owner': () => ({ ok: true, owner: { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1', puuid: null }, source: 'last' }),
            'build:skills': (e, a) => (a.champion === 'Ahri' && a.role === 'MIDDLE' ? { ok: true, data: skills, fetchedAt: Date.now() } : { ok: false, error: 'no data' }),
            'profile:champ-summary': (e, a) => (a && a.champId === 103 && a.gameName === 'TestOwner' ? summary : { ok: false, error: 'unexpected ' + JSON.stringify(a) }),
            'aram:tier-list': () => ({ ok: true, data: tier, fetchedAt: Date.now() }),
            'aram:champion': (e, a) => (a.slug === 'ahri' ? { ok: true, data: ahriPage, fetchedAt: Date.now() } : { ok: false, error: 'no' }),
            'aram:items': () => ({ ok: true, data: { wr: 50.2, games: 50000, core: { items: [6655, 3020, 4645], wr: 52.1, games: 3000 } }, fetchedAt: Date.now() })
        } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        // the draft: Akali in the enemy mid, recommendations for our mid -> Ahri's row carries the pairing "vs Akali"
        await h.ev(`(async () => { const t = document.querySelector('.champion-tile[data-champion-name="Akali"]'); const s = document.querySelector('.role-slot[data-side="right"][data-role="MIDDLE"]'); s.click(); t.click(); await new Promise(r => setTimeout(r, 200));
            document.querySelector("[data-side='left'][data-role='MIDDLE'] .suggest-btn").click(); return 1; })()`);
        await h.waitFor(`!!document.querySelector('#recommendation-list li[data-champion-name="Ahri"]')`, 15000);
        const draftVsAkali = await h.ev(`(() => { const li = document.querySelector('#recommendation-list li[data-champion-name="Ahri"]'); const b = JSON.parse(li.dataset.breakdown).find(x => x.source === 'Akali'); return b ? b.mean : null; })()`);

        // open from the grid's right-click menu
        await h.ev(`(() => { const t = document.querySelector('.champion-tile[data-champion-name="Ahri"]'); t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 })); return 1; })()`);
        const menu = await h.ev(`[...document.querySelectorAll('#context-menu .context-menu-item')].map(x => x.textContent.trim()).join('|')`);
        await h.ev(`document.querySelector('#context-menu [data-hub="Ahri"]').click(); 1`);
        await h.waitFor(`DD.currentView() === 'champion' && /Ahri/.test(document.querySelector('#champion-root .ch-name h2').textContent) && !!document.querySelector('#champion-root .ch-big')`, 15000);
        R.ok('right-click > Champion page opens the hub', /Champion page/.test(menu) && (await h.ev(`document.querySelector('.sb-item.active').dataset.view`)) === 'champion', menu);
        const head = await h.ev(`({ role: (document.querySelector('#champion-root .ch-role.on') || {}).textContent, chip: (document.querySelector('#champion-root .dg-prov') || {}).textContent, big: document.querySelector('#champion-root .ch-big').textContent })`);
        const data = await h.ev(`DD.championData('Ahri', 'MIDDLE').then(d => ({ wr: d.roles.MIDDLE.wr, akali: (d.matchups.find(m => m.champion === 'Akali') || {}).mean, n: d.matchups.length, syn: Object.keys(d.synergies) }))`);
        R.ok('overview: win rate by game length (7 bars) and the skill order', await h.waitFor(`document.querySelectorAll('#champion-root .sk-len .sk-lb').length === 7 && /Q > W > E/.test((document.querySelector('#champion-root .sk-row:not(.sk-muted)') || {}).textContent || '')`, 8000),
            await h.ev(`(document.querySelector('#champion-root .sk-len') || {}).textContent`));
        R.ok('overview: Mid role, base WR and the data chip', /Mid/.test(head.role) && head.big === (data.wr * 100).toFixed(2) + '%' && /Platinum\+/.test(head.chip), { head, data });
        R.ok('hub matchup = the draft\'s own number for Ahri vs Akali', draftVsAkali != null && Math.abs(data.akali - draftVsAkali) < 1e-12, { hub: data.akali, draft: draftVsAkali });

        // matchups tab
        const mt = await h.ev(`(async () => { document.querySelector('#champion-root [data-tab="matchups"]').click(); await new Promise(r => setTimeout(r, 50));
            const c = document.querySelector('#champion-root [data-opt="common"]'); if (c.checked) { c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); }
            await new Promise(r => setTimeout(r, 50)); const rows = [...document.querySelectorAll('#champion-root .ch-table tbody tr[data-hub]')];
            return { n: rows.length, first: rows[0] && rows[0].dataset.hub, means: rows.map(r => parseFloat(r.children[3].textContent)) }; })()`);
        R.ok('matchups: every opponent, best first', mt.n === data.n && mt.n >= 5 && mt.means.every((v, i) => i === 0 || v <= mt.means[i - 1] + 1e-9), mt);
        // synergies
        const sy = await h.ev(`(async () => { document.querySelector('#champion-root [data-tab="synergies"]').click(); await new Promise(r => setTimeout(r, 50));
            return [...document.querySelectorAll('#champion-root .ch-card-h')].map(x => x.textContent.trim()); })()`);
        R.ok('synergies: one card per ally role', sy.length === 4 && sy.some(x => /With Bot/.test(x)) && sy.some(x => /With Jungle/.test(x) && /jungle/.test(x)), sy);
        // builds (nothing saved)
        const bd = await h.ev(`(async () => { document.querySelector('#champion-root [data-tab="builds"]').click(); for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 100)); const t = document.querySelector('#champion-root .ch-body').textContent; if (!/Reading/.test(t)) return t; } return 'timeout'; })()`);
        R.ok('builds: explains on-demand download when nothing is saved', /No Coachless data saved/.test(bd) && /Download in Builds/.test(bd), bd.slice(0, 160));
        // my stats
        const ms = await h.ev(`(async () => { document.querySelector('#champion-root [data-tab="mine"]').click(); for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 100)); const t = document.querySelector('#champion-root .ch-body').textContent; if (!/Reading/.test(t)) return t; } return 'timeout'; })()`);
        R.ok('my stats: your games on the champion from Profile', /TestOwner#META on Ahri/.test(ms) && /67%/.test(ms) && /8W 4L/.test(ms) && /4\.00/.test(ms) && /6\.4/.test(ms) && /MVP/.test(ms), ms.slice(0, 300));
        // ARAM
        const ar = await h.ev(`(async () => { document.querySelector('#champion-root [data-tab="aram"]').click(); for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 100)); const t = document.querySelector('#champion-root .ch-body').textContent; if (!/Loading/.test(t)) return t; } return 'timeout'; })()`);
        R.ok('ARAM tab: Mayhem WR, tier, top augments (rare ones left out), LoLalytics core', /51\.70%/.test(ar) && /tier A/.test(ar) && /Archmage/.test(ar) && !/Rare/.test(ar) && /core build/.test(ar), ar.slice(0, 300));
        // click a matchup row -> that champion's page; palette entry
        await h.ev(`(async () => { document.querySelector('#champion-root [data-tab="matchups"]').click(); await new Promise(r => setTimeout(r, 50)); document.querySelector('#champion-root .ch-table tbody tr[data-hub="Akali"]').click(); return 1; })()`);
        await h.waitFor(`/Akali/.test(document.querySelector('#champion-root .ch-name h2').textContent)`, 10000);
        R.ok('a matchup row opens that champion (same role)', /Mid/.test(await h.ev(`document.querySelector('#champion-root .ch-role.on').textContent`)));
        R.ok('recent champions are remembered', JSON.stringify(h.settings().hubRecent.slice(0, 2)) === JSON.stringify(['Akali', 'Ahri']), h.settings().hubRecent);
        const pal = await h.ev(`(async () => { DD.openPalette(); const i = document.querySelector('.dg-pal-in'); i.value = 'ahri'; i.dispatchEvent(new Event('input')); await new Promise(r => setTimeout(r, 50));
            const first = document.querySelector('.dg-pal-item'); const txt = first.textContent; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); await new Promise(r => setTimeout(r, 300)); return txt; })()`);
        await h.waitFor(`/Ahri/.test(document.querySelector('#champion-root .ch-name h2').textContent)`, 10000);
        R.ok('Ctrl+K: the first champion result is its page', /Ahri/.test(pal) && /Champion page/.test(pal), pal);
        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
