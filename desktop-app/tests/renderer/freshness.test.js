// Data freshness: STAGE=A (cold install, live refresh, patch change, re-scrape), B (restart, cache-first), C (offline restart).
// Run without STAGE it drives the three stages as separate Electron runs that share one scratch userData folder.
const { app } = require('electron');
const lib = require('../lib/renderer-harness');
if (!process.env.STAGE) {
    const { spawnSync } = require('child_process');
    const ud = require('../lib/common').scratch('fresh');
    let failed = 0;
    for (const st of ['A', 'B', 'C']) {
        const r = spawnSync(process.execPath, [__filename], { env: { ...process.env, STAGE: st, DG_TEST_UD: ud }, encoding: 'utf8', timeout: 150000, windowsHide: true });
        process.stdout.write('--- stage ' + st + '\n' + (r.stdout || '') + (r.stderr || ''));
        if (r.status !== 0) failed++;
    }
    app.exit(failed ? 1 : 0);
    return;
}
const STAGE = process.env.STAGE || 'A';
const results = []; let HH = null;
const ok = (name, cond, extra) => { results.push([cond ? 'PASS' : 'FAIL', name, extra === undefined ? '' : JSON.stringify(extra)]); };
const count = (S, re) => S.log.filter(l => re.test(l)).length;
const HDR = "document.getElementById('last-updated-info').textContent";
const T1 = '2026-10-03T21:26:03.135495', T2 = '2026-10-04T09:00:00.000000', T3 = '2026-10-05T08:00:00.000000';

async function pickDraft(h) {
    return h.ev(`(async () => {
        const tile = document.querySelector('.champion-tile[data-champion-name="Aatrox"]');
        const slot = document.querySelector('.role-slot[data-side="left"][data-role="TOP"]');
        tile.click(); slot.click();
        await new Promise(r => setTimeout(r, 200));
        document.getElementById('min-games-filter') && (document.getElementById('min-games-filter').value = '1234');
        document.getElementById('min-games-filter') && document.getElementById('min-games-filter').dispatchEvent(new Event('input'));
        await new Promise(r => setTimeout(r, 300));
        return slot.dataset.champion || null;
    })()`);
}
const state = h => h.ev(`(() => ({ champ: (document.querySelector('.role-slot[data-side="left"][data-role="TOP"]')||{dataset:{}}).dataset.champion || null,
    minGames: (document.getElementById('min-games-filter')||{}).value, hdr: ${HDR}, patchInfo: document.getElementById('patch-info') && document.getElementById('patch-info').textContent,
    overlay: document.getElementById('loading-overlay').style.display, tp: document.getElementById('time-period-select').value,
    opts: [...document.getElementById('time-period-select').options].map(o => o.value) }))()`);
const startHist = h => h.ev(`window.__hist = []; setInterval(() => { const t = ${HDR}; if (window.__hist[window.__hist.length-1] !== t) window.__hist.push(t); }, 40); 1`);

(async () => {
  try {
    if (STAGE === 'A') {
      const h = HH = await lib.boot({ userData: process.env.DG_TEST_UD, meta: lib.makeMeta(T1, '16.19.1') });
      await h.waitFor(`document.getElementById('loading-overlay').style.display === 'none' && ${HDR}.length > 0`, 30000);
      await h.sleep(1500);
      let s = await state(h);
      ok('A1 cold start renders (first download, as before)', /Data updated/.test(s.hdr), s);
      ok('A1 downloaded patch dataset once', count(h.S, /champion_stats/) >= 1, h.S.log.filter(l => /stats/.test(l)));
      const draft = await pickDraft(h);
      ok('A2 draft champion set', draft === 'Aatrox', draft);
      await startHist(h);
      // --- already fresh: no refresh
      h.S.log.length = 0;
      await h.ev(`DD.freshness._backdate(3600000); void DD.freshness.check('t'); 1`);
      await h.sleep(800);
      ok('A3 already fresh -> only metadata requests, no dataset download', count(h.S, /champion_stats|matchup_win/) === 0 && count(h.S, /metadata/) === 1, h.S.log);
      // --- remote run is newer
      h.S.meta = lib.makeMeta(T2, '16.19.1'); h.S.seed = 2; h.S.delay = 1200; h.S.log.length = 0;
      await h.ev(`DD.freshness._backdate(3600000); void DD.freshness.check('t'); 1`);
      await h.sleep(500);
      const mid = await state(h);
      ok('A4 during refresh: no blocking overlay, status "Updating data…"', mid.overlay !== 'flex' && /Updating data/.test(mid.hdr), mid);
      await h.waitFor(`/just now/.test(${HDR})`, 15000);
      await h.sleep(600);
      const after = await state(h);
      ok('A4 status flips to "Data updated just now"', /Data updated just now/.test(after.hdr), after);
      ok('A4 draft + filter kept', after.champ === 'Aatrox' && after.minGames === '1234', after);
      ok('A4 exactly one stats + one matchups download for the selected period (refs may load too)', count(h.S, /patch\/platinum_plus\/all\/champion_stats/) === 1 && count(h.S, /patch\/platinum_plus\/all\/matchup/) === 1, h.S.log);
      const hist = await h.ev('window.__hist');
      ok('A4 header history', hist.some(t => /Updating/.test(t)) && hist.some(t => /just now/.test(t)), hist);
      // after flash, back to the normal text
      await h.sleep(8500);
      const later = await state(h);
      ok('A4 flash expires into the normal "Data updated … ago" text', /Data updated .*ago/.test(later.hdr), later);
      // second check right away: nothing
      h.S.log.length = 0; h.S.delay = 0;
      await h.ev(`DD.freshness._backdate(3600000); void DD.freshness.check('t'); 1`);
      await h.sleep(800);
      ok('A5 second check: no download', count(h.S, /champion_stats|matchup_win/) === 0, h.S.log);
      // concurrency: two simultaneous checks -> one run
      h.S.log.length = 0;
      await h.ev(`DD.freshness._backdate(3600000); Promise.all([DD.freshness.check('a'), DD.freshness.check('b'), DD.freshness.check('c')])`);
      ok('A6 concurrent checks coalesce into one metadata fetch', count(h.S, /metadata/) === 1, h.S.log);
      // focus trigger: recent check -> no fetch; old check -> fetch
      h.S.log.length = 0;
      await h.ev(`window.dispatchEvent(new Event('focus'))`); await h.sleep(500);
      ok('A7 focus right after a check -> nothing', count(h.S, /metadata/) === 0, h.S.log);
      await h.ev(`DD.freshness._backdate(20*60*1000); window.dispatchEvent(new Event('focus'))`); await h.sleep(800);
      ok('A7 focus after 20 min -> a check runs', count(h.S, /metadata/) === 1, h.S.log);

      // --- data dragon version
      h.S.ddVersions = ['16.20.1', ...h.S.ddVersions]; h.S.log.length = 0;
      await h.ev(`DD.freshness._backdate(3600000); void DD.freshness.check('t'); 1`); await h.sleep(1200);
      ok('A8 new Data Dragon version picked up', (await h.ev('DD.getLatestPatch()')) === '16.20.1', await h.ev('DD.getLatestPatch()'));

      // --- re-scrape: rolling window
      await h.ev(`(async () => {
          const db = await new Promise((res, rej) => { const r = indexedDB.open('draftdiff-datasets'); r.onsuccess = () => res(r.result); r.onerror = rej; });
          const put = (store, rec) => new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete = res; tx.onerror = rej; });
          const old = new Date(Date.now() - 2 * 86400000).toISOString(), fresh = new Date(Date.now() - 3600000).toISOString();
          const base = { enc: 'raw', stats: new Blob(['[]']), matchups: new Blob(['{}']), bytes: 4, totalGames: 10, savedAt: Date.now(), source: 'scraped', patch: null };
          await put('live', { ...base, key: 'd7|platinum_plus', period: 'd7', rank: 'platinum_plus', last_updated_utc: old });
          await put('live', { ...base, key: 'd14|platinum_plus', period: 'd14', rank: 'platinum_plus', last_updated_utc: fresh });
          await put('live', { ...base, key: 'd7|emerald_plus', period: 'd7', rank: 'emerald_plus', last_updated_utc: old });
          await put('live', { ...base, key: 'd14|emerald_plus', period: 'd14', rank: 'emerald_plus', last_updated_utc: fresh });
          return 1; })()`);
      h.scrapeCalls.length = 0;
      await h.ev(`DD.freshness._backdate(3600000); void DD.freshness.check('t'); 1`); await h.sleep(1500);
      ok('B1 only the stale Emerald+ 7-day window queued (Platinum+ skipped), background flag, d14 (fresh) skipped', h.scrapeCalls.length === 1 && h.scrapeCalls[0].opts && h.scrapeCalls[0].opts.background === true && JSON.stringify(h.scrapeCalls[0].jobs) === JSON.stringify([{ period: '7', rank: 'emerald_plus' }]), h.scrapeCalls);
      await h.ev(`DD.freshness._backdate(3600000); void DD.freshness.check('t'); 1`); await h.sleep(1200);
      ok('B2 not queued again while that job is active', h.scrapeCalls.length === 1, h.scrapeCalls.length);
      h.send('scrape-finished', { completed: 0, failed: 1, cancelled: false }); await h.sleep(300);
      await h.ev(`DD.freshness._backdate(3600000); void DD.freshness.check('t'); 1`); await h.sleep(1200);
      ok('B3 failed job is not retried within 12 h', h.scrapeCalls.length === 1, h.scrapeCalls.length);

      // --- new patch on R2
      h.S.meta = lib.makeMeta(T3, '16.20.1'); h.S.seed = 3; h.S.delay = 300; h.S.log.length = 0; h.scrapeCalls.length = 0;
      await h.ev(`DD.freshness._backdate(3600000); void DD.freshness.check('t'); 1`);
      await h.waitFor(`/just now/.test(${HDR})`, 15000); await h.sleep(800);
      const np = await state(h);
      ok('C1 header shows the new patch', /16\.20/.test(np.patchInfo) , np);
      ok('C1 old patch archived and listed', np.opts.includes('p:16.19'), np.opts);
      ok('C1 draft + filter kept across patch change', np.champ === 'Aatrox' && np.minGames === '1234', np);
      ok('C1 new patch downloaded for the selected rank', count(h.S, /patch\/platinum_plus\/all\/champion_stats/) === 1, h.S.log);
      const arch = await h.ev(`(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('draftdiff-datasets'); r.onsuccess = () => res(r.result); r.onerror = rej; });
          return await new Promise(res => { const q = db.transaction('archive').objectStore('archive').getAllKeys(); q.onsuccess = () => res(q.result); }); })()`);
      ok('C1 archive holds both patches', arch.includes('16.19|platinum_plus') && arch.includes('16.20|platinum_plus'), arch);
      await h.sleep(1500);
      // the just-ended patch (16.19) has an R2 snapshot (not scraped) and the user uses the scraper -> queued once
      await h.ev(`DD.freshness._backdate(3600000); void DD.freshness.check('t'); 1`); await h.sleep(1500);
      ok('C2a finished Platinum+ patch is not re-downloaded automatically (Emerald+ only)', !h.scrapeCalls.some(c => c.jobs.some(j => j.period === '16.19')), h.scrapeCalls);
      h.send('scrape-finished', { completed: 0, failed: 0, cancelled: false }); await h.sleep(200); h.scrapeCalls.length = 0;
      await h.ev(`(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('draftdiff-datasets'); r.onsuccess = () => res(r.result); r.onerror = rej; });
          const rec = await new Promise(res => { const q = db.transaction('archive').objectStore('archive').get('16.19|platinum_plus'); q.onsuccess = () => res(q.result); });
          const em = { ...rec, key: '16.19|emerald_plus', rank: 'emerald_plus' };
          await new Promise(res => { const tx = db.transaction('archive', 'readwrite'); tx.objectStore('archive').put(em); tx.oncomplete = res; }); return 1; })()`);
      await h.ev(`DD.freshness._backdate(3600000); void DD.freshness.check('t'); 1`); await h.sleep(1500);
      const patchJobs = h.scrapeCalls.filter(c => c.jobs.some(j => j.period === '16.19'));
      ok('C2 finished Emerald+ patch (R2 snapshot only) queued for a single full scrape', patchJobs.length === 1 && JSON.stringify(patchJobs[0].jobs.filter(j => j.period === '16.19')) === JSON.stringify([{ period: '16.19', rank: 'emerald_plus' }]), h.scrapeCalls);
      h.send('scrape-finished', { completed: 1, failed: 0, cancelled: false }); await h.sleep(200);
      // mark as scraped and check nothing more for finished patches
      await h.ev(`(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('draftdiff-datasets'); r.onsuccess = () => res(r.result); r.onerror = rej; });
          const rec = await new Promise(res => { const q = db.transaction('archive').objectStore('archive').get('16.19|emerald_plus'); q.onsuccess = () => res(q.result); });
          rec.source = 'scraped'; await new Promise(res => { const tx = db.transaction('archive', 'readwrite'); tx.objectStore('archive').put(rec); tx.oncomplete = res; }); return 1; })()`);
      h.scrapeCalls.length = 0;
      await h.ev(`DD.freshness._backdate(3600000); void DD.freshness.check('t'); 1`); await h.sleep(1200);
      ok('C3 scraped finished patch never re-scraped', !h.scrapeCalls.some(c => c.jobs.some(j => j.period === '16.19')), h.scrapeCalls);
      // manual scrape running -> skipped
      ok('C4 console errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.slice(-5));
    }

    if (STAGE === 'B') { // restart: cached data from run T2/T3 exists; remote is now newer, dataset responses are slow
      const h = HH = await lib.boot({ userData: process.env.DG_TEST_UD, meta: lib.makeMeta('2026-10-06T08:00:00.000000', '16.20.1') });
      h.S.delay = 4000;
      await h.sleep(2500);
      const early = await h.ev(`(() => ({ overlay: document.getElementById('loading-overlay').style.display, hdr: ${HDR}, rows: document.querySelectorAll('#recommendation-list li').length, champs: document.querySelectorAll('.champion-tile').length }))()`);
      ok('D1 cache-first: UI is up (no overlay) while the newer download is still in flight', early.overlay === 'none' && early.champs > 50 && !/Offline/.test(early.hdr), early);
      ok('D1 header is "Updating data…" during the background refresh', /Updating data/.test(early.hdr), early.hdr);
      await h.waitFor(`/just now/.test(${HDR})`, 20000);
      const fin = await h.ev(`${HDR}`);
      ok('D2 replaced by fresh data and flagged "just now"', /just now/.test(fin), fin);
      ok('D2 one download of the selected period', count(h.S, /patch\/platinum_plus\/all\/champion_stats/) === 1, h.S.log.filter(l => /stats/.test(l)));
    }

    if (STAGE === 'C') { // offline
      const h = HH = await lib.boot({ userData: process.env.DG_TEST_UD, meta: lib.makeMeta(T3, '16.20.1') });
      h.S.down = true;
      await h.srv.close();
      await h.sleep(500);
      await h.w.reload(); await h.sleep(1500);
      await h.waitFor(`document.getElementById('loading-overlay').style.display === 'none' && ${HDR}.length > 0 && document.querySelectorAll('.champion-tile').length > 0`, 30000);
      await h.sleep(1500);
      const s = await state(h);
      ok('E1 offline start renders from saved data', /Offline/.test(s.hdr) && s.overlay === 'none', s);
      await h.ev(`void DD.freshness.check('t'); 1`); await h.sleep(800);
      const s2 = await state(h);
      ok('E2 check while offline is quiet and keeps the offline text', /Offline/.test(s2.hdr), s2);
      ok('E3 no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.slice(-5));
    }
  } catch (e) { results.push(['FAIL', 'exception', e.stack]); if (HH) console.log('LOGS', JSON.stringify(HH.logs.slice(-15))); }
  for (const r of results) console.log(r.join(' | '));
  const fails = results.filter(r => r[0] === 'FAIL').length;
  console.log('SUMMARY', results.length - fails, 'pass', fails, 'fail');
  app.exit(fails ? 1 : 0);
})();
