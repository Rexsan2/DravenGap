// Fix pass D2 (champion page, build coaching, tier list, pool planner): checks for the review findings fixed in champion-hub.js,
// build-coach.js, tierlist.js and pool-planner.js.
//   Champion page: the Builds tab and the coaching card follow the Time Period, also when it changed in another view, and write
//   several patches as one range (A3-F6/A3-F7/D2-F5); coaching finds your account through profile:owner when the client has none
//   (A3-F15); My stats reloads after new games (D2-F6); the last role viewed is what a restart reopens (D2-F17); the matchup header's
//   pictures keep the lane (D2-F16); ally cards carry no "jungle" tag (D2-F19).
//   Tier list: the Search box keeps focus through a reload (D2-F18); Patch movers on a multi-patch period says to pick one patch
//   (D2-F9). Pool planner: the plan follows your pool (A1-F15/D2-F7) and redraws when it arrives; a plan finishing after a tab switch
//   is dropped (D2-F8); the 3-champion cap is reported as such (D2-F15).
const H = require('../lib/renderer-harness');
const { fixture } = require('../lib/common');
const R = H.results();

const ds = JSON.parse(fixture('data/coachless_builds_16.18.json'));
const PUUID = 'P'.padEnd(78, 'x');
// your Ahri Mid games: Liandry's (3118) in 9 of 10, Sorcerer's Shoes (3020) in all
const summary = games => ({ ok: true, puuid: PUUID, games, w: 6, k: 60, d: 30, a: 50, cs: 2000, mins: 300, kp: 550, roles: { MIDDLE: games }, queues: { 420: games }, last: [], score: 6, mvp: 1, ace: 0,
    items: { MIDDLE: { games: 10, freq: { 3118: 9, 3020: 10, 1056: 10 } } }, itemGames: 10, totalCached: 80 });

(async () => {
    try {
        let mineGames = 10;
        const h = await H.boot({ size: [1400, 900], ipc: {
            // the client is up but has no account with a region: only profile:owner (last owner seen / Settings) knows who you are
            'profile:me': () => ({ ok: true, me: { gameName: 'Someone', tagLine: 'ELSE' }, lcu: true, phase: 'None' }),
            'profile:owner': () => ({ ok: true, owner: { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1', puuid: PUUID }, source: 'last' }),
            'profile:champ-summary': (e, a) => (a && a.champId === 103 && a.gameName === 'TestOwner' ? summary(mineGames) : { ok: true, games: 0, items: {}, totalCached: 80 })
        } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        await h.ev(`window.addEventListener('unhandledrejection', e => console.error('Uncaught rejection: ' + String(e.reason && e.reason.stack || e.reason).replace(/\\s+/g, ' ').slice(0, 280))); 1`);
        // the Coachless fixture saved as patches 16.19 (current) and 16.18
        const saved = await h.ev(`(async () => {
            const db = await new Promise((res, rej) => { const r = indexedDB.open('draftdiff-datasets'); r.onsuccess = () => res(r.result); r.onerror = rej; });
            for (const patch of ['16.19', '16.18']) {
                const data = ${JSON.stringify(ds)}; data.patch = patch; data.scrapedAt = new Date().toISOString();
                const blob = await new Response(new Blob([JSON.stringify(data)]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
                await new Promise((res, rej) => { const tx = db.transaction('builds', 'readwrite'); tx.objectStore('builds').put({ key: 'builds|' + patch + '|emerald_plus', patch, rank: 'emerald_plus', enc: 'gzip', data: blob, bytes: blob.size, scrapedAt: data.scrapedAt, champions: 3, complete: false }); tx.oncomplete = res; tx.onerror = rej; });
            }
            return 2; })()`);
        R.ok('fixture saved as patches 16.19 and 16.18', saved === 2);
        const setPeriod = v => h.ev(`(() => { const s = document.getElementById('time-period-select'); s.value = '${v}'; s.dispatchEvent(new Event('change')); return s.value; })()`);
        const controls = () => h.ev(`((document.querySelector('#champion-root .ch-controls') || {}).textContent || '').replace(/\\s+/g, ' ')`);
        const coachFoot = () => h.ev(`((document.querySelector('#champion-root .coach-foot') || {}).textContent || '').replace(/\\s+/g, ' ')`);

        // ================================================================ champion page: Builds tab + coaching follow the Time Period
        await h.ev(`DD.openChampion('Ahri', 'MIDDLE'); 1`);
        await h.waitFor(`DD.currentView() === 'champion' && !!document.querySelector('#champion-root .ch-tab[data-tab="builds"]')`, 15000);
        await h.ev(`document.querySelector('#champion-root .ch-tab[data-tab="builds"]').click(); 1`);
        const card = await h.waitFor(`!!document.querySelector('#champion-root .coach') && /patch 16\\.19/.test(document.querySelector('#champion-root .ch-controls').textContent)`, 20000);
        R.ok('A3-F15: the coaching card shows with no account in the client (profile:owner answers)', card && /10 of your Ahri Mid games/.test(await h.ev(`document.querySelector('#champion-root .coach').textContent`)), { controls: await controls(), foot: await coachFoot() });
        R.ok('Builds tab and coaching footer on Current Patch: patch 16.19', /patch 16\.19 /.test(await controls()) && /patch 16\.19\./.test(await coachFoot()), { controls: await controls(), foot: await coachFoot() });
        await setPeriod('30');
        const pooled = await h.waitFor(`/patches 16\\.18–16\\.19/.test((document.querySelector('#champion-root .ch-controls') || {}).textContent || '') && /patches 16\\.18–16\\.19/.test((document.querySelector('#champion-root .coach-foot') || {}).textContent || '')`, 20000);
        R.ok('A3-F6/A3-F7: Last 30 Days on the champion page: Builds and coaching read 16.18 + 16.19, written as one range', pooled, { controls: await controls(), foot: await coachFoot() });
        R.ok('A3-F6: the coaching cache key has the period', await h.ev(`[...DDCoach._cache.keys()].some(k => k === 'Ahri|MIDDLE|30')`), await h.ev(`[...DDCoach._cache.keys()]`));
        // changed in another view: the page shows the new period when it is opened again
        await h.ev(`DD.showView('draft'); 1`);
        await setPeriod('patch');
        await h.sleep(800);
        await h.ev(`DD.showView('champion'); 1`);
        const back = await h.waitFor(`/patch 16\\.19 /.test((document.querySelector('#champion-root .ch-controls') || {}).textContent || '') && /patch 16\\.19\\./.test((document.querySelector('#champion-root .coach-foot') || {}).textContent || '')`, 20000);
        R.ok('A3-F6: a Time Period changed in another view is followed when the champion page is shown again', back, { controls: await controls(), foot: await coachFoot() });

        // ================================================================ My stats after new games (D2-F6)
        await h.ev(`document.querySelector('#champion-root .ch-tab[data-tab="mine"]').click(); 1`);
        await h.waitFor(`/in 10 saved games/.test(document.querySelector('#champion-root .ch-body').textContent)`, 10000);
        mineGames = 11;
        h.send('profile:update', { kind: 'matches', owner: true, puuid: PUUID, group: 'all', added: 1, ids: ['EUW1_9'] });
        R.ok('D2-F6: My stats reads your games again after profile:update { kind: matches, owner }', await h.waitFor(`/in 11 saved games/.test(document.querySelector('#champion-root .ch-body').textContent)`, 10000),
            await h.ev(`document.querySelector('#champion-root .ch-body').textContent.replace(/\\s+/g, ' ').slice(0, 200)`));

        // ================================================================ hubLast follows the role clicked (D2-F17)
        await h.ev(`document.querySelector('#champion-root .ch-role[data-role="TOP"]').click(); 1`);
        R.ok('D2-F17: a role button changes what a restart reopens (settings.hubLast)', await h.waitFor(`DDHub.state.role === 'TOP'`, 10000) && await (async () => { for (let i = 0; i < 40; i++) { const s = h.settings(); if (s.hubLast && s.hubLast.champ === 'Ahri' && s.hubLast.role === 'TOP') return true; await h.sleep(100); } return false; })(), h.settings().hubLast);

        // ================================================================ synergies: no "jungle" tag on ally cards (D2-F19)
        await h.ev(`DD.openChampion('Ahri', 'MIDDLE'); 1`);
        await h.waitFor(`DDHub.state.role === 'MIDDLE' && !DDHub.state.loading`, 10000);
        await h.ev(`document.querySelector('#champion-root .ch-tab[data-tab="synergies"]').click(); 1`);
        const heads = await h.ev(`[...document.querySelectorAll('#champion-root .ch-card-h')].map(x => x.textContent.trim())`);
        R.ok('D2-F19: ally cards are not tagged "jungle" (allies use the ally prior)', heads.length === 4 && heads.some(x => /With Jungle/.test(x)) && !heads.some(x => /jungle/.test(x)), heads);

        // ================================================================ matchup header pictures keep the lane (D2-F16)
        await h.ev(`DDHub.openMatchup('Akali', 'TOP', 'Aatrox'); 1`);
        await h.waitFor(`!!document.querySelector('#champion-root .ch-vs-head img') && DDHub.state.role === 'TOP' && !DDHub.state.loading`, 15000);
        await h.ev(`document.querySelector('#champion-root .ch-vs-head img').click(); 1`);
        await h.sleep(800);
        const st = await h.ev(`({ champ: DDHub.state.champ, role: DDHub.state.role, vs: DDHub.state.vs })`);
        R.ok('D2-F16: a click on the matchup header picture keeps the lane (Akali Top, not her most played Mid)', st.champ === 'Akali' && st.role === 'TOP', st);

        // ================================================================ tier list: Search box focus (D2-F18), movers on a day window (D2-F9)
        await h.ev(`DD.showView('tierlist'); 1`);
        await h.waitFor(`document.querySelectorAll('#tl-body .tl-row').length > 10`, 15000);
        await h.ev(`(() => { const q = document.getElementById('tl-q'); q.focus(); q.value = 'ah'; q.setSelectionRange(2, 2); q.dispatchEvent(new Event('input', { bubbles: true })); window.dispatchEvent(new Event('dd:archive-changed')); return 1; })()`);
        await h.sleep(1500);
        const focus = await h.ev(`({ id: document.activeElement && document.activeElement.id, value: document.getElementById('tl-q').value, pos: document.getElementById('tl-q').selectionStart, rows: document.querySelectorAll('#tl-body .tl-row').length })`);
        R.ok('D2-F18: the tier list Search box keeps its text, cursor and focus when the list reloads', focus.id === 'tl-q' && focus.value === 'ah' && focus.pos === 2 && focus.rows >= 1, focus);
        await h.ev(`(() => { const q = document.getElementById('tl-q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); q.blur(); return 1; })()`);
        await setPeriod('30');
        await h.waitFor(`/Last 30 Days/.test((document.querySelector('#tl-body .tl-m') || {}).textContent || '')`, 15000);
        await h.ev(`document.querySelector('#tierlist-root .tl-tab[data-tab="movers"]').click(); 1`);
        const movers = await h.ev(`document.getElementById('tl-body').textContent.replace(/\\s+/g, ' ')`);
        R.ok('D2-F9: Patch movers on Last 30 Days says to pick a single patch, not to download one', /compare single patches/.test(movers) && !/Download more history/.test(movers), movers.slice(0, 240));
        await setPeriod('patch');
        await h.waitFor(`/16\\.19|Current/.test((document.querySelector('#tierlist-root .dg-prov') || {}).textContent || '')`, 15000);

        // ================================================================ pool planner
        // D2-F15: four champions that each add a point: three are kept and the reason is the cap
        const ch = await h.ev(`(() => { const v = (i) => [0, 1, 2, 3].map(j => j === i ? 0.6 : 0.4); const r = DDPool.choose({ A: v(0), B: v(1), C: v(2), D: v(3) }, [0.25, 0.25, 0.25, 0.25], ['A', 'B', 'C', 'D']);
            const g = DDPool.choose({ A: [0.52, 0.48, 0.5], B: [0.47, 0.55, 0.5], C: [0.5, 0.5, 0.5] }, [0.4, 0.4, 0.2], ['A', 'B', 'C']); return { steps: r.steps.length, stop: r.stop, gStop: g.stop }; })()`);
        R.ok('D2-F15: the 3-champion cap is reported as the cap, the gain rule as the gain rule', ch.steps === 3 && ch.stop === 'cap' && ch.gStop === 'gain', ch);
        // A1-F15 / D2-F7: the plan follows your pool (unknown, then known)
        const pl = await h.ev(`(async () => { const real = DD.myPool; DD.myPool = () => null; const a = await DDPool.plan('MIDDLE'); DD.myPool = () => ['Ahri', 'Syndra', 'Leblanc']; const b = await DDPool.plan('MIDDLE'); DD.myPool = real;
            return { a: a.poolKnown, b: b.poolKnown, chosen: b.chosen }; })()`);
        R.ok('A1-F15: a plan made before your pool was known is not reused once it is', pl.a === false && pl.b === true && pl.chosen.length >= 1, pl);
        // D2-F8: a plan that finishes after a switch back to the Tier list tab does not replace the tier list
        await h.ev(`document.querySelector('#tierlist-root .tl-tab[data-tab="list"]').click(); document.querySelector('#tierlist-root .tl-role[data-role="MIDDLE"]').click(); 1`);
        await h.waitFor(`document.querySelectorAll('#tl-body .tl-row').length > 3`, 10000);
        // (a pool not planned before, so the plan is worked out afresh and finishes after the switch)
        await h.ev(`(() => { window.__realPool = DD.myPool; DD.myPool = () => ['Ahri', 'Syndra']; document.querySelector('#tierlist-root .tl-tab[data-tab="pool"]').click(); document.querySelector('#tierlist-root .tl-tab[data-tab="list"]').click(); return 1; })()`);
        await h.sleep(2500);
        const body = await h.ev(`({ table: !!document.querySelector('#tl-body .tl-table'), plan: !!document.querySelector('#tl-body .pp-wrap'), tab: DDTier.state.tab })`);
        R.ok('D2-F8: the pool plan does not overwrite the tier list after switching back to it', body.table && !body.plan && body.tab === 'list', body);
        // A1-F15: "Your pool is not known yet", then the pool arrives: the planner redraws by itself
        await h.ev(`(() => { DD.myPool = () => null; document.querySelector('#tierlist-root .tl-tab[data-tab="pool"]').click(); return 1; })()`);
        const unknown = await h.waitFor(`/pool is not known yet/.test(document.getElementById('tl-body').textContent)`, 15000);
        await h.ev(`(() => { DD.myPool = () => ['Ahri', 'Syndra', 'Leblanc']; return 1; })()`);
        const redrawn = await h.waitFor(`!!document.querySelector('#tl-body .pp-steps')`, 12000);
        R.ok('A1-F15: the pool planner redraws once your pool arrives', unknown && redrawn, await h.ev(`document.getElementById('tl-body').textContent.replace(/\\s+/g, ' ').slice(0, 200)`));
        await h.ev(`(() => { DD.myPool = window.__realPool; return 1; })()`);

        const errs = h.logs.filter(l => /Uncaught|TypeError|ReferenceError/.test(l));
        R.ok('no uncaught errors', errs.length === 0, errs.slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
