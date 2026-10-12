// Glossary (B2), data-source chips (B1) and Exp WR uncertainty bars (B4) in the real window.
const H = require('../lib/renderer-harness');
const R = H.results();

(async () => {
    try {
        const h = await H.boot();
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        // ask for suggestions for the left Top slot
        await h.ev(`document.querySelector("[data-side='left'][data-role='TOP'] .suggest-btn").click(); 1`);
        const gotRows = await h.waitFor(`document.querySelectorAll('#recommendation-list li .ewr-bar').length > 3`, 20000);
        R.ok('recommendation rows render with an uncertainty bar', gotRows);
        const bar = await h.ev(`(() => { const li = document.querySelector('#recommendation-list li'); const i = li.querySelector('.ewr-bar i'), em = li.querySelector('.ewr-bar em');
            return { left: parseFloat(i.style.left), width: parseFloat(i.style.width), point: parseFloat(em.style.left), cls: i.className, wr: JSON.parse(li.dataset.expwr) }; })()`);
        const x = v => Math.min(100, Math.max(0, (v - 0.4) / 0.2 * 100));
        R.ok('bar interval is the 95% range on a 40-60% track', Math.abs(bar.left - x(bar.wr.wr - 1.96 * bar.wr.sd)) < 0.2 && Math.abs(bar.point - x(bar.wr.wr)) < 0.2, bar);
        R.ok('bar colour follows P(Exp WR > 50%)', bar.cls === (bar.wr.p50 >= 0.9 ? 'pp-high' : bar.wr.p50 >= 0.5 ? 'pp-mid' : 'pp-low'), bar);

        const chip = await h.ev(`(() => { const c = document.querySelector('#rec-prov .dg-prov'); return c ? c.textContent : null; })()`);
        R.ok('recommendations show a data-source chip', !!chip && /Platinum\+/.test(chip) && /games/.test(chip) && /LoLalytics/.test(chip), chip);
        const pop = await h.ev(`(async () => { document.querySelector('#rec-prov .dg-prov').click(); await new Promise(r => setTimeout(r, 100));
            const p = document.querySelector('.dg-pop'); return { shown: p.style.display, text: p.textContent, refresh: !!p.querySelector('[data-prov-refresh]') }; })()`);
        R.ok('chip opens its details with a refresh button', pop.shown === 'block' && /Draft data/.test(pop.text) && /Min Games/.test(pop.text) && pop.refresh, pop.text.slice(0, 200));
        const refreshed = await h.ev(`(async () => { document.querySelector('.dg-pop [data-prov-refresh]').click(); for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 100)); const m = document.querySelector('.dg-pop-msg').textContent; if (/Checked/.test(m)) return m; } return document.querySelector('.dg-pop-msg').textContent; })()`);
        R.ok('refresh runs a freshness check', /Checked at/.test(refreshed), refreshed);
        await h.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); 1`);
        R.ok('Escape closes the popover', (await h.ev(`document.querySelector('.dg-pop').style.display`)) === 'none');

        // header tooltip text comes from the glossary
        const tip = await h.ev(`(async () => { document.getElementById('pp-header').dispatchEvent(new MouseEvent('mouseenter')); await new Promise(r => setTimeout(r, 50)); return document.getElementById('pp-tooltip').innerHTML; })()`);
        R.ok('PP header tooltip reads the glossary', tip.includes(await h.ev(`DD.glossary['pp-draft'].title`)) && /posterior/i.test(tip), tip.slice(0, 120));
        R.ok('one evidence scale', JSON.stringify(await h.ev(`[0.95, 0.9, 0.7, 0.5, 0.2, null].map(DD.ppClass)`)) === JSON.stringify(['pp-high', 'pp-high', 'pp-mid', 'pp-mid', 'pp-low', '']));

        // Bans: chip + "?" that must not trigger anything else
        await h.ev(`document.getElementById('bans-tab-btn').click(); 1`);
        await h.waitFor(`!!document.querySelector('#bans-view .bans-table')`, 15000);
        const bans = await h.ev(`(async () => { const q = document.querySelector('#bans-view .dg-help'); q.click(); await new Promise(r => setTimeout(r, 80));
            return { chip: !!document.querySelector('#bans-view .dg-prov'), pop: document.querySelector('.dg-pop').textContent }; })()`);
        R.ok('Bans: data-source chip and a working "?"', bans.chip && /Ban value/.test(bans.pop), bans.pop.slice(0, 80));

        // the full glossary
        const g = await h.ev(`(async () => { DD.openGlossary('wpa'); await new Promise(r => setTimeout(r, 60)); const m = document.getElementById('glossary-modal');
            const d = m.querySelector('#gloss-wpa'); const n = m.querySelectorAll('details').length;
            const q = m.querySelector('.dg-gloss-q'); q.value = 'smurf'; q.dispatchEvent(new Event('input'));
            const hits = [...m.querySelectorAll('details')].map(x => x.dataset.key); return { shown: m.style.display, open: d && d.open, n, hits }; })()`);
        R.ok('Glossary dialog opens on a term and searches', g.shown === 'flex' && g.open && g.n >= 20 && JSON.stringify(g.hits) === JSON.stringify(['tags']), g);
        // How to Use covers the newer features and links to the glossary
        const help = await h.ev(`(async () => { document.querySelector('#glossary-modal .modal-close-btn').click(); document.getElementById('how-to-use-btn').click();
            const m = document.getElementById('how-to-use-modal'); const sections = [...m.querySelectorAll('summary')].map(s => s.textContent.trim()); const text = m.textContent;
            m.querySelector('[data-open-glossary]').click(); await new Promise(r => setTimeout(r, 50));
            return { sections, has: ['Bans', 'why', 'Send to client', 'vs', 'Insights', 'Ctrl+K', 'Follow my game', 'locks', 'Duo', 'Mini window', 'Diagnostics', 'Champion pages', 'Your build vs the data', 'data chip'].filter(w => !text.includes(w)),
                helpOpen: m.style.display, glossOpen: document.getElementById('glossary-modal').style.display }; })()`);
        R.ok('How to Use mentions every feature and opens the glossary', help.has.length === 0 && help.sections.length >= 9 && help.helpOpen === 'none' && help.glossOpen === 'flex', help);
        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
