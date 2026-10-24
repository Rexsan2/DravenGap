// Clearing the draft board: Reset Draft clears everything; "Clear" by a team's name clears that team; right-click a champion on
// the board > Remove takes out just that one (the champion menu used to swallow the right-click), and > Reset draft clears all.
const H = require('../lib/renderer-harness');
const R = H.results();

(async () => {
    try {
        const h = await H.boot({});
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        await h.sleep(1000);
        const place = (side, role, champ) => h.ev(`(async () => { document.querySelector("[data-side='${side}'][data-role='${role}']").click(); await new Promise(r => setTimeout(r, 50));
            document.querySelector('.champion-tile[data-champion-name="${champ}"]').click(); await new Promise(r => setTimeout(r, 250)); return 1; })()`);
        const board = () => h.ev(`[...document.querySelectorAll('.role-slot')].filter(s => s.dataset.champion).map(s => s.dataset.side[0] + s.dataset.role + '=' + s.dataset.champion).join()`);
        const fill = async () => { await place('left', 'BOTTOM', 'Kalista'); await place('left', 'SUPPORT', 'Renata'); await place('right', 'TOP', 'Garen'); await place('right', 'MIDDLE', 'Ahri'); };
        const rightClick = (side, role) => h.ev(`(() => { const img = document.querySelector("[data-side='${side}'][data-role='${role}'] img"); const r = img.getBoundingClientRect();
            img.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 5, clientY: r.y + 5, button: 2 }));
            const m = document.querySelector('.dg-menu'); return m && m.style.display !== 'none' ? [...m.querySelectorAll('[data-menu]')].map(b => b.dataset.menu + ':' + b.textContent) : null; })()`);
        const menuClick = k => h.ev(`document.querySelector('.dg-menu [data-menu="${k}"]').click(); 1`);

        await fill();
        R.ok('board filled', (await board()) === 'lBOTTOM=Kalista,lSUPPORT=Renata,rTOP=Garen,rMIDDLE=Ahri', await board());
        // right-click > Remove
        const items = await rightClick('left', 'BOTTOM');
        R.ok('right-click on a board champion: Remove first, Reset draft last', items && /^remove:Remove from left Bot/.test(items[0]) && /^reset:/.test(items[items.length - 1]) && items.some(x => /^hub:/.test(x)), items);
        await menuClick('remove'); await h.sleep(300);
        R.ok('Remove takes out just that champion', (await board()) === 'lSUPPORT=Renata,rTOP=Garen,rMIDDLE=Ahri', await board());
        // Clear by the team name
        await h.ev(`document.querySelector('.team-clear[data-clear-side="right"]').click(); 1`); await h.sleep(300);
        R.ok('"Clear" by Right Team clears only that team', (await board()) === 'lSUPPORT=Renata', await board());
        R.ok('the Clear buttons survive the board being rebuilt', (await h.ev(`document.querySelectorAll('.team-clear').length`)) === 2);
        // right-click > Reset draft
        await fill();
        await rightClick('right', 'TOP');
        await menuClick('reset'); await h.sleep(300);
        R.ok('right-click > Reset draft clears both teams', (await board()) === '', await board());
        // the Reset Draft button
        await fill();
        await h.ev(`document.getElementById('reset-btn').click(); 1`); await h.sleep(300);
        R.ok('Reset Draft button clears both teams', (await board()) === '', await board());
        // the menu elsewhere has no Remove (a recommendation row, the tier list...)
        await h.ev(`document.querySelector("[data-side='left'][data-role='MIDDLE'] .suggest-btn").click(); 1`);
        await h.waitFor(`document.querySelectorAll('#recommendation-list li[data-champion-name] img').length > 3`, 15000);
        const other = await h.ev(`(() => { const img = document.querySelector('#recommendation-list li[data-champion-name] img'); img.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50, button: 2 }));
            return [...document.querySelectorAll('.dg-menu [data-menu]')].map(b => b.dataset.menu); })()`);
        R.ok('off the board the menu has no Remove / Reset', other.length > 0 && !other.includes('remove') && !other.includes('reset'), other);

        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.filter(l => /Uncaught|TypeError|ReferenceError/.test(l)).slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
