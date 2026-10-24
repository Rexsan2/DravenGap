// Premades view: a click on a pair row opens its details (DD.duoPairDetail: same edge as DD.duoPairs), Esc closes them; ticking
// friends builds a 2-5 stack planner (roles from your games together, changeable; your record with all of them from
// profile:group-history; best combos from DD.stackCombos = every champion's strength + every two's synergy; each player's best
// picks); a combo opens its details; a portrait still opens the champion page.
const H = require('../lib/renderer-harness');
const R = H.results();

const PUUID = 'P'.padEnd(78, 'x');
const none = { ok: true, scanned: 60, games: 0, w: 0, pairs: [], lanes: [], partnerChamps: {} };
const HIST = {
    Alpha: { ok: true, puuid: PUUID, scanned: 60, games: 20, w: 12, lanes: [{ myPos: 'MIDDLE', theirPos: 'JUNGLE', games: 20, w: 12 }],
        pairs: [{ mine: 103, theirs: 64, games: 6, w: 4, myPos: 'MIDDLE', theirPos: 'JUNGLE' }, { mine: 4, theirs: 64, games: 3, w: 1, myPos: 'MIDDLE', theirPos: 'JUNGLE' }],
        partnerChamps: { JUNGLE: { 64: 12, 254: 5, 76: 3 } } },
    Bravo: { ok: true, puuid: PUUID, scanned: 60, games: 14, w: 7, lanes: [{ myPos: 'MIDDLE', theirPos: 'BOTTOM', games: 14, w: 7 }],
        pairs: [{ mine: 103, theirs: 222, games: 5, w: 3, myPos: 'MIDDLE', theirPos: 'BOTTOM' }], partnerChamps: { BOTTOM: { 222: 8, 51: 4, 21: 2 } } },
    Charlie: { ok: true, puuid: PUUID, scanned: 60, games: 9, w: 6, lanes: [{ myPos: 'MIDDLE', theirPos: 'UTILITY', games: 9, w: 6 }],
        pairs: [{ mine: 103, theirs: 412, games: 4, w: 3, myPos: 'MIDDLE', theirPos: 'UTILITY' }], partnerChamps: { UTILITY: { 412: 6, 89: 3 } } }
};

(async () => {
    try {
        const groupCalls = [];
        const h = await H.boot({ ipc: {
            'profile:owner': () => ({ ok: true, owner: { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1', puuid: PUUID }, source: 'client' }),
            'profile:played': () => ({ ok: true, scanned: 60, list: [{ name: 'Alpha', tag: 'EUW', games: 20, w: 12, l: 8 }, { name: 'Bravo', tag: 'EUW', games: 14, w: 7, l: 7 }, { name: 'Charlie', tag: 'EUW', games: 9, w: 6, l: 3 }] }),
            'profile:duo-history': (e, a) => HIST[a.partner.gameName] || none,
            'profile:group-history': (e, a) => { groupCalls.push(a); return { ok: true, scanned: 60, games: 3, w: 2, lineups: [{ pos: ['MIDDLE', 'JUNGLE', 'BOTTOM'], games: 3, w: 2 }],
                combos: [{ champs: [103, 64, 222], pos: ['MIDDLE', 'JUNGLE', 'BOTTOM'], games: 3, w: 2 }] }; }
        } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        await h.sleep(1000);
        await h.ev(`DD.showView('premades'); 1`);
        const ready = await h.waitFor(`document.querySelectorAll('#premades-root .pm-click[data-pair]').length > 3`, 20000);
        R.ok('Premades lists pairs for the first friend', ready, await h.ev(`document.getElementById('premades-root').textContent.replace(/\\s+/g, ' ').slice(0, 300)`));

        // ---- pair details: click the row's name (not the picture)
        const pairKey = await h.ev(`(() => { const r = [...document.querySelectorAll('#premades-root .pm-main [data-pair]')].find(x => /Untried/.test(x.closest('.pm-card').textContent)); r.querySelector('span').click(); return r.dataset.pair; })()`);
        const shown = await h.waitFor(`(() => { const d = document.getElementById('pm-detail'); return !d.hidden && /pair edge/.test(d.textContent) && /Best third/.test(d.textContent); })()`, 15000);
        const det = await h.ev(`(() => { const d = document.getElementById('pm-detail'); return { text: d.textContent.replace(/\\s+/g, ' '), rows: d.querySelectorAll('.pm-tab tr').length }; })()`);
        R.ok('clicking a pair opens its details panel', shown && det.rows === 3 && /Synergy each way/.test(det.text) && /Lane matchups/.test(det.text) && /You/.test(det.text), det.text.slice(0, 400));
        const [a, ra, b, rb] = pairKey.split('|');
        const cmp = await h.ev(`(async () => { const d = await DD.duoPairDetail({ a: '${a}', roleA: '${ra}', b: '${b}', roleB: '${rb}' }); const l = await DD.duoPairs({ roleA: '${ra}', roleB: '${rb}', poolA: ['${a}'], poolB: ['${b}'], blank: true });
            const p = l.pairs[0]; return { edge: d.edge, listEdge: p && p.edge, syn: d.syn.mean, listSyn: p && p.syn, expA: d.a.exp, listExpA: p && p.expA, thirds: d.thirds.length, worst: d.a.worst.length }; })()`);
        R.ok('the panel\'s edge, synergy and Exp WR equal the pair list\'s', Math.abs(cmp.edge - cmp.listEdge) < 1e-12 && Math.abs(cmp.syn - cmp.listSyn) < 1e-12 && Math.abs(cmp.expA - cmp.listExpA) < 1e-12 && cmp.thirds > 0 && cmp.worst > 0, cmp);
        await h.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
        R.ok('Esc closes the panel', await h.ev(`document.getElementById('pm-detail').hidden`));
        // your played pair opens too, with your record
        await h.ev(`(() => { const r = [...document.querySelectorAll('#premades-root .pm-main [data-pair]')].find(x => /Your pairs/.test(x.closest('.pm-card').textContent)); r.querySelector('span').click(); return 1; })()`);
        await h.waitFor(`/pair edge/.test(document.getElementById('pm-detail').textContent)`, 15000);
        R.ok('a pair you played shows your record with it', /With Alpha\s*4-2 on this pair/.test(await h.ev(`document.getElementById('pm-detail').textContent.replace(/\\s+/g, ' ')`)), await h.ev(`document.getElementById('pm-detail').textContent.replace(/\\s+/g, ' ').slice(0, 500)`));
        await h.ev(`document.querySelector('#pm-detail [data-close]').click(); 1`);

        // ---- 3-stack: tick Alpha and Bravo
        const tick = name => h.ev(`(() => { const c = document.querySelector('#premades-root [data-stack="${name.toLowerCase()}#euw"]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
        await tick('Alpha'); await tick('Bravo');
        const planned = await h.waitFor(`document.querySelectorAll('#premades-root [data-combo]').length > 3 && /All 3 of you together/.test(document.getElementById('premades-root').textContent)`, 20000);
        const st = await h.ev(`(() => { const r = document.getElementById('premades-root'); return { text: r.querySelector('.pm-stack').textContent.replace(/\\s+/g, ' '), roles: [...r.querySelectorAll('.pm-rsel')].map(s => s.value), combos: r.querySelectorAll('[data-combo]').length, picks: r.querySelectorAll('.pm-bp').length }; })()`);
        R.ok('3-stack planner: roles from your games together, your record with all of them', planned && /3-stack planner/.test(st.text) && st.roles.join() === 'MIDDLE,JUNGLE,BOTTOM' && /All 3 of you together: 2-1/.test(st.text) && st.picks >= 3, st);
        R.ok('group history asked for both friends', groupCalls.length >= 1 && groupCalls[groupCalls.length - 1].partners.map(p => p.gameName).join() === 'Alpha,Bravo', groupCalls.slice(-1));
        const sc = await h.ev(`(async () => { const r = await DD.stackCombos({ slots: [{ role: 'MIDDLE', pool: null }, { role: 'JUNGLE', pool: null }, { role: 'BOTTOM', pool: null }], limit: 20 });
            const ok = r.combos.every((c, i) => Math.abs(c.edge - (c.exp.reduce((t, x) => t + x - 0.5, 0) + c.pairs.reduce((t, p) => t + p.syn, 0))) < 1e-12 && (i === 0 || c.edge <= r.combos[i - 1].edge) && new Set(c.champs).size === 3 && c.pairs.length === 3);
            const two = await DD.stackCombos({ slots: [{ role: 'MIDDLE', pool: ['Ahri'] }, { role: 'JUNGLE', pool: ['LeeSin'] }], limit: 1 });
            const d = await DD.duoPairDetail({ a: 'Ahri', roleA: 'MIDDLE', b: 'LeeSin', roleB: 'JUNGLE' });
            return { ok, n: r.combos.length, count: r.count, twoEdge: two.combos[0] && two.combos[0].edge, pairEdge: d.edge, bad: await DD.stackCombos({ slots: [{ role: 'MIDDLE' }, { role: 'MIDDLE' }] }) }; })()`);
        R.ok('combo value = every Exp WR over 50% + every two\'s synergy, best first; a 2-stack equals the pair edge', sc.ok && sc.n === 20 && Math.abs(sc.twoEdge - sc.pairEdge) < 1e-12 && sc.bad === null, sc);
        // a combo you played shows your record
        const rec = await h.ev(`(() => { const r = [...document.querySelectorAll('#premades-root [data-played]')]; return r.length ? r[0].textContent.replace(/\\s+/g, ' ') : ''; })()`);
        R.ok('the combo you played with all of them is listed with its record', /Ahri \+ Lee Sin \+ Jinx\s*2-1/.test(rec), rec);

        // ---- combo details
        await h.ev(`document.querySelector('#premades-root [data-combo="0"] span').click(); 1`);
        await h.waitFor(`/combo value/.test(document.getElementById('pm-detail').textContent)`, 5000);
        const cd = await h.ev(`(() => { const d = document.getElementById('pm-detail'); return { rows: d.querySelectorAll('.pm-tab tr').length, pairs: d.querySelectorAll('[data-pair]').length, text: d.textContent.replace(/\\s+/g, ' ') }; })()`);
        R.ok('a combo opens its details: each player, and every two of them', cd.rows === 4 && cd.pairs === 3 && /TestOwner/.test(cd.text) && /Alpha/.test(cd.text) && /Bravo/.test(cd.text), cd);
        await h.ev(`document.querySelector('#pm-detail [data-pair] span').click(); 1`);
        R.ok('a pair inside the combo opens the pair details', await h.waitFor(`/pair edge/.test(document.getElementById('pm-detail').textContent)`, 15000));
        await h.ev(`document.querySelector('#pm-detail [data-close]').click(); 1`);

        // ---- change a role: Bravo to Jungle, Alpha takes Bot
        await h.ev(`(() => { const s = document.querySelector('#premades-root [data-role-for="bravo#euw"]'); s.value = 'JUNGLE'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
        await h.sleep(300);
        R.ok('setting a role swaps it with whoever had it', (await h.ev(`[...document.querySelectorAll('#premades-root .pm-rsel')].map(s => s.value).join()`)) === 'MIDDLE,BOTTOM,JUNGLE');
        await h.waitFor(`document.querySelectorAll('#premades-root [data-combo]').length > 0`, 15000);
        // ---- 4-stack, pool "Anyone"
        await tick('Charlie');
        const four = await h.waitFor(`/4-stack planner/.test(document.getElementById('premades-root').textContent) && document.querySelectorAll('#premades-root [data-combo]').length > 0 && document.querySelector('#premades-root [data-combo] ').querySelectorAll('img').length === 4`, 20000);
        R.ok('4-stack: combos of four champions', four, await h.ev(`document.querySelector('#premades-root .pm-stack').textContent.replace(/\\s+/g, ' ').slice(0, 400)`));
        const before = await h.ev(`DDPremades.state.plan.res.slots[0].candidates.map(c => c.id).join()`);
        await h.ev(`(() => { const r = document.querySelector('#premades-root input[name="pm-pool"][value="any"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
        await h.waitFor(`DDPremades.state.plan && !DDPremades.state.plan.loading && DDPremades.state.poolMode === 'any' && DDPremades.state.plan.res`, 15000);
        const after = await h.ev(`DDPremades.state.plan.res.slots[0].candidates.map(c => c.id).join()`);
        R.ok('"Anyone" uses everyone played in the role instead of the champions you played', before !== after && after.split(',').length >= before.split(',').length, { before, after });

        // ---- a portrait opens the champion page instead of the details
        await h.ev(`document.querySelector('#premades-root [data-combo] img').click(); 1`);
        R.ok('a portrait in a combo row opens the champion page', await h.waitFor(`DD.currentView() === 'champion'`, 5000) && await h.ev(`document.getElementById('pm-detail').hidden`));

        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.filter(l => /Uncaught|TypeError|ReferenceError/.test(l)).slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
