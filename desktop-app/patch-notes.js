// Buff / nerf / adjust marks from the current patch's notes (patchnotes-main.js reads and classifies them): a green ▲ (buffed),
// red ▼ (nerfed) or blue = (adjusted) next to every champion changed this patch, in the champion grid, the recommendations,
// the tier list and patch movers. Hovering a mark shows the developer context and the changes. The marks are added to whatever
// the views render (MutationObserver), so no view needs to know about them.
window.DDPatchNotes = (function () {
    const api = window.electronAPI && window.electronAPI.feature;
    const KIND = { buff: { sym: '▲', label: 'Buffed' }, nerf: { sym: '▼', label: 'Nerfed' }, adjust: { sym: '=', label: 'Adjusted' } };
    let notes = null;            // { patch, url, champions: { id: { name, kind, context, changes } } }
    let asked = '';              // patch last asked for (one request per patch)
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function info(id) { return notes && notes.champions && notes.champions[id] || null; }
    function markEl(id) {
        const c = info(id);
        if (!c || !KIND[c.kind]) return null;
        const el = document.createElement('span');
        el.className = `pn-mark pn-${c.kind}`;
        el.dataset.pn = id;
        el.textContent = KIND[c.kind].sym;
        el.setAttribute('aria-label', `${KIND[c.kind].label} in patch ${notes.patch}`);
        return el;
    }

    // [selector, champion id of the element, where the mark goes]
    const TARGETS = [
        ['.champion-tile[data-champion-name]', el => el.dataset.championName, el => el],
        ['.rec-cell-champ', el => { const b = el.querySelector('[data-champion]'); return b && b.dataset.champion; }, el => el.querySelector('.rec-name')],
        ['.tl-row[data-hub]', el => el.dataset.hub, el => el.querySelector('td.l')],
        ['.tl-mover[data-hub]', el => el.dataset.hub, el => el.querySelector('.tl-mn')]
    ];
    function decorate() {
        for (const [sel, idOf, hostOf] of TARGETS) {
            for (const el of document.querySelectorAll(sel)) {
                const id = idOf(el), host = hostOf(el);
                if (!id || !host) continue;
                const old = host.querySelector(':scope > .pn-mark');
                if (old && old.dataset.pn === id && old.dataset.patch === (notes && notes.patch)) continue;
                if (old) old.remove();
                const m = markEl(id);
                if (m) { m.dataset.patch = notes.patch; host.appendChild(m); }
            }
        }
    }
    let queued = false;
    const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; decorate(); }); } };

    async function load(patch) {
        if (!api || !patch || patch === asked) return;
        asked = patch;
        try {
            const r = await api.invoke('patch:notes', { patch, latest: true });
            if (r && r.ok && r.champions) { notes = { patch: r.patch, url: r.url, champions: r.champions }; schedule(); }
            else asked = '';  // try again on the next call (the main process limits retries)
        } catch (e) { asked = ''; }
    }

    // hover card
    let tip = null;
    function tipHtml(id) {
        const c = info(id);
        if (!c) return '';
        const k = KIND[c.kind];
        const lines = c.changes.slice(0, 14).map(ch => {
            const cls = ch.dir > 0 ? 'pn-up' : ch.dir < 0 ? 'pn-down' : '';
            const what = ch.attr ? `<b>${esc(ch.attr)}</b>: ${esc(ch.before)} ⇒ ${esc(ch.after)}` : esc(ch.text);
            return `<li class="${cls}">${ch.section ? `<span class="pn-sec">${esc(ch.section)}</span> ` : ''}${what}</li>`;
        }).join('');
        const more = c.changes.length > 14 ? `<li class="pn-sec">and ${c.changes.length - 14} more</li>` : '';
        return `<h4 class="pn-${c.kind}">${k.sym} ${esc(c.name)}: ${k.label.toLowerCase()} in patch ${esc(notes.patch)}</h4>` +
            (c.context ? `<p class="pn-ctx">${esc(c.context)}</p>` : '') + (lines ? `<ul>${lines}${more}</ul>` : '') +
            `<p class="pn-sec">From Riot's patch notes. Buff / nerf is read from the changes, so a mixed set counts as an adjustment.</p>`;
    }
    function place(e) {
        const r = tip.getBoundingClientRect(), pad = 12;
        let x = e.clientX + pad, y = e.clientY + pad;
        if (x + r.width > innerWidth - 4) x = Math.max(4, e.clientX - r.width - pad);
        if (y + r.height > innerHeight - 4) y = Math.max(4, innerHeight - r.height - 4);
        tip.style.left = x + 'px'; tip.style.top = y + 'px';
    }
    document.addEventListener('mouseover', e => {
        const m = e.target.closest && e.target.closest('.pn-mark');
        if (!m) return;
        if (!tip) { tip = document.createElement('div'); tip.className = 'tooltip pn-tip'; document.body.appendChild(tip); }
        tip.innerHTML = tipHtml(m.dataset.pn);
        tip.style.opacity = '1';
        place(e);
    });
    document.addEventListener('mousemove', e => { if (tip && tip.style.opacity === '1' && e.target.closest && e.target.closest('.pn-mark')) place(e); });
    document.addEventListener('mouseout', e => { const m = e.target.closest && e.target.closest('.pn-mark'); if (m && tip && !m.contains(e.relatedTarget)) tip.style.opacity = '0'; });

    const start = () => new MutationObserver(muts => { if (notes && muts.some(m => m.addedNodes.length)) schedule(); }).observe(document.body, { childList: true, subtree: true });
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);

    // Any patch's notes, for the Adaptive period: { championId: { kind, context, changes } }, or undefined when they can't be read
    const byPatch = new Map();
    function get(patch) {
        if (!api || !patch) return Promise.resolve(undefined);
        if (!byPatch.has(patch)) {
            const forget = () => { byPatch.delete(patch); return undefined; };
            byPatch.set(patch, api.invoke('patch:notes', { patch }).then(r => (r && r.ok && r.champions ? r.champions : forget()), forget));
        }
        return byPatch.get(patch);
    }

    return { load, get, info: id => info(id), patch: () => notes && notes.patch, url: () => notes && notes.url, all: () => (notes ? notes.champions : null) };
})();
