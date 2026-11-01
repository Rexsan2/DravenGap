// Stats & data fixes (code review 2026-11-01, fixer IDXB) in the real window:
//  A2-F9 "1 day ago", A2-F14 own slot not a pairing, A2-F8 Adaptive notes of unsaved patches (pure functions),
//  A2-F5 + A2-F13 reference prior for a second selection with the same reference (and its readable label),
//  A2-F1 a downloaded patch newer than the shared data, A2-F11 setup card time zone, A2-F6 columnar matchups out of the listed records,
//  A2-F4 + A2-F12 Patch range Apply fires 'change' and its header, A2-F2 + A2-F3 the last dataset before 'scrape-finished' without the
//  overlay, A2-F19 + A2-F3 Refresh on a downloaded Platinum+ window downloads it and reloads quietly, A2-F7 partial / smaller downloads
//  keep the saved copy, A2-F17 role frequencies follow the selected dataset, A2-F15 clearing the day windows, A2-F18 offline fallback.
const H = require('../lib/renderer-harness');
const { fixture } = require('../lib/common');
const zlib = require('zlib');
const R = H.results();

const stats = JSON.parse(fixture('data/champion_stats_patch_platplus.json'));
// the harness' matchup generator (same keys and values for a seed); scale shrinks the games (a smaller dataset inside the reference)
function makeMatchups(seed, scale = 1) {
    const out = {}; const top = stats.slice(0, 60); let r = seed;
    const rnd = () => { r = (r * 1103515245 + 12345) & 0x7fffffff; return r / 0x7fffffff; };
    for (const a of top) for (const b of top) {
        if (a.champion === b.champion) continue;
        const rel = a.role === b.role ? 'enemy' : 'teammate';
        out[JSON.stringify([a.champion, a.role, b.champion, b.role, rel])] = { win_rate: 0.45 + rnd() * 0.1, delta2: (rnd() - 0.5) * 0.04, total_games: Math.floor((300 + Math.floor(rnd() * 3000)) * scale) };
    }
    return out;
}
const stats18 = stats.map(s => (s.champion === 'Aatrox' && s.role === 'TOP' ? { ...s, role_frequency: 0.123 } : s));
const gz = o => zlib.gzipSync(Buffer.from(JSON.stringify(o)));
const HDR = "document.getElementById('last-updated-info').textContent";
const PINFO = "document.getElementById('patch-info').textContent";
const RUN = new Date(Date.now() - 30 * 3600e3).toISOString().slice(0, -1);   // the bucket's run 30 h ago (no zone, like the real file)
const idb = body => `(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('draftdiff-datasets'); r.onsuccess = () => res(r.result); r.onerror = rej; });
    const put = (store, rec) => new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete = res; tx.onerror = rej; });
    const del = (store, key) => new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(key); tx.oncomplete = res; tx.onerror = rej; });
    const get = (store, key) => new Promise((res, rej) => { const q = db.transaction(store).objectStore(store).get(key); q.onsuccess = () => res(q.result); q.onerror = rej; });
    const keys = store => new Promise((res, rej) => { const q = db.transaction(store).objectStore(store).getAllKeys(); q.onsuccess = () => res(q.result); q.onerror = rej; });
    try { ${body} } finally { db.close(); } })()`;
const select = tp => `(() => { const s = document.getElementById('time-period-select'); s.value = ${JSON.stringify(tp)}; s.dispatchEvent(new Event('change')); return s.value; })()`;
const sampleOverlay = `window.__ov = []; clearInterval(window.__ovT); window.__ovT = setInterval(() => window.__ov.push(document.getElementById('loading-overlay').style.display), 40); 1`;
const chipRefresh = `(async () => { document.querySelector('#rec-prov .dg-prov').click(); await new Promise(r => setTimeout(r, 120));
    document.querySelector('.dg-pop [data-prov-refresh]').click();
    for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 100)); const m = document.querySelector('.dg-pop-msg').textContent; if (m) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return m; } }
    return ''; })()`;

let CS = null;   // the champion select session Live Tracking reads (null: none)
(async () => {
    try {
        const h = await H.boot({ meta: H.makeMeta(RUN, '16.19.1'), settings: { timePeriod: 'patch', rank: 'platinum_plus', minGames: '0' }, ipc: { 'get-champ-select': () => CS } });
        await h.waitFor(`document.getElementById('loading-overlay').style.display === 'none' && document.querySelectorAll('.champion-tile').length > 50 && ${HDR}.length > 0`, 30000);
        await h.sleep(800);

        // ---------- A2-F9: singular units ----------
        const hdr0 = await h.ev(HDR);
        R.ok('A2-F9 header: "Data updated 1 day ago" (not "1 days")', /Data updated 1 day ago/.test(hdr0), hdr0);

        // ---------- A2-F14: the slot's own champion is not a pairing ----------
        const why = await h.ev(`(async () => {
            document.querySelector('.champion-tile[data-champion-name="Aatrox"]').click();
            document.querySelector('.role-slot[data-side="left"][data-role="TOP"]').click();
            await new Promise(r => setTimeout(r, 300));
            document.querySelector("[data-side='left'][data-role='TOP'] .suggest-btn").click();
            for (let i = 0; i < 100 && !document.querySelector('#recommendation-list li .why-btn'); i++) await new Promise(r => setTimeout(r, 100));
            const b = document.querySelector('#recommendation-list li .why-btn'); if (!b) return null;
            b.click(); await new Promise(r => setTimeout(r, 200));
            const p = document.querySelector('#recommendation-list .why-panel'); return { slot: document.querySelector('.role-slot[data-side="left"][data-role="TOP"]').dataset.champion, text: p ? p.textContent : null }; })()`);
        R.ok('A2-F14 Aatrox in your Top slot: no "pairing below Min Games" for the slot itself', why && why.slot === 'Aatrox' && why.text && !/below Min Games/.test(why.text), why);

        // ---------- A2-F8: Adaptive steps over a patch missing from the archive ----------
        const ad = await h.ev(`(() => {
            const row = (champion, role, games, win_rate) => ({ champion, role, games, win_rate, pick_rate: 0.01, role_frequency: 0.9 });
            const parts = [{ patch: '16.20', age: 0 }, { patch: '16.18', age: 2 }].map(p => ({ ...p, totalGames: 100000, statsList: [row('Rew', 'TOP', 3000, 0.5), row('Same', 'MIDDLE', 3000, 0.5)] }));
            const notes = { '16.20': {}, '16.19': { Rew: { kind: 'buff', context: 'A full champion rework', changes: [] }, Two: { kind: 'buff', changes: [] } }, '16.18': {} };
            notes['16.20'].Two = { kind: 'buff', changes: [] };
            const released = ['16.20', '16.19', '16.18'];
            const lookup = DD.adaptive.changesLookup(notes, released);
            const r = DD.adaptive.championStats(parts, lookup);
            const two = lookup('Two', '16.20', '16.18');
            const unknown = DD.adaptive.changesLookup({ '16.20': {}, '16.19': undefined }, released)('Same', '16.20', '16.18');
            const known = lookup('Same', '16.20', '16.18');
            return { rew: r.windows.get('Rew,TOP'), same: r.windows.get('Same,MIDDLE'), two, unknown: unknown === undefined ? 'undefined' : unknown, known }; })()`);
        R.ok('A2-F8 a rework in the unsaved 16.19 ends the window between 16.20 and 16.18 (win rate and pairs)', ad.rew && ad.rew.depth === 1 && ad.rew.pairDepth === 1, ad.rew);
        R.ok('A2-F8 an untouched champion keeps both parts', ad.same && ad.same.depth === 2 && ad.same.pairDepth === 2, ad.same);
        R.ok('A2-F8 two buffs in one step add up (prior means and variances summed)', ad.two && ad.two.kind === 'buff' && Math.abs(ad.two.prior.m - 0.0138) < 1e-9 && Math.abs(ad.two.prior.sd - Math.sqrt(2) * 0.0077) < 1e-9, ad.two);
        R.ok('A2-F8 a step with unreadable notes is "unknown", with readable ones "unchanged"', ad.unknown === 'undefined' && ad.known === null, ad);

        // ---------- records for the reload ----------
        await h.waitFor(idb(`return (await keys('archive')).includes('16.19|platinum_plus') && (await keys('live')).includes('30|platinum_plus');`), 30000);
        await h.sleep(500);
        await h.ev(`window.__S = ${JSON.stringify(stats)}; window.__S18 = ${JSON.stringify(stats18)}; window.__M2 = ${JSON.stringify(makeMatchups(2))}; window.__M3 = ${JSON.stringify(makeMatchups(3))};
            window.__D7 = ${JSON.stringify(makeMatchups(1, 0.2))}; 1`);
        const nowIso = new Date().toISOString();
        await h.ev(idb(`
            const rec = (key, period, rank, statsList, matchups, totalGames, at, source, extra) => ({ key, period, rank, patch: period === 'patch' ? key.split('|')[0] : null, enc: 'raw',
                stats: new Blob([JSON.stringify(statsList)]), matchups: new Blob([JSON.stringify(matchups)]), bytes: 1000, totalGames, last_updated_utc: at, savedAt: Date.now(), source, ...(extra || {}) });
            const old = new Date(Date.now() - 864e6).toISOString();
            await put('archive', rec('16.20|platinum_plus', 'patch', 'platinum_plus', __S, __M2, 30000, '${nowIso}', 'scraped'));
            await put('archive', rec('16.18|platinum_plus', 'patch', 'platinum_plus', __S18, __M2, 120000, old, 'scraped'));
            await put('archive', rec('16.17|platinum_plus', 'patch', 'platinum_plus', __S, __M3, 120000, old, 'scraped'));
            const m16 = new Map(Object.entries(__M3)); const cols = DD.adaptive.toCols(m16, m16.size);
            await put('archive', rec('16.16|platinum_plus', 'patch', 'platinum_plus', __S, __M3, 120000, old, 'scraped', { cols }));   // saved by an older version: cols inline
            await put('archive', rec('16.19|platinum_plus', 'patch', 'platinum_plus', __S, __M2, 77777, '${nowIso}', 'scraped'));      // downloaded after the bucket's run
            await put('archive', rec('16.19|emerald_plus', 'patch', 'emerald_plus', __S, __M2, 50000, new Date().toISOString().slice(0, -1), undefined));
            await put('live', rec('d7|emerald_plus', 'd7', 'emerald_plus', __S, {}, 10, new Date(Date.now() - 2 * 86400e3).toISOString(), 'scraped'));
            await put('live', rec('d7|platinum_plus', 'd7', 'platinum_plus', __S, __D7, 10, new Date(Date.now() - 3600e3).toISOString(), 'scraped'));
            await del('live', '30|platinum_plus');   // the reference downloads again (slowly) after the reload
            return 1;`));
        h.S.delay = 4000; h.S.log.length = 0;
        await h.ev(`window.__before = 1; location.reload(); 1`);
        await h.waitFor(`!window.__before && document.querySelectorAll('.champion-tile').length > 50 && document.getElementById('loading-overlay').style.display === 'none' && ${HDR}.length > 0`, 40000);

        // ---------- A2-F5 + A2-F13: the reference arrives for a second selection with the same reference ----------
        const refBefore = await h.ev(`document.getElementById('ref-status').textContent`);
        await h.ev(select('d7'));
        const gotRef = await h.waitFor(`/^Prior centred on Last 30 Days · Platinum\\+ data/.test(document.getElementById('ref-status').textContent)`, 25000);
        R.ok('A2-F5 Current Patch -> Last 7 Days while the 30-day reference loads: the prior arrives (not stuck on "Refining")', gotRef, { refBefore, now: await h.ev(`document.getElementById('ref-status').textContent`) });
        h.S.delay = 0;

        // ---------- A2-F1: a downloaded patch newer than the shared data ----------
        const opts = await h.ev(`[...document.getElementById('time-period-select').options].map(o => [o.value, o.textContent])`);
        const o20 = opts.find(o => o[0] === 'p:16.20'), last2 = opts.find(o => o[0] === 'last2');
        R.ok('A2-F1 Patch 16.20 (newer than the shared 16.19) is listed as its own period', !!o20 && /newer than the shared data/.test(o20[1]), opts);
        R.ok('A2-F1 Last 2 patches stays 16.18–16.19 and Adaptive leaves 16.20 out', last2 && /16\.18–16\.19/.test(last2[1]) && !(await h.ev(`DD.adaptive.patches('platinum_plus').map(p => p.patch)`)).includes('16.20'), { last2, ad: await h.ev(`DD.adaptive.patches('platinum_plus')`) });
        const cur = await h.ev(`(async () => { const d = await DD.adaptive.load('patch', 'platinum_plus'); return { games: d.total_games, scraped: d.info.scraped, savedAt: d.info.savedAt }; })()`);
        R.ok('A2-F1 Current Patch uses the copy downloaded after the bucket\'s run (no bucket download over it)', cur.games === 77777 && cur.scraped && !h.S.log.some(l => /patch\/platinum_plus\/all\/champion_stats/.test(l)), { cur, log: h.S.log });
        h.S.log.length = 0;
        await h.ev(`DD.freshness._backdate(3600000); DD.freshness.check('t')`);
        await h.sleep(800);
        const cur2 = await h.ev(`(async () => (await DD.adaptive.load('patch', 'platinum_plus')).total_games)()`);
        R.ok('A2-F1 a freshness check does not count it as stale (no download, still the downloaded copy)', cur2 === 77777 && !h.S.log.some(l => /champion_stats/.test(l)), { cur2, log: h.S.log });
        await h.ev(select('p:16.20'));
        await h.waitFor(`/Patch 16\\.20 · downloaded/.test(${PINFO})`, 15000);
        R.ok('A2-F1 selecting it shows "Patch 16.20 · downloaded"', /Patch 16\.20 · downloaded/.test(await h.ev(PINFO)), await h.ev(PINFO));

        // ---------- A2-F11: the setup card's saved time has its zone ----------
        const st = await h.ev(`DD.draftDataStatus()`);
        R.ok('A2-F11 draftDataStatus savedAt is UTC (ends in Z, a moment ago)', st.saved && /Z$/.test(st.savedAt) && Math.abs(Date.parse(st.savedAt) - Date.now()) < 10 * 60e3, st);

        // ---------- A2-F6: columnar matchups out of the listed records ----------
        const moved = await h.waitFor(idb(`const r = await get('archive', '16.16|platinum_plus'); const c = await get('cols', 'archive:16.16|platinum_plus'); return !!(r && !r.cols && r.colsRef && c && c.ref === r.colsRef && c.cols && c.cols.n > 1000);`), 15000);
        R.ok('A2-F6 a record with inline cols (older version) is moved to the cols store once listed', moved);
        await h.ev(`window.__heavy = 0; window.__lists = 0; const o = IDBObjectStore.prototype.getAll; IDBObjectStore.prototype.getAll = function (...a) { const q = o.apply(this, a);
            if (this.name === 'archive' || this.name === 'live') { window.__lists++; q.addEventListener('success', () => { if ((q.result || []).some(x => x && x.cols)) window.__heavy++; }); } return q; }; 1`);
        await h.ev(`DD.freshness._backdate(3600000); DD.freshness.check('t')`);
        await h.ev(`(async () => { await DD.openSavedData(); await new Promise(r => setTimeout(r, 300)); document.getElementById('storage-close-btn').click(); return 1; })()`);
        await h.sleep(600);
        const heavy = await h.ev(`({ heavy: window.__heavy, lists: window.__lists })`);
        R.ok('A2-F6 a freshness check and the Saved data dialog list the stores without reading any matchup arrays', heavy.lists > 0 && heavy.heavy === 0, heavy);
        const k16 = Object.keys(makeMatchups(3))[5], v16 = makeMatchups(3)[k16];
        const p16 = await h.ev(`(async () => { const d = await DD.adaptive.load('p:16.16', 'platinum_plus', true); return d && d.matchup_stats.get(${JSON.stringify(k16)}); })()`);
        R.ok('A2-F6 the moved patch still loads its matchups from the cols store', p16 && p16.total_games === v16.total_games && Math.abs(p16.win_rate - v16.win_rate) < 1e-12, { p16, v16 });

        // ---------- A2-F4 + A2-F12: Patch range Apply ----------
        await h.ev(`window.__chg = 0; document.getElementById('time-period-select').addEventListener('change', () => window.__chg++); 1`);
        await h.ev(select('range-pick'));
        const picker = await h.ev(`document.getElementById('range-modal').style.display`);
        await h.ev(`(() => { document.getElementById('range-from').value = '16.17'; document.getElementById('range-to').value = '16.18'; document.getElementById('range-apply-btn').click(); return 1; })()`);
        const rng = await h.ev(`({ chg: window.__chg, tp: document.getElementById('time-period-select').value })`);
        R.ok('A2-F4 Apply fires the selector\'s change event (every view reloads), value r:16.17-16.18', picker === 'flex' && rng.chg === 2 && rng.tp === 'r:16.17-16.18', { picker, rng });
        await h.waitFor(`/^Patches 16\\.17–16\\.18/.test(${PINFO}) && /saved/.test(${HDR})`, 20000);
        const rh = await h.ev(HDR);
        R.ok('A2-F12 range without the current patch: "Newest patch (16.18) saved …", not "Current patch updated"', /Newest patch \(16\.18\) saved/.test(rh) && !/Current patch/.test(rh), rh);

        // ---------- A2-F2 + A2-F3: the automatic job's dataset and 'scrape-finished' back to back ----------
        const autoQueued = h.scrapeCalls.some(c => c.opts && c.opts.background && c.jobs.some(j => j.period === '7' && j.rank === 'emerald_plus'));
        R.ok('(setup) the stale Emerald+ 7-day window was queued automatically', autoQueued, h.scrapeCalls);
        await h.ev(select('adaptive'));
        await h.waitFor(`/^Adaptive/.test(${PINFO})`, 20000);
        await h.ev(`(async () => { window.__ad = await DD.adaptive.load('adaptive', 'platinum_plus'); window.__dr = []; const o = DD.notify.dataReady; DD.notify.dataReady = i => { window.__dr.push(i); return o(i); }; return 1; })()`);
        await h.ev(sampleOverlay);
        h.send('scrape-dataset', { period: '7', rank: 'emerald_plus', statsGz: gz(stats), matchupsGz: gz(makeMatchups(5, 0.1)), totalGames: 12, scrapedAt: new Date().toISOString() });
        h.send('scrape-finished', { completed: 1, failed: 0, cancelled: false });
        await h.sleep(2500);
        const a2 = await h.ev(`(async () => ({ title: document.getElementById('storage-info').title, dr: window.__dr, ov: [...new Set(window.__ov)], same: (await DD.adaptive.load('adaptive', 'platinum_plus')) === window.__ad }))()`);
        R.ok('A2-F2 one dataset right before the finish: "1 saved" and the refresh toast (saved: 1)', /finished: 1 saved/.test(a2.title) && a2.dr.some(x => x.kind === 'scrape' && x.saved === 1), a2);
        R.ok('A2-F2 no TypeError from the late count', !h.logs.some(l => /TypeError|Could not save downloaded dataset/.test(l)), h.logs.filter(l => /Error|save/.test(l)).slice(-5));
        R.ok('A2-F3 an Emerald+ download while on Adaptive at Platinum+: no overlay, the shown dataset is not reloaded', !a2.ov.includes('flex') && a2.same, a2);

        // ---------- A2-F19 + A2-F3: Refresh on a downloaded Platinum+ 7-day window ----------
        await h.ev(select('d7'));
        await h.waitFor(`/Last 7 Days/.test(${PINFO})`, 15000);
        h.scrapeCalls.length = 0;
        const msg = await h.ev(chipRefresh);
        R.ok('A2-F19 Refresh starts a one-job download of that window (the user asked)', h.scrapeCalls.length === 1 && JSON.stringify(h.scrapeCalls[0].jobs) === JSON.stringify([{ period: '7', rank: 'platinum_plus' }]) && !(h.scrapeCalls[0].opts && h.scrapeCalls[0].opts.background) && /Downloading Last 7 Days · Platinum\+/.test(msg), { calls: h.scrapeCalls, msg });
        await h.ev(sampleOverlay);
        h.send('scrape-dataset', { period: '7', rank: 'platinum_plus', statsGz: gz(stats), matchupsGz: gz(makeMatchups(1, 0.25)), totalGames: 4242, scrapedAt: new Date().toISOString() });
        h.send('scrape-finished', { completed: 1, failed: 0, cancelled: false });
        const reloaded = await h.waitFor(`(async () => (await DD.adaptive.load('d7', 'platinum_plus')).total_games === 4242)()`, 15000);
        const ov2 = await h.ev(`[...new Set(window.__ov)]`);
        R.ok('A2-F3 the shown window is reloaded in the background with the new data (no overlay)', reloaded && !ov2.includes('flex'), { ov2, games: await h.ev(`(async () => (await DD.adaptive.load('d7', 'platinum_plus')).total_games)()`) });

        // ---------- A2-F7: partial / smaller downloads keep the saved copy ----------
        await h.ev(chipRefresh);
        h.send('scrape-dataset', { period: '16.18', rank: 'platinum_plus', statsGz: gz(stats), matchupsGz: gz({}), totalGames: 999999, failed: 5, requested: 850, scrapedAt: new Date().toISOString() });
        h.send('scrape-dataset', { period: '16.17', rank: 'platinum_plus', statsGz: gz(stats), matchupsGz: gz({}), totalGames: 10, failed: 0, requested: 850, scrapedAt: new Date().toISOString() });
        h.send('scrape-dataset', { period: '16.15', rank: 'platinum_plus', statsGz: gz(stats), matchupsGz: gz({}), totalGames: 5000, failed: 3, requested: 850, scrapedAt: new Date().toISOString() });
        h.send('scrape-finished', { completed: 3, failed: 0, cancelled: false });
        await h.sleep(2500);
        const a7 = await h.ev(idb(`const a = await get('archive', '16.18|platinum_plus'), b = await get('archive', '16.17|platinum_plus'), c = await get('archive', '16.15|platinum_plus');
            return { a: a && a.totalGames, b: b && b.totalGames, c: c && { games: c.totalGames, partial: c.partial, failedRoles: c.failedRoles }, title: document.getElementById('storage-info').title };`));
        R.ok('A2-F7 a partial download does not replace a complete patch', a7.a === 120000, a7);
        R.ok('A2-F7 a download with far fewer games does not replace the saved patch', a7.b === 120000, a7);
        R.ok('A2-F7 with nothing saved, a partial download is kept and marked partial', a7.c && a7.c.games === 5000 && a7.c.partial === true && a7.c.failedRoles === 3, a7);
        R.ok('A2-F7 the result line says so: "1 saved, 2 not saved"', /1 saved, 2 not saved/.test(a7.title), a7.title);

        // ---------- A2-F3: a download that replaces the shown data during champion select is applied once it ends ----------
        CS = { localPlayerCellId: 0, actions: [[]], theirTeam: [], myTeam: [{ cellId: 0, championId: 0, championPickIntent: 0 }], gameId: 77 };
        const inCs = await h.waitFor(`DD.flowState().inChampSelect === true`, 10000);
        await h.ev(chipRefresh);
        await h.ev(sampleOverlay);
        h.send('scrape-dataset', { period: '7', rank: 'platinum_plus', statsGz: gz(stats), matchupsGz: gz(makeMatchups(1, 0.3)), totalGames: 5151, scrapedAt: new Date().toISOString() });
        h.send('scrape-finished', { completed: 1, failed: 0, cancelled: false });
        await h.sleep(2000);
        const during = await h.ev(`(async () => (await DD.adaptive.load('d7', 'platinum_plus')).total_games)()`);
        CS = null;
        const after = await h.waitFor(`(async () => (await DD.adaptive.load('d7', 'platinum_plus')).total_games === 5151)()`, 10000);
        const ov3 = await h.ev(`[...new Set(window.__ov)]`);
        R.ok('A2-F3 in champion select the shown window keeps its numbers; the new download is applied when it ends (no overlay)', inCs && during === 4242 && after && !ov3.includes('flex'), { inCs, during, after, ov3 });

        // ---------- glossary hand-off (IDXA): the Exp WR entry names the "For you" column ----------
        R.ok('glossary Exp WR entry says "For you" column', /"For you" column/.test(await h.ev(`DD.glossary['exp-wr'].html`)));

        // ---------- A2-F17: role frequencies follow the selected dataset ----------
        await h.ev(select('p:16.18'));
        await h.waitFor(`/Patch 16\\.18/.test(${PINFO})`, 15000);
        const rp1 = await h.ev(`DD.freshness._roleProbs().Aatrox.TOP`);
        await h.ev(select('patch'));
        await h.waitFor(`/^Patch 16\\.19/.test(${PINFO})`, 15000);
        const rp2 = await h.ev(`DD.freshness._roleProbs().Aatrox.TOP`);
        await h.ev(`DD.adaptive.load('p:16.18', 'platinum_plus', true)`);
        const rp3 = await h.ev(`DD.freshness._roleProbs().Aatrox.TOP`);
        R.ok('A2-F17 back on Current Patch (in memory): its own role frequencies, not the last loaded patch\'s', rp1 === 0.123 && Math.abs(rp2 - 0.8551336146272854) < 1e-12 && rp3 === rp2, { rp1, rp2, rp3 });

        // ---------- A2-F15: clearing the downloaded rolling windows ----------
        await h.ev(select('d7'));
        await h.waitFor(`/Last 7 Days/.test(${PINFO})`, 15000);
        await h.ev(`window.__chg = 0; window.confirm = () => true; document.getElementById('storage-clear-live-btn').click(); 1`);
        await h.waitFor(`![...document.getElementById('time-period-select').options].some(o => o.value === 'd7')`, 10000);
        const a15 = await h.ev(`({ tp: document.getElementById('time-period-select').value, chg: window.__chg, opts: [...document.getElementById('time-period-select').options].map(o => o.value) })`);
        R.ok('A2-F15 the 7-day window is no longer offered, the selector moves to Current Patch with a change event', a15.tp === 'patch' && a15.chg >= 1 && !a15.opts.includes('d14'), a15);
        const colKeys = await h.ev(idb(`return await keys('cols');`));
        R.ok('A2-F6 clearing the rolling windows also drops their matchup arrays (the archive\'s stay)', !colKeys.some(k => k.startsWith('live:')) && colKeys.some(k => k.startsWith('archive:')), colKeys);
        await h.ev(`document.getElementById('storage-close-btn').click(); 1`);
        await h.sleep(800);

        // ---------- A2-F18: offline with the new patch's metadata saved but its dataset never downloaded ----------
        await h.ev(idb(`await del('archive', '16.19|platinum_plus'); await del('archive', '16.20|platinum_plus'); return 1;`));
        h.S.down = true;
        await h.ev(`window.__before = 1; location.reload(); 1`);
        await h.waitFor(`!window.__before && document.querySelectorAll('.champion-tile').length > 50 && document.getElementById('loading-overlay').style.display === 'none' && ${HDR}.length > 0`, 40000);
        await h.sleep(1000);
        const off = await h.ev(`({ p: ${PINFO}, w: ${HDR}, games: (window.DD.draftProv && DD.draftProv() || {}).games })`);
        R.ok('A2-F18 offline start: the newest saved patch (16.18) stands in, labelled, with the Offline note', /Patch 16\.18 · saved \(16\.19 not downloaded yet\)/.test(off.p) && /Offline/.test(off.w) && off.games === 120000, off);
        h.S.down = false;

        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.filter(l => /Uncaught|TypeError|ReferenceError/.test(l)).slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
