// Live Tracking: a fake champ select with Kassadin and Yasuo on my team. A manual swap must survive later polls
// (both slots get locked), and unlocking hands the slot back to the automatic role guess.
const H = require('../lib/renderer-harness');
const R = H.results();

const champSelect = () => ({ localPlayerCellId: 0, actions: [[]], theirTeam: [],
    myTeam: [{ cellId: 0, championId: 38, championPickIntent: 0 }, { cellId: 1, championId: 157, championPickIntent: 0 }, { cellId: 2, championId: 0, championPickIntent: 0 }, { cellId: 3, championId: 0, championPickIntent: 0 }, { cellId: 4, championId: 0, championPickIntent: 0 }] });

(async () => {
    try {
        const h = await H.boot({ ipc: { 'get-champ-select': champSelect } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        const out = await h.ev(`(async () => {
            const sleep = ms => new Promise(r => setTimeout(r, ms)); const $ = s => document.querySelector(s);
            const team = () => ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'SUPPORT'].map(r => r + ':' + ($("[data-side='left'][data-role='" + r + "']").dataset.champion || '-')).join(' ');
            const locks = () => [...document.querySelectorAll("[data-side='left'] .lock-btn.locked")].map(b => b.closest('.role-slot').dataset.role);
            const slotOf = c => [...document.querySelectorAll("[data-side='left'].role-slot")].find(s => s.dataset.champion === c);
            for (let i = 0; i < 60 && !(slotOf('Kassadin') && slotOf('Yasuo')); i++) await sleep(100);
            const out = { auto: team() };
            const move = async (champ, role) => {
                const from = slotOf(champ), to = $("[data-side='left'][data-role='" + role + "']");
                if (!from || from === to) return;
                from.click(); await sleep(150); to.click(); await sleep(300);
            };
            await move('Kassadin', 'TOP'); await move('Yasuo', 'MIDDLE');
            out.afterSwap = team(); out.locks = locks().sort();
            await sleep(4000);                       // several Live Tracking polls later
            out.afterPolls = team();
            slotOf('Kassadin').querySelector('.lock-btn').click(); await sleep(200);
            out.locksAfterUnlock = locks();
            return out;
        })()`);
        R.ok('both picks placed automatically', /Kassadin/.test(out.auto) && /Yasuo/.test(out.auto), out.auto);
        R.ok('swap puts Kassadin top and Yasuo mid', /TOP:Kassadin/.test(out.afterSwap) && /MIDDLE:Yasuo/.test(out.afterSwap), out.afterSwap);
        R.ok('both swapped slots are locked', JSON.stringify(out.locks) === JSON.stringify(['MIDDLE', 'TOP']), out.locks);
        R.ok('order holds through 4 s of polls', out.afterPolls === out.afterSwap, out.afterPolls);
        R.ok('unlocking Kassadin leaves only the MIDDLE lock', JSON.stringify(out.locksAfterUnlock) === JSON.stringify(['MIDDLE']), out.locksAfterUnlock);
        R.ok('champ select was polled', h.calls.filter(c => c[0] === 'get-champ-select').length >= 3);
        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
