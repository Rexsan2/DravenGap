// Personal build (key inside the exe): no word about Riot keys anywhere in the window: Settings, How to Use, the setup check,
// tooltips, Multi-search, and error states added later by the views.
const H = require('../lib/renderer-harness');
const R = H.results();

const LEAK = /api key|riot key|rgapi|developer\.riotgames/i;
const leaks = `(() => { const c = document.body.cloneNode(true); c.querySelectorAll('.key-ui, script, style').forEach(e => e.remove());
    const out = []; const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (n.nodeType === 3) { if (/api key|riot key|rgapi|developer\\.riotgames/i.test(n.nodeValue)) out.push(n.nodeValue.trim().slice(0, 120)); }
        else for (const a of ['title', 'placeholder', 'aria-label']) { const v = n.getAttribute(a); if (v && /api key|riot key|rgapi/i.test(v)) out.push(a + ': ' + v.slice(0, 120)); }
    } return out; })()`;

(async () => {
    try {
        const h = await H.boot({ builtinKey: true, onboarding: true, ipc: {
            'get-riot-key-status': () => ({ set: true, builtin: true, hint: null }),
            'profile:search': () => ({ ok: false, code: 'KEY_REJECTED', error: 'Riot API key rejected. Personal keys can expire or be revoked; paste a fresh one in Settings.' }),
            'profile:multi': () => ({ ok: false, code: 'NO_KEY', error: 'No Riot API key saved. Add one in Settings.' })
        } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        await h.sleep(1500);
        R.ok('flag reaches the window', await h.ev(`DD.builtinKey === true && document.documentElement.classList.contains('builtin-key')`));
        R.ok('Settings key section hidden', await h.ev(`getComputedStyle(document.querySelector('#riot-key-input').closest('section')).display === 'none'`));
        R.ok('setup check has no key step', await h.ev(`!document.querySelector('.ob-step[data-step="key"]')`));
        let l = await h.ev(leaks);
        R.ok('no key mention in the page after start-up (help, settings, tooltips, setup check)', l.length === 0, l);
        // views that add text later
        await h.ev(`document.getElementById('settings-btn').click(); 1`); await h.sleep(500);
        await h.ev(`DD.showView('scout'); DDScout.setText('Alpha#EUW'); DDScout.search(); 1`); await h.sleep(1500);
        await h.ev(`DD.showView('profile'); 1`); await h.sleep(800);
        l = await h.ev(leaks);
        R.ok('no key mention after Settings, Multi-search error and Profile', l.length === 0, l);
        const t = await h.ev(`[DD.scrubKeyText('Up to 10 players. Needs a Riot API key (Settings); players looked up recently come from the cache.'),
            DD.scrubKeyText('Only champions you play: 3+ games in your saved history (League client / Riot key) or 20,000+ mastery points.')]`);
        R.ok('rewritten sentences still read well', t[0] === 'Up to 10 players. Players looked up recently come from the cache.', t);
        R.ok('pool tooltip keeps the League client', t[1] === 'Only champions you play: 3+ games in your saved history (League client) or 20,000+ mastery points.', t[1]);
        R.ok('no uncaught errors', !h.logs.some(x => /Uncaught|TypeError|ReferenceError/.test(x)), h.logs.filter(x => /Error/.test(x)).slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
