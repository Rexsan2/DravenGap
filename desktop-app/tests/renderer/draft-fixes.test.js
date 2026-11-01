// Draft fixes (code review 2026-11-01, fixer IDXA), in the real window:
//  manual board: Reset Draft forgets the old slot's list (A1-F2), names not Data Dragon ids + search "wukong" (A1-F5),
//  "Best for you" / For you only on your side (A1-F13), a pick hidden by My pool can still be shown (A1-F12), the grid's ▼ keeps
//  the slot selected (A1-F6), a champion is placed only once (A1-F14), your own slot shows the swap selection (A1-F8),
//  "Back to pinned" re-marks the taken champions (A1-F11), the Bans tab follows a Rank change (A1-F4 / A1-F9);
//  Live Tracking: Reset Draft repaints on the next poll (V1-M2), a new game clears the role locks (A1-F3), an in-turn selection
//  is a hover (A1-F7), a swapped hover keeps its lane (A1-F10), a banned champion can't be placed (A1-F14), an older slow poll
//  never paints over a newer one (A1-F17).
const H = require('../lib/renderer-harness');
const R = H.results();

// your games: Ahri x4, Syndra x3, Garen x5 -> My pool = Ahri, Syndra, Garen (+ LeBlanc by mastery)
const games = [...Array(4).fill(103), ...Array(3).fill(134), ...Array(5).fill(86)].map((c, i) => ({ championId: c, queueId: 420, win: i % 2 === 0, gameId: 7000 + i, role: null }));
const personal = { summoner: { name: 'TestOwner' }, games, mastery: { 7: { level: 7, points: 60000 } } };
const P = (cellId, championId, assignedPosition, championPickIntent = 0) => ({ cellId, championId, championPickIntent, assignedPosition: assignedPosition || '' });
const empty = c => P(c, 0, '');
let sess = null, slowPickable = false;

(async () => {
    try {
        const h = await H.boot({ size: [1400, 900], ipc: {
            'get-champ-select': () => sess,
            'get-pickable-champions': async () => { if (slowPickable) { slowPickable = false; await new Promise(r => setTimeout(r, 2500)); } return null; },
            'get-personal-stats': () => personal } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        await h.waitFor(`Array.isArray(DD.myPool()) && DD.myPool().length >= 3`, 10000);
        await h.sleep(500);
        const $ = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
        const slotSel = (side, role) => `[data-side='${side}'][data-role='${role}']`;
        const place = (side, role, champ) => h.ev(`(async () => { ${$(slotSel(side, role))}.click(); await new Promise(r => setTimeout(r, 50));
            document.querySelector('.champion-tile[data-champion-name="${champ}"]').click(); await new Promise(r => setTimeout(r, 300)); return 1; })()`);
        const suggest = (side, role) => h.ev(`${$(slotSel(side, role) + ' .suggest-btn')}.click(); 1`);
        const search = q => h.ev(`(() => { const s = document.getElementById('recommendation-search'); s.value = ${JSON.stringify(q)}; s.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
        const rows = () => h.ev(`[...document.querySelectorAll('#recommendation-list li[data-champion-name]')].map(li => li.dataset.championName)`);
        const listText = () => h.ev(`document.getElementById('recommendation-list').textContent`);
        const cardShown = () => h.ev(`(() => { const c = document.getElementById('rec-card'); return !!c && c.style.display !== 'none' && c.innerHTML.trim() !== ''; })()`);
        const board = side => h.ev(`['TOP','JUNGLE','MIDDLE','BOTTOM','SUPPORT'].map(r => { const s = document.querySelector("[data-side='${side}'][data-role='" + r + "']"); return r + ':' + (s.dataset.champion || (s.dataset.hover ? '~' + s.dataset.hover : '-')); }).join(' ')`);
        const locks = () => h.ev(`[...document.querySelectorAll('.lock-btn.locked')].map(b => b.closest('.role-slot').dataset.side[0] + b.closest('.role-slot').dataset.role)`);
        const many = `document.querySelectorAll('#recommendation-list li[data-champion-name]').length > 5`;

        // ---------- A1-F5: display names and a search that knows them ----------
        await suggest('left', 'JUNGLE');
        await h.waitFor(many, 15000);
        await search('wukong');
        await h.waitFor(`document.querySelectorAll('#recommendation-list li[data-champion-name]').length === 1`, 5000);
        const wk = await h.ev(`(() => { const li = document.querySelector('#recommendation-list li[data-champion-name]'); return { id: li.dataset.championName, name: li.querySelector('.rec-name').textContent.trim() }; })()`);
        R.ok('search "wukong" finds MonkeyKing; the row says "Wukong" and keeps the Data Dragon id', wk.id === 'MonkeyKing' && wk.name === 'Wukong', wk);
        await search('lee sin');
        await h.waitFor(`document.querySelectorAll('#recommendation-list li[data-champion-name]').length >= 1`, 5000);
        const ls = await rows();
        R.ok('search "lee sin" (space, any case) finds LeeSin', ls.length === 1 && ls[0] === 'LeeSin', ls);
        await search('');
        await h.waitFor(many, 5000);
        const ids = await h.ev(`[...document.querySelectorAll('#recommendation-list .rec-name')].map(e => e.textContent.trim())`);
        R.ok('no row shows a Data Dragon id with no space (LeeSin, MonkeyKing)', !ids.some(t => /^(LeeSin|MonkeyKing|XinZhao|JarvanIV)$/.test(t)), ids.filter(t => /[a-z][A-Z]/.test(t)));

        // ---------- A1-F13: "Best for you" and For you only for your own side ----------
        await suggest('left', 'MIDDLE');
        await h.waitFor(many, 15000);
        const leftCard = await h.waitFor(`(() => { const c = document.getElementById('rec-card'); return c && c.style.display !== 'none' && /Best for you/.test(c.textContent); })()`, 8000);
        const leftYou = await h.ev(`[...document.querySelectorAll('#recommendation-list .you-cell')].filter(c => c.textContent.trim()).length`);
        await suggest('right', 'MIDDLE');
        await h.waitFor(`${many} && ${$(slotSel('right', 'MIDDLE'))}.classList.contains('selected')`, 15000);
        await h.sleep(300);
        const rightCard = await cardShown(), rightYou = await h.ev(`[...document.querySelectorAll('#recommendation-list .you-cell')].filter(c => c.textContent.trim()).length`);
        R.ok('your slot: "Best for you" and the For you column are shown', leftCard && leftYou > 0, { leftCard, leftYou });
        R.ok('an enemy slot: no "Best for you" card and an empty For you column', !rightCard && rightYou === 0, { rightCard, rightYou });

        // ---------- A1-F12: a pick hidden by My pool is still shown when asked for (the card's "outside your pool" pick) ----------
        await suggest('left', 'MIDDLE');
        await h.waitFor(many, 15000);
        await h.ev(`(() => { const t = document.getElementById('my-pool-toggle'); t.checked = true; t.dispatchEvent(new Event('change')); return 1; })()`);
        await h.waitFor(`!document.querySelector('#recommendation-list li[data-champion-name="Yasuo"]')`, 5000);
        const pooled = await rows();
        await h.ev(`DD.showPickInDraft('Yasuo'); 1`);
        const yas = await h.waitFor(`(() => { const li = document.querySelector('#recommendation-list li[data-champion-name="Yasuo"]'); return !!(li && li.querySelector('.why-panel')); })()`, 5000);
        R.ok('My pool on: Yasuo (outside the pool) is hidden, then shown with its why panel when the card asks for it', !pooled.includes('Yasuo') && pooled.every(c => ['Ahri', 'Syndra', 'Garen', 'Leblanc'].includes(c)) && yas, { pooled, yas });
        await h.ev(`(() => { const t = document.getElementById('my-pool-toggle'); t.checked = false; t.dispatchEvent(new Event('change')); return 1; })()`);

        // ---------- A1-F2 / A1-F16: Reset Draft forgets the old slot's list ----------
        await h.ev(`document.getElementById('reset-btn').click(); 1`);
        await h.sleep(300);
        await search('a');
        await h.sleep(300);
        const afterReset = { rows: (await rows()).length, text: await listText(), card: await cardShown() };
        await h.ev(`(() => { const t = document.getElementById('favorites-only-toggle'); t.checked = !t.checked; t.dispatchEvent(new Event('change')); t.checked = !t.checked; t.dispatchEvent(new Event('change')); return 1; })()`);
        await h.sleep(300);
        afterReset.rowsAfterFilter = (await rows()).length;
        R.ok('after Reset Draft a search or filter brings back no list: the SUGGEST hint stays, no "Best for you" card', afterReset.rows === 0 && afterReset.rowsAfterFilter === 0 && /Press SUGGEST under a slot/.test(afterReset.text) && !afterReset.card, afterReset);
        await search('');

        // ---------- A1-F6: the grid's ▼ toggle keeps the slot you just clicked ----------
        await h.ev(`(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); ${$(slotSel('left', 'TOP'))}.click(); await w(50);
            const b = document.getElementById('toggle-champion-grid-btn'); b.click(); await w(50); b.click(); await w(50);
            document.getElementById('champion-grid').click(); await w(50);
            document.querySelector('.champion-tile[data-champion-name="Garen"]').click(); await w(300); return 1; })()`);
        R.ok('slot, ▼ (twice), a gap in the grid, then a champion: the champion fills the slot', (await h.ev(`${$(slotSel('left', 'TOP'))}.dataset.champion || null`)) === 'Garen', await board('left'));

        // ---------- A1-F14: one champion, one slot ----------
        await place('left', 'MIDDLE', 'Ahri');
        await h.ev(`(async () => { document.querySelector('.champion-tile[data-champion-name="Ahri"]').click(); await new Promise(r => setTimeout(r, 50));
            ${$(slotSel('right', 'MIDDLE'))}.click(); await new Promise(r => setTimeout(r, 300)); return 1; })()`);
        const ahris = await h.ev(`[...document.querySelectorAll('.role-slot[data-champion="Ahri"]')].map(s => s.dataset.side + s.dataset.role)`);
        R.ok('placing Ahri again (grid, then the enemy Mid slot) moves her: exactly one Ahri on the board', ahris.length === 1 && ahris[0] === 'rightMIDDLE', ahris);
        await place('left', 'MIDDLE', 'Ahri');   // back to the left for the next steps
        R.ok('and back: Ahri only in left Mid', JSON.stringify(await h.ev(`[...document.querySelectorAll('.role-slot[data-champion="Ahri"]')].map(s => s.dataset.side + s.dataset.role)`)) === '["leftMIDDLE"]');

        // ---------- A1-F8: your own (yellow) slot shows that it is selected for a swap ----------
        const meLook = await h.ev(`(async () => { const s = ${$(slotSel('left', 'SUPPORT'))}; s.classList.add('is-me'); const before = getComputedStyle(s).boxShadow;
            s.click(); await new Promise(r => setTimeout(r, 50)); const sel = s.classList.contains('swap-source'), after = getComputedStyle(s).boxShadow;
            s.click(); await new Promise(r => setTimeout(r, 50)); s.classList.remove('is-me'); return { before, after, sel }; })()`);
        R.ok('clicking your own slot (yellow "you" outline) changes how it looks', meLook.sel && meLook.before !== meLook.after && meLook.after !== 'none', meLook);

        // ---------- A1-F11: "Back to pinned" re-marks what is taken ----------
        await place('right', 'TOP', 'Darius'); await place('right', 'JUNGLE', 'LeeSin');
        await h.ev(`DD.setDraftTab('analysis'); 1`);
        await h.waitFor(`!!document.querySelector('#analysis-view [data-pin="set"]')`, 8000);
        await h.ev(`document.querySelector('#analysis-view [data-pin="set"]').click(); 1`);
        await h.waitFor(`!!DD.whatIf.pinned()`, 5000);
        await place('left', 'MIDDLE', 'Syndra');
        await h.ev(`DD.setDraftTab('analysis'); 1`);
        await h.waitFor(`!!document.querySelector('#analysis-view [data-pin="restore"]')`, 8000);
        await h.ev(`document.querySelector('#analysis-view [data-pin="restore"]').click(); 1`);
        await h.waitFor(`${$(slotSel('left', 'MIDDLE'))}.dataset.champion === 'Ahri'`, 5000);
        await h.ev(`DD.setDraftTab('recommendations'); 1`);
        await suggest('right', 'MIDDLE');
        await h.waitFor(`!!document.querySelector('#recommendation-list li[data-champion-name="Syndra"]')`, 15000);
        const syn = await h.ev(`document.querySelector('#recommendation-list li[data-champion-name="Syndra"]').classList.contains('unavailable')`);
        R.ok('after "Back to pinned" Syndra (no longer on the board) is not greyed out', syn === false, { syndraUnavailable: syn });
        await h.ev(`document.querySelector('#analysis-view [data-pin="clear"]') && document.querySelector('#analysis-view [data-pin="clear"]').click(); 1`);

        // ---------- A1-F4 / A1-F9: the Bans tab follows a Rank change ----------
        await h.ev(`DD.setDraftTab('bans'); 1`);
        await h.waitFor(`!!document.querySelector('#bans-view .bans-table') && /Platinum\\+/.test((document.querySelector('#bans-view .dg-prov') || {}).textContent || '')`, 15000);
        await h.ev(`(() => { const s = document.getElementById('rank-select'); s.value = 'gold'; s.dispatchEvent(new Event('change')); return 1; })()`);
        const goldChip = await h.waitFor(`/^Gold ·/.test(((document.querySelector('#bans-view .dg-prov') || {}).textContent || '').trim())`, 15000);
        R.ok('Bans tab: changing Rank redraws it (its data chip says Gold)', goldChip, await h.ev(`(document.querySelector('#bans-view .dg-prov') || {}).textContent`));
        await h.ev(`(() => { const s = document.getElementById('rank-select'); s.value = 'platinum_plus'; s.dispatchEvent(new Event('change')); return 1; })()`);
        await h.sleep(800);
        await h.ev(`DD.setDraftTab('analysis'); 1`);
        await h.ev(`document.getElementById('reset-btn').click(); 1`);

        // ================= Live Tracking =================
        // ---------- V1-M2: Reset Draft during champion select: the next poll paints the board and Draft Analysis again ----------
        sess = { gameId: 100, localPlayerCellId: 0, actions: [[]], theirTeam: [P(5, 238, '')], myTeam: [P(0, 38, 'middle'), P(1, 86, 'top'), empty(2), empty(3), empty(4)] };
        await h.waitFor(`${$(slotSel('left', 'MIDDLE'))}.dataset.champion === 'Kassadin' && ${$(slotSel('left', 'TOP'))}.dataset.champion === 'Garen'`, 10000);
        await h.ev(`document.getElementById('reset-btn').click(); 1`);
        const emptied = await h.ev(`!document.querySelector('.role-slot[data-champion]')`);
        const repainted = await h.waitFor(`${$(slotSel('left', 'MIDDLE'))}.dataset.champion === 'Kassadin' && /Kassadin/.test(document.getElementById('analysis-view').textContent)`, 5000);
        R.ok('Reset Draft in champion select: the next poll puts the picks back, Draft Analysis included', emptied && repainted, { emptied, board: await board('left') });

        // ---------- A1-F3: a new game (another gameId) clears the role locks ----------
        await h.ev(`(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); ${$(slotSel('left', 'MIDDLE'))}.click(); await w(150); ${$(slotSel('left', 'TOP'))}.click(); await w(400); return 1; })()`);
        const swapped = await board('left'), locks1 = (await locks()).sort();
        sess = null;
        await h.sleep(1600);
        sess = { gameId: 200, localPlayerCellId: 0, actions: [[]], theirTeam: [], myTeam: [P(0, 86, 'top'), P(1, 38, 'middle'), empty(2), empty(3), empty(4)] };
        await h.waitFor(`${$(slotSel('left', 'TOP'))}.dataset.champion === 'Garen' && ${$(slotSel('left', 'MIDDLE'))}.dataset.champion === 'Kassadin'`, 6000);
        const locks2 = await locks();
        R.ok('swap locks both slots in game 1', /TOP:Kassadin/.test(swapped) && JSON.stringify(locks1) === '["lMIDDLE","lTOP"]', { swapped, locks1 });
        R.ok('the next champion select (new gameId): no locks left, each pick in its player\'s lane', locks2.length === 0 && /TOP:Garen/.test(await board('left')), { locks2, board: await board('left') });

        // ---------- A1-F7: a teammate's selection during their own pick turn is a hover, not a locked pick ----------
        sess = { gameId: 300, localPlayerCellId: 0, theirTeam: [],
            actions: [[{ actorCellId: 0, type: 'pick', completed: true, championId: 103 }, { actorCellId: 2, type: 'pick', completed: false, isInProgress: true, championId: 222 }]],
            myTeam: [P(0, 103, 'middle'), P(1, 0, 'top'), P(2, 222, 'bottom'), P(3, 0, 'jungle'), P(4, 0, 'utility')] };
        await h.waitFor(`${$(slotSel('left', 'MIDDLE'))}.dataset.champion === 'Ahri'`, 6000);
        await h.sleep(300);
        const bot = await h.ev(`(() => { const s = ${$(slotSel('left', 'BOTTOM'))}; return { champion: s.dataset.champion || null, hover: s.dataset.hover || null, grey: !!s.querySelector('.champion-portrait.hovered') }; })()`);
        R.ok('Jinx selected in her pick turn (not locked): Bot shows a greyed hover, no locked pick', bot.hover === 'Jinx' && !bot.champion && bot.grey, bot);
        // ...and once the action is completed it is a pick
        sess = JSON.parse(JSON.stringify(sess)); sess.actions[0][1].completed = true; sess.actions[0][1].isInProgress = false;
        R.ok('locked in: Jinx becomes the Bot pick', await h.waitFor(`${$(slotSel('left', 'BOTTOM'))}.dataset.champion === 'Jinx'`, 5000), await board('left'));

        // ---------- A1-F10: a hover swapped into a lane keeps it when a teammate locks a champion for that lane (blind pick) ----------
        sess = { gameId: 400, localPlayerCellId: 0, theirTeam: [],
            actions: [[{ actorCellId: 0, type: 'pick', completed: true, championId: 86 }, { actorCellId: 1, type: 'pick', completed: false, championId: 0 }, { actorCellId: 2, type: 'pick', completed: false, championId: 0 }]],
            myTeam: [P(0, 86, ''), P(1, 0, '', 222), P(2, 0, ''), P(3, 0, ''), P(4, 0, '')] };
        await h.waitFor(`${$(slotSel('left', 'TOP'))}.dataset.champion === 'Garen' && [...document.querySelectorAll("[data-side='left'].role-slot")].some(s => s.dataset.hover === 'Jinx')`, 6000);
        await h.ev(`(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); const from = [...document.querySelectorAll("[data-side='left'].role-slot")].find(s => s.dataset.hover === 'Jinx');
            from.click(); await w(150); ${$(slotSel('left', 'MIDDLE'))}.click(); await w(400); return 1; })()`);
        const hoverMoved = await h.ev(`${$(slotSel('left', 'MIDDLE'))}.dataset.hover || null`);
        sess = JSON.parse(JSON.stringify(sess)); sess.myTeam[2].championId = 134; sess.actions[0][2] = { actorCellId: 2, type: 'pick', completed: true, championId: 134 };   // Syndra (a mid) locked
        await h.waitFor(`[...document.querySelectorAll("[data-side='left'].role-slot")].some(s => s.dataset.champion === 'Syndra')`, 6000);
        await h.sleep(1200);
        const mid = await h.ev(`(() => { const s = ${$(slotSel('left', 'MIDDLE'))}; return { champion: s.dataset.champion || null, hover: s.dataset.hover || null }; })()`);
        R.ok('Jinx (hover) moved to Mid stays there when Syndra is locked; Syndra goes elsewhere', hoverMoved === 'Jinx' && mid.hover === 'Jinx' && !mid.champion, { hoverMoved, mid, board: await board('left') });

        // ---------- A1-F14: a champion banned in the live champion select can't be placed from the grid ----------
        sess = { gameId: 500, localPlayerCellId: 0, theirTeam: [], actions: [[{ actorCellId: 6, type: 'ban', completed: true, championId: 157 }]],
            myTeam: [P(0, 0, 'middle'), empty(1), empty(2), empty(3), empty(4)] };
        await h.sleep(1500);
        await h.ev(`(async () => { document.querySelector('.champion-tile[data-champion-name="Yasuo"]').click(); await new Promise(r => setTimeout(r, 50));
            ${$(slotSel('right', 'SUPPORT'))}.click(); await new Promise(r => setTimeout(r, 300)); return 1; })()`);
        R.ok('a banned champion (Yasuo) clicked into a slot is refused', !(await h.ev(`document.querySelector('.role-slot[data-champion="Yasuo"]') !== null`)), await board('right'));

        // ---------- A1-F17: an older, slower poll never paints over a newer champion select ----------
        slowPickable = true;
        sess = { gameId: 600, localPlayerCellId: 0, theirTeam: [], actions: [[]], myTeam: [P(0, 38, 'middle'), empty(1), empty(2), empty(3), empty(4)] };   // Kassadin (slow answer)
        await h.sleep(1200);
        sess = { gameId: 600, localPlayerCellId: 0, theirTeam: [], actions: [[]], myTeam: [P(0, 112, 'middle'), empty(1), empty(2), empty(3), empty(4)] };  // Viktor
        await h.sleep(4500);
        const final = await h.ev(`${$(slotSel('left', 'MIDDLE'))}.dataset.champion || null`);
        R.ok('the board ends on the newest state (Viktor), not on the slow older answer (Kassadin)', final === 'Viktor', { final, board: await board('left') });

        sess = null;
        const errs = h.logs.filter(l => /Uncaught|TypeError|ReferenceError/.test(l));
        R.ok('no uncaught errors', errs.length === 0, errs.slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
