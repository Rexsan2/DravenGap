// Draft in champion select: slots shown in pick order. Your team's champions go to the lane of the player who picked them
// (Garen picked by the support player sits in Support), the enemy team is guessed from role play rates, and a manual swap
// on the enemy side still corrects the guess.
const H = require('../lib/renderer-harness');
const R = H.results();

const session = { localPlayerCellId: 1, actions: [[]],
    myTeam: [{ cellId: 0, championId: 86, championPickIntent: 0, assignedPosition: 'utility' },      // Garen, support player
        { cellId: 1, championId: 103, championPickIntent: 0, assignedPosition: 'middle' },            // me: Ahri
        { cellId: 2, championId: 0, championPickIntent: 222, assignedPosition: 'bottom' },            // hovering Jinx
        { cellId: 3, championId: 64, championPickIntent: 0, assignedPosition: 'jungle' },             // Lee Sin
        { cellId: 4, championId: 0, championPickIntent: 0, assignedPosition: 'top' }],
    theirTeam: [{ cellId: 5, championId: 238, championPickIntent: 0 }, { cellId: 6, championId: 412, championPickIntent: 0 }, { cellId: 7, championId: 0, championPickIntent: 0 },
        { cellId: 8, championId: 0, championPickIntent: 0 }, { cellId: 9, championId: 0, championPickIntent: 0 }] };

(async () => {
    try {
        const h = await H.boot({ ipc: { 'get-champ-select': () => session } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        await h.waitFor(`document.querySelector("[data-side='left'][data-role='SUPPORT']").dataset.champion === 'Garen'`, 15000);
        await h.sleep(500);
        const view = side => h.ev(`[...document.querySelectorAll("[data-side='${side}'].role-slot")].sort((a, b) => getComputedStyle(a).order - getComputedStyle(b).order)
            .map(s => s.querySelector('.slot-tag').textContent + '=' + (s.dataset.champion || s.dataset.hover || '-') + (s.classList.contains('is-me') ? '*' : '')).join(' | ')`);
        const left = await view('left');
        R.ok('your team in pick order, each champion in its picker\'s lane, you marked', left === '#1 Support=Garen | #2 Mid=Ahri* | #3 Bot=Jinx | #4 Jungle=LeeSin | #5 Top=-', left);
        const right = await view('right');
        R.ok('enemy picks guessed by role play rate, in pick order', /^#1 Mid=Zed \| #2 Support=Thresh/.test(right), right);
        // manual correction on the enemy side: Zed to Top
        await h.ev(`(async () => { const s = q => document.querySelector(q); s("[data-side='right'][data-role='MIDDLE']").click(); await new Promise(r => setTimeout(r, 150));
            s("[data-side='right'][data-role='TOP']").click(); await new Promise(r => setTimeout(r, 300)); return 1; })()`);
        await h.sleep(2500);
        const fixed = await view('right');
        R.ok('a swap corrects the enemy lane, survives polls, order follows the pick', /^#1 Top=Zed \| #2 Support=Thresh/.test(fixed), fixed);
        R.ok('the draft model sees the corrected lanes', await h.ev(`document.querySelector("[data-side='right'][data-role='TOP']").dataset.champion === 'Zed'`));
        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
