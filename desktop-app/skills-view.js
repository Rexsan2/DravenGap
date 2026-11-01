// desktop-app/skills-view.js
// Skill order line for Builds and the game plan: DD.skillOrder.slot(champion, role, { compact }) returns
// HTML: the line itself when the data is known, else a placeholder that fills in when skills-main.js answers (build:skills, one
// LoLalytics page per champion and lane, on demand, cached 6 h). The most played order is shown, with its games: LoLalytics measures
// full orders at level 15, where only games that last that long count, so their win rates are flattered and are not used to rank.
// The same page gives the champion's win rate by game length: DD.skillOrder.slot(champion, role, { kind: 'length' }) (champion pages).
// That card follows the Time Period and Rank (DD.lolalyticsPeriod): one LoLalytics page per patch of the period, games and wins added up.
(function () {
    'use strict';
    const DD = window.DD, api = window.electronAPI && window.electronAPI.feature;
    if (!DD || !api) return;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const known = new Map(), pending = new Map();   // "Champion|ROLE" -> build:skills answer / promise
    const keyOf = (c, r) => `${c}|${r}`;
    // A failed answer (offline, 429, timeout, main's 60 s per-URL back-off) and a pooled length card with a page missing are kept with
    // the time they failed: shown as they are, then asked for again on a view after retryMs. Good answers are kept for the session, and
    // so are failures that can't change by asking again (a bad request, a page layout the parser no longer reads).
    const S = { retryMs: 60000 };
    const remember = (k, r, partial) => { known.set(k, r && ((r.ok && !partial) || r.code === 'BAD_REQUEST' || r.code === 'PARSE') ? r : Object.assign({}, r, { _failedAt: Date.now() })); };
    const usable = k => known.has(k) && !(known.get(k)._failedAt && Date.now() - known.get(k)._failedAt >= S.retryMs);
    const fmt = n => Math.round(n).toLocaleString('en-US');

    function lineHtml(r, opts = {}) {
        if (!r || !r.ok) return `<div class="sk-row sk-muted">Skill order: ${esc(String((r && r.error) || 'not available').replace(/^Error invoking remote method '[^']*': (Error: )?/, ''))}</div>`;
        const d = r.data, pr = d.priority && d.priority.pick, ord = d.order && d.order.pick;
        if (!pr && !ord) return '<div class="sk-row sk-muted">Skill order: no data for this lane.</div>';
        const boxes = ord ? `<span class="sk-seq" title="The first 15 level-ups, most played order (${fmt(ord.games)} games)">${ord.seq.map((s, i) => `<i class="sk-${s.toLowerCase()}" title="Level ${i + 1}: ${s}">${s}</i>`).join('')}</span>` : '';
        const share = pr && d.games ? ` · ${Math.round(pr.games / d.games * 100)}% of ${fmt(d.games)} games` : pr ? ` · ${fmt(pr.games)} games` : '';
        const tip = 'Max order (skill priority) as most players level it, from LoLalytics, Emerald+. Win rates of full skill orders are measured at level 15, so they are left out.';
        return `<div class="sk-row${opts.compact ? ' compact' : ''}" title="${esc(tip)}"><span class="sk-lbl">Skills</span>${pr ? `<b class="sk-prio">${pr.order.join(' &gt; ')}</b>` : ''}${boxes}<span class="sk-m">most played${share} · LoLalytics Emerald+</span></div>`;
    }
    // 95% range of a win rate (Wilson score interval, sane for small samples too), in points: [lo, hi]
    function wilson(wr, n) {
        if (!n || wr == null) return null;
        const p = wr / 100, z = 1.96, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
        return [Math.max(0, c - h) * 100, Math.min(1, c + h) * 100];
    }
    // Win rate by game length: a bar per LoLalytics bucket (under 15 ... 40+ minutes) around 50% with a whisker for its 95% range,
    // and one sentence when long and short games differ by 1.5+ points and by more than twice the noise of that difference.
    function lengthHtml(r) {
        const L = r && r.ok && r.data && r.data.length, src = (r && r.src) || 'LoLalytics Emerald+';
        if (!L) return `<div class="sk-len sk-muted">Win rate by game length: ${r && !r.ok ? esc(String(r.error || '').replace(/^Error invoking remote method '[^']*': (Error: )?/, '')) : 'no data'}.</div>`;
        const tot = L.reduce((t, b) => t + b.games, 0) || 1;
        const span = b => { const g = L.filter(x => b(x.label) && x.games); const n = g.reduce((t, x) => t + x.games, 0); return n ? { n, wr: g.reduce((t, x) => t + x.wr * x.games, 0) / n } : null; };
        const early = span(l => ['<15', '15-20', '20-25'].includes(l)), late = span(l => ['35-40', '40+'].includes(l));
        const diff = early && late ? late.wr - early.wr : 0;
        const seDiff = early && late ? Math.sqrt(early.wr * (100 - early.wr) / early.n + late.wr * (100 - late.wr) / late.n) : Infinity;
        const verdict = early && late && Math.abs(diff) >= 1.5 && Math.abs(diff) > 1.96 * seDiff
            ? `${diff > 0 ? 'Stronger the longer the game goes' : 'Stronger in short games'}: ${late.wr.toFixed(1)}% after 35 minutes against ${early.wr.toFixed(1)}% before 25.`
            : 'No clear difference between short and long games.';
        const ht = wr => Math.max(3, Math.min(60, 30 + (wr - 50) * 4));   // 50% = half height, +-7.5 pts = full / empty
        const bars = L.map(b => {
            const h = b.wr == null ? 0 : ht(b.wr), ci = wilson(b.wr, b.games);
            const few = b.games < tot * 0.02;
            const whisker = ci ? `<em class="sk-ci" style="bottom:${ht(ci[0]).toFixed(1)}px;height:${Math.max(1, ht(ci[1]) - ht(ci[0])).toFixed(1)}px"></em>` : '';
            const above = ci ? Math.max(0, ht(ci[1]) - h) : 0;   // keep the value label clear of the whisker
            const tip = b.wr == null ? 'no games' : `${b.wr.toFixed(1)}% in ${fmt(b.games)} games${ci ? ` (95% range ${ci[0].toFixed(1)}–${ci[1].toFixed(1)}%)` : ''}`;
            return `<div class="sk-lb${few ? ' few' : ''}" title="${esc(b.label)} min: ${esc(tip)}"><span style="margin-bottom:${above.toFixed(1)}px">${b.wr == null ? '–' : b.wr.toFixed(1)}</span><i class="${b.wr >= 50 ? 'w' : 'l'}" style="height:${h}px">${whisker}</i><b>${esc(b.label)}</b></div>`;
        }).join('');
        return `<div class="sk-len"><div class="sk-lbars">${bars}</div><div class="sk-m">${esc(verdict)} Minutes; ${esc(src)}, ${fmt(tot)} games. Whiskers: 95% range. Faint bars: under 2% of games.</div></div>`;
    }
    // Win rate by game length for the selected Time Period / Rank: each page of the period (a patch, or a LoLalytics day window),
    // pooled by adding games and wins per bucket. Adaptive is pooled plainly here (no drift weighting: these are game lengths, not
    // a champion's strength). Pages that fail are left out and named; all failing is an error.
    function lengthSel() {
        const P = DD.lolalyticsPeriod ? DD.lolalyticsPeriod() : { pages: [''], label: 'Current Patch', rank: 'emerald_plus', rankLabel: 'Emerald+' };
        return { ...P, key: `len|${P.rank}|${P.pages.join(',')}` };
    }
    function loadLength(champion, role, P, k) {
        if (usable(k) || pending.has(k)) return pending.get(k) || Promise.resolve(known.get(k));
        const p = Promise.all(P.pages.map(pg => api.invoke('build:skills', { champion, role, tier: P.rank, ...(pg ? { patch: pg } : {}) }).catch(e => ({ ok: false, error: e.message }))))
            .then(rs => {
                const got = rs.filter(r => r && r.ok && r.data && r.data.length), missing = P.pages.filter((pg, i) => !got.includes(rs[i]));
                if (!got.length) return rs.find(r => r && !r.ok) || { ok: false, error: 'no data' };
                const length = got[0].data.length.map(b => {
                    const n = got.reduce((t, r) => t + ((r.data.length.find(x => x.label === b.label) || {}).games || 0), 0);
                    const w = got.reduce((t, r) => { const x = r.data.length.find(y => y.label === b.label); return t + (x && x.wr != null ? x.wr * x.games / 100 : 0); }, 0);
                    return { label: b.label, games: n, wr: n ? w / n * 100 : null };
                });
                const what = P.label + (P.adaptive ? ' (its patches pooled)' : '') + (missing.length ? ` · ${missing.join(', ')} not available` : '');
                return { ok: true, data: { length }, src: `LoLalytics ${P.rankLabel}, ${what}`, partial: missing.length > 0 };
            })
            .then(r => { remember(k, r, r && r.partial); pending.delete(k); fill(k); return r; });
        pending.set(k, p);
        return p;
    }
    function fill(k) { for (const el of document.querySelectorAll(`[data-sk="${k}"]`)) el.outerHTML = el.dataset.skKind === 'length' ? lengthHtml(known.get(k)) : lineHtml(known.get(k), { compact: el.dataset.skCompact === '1' }); }
    function load(champion, role) {
        const k = keyOf(champion, role);
        if (usable(k) || pending.has(k)) return pending.get(k) || Promise.resolve(known.get(k));
        const p = api.invoke('build:skills', { champion, role }).catch(e => ({ ok: false, error: e.message }))
            .then(r => { remember(k, r); pending.delete(k); fill(k); return r; });
        pending.set(k, p);
        return p;
    }
    function slot(champion, role, opts = {}) {
        if (!champion || !role) return '';
        if (opts.kind === 'length') {
            const P = lengthSel(), k = `${keyOf(champion, role)}|${P.key}`;
            if (usable(k)) return lengthHtml(known.get(k));
            loadLength(champion, role, P, k);
            return `<div class="sk-len sk-muted" data-sk="${esc(k)}" data-sk-kind="length">Reading the win rate by game length (${esc(P.label)}, ${esc(P.rankLabel)})…</div>`;
        }
        const k = keyOf(champion, role);
        if (usable(k)) return lineHtml(known.get(k), opts);
        load(champion, role);
        return `<div class="sk-row sk-muted" data-sk="${esc(k)}"${opts.compact ? ' data-sk-compact="1"' : ''}>Skills: reading the most played order…</div>`;
    }
    api.on('build:skills-updated', ev => {   // a background refresh replaced a stale copy: read it again next time
        const m = /^skills-([a-z0-9]+)-([a-z]+)(-|$)/.exec((ev && ev.key) || '');
        if (m) for (const k of [...known.keys()]) if (k.toLowerCase().startsWith(m[1] + '|')) known.delete(k);
    });
    DD.skillOrder = { slot, load, lineHtml, lengthHtml, known, retry: S };   // retry.retryMs: settable for tests
})();
