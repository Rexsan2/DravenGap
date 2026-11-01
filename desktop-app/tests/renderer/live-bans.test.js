// Live Tracking, bans vs champions you don't own: a fake champion select where Yasuo is banned and Ahri is not in your pickable
// list. Yasuo is unavailable for every slot; Ahri only for your own pick (left side, your assigned lane MIDDLE), not for an enemy
// slot or a teammate's. A manual swap keeps the ban (refreshUnavailableChampions used to rebuild the set from the board only).
const H = require('../lib/renderer-harness');
const R = H.results();

const champSelect = () => ({ localPlayerCellId: 0, actions: [[{ type: 'ban', completed: true, championId: 157, actorCellId: 0 }]],
    theirTeam: [{ cellId: 5, championId: 0, championPickIntent: 0 }, { cellId: 6, championId: 0, championPickIntent: 0 }],
    myTeam: [{ cellId: 0, championId: 0, championPickIntent: 0, assignedPosition: 'middle' }, { cellId: 1, championId: 38, championPickIntent: 0, assignedPosition: 'top' },
        { cellId: 2, championId: 86, championPickIntent: 0, assignedPosition: 'jungle' }, { cellId: 3, championId: 0, championPickIntent: 0, assignedPosition: 'bottom' }, { cellId: 4, championId: 0, championPickIntent: 0, assignedPosition: 'utility' }] });
// every champion key except Ahri (103)
const pickable = () => Array.from({ length: 1200 }, (_, i) => i + 1).filter(k => k !== 103);

(async () => {
    try {
        const h = await H.boot({ ipc: { 'get-champ-select': champSelect, 'get-pickable-champions': pickable } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        const out = await h.ev(`(async () => {
            const sleep = ms => new Promise(r => setTimeout(r, ms)); const $ = s => document.querySelector(s);
            const slotOf = c => [...document.querySelectorAll("[data-side='left'].role-slot")].find(s => s.dataset.champion === c);
            for (let i = 0; i < 60 && !(slotOf('Kassadin') && slotOf('Garen')); i++) await sleep(100);
            const row = name => $('#recommendation-list li[data-champion-name="' + name + '"]');
            const state = async () => { for (let i = 0; i < 50 && !(row('Yasuo') && row('Ahri')); i++) await sleep(100); return { yasuo: !!(row('Yasuo') && row('Yasuo').classList.contains('unavailable')), ahri: !!(row('Ahri') && row('Ahri').classList.contains('unavailable')), rows: document.querySelectorAll('#recommendation-list li').length }; };
            const suggest = (side, role) => $("[data-side='" + side + "'][data-role='" + role + "'] .suggest-btn").click();
            const out = {};
            suggest('left', 'MIDDLE'); await sleep(400); out.mine = await state();
            // a manual swap of two teammates must keep the ban (the list is only re-marked, not rebuilt)
            const from = slotOf('Kassadin'), to = slotOf('Garen'); from.click(); await sleep(150); to.click(); await sleep(400);
            out.afterSwap = { yasuo: !!(row('Yasuo') && row('Yasuo').classList.contains('unavailable')), swapped: slotOf('Kassadin').dataset.role };
            suggest('right', 'MIDDLE'); await sleep(400); out.enemy = await state();
            suggest('left', 'BOTTOM'); await sleep(400); out.mate = await state();
            return out;
        })()`);
        R.ok('your own slot: the banned champion and the one you don\'t own are both unavailable', out.mine.rows > 5 && out.mine.yasuo && out.mine.ahri, out.mine);
        R.ok('an enemy slot: the ban holds, but the champion you don\'t own is offered', out.enemy.rows > 5 && out.enemy.yasuo && !out.enemy.ahri, out.enemy);
        R.ok('a teammate\'s slot: same, their pool is not yours', out.mate.rows > 5 && out.mate.yasuo && !out.mate.ahri, out.mate);
        R.ok('after a manual swap the ban is still there', out.afterSwap.yasuo && out.afterSwap.swapped === 'JUNGLE', out.afterSwap);
        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
