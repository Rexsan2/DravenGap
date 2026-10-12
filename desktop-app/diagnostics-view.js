// desktop-app/diagnostics-view.js
// Settings > Diagnostics (E4), renderer side: storage per source with Clear / Manage buttons, last refresh per source, Riot
// rate-limit usage, op.gg / Coachless back-off, the League client connection, and "Save a diagnostics report".
// Reads diag:info (diagnostics-main.js), profile:diag, aram:cache-info, arena:cache-info and DD.diagnosticsLocal() (index.html). Loaded lazily:
// nothing is read until the panel is opened, and it refreshes every 2 s while open.
(function () {
    'use strict';
    const DD = window.DD;
    const panel = document.getElementById('diag-panel'), btn = document.getElementById('diag-open-btn');
    const api = window.electronAPI && window.electronAPI.feature;
    if (!DD || !panel || !btn || !api) return;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const bytes = b => (!b ? '0 KB' : b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
    const ago = t => (t ? (DD.ago ? DD.ago(t) : new Date(t).toLocaleString()) : '–');
    const ts = v => (v == null ? null : typeof v === 'number' ? v : (x => (isNaN(x) ? null : x))(Date.parse(/T/.test(v) && !/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v + 'Z' : v)));
    const until = t => (t && t > Date.now() ? `until ${new Date(t).toLocaleTimeString()}` : '');
    const call = (ch, a) => api.invoke(ch, a).catch(e => ({ ok: false, error: e.message }));
    let timer = null, busy = false, msg = '';

    async function collect() {
        const [main, prof, aram, local, arena] = await Promise.all([call('diag:info'), call('profile:diag'), call('aram:cache-info'), DD.diagnosticsLocal ? DD.diagnosticsLocal().catch(() => null) : null, call('arena:cache-info')]);
        return { main, prof, aram, local, arena };
    }

    function render(d) {
        const L = d.local || {}, M = d.main && d.main.ok ? d.main : { stores: [] }, P = d.prof && d.prof.ok ? d.prof : null;
        const store = id => M.stores.find(s => s.id === id) || { bytes: 0, files: 0, newest: 0 };
        const aramFiles = d.aram && d.aram.ok ? d.aram.data.files : [];
        const row = (label, size, when, action) => `<tr><td>${label}</td><td class="n">${size}</td><td>${when}</td><td class="a">${action || ''}</td></tr>`;
        const sRow = (id, action) => { const s = store(id); return row(esc((M.stores.find(x => x.id === id) || {}).label || id), `${bytes(s.bytes)}${s.files > 1 ? ` <span class="diag-m">${s.files.toLocaleString()} files</span>` : ''}`, s.newest ? ago(s.newest) : '–', action); };
        const manage = '<button data-diag="saved">Manage…</button>';
        const clear = (what, label = 'Clear') => `<button data-diag="clear" data-what="${what}">${label}</button>`;
        let h = '<h4>Stored on this PC</h4><table class="diag-t"><thead><tr><th>Source</th><th class="n">Size</th><th>Last change</th><th></th></tr></thead><tbody>';
        if (L.draft) {
            h += row(`Draft data: patch archive (${L.draft.archive.n})`, bytes(L.draft.archive.bytes), '–', manage);
            h += row(`Draft data: 7 / 14 / 30-day windows (${L.draft.windows.n})`, bytes(L.draft.windows.bytes), '–', manage);
        }
        if (L.builds) h += row(`Builds: Coachless (${L.builds.patches} patch${L.builds.patches === 1 ? '' : 'es'})`, bytes(L.builds.bytes), L.builds.newest ? ago(L.builds.newest) : '–', manage);
        h += sRow('profile-matches') + sRow('profile-timelines') + sRow('profile-players');
        h += sRow('profile-lookups', clear('profile-lookups'));
        h += sRow('profile-emblems');
        h += row(`ARAM Mayhem cache (${aramFiles.length})`, bytes(aramFiles.reduce((s, f) => s + f.bytes, 0)), aramFiles.length ? ago(Math.max(...aramFiles.map(f => f.at || 0))) : '–', aramFiles.length ? clear('aram') : '');
        const arenaFiles = d.arena && d.arena.ok ? d.arena.data.files : [];
        h += row(`Arena cache (${arenaFiles.length})`, bytes(arenaFiles.reduce((s, f) => s + f.bytes, 0)), arenaFiles.length ? ago(Math.max(...arenaFiles.map(f => f.at || 0))) : '–', arenaFiles.length ? clear('arena') : '');
        const res = store('coachless-resume');
        h += sRow('coachless-resume', res.files ? clear('coachless-resume') : '');
        h += sRow('personal-history');
        h += '</tbody></table>';
        if (L.storage && L.storage.quota) h += `<div class="diag-m">Window storage in use (datasets, builds, settings cache): ${bytes(L.storage.usage)} of ${bytes(L.storage.quota)} available.</div>`;

        h += '<h4>Sources and limits</h4><table class="diag-t"><tbody>';
        if (L.draft) {
            const saved = ts(L.draft.savedAt);
            h += row('LoLalytics (draft)', esc(L.draft.selected), `${L.draft.offline ? '<span class="diag-warn">offline, saved copy</span> · ' : ''}data from ${ago(saved)} · checked ${ago(L.draft.checkedAt)}`, '');
        }
        h += row('Data Dragon', esc(L.ddragon && L.ddragon.version || '–'), '', '');
        if (P) {
            const w = P.riot.windows.map(x => `${x.used}/${x.limit} per ${x.ms >= 60000 ? x.ms / 60000 + ' min' : x.ms / 1000 + ' s'}`).join(' · ');
            const riotState = !P.riot.keySet ? '<span class="diag-m">no key saved</span>' : P.riot.pausedUntil ? `<span class="diag-warn">paused ${until(P.riot.pausedUntil)}</span>` : '<span class="diag-ok">ok</span>';
            h += row('Riot API', w, `${riotState} · ${P.riot.requests} request${P.riot.requests === 1 ? '' : 's'} this session${P.riot.rateLimited ? `, ${P.riot.rateLimited} rate-limited` : ''}${P.riot.waiting ? ` · ${P.riot.waiting} waiting` : ''}`, '');
            const og = P.opgg.blockedUntil ? `<span class="diag-warn">backing off ${until(P.opgg.blockedUntil)}</span>${P.opgg.error ? ` <span class="diag-m">(${esc(P.opgg.error)})</span>` : ''}`
                : P.opgg.actionFailedUntil ? `<span class="diag-warn">champion stats off ${until(P.opgg.actionFailedUntil)}</span>` : P.opgg.playersBackingOff ? `<span class="diag-m">${P.opgg.playersBackingOff} player page(s) backing off</span>` : '<span class="diag-ok">ok</span>';
            h += row('op.gg', 'past seasons, live champion stats', og, P.opgg.blockedUntil || P.opgg.actionFailedUntil || P.opgg.playersBackingOff ? clear('opgg-backoff', 'Retry now') : '');
            h += row('League client', P.lcu.up ? '<span class="diag-ok">connected</span>' : '<span class="diag-m">not detected</span>', P.lcu.phase ? esc(P.lcu.phase) : '', '');
        } else h += row('Riot API / op.gg / client', '<span class="diag-m">unavailable</span>', esc(d.prof && d.prof.error || ''), '');
        if (M.coachless) h += row('Coachless', M.coachless.blockedUntil ? `<span class="diag-warn">rate-limited ${until(M.coachless.blockedUntil)}</span>` : '<span class="diag-ok">ok</span>', M.coachless.running ? 'download running' : '', '');
        h += '</tbody></table>';
        h += `<div class="settings-row"><button data-diag="refresh">Refresh</button><button data-diag="export" title="A text file with versions, sizes, limits and recent log lines (no keys). Saved to your Downloads folder.">Save a diagnostics report</button>
            <button data-diag="champ-snapshot" title="During champion select (ARAM Mayhem too): copies what the client reports (your champion, the bench, rerolls) as text. Summoner names, Riot IDs and puuids are removed.">Copy champion select snapshot</button></div>
            <div class="settings-msg diag-msg" aria-live="polite">${esc(msg)}</div>`;
        if (M.app && M.app.version) h += `<div class="diag-m">DravenGap ${esc(M.app.version)} · Electron ${esc(M.app.electron || '')}</div>`;
        panel.innerHTML = h;
    }

    async function refresh() {
        if (busy || panel.hidden) return;
        busy = true;
        try { render(await collect()); } finally { busy = false; }
    }
    function setOpen(on) {
        panel.hidden = !on;
        btn.textContent = on ? 'Hide diagnostics' : 'Show diagnostics';
        btn.setAttribute('aria-expanded', String(on));
        clearInterval(timer); timer = null;
        if (on) { panel.innerHTML = '<div class="diag-m">Reading…</div>'; refresh(); timer = setInterval(() => { if (document.getElementById('settings-modal').style.display === 'none') setOpen(false); else refresh(); }, 2000); }
    }
    btn.addEventListener('click', () => setOpen(panel.hidden));

    panel.addEventListener('click', async e => {
        const b = e.target.closest('[data-diag]');
        if (!b) return;
        const act = b.dataset.diag;
        if (act === 'refresh') { msg = ''; refresh(); return; }
        if (act === 'saved') { if (DD.openSavedData) DD.openSavedData(); return; }
        if (act === 'clear') {
            const what = b.dataset.what;
            const label = { 'profile-lookups': 'the Profile look-up cache (accounts, ranks, mastery, op.gg pages; downloaded matches are kept)', aram: 'the ARAM Mayhem cache', arena: 'the Arena cache', 'coachless-resume': 'the unfinished Builds download state', 'opgg-backoff': null }[what];
            if (label && !confirm(`Delete ${label}? It is downloaded again when needed.`)) return;
            b.disabled = true;
            const r = what === 'aram' ? await call('aram:cache-clear')
                : what === 'arena' ? await call('arena:cache-clear')
                : what === 'coachless-resume' ? await call('diag:clear', { id: 'coachless-resume' })
                : await call('profile:cache-clear', { what: what === 'profile-lookups' ? 'lookups' : what });
            msg = r && r.ok ? (what === 'opgg-backoff' ? 'op.gg will be asked again on the next look-up.' : `Cleared (${r.removed || 0} entr${r.removed === 1 ? 'y' : 'ies'}).`) : `Could not clear: ${(r && r.error) || 'unknown error'}`;
            refresh();
            return;
        }
        if (act === 'champ-snapshot') {
            b.disabled = true; msg = 'Reading champion select…'; panel.querySelector('.diag-msg').textContent = msg;
            const r = await call('aram:champ-snapshot');
            if (!r || !r.ok) msg = `No snapshot: ${(r && r.error) || 'unknown error'}`;
            else {
                let copied = !!r.copied;
                if (!copied) { try { await navigator.clipboard.writeText(r.text); copied = true; } catch (err) { /* no clipboard access */ } }
                msg = copied ? `Copied the champion select snapshot (${r.lines} lines, names and IDs removed). Paste it where it is needed.` : 'The snapshot could not be copied to the clipboard.';
            }
            b.disabled = false;
            refresh();
            return;
        }
        if (act === 'export') {
            b.disabled = true; msg = 'Writing the report…'; panel.querySelector('.diag-msg').textContent = msg;
            let local = null;
            try { local = await DD.diagnosticsLocal(); } catch (err) { /* the main process part is still useful */ }
            const r = await call('diag:export', { renderer: local ? { draft: local.draft, builds: local.builds, ddragon: local.ddragon, storage: local.storage, view: DD.currentView() } : { view: DD.currentView() } });
            msg = r && r.ok ? `Saved: ${r.file}` : `Could not save the report: ${(r && r.error) || 'unknown error'}`;
            b.disabled = false;
            refresh();
        }
    });
    DD.diagnostics = { open: () => setOpen(true), refresh };
})();
