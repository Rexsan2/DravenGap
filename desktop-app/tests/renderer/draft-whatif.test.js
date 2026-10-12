// "What if" and practice draft: pin a draft in Draft Analysis, change a pick, the verdict shows the change
// in points and which slot changed, "Back to pinned" restores the picks; Ctrl+K "Practice draft" turns Live Tracking off and clears the board.
const H = require('../lib/renderer-harness');
const R = H.results();

(async () => {
    try {
        const copies = [];
        const h = await H.boot({ size: [1400, 900], ipc: { 'copy-region': (e, r) => { copies.push(r); return { ok: true, width: Math.round(r.width), height: Math.round(r.height) }; } } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        const place = (side, role, champ) => h.ev(`(async () => { document.querySelector("[data-side='${side}'][data-role='${role}']").click(); await new Promise(r => setTimeout(r, 50));
            document.querySelector('.champion-tile[data-champion-name="${champ}"]').click(); await new Promise(r => setTimeout(r, 300)); return 1; })()`);
        const whatIf = () => h.ev(`(document.querySelector('#analysis-view .analysis-whatif') || {}).textContent || ''`);
        // a stopped Live Tracking keeps the manual picks
        await h.ev(`DD.practiceDraft(); 1`);
        R.ok('Practice draft: Live Tracking off, empty board', await h.ev(`!/Stop/.test(document.getElementById('live-tracking-btn').textContent) && !document.querySelector('.role-slot[data-champion]')`));
        await place('left', 'MIDDLE', 'Ahri'); await place('right', 'MIDDLE', 'Akali'); await place('left', 'TOP', 'Garen'); await place('right', 'TOP', 'Darius');
        await h.ev(`DD.setDraftTab('analysis'); 1`);
        R.ok('the verdict offers "Pin this draft"', await h.waitFor(`/Pin this draft/.test((document.querySelector('#analysis-view .analysis-whatif') || {}).textContent || '')`, 8000));
        const before = await h.ev(`(() => { const b = document.querySelector('#analysis-view .analysis-verdict-main b'); return b ? b.textContent : null; })()`);
        await h.ev(`document.querySelector('#analysis-view [data-pin="set"]').click(); 1`);
        R.ok('pinned: it says so', await h.waitFor(`/Pinned \\(Left/.test((document.querySelector('#analysis-view .analysis-whatif') || {}).textContent || '')`, 5000), await whatIf());
        R.ok('the pinned verdict is the one on screen', (await h.ev(`(DD.whatIf.pinned().wr * 100).toFixed(1) + '%'`)) === before, before);
        await place('left', 'MIDDLE', 'Syndra');
        await h.ev(`DD.setDraftTab('analysis'); 1`);
        await h.waitFor(`/vs pinned draft/.test((document.querySelector('#analysis-view .analysis-whatif') || {}).textContent || '')`, 8000);
        const t = await whatIf();
        R.ok('after a change: old → new win chance, the points moved and the slot that changed', /vs pinned draft: Left \d+\.\d% → \d+\.\d%/.test(t) && /[+-]\d+\.\d pts/.test(t) && /Left Mid: Ahri → Syndra/.test(t), t.replace(/\s+/g, ' '));
        await h.ev(`document.querySelector('#analysis-view [data-pin="restore"]').click(); 1`);
        R.ok('"Back to pinned" puts Ahri back', await h.waitFor(`document.querySelector("[data-side='left'][data-role='MIDDLE']").dataset.champion === 'Ahri'`, 5000));
        R.ok('and the line says pinned again', await h.waitFor(`/Pinned \\(Left/.test((document.querySelector('#analysis-view .analysis-whatif') || {}).textContent || '')`, 8000), await whatIf());
        await h.ev(`document.querySelector('#analysis-view [data-pin="clear"]').click(); 1`);
        R.ok('Unpin', await h.waitFor(`DD.whatIf.pinned() === null && /Pin this draft/.test(document.querySelector('#analysis-view .analysis-whatif').textContent)`, 5000));
        // Copy as image (REC 2.11): the analysis area, inside the window, the button itself hidden while capturing
        await h.ev(`document.querySelector('#analysis-view [data-copy-draft]').click(); 1`);
        await h.waitFor(`[...document.querySelectorAll('.dg-toast')].some(t => /Copied the draft as an image/.test(t.textContent))`, 5000);
        const c = copies[0] || {};
        R.ok('"Copy as image" sends the analysis area (inside the 1400 x 900 window) and says it was copied', copies.length === 1 && c.x >= 0 && c.y >= 0 && c.width > 300 && c.height > 100 && c.x + c.width <= 1401 && c.y + c.height <= 901, c);
        R.ok('the button is visible again afterwards', await h.ev(`document.querySelector('#analysis-view [data-copy-draft]').style.visibility === ''`));
        const errs = h.logs.filter(l => /Uncaught|TypeError|ReferenceError/.test(l));
        R.ok('no uncaught errors', errs.length === 0, errs);
    } catch (e) { R.ok('test ran', false, String(e && e.stack || e)); }
    R.finish();
})();
