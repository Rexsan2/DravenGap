// desktop-app/ui-states.js
// Shared loading / empty / error states (FEATURES3 B5) and Settings > Appearance: density and UI scale (E3). Styles: ui-states.css.
//
// For every view (each returns an HTML string; put it in innerHTML):
//   DD.ui.loading(text?, { rows? })           spinner + text (rows: n adds n placeholder bars)
//   DD.ui.empty(title, hint?, action?)        centred "nothing here" message. action = { label, act } or { label, onClick }
//   DD.ui.error(err, opts?)                   err = string | Error | an IPC result { code, error, retryAt }
//        opts: { retryAt (ms epoch), onRetry (fn), autoRetry (call onRetry when the countdown ends), stale (the data shown is a saved
//               copy: renders a slim banner instead of a block), when ("2 h ago", for the stale banner), compact, title, action }
//        RATE_LIMITED / a future retryAt -> "Waiting for the rate limit. Resumes in 1:12." (the number counts down live)
//        OFFLINE or stale                -> "Source unavailable, showing saved data."
//        NO_KEY / KEY_REJECTED           -> the message plus an "Open Settings" button
// Built-in actions (data-ui-act): 'settings', 'saved-data', 'setup', 'view:<name>'. Any other act name fires a bubbling
// "dg-ui-act" CustomEvent ({ detail: { act } }) from the button, so a view can listen on its own root. A function given as
// onClick / onRetry is kept in a small registry (the last 40) and called by one document-level click handler, so views do not need
// their own listener for it; call the helper again on every repaint.
//
// Appearance (Settings): Density "Comfortable" / "Compact" (settings key density; class density-compact on <body> and <html>) and
// UI scale 90-125% (key uiScale, a percent; applied with Electron's webFrame zoom through electronAPI.setUiScale, else CSS zoom).
// A copy is kept in localStorage ('dg-ui') so the small script in index.html's <head> can apply both before the first paint.
//   DD.ui.setDensity('compact'|'comfortable'), DD.ui.setScale(percent), DD.ui.appearance() -> { density, scale }
(function () {
    'use strict';
    const DD = window.DD, api = window.electronAPI;
    if (!DD) return;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // ------------------------------------------------------------------ click registry
    const reg = new Map();
    let regSeq = 0;
    function keep(fn) {
        const id = 'f' + (++regSeq);
        reg.set(id, fn);
        while (reg.size > 40) reg.delete(reg.keys().next().value);
        return id;
    }
    function actionHtml(a, cls = '') {
        if (!a || !a.label) return '';
        const c = `dg-state-btn${cls ? ' ' + cls : ''}`;
        if (typeof a.onClick === 'function') return `<button type="button" class="${c}" data-ui-fn="${keep(a.onClick)}">${esc(a.label)}</button>`;
        return `<button type="button" class="${c}" data-ui-act="${esc(a.act || '')}">${esc(a.label)}</button>`;
    }
    document.addEventListener('click', e => {
        const b = e.target.closest && e.target.closest('[data-ui-fn],[data-ui-act]');
        if (!b) return;
        if (b.dataset.uiFn) { const fn = reg.get(b.dataset.uiFn); if (fn) { try { fn(e); } catch (err) { console.error(err); } } return; }
        const act = b.dataset.uiAct || '';
        if (act === 'settings') { const s = document.getElementById('settings-btn'); if (s) s.click(); }
        else if (act === 'saved-data') { if (DD.openSavedData) DD.openSavedData(); }
        else if (act === 'setup') { if (DD.onboarding) DD.onboarding.open(); }
        else if (act.startsWith('view:')) DD.showView(act.slice(5));
        else b.dispatchEvent(new CustomEvent('dg-ui-act', { bubbles: true, detail: { act } }));
    });

    // ------------------------------------------------------------------ countdown ("resumes in 1:12")
    const fmtCount = ms => {
        const s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
        return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
    };
    let ticker = null;
    function tick() {
        const els = document.querySelectorAll('.dg-count');
        if (!els.length) { clearInterval(ticker); ticker = null; return; }
        const now = Date.now();
        for (const el of els) {
            const left = Number(el.dataset.until) - now;
            if (left > 0) { el.textContent = fmtCount(left); continue; }
            el.textContent = 'now';
            const box = el.closest('.dg-err');
            if (box) box.classList.add('ready');
            if (el.dataset.auto) {   // run the retry once
                const fn = reg.get(el.dataset.auto);
                delete el.dataset.auto;
                if (fn) { try { fn(); } catch (err) { console.error(err); } }
            }
        }
    }
    function startTicker() { if (!ticker) ticker = setInterval(tick, 1000); }

    // ------------------------------------------------------------------ the three states
    const ICON = {
        empty: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/></svg>',
        warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20z"/><path d="M12 10v5M12 18v.01"/></svg>',
        clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
    };

    function loading(text, opts = {}) {
        const rows = Math.max(0, Math.min(12, opts.rows | 0));
        return `<div class="dg-state dg-loading" role="status" aria-live="polite"><span class="dg-spin" aria-hidden="true"></span><span>${esc(text || 'Loading…')}</span></div>`
            + (rows ? `<div class="dg-skel" aria-hidden="true">${Array.from({ length: rows }, (_, i) => `<i style="width:${96 - (i * 7) % 28}%"></i>`).join('')}</div>` : '');
    }

    function empty(title, hint, action) {
        return `<div class="dg-state dg-empty"><div class="dg-state-ico">${ICON.empty}</div><div class="dg-state-t">${esc(title)}</div>`
            + `${hint ? `<div class="dg-state-h">${esc(hint)}</div>` : ''}${action ? `<div class="dg-state-a">${actionHtml(action)}</div>` : ''}</div>`;
    }

    function norm(err) {
        if (err == null) return { code: '', msg: '', retryAt: null };
        if (typeof err === 'string') return { code: '', msg: err, retryAt: null };
        return { code: err.code || '', msg: err.error || err.message || '', retryAt: err.retryAt || null };
    }

    function error(err, opts = {}) {
        const n = norm(err), now = Date.now();
        const retryAt = opts.retryAt || n.retryAt || 0;
        const cls = `dg-state dg-err${opts.compact ? ' compact' : ''}`;
        const retryId = typeof opts.onRetry === 'function' ? keep(opts.onRetry) : null;
        const rate = n.code === 'RATE_LIMITED' || retryAt > now;
        const offline = n.code === 'OFFLINE' || opts.stale === true;

        // saved data is still on screen: a slim banner (put it above the content)
        if (opts.stale) {
            const why = rate && retryAt > now ? ` Resumes in <span class="dg-count" data-until="${retryAt}">${fmtCount(retryAt - now)}</span>.` : '';
            if (why) startTicker();
            return `<div class="dg-note warn" role="status"><span>Source unavailable, showing saved data${opts.when ? ` (${esc(opts.when)})` : ''}.${why}</span>`
                + `${retryId ? `<button type="button" class="dg-state-btn" data-ui-fn="${retryId}">Try again</button>` : ''}</div>`;
        }
        let ico = ICON.warn, title, body = '', bodyHtml = false, action = opts.action || null, kind = 'bad';
        if (rate) {
            ico = ICON.clock; kind = 'warn';
            title = opts.title || 'Waiting for the rate limit';
            if (retryAt > now) {
                const auto = opts.autoRetry && retryId ? ` data-auto="${retryId}"` : '';
                body = `Too many requests were sent, so the source asked us to slow down. Resumes in <span class="dg-count" data-until="${retryAt}"${auto}>${fmtCount(retryAt - now)}</span>.`;
                bodyHtml = true;
                startTicker();
            } else body = 'Too many requests were sent. Try again in a moment.';
        } else if (offline) {
            kind = 'warn';
            title = opts.title || 'Source unavailable';
            body = n.msg || 'The data source could not be reached. Check your connection.';
        } else if (n.code === 'NO_KEY' || n.code === 'KEY_REJECTED') {
            title = opts.title || (n.code === 'NO_KEY' ? 'A Riot API key is needed' : 'Riot rejected the API key');
            body = n.msg || '';
            if (!action) action = { label: 'Open Settings', act: 'settings' };
        } else if (n.code === 'NOT_FOUND') {
            kind = 'warn'; title = opts.title || 'Not found'; body = n.msg && n.msg !== 'Not found.' ? n.msg : 'Check the spelling and the region.';
        } else {
            title = opts.title || 'Something went wrong';
            body = n.msg || 'Try again in a moment.';
        }
        const retry = retryId ? `<button type="button" class="dg-state-btn" data-ui-fn="${retryId}">${rate && retryAt > now ? 'Try now' : 'Try again'}</button>` : '';
        return `<div class="${cls} ${kind}" role="alert"><div class="dg-state-ico">${ico}</div><div class="dg-state-t">${esc(title)}</div>`
            + `${body ? `<div class="dg-state-h">${bodyHtml ? body : esc(body)}</div>` : ''}`
            + `${retry || action ? `<div class="dg-state-a">${retry}${action ? actionHtml(action) : ''}</div>` : ''}</div>`;
    }

    // ------------------------------------------------------------------ density and UI scale
    const A = { density: 'comfortable', scale: 100 };
    const clampScale = v => {
        let n = Number(v);
        if (!isFinite(n) || n <= 0) return 100;
        if (n <= 3) n *= 100;                       // a factor such as 1.1
        return Math.min(125, Math.max(90, Math.round(n / 5) * 5));
    };
    function mirror() { try { localStorage.setItem('dg-ui', JSON.stringify({ density: A.density, scale: A.scale })); } catch (e) { /* storage unavailable */ } }
    function paintControls() {
        const d = document.getElementById('density-select'), r = document.getElementById('ui-scale-range'), l = document.getElementById('ui-scale-label');
        if (d) d.value = A.density;
        if (r) r.value = String(A.scale);
        if (l) l.textContent = A.scale + '%';
    }
    function applyDensity(value) {
        A.density = value === 'compact' ? 'compact' : 'comfortable';
        const on = A.density === 'compact';
        document.documentElement.classList.toggle('density-compact', on);
        document.body.classList.toggle('density-compact', on);
        mirror(); paintControls();
        return A.density;
    }
    function applyScale(value) {
        A.scale = clampScale(value);
        const f = A.scale / 100;
        if (api && typeof api.setUiScale === 'function') { api.setUiScale(f); document.documentElement.style.zoom = ''; }
        else document.documentElement.style.zoom = f === 1 ? '' : String(f);    // no preload hook: CSS zoom on the page root
        mirror(); paintControls();
        return A.scale;
    }
    const save = patch => (DD.patchSettings ? DD.patchSettings(patch).catch(() => {}) : Promise.resolve());

    document.addEventListener('change', e => {
        if (e.target.id === 'density-select') { applyDensity(e.target.value); save({ density: A.density }); }
        else if (e.target.id === 'ui-scale-range') { applyScale(e.target.value); save({ uiScale: A.scale }); }
    });
    document.addEventListener('input', e => {
        if (e.target.id === 'ui-scale-range') { const l = document.getElementById('ui-scale-label'); if (l) l.textContent = e.target.value + '%'; }   // label only; applied on release
    });
    document.addEventListener('click', e => {
        if (e.target.id === 'ui-scale-reset-btn') { applyScale(100); applyDensity('comfortable'); save({ uiScale: 100, density: 'comfortable' }); }
    });

    // apply what the head script already applied from localStorage again from the authoritative copy (settings.json)
    applyDensity(document.documentElement.classList.contains('density-compact') ? 'compact' : 'comfortable');
    const applied = (() => { try { return JSON.parse(localStorage.getItem('dg-ui') || '{}'); } catch (e) { return {}; } })();
    A.scale = clampScale(applied.scale || 100);
    paintControls();
    if (api && api.getSettings) {
        api.getSettings().then(s => {
            s = s || {};
            applyDensity(s.density);
            applyScale(s.uiScale || 100);
        }).catch(() => {});
    }

    DD.ui = { loading, empty, error, setDensity: v => { applyDensity(v); return save({ density: A.density }); }, setScale: v => { applyScale(v); return save({ uiScale: A.scale }); }, appearance: () => ({ ...A }), fmtCount };
})();
