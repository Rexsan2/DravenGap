// Personal build (the Riot key is inside the exe, electronAPI.builtinKey): nothing in the window talks about keys.
// Elements marked .key-ui (Settings › Riot API key, its help lines) are hidden by CSS, and every text or tooltip that mentions
// a key, now or added later by any view (a MutationObserver watches the page), is rewritten by the rules below.
(function () {
    const api = window.electronAPI;
    const on = !!(api && api.builtinKey);
    window.DD = window.DD || {};
    DD.builtinKey = on;
    if (!on) return;
    document.documentElement.classList.add('builtin-key');

    // [pattern, replacement], applied in order to text nodes and title / placeholder / aria-label attributes
    const RULES = [
        [/\s*Needs a (?:valid )?Riot API key \(Settings\)[^.;]*[.;]?/g, ''],
        [/;?\s*needs a Riot API key(?:, same [^)]*)?/g, ''],
        [/League client \/ Riot key|League client or Riot key|League client, or a Riot key in Settings|League client or a Riot key/g, 'League client'],
        [/,? ?your Riot API key works,?/g, ','],
        [/A Riot API key is needed/g, 'Riot data unavailable'],
        [/Riot rejected the API key/g, 'Riot data unavailable'],
        [/No Riot API key saved\.?(?: Add one in Settings\.)?/g, 'Riot data is unavailable right now.'],
        [/Riot API key (?:rejected|accepted)[^.]*\.(?:[^.]*(?:Settings|key)[^.]*\.)*/g, "Riot's servers refused the request. Try again later."],
        [/(?:Add|Paste) (?:your personal |a fresh )?(?:Riot API )?key in Settings[^.]*\./g, 'Try again later.'],
        [/Personal keys can expire or be revoked\.\s*/g, ''],
        [/This player id belongs to a different API key\./g, 'This player id is out of date.'],
        [/\s*\(?\b[Rr]iot (?:API )?key\b\)?/g, '']                // anything left: drop the mention
    ];
    const MENTION = /api key|riot key/i;
    const fix = t => { let s = t; for (const [re, to] of RULES) s = s.replace(re, to); return s.replace(/ {2,}/g, ' ').replace(/ ([.,;)])/g, '$1').replace(/,,/g, ',').replace(/([.!?]) ([a-z])/g, (m, p, c) => p + ' ' + c.toUpperCase()); };
    const ATTRS = ['title', 'placeholder', 'aria-label'];
    function scrub(root) {
        if (!root) return;
        if (root.nodeType === 3) { if (MENTION.test(root.nodeValue)) root.nodeValue = fix(root.nodeValue); return; }
        if (root.nodeType !== 1 || root.closest('.key-ui')) return;
        for (const a of ATTRS) { const v = root.getAttribute(a); if (v && MENTION.test(v)) root.setAttribute(a, fix(v)); }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (n.nodeType === 3) { if (MENTION.test(n.nodeValue) && !(n.parentElement && n.parentElement.closest('.key-ui, script, style'))) n.nodeValue = fix(n.nodeValue); }
            else if (!n.closest('.key-ui')) for (const a of ATTRS) { const v = n.getAttribute(a); if (v && MENTION.test(v)) n.setAttribute(a, fix(v)); }
        }
    }
    const start = () => {
        scrub(document.body);
        new MutationObserver(list => {
            for (const m of list) {
                if (m.type === 'characterData') scrub(m.target);
                else if (m.type === 'attributes') scrub(m.target);
                else m.addedNodes.forEach(scrub);
            }
        }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
    DD.scrubKeyText = fix;   // for tests
})();
