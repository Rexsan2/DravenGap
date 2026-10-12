// desktop-app/skills-view.js
// Skill order line for Builds and the game plan: DD.skillOrder.slot(champion, role, { compact }) returns
// HTML: the line itself when the data is known, else a placeholder that fills in when skills-main.js answers (build:skills, one
// LoLalytics page per champion and lane, on demand, cached 6 h). The most played order is shown, with its games: LoLalytics measures
// full orders at level 15, where only games that last that long count, so their win rates are flattered and are not used to rank.
// The same page gives the champion's win rate by game length: DD.skillOrder.slot(champion, role, { kind: 'length' }) (champion pages).
(function () {
    'use strict';
    const DD = window.DD, api = window.electronAPI && window.electronAPI.feature;
    if (!DD || !api) return;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const known = new Map(), pending = new Map();   // "Champion|ROLE" -> build:skills answer / promise
    const keyOf = (c, r) => `${c}|${r}`;
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
    // Win rate by game length: a bar per LoLalytics bucket (under 15 ... 40+ minutes) around 50%, and one
    // sentence when long or short games differ by 1.5+ points (each side has thousands of games, so that is beyond noise).
    function lengthHtml(r) {
        const L = r && r.ok && r.data && r.data.length;
        if (!L) return `<div class="sk-len sk-muted">Win rate by game length: ${r && !r.ok ? esc(String(r.error || '').replace(/^Error invoking remote method '[^']*': (Error: )?/, '')) : 'no data'}.</div>`;
        const tot = L.reduce((t, b) => t + b.games, 0) || 1;
        const span = b => { const g = L.filter(x => b(x.label) && x.games); const n = g.reduce((t, x) => t + x.games, 0); return n ? { n, wr: g.reduce((t, x) => t + x.wr * x.games, 0) / n } : null; };
        const early = span(l => ['<15', '15-20', '20-25'].includes(l)), late = span(l => ['35-40', '40+'].includes(l));
        const diff = early && late ? late.wr - early.wr : 0;
        const verdict = early && late && Math.abs(diff) >= 1.5 && early.n >= 1000 && late.n >= 1000
            ? `${diff > 0 ? 'Stronger the longer the game goes' : 'Stronger in short games'}: ${late.wr.toFixed(1)}% after 35 minutes against ${early.wr.toFixed(1)}% before 25.`
            : 'No clear difference between short and long games.';
        const bars = L.map(b => {
            const h = b.wr == null ? 0 : Math.max(3, Math.min(60, 30 + (b.wr - 50) * 4));   // 50% = half height, +-7.5 pts = full / empty
            const few = b.games < tot * 0.02;
            return `<div class="sk-lb${few ? ' few' : ''}" title="${esc(b.label)} min: ${b.wr == null ? 'no games' : b.wr.toFixed(1) + '% in ' + fmt(b.games) + ' games'}"><span>${b.wr == null ? '–' : b.wr.toFixed(1)}</span><i class="${b.wr >= 50 ? 'w' : 'l'}" style="height:${h}px"></i><b>${esc(b.label)}</b></div>`;
        }).join('');
        return `<div class="sk-len"><div class="sk-lbars">${bars}</div><div class="sk-m">${esc(verdict)} Minutes; LoLalytics Emerald+, ${fmt(tot)} games. Faint bars: under 2% of games.</div></div>`;
    }
    function fill(k) { for (const el of document.querySelectorAll(`[data-sk="${k}"]`)) el.outerHTML = el.dataset.skKind === 'length' ? lengthHtml(known.get(k)) : lineHtml(known.get(k), { compact: el.dataset.skCompact === '1' }); }
    function load(champion, role) {
        const k = keyOf(champion, role);
        if (known.has(k) || pending.has(k)) return pending.get(k) || Promise.resolve(known.get(k));
        const p = api.invoke('build:skills', { champion, role }).catch(e => ({ ok: false, error: e.message }))
            .then(r => { known.set(k, r); pending.delete(k); fill(k); return r; });
        pending.set(k, p);
        return p;
    }
    function slot(champion, role, opts = {}) {
        if (!champion || !role) return '';
        const k = keyOf(champion, role);
        if (known.has(k)) return opts.kind === 'length' ? lengthHtml(known.get(k)) : lineHtml(known.get(k), opts);
        load(champion, role);
        if (opts.kind === 'length') return `<div class="sk-len sk-muted" data-sk="${esc(k)}" data-sk-kind="length">Reading the win rate by game length…</div>`;
        return `<div class="sk-row sk-muted" data-sk="${esc(k)}"${opts.compact ? ' data-sk-compact="1"' : ''}>Skills: reading the most played order…</div>`;
    }
    api.on('build:skills-updated', ev => {   // a background refresh replaced a stale copy: read it again next time
        const m = /^skills-([a-z0-9]+)-([a-z]+)$/.exec((ev && ev.key) || '');
        if (m) for (const k of [...known.keys()]) if (k.toLowerCase().startsWith(m[1] + '|')) known.delete(k);
    });
    DD.skillOrder = { slot, load, lineHtml, lengthHtml, known };
})();
