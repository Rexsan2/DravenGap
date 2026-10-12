// Build coaching (C8) end to end: real Coachless tables (fixture, saved as the current patch) + your games on Ahri Mid
// (stubbed profile:champ-summary) -> the card in the Builds view and in the champion hub's Builds tab; the Builds chip.
const H = require('../lib/renderer-harness');
const { fixture, APP } = require('../lib/common');
const R = H.results();

const ds = JSON.parse(fixture('data/coachless_builds_16.18.json'));
// you finish with Liandry's (3118) in 9 of 10 games and Sorcerer's Shoes (3020) in all of them
const summary = { ok: true, puuid: 'P'.padEnd(78, 'x'), games: 10, w: 6, k: 60, d: 30, a: 50, cs: 2000, mins: 300, kp: 550, roles: { MIDDLE: 10 }, queues: { 420: 10 }, last: [], score: 6, mvp: 1, ace: 0,
    items: { MIDDLE: { games: 10, freq: { 3118: 9, 3020: 10, 1056: 10 } } }, itemGames: 10, totalCached: 80 };

const skills = require(APP + 'aram-parsers').parseLolalyticsSkills(fixture('lolalytics/ahri_middle_build.html'));
const skillCalls = [];
(async () => {
    try {
        let calls = 0;
        const h = await H.boot({ ipc: {
            'profile:me': () => ({ ok: true, me: { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' }, lcu: true, phase: 'None' }),
            'profile:champ-summary': (e, a) => { calls++; return a && a.champId === 103 ? summary : { ok: true, games: 0, items: {}, totalCached: 80 }; },
            // skill order (skills-main.js): the saved LoLalytics page of Ahri Mid
            'build:skills': (e, a) => { skillCalls.push(a); return a.champion === 'Ahri' ? { ok: true, data: skills, fetchedAt: Date.now(), stale: false } : { ok: false, code: 'PARSE', error: 'no data' }; }
        } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        // save the fixture as the current patch (16.19) in the window's own store
        const saved = await h.ev(`(async () => {
            const data = ${JSON.stringify({ ...ds, patch: '16.19' })}; data.scrapedAt = new Date().toISOString();
            const blob = await new Response(new Blob([JSON.stringify(data)]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
            const db = await new Promise((res, rej) => { const r = indexedDB.open('draftdiff-datasets'); r.onsuccess = () => res(r.result); r.onerror = rej; });
            await new Promise((res, rej) => { const tx = db.transaction('builds', 'readwrite'); tx.objectStore('builds').put({ key: 'builds|16.19|emerald_plus', patch: '16.19', rank: 'emerald_plus', enc: 'gzip', data: blob, bytes: blob.size, scrapedAt: data.scrapedAt, champions: 3, complete: false }); tx.oncomplete = res; tx.onerror = rej; });
            return blob.size; })()`);
        R.ok('fixture saved as patch 16.19', saved > 1000, saved);
        await h.ev(`DD.openBuilds('Ahri', 'MIDDLE'); 1`);
        const got = await h.waitFor(`!!document.querySelector('#builds-body .coach')`, 20000);
        const card = await h.ev(`(() => { const c = document.querySelector('#builds-body .coach'); return c ? { text: c.textContent.replace(/\\s+/g, ' '), rows: c.querySelectorAll('.coach-row').length, alts: c.querySelectorAll('.coach-row.alt').length } : null; })()`);
        R.ok('Builds shows the skill order: Q > W > E and the first 15 level-ups, asked once for Ahri Mid', await h.waitFor(`(() => { const s = document.querySelector('#builds-body .sk-row:not(.sk-muted)'); return !!s && /Q > W > E/.test(s.textContent) && s.querySelectorAll('.sk-seq i').length === 15; })()`, 8000)
            && skillCalls.length === 1 && skillCalls[0].role === 'MIDDLE', skillCalls);
        R.ok('the Builds view shows your build vs the data', got && card && /Your build vs the data/.test(card.text) && /10 of your Ahri Mid games/.test(card.text) && card.rows >= 2, card);
        // the suggestions follow the rules: every suggested item has PP >= 90% and beats yours by 0.5+ adjusted WPA
        const check = await h.ev(`(async () => { const t = await DD.buildsTables('Ahri', 'MIDDLE'); const r = DDCoach.computeCoaching(${JSON.stringify(summary)}, t, 'MIDDLE');
            return r.rows.map(x => ({ id: x.item.id, share: x.share, adj: x.item.adj, alt: x.alt && { id: x.alt.id, pp: x.alt.pp, adj: x.alt.adj, buys: x.alt.buys } })); })()`);
        R.ok('every suggestion has PP >= 90%, +0.5 WPA and 1,000+ buys', check.length >= 2 && check.every(x => !x.alt || (x.alt.pp >= 0.9 && x.alt.adj - x.adj >= 0.005 && x.alt.buys >= 1000)), check);
        R.ok('the card matches the rules (one suggestion line per alternative)', card.alts === check.filter(x => x.alt).length, { card: card.alts, rules: check.filter(x => x.alt).length });
        const chip = await h.ev(`(document.querySelector('#builds-body .dg-prov') || {}).textContent`);
        R.ok('Builds chip: Emerald+, patch, games, Coachless', /Emerald\+/.test(chip) && /Patch 16\.19/.test(chip) && /games/.test(chip) && /Coachless/.test(chip), chip);
        // champion hub: Builds tab summary + the same card
        await h.ev(`DD.openChampion('Ahri', 'MIDDLE'); 1`);
        await h.waitFor(`DD.currentView() === 'champion' && !!document.querySelector('#champion-root .ch-tab[data-tab="builds"]')`, 10000);
        await h.ev(`document.querySelector('#champion-root .ch-tab[data-tab="builds"]').click(); 1`);
        const hub = await h.waitFor(`!!document.querySelector('#champion-root .coach') && document.querySelectorAll('#champion-root .ch-item').length > 5`, 15000);
        const hubText = await h.ev(`document.querySelector('#champion-root .ch-body').textContent.replace(/\\s+/g, ' ')`);
        R.ok('hub Builds tab: recommended set, keystone, spells and your-build card', hub && /Legendaries/.test(hubText) && /Keystone/.test(hubText) && /Summoner spells/.test(hubText) && /Your build vs the data/.test(hubText), hubText.slice(0, 300));
        R.ok('your games were read once for both places', calls === 1, calls);
        // a champion you have no games on: no card
        await h.ev(`DD.openBuilds('Quinn', 'JUNGLE'); 1`);
        await h.waitFor(`/Quinn/i.test(document.getElementById('builds-champ-input').value) && !!document.querySelector('#builds-body .builds-table')`, 15000);
        await h.sleep(800);
        R.ok('no card without your games', !(await h.ev(`!!document.querySelector('#builds-body .coach')`)));
        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
