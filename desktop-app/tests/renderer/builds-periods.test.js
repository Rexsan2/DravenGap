// Builds time periods (feedback items 4, 8, 9 and the D3 statistics check), in the real window:
//  - patch span labels ("16.17–16.20", "· 16.19 missing") in the Time Period options and the data chip,
//  - Time Period "Last 30 days" in Builds pools the Coachless patches released inside it (no "no builds equivalent" warning),
//  - matchup (vs) records and on-demand champion records (with rune detail) survive a restart: no second Coachless call,
//    "empty" answers expire after 24 h, Settings > Data lists them and Clear removes them,
//  - several pooled patches: between-patch variance lowers PP for a row that swings, single patches are unchanged.
// Coachless itself is stubbed (coachless-champion / coachless-detail); R2 and Data Dragon come from the harness.
const H = require('../lib/renderer-harness');
const { fixture } = require('../lib/common');
const R = H.results();

const base = JSON.parse(fixture('data/coachless_builds_16.18.json'));
const stats = fixture('data/champion_stats_patch_platplus.json');
const clone = o => JSON.parse(JSON.stringify(o));
const setWpa = (ds, champ, id, wpa) => { ds.champions[champ].items.legendaries.all.find(r => r.id === id).wpa = wpa; return ds; };
// 3118 (Ahri) swings between the two patches; everything else is identical
const ds20 = setWpa(clone({ ...base, patch: '16.20' }), 'Ahri|MIDDLE', 3118, 0.010);
const ds19 = setWpa(clone({ ...base, patch: '16.19' }), 'Ahri|MIDDLE', 3118, -0.006);

// what Coachless returns for one champion-role on demand: the overview only (no components, no boot slots, no rune detail)
const overview = (rec, games) => { const r = clone(rec); r.games = games; delete r.items.components; r.items.boots = { all: r.items.boots.all }; r.runes.byKeystone = {}; return r; };
const detailOf = rec => ({ items: { components: clone(rec.items.components), boots: { 1: rec.items.boots['1'], 2: rec.items.boots['2'], 3: rec.items.boots['3'], '4+': rec.items.boots['4+'] } }, runes: { byKeystone: clone(rec.runes.byKeystone) } });
const ahri = base.champions['Ahri|MIDDLE'];

const idb = body => `(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('draftdiff-datasets'); r.onsuccess = () => res(r.result); r.onerror = rej; });
    const get = (store, key) => new Promise(res => { const q = db.transaction(store).objectStore(store).get(key); q.onsuccess = () => res(q.result); });
    const all = store => new Promise(res => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => res(q.result); });
    const put = (store, rec) => new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete = res; tx.onerror = rej; });
    const gz = async obj => new Response(new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
    const unzip = async blob => new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).json();
    ${body} })()`;
const saveBuilds = (ds, champions) => idb(`const data = ${JSON.stringify(ds)}; data.scrapedAt = new Date().toISOString(); const blob = await gz(data);
    await put('builds', { key: 'builds|' + data.patch + '|emerald_plus', patch: data.patch, rank: 'emerald_plus', enc: 'gzip', data: blob, bytes: blob.size, scrapedAt: data.scrapedAt, champions: ${champions}, complete: false }); return blob.size;`);

(async () => {
    try {
        let champCalls = [], detailCalls = [];
        const h = await H.boot({
            meta: H.makeMeta(new Date().toISOString(), '16.20.1'),
            settings: { timePeriod: '30', rank: 'platinum_plus' },
            ipc: {
                // matchup answers: Zed has games; Annie has none yet. Plain champion answers: the overview of that champion-role
                'coachless-champion': (e, req) => {
                    champCalls.push(req);
                    if (req.champion === 'Garen' && req.patch === '16.19') return { ok: false, error: 'Coachless is not answering (test)' };
                    if (req.matchupKey) return { ok: true, record: Number(req.matchupKey) === 1 ? null : overview(ahri, 4321) };
                    return { ok: true, record: overview(ahri, 9000 + champCalls.length) };
                },
                'coachless-detail': (e, req) => { detailCalls.push(req); return { ok: true, detail: detailOf(ahri) }; }
            }
        });
        H.S.ddVersions = ['16.20.1', '16.19.1', '16.18.1', '16.17.1'];
        const reload = async () => {
            await h.ev(`window.__before = 1`);
            h.w.webContents.reload();
            await h.waitFor(`!window.__before && document.querySelectorAll('.champion-tile').length > 50 && !!window.DD && !!DD.patchLabels`, 40000);
            await h.sleep(500);
        };
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        await reload(); // Data Dragon's list (with 16.20) is only read at start-up

        // ---------- item 4: labels ----------
        const lab = await h.ev(`({ a: DD.patchLabels.range(['16.20', '16.18', '16.17']), b: DD.patchLabels.range(['16.19']), c: DD.patchLabels.range([]), d: DD.patchLabels.range(['16.10', '16.9']),
            e: DD.patchLabels.range(['16.19', '16.19', '16.18']), miss: DD.patchLabels.missingIn(['16.20', '16.18', '16.17']), none: DD.patchLabels.missingIn(['16.20', '16.19']),
            note: DD.patchLabels.missingNote(['16.19']), noNote: DD.patchLabels.missingNote([]) })`);
        R.ok('patchRangeLabel: lowest–highest, one patch plain, numeric order', lab.a === '16.17–16.20' && lab.b === '16.19' && lab.c === '' && lab.d === '16.9–16.10' && lab.e === '16.18–16.19', lab);
        R.ok('missing patches are the released ones inside the span', JSON.stringify(lab.miss) === '["16.19"]' && lab.none.length === 0 && lab.note === ' · 16.19 missing' && lab.noNote === '', lab);

        // saved LoLalytics patches 16.18 and 16.17 (Plat+), 16.19 is not saved
        const entry = (p) => `await put('archive', { key: '${p}|platinum_plus', patch: '${p}', rank: 'platinum_plus', enc: 'raw', stats: new Blob([${JSON.stringify(stats)}]), matchups: new Blob(['{}']),
            bytes: 100, totalGames: 5000, savedAt: Date.now(), source: 'scraped', last_updated_utc: new Date(Date.now() - 86400000 * 10).toISOString() });`;
        await h.ev(idb(`${entry('16.18')} ${entry('16.17')} return 1;`));
        // Builds data for the current patch (16.20) and 16.19, as the app saves it after an on-demand download
        await h.ev(saveBuilds(ds20, 3));
        await h.ev(saveBuilds(ds19, 3));
        await reload();
        const opts = await h.ev(`[...document.getElementById('time-period-select').options].map(o => ({ v: o.value, t: o.textContent, title: o.title }))`);
        const l3 = opts.find(o => o.v === 'last3'), l2 = opts.find(o => o.v === 'last2');
        R.ok('Time Period "Last 3 patches" is a range with the missing patch marked', l3 && l3.t === 'Last 3 patches (16.17–16.20) · 16.19 missing' && /Settings > Data/.test(l3.title), l3);
        R.ok('"Last 2 patches" too', l2 && l2.t === 'Last 2 patches (16.18–16.20) · 16.19 missing', l2);
        R.ok('no " + " lists in any option', !opts.some(o => / \+ /.test(o.t)), opts.map(o => o.t));
        // the header and the data chip use the same text
        await h.ev(`(() => { const s = document.getElementById('time-period-select'); s.value = 'last2'; s.dispatchEvent(new Event('change')); return 1; })()`);
        const hdr = await h.waitFor(`/16\\.18–16\\.20/.test(document.getElementById('patch-info').textContent)`, 25000);
        const info = await h.ev(`({ head: document.getElementById('patch-info').textContent, tip: document.getElementById('patch-info').title, chip: (document.querySelector('#rec-prov .dg-prov') || {}).textContent })`);
        R.ok('header: "Patches 16.18–16.20 · 16.19 missing" with a Settings > Data tooltip', hdr && info.head === 'Patches 16.18–16.20 · 16.19 missing' && /Settings > Data/.test(info.tip), info);
        R.ok('draft data chip: same range text', /Patches 16\.18–16\.20 · 16\.19 missing/.test(info.chip || ''), info.chip);
        await h.ev(`(() => { const s = document.getElementById('time-period-select'); s.value = '30'; s.dispatchEvent(new Event('change')); return 1; })()`);
        await h.sleep(800);

        // ---------- item 8: "Last 30 days" pools the patches released inside it ----------
        const days = await h.ev(`({ d30: DD.patchLabels.dayPatches('30'), d14: DD.patchLabels.dayPatches('d14'), d7: DD.patchLabels.dayPatches('d7'), none: DD.patchLabels.dayPatches('patch') })`);
        R.ok('30 days = current patch + the one released inside the window (2), 14 and 7 days = the current patch, other periods null',
            JSON.stringify(days.d30) === '["16.20","16.19"]' && JSON.stringify(days.d14) === '["16.20"]' && JSON.stringify(days.d7) === '["16.20"]' && days.none === null, days);
        const before = champCalls.length;
        await h.ev(`DD.openBuilds('Ahri', 'MIDDLE'); 1`);
        const shown = await h.waitFor(`!!document.querySelector('#builds-body .builds-table')`, 20000);
        const b = await h.ev(`({ note: document.querySelector('#builds-body .builds-note').textContent, chip: (document.querySelector('#builds-body .dg-prov') || {}).textContent,
            warn: !!document.querySelector('#builds-body .builds-warn'), all: document.getElementById('builds-body').textContent })`);
        R.ok('Builds on 30 days: both saved patches pooled, provenance "Patches 16.19–16.20 (pooled, last 30 days)"', shown && /Patches 16\.19–16\.20 \(pooled, last 30 days\)/.test(b.note) && /Patches 16\.19–16\.20 \(pooled, last 30 days\)/.test(b.chip || ''), { note: b.note.slice(0, 160), chip: b.chip });
        R.ok('no "no builds equivalent" warning, no missing-patch mark', !/no builds equivalent/.test(b.all) && !b.warn && !/missing/.test(b.note), b.note.slice(0, 200));
        R.ok('both patches\' games are in the pool and nothing was downloaded', new RegExp((2 * ahri.games).toLocaleString('en-US') + ' games').test(b.note) && champCalls.length === before, { note: b.note.slice(0, 200), calls: champCalls.length - before });

        // ---------- D3: between-patch variance ----------
        const pp = await h.ev(`(async () => {
            const M = DD.buildsMath, pick = ds => ds.champions['Ahri|MIDDLE'].items.legendaries.all.find(r => r.id === 3118);
            const d20 = ${JSON.stringify(ds20)}, d19 = ${JSON.stringify(ds19)};
            const pooled = pick(M.combineBuilds([d20, d19]));
            const same = pick(M.combineBuilds([d20, JSON.parse(JSON.stringify({ ...d20, patch: '16.19' }))]));
            const single = pick(d20), plain = { ...pooled }; delete plain._parts;
            const sameNoParts = { ...same }; delete sameNoParts._parts;
            const withV = M.bvPP(pooled, 'legendaries', pooled.buys), without = M.bvPP(plain, 'legendaries', plain.buys);
            const homV = M.bvPP(same, 'legendaries', same.buys), homPlain = M.bvPP(sameNoParts, 'legendaries', sameNoParts.buys);
            const one = M.bvPP(single, 'legendaries', single.buys);
            return { parts: pooled._parts, singleParts: single._parts === undefined, wpa: pooled.wpa, withV, without, homV, homPlain, one, tb: M.bvBetweenVar(pooled._parts, 0.66) };
        })()`);
        R.ok('a row that swings between patches keeps its pooled WPA but loses PP', pp.parts && pp.parts.length === 2 && Math.abs(pp.wpa - 0.002) < 1e-6 && pp.withV.pp < pp.without.pp - 0.1 && pp.withV.sd > pp.without.sd * 2 && pp.withV.between > 0, { with: pp.withV, without: pp.without });
        R.ok('a row that agrees across patches is unchanged (no extra variance)', pp.homV.between === 0 && Math.abs(pp.homV.pp - pp.homPlain.pp) < 1e-12 && Math.abs(pp.homV.sd - pp.homPlain.sd) < 1e-12, { homV: pp.homV, homPlain: pp.homPlain });
        R.ok('a single patch has no pooled data and its PP is the original formula', pp.singleParts && pp.one.between === 0 && pp.one.pp > 0 && pp.one.pp <= 1, pp.one);
        // formula check against a hand computation: two equal patches, v = 0.66 W(1-W)/n, tau_b2 = (Q - 1)/w, added variance tau_b2 / 2
        const row = pp.parts, W = [row[0][2], row[1][2]];
        const v = i => 0.66 * W[i] * (1 - W[i]) / row[i][0], w0 = 1 / v(0), w1 = 1 / v(1), m = (w0 * row[0][1] + w1 * row[1][1]) / (w0 + w1);
        const Q = w0 * (row[0][1] - m) ** 2 + w1 * (row[1][1] - m) ** 2, tb2 = Math.max(0, (Q - 1) / (w0 + w1 - (w0 * w0 + w1 * w1) / (w0 + w1)));
        const N = row[0][0] + row[1][0], expect = tb2 * (row[0][0] ** 2 + row[1][0] ** 2) / (N * N);
        R.ok('between-patch variance = DerSimonian-Laird tau² × Σn²/N²', Math.abs(pp.tb - expect) < 1e-12 && expect > 0, { got: pp.tb, expect });
        // the Builds tables on 30 days use it end to end: the pooled row's PP is the lower one
        const tab = await h.ev(`(async () => { const t = await DD.buildsTables('Ahri', 'MIDDLE'); const r = t.legendaries.find(x => x.id === 3118); return { patches: t.patches, pp: r && r.pp, adj: r && r.adj }; })()`);
        R.ok('the Builds tables (30 days) show the lowered PP for that item', JSON.stringify(tab.patches) === '["16.20","16.19"]' && Math.abs(tab.pp - pp.withV.pp) < 1e-9 && tab.pp < pp.without.pp - 0.1, { tab, with: pp.withV.pp, without: pp.without.pp });

        // ---------- item 9: matchup builds survive a restart ----------
        const matchupCalls = () => champCalls.filter(c => c.matchupKey);
        await h.ev(`DD.openBuilds('Ahri', 'MIDDLE', 'Zed'); 1`);
        const zed = await h.waitFor(`/Matchup: Ahri vs Zed/.test((document.querySelector('#builds-body .builds-vs-note') || {}).textContent || '')`, 20000);
        R.ok('matchup vs Zed downloaded once (latest patch of the period)', zed && matchupCalls().length === 1 && matchupCalls()[0].patch === '16.20' && matchupCalls()[0].matchupKey === 238, matchupCalls());
        await h.ev(`DD.openBuilds('Ahri', 'MIDDLE', 'Annie'); 1`);
        const annie = await h.waitFor(`/No Emerald\\+ games of Ahri vs Annie/.test((document.querySelector('#builds-body .builds-vs-note') || {}).textContent || '')`, 20000);
        R.ok('an empty answer (Annie) is shown', annie && matchupCalls().length === 2);
        const rows = await h.ev(idb(`const a = await all('matchups'); return a.map(r => ({ key: r.key, empty: r.empty, at: r.at, bytes: r.bytes })); `));
        R.ok('both are saved in the matchups store: key patch|champion|role|vs, empty marker with a time', rows.length === 2 && rows.some(r => r.key === '16.20|Ahri|MIDDLE|Zed' && !r.empty && r.bytes > 100) && rows.some(r => r.key === '16.20|Ahri|MIDDLE|Annie' && r.empty && r.at > 0), rows);
        const stored = await h.ev(idb(`const r = await get('matchups', '16.20|Ahri|MIDDLE|Zed'); const rec = await unzip(r.data); return { enc: r.enc, games: rec.games, keystones: rec.runes.keystones.length }; `));
        R.ok('the saved record is the gzip JSON of the Coachless answer', stored.enc === 'gzip' && stored.games === 4321 && stored.keystones > 3, stored);

        // on-demand champion (no vs): overview from coachless-champion into the patch record, rune detail afterwards
        champCalls.length = 0;
        await h.ev(`DD.openBuilds('Jinx', 'BOTTOM'); 1`);
        const jinx = await h.waitFor(`!!document.querySelector('#builds-body .builds-table') && /Jinx/i.test(document.getElementById('builds-champ-input').value)`, 30000);
        await h.sleep(500);
        R.ok('Jinx fetched on demand for each missing patch of the period (2 calls, no vs)', jinx && champCalls.length === 2 && champCalls.every(c => !c.matchupKey) && champCalls.map(c => c.patch).sort().join() === '16.19,16.20', champCalls.map(c => c.patch));
        const rec20 = await h.ev(idb(`const r = await get('builds', 'builds|16.20|emerald_plus'); const d = await unzip(r.data); return { has: !!d.champions['Jinx|BOTTOM'], games: d.champions['Jinx|BOTTOM'] && d.champions['Jinx|BOTTOM'].games, ks: d.champions['Jinx|BOTTOM'] && Object.keys(d.champions['Jinx|BOTTOM'].runes.byKeystone).length, fetched: !!(d.fetchedAt && d.fetchedAt['Jinx|BOTTOM']) }; `));
        R.ok('the record is written into the patch\'s builds record (overview: no rune detail yet)', rec20.has && rec20.ks === 0 && rec20.fetched, rec20);
        const loadBtn = await h.waitFor(`!!document.querySelector('#builds-body button[data-bdetail]')`, 10000);
        await h.ev(`document.querySelector('#builds-body button[data-bdetail]').click(); 1`);
        const detailShown = await h.waitFor(`!!document.querySelector('#builds-body .builds-rune-groups')`, 30000);
        R.ok('"Load rune details" fetched the detail for both patches and shows the sub-runes', loadBtn && detailShown && detailCalls.length === 2, { calls: detailCalls.length });
        const det = await h.ev(idb(`const a = await all('builds'); return a.filter(r => String(r.key).startsWith('bdetail|16.20|Jinx')).map(r => ({ key: r.key, ks: Object.keys(r.detail.runes.byKeystone) })); `));
        R.ok('keystone detail (runes.byKeystone) saved with the champion', det.length === 1 && det[0].ks.length >= 2, det);

        // a patch that cannot be downloaded is marked as missing in the Builds label (the other patch is still shown)
        await h.ev(`DD.openBuilds('Garen', 'TOP'); 1`);
        const garen = await h.waitFor(`/missing/.test((document.querySelector('#builds-body .builds-note') || {}).textContent || '')`, 30000);
        const gl = await h.ev(`({ note: document.querySelector('#builds-body .builds-note').textContent, tip: (document.querySelector('#builds-body .builds-note .builds-warn') || {}).title, chip: (document.querySelector('#builds-body .dg-prov') || {}).textContent, err: (document.querySelector('#builds-body .builds-warn') || {}).textContent })`);
        R.ok('a patch that failed to download is marked: "Patches 16.19–16.20 (pooled, last 30 days) · 16.19 missing" with a tooltip', garen && /^Patches 16\.19–16\.20 \(pooled, last 30 days\) · 16\.19 missing,/.test(gl.note) && /Settings > Data/.test(gl.tip || '') && /16\.19 missing/.test(gl.chip || ''), gl);

        const calls1 = { champ: champCalls.length, detail: detailCalls.length };
        await reload();
        // after the restart: Zed, Annie and Jinx come from the local store
        await h.ev(`DD.openBuilds('Ahri', 'MIDDLE', 'Zed'); 1`);
        const zed2 = await h.waitFor(`/Matchup: Ahri vs Zed/.test((document.querySelector('#builds-body .builds-vs-note') || {}).textContent || '')`, 20000);
        const note2 = await h.ev(`(document.querySelector('#builds-body .builds-vs-note') || {}).textContent`);
        R.ok('after a restart the saved Zed matchup is used (no second Coachless call), marked as saved', zed2 && champCalls.length === calls1.champ && /saved on this PC/.test(note2) && /4,321 games/.test(note2), { note: note2, calls: champCalls.length - calls1.champ });
        await h.ev(`DD.openBuilds('Ahri', 'MIDDLE', 'Annie'); 1`);
        const annie2 = await h.waitFor(`/No Emerald\\+ games of Ahri vs Annie/.test((document.querySelector('#builds-body .builds-vs-note') || {}).textContent || '')`, 20000);
        R.ok('the empty answer is still valid within 24 h (no call)', annie2 && champCalls.length === calls1.champ);
        await h.ev(`DD.openBuilds('Jinx', 'BOTTOM'); 1`);
        const jinx2 = await h.waitFor(`!!document.querySelector('#builds-body .builds-rune-groups')`, 20000);
        await h.sleep(500);
        R.ok('Jinx and her rune detail come from the local store (no champion or detail call)', jinx2 && champCalls.length === calls1.champ && detailCalls.length === calls1.detail, { champ: champCalls.length - calls1.champ, detail: detailCalls.length - calls1.detail });

        // Settings > Data
        await h.ev(`document.getElementById('settings-btn').click(); 1`);
        await h.waitFor(`/Matchup builds saved: 1 \\(/.test(document.getElementById('matchups-saved-text').textContent)`, 8000);
        const line = await h.ev(`document.getElementById('matchups-saved-text').textContent`);
        R.ok('Settings > Data: "Matchup builds saved: 1 (N KB)"', /^Matchup builds saved: 1 \(\d+(\.\d)? (KB|MB)\)$/.test(line), line);

        // the empty answer expires after 24 h: back-date it, restart, open it again -> one new call (Annie only)
        await h.ev(`document.getElementById('settings-close-btn').click(); 1`);
        await h.ev(idb(`const r = await get('matchups', '16.20|Ahri|MIDDLE|Annie'); r.at = Date.now() - 25 * 3600 * 1000; await put('matchups', r); return 1;`));
        await reload();
        await h.ev(`DD.openBuilds('Ahri', 'MIDDLE', 'Zed'); 1`);
        await h.waitFor(`/Matchup: Ahri vs Zed/.test((document.querySelector('#builds-body .builds-vs-note') || {}).textContent || '')`, 20000);
        R.ok('Zed (a record) is kept for good', champCalls.length === calls1.champ, champCalls.length - calls1.champ);
        await h.ev(`DD.openBuilds('Ahri', 'MIDDLE', 'Annie'); 1`);
        await h.waitFor(`/No Emerald\\+ games of Ahri vs Annie/.test((document.querySelector('#builds-body .builds-vs-note') || {}).textContent || '')`, 20000);
        const exp = champCalls.slice(calls1.champ);
        R.ok('the empty answer older than 24 h is asked for again', exp.length === 1 && exp[0].matchupKey === 1, exp);
        const row2 = await h.ev(idb(`const r = await get('matchups', '16.20|Ahri|MIDDLE|Annie'); return { empty: r.empty, fresh: Date.now() - r.at < 60000 };`));
        R.ok('and saved again with a new time', row2.empty && row2.fresh, row2);

        // Clear only on click
        await h.ev(`document.getElementById('settings-btn').click(); 1`);
        await h.waitFor(`/Matchup builds saved: 1 \\(/.test(document.getElementById('matchups-saved-text').textContent)`, 8000);
        R.ok('nothing was deleted by merely opening Settings', (await h.ev(idb(`return (await all('matchups')).length;`))) === 2);
        await h.ev(`document.getElementById('matchups-clear-btn').click(); 1`);
        await h.waitFor(`/Matchup builds saved: 0 \\(/.test(document.getElementById('matchups-saved-text').textContent)`, 8000);
        R.ok('Clear empties the matchups store and says so', (await h.ev(idb(`return (await all('matchups')).length;`))) === 0 && /Cleared/.test(await h.ev(`document.getElementById('matchups-saved-text').textContent`)));
        R.ok('the champion records (builds store) were not touched by Clear', (await h.ev(idb(`const r = await get('builds', 'builds|16.20|emerald_plus'); return !!r;`))) === true);

        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.slice(-6));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
