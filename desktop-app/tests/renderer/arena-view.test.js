// Arena view in the real window: sidebar item and Ctrl+K open it, the tier list (173 champions from the saved LoLalytics page), a
// champion's build (six places, the top three marked as the top half, augments, items, partners), the champion-select tab with a
// partner, "Follow my game" in an Arena champion select (queue 1750), the flow bar's single Arena action, glossary and How to Use.
const H = require('../lib/renderer-harness');
const { APP, fixture } = require('../lib/common');
const P = require(APP + 'arena-parsers');
const R = H.results();

const tier = P.parseTierList(fixture('arena/tier_all.html'));
const ahri = P.parseChampionPage(fixture('arena/ahri_emerald.html'));
const augs = P.parseAugmentMeta(fixture('arena/cdragon_augments.json'));
let cs = { connected: true, phase: 'Lobby', inChampSelect: false };

(async () => {
    try {
        const champCalls = [];
        const h = await H.boot({ size: [1400, 900], ipc: {
            'arena:tier-list': () => ({ ok: true, data: { ...tier, url: 'https://lolalytics.com/lol/tierlist/arena/?tier=all' }, fetchedAt: Date.now(), stale: false }),
            'arena:champion': (e, a) => { champCalls.push(a.slug); return a.slug === 'ahri' ? { ok: true, data: ahri, fetchedAt: Date.now(), stale: false } : { ok: false, code: 'NOT_FOUND', error: 'Page not found (404)' }; },
            'arena:augments': () => ({ ok: true, data: augs, fetchedAt: Date.now(), stale: false }),
            'arena:champ-select': () => ({ ok: true, data: cs, fetchedAt: Date.now(), stale: false }),
            'profile:me': () => ({ ok: true, me: { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' }, lcu: true, phase: 'Lobby' })
        } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        const page = f => h.ev(`(${f})()`);

        R.ok('the sidebar has an Arena item', await h.ev(`!!document.querySelector('#sidebar .sb-item[data-view="arena"]')`));
        await h.ev(`document.querySelector('#sidebar .sb-item[data-view="arena"]').click(); 1`);
        R.ok('it opens the Arena view', await h.waitFor(`DD.currentView() === 'arena' && document.getElementById('arena-root').style.display !== 'none'`, 5000));
        R.ok('tier list: every champion', await h.waitFor(`document.querySelectorAll('#arena-root .arena-list .arena-row').length === 173`, 10000),
            await h.ev(`document.querySelectorAll('#arena-root .arena-row').length`));
        const first = await page(() => { const r = document.querySelector('#arena-root .arena-row'); return { name: r.querySelector('.arena-name').firstChild.textContent, tier: r.querySelector('.arena-tier').textContent, wr: r.querySelector('.arena-wr').textContent }; });
        R.ok('first row: Renata Glasc, S+, 56.7%', first.name === 'Renata Glasc' && first.tier === 'S+' && first.wr === '56.7%', first);
        R.ok('the CSS is loaded (rows are a grid)', await h.ev(`getComputedStyle(document.querySelector('#arena-root .arena-row')).display === 'grid'`));
        R.ok('the saved game mode is Arena', await h.waitFor(`true`) && (h.settings().gameMode === 'arena'), h.settings().gameMode);

        // search + a champion's build
        await h.ev(`(() => { const i = document.getElementById('arena-search'); i.value = 'ahr'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
        R.ok('search narrows the list', await h.waitFor(`document.querySelectorAll('#arena-root .arena-list .arena-row').length === 1`, 3000));
        await h.ev(`document.querySelector('#arena-root .arena-row[data-cid="103"]').click(); 1`);
        R.ok('Ahri\'s build: six places, the first three marked as the top half', await h.waitFor(`document.querySelectorAll('#arena-root .arena-place').length === 6`, 5000)
            && (await h.ev(`[...document.querySelectorAll('#arena-root .arena-place')].map(p => p.classList.contains('win') ? 1 : 0).join('')`)) === '111000');
        const b = await page(() => ({ line: document.querySelector('#arena-root .arena-statline').textContent, augs: document.querySelectorAll('#arena-root .arena-arow:not(.part)').length,
            parts: document.querySelectorAll('#arena-root .arena-arow.part').length, chip: !!document.querySelector('#arena-root .dg-prov-row') }));
        R.ok('stat line says 1st to 3rd of 6; augments (14 shown) and start items listed, partners, a data chip', /1st to 3rd of 6/.test(b.line) && b.augs === 14 + ahri.items.start.length && b.parts > 0 && b.chip, b);
        await h.ev(`document.querySelector('#arena-root [data-rarity="prismatic"]').click(); 1`);
        R.ok('rarity tab: prismatic only', await h.ev(`[...document.querySelectorAll('#arena-root .arena-rar')].slice(0, 14).every(i => i.classList.contains('r-prismatic'))`));
        R.ok('the glossary has the Arena entry used by the "?" chips', await h.ev(`!!(DD.glossary && DD.glossary.arena && /Top-half rate/.test(DD.glossary.arena.html))`));

        // champion select (Arena, queue 1750): Follow my game switches here, the left panel shows you and your partner
        await h.ev(`DD.showView('draft'); 1`);
        cs = { connected: true, phase: 'ChampSelect', inChampSelect: true, queueId: 1750, queueName: 'Arena', isArena: true, mine: 103, mineLocked: true, mates: [{ cellId: 1, championId: 17 }], teamKnown: true, taken: [888], banned: [], pickable: null };
        h.send('profile:phase', { prev: 'Lobby', next: 'ChampSelect', queueId: 1750 });
        R.ok('Follow my game: an Arena champion select opens the Arena view', await h.waitFor(`DD.currentView() === 'arena'`, 5000));
        R.ok('the flow bar offers one action: Arena (no draft actions)', await h.waitFor(`(() => { const a = [...document.querySelectorAll('#flow-bar .fb-act:not(.fb-more)')].map(b => b.dataset.fbAct); return a.length === 1 && a[0] === 'arena'; })()`, 5000),
            await h.ev(`[...document.querySelectorAll('#flow-bar .fb-act')].map(b => b.dataset.fbAct)`));
        R.ok('champion select tab: you and your partner', await h.waitFor(`document.querySelectorAll('#arena-root .arena-person').length === 2 && /Teemo/.test(document.querySelector('#arena-root .arena-team').textContent)`, 5000));
        const sug = await page(() => [...document.querySelectorAll('#arena-root .arena-row.cs')].map(r => Number(r.dataset.cid)));
        R.ok('suggestions leave out taken champions and you', sug.length === 12 && !sug.includes(888) && !sug.includes(103), sug);
        R.ok('your partner\'s page is fetched once for the pair numbers', champCalls.filter(s => s === 'teemo').length === 1, champCalls);

        // a Summoner's Rift champion select goes back to the draft and the usual actions
        cs = { connected: true, phase: 'Lobby', inChampSelect: false };
        h.send('profile:phase', { prev: 'ChampSelect', next: 'Lobby', queueId: null });
        h.send('profile:phase', { prev: 'Lobby', next: 'ChampSelect', queueId: 420 });
        R.ok('a ranked champion select opens the draft again', await h.waitFor(`DD.currentView() === 'draft'`, 5000));
        R.ok('and the flow bar has its draft actions back', await h.waitFor(`!document.querySelector('#flow-bar [data-fb-act="arena"]') && !!document.querySelector('#flow-bar [data-fb-act="bans"]')`, 5000));

        // Ctrl+K
        await h.ev(`DD.openPalette && DD.openPalette(); 1`);
        await h.sleep(200);
        const pal = await page(() => { const i = document.querySelector('.dg-pal input, #dg-palette input, .palette input'); if (!i) return null; i.value = 'arena'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; });
        await h.sleep(200);
        R.ok('Ctrl+K lists Arena', pal && await h.ev(`[...document.querySelectorAll('.dg-pal-item, .dg-pal li, [data-pal]')].some(e => /^\\s*Arena/.test(e.textContent))`), pal);
        R.ok('How to Use has an Arena section', await h.ev(`[...document.querySelectorAll('details > summary')].some(s => s.textContent.trim() === 'Arena')`));

        // right-click menu on a champion in the draft grid offers the Arena build
        await h.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); DD.showView('draft'); 1`);
        await h.ev(`(() => { const t = document.querySelector('.champion-tile[data-champion-name="Ahri"]'); const r = t.getBoundingClientRect(); t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5 })); return 1; })()`);
        await h.sleep(200);
        const hasArena = await h.ev(`!!document.querySelector('#context-menu [data-arena="Ahri"]')`);
        R.ok('right-click menu: Arena build', hasArena);
        if (hasArena) {
            await h.ev(`document.querySelector('#context-menu [data-arena="Ahri"]').click(); 1`);
            R.ok('which opens Ahri in the Arena view', await h.waitFor(`DD.currentView() === 'arena' && DDArena.selectedKey() === 103`, 5000));
        }
        const errs = h.logs.filter(l => /Uncaught|TypeError|ReferenceError|IPC channel not allowed/.test(l));
        R.ok('no uncaught errors', errs.length === 0, errs);
    } catch (e) { R.ok('test ran', false, String(e && e.stack || e)); }
    R.finish();
})();
