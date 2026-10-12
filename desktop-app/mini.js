// desktop-app/mini.js
// Renderer of the mini window (mini.html): draws the rows the main window sends (window.mini from mini-preload.js).
// Summoner's Rift rows: champion, Exp WR with its 95% bar, PP. ARAM Mayhem rows: champion, tier, Mayhem WR, vs average.
(function () {
    'use strict';
    const $ = id => document.getElementById(id);
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ppClass = p => (p == null ? '' : p >= 0.9 ? 'pp-high' : p >= 0.5 ? 'pp-mid' : 'pp-low');
    const pct = (v, d = 1) => (v == null ? '–' : (v * 100).toFixed(d) + '%');
    let last = null;

    function bar(wr, sd, p50) {
        if (wr == null || sd == null) return '';
        const x = v => Math.min(100, Math.max(0, (v - 0.4) / 0.2 * 100));
        const lo = x(wr - 1.96 * sd), hi = x(wr + 1.96 * sd);
        return `<span class="bar2 ${ppClass(p50)}"><b></b><i style="left:${lo.toFixed(1)}%;width:${Math.max(2, hi - lo).toFixed(1)}%"></i></span>`;
    }
    function render(d) {
        last = d;
        document.body.classList.toggle('aram', d.mode === 'aram');
        $('title').textContent = d.title || 'DravenGap';
        $('sub').textContent = d.sub || '';
        $('advice').innerHTML = d.advice ? `<div class="advice ${esc(d.advice.cls || '')}">${esc(d.advice.text)}</div>` : '';
        const rows = Array.isArray(d.rows) ? d.rows : [];
        if (d.mode === 'plan') {   // after lock-in: the game plan as label / value lines
            $('head').innerHTML = '';
            $('list').innerHTML = (d.lines || []).map(l => `<div class="kv"><span>${esc(l.label)}</span><b class="${esc(l.cls || '')}">${esc(l.value)}</b>${l.sub ? `<em>${esc(l.sub)}</em>` : ''}</div>`).join('') || '<div class="empty">No plan yet.</div>';
            stamp();
            return;
        }
        if (!rows.length) {
            $('head').innerHTML = '';
            $('list').innerHTML = `<div class="empty">${esc(d.empty || 'Nothing to show yet.')}</div>`;
        } else if (d.mode === 'aram') {
            $('head').innerHTML = '<span></span><span>Champion</span><span>Tier</span><span>Mayhem WR</span><span>vs avg</span>';
            $('list').innerHTML = rows.map(r => `<div class="row" data-id="${esc(r.id)}" title="${esc(r.name)}"><img src="${esc(r.img)}" alt="">
                <span class="name">${esc(r.name)}${r.src ? `<span class="src ${esc(r.src)}">${esc(r.src)}</span>` : ''}</span>
                <span class="tier">${esc(r.tier || '')}</span><span class="num">${r.wr == null ? '–' : r.wr.toFixed(2) + '%'}</span>
                <span class="num ${r.delta > 0.05 ? 'pos' : r.delta < -0.05 ? 'neg' : ''}">${r.delta == null ? '' : (r.delta >= 0 ? '+' : '') + r.delta.toFixed(1)}</span></div>`).join('');
        } else {
            $('head').innerHTML = '<span></span><span>Champion</span><span>Exp WR</span><span>PP</span>';
            $('list').innerHTML = rows.map(r => `<div class="row" data-id="${esc(r.id)}" title="${esc(r.tip || r.name)}"><img src="${esc(r.img)}" alt="">
                <span class="name">${esc(r.name)}${r.flag ? '<span class="flag" title="Likely counters in this lane">⚠</span>' : ''}${r.trend ? `<small class="${r.trend === 'up' ? 'pos' : 'neg'}">${r.trend === 'up' ? '▲' : '▼'}</small>` : ''}</span>
                <span class="num wr"><span class="${r.wr >= 0.5 ? 'pos' : 'neg'}">${pct(r.wr)}</span>${bar(r.wr, r.sd, r.p50)}</span>
                <span class="num ${ppClass(r.pp)}">${r.pp == null ? '–' : r.pp > 0.999 ? '>99%' : pct(r.pp, 0)}</span></div>`).join('');
        }
        stamp();
    }
    function stamp() {
        if (!last || !last.at) { $('when').textContent = ''; return; }
        const s = Math.round((Date.now() - last.at) / 1000);
        $('when').textContent = s < 5 ? 'live' : s < 120 ? `updated ${s} s ago` : `updated ${Math.round(s / 60)} min ago`;
    }
    setInterval(stamp, 5000);

    $('close').addEventListener('click', () => window.mini.close());
    $('main').addEventListener('click', () => window.mini.focusMain());
    $('list').addEventListener('click', e => { const r = e.target.closest('.row'); if (r) window.mini.pick(r.dataset.id, last && last.mode); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') window.mini.close(); });
    window.mini.onData(render);
    window.mini.ready();
})();
