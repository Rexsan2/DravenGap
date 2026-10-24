// Patch day: the first time DravenGap runs on a new patch, one card with what the patch did to YOUR champions (My pool, else the
// champions you play most): buffed / nerfed / adjusted from Riot's notes (patch-notes.js) with the changes, and how each one's win
// rate moved since the previous saved patch (the draft's patch trend). Shown once per patch (settings.patchDaySeen); it can be
// opened again from Ctrl+K ("Patch changes for my champions").
(function () {
    'use strict';
    const DD = window.DD;
    if (!DD) return;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const KIND = { buff: ['▲', 'Buffed', 'pn-buff'], nerf: ['▼', 'Nerfed', 'pn-nerf'], adjust: ['=', 'Adjusted', 'pn-adjust'] };
    const ROLE_LABEL = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', SUPPORT: 'Support' };
    const pts = v => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}`;
    let el = null;

    const PN = () => window.DDPatchNotes;
    async function myChampions() {
        const pool = DD.myPool ? DD.myPool() : null;
        return pool && pool.length ? pool : null;
    }
    async function build() {
        const pn = PN(), all = pn && pn.all();
        if (!all) return null;
        if (DD.tierData) await DD.tierData().catch(() => null);   // waits for the patch trend (previous saved patch)
        const pool = await myChampions();
        const ids = pool || [];
        const rows = [];
        for (const id of ids) {
            const c = all[id];
            let trend = null, role = null;
            try {
                const d = DD.championData ? await DD.championData(id, null) : null;
                role = d && d.role;
                const r = role && d.roles[role];
                trend = r && r.trend;
            } catch (e) { /* no draft data */ }
            if (c || (trend && trend.flag)) rows.push({ id, c, role, trend });
        }
        rows.sort((a, b) => (!!b.c - !!a.c) || Math.abs((b.trend && b.trend.d) || 0) - Math.abs((a.trend && a.trend.d) || 0));
        return { patch: pn.patch(), url: pn.url(), rows, poolKnown: !!pool, changed: Object.keys(all).length };
    }
    function html(d) {
        const name = id => ((DD.getChampions() || []).find(c => c.id === id) || {}).name || id;
        const img = id => { const c = (DD.getChampions() || []).find(x => x.id === id), v = DD.getLatestPatch && DD.getLatestPatch(); return c && v ? `${DD.ddragonBase}/cdn/${v}/img/champion/${c.image.full}` : ''; };
        const rows = d.rows.map(r => {
            const k = r.c ? KIND[r.c.kind] : null;
            const lines = r.c ? r.c.changes.slice(0, 4).map(ch => `<li class="${ch.dir > 0 ? 'pn-up' : ch.dir < 0 ? 'pn-down' : ''}">${ch.attr ? `<b>${esc(ch.attr)}</b>: ${esc(ch.before)} ⇒ ${esc(ch.after)}` : esc(ch.text)}</li>`).join('') : '';
            return `<div class="pd-row" data-hub="${esc(r.id)}" data-role="${esc(r.role || '')}"><img src="${esc(img(r.id))}" alt="" onerror="this.style.visibility='hidden'">
                <div class="pd-txt"><div><b>${esc(name(r.id))}</b>${k ? ` <span class="${k[2]}">${k[0]} ${k[1]}</span>` : ' <span class="pd-m">not in the notes</span>'}
                ${r.trend ? ` <span class="pd-m">· win rate ${r.role ? ROLE_LABEL[r.role] + ' ' : ''}</span><span class="${r.trend.flag ? (r.trend.d > 0 ? 'delta-pos' : 'delta-neg') : 'pd-m'}">${pts(r.trend.d)} vs ${esc(r.trend.prevPatch)}${r.trend.flag ? '' : ' (noise)'}</span>` : ''}</div>
                ${lines ? `<ul>${lines}${r.c.changes.length > 4 ? `<li class="pd-m">and ${r.c.changes.length - 4} more</li>` : ''}</ul>` : ''}</div></div>`;
        }).join('');
        return `<div class="pd-card" role="dialog" aria-label="Patch ${esc(d.patch)} for your champions">
            <div class="pd-h"><b>Patch ${esc(d.patch)} for your champions</b><button class="pd-x" aria-label="Close">&times;</button></div>
            ${!d.poolKnown ? '<div class="pd-m">Your champions are not known yet (they come from your games in the League client or Profile).</div>'
                : rows || '<div class="pd-m">None of your champions was changed, and none moved beyond noise.</div>'}
            <div class="pd-foot pd-m">${d.changed} champions changed in total · win-rate moves need the previous patch saved for this rank and get clearer as games come in.
                ${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">Riot's patch notes</a>` : ''}</div></div>`;
    }
    async function show(force) {
        const d = await build();
        if (!d) { if (force && DD.toast) DD.toast('The patch notes are not loaded yet. Try again in a moment.'); return false; }
        if (!force && (!d.poolKnown || !d.rows.length)) return false;
        if (!el) {
            el = document.createElement('div');
            el.className = 'pd-back';
            document.body.appendChild(el);
            el.addEventListener('click', e => {
                if (e.target === el || e.target.closest('.pd-x')) { el.style.display = 'none'; return; }
                const r = e.target.closest('[data-hub]');
                if (r && DD.openChampion) { el.style.display = 'none'; DD.openChampion(r.dataset.hub, r.dataset.role || null); }
            });
        }
        el.innerHTML = html(d);
        el.style.display = 'flex';
        return true;
    }
    // once per patch, when the notes and your champions are known (checked for up to 2 minutes after start)
    (async () => {
        for (let i = 0; i < 40; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const pn = PN(), patch = pn && pn.patch();
            if (!patch || !(DD.myPool && DD.myPool())) continue;
            let seen = null;
            try { const s = await window.electronAPI.getSettings(); seen = s && s.patchDaySeen; } catch (e) { return; }
            if (seen === patch) return;
            if (!seen) { DD.patchSettings({ patchDaySeen: patch }).catch(() => {}); return; }   // first run of the app: nothing "new" to report
            await show(false);   // nothing of yours changed: no card, but the patch counts as seen
            DD.patchSettings({ patchDaySeen: patch }).catch(() => {});
            return;
        }
    })();
    DD.patchDay = { show: () => show(true) };
})();
