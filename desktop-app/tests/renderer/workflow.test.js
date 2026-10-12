// Workflow wave 1 in the real window: game flow bar through champion select (lock-in -> game plan -> send everything),
// back / forward, the champion menu, the tier list (+ patch movers view) and multi-search.
const H = require('../lib/renderer-harness');
const { fixture } = require('../lib/common');
const R = H.results();

const ds = JSON.parse(fixture('data/coachless_builds_16.18.json'));
const session = { localPlayerCellId: 0, theirTeam: [{ cellId: 5, championId: 238, championPickIntent: 0 }],
    actions: [[{ actorCellId: 0, type: 'pick', completed: true, championId: 103 }]],
    myTeam: [{ cellId: 0, championId: 103, championPickIntent: 0, assignedPosition: 'middle' }, { cellId: 1, championId: 157, championPickIntent: 0, assignedPosition: 'top' }] };

(async () => {
    try {
        const sent = [];
        const multi = (e, a) => (a.gameName === 'Nobody' ? { ok: false, code: 'NOT_FOUND', error: 'not found' } : { ok: true,
            profile: { gameName: a.gameName, tagLine: a.tagLine, platform: a.platform, summonerLevel: 120, ranked: [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', leaguePoints: 50, wins: 60, losses: 40 }], mastery: [{ championId: 103, championPoints: 120000 }] },
            form: { results: [{ win: true, champId: 103, k: 5, d: 1, a: 9 }, { win: true, champId: 103, k: 3, d: 2, a: 4 }, { win: true, champId: 1, k: 1, d: 1, a: 1 }] },
            tags: [{ id: 'hot', label: 'Hot streak', cls: 'good', tip: '3 wins' }] });
        const h = await H.boot({ ipc: {
            'get-champ-select': () => session,
            'profile:me': () => ({ ok: true, me: { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' }, lcu: true, phase: 'ChampSelect' }),
            'profile:session': () => ({ ok: true, lcu: true, games: [{ q: 420, champId: 103, win: true, k: 5, d: 2, a: 7, at: Date.now() - 3600e3, dur: 1800 }], w: 1, l: 0, lp: { RANKED_SOLO_5x5: 21 } }),
            'profile:champ-summary': () => ({ ok: true, games: 10, w: 6, vsOpp: { 238: { g: 3, w: 2 } }, items: {}, totalCached: 50 }),
            'profile:duo': () => ({ ok: true, lcu: true, partners: [{ gameName: 'Alpha', tagLine: 'EUW', positions: [] }], me: { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1', positions: [] } }),
            'profile:multi': multi,
            'lcu:apply-runes': (e, a) => { sent.push(['runes', a]); return { ok: true, name: 'DravenGap Ahri', action: 'created' }; },
            'lcu:apply-spells': (e, a) => { sent.push(['spells', a]); return { ok: true, spell1Id: a.spell1Id, spell2Id: a.spell2Id }; },
            'lcu:apply-itemset': (e, a) => { sent.push(['items', a]); return { ok: true, title: a.title, blocks: a.blocks.length }; }
        } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        // Coachless data for Ahri Mid saved as the current patch (no download needed to send)
        await h.ev(`(async () => { const data = ${JSON.stringify({ ...ds, patch: '16.19' })}; data.scrapedAt = new Date().toISOString();
            const blob = await new Response(new Blob([JSON.stringify(data)]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
            const db = await new Promise((res, rej) => { const r = indexedDB.open('draftdiff-datasets'); r.onsuccess = () => res(r.result); r.onerror = rej; });
            await new Promise((res, rej) => { const tx = db.transaction('builds', 'readwrite'); tx.objectStore('builds').put({ key: 'builds|16.19|emerald_plus', patch: '16.19', rank: 'emerald_plus', enc: 'gzip', data: blob, bytes: blob.size, scrapedAt: data.scrapedAt, champions: 3, complete: true }); tx.oncomplete = res; tx.onerror = rej; }); return 1; })()`);
        await h.sleep(2500);
        const bar = await h.ev(`document.getElementById('flow-bar').textContent.replace(/\\s+/g, ' ')`);
        R.ok('flow bar: champion select step, your lane, locked pick and opponent, session', /Champion select/.test(bar) && /Mid/.test(bar) && /Ahri/.test(bar) && /vs .*Zed/.test(bar) && /Today 1W 0L/.test(bar) && /\+21 LP/.test(bar)
            && (await h.ev(`document.querySelector('.fb-step.now').dataset.fbStep`)) === 'select', bar);
        R.ok('after lock-in: game plan, build, send and champion page actions', await h.ev(`['plan','build','send','hub'].every(k => document.querySelector('[data-fb-act="' + k + '"]')) && !document.querySelector('[data-fb-act="suggest"]')`));
        // game plan
        await h.ev(`document.querySelector('[data-fb-act="plan"]').click(); 1`);
        await h.waitFor(`/Exp WR/.test(document.querySelector('.fb-plan').textContent) && /vs Zed: 2-1/.test(document.querySelector('.fb-plan').textContent)`, 10000);
        const plan = await h.ev(`document.querySelector('.fb-plan').textContent.replace(/\\s+/g, ' ')`);
        const gp = await h.ev(`DD.gamePlan('Ahri', 'MIDDLE')`);
        R.ok('game plan: Exp WR, lane vs Zed, your record vs Zed', /Lane vs Zed/.test(plan) && gp.opponent === 'Zed' && gp.expWr > 0.3 && /vs Zed: 2-1/.test(plan), plan.slice(0, 300));
        // send everything
        await h.ev(`document.querySelector('[data-fb-act="send"]').click(); 1`);
        await h.waitFor(`/Item set/.test(document.querySelector('.fb-msg') ? document.querySelector('.fb-msg').textContent : '')`, 15000);
        const msg = await h.ev(`document.querySelector('.fb-msg').textContent`);
        const kinds = sent.map(s => s[0]);
        R.ok('send to client: runes, spells and item set in one click', kinds.includes('runes') && kinds.includes('spells') && kinds.includes('items') && sent.find(s => s[0] === 'runes')[1].page.selectedPerkIds.length === 9 && /Rune page/.test(msg), { kinds, msg });
        // views + back / forward
        await h.ev(`DD.openChampion('Ahri', 'MIDDLE'); 1`); await h.sleep(800);
        await h.ev(`DD.openBuilds('Ahri', 'MIDDLE', 'Zed'); 1`); await h.sleep(800);
        await h.ev(`DD.showView('tierlist'); 1`); await h.sleep(800);
        await h.ev(`DD.history.back(); 1`); await h.sleep(900);
        const b1 = await h.ev(`[DD.currentView(), JSON.stringify(DD.buildsContext())]`);
        await h.ev(`DD.history.back(); 1`); await h.sleep(900);
        const b2 = await h.ev(`[DD.currentView(), DDHub.state.champ]`);
        await h.ev(`DD.history.forward(); 1`); await h.sleep(900);
        R.ok('back / forward restore the view and its context', b1[0] === 'builds' && /"vs":"Zed"/.test(b1[1]) && b2[0] === 'champion' && b2[1] === 'Ahri' && (await h.ev(`DD.currentView()`)) === 'builds', { b1, b2 });
        // champion menu on a draft slot
        await h.ev(`DD.showView('draft'); 1`); await h.sleep(300);
        const menu = await h.ev(`(() => { const s = document.querySelector('.role-slot[data-side="left"][data-role="MIDDLE"]'); s.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
            const m = document.querySelector('.dg-menu'); return { shown: m.style.display, items: [...m.querySelectorAll('.dg-menu-i')].map(x => x.textContent) }; })()`);
        R.ok('right-click a draft slot: page, builds, builds vs the lane opponent, ARAM', menu.shown === 'block' && menu.items.includes('Champion page') && menu.items.includes('Builds vs Zed') && menu.items.includes('ARAM Mayhem build'), menu);
        await h.ev(`[...document.querySelectorAll('.dg-menu-i')].find(x => x.textContent === 'Builds vs Zed').click(); 1`); await h.sleep(500);
        R.ok('menu opens Builds vs the opponent', JSON.stringify(await h.ev(`[DD.currentView(), DD.buildsContext().champion, DD.buildsContext().vs]`)) === '["builds","Ahri","Zed"]');
        // tier list
        await h.ev(`DD.showView('tierlist'); 1`);
        await h.waitFor(`document.querySelectorAll('#tierlist-root .tl-row').length > 20`, 10000);
        const tl = await h.ev(`(() => { const rows = [...document.querySelectorAll('#tierlist-root .tl-row')]; const d = rows.map(r => parseFloat(r.children[5 + (rows[0].children.length > 8 ? 0 : -1)].textContent));
            return { n: rows.length, tiers: [...new Set(rows.map(r => r.querySelector('.tl-tier').textContent))], sorted: d.every((v, i) => i === 0 || v <= d[i - 1] + 1e-9), period: getComputedStyle(document.getElementById('time-period-select')).display !== 'none' }; })()`);
        R.ok('tier list: tiers best first, Time Period visible', tl.n > 20 && tl.tiers.length >= 3 && tl.sorted && tl.period, tl);
        await h.ev(`document.querySelector('#tierlist-root .tl-role[data-role="MIDDLE"]').click(); 1`);
        R.ok('role filter', await h.ev(`[...document.querySelectorAll('#tierlist-root .tl-row')].every(r => r.dataset.hubRole === 'MIDDLE')`));
        await h.ev(`document.querySelector('#tierlist-root .tl-tab[data-tab="movers"]').click(); 1`);
        R.ok('patch movers explain when no previous patch is saved', /previous patch/.test(await h.ev(`document.getElementById('tl-body').textContent`)));
        // multi-search
        await h.ev(`DDScout.setText('Alpha#EUW joined the lobby\\nBravo #EUW joined the lobby\\nNobody#EUW\\nalpha#euw'); DD.showView('scout'); DDScout.search(); 1`);
        await h.waitFor(`document.querySelectorAll('#scout-root .ms-card:not(.loading)').length === 3`, 10000);
        const ms = await h.ev(`[...document.querySelectorAll('#scout-root .ms-card')].map(c => c.textContent.replace(/\\s+/g, ' '))`);
        R.ok('multi-search: parses chat lines, dedupes, shows rank, form and tags; errors per player', ms.length === 3 && /Gold II 50 LP/.test(ms[0]) && /60%/.test(ms[0]) && /Hot streak/.test(ms[0]) && /Bravo/.test(ms[1]) && /Not found/.test(ms[2]), ms);
        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.filter(l => /Error/.test(l)).slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
