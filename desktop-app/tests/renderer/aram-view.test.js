// ARAM Mayhem view (stubbed arammayhem + client): your champion is shown before the bench opens, with the "Bench opens soon" advice
// (keep, or reroll when below the tier list middle and rerolls are left); with a bench the older advice returns; and Settings >
// Diagnostics > "Copy champion select snapshot" reports what aram:champ-snapshot answers.
const H = require('../lib/renderer-harness');
const R = H.results();

const tier = { patch: '26.19', dataDate: '2026-10-03', avgWr: 50.4, champions: [
    { slug: 'teemo', name: 'Teemo', wr: 53.4, tier: 'S+', rank: 1, tags: ['Marksman'], image: '', search: 'teemo' },
    { slug: 'ahri', name: 'Ahri', wr: 51.7, tier: 'A', rank: 2, tags: ['Mage'], image: '', search: 'ahri' },
    { slug: 'yuumi', name: 'Yuumi', wr: 50.5, tier: 'B', rank: 3, tags: ['Support'], image: '', search: 'yuumi' },
    { slug: 'lux', name: 'Lux', wr: 49.0, tier: 'C', rank: 4, tags: ['Mage'], image: '', search: 'lux' },
    { slug: 'zed', name: 'Zed', wr: 47.5, tier: 'D', rank: 5, tags: ['Assassin'], image: '', search: 'zed' }] };           // middle = Yuumi 50.5
const aug = (name, wr, app) => ({ slug: name.toLowerCase(), name, wr, appearance: app, icon: '' });
const page = slug => ({ meta: { name: slug, wr: 50, pick: 3, tier: 'A', rank: 9, patch: '26.19', dataDate: '2026-10-03' }, balance: [],
    augments: { prismatic: [aug('Archmage', 55.1, 12)], gold: [aug('Blade Waltz', 53.2, 8)], silver: [] } });
const KEY = { teemo: 17, ahri: 103, yuumi: 350, lux: 99, zed: 238 };

(async () => {
    try {
        let cs = { connected: true, phase: 'ChampSelect', inChampSelect: true, isMayhem: true, isAram: true, queueId: 2400, queueName: 'ARAM: Mayhem', mine: 17, mineSource: 'current-champion', bench: [], team: [], rerolls: 2, benchEnabled: true };
        let snap = { ok: true, text: '{}', copied: true, lines: 3 };
        const snapCalls = [];
        const h = await H.boot({ settings: { timePeriod: 'patch', rank: 'platinum_plus', gameMode: 'aram-mayhem' }, ipc: {
            'aram:tier-list': () => ({ ok: true, data: tier, fetchedAt: Date.now() }),
            'aram:champion': (e, a) => ({ ok: true, data: page(a.slug), fetchedAt: Date.now() }),
            'aram:items': (e, a) => ({ ok: true, data: { wr: 50.2, games: 50000, tierLabel: 'All ranks', core: { items: [6655, 3020, 4645], wr: 52.1, games: 3000 } }, fetchedAt: Date.now() }),
            'aram:champ-select': () => ({ ok: true, data: cs, fetchedAt: Date.now() }),
            'aram:champ-snapshot': () => { snapCalls.push(1); return snap; }
        } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        const advice = () => h.ev(`(() => { const a = document.querySelector('#aram-root .aram-advice'); return a ? { text: a.textContent.replace(/\\s+/g, ' ').trim(), cls: a.className } : null; })()`);
        const waitAdvice = async re => { const t0 = Date.now(); let a = null; while (Date.now() - t0 < 12000) { a = await advice(); if (a && re.test(a.text)) return a; await h.sleep(250); } return a; };

        // champion known, bench still empty
        let a = await waitAdvice(/Bench opens soon/);
        await h.waitFor(`/Archmage/.test(document.getElementById('aram-right').textContent)`, 8000);
        const view = await h.ev(`({ rows: [...document.querySelectorAll('#aram-root .aram-list .aram-row')].map(r => r.dataset.slug + ':' + [...r.querySelectorAll('.aram-src')].map(s => s.textContent).join('+')),
            head: (document.querySelector('#aram-root .aram-bhead h2') || {}).textContent, right: document.getElementById('aram-right').textContent.replace(/\\s+/g, ' ') })`);
        R.ok('no bench yet: your champion is listed as current and its build is open (tier, augments, items)', JSON.stringify(view.rows) === '["teemo:current"]' && view.head === 'Teemo' && /S\+/.test(view.right) && /Archmage/.test(view.right) && /Core build/.test(view.right), view);
        R.ok('advice: Bench opens soon, keep a champion above the tier list middle', a && /Bench opens soon: keep Teemo/.test(a.text) && /ok/.test(a.cls) && /tier list middle 50\.50%/.test(a.text) && /rerolls left: 2/.test(a.text), a);

        // below the middle with rerolls -> reroll; without -> no rerolls left; with a bench -> the bench comparison
        cs = { ...cs, mine: KEY.zed, mineSource: 'pick-intent' };
        a = await waitAdvice(/reroll is worth it/);
        R.ok('below the tier list middle with rerolls left: a reroll is worth it', a && /Bench opens soon: a reroll is worth it, 80% of champions have a higher win rate than Zed/.test(a.text) && /go/.test(a.cls) && /rerolls left: 2/.test(a.text), a);
        R.ok('your champion changed, so its build follows', await h.waitFor(`document.querySelector('#aram-root .aram-bhead h2') && document.querySelector('#aram-root .aram-bhead h2').textContent === 'Zed'`, 8000));
        cs = { ...cs, rerolls: 0 };
        a = await waitAdvice(/no rerolls are left/);
        R.ok('below the middle with no rerolls left: says so, no reroll advice', a && /Zed is below the middle of the tier list, but no rerolls are left/.test(a.text) && /warn/.test(a.cls), a);
        cs = { ...cs, rerolls: 2, bench: [KEY.teemo] };
        a = await waitAdvice(/Swap to/);
        R.ok('with a bench the usual comparison is back (no "Bench opens soon")', a && /Swap to Teemo from the bench/.test(a.text) && !/Bench opens soon/.test(a.text), a);

        // champion not reported yet
        cs = { ...cs, mine: 0, mineSource: null, bench: [], team: [] };
        a = await waitAdvice(/Waiting for your champion/);
        R.ok('champion select but no champion reported yet: says it is waiting (the full tier list stays below)', a && /The client has not reported it yet/.test(a.text) && (await h.ev(`document.querySelectorAll('#aram-root .aram-list .aram-row').length`)) === 5, a);

        // diagnostics button
        await h.ev(`document.getElementById('settings-btn').click(); document.getElementById('diag-open-btn').click(); 1`);
        R.ok('diagnostics lists the snapshot button', await h.waitFor(`!!document.querySelector('#diag-panel [data-diag="champ-snapshot"]')`, 8000));
        const msg = () => h.ev(`(async () => { const b = document.querySelector('#diag-panel [data-diag="champ-snapshot"]'); b.click();
            for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 100)); const m = document.querySelector('#diag-panel .diag-msg'); if (m && /Copied|No snapshot|could not/.test(m.textContent)) return m.textContent; } return 'timeout'; })()`);
        const ok1 = await msg();
        R.ok('Copy champion select snapshot: reports the copy (done in the main process)', /Copied the champion select snapshot \(3 lines/.test(ok1) && snapCalls.length === 1, ok1);
        snap = { ok: false, error: 'Not in champion select (Lobby): open this during champion select.' };
        const bad = await msg();
        R.ok('outside champion select the reason is shown', /No snapshot: Not in champion select \(Lobby\)/.test(bad), bad);
        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
