// Recommendation search box: a search typed to find one pick must not empty the next slot's list. Picking from the list clears it,
// a new target slot clears it, and when the search is what hides every row the list says so, with a "Clear search" button.
const H = require('../lib/renderer-harness');
const R = H.results();

(async () => {
    try {
        const h = await H.boot({});
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        await h.sleep(1000);
        const rows = () => h.ev(`document.querySelectorAll('#recommendation-list li[data-champion-name]').length`);
        const suggest = (side, role) => h.ev(`document.querySelector("[data-side='${side}'][data-role='${role}'] .suggest-btn").click(); 1`);
        const search = q => h.ev(`(() => { const s = document.getElementById('recommendation-search'); s.value = ${JSON.stringify(q)}; s.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);

        // no slot chosen: the list explains what to do
        R.ok('no slot chosen: a hint to click a slot\'s 💡', /Click the 💡 on a slot/.test(await h.ev(`document.getElementById('recommendation-list').textContent`)));

        // the reported case: search "renat", pick Renata for Support, then the enemy Bot
        await suggest('left', 'SUPPORT');
        await h.waitFor(`document.querySelectorAll('#recommendation-list li[data-champion-name]').length > 5`, 15000);
        await search('renat');
        await h.waitFor(`document.querySelectorAll('#recommendation-list li[data-champion-name]').length === 1`, 5000);
        await h.ev(`document.querySelector('#recommendation-list li[data-champion-name="Renata"]').click(); 1`);
        await h.sleep(500);
        const after = await h.ev(`({ slot: document.querySelector("[data-side='left'][data-role='SUPPORT']").dataset.champion, search: document.getElementById('recommendation-search').value })`);
        R.ok('picking from the list fills the slot and clears the search', after.slot === 'Renata' && after.search === '', after);
        await suggest('right', 'BOTTOM');
        R.ok('the next slot (enemy Bot) gets its full list', await h.waitFor(`document.querySelectorAll('#recommendation-list li[data-champion-name]').length > 5`, 15000), await rows());

        // a search left over from another slot is cleared when a new slot is chosen
        await search('renat');
        await h.sleep(300);
        const hint = await h.ev(`document.getElementById('recommendation-list').textContent`);
        R.ok('a search hiding every row says so (not "no champions meet the filter criteria")', /No champion here matches the search "renat"/.test(hint) && !!(await h.ev(`!!document.querySelector('#recommendation-list .rec-clear-search')`)), hint);
        await h.ev(`document.querySelector('#recommendation-list .rec-clear-search').click(); 1`);
        R.ok('"Clear search" brings the list back', await h.waitFor(`document.querySelectorAll('#recommendation-list li[data-champion-name]').length > 5 && document.getElementById('recommendation-search').value === ''`, 5000));
        await search('renat');
        await suggest('right', 'SUPPORT');
        R.ok('choosing another slot clears an old search', await h.waitFor(`document.querySelectorAll('#recommendation-list li[data-champion-name]').length > 5 && document.getElementById('recommendation-search').value === ''`, 15000));
        // the same slot again keeps a search you are typing
        await search('le');
        await suggest('right', 'SUPPORT');
        await h.sleep(300);
        R.ok('re-clicking the same slot keeps the search', (await h.ev(`document.getElementById('recommendation-search').value`)) === 'le');

        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.filter(l => /Uncaught|TypeError|ReferenceError/.test(l)).slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
