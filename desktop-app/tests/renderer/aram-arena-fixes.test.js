// Fixes from the 2026-11 review in the ARAM Mayhem and Arena views (real window, stubbed IPC, no network):
//  - D1-F12 the Full tier list has the "+" its text mentions (adds a champion by hand)
//  - D1-F9  failed LoLalytics items have a Retry, and re-selecting the champion asks again
//  - D1-F10 a failed Data Dragon item.json is tried again with the next build (item names appear without a restart)
//  - D1-F7 / D1-F8 a new champion select drops hand-added champions and opens on "Recommended picks" / "Champion select"
//  - D1-F4  the reroll verdict does not flip when the bench opens; D1-F6 unknown rerolls with a bench are not "no rerolls left"
//  - D1-F15 one failed poll does not undo the champion the user clicked
//  - D1-F3  a failed refresh says "could not refresh" (top bar and the chip's Refresh now), not "refreshing" / "fetched again"
//  - D1-F14 Arena: champion picks are not labelled games; the build line shows LoLalytics' pick rate
const H = require('../lib/renderer-harness');
const { APP, fixture } = require('../lib/common');
const P = require(APP + 'arena-parsers');
const R = H.results();

// average reroll 48.10 (rule: below 47.60); tier list middle 49.55. Lux 49.50 sits between the two.
const tier = { patch: '26.19', dataDate: '2026-10-03', avgWr: 48.1, champions: [
    { slug: 'teemo', name: 'Teemo', wr: 60, tier: 'S+', rank: 1, tags: ['Marksman'], image: '', search: 'teemo' },
    { slug: 'ahri', name: 'Ahri', wr: 50, tier: 'A', rank: 2, tags: ['Mage'], image: '', search: 'ahri' },
    { slug: 'yuumi', name: 'Yuumi', wr: 49.6, tier: 'B', rank: 3, tags: ['Support'], image: '', search: 'yuumi' },
    { slug: 'lux', name: 'Lux', wr: 49.5, tier: 'B', rank: 4, tags: ['Mage'], image: '', search: 'lux' },
    { slug: 'zed', name: 'Zed', wr: 40, tier: 'D', rank: 5, tags: ['Assassin'], image: '', search: 'zed' },
    { slug: 'yasuo', name: 'Yasuo', wr: 39.5, tier: 'D', rank: 6, tags: ['Fighter'], image: '', search: 'yasuo' }] };
const KEY = { teemo: 17, ahri: 103, yuumi: 350, lux: 99, zed: 238, yasuo: 157 };
const page = slug => ({ meta: { name: slug, wr: 50, pick: 3, tier: 'A', rank: 9, patch: '26.19', dataDate: '2026-10-03' }, balance: [], augments: { prismatic: [], gold: [], silver: [] } });
const arenaTier = P.parseTierList(fixture('arena/tier_all.html'));
const ahri = P.parseChampionPage(fixture('arena/ahri_emerald.html'));

(async () => {
    try {
        let aramCs = { connected: false, inChampSelect: false };
        let arenaCs = { connected: true, phase: 'Lobby', inChampSelect: false };
        let tierAnswer = () => ({ ok: true, data: tier, fetchedAt: Date.now(), stale: false });
        let arenaTierAnswer = () => ({ ok: true, data: { ...arenaTier, url: 'https://lolalytics.com/lol/tierlist/arena/?tier=all' }, fetchedAt: Date.now() - 7 * 3600e3, stale: true, error: 'Network error: down' });
        const itemsFail = { ahri: 1, teemo: 1 };   // the LoLalytics items of these fail once
        let coreWr = 52.1;
        const h = await H.boot({ settings: { timePeriod: 'patch', rank: 'platinum_plus', gameMode: 'aram-mayhem' }, ipc: {
            'aram:tier-list': () => tierAnswer(),
            'aram:champion': (e, a) => ({ ok: true, data: page(a.slug), fetchedAt: Date.now() }),
            'aram:items': (e, a) => {
                if (itemsFail[a.slug] > 0) { itemsFail[a.slug]--; return { ok: false, code: 'NETWORK', error: 'Network error: timeout' }; }
                return { ok: true, data: { wr: 50.2, games: 50000, tierLabel: 'All ranks', core: { items: [6655, 3020, 4645], wr: coreWr, games: 3000 } }, fetchedAt: Date.now() };
            },
            'aram:champ-select': () => ({ ok: true, data: aramCs, fetchedAt: Date.now() }),
            'arena:tier-list': () => arenaTierAnswer(),
            'arena:champion': (e, a) => (a.slug === 'ahri' ? { ok: true, data: ahri, fetchedAt: Date.now(), stale: false } : { ok: false, code: 'NOT_FOUND', error: 'Page not found (404)' }),
            'arena:augments': () => ({ ok: false, error: 'not in this test' }),
            'arena:champ-select': () => ({ ok: true, data: arenaCs, fetchedAt: Date.now() })
        } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        const head = () => h.ev(`(document.querySelector('#aram-root .aram-bhead h2') || {}).textContent || ''`);
        const right = `document.getElementById('aram-right').textContent`;
        const click = sel => h.ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.click(); return !!el; })()`);
        const advice = () => h.ev(`(() => { const a = document.querySelector('#aram-root .aram-advice'); return a ? { text: a.textContent.replace(/\\s+/g, ' ').trim(), cls: a.className } : null; })()`);
        const waitAdvice = async re => { const t0 = Date.now(); let a = null; while (Date.now() - t0 < 10000) { a = await advice(); if (a && re.test(a.text)) return a; await h.sleep(200); } return a; };

        // ---- D1-F12: no client, Full tier list with a "+" per row
        R.ok('no client: the Full tier list has a + on every row', await h.waitFor(`document.querySelectorAll('#aram-root .aram-list .aram-row [data-add]').length === 6`, 15000),
            await h.ev(`document.querySelectorAll('#aram-root .aram-list .aram-row').length`));
        await click('#aram-root .aram-row[data-slug="lux"] [data-add]');
        const a1 = await h.ev(`({ tab: (document.querySelector('#aram-root .aram-tab.on') || {}).dataset, x: !!document.querySelector('#aram-root .aram-row[data-slug="lux"] [data-rm]'), count: document.querySelector('#aram-root [data-aview="avail"]').textContent })`);
        R.ok('+ adds Lux by hand and stays on the Full tier list (Lux now has the remove button, Recommended picks (1))', a1.tab && a1.tab.aview === 'all' && a1.x && /\(1\)/.test(a1.count), a1);
        await click('#aram-root [data-aview="avail"]');
        R.ok('Recommended picks lists Lux as added by hand', await h.waitFor(`[...document.querySelectorAll('#aram-root .aram-list .aram-row')].map(r => r.dataset.slug + ':' + r.querySelector('.aram-src').textContent).join() === 'lux:manual'`, 3000));

        // ---- D1-F9 / D1-F10: items fail once (Retry), Data Dragon item.json fails until later
        await h.ev(`(() => { window.__ddItemOk = false; const real = window.fetch;
            window.fetch = (u, o) => { const s = String((u && u.url) || u);
                if (window.__ddItemOk && s.includes('/cdn/') && s.endsWith('/data/en_US/item.json')) return Promise.resolve(new Response(JSON.stringify({ data: { 6655: { name: "Luden's Companion" }, 3020: { name: "Sorcerer's Shoes" }, 4645: { name: 'Shadowflame' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                return real(u, o); }; return 1; })()`);
        await click('#aram-root [data-aview="all"]');
        await click('#aram-root .aram-row[data-slug="ahri"]');
        R.ok('LoLalytics items failed: the message has a Retry button', await h.waitFor(`!!document.querySelector('#aram-right [data-act="retry-items"]') && /LoLalytics build not available/.test(${right})`, 8000), await h.ev(right));
        await click('#aram-right [data-act="retry-items"]');
        R.ok('Retry asks for the items again: Core build', await h.waitFor(`/Core build/.test(${right})`, 8000), await h.ev(right));
        const asked = (ch, slug) => h.calls.filter(c => c[0] === ch && c[1][0] && c[1][0].slug === slug).length;
        R.ok('... only the items (the augments page is not asked again)', asked('aram:items', 'ahri') === 2 && asked('aram:champion', 'ahri') === 1, { items: asked('aram:items', 'ahri'), champ: asked('aram:champion', 'ahri') });
        const titles = () => h.ev(`[...document.querySelectorAll('#aram-right .aram-isec .aram-item')].map(i => i.title).join('|')`);
        const t1 = await titles();
        R.ok('item.json failed: the items show by id', /6655/.test(t1) && !/Luden/.test(t1), t1);
        await click('#aram-root .aram-row[data-slug="teemo"]');
        R.ok('Teemo: items failed', await h.waitFor(`/LoLalytics build not available/.test(${right}) && document.querySelector('#aram-root .aram-bhead h2').textContent === 'Teemo'`, 8000));
        await click('#aram-root .aram-row[data-slug="ahri"]');
        await h.waitFor(`document.querySelector('#aram-root .aram-bhead h2').textContent === 'Ahri'`, 3000);
        await click('#aram-root .aram-row[data-slug="teemo"]');
        R.ok('re-selecting a champion whose items failed asks for them again', await h.waitFor(`/Core build/.test(${right}) && document.querySelector('#aram-root .aram-bhead h2').textContent === 'Teemo'`, 8000), await h.ev(right));
        await h.ev(`window.__ddItemOk = true; 1`);
        await click('#aram-root .aram-row[data-slug="yuumi"]');
        await h.waitFor(`/Core build/.test(${right}) && document.querySelector('#aram-root .aram-bhead h2').textContent === 'Yuumi'`, 8000);
        const t2 = await titles();
        R.ok('item.json loads with a later build: item names appear without a restart', /Luden's Companion/.test(t2) && /Shadowflame/.test(t2), t2);

        // ---- D1-F7 / D1-F8 / D1-F4: a new champion select (the Full tier list tab is still chosen, Lux was added by hand)
        const csLux = { connected: true, phase: 'ChampSelect', inChampSelect: true, isMayhem: true, isAram: true, queueId: 2400, queueName: 'ARAM: Mayhem', mine: KEY.lux, mineSource: 'championId', bench: [], team: [], rerolls: 2, benchEnabled: true };
        aramCs = csLux;
        const rowsTxt = `[...document.querySelectorAll('#aram-root .aram-list .aram-row')].map(r => r.dataset.slug + ':' + [...r.querySelectorAll('.aram-src')].map(s => s.textContent).join('+')).join()`;
        R.ok('new champion select: opens on Recommended picks, the hand-added Lux is dropped (Lux is listed as current only)',
            await h.waitFor(`(() => { const on = document.querySelector('#aram-root .aram-tab.on'); return on && on.dataset.aview === 'avail' && ${rowsTxt} === 'lux:current'; })()`, 8000),
            await h.ev(`({ on: (document.querySelector('#aram-root .aram-tab.on') || {}).textContent, rows: ${rowsTxt} })`));
        const before = await waitAdvice(/Bench opens soon/);
        aramCs = { ...csLux, bench: [KEY.yasuo] };
        const after = await waitAdvice(/^(?!Bench opens soon)/);
        R.ok('Lux (between the tier list middle and an average reroll): "keep" before and after the bench opens',
            before && /Bench opens soon: keep Lux/.test(before.text) && /ok/.test(before.cls) && after && /Keep Lux/.test(after.text) && /ok/.test(after.cls), { before, after });

        // ---- D1-F15: click a bench champion; one failed poll; the same champion select again -> the selection stays
        await click('#aram-root .aram-row[data-slug="yasuo"]');
        await h.waitFor(`document.querySelector('#aram-root .aram-bhead h2').textContent === 'Yasuo'`, 5000);
        const saved = aramCs;
        aramCs = { connected: false, inChampSelect: false };
        await h.waitFor(`/League client not detected/.test(document.getElementById('aram-top').textContent)`, 5000);
        aramCs = saved;
        await h.waitFor(`/ARAM: Mayhem champion select/.test(document.getElementById('aram-top').textContent)`, 5000);
        await h.sleep(2600);
        R.ok('one failed poll does not undo the champion the user clicked', (await head()) === 'Yasuo', await head());

        // ---- D1-F6: below an average reroll, a bench with nothing better, rerolls unknown
        aramCs = { ...saved, mine: KEY.zed, bench: [KEY.yasuo], rerolls: null };
        const unk = await waitAdvice(/Zed|unknown|no rerolls/);
        R.ok('rerolls unknown with a bench: says unknown, not "no rerolls left"', unk && /unknown/.test(unk.text) && !/no rerolls left/.test(unk.text), unk);

        // ---- D1-F3: a refresh that fails with a saved copy
        tierAnswer = () => ({ ok: true, data: tier, fetchedAt: Date.now() - 7 * 3600e3, stale: true, error: 'Network error: down' });
        await click('#aram-top [data-act="reload"]');
        const staleTxt = `((document.querySelector('#aram-top .aram-stale') || {}).textContent || '')`;
        R.ok('failed refresh: the top bar says "could not refresh" with the error, not "refreshing"', await h.waitFor(`/could not refresh: Network error: down/.test(${staleTxt}) && !/refreshing/.test(${staleTxt})`, 5000), await h.ev(staleTxt));
        const msg = await h.ev(`(async () => { document.querySelector('#aram-top .dg-prov').click(); await new Promise(r => setTimeout(r, 150));
            document.querySelector('.dg-pop [data-prov-refresh]').click();
            for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 100)); const m = document.querySelector('.dg-pop-msg').textContent; if (m && !/Refreshing/.test(m)) return m; }
            return document.querySelector('.dg-pop-msg').textContent; })()`);
        R.ok('the chip\'s "Refresh now" reports the failure, not "fetched again"', /Could not refresh: Network error: down/.test(msg) && !/fetched again/i.test(msg), msg);
        await h.ev(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); 1`);
        tierAnswer = () => ({ ok: true, data: tier, fetchedAt: Date.now() - 7 * 3600e3, stale: true });
        await click('#aram-top [data-act="reload"]');
        R.ok('a stale copy being refreshed in the background: "refreshing"', await h.waitFor(`${staleTxt} === 'refreshing'`, 5000), await h.ev(staleTxt));
        h.send('aram:updated', { kind: 'tier-list', key: 'tier-list', error: 'HTTP 503' });
        R.ok('that background refresh fails (pushed by main): "refreshing" becomes "could not refresh"', await h.waitFor(`/could not refresh: HTTP 503/.test(${staleTxt})`, 3000), await h.ev(staleTxt));

        // ---- Arena: D1-F3, D1-F14, D1-F8
        await h.ev(`DD.showView('arena'); 1`);
        R.ok('Arena tier list', await h.waitFor(`document.querySelectorAll('#arena-root .arena-list .arena-row').length === 173`, 10000));
        const top = await h.ev(`({ chip: (document.querySelector('#arena-top .dg-prov') || {}).textContent, stale: (document.querySelector('#arena-top .arena-stale') || {}).textContent })`);
        R.ok('Arena: the tier chip does not call champion picks "games"', top.chip && !/games/.test(top.chip), top);
        R.ok('Arena: a saved copy whose refresh failed says so, not "refreshing"', /could not refresh: Network error: down/.test(top.stale || ''), top);
        await click('#arena-root [data-aview="tier"]');
        arenaCs = { connected: true, phase: 'ChampSelect', inChampSelect: true, queueId: 1750, queueName: 'Arena', isArena: true, mine: 103, mineLocked: true, mates: [], teamKnown: true, taken: [], banned: [], pickable: null };
        R.ok('Arena: Tier list chosen in the lobby, then a champion select opens on the champion select panel', await h.waitFor(`!!document.querySelector('#arena-root .arena-team')`, 6000));
        R.ok('Arena build line: LoLalytics pick rate, not "% of games"', await h.waitFor(`(() => { const s = document.querySelector('#arena-root .arena-statline'); return !!s && /pick rate \\d/.test(s.textContent) && !/of games/.test(s.textContent); })()`, 8000),
            await h.ev(`(document.querySelector('#arena-root .arena-statline') || {}).textContent`));

        // ---- D1-F19: the champion page's ARAM tab when the LoLalytics core build has no win rate
        coreWr = null;
        await h.ev(`DD.showView('draft'); 1`);
        await h.ev(`(() => { const t = document.querySelector('.champion-tile[data-champion-name="Ahri"]'); t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 })); return 1; })()`);
        await click('#context-menu [data-hub="Ahri"]');
        await h.waitFor(`DD.currentView() === 'champion' && !!document.querySelector('#champion-root [data-tab="aram"]')`, 15000);
        const ar = await h.ev(`(async () => { document.querySelector('#champion-root [data-tab="aram"]').click(); for (let i = 0; i < 50; i++) { await new Promise(r => setTimeout(r, 100)); const t = document.querySelector('#champion-root .ch-body').textContent; if (!/Loading/.test(t)) return t; } return 'timeout'; })()`);
        R.ok('champion page ARAM tab: a core build without a win rate still shows its items', /core build · – WR/.test(ar) && (await h.ev(`document.querySelectorAll('#champion-root .ch-items .ch-item').length`)) === 3, ar.slice(0, 400));

        const errs = h.logs.filter(l => /Uncaught|TypeError|ReferenceError|IPC channel not allowed/.test(l));
        R.ok('no uncaught errors', errs.length === 0, errs);
    } catch (e) { R.ok('test ran', false, String(e && e.stack || e)); }
    R.finish();
})();
