// Builds fixes (code review 2026-11-01, fixer IDXA), in the real window with Coachless and the client stubbed:
//  A3-F9 a jungler keeps Flash; A3-F4 a failed skill-order read is asked again later; A3-F2 Send to client with a vs matchup sends
//  the item set on screen; A3-F11 Send messages keep their button, go with their keystone and champion; A3-F3 a failed matchup has
//  Try again; A3-F5 one failed detail download doesn't block other champions; A3-F16 a failed save ends with Try again; A3-F8 a
//  finished patch fetched mid-patch is fetched once more; A3-F13 DD.sendAll keeps to 3 patches and waits for a running download;
//  A3-F10 the rate-limit note updates by itself when the wait is over.
const H = require('../lib/renderer-harness');
const { fixture } = require('../lib/common');
const R = H.results();

const base = JSON.parse(fixture('data/coachless_builds_16.18.json'));
const clone = o => JSON.parse(JSON.stringify(o));
const ahri = base.champions['Ahri|MIDDLE'];
const overview = (rec, games) => { const r = clone(rec); r.games = games; delete r.items.components; r.items.boots = { all: r.items.boots.all }; r.runes.byKeystone = {}; return r; };
const detailOf = rec => ({ items: { components: clone(rec.items.components), boots: { 1: rec.items.boots['1'], 2: rec.items.boots['2'], 3: rec.items.boots['3'], '4+': rec.items.boots['4+'] } }, runes: { byKeystone: clone(rec.runes.byKeystone) } });
// the vs Zed games: legendaries and starters ranked the other way round, so the matchup's item set differs from all games
const vsRec = overview(ahri, 4321);
for (const r of vsRec.items.legendaries.all) r.wpa = -r.wpa;
for (const r of vsRec.items.starter.all) r.wpa = -r.wpa;
// saved datasets: 16.20 (current) with Ahri / Thresh / Quinn (with detail) and Leona; 16.19 with Leona fetched while 16.19 was current
const now = new Date().toISOString();
const ds20 = { ...clone(base), patch: '16.20', fetchedAt: {}, liveAt: {} };
ds20.champions['Leona|SUPPORT'] = clone(base.champions['Thresh|SUPPORT']);
ds20.champions['Graves|JUNGLE'] = overview(ahri, 7777);   // overview refreshed now; its detail tables (saved below) are 3 days old
for (const id of Object.keys(ds20.champions)) { ds20.fetchedAt[id] = now; ds20.liveAt[id] = true; }
const ds19 = { schema: 1, patch: '16.19', rank: 'emerald_plus', source: 'coachless', champions: { 'Leona|SUPPORT': clone(base.champions['Thresh|SUPPORT']) },
    fetchedAt: { 'Leona|SUPPORT': new Date(Date.now() - 20 * 86400000).toISOString() }, liveAt: { 'Leona|SUPPORT': true } };
const idb = body => `(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('draftdiff-datasets'); r.onsuccess = () => res(r.result); r.onerror = rej; });
    const put = (store, rec) => new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete = res; tx.onerror = rej; });
    const gz = async obj => new Response(new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
    const get = (store, key) => new Promise(res => { const q = db.transaction(store).objectStore(store).get(key); q.onsuccess = () => res(q.result); });
    const unzip = async blob => new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).json();
    ${body} })()`;
const saveBuilds = ds => idb(`const data = ${JSON.stringify(ds)}; data.scrapedAt = new Date().toISOString(); const blob = await gz(data);
    await put('builds', { key: 'builds|' + data.patch + '|emerald_plus', patch: data.patch, rank: 'emerald_plus', enc: 'gzip', data: blob, bytes: blob.size, scrapedAt: data.scrapedAt, champions: ${Object.keys(ds.champions).length}, complete: false }); return 1;`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    let h = null;
    try {
        const champCalls = [], detailCalls = [], itemsets = [], skillCalls = [];
        let syndraFails = 1, viktorRate = 1, runesSlow = false;
        h = await H.boot({
            meta: H.makeMeta(new Date().toISOString(), '16.20.1'),
            settings: { timePeriod: 'patch', rank: 'platinum_plus' },
            ipc: {
                'coachless-champion': async (e, req) => {
                    champCalls.push(req);
                    if (req.matchupKey) {
                        if (Number(req.matchupKey) === 134 && syndraFails-- > 0) return { ok: false, error: 'Coachless did not answer in time (test)' };
                        return { ok: true, record: vsRec };
                    }
                    if (req.champion === 'Viktor' && viktorRate-- > 0) return { ok: false, code: 'RATE_LIMITED', retryAt: Date.now() + 3000, error: 'Coachless rate limit (test)' };
                    if (req.champion === 'Lux') await sleep(1500);
                    return { ok: true, record: overview(ahri, 5000 + champCalls.length) };
                },
                'coachless-detail': (e, req) => { detailCalls.push(req); return req.champion === 'Zed' ? { ok: false, error: 'Coachless detail failed (test)' } : { ok: true, detail: detailOf(ahri) }; },
                'lcu:apply-itemset': (e, req) => { itemsets.push(req); return { ok: true, title: 'DravenGap ' + req.title, blocks: req.blocks.length }; },
                'lcu:apply-runes': async () => { if (runesSlow) await sleep(1000); return { ok: false, code: 'PAGES_FULL', error: 'No free rune page (2 in use). Use "Replace current page" (test).' }; },
                'lcu:apply-spells': (e, req) => ({ ok: true, spell1Id: req.spell1Id, spell2Id: req.spell2Id }),
                'build:skills': (e, req) => {
                    skillCalls.push(req);
                    if (req.champion === 'Kayle' && skillCalls.filter(c => c.champion === 'Kayle').length === 1) return { ok: false, code: 'NETWORK', error: 'Network error (test)' };
                    return { ok: true, data: { games: 1000, priority: { pick: { order: ['Q', 'E', 'W'], games: 600 } }, order: { pick: { seq: 'QEWQQRQEQERWEEW'.split(''), games: 300 } } } };
                }
            }
        });
        H.S.ddVersions = ['16.20.1', '16.19.1', '16.18.1', '16.17.1', '16.16.1', '16.15.1', '16.14.1'];
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        await h.ev(saveBuilds(ds20)); await h.ev(saveBuilds(ds19));
        await h.ev(idb(`await put('builds', { key: 'bdetail|16.20|Graves|JUNGLE', patch: '16.20', champion: 'Graves', role: 'JUNGLE', detail: ${JSON.stringify(detailOf(ahri))}, scrapedAt: new Date(Date.now() - 3 * 86400000).toISOString() }); return 1;`));
        await h.ev(`window.__before = 1`);
        h.w.webContents.reload();   // Data Dragon's patch list (and the saved builds) are read at start-up
        await h.waitFor(`!window.__before && document.querySelectorAll('.champion-tile').length > 50 && !!window.DD && !!DD.buildsMath && !!DD.skillOrder`, 40000);
        await h.sleep(500);
        const ev0 = h.ev; h.ev = code => { h.last = String(code).slice(0, 160); return ev0(code); };   // the failing script, for the report
        const body = () => h.ev(`document.getElementById('builds-body').textContent`);
        const calls = (champ, extra = () => true) => champCalls.filter(c => c.champion === champ && !c.matchupKey && extra(c)).length;

        // ---------- A3-F9: a jungler keeps Flash when it is common ----------
        const sp = await h.ev(`(() => { const row = (id, games, pickRate, wpa) => ({ id, games, pickRate, wpa, preBuyWp: 0.5 });
            const rec = { spells: [row(11, 10000, 1, 0.002), row(4, 9600, 0.96, 0), row(6, 400, 0.04, 0.01)] };
            return { jungle: DD.buildsMath.bvBestSpells(rec, 'JUNGLE'), mid: DD.buildsMath.bvBestSpells({ spells: [row(4, 9600, 0.96, 0), row(14, 5000, 0.5, 0.004), row(6, 400, 0.04, 0.01)] }, 'MIDDLE') }; })()`);
        R.ok('jungle: Smite + Flash, not Smite + the 4% Ghost with a higher WPA', JSON.stringify(sp.jungle) === '[11,4]', sp);
        R.ok('other roles unchanged: Flash + the best other spell', sp.mid && sp.mid[0] === 4 && sp.mid[1] !== 4, sp);

        // ---------- A3-F4: a failed skill-order read is shown, then asked for again after the retry time ----------
        await h.ev(`DD.skillOrder.retry.retryMs = 400; DD.skillOrder.slot('Kayle', 'TOP'); 1`);
        await h.waitFor(`DD.skillOrder.known.has('Kayle|TOP')`, 5000);
        const s1 = await h.ev(`DD.skillOrder.slot('Kayle', 'TOP')`);
        const kayle1 = skillCalls.filter(c => c.champion === 'Kayle').length;
        await h.sleep(500);
        await h.ev(`DD.skillOrder.slot('Kayle', 'TOP'); 1`);
        await h.waitFor(`/sk-lbl/.test(DD.skillOrder.slot('Kayle', 'TOP'))`, 5000);
        const kayle2 = skillCalls.filter(c => c.champion === 'Kayle').length;
        R.ok('skill order: the failure is shown at first (no new request), then read again after the retry time and shown', /Network error/.test(s1) && kayle1 === 1 && kayle2 === 2 && /sk-lbl/.test(await h.ev(`DD.skillOrder.slot('Kayle', 'TOP')`)), { s1: s1.slice(0, 120), kayle1, kayle2 });

        // ---------- A3-F2: Send to client with a vs matchup sends the item set that is on screen ----------
        const groupsOnScreen = () => h.ev(`[...document.querySelectorAll('#builds-body .builds-set-group')].map(g => ({ type: g.querySelector('.builds-set-title').textContent + ' (WPA)',
            items: [...g.querySelectorAll('.builds-set-item')].map(i => { const img = i.querySelector('img'); const m = img && /\\/item\\/(\\d+)\\.png/.exec(img.getAttribute('src') || ''); return Number(m ? m[1] : i.title); }) }))`);
        await h.ev(`DD.openBuilds('Ahri', 'MIDDLE'); 1`);
        await h.waitFor(`!!document.querySelector('#builds-body .builds-table') && !!document.querySelector('#builds-body [data-bapply="items"]')`, 20000);
        await h.ev(`document.querySelector('#builds-body [data-bapply="items"]').click(); 1`);
        await h.waitFor(`/Item set/.test((document.getElementById('builds-apply-msg') || {}).textContent || '')`, 5000);
        const allGames = itemsets[itemsets.length - 1];
        await h.ev(`DD.openBuilds('Ahri', 'MIDDLE', 'Zed'); 1`);
        await h.waitFor(`/Matchup: Ahri vs Zed/.test((document.querySelector('#builds-body .builds-vs-note') || {}).textContent || '')`, 20000);
        const shown = await groupsOnScreen();
        await h.ev(`document.querySelector('#builds-body [data-bapply="items"]').click(); 1`);
        await h.waitFor(`/Item set/.test((document.getElementById('builds-apply-msg') || {}).textContent || '')`, 5000);
        const vsSent = itemsets[itemsets.length - 1];
        R.ok('vs Zed: "Save item set" sends exactly the Recommended Item Set shown (the matchup\'s)', JSON.stringify(vsSent.blocks) === JSON.stringify(shown), { sent: vsSent.blocks, shown });
        R.ok('...which differs from the all-games set, and the set is named "vs Zed"', JSON.stringify(vsSent.blocks) !== JSON.stringify(allGames.blocks) && /vs Zed$/.test(vsSent.title) && !/vs/.test(allGames.title), { title: vsSent.title, allTitle: allGames.title });

        // ---------- A3-F11: Send messages keep their button, follow the keystone and stay with their champion ----------
        await h.ev(`DD.openBuilds('Ahri', 'MIDDLE'); 1`);
        await h.waitFor(`!document.querySelector('#builds-body .builds-vs-note') && !!document.querySelector('#builds-body [data-bapply="runes"]:not([disabled])')`, 20000);   // (the vs Zed page is gone)
        await h.ev(`document.querySelector('#builds-body [data-bapply="runes"]').click(); 1`);
        await h.waitFor(`!!document.querySelector('#builds-apply-msg [data-bapply="runes-replace"]')`, 5000);
        await h.ev(`document.querySelector('#builds-body [data-bitype="boots"]').click(); 1`);
        await h.sleep(300);
        const keepBtn = await h.ev(`!!document.querySelector('#builds-apply-msg [data-bapply="runes-replace"]') && /No free rune page/.test(document.getElementById('builds-apply-msg').textContent)`);
        R.ok('"No free rune page": a repaint (another item tab) keeps the text and its "Replace current page" button', keepBtn,
            await h.ev(`({ msg: (document.getElementById('builds-apply-msg') || {}).innerHTML, tab: (document.querySelector('#builds-body .builds-tab.active') || {}).textContent, ks: (document.querySelector('#builds-body tr[data-bks].selected') || {}).dataset })`));
        await h.ev(`(() => { const r = document.querySelector('#builds-body tr[data-bks]:not(.selected)'); if (r) r.click(); return !!r; })()`);
        await h.sleep(300);
        R.ok('another keystone selected: the rune message (about the other page) is gone', (await h.ev(`(document.getElementById('builds-apply-msg') || {}).textContent || ''`)).trim() === '');
        runesSlow = true;
        await h.ev(`document.querySelector('#builds-body [data-bapply="runes"]').click(); DD.openBuilds('Thresh', 'SUPPORT'); 1`);
        await h.waitFor(`/Thresh/i.test(document.getElementById('builds-champ-input').value)`, 5000);
        await h.sleep(1500);
        runesSlow = false;
        const threshMsg = await h.ev(`(document.getElementById('builds-apply-msg') || {}).textContent || ''`);
        R.ok('a result that arrives after switching champion does not land in the new champion\'s bar', threshMsg.trim() === '', threshMsg);

        // ---------- A3-F3: a failed matchup download has Try again ----------
        await h.ev(`DD.openBuilds('Ahri', 'MIDDLE', 'Syndra'); 1`);
        await h.waitFor(`!!document.querySelector('#builds-body .builds-vs-note [data-bvretry]')`, 20000);
        const errNote = await h.ev(`document.querySelector('#builds-body .builds-vs-note').textContent`);
        await h.ev(`document.querySelector('#builds-body .builds-vs-note [data-bvretry]').click(); 1`);
        const syn = await h.waitFor(`/Matchup: Ahri vs Syndra/.test((document.querySelector('#builds-body .builds-vs-note') || {}).textContent || '')`, 20000);
        R.ok('matchup vs Syndra fails once: the note says so with Try again; Try again downloads it', /did not answer/.test(errNote) && syn && champCalls.filter(c => Number(c.matchupKey) === 134).length === 2, { errNote, calls: champCalls.filter(c => Number(c.matchupKey) === 134).length });

        // ---------- A3-F5: one failed detail download does not leave every champion on "Loading this table" ----------
        await h.ev(`DD.openBuilds('Zed', 'MIDDLE'); 1`);
        await h.waitFor(`/Zed/.test(document.getElementById('builds-champ-input').value) && !document.querySelector('#builds-body .builds-vs-note') && !!document.querySelector('#builds-body [data-bitype="components"]')`, 20000);
        await h.ev(`document.querySelector('#builds-body [data-bitype="components"]').click(); 1`);
        const zedErr = await h.waitFor(`/Coachless detail failed/.test(document.getElementById('builds-body').textContent)`, 10000);
        const zedBtn = await h.ev(`!!document.querySelector('#builds-body .builds-items [data-bdetail]')`);
        await h.ev(`DD.openBuilds('Orianna', 'MIDDLE'); 1`);
        const ori = await h.waitFor(`!!document.querySelector('#builds-body .builds-items .builds-table') && !/Loading this table/.test(document.getElementById('builds-body').textContent)`, 20000);
        R.ok('Zed\'s Components fail: the error and its button are shown in place of "Loading this table"', zedErr && zedBtn);
        R.ok('then Orianna\'s Components load (a detail call for Orianna) instead of a stuck "Loading this table"', ori && detailCalls.some(c => c.champion === 'Orianna'), { ori, detail: detailCalls.map(c => c.champion), text: (await body()).slice(0, 300) });
        await h.ev(`document.querySelector('#builds-body [data-bitype="legendaries"]') && document.querySelector('#builds-body [data-bitype="legendaries"]').click(); 1`);

        // ---------- A3-F16: a save that fails ends with an error and Try again, not "Downloading..." for good ----------
        await h.ev(`(() => { const put = IDBObjectStore.prototype.put; let once = true;
            IDBObjectStore.prototype.put = function (rec) { if (once && rec && String(rec.key).startsWith('builds|16.20')) { once = false; throw new DOMException('Disk full (test)', 'QuotaExceededError'); } return put.apply(this, arguments); }; return 1; })()`);
        await h.ev(`DD.openBuilds('Malphite', 'TOP'); 1`);
        const saveErr = await h.waitFor(`/Could not save Malphite/.test(document.getElementById('builds-body').textContent) && !!document.querySelector('#builds-fetch-btn:not([disabled])')`, 15000);
        R.ok('the save fails: "Could not save ..." with Try again (not a stuck "Downloading")', saveErr && !/Downloading Coachless data for Malphite/.test(await body()), (await body()).slice(0, 300));
        await h.ev(`document.getElementById('builds-fetch-btn').click(); 1`);
        R.ok('Try again downloads and saves it', await h.waitFor(`!!document.querySelector('#builds-body .builds-table') && !/Could not save/.test(document.getElementById('builds-body').textContent)`, 15000));

        // ---------- A3-F8: a finished patch's record fetched while it was current is fetched once more ----------
        // (no saved LoLalytics patches here, so the select has no "Last 2 patches": add it; Builds reads the select's value)
        await h.ev(`(() => { const s = document.getElementById('time-period-select'); if (![...s.options].some(o => o.value === 'last2')) s.add(new Option('Last 2 patches (test)', 'last2')); s.value = 'last2'; return s.value; })()`);
        const leona0 = { p19: calls('Leona', c => c.patch === '16.19'), p20: calls('Leona', c => c.patch === '16.20') };
        await h.ev(`DD.openBuilds('Leona', 'SUPPORT'); 1`);
        await h.waitFor(`!!document.querySelector('#builds-body .builds-table')`, 20000);
        await h.sleep(1500);
        const leona1 = { p19: calls('Leona', c => c.patch === '16.19'), p20: calls('Leona', c => c.patch === '16.20') };
        await h.ev(`DD.openBuilds('Thresh', 'SUPPORT'); 1`); await h.sleep(800);
        await h.ev(`DD.openBuilds('Leona', 'SUPPORT'); 1`); await h.sleep(1500);
        const leona2 = { p19: calls('Leona', c => c.patch === '16.19'), p20: calls('Leona', c => c.patch === '16.20') };
        R.ok('Leona 16.19 (saved while 16.19 was current) is fetched once more; 16.20 (current, fresh) is not', leona0.p19 === 0 && leona1.p19 === 1 && leona1.p20 === 0,
            { leona0, leona1, saved19: await h.ev(idb(`const r = await get('builds', 'builds|16.19|emerald_plus'); const d = await unzip(r.data); return d.liveAt; `)) });
        R.ok('...and only once: opening her again makes no call', leona2.p19 === 1 && leona2.p20 === 0, leona2);
        // (for D2's hub footers) DD.buildsTables / DD.buildsSummary name the patches of the period with nothing saved for the champion
        const miss = await h.ev(`Promise.all([DD.buildsTables('Ahri', 'MIDDLE'), DD.buildsSummary('Ahri', 'MIDDLE'), DD.buildsTables('Leona', 'SUPPORT')]).then(([a, b, c]) => ({ a: a.missing, b: b.missing, c: c.missing }))`);
        R.ok('Last 2 patches: Ahri (only 16.20 saved) is missing 16.19 in buildsTables and buildsSummary; Leona misses nothing', JSON.stringify(miss) === '{"a":["16.19"],"b":["16.19"],"c":[]}', miss);
        // detail tables saved long before the overview's last refresh are fetched again when a detail table (Components) is opened
        await h.ev(`(() => { const s = document.getElementById('time-period-select'); s.value = 'patch'; return 1; })()`);
        await h.ev(`DD.openBuilds('Graves', 'JUNGLE'); 1`);
        await h.waitFor(`/Graves/.test(document.getElementById('builds-champ-input').value) && !!document.querySelector('#builds-body [data-bitype="components"]')`, 15000);
        await h.sleep(500);
        const gravesBefore = detailCalls.filter(c => c.champion === 'Graves').length;
        await h.ev(`document.querySelector('#builds-body [data-bitype="components"]').click(); 1`);
        const gravesDetail = await h.waitFor(`!!document.querySelector('#builds-body .builds-items .builds-table')`, 5000) && await (async () => { for (let i = 0; i < 50 && !detailCalls.some(c => c.champion === 'Graves'); i++) await sleep(100); return detailCalls.filter(c => c.champion === 'Graves').length; })();
        await h.sleep(800);
        await h.ev(`document.querySelector('#builds-body [data-bitype="legendaries"]').click(); 1`); await h.sleep(200);
        await h.ev(`document.querySelector('#builds-body [data-bitype="components"]').click(); 1`); await h.sleep(800);
        const gravesAfter = detailCalls.filter(c => c.champion === 'Graves').length;
        R.ok('3-day-old detail under a fresh overview: shown, and fetched again (once) when Components opens, not before', gravesBefore === 0 && gravesDetail === 1 && gravesAfter === 1, { gravesBefore, gravesDetail, gravesAfter });
        await h.ev(`document.querySelector('#builds-body [data-bitype="legendaries"]').click(); 1`);

        // ---------- A3-F13: DD.sendAll keeps to 3 patches and waits for a download already running ----------
        await h.ev(`(() => { const s = document.getElementById('time-period-select'); s.add(new Option('Last 6 patches (test)', 'last6')); s.value = 'last6'; return 1; })()`);
        const sa = await h.ev(`(async () => { const p1 = DD.sendAll('Lux', 'MIDDLE'); await new Promise(r => setTimeout(r, 100)); const p2 = DD.sendAll('Caitlyn', 'BOTTOM');
            const [a, b] = await Promise.all([p1, p2]); return { a: a.error || Object.keys(a.parts || {}), b: b.error || Object.keys(b.parts || {}) }; })()`);
        R.ok('DD.sendAll on a 6-patch period downloads at most 3 patches per champion', calls('Lux') === 3 && calls('Caitlyn') === 3, { lux: calls('Lux'), caitlyn: calls('Caitlyn') });
        R.ok('a Send started while another download runs waits for it instead of "No Coachless data"', Array.isArray(sa.a) && Array.isArray(sa.b) && sa.b.includes('items'), sa);
        await h.ev(`(() => { const s = document.getElementById('time-period-select'); s.value = 'patch'; s.dispatchEvent(new Event('change')); return 1; })()`);
        await h.sleep(800);

        // ---------- A3-F10: the rate-limit note updates by itself when the wait is over ----------
        await h.ev(`DD.openBuilds('Viktor', 'MIDDLE'); 1`);
        const blocked = await h.waitFor(`/rate limit reached/.test(document.getElementById('builds-body').textContent) && !!document.querySelector('#builds-fetch-btn[disabled]')`, 10000);
        const ready = await h.waitFor(`!!document.querySelector('#builds-fetch-btn:not([disabled])') || !!document.querySelector('#builds-body .builds-table')`, 6000);
        R.ok('rate limited: the note has a disabled Try again, enabled by itself once the wait is over (no click, no other repaint)', blocked && ready, (await body()).slice(0, 300));

        const errs = h.logs.filter(l => /Uncaught|TypeError|ReferenceError/.test(l));
        R.ok('no uncaught errors', errs.length === 0, errs.slice(-5));
    } catch (e) { R.ok('exception', false, String(e.message) + ' | last script: ' + (h && h.last) + ' | ' + JSON.stringify(h && h.logs ? h.logs.filter(l => /rror/.test(l)).slice(-4) : [])); }
    R.finish();
})();
