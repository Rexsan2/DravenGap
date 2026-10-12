// desktop-app/aram-view.js
// Renderer side of the ARAM Mayhem mode; renders into #aram-root only.
// Data comes from aram-main.js over window.electronAPI.feature ('aram:*'). Champ select is polled only while the view is visible.
(function () {
    'use strict';
    const root = document.getElementById('aram-root');
    if (!root || !window.DD || !window.electronAPI || !window.electronAPI.feature) return;
    const api = window.electronAPI.feature;
    const DD = window.DD;

    const ALIASES = { wukong: 'monkeyking', nunuwillump: 'nunu', renataglasc: 'renata', nunuandwillump: 'nunu' };
    const norm = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmt1 = n => (n == null ? '-' : (Math.round(n * 10) / 10).toFixed(1));
    const fmt2 = n => (n == null ? '-' : (Math.round(n * 100) / 100).toFixed(2));
    const fmtInt = n => (n == null ? '-' : Number(n).toLocaleString('en-US'));
    const signed = n => (n == null ? '' : (n >= 0 ? '+' : '') + fmt1(n));
    const deltaCls = n => (n == null ? '' : n > 0.05 ? 'pos' : n < -0.05 ? 'neg' : 'flat');
    const LOW_APPEARANCE = 2;   // augment rows below this appearance rate (%) are dimmed

    const S = {
        ready: false, active: false, tier: null, tierErr: null, ddByNorm: new Map(), ddById: new Map(), bySlug: new Map(),
        cs: null, csSig: '', autoMine: 0, manual: new Map(), selected: null, view: 'auto', search: '', rarity: 'prismatic',
        build: {}, items: {}, itemMeta: null, spellMeta: null, timer: null, polling: false, lastErr: ''
    };

    // ---- champion mapping (arammayhem entries <-> Data Dragon) ----------------------------------------------------------
    function buildMaps() {
        S.ddByNorm.clear(); S.ddById.clear(); S.bySlug.clear();
        for (const c of DD.getChampions() || []) { S.ddByNorm.set(norm(c.id), c); S.ddByNorm.set(norm(c.name), c); S.ddById.set(Number(c.key), c); }
        if (!S.tier) return;
        for (const e of S.tier.champions) {
            const first = norm((e.search || '').split(' ')[0]);
            const cand = [norm(e.slug), norm(e.name), ALIASES[norm(e.slug)], ALIASES[norm(e.name)], first];
            let dd = null;
            for (const k of cand) if (k && (dd = S.ddByNorm.get(k))) break;
            if (!dd && norm(e.name).length > 3) { // "Nunu & Willump" style: Data Dragon name starts with the slug
                for (const c of S.ddById.values()) if (norm(c.name).startsWith(norm(e.slug)) && norm(e.slug).length >= 4) { dd = c; break; }
            }
            e.dd = dd ? dd.id : null; e.ddKey = dd ? Number(dd.key) : null;
            S.bySlug.set(e.slug, e);
        }
    }
    const entryByKey = key => { for (const e of S.bySlug.values()) if (e.ddKey === key) return e; return null; };
    const champIcon = e => {
        const dd = e && e.dd && S.ddByNorm.get(norm(e.dd));
        const v = DD.getLatestPatch && DD.getLatestPatch();
        return dd && v ? `${DD.ddragonBase}/cdn/${v}/img/champion/${dd.image.full}` : (e && e.image) || '';
    };
    const unmapped = () => (S.tier ? S.tier.champions.filter(e => !e.dd).map(e => e.slug) : []);

    // ---- Data Dragon items / spells (with fallback to older versions for removed item ids) -----------------------------
    const itemCache = new Map();   // id -> { name, img } | null
    let latestItems = null, versionsPromise = null, oldBusy = false;
    const oldVersionItems = new Map();
    async function ddJson(url) { try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch (e) { return null; } }
    async function loadStatic() {
        if (S.itemMeta) return;
        const v = DD.getLatestPatch();
        const [it, sp] = await Promise.all([ddJson(`${DD.ddragonBase}/cdn/${v}/data/en_US/item.json`), ddJson(`${DD.ddragonBase}/cdn/${v}/data/en_US/summoner.json`)]);
        latestItems = (it && it.data) || {};
        S.itemMeta = true;
        S.spellMeta = {};
        if (sp && sp.data) for (const s of Object.values(sp.data)) S.spellMeta[s.key] = { name: s.name, file: s.image && s.image.full };
    }
    function item(id) {
        const key = String(id);
        if (itemCache.has(key)) return itemCache.get(key);
        const v = DD.getLatestPatch();
        if (latestItems && latestItems[key]) { const r = { name: latestItems[key].name, img: `${DD.ddragonBase}/cdn/${v}/img/item/${key}.png` }; itemCache.set(key, r); return r; }
        if (latestItems) pendingOld.add(key), setTimeout(resolveOld, 0);
        return { name: key, img: latestItems ? '' : `${DD.ddragonBase}/cdn/${v}/img/item/${key}.png` };
    }
    const pendingOld = new Set();
    async function resolveOld() {
        if (oldBusy || !pendingOld.size) return;
        oldBusy = true;
        try {
            if (!versionsPromise) versionsPromise = ddJson(`${DD.ddragonBase}/api/versions.json`);
            const versions = ((await versionsPromise) || []).filter(v => /^\d+\.\d+\.\d+$/.test(v)).slice(1, 60);
            for (const v of versions) {
                if (!pendingOld.size) break;
                let items = oldVersionItems.get(v);
                if (!items) { const j = await ddJson(`${DD.ddragonBase}/cdn/${v}/data/en_US/item.json`); if (!j) continue; items = j.data || {}; oldVersionItems.set(v, items); }
                for (const id of [...pendingOld]) if (items[id]) { itemCache.set(id, { name: items[id].name, img: `${DD.ddragonBase}/cdn/${v}/img/item/${id}.png` }); pendingOld.delete(id); }
            }
            for (const id of pendingOld) itemCache.set(id, { name: '#' + id, img: '' });
            pendingOld.clear();
        } finally { oldBusy = false; }
        renderBuild();
    }
    const itemIcon = (id, count) => { const it = item(id); return `<span class="aram-item" title="${esc(it.name)}">${it.img ? `<img src="${esc(it.img)}" alt="${esc(it.name)}" loading="lazy" onerror="this.style.visibility='hidden'">` : `<span class="aram-item-missing">${esc(it.name)}</span>`}${count > 1 ? `<b>x${count}</b>` : ''}</span>`; };
    const spellIcon = (id, fallbackName) => {
        const m = S.spellMeta && S.spellMeta[id];
        const v = DD.getLatestPatch();
        return m && m.file ? `<span class="aram-item" title="${esc(m.name)}"><img src="${DD.ddragonBase}/cdn/${v}/img/spell/${esc(m.file)}" alt="${esc(m.name)}"></span>` : `<span class="aram-chip">${esc(fallbackName || id)}</span>`;
    };

    // ---- data loading ---------------------------------------------------------------------------------------------------
    async function loadTier(force) {
        const r = await api.invoke('aram:tier-list', { force: !!force }).catch(e => ({ ok: false, error: e.message }));
        if (r && r.ok) { S.tier = Object.assign({}, r.data, { fetchedAt: r.fetchedAt, stale: r.stale }); S.tierErr = r.error || null; buildMaps(); }
        else S.tierErr = (r && r.error) || 'Could not load the tier list';
    }
    async function loadBuild(slug, force) {
        if (!slug) return;
        S.build[slug] = Object.assign(S.build[slug] || {}, { loading: true });
        renderBuild();
        const [c, i] = await Promise.all([
            api.invoke('aram:champion', { slug, force: !!force }).catch(e => ({ ok: false, error: e.message })),
            api.invoke('aram:items', { slug, tier: 'all', force: !!force }).catch(e => ({ ok: false, error: e.message })),
            loadStatic()
        ]);
        S.build[slug] = { loading: false, champ: c, items: i };
        if (S.selected === slug) renderBuild();
    }
    function select(slug) {
        S.selected = slug;
        renderLeft();
        const b = S.build[slug];
        if (!b || (!b.loading && !(b.champ && b.champ.ok))) loadBuild(slug); else renderBuild();
    }

    // ---- champ select polling -------------------------------------------------------------------------------------------
    async function poll() {
        if (S.polling || !S.active) return;
        S.polling = true;
        try {
            const r = await api.invoke('aram:champ-select', {});
            S.cs = r && r.ok ? r.data : null;
        } catch (e) { S.cs = null; }
        finally { S.polling = false; }
        const d = S.cs;
        const sig = d ? JSON.stringify([d.connected, d.inChampSelect, d.inGame, d.phase, d.isMayhem, d.isAram, d.mine, d.bench, d.team, d.rerolls]) : '';
        // Follow your own champion: whenever it changes (first pick, reroll, bench swap) its build opens automatically.
        // Clicking another row overrides this until your champion changes again. Checked every poll, not only on a change,
        // because the tier list (needed to map the champion) may still be loading when your champion first appears.
        const mine = d && (d.inChampSelect || d.inGame) ? d.mine : 0;
        if (mine && mine !== S.autoMine) {
            const e = entryByKey(mine);
            if (e) { S.autoMine = mine; select(e.slug); }
        } else if (!mine) S.autoMine = 0;
        if (sig !== S.csSig) {
            S.csSig = sig;
            renderTop(); renderLeft();
            if (S.view === 'auto' && S.cs && S.cs.inChampSelect) prefetchAvailable();
        }
    }
    function startPolling() { if (S.timer) return; poll(); S.timer = setInterval(poll, 1200); }
    function stopPolling() { if (S.timer) clearInterval(S.timer); S.timer = null; }

    // Prefetch builds for at most the champions currently available (own + bench), a few at a time via the main-process limiter.
    const prefetched = new Set();
    function prefetchAvailable() {
        const slugs = available().slice(0, 12).map(a => a.entry && a.entry.slug).filter(Boolean);
        for (const s of slugs) if (!prefetched.has(s)) { prefetched.add(s); api.invoke('aram:champion', { slug: s }).catch(() => {}); }
    }

    // ---- available champions --------------------------------------------------------------------------------------------
    function available() {
        const out = new Map();   // ddKey -> { entry, sources:Set }
        const add = (key, src) => {
            if (!key) return;
            const e = entryByKey(key);
            if (!e) return;
            if (!out.has(key)) out.set(key, { entry: e, sources: new Set() });
            out.get(key).sources.add(src);
        };
        const d = S.cs;
        if (d && d.inGame) add(d.mine, 'current'); // loading screen / in game: your champion only (champ select is over)
        if (d && d.inChampSelect) {
            add(d.mine, 'current');
            for (const b of d.bench || []) add(b, 'bench');
            for (const t of d.team || []) add(t.championId, 'teammate');
        }
        for (const key of S.manual.keys()) add(key, 'manual');
        return [...out.values()].sort((a, b) => b.entry.wr - a.entry.wr);
    }

    // ---- rendering ------------------------------------------------------------------------------------------------------
    function skeleton() {
        root.innerHTML = `<div class="aram-wrap">
            <div class="aram-top" id="aram-top"></div>
            <div class="aram-cols">
                <section class="aram-left" id="aram-left"></section>
                <section class="aram-right" id="aram-right"></section>
            </div></div>`;
        root.querySelector('#aram-left').addEventListener('click', onLeftClick);
        root.querySelector('#aram-left').addEventListener('input', onLeftInput);
        root.querySelector('#aram-right').addEventListener('click', onRightClick);
        root.querySelector('#aram-top').addEventListener('click', onTopClick);
    }

    function renderTop() {
        const el = root.querySelector('#aram-top'); if (!el) return;
        const d = S.cs, t = S.tier;
        let status;
        if (!d || !d.connected) status = '<span class="aram-dot off"></span>League client not detected: showing the full tier list. You can add the champions you have by hand.';
        else if (d.inGame) status = `<span class="aram-dot on"></span>In game${d.queueName ? ` (${esc(d.queueName)})` : ''}: showing your champion's build.`;
        else if (!d.inChampSelect) status = `<span class="aram-dot off"></span>Not in champion select (${esc(d.phase || 'idle')}).`;
        else if (!d.isMayhem) status = `<span class="aram-dot warn"></span>In champion select, but the queue is <b>${esc(d.queueName || 'not ARAM: Mayhem')}</b>${d.isAram ? ' (regular ARAM: augments do not apply, win rates are Mayhem figures)' : ''}.`;
        else status = `<span class="aram-dot on"></span>ARAM: Mayhem champion select${d.rerolls != null ? ` &middot; rerolls left: <b>${d.rerolls}</b>` : ''}.`;
        const meta = t ? `${chip('aram-tier', { title: 'ARAM Mayhem tier list', source: 'arammayhem.com', url: 'https://arammayhem.com/tier-list/', period: `Patch ${t.patch || '?'}`,
                updatedAt: t.dataDate || null, fetchedAt: t.fetchedAt, stale: !!t.stale, rows: [['Champions', String(t.champions.length)], ['Average WR', fmt1(t.avgWr) + '%']],
                note: 'Cached on this PC for about 6 hours and refreshed in the background.', onRefresh: async () => { await reload(); return { message: 'Tier list fetched again.' }; } })}
                ${DD.help ? DD.help('aram') : ''}${t.stale ? ' &middot; <span class="aram-stale">refreshing</span>' : ''}` : '';
        el.innerHTML = `<div class="aram-status">${status}</div><div class="aram-meta">${meta}
            <a href="https://arammayhem.com/tier-list/" target="_blank" rel="noopener" class="aram-link">arammayhem.com</a>
            <button class="aram-btn" data-act="reload" title="Re-fetch the tier list and the selected champion">Refresh</button></div>`;
    }

    function rowHtml(e, sources, selected) {
        const avg = S.tier ? S.tier.avgWr : 50;
        const d = e.wr - avg;
        const tags = sources ? [...sources].map(s => `<span class="aram-src ${s}">${s}</span>`).join('') : '';
        return `<div class="aram-row${selected ? ' sel' : ''}" data-slug="${esc(e.slug)}">
            <img class="aram-champ" src="${esc(champIcon(e))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
            <div class="aram-name">${esc(e.name)}<div class="aram-sub">${tags}${e.tags.length ? `<span class="aram-role">${esc(e.tags.join(' / '))}</span>` : ''}</div></div>
            <span class="aram-tier t-${esc((e.tier || '').replace('+', 'p').toLowerCase())}">${esc(e.tier || '')}</span>
            <span class="aram-wr">${fmt2(e.wr)}%</span>
            <span class="aram-delta ${deltaCls(d)}">${signed(d)}</span>
            ${sources && sources.has('manual') ? `<button class="aram-x" data-rm="${e.ddKey}" title="Remove">&times;</button>` : ''}
        </div>`;
    }

    function renderLeft() {
        const el = root.querySelector('#aram-left'); if (!el) return;
        const keepFocus = document.activeElement && document.activeElement.id === 'aram-search';
        const pos = keepFocus ? document.activeElement.selectionStart : 0;
        if (!S.tier) {
            el.innerHTML = `<div class="aram-empty">${S.tierErr ? `Could not load the ARAM Mayhem tier list: ${esc(S.tierErr)}<br><button class="aram-btn" data-act="reload">Retry</button>` : 'Loading the ARAM Mayhem tier list...'}</div>`;
            return;
        }
        const avail = available();
        const inCs = !!(S.cs && S.cs.inChampSelect);
        const mode = S.view === 'auto' ? (avail.length ? 'avail' : 'all') : S.view;
        let body = '';
        if (mode === 'avail') {
            body = avail.length ? avail.map(a => rowHtml(a.entry, a.sources, a.entry.slug === S.selected)).join('')
                : inCs ? '<div class="aram-empty">In champion select, but the client has not reported your champion yet. It appears here as soon as it does; you can also add champions by hand.</div>'
                : '<div class="aram-empty">No champions yet. Enter champion select, or add champions by hand.</div>';
            if (inCs && S.cs.rerolls) body += `<div class="aram-note">${S.cs.rerolls} reroll(s) left: a reroll gives a random champion, so it is not listed.</div>`;
        } else {
            const q = norm(S.search);
            const list = S.tier.champions.filter(e => !q || norm(e.name).includes(q) || norm(e.slug).includes(q) || norm(e.search).includes(q));
            body = list.map(e => {
                const a = avail.find(x => x.entry === e);
                return rowHtml(e, a ? a.sources : null, e.slug === S.selected);
            }).join('') || '<div class="aram-empty">No champion matches.</div>';
        }
        const addable = mode === 'avail' ? '' : '';
        el.innerHTML = rerollAdviceHtml() + `<div class="aram-tabs">
                <button class="aram-tab${mode === 'avail' ? ' on' : ''}" data-aview="avail">Recommended picks (${avail.length})</button>
                <button class="aram-tab${mode === 'all' ? ' on' : ''}" data-aview="all">Full tier list</button>
            </div>
            <div class="aram-listhead"><span>${mode === 'avail' ? 'Available to you, best Mayhem win rate first' : 'All champions by Mayhem win rate'}</span><span class="h-tier">Tier</span><span class="h-wr">WR</span><span class="h-d">vs avg</span></div>
            ${mode === 'all' ? `<input id="aram-search" class="aram-search" type="search" placeholder="Search champion (search to also add it by hand with +)" value="${esc(S.search)}">` : ''}
            ${mode === 'avail' ? `<input id="aram-search" class="aram-search" type="search" placeholder="Add a champion by hand..." value="${esc(S.search)}" list="aram-dl">${datalist()}` : ''}
            <div class="aram-list">${body}</div>${addable}`;
        if (mode === 'avail' && S.search) { /* suggestions are in the datalist */ }
        if (keepFocus) { const i = el.querySelector('#aram-search'); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch (e) { /* type=search */ } } }
    }
    // Reroll / bench advice (champ select): your champion against what a reroll gives on average (every champion's Mayhem WR
    // counts equally: a reroll is random over the pool) and against the best champion on the bench right now.
    function rerollAdviceHtml() {
        const a = rerollAdvice();
        if (a) return a.html;
        const d = S.cs;   // ARAM champion select, nothing known about your champion yet (not even from the client's other fields)
        if (d && d.inChampSelect && d.isAram && S.tier && !d.mine && !(d.bench && d.bench.length)) return '<div class="aram-advice"><div class="aram-advice-main">Waiting for your champion</div><div class="aram-advice-sub">The client has not reported it yet. It appears here with its build as soon as it does.</div></div>';
        return '';
    }
    function rerollAdvice() {
        const d = S.cs;
        if (!d || !d.inChampSelect || !S.tier || !d.mine) return null;
        const mine = entryByKey(d.mine);
        if (!mine || mine.wr == null) return null;
        const wrs = S.tier.champions.map(e => e.wr).filter(w => w != null);
        if (!wrs.length) return null;
        const avg = wrs.reduce((t, w) => t + w, 0) / wrs.length;
        const better = wrs.filter(w => w > mine.wr).length / wrs.length;
        const bench = (d.bench || []).map(entryByKey).filter(e => e && e.wr != null).sort((a, b) => b.wr - a.wr)[0];
        const rerolls = d.rerolls;
        let verdict, cls;
        if (!(d.bench && d.bench.length)) {   // the bench has not opened yet: only your own champion against the tier list
            const sorted = [...wrs].sort((a, b) => a - b), mid = sorted.length >> 1;
            const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
            if (mine.wr >= median) { verdict = `Bench opens soon: keep <b>${esc(mine.name)}</b>, it is above the middle of the tier list`; cls = 'ok'; }
            else if (rerolls === 0) { verdict = `Bench opens soon: ${esc(mine.name)} is below the middle of the tier list, but no rerolls are left`; cls = 'warn'; }
            else { verdict = `Bench opens soon: a reroll is worth it, ${Math.round(better * 100)}% of champions have a higher win rate than ${esc(mine.name)}${rerolls == null ? ' (rerolls left unknown)' : ''}`; cls = 'go'; }
            return { cls, text: verdict.replace(/<[^>]+>/g, ''), html: `<div class="aram-advice ${cls}"><div class="aram-advice-main">${verdict}</div>
                <div class="aram-advice-sub">${esc(mine.name)} ${fmt2(mine.wr)}% · tier list middle ${fmt2(median)}% · average reroll ${fmt2(avg)}%${rerolls != null ? ` · rerolls left: ${rerolls}` : ''}</div></div>` };
        }
        if (bench && bench.wr - mine.wr >= 1) { verdict = `Swap to <b>${esc(bench.name)}</b> from the bench (${signed(bench.wr - mine.wr)})`; cls = 'go'; }
        else if (mine.wr < avg - 0.5 && rerolls) { verdict = `Reroll: ${Math.round(better * 100)}% of rerolls give a higher win rate`; cls = 'go'; }
        else if (mine.wr < avg - 0.5) { verdict = `Below an average reroll, but no rerolls left${bench ? ' and nothing better on the bench' : ''}`; cls = 'warn'; }
        else { verdict = `Keep ${esc(mine.name)}: only ${Math.round(better * 100)}% of rerolls would be better`; cls = 'ok'; }
        return { cls, text: verdict.replace(/<[^>]+>/g, ''), html: `<div class="aram-advice ${cls}"><div class="aram-advice-main">${verdict}</div>
            <div class="aram-advice-sub">${esc(mine.name)} ${fmt2(mine.wr)}% · average reroll ${fmt2(avg)}%${bench ? ` · best bench ${esc(bench.name)} ${fmt2(bench.wr)}%` : ''}${rerolls != null ? ` · rerolls left: ${rerolls}` : ''}</div></div>` };
    }
    // Rows for the mini window (mini-feed.js): the champions you can play now, else the top of the tier list
    function miniData() {
        if (!S.tier) return { mode: 'aram', title: 'ARAM Mayhem', rows: [], empty: S.tierErr ? `Tier list unavailable: ${S.tierErr}` : 'Loading the tier list…' };
        const avail = available();
        const list = avail.length ? avail.map(a => ({ e: a.entry, src: a.sources.has('current') ? 'current' : [...a.sources][0] })) : S.tier.champions.slice(0, 8).map(e => ({ e, src: '' }));
        const rows = list.slice(0, 8).map(({ e, src }) => ({ id: String(e.ddKey || ''), name: e.name, img: champIcon(e), tier: e.tier || '', wr: e.wr, delta: e.wr != null && S.tier.avgWr != null ? e.wr - S.tier.avgWr : null, src }));
        const adv = rerollAdvice();
        return { mode: 'aram', title: avail.length ? 'ARAM Mayhem: your options' : 'ARAM Mayhem: top of the tier list', rows,
            sub: `Patch ${S.tier.patch || '?'} · arammayhem.com${S.cs && S.cs.inChampSelect && S.cs.rerolls != null ? ` · rerolls left: ${S.cs.rerolls}` : ''}`,
            advice: adv ? { text: adv.text, cls: adv.cls === 'go' ? 'go' : adv.cls === 'warn' ? 'warn' : '' } : null };
    }
    function datalist() {
        return `<datalist id="aram-dl">${S.tier.champions.map(e => `<option value="${esc(e.name)}"></option>`).join('')}</datalist>`;
    }

    function onTopClick(ev) {
        const b = ev.target.closest('[data-act="reload"]');
        if (b) reload();
    }
    async function reload() {
        await loadTier(true); renderTop(); renderLeft();
        if (S.selected) loadBuild(S.selected, true);
    }
    function onLeftClick(ev) {
        const rm = ev.target.closest('[data-rm]');
        if (rm) { S.manual.delete(Number(rm.dataset.rm)); renderLeft(); return; }
        const tab = ev.target.closest("[data-aview]");
        if (tab) { S.view = tab.dataset.aview; S.search = ''; renderLeft(); return; }
        if (ev.target.closest('[data-act="reload"]')) { reload(); return; }
        const row = ev.target.closest('.aram-row');
        if (row) select(row.dataset.slug);
    }
    function onLeftInput(ev) {
        if (ev.target.id !== 'aram-search') return;
        const v = ev.target.value;
        const mode = S.view === 'auto' ? (available().length ? 'avail' : 'all') : S.view;
        if (mode === 'avail') {   // datalist pick (exact name) adds the champion by hand
            const e = S.tier && S.tier.champions.find(x => x.name.toLowerCase() === v.trim().toLowerCase() && x.ddKey);
            if (e) { S.manual.set(e.ddKey, true); S.search = ''; S.view = 'avail'; renderLeft(); select(e.slug); return; }
            S.search = v; return;
        }
        S.search = v; renderLeft();
    }

    // data-source chip (glossary.js); empty if that script is missing
    const chip = (id, info) => (DD.provChip ? DD.provChip(id, info) : '');

    // ---- build panel ----------------------------------------------------------------------------------------------------
    function ageText(ts) { if (!ts) return ''; const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'just now' : m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; }

    function pickRateCell(p) { return p == null ? '' : `<span class="aram-pick">${fmt1(p)}% picked</span>`; }
    function rateRow(items, pick, wr, base, extra, names) {
        const d = base != null && wr != null ? wr - base : null;
        return `<div class="aram-irow">${items}<span class="aram-iname">${esc(names || '')}</span><span class="aram-grow"></span>${extra || ''}${pickRateCell(pick)}<span class="aram-wr">${fmt2(wr)}%</span><span class="aram-delta ${deltaCls(d)}">${signed(d)}</span></div>`;
    }
    // Items come ONLY from LoLalytics ARAM win rates (not arammayhem.com). A row is dimmed when it has few games; dimmed rows sink to the bottom.
    const LOW_GAMES_FRAC = 0.01, LOW_GAMES_MIN = 100;   // dimmed: under 1% of the champion's games (or under 100)
    function sortByWr(rows, lowGames) {
        const ok = rows.filter(r => r.games == null || r.games >= lowGames).sort((a, b) => (b.wr || 0) - (a.wr || 0));
        const low = rows.filter(r => r.games != null && r.games < lowGames).sort((a, b) => b.games - a.games);
        return ok.concat(low.map(r => ({ ...r, low: true })));
    }
    const lowRow = html => html.replace('class="aram-irow"', 'class="aram-irow low"');

    function renderBuild() {
        const el = root.querySelector('#aram-right'); if (!el) return;
        const slug = S.selected;
        if (!slug) { el.innerHTML = '<div class="aram-empty big">Select a champion on the left to see its augment win rates and item builds.</div>'; return; }
        const e = S.bySlug.get(slug), b = S.build[slug];
        const head = `<div class="aram-bhead">${e ? `<img class="aram-champ lg" src="${esc(champIcon(e))}" alt="">` : ''}<div><h2>${esc(e ? e.name : slug)}</h2>
            <div class="aram-sub">${e ? `<span class="aram-tier t-${esc((e.tier || '').replace('+', 'p').toLowerCase())}">${esc(e.tier || '')}</span> ARAM: Mayhem WR <b>${fmt2(e.wr)}%</b> &middot; rank #${e.rank}` : ''}</div></div></div>`;
        if (!b || b.loading) { el.innerHTML = head + '<div class="aram-empty">Loading build...</div>'; return; }
        const c = b.champ && b.champ.ok ? b.champ.data : null, st = b.champ && b.champ.stale;
        let html = head;
        if (!c) {
            html += `<div class="aram-empty">Could not load the Mayhem build: ${esc((b.champ && b.champ.error) || 'unknown error')} <button class="aram-btn" data-act="retry">Retry</button></div>`;
        } else {
            const base = c.meta.wr != null ? c.meta.wr : (e && e.wr);
            html += `<div class="dg-prov-row">${chip('aram-augments', { title: 'Mayhem augments', source: 'arammayhem.com', url: `https://arammayhem.com/build/${slug}/`, period: `Patch ${c.meta.patch || '?'}`,
                updatedAt: c.meta.dataDate || null, fetchedAt: b.champ.fetchedAt, stale: !!st, rows: [['Champion', e ? e.name : slug], ['Pick rate', fmt2(c.meta.pick) + '%']],
                note: 'Fetched when the champion is opened; cached on this PC for about 6 hours.', onRefresh: async () => { await loadBuild(slug, true); return { message: 'Fetched again.' }; } })}</div>`;
            html += `<div class="aram-statline">Champion WR <b>${fmt2(c.meta.wr)}%</b> &middot; pick rate ${fmt2(c.meta.pick)}% &middot; ${esc(c.meta.tier || '')} #${c.meta.rank || '?'} &middot; patch ${esc(c.meta.patch || '?')} &middot; data ${esc(c.meta.dataDate || '?')}
                ${c.balance.length ? ` &middot; Mayhem balance: ${c.balance.map(x => `<span class="aram-bal">${esc(x.dir)} ${esc(x.label)} ${esc(x.value)}</span>`).join(' ')}` : ''}</div>`;
            // augments
            const tabs = ['prismatic', 'gold', 'silver'];
            html += `<h3>Augments ${DD.help ? DD.help('aram') : ''} <span class="aram-hint">sorted by win rate; dimmed = appeared in under ${LOW_APPEARANCE}% of games</span></h3>
                <div class="aram-tabs sm">${tabs.map(r => `<button class="aram-tab r-${r}${S.rarity === r ? ' on' : ''}" data-rarity="${r}">${r[0].toUpperCase() + r.slice(1)} (${c.augments[r].length})</button>`).join('')}</div>
                <div class="aram-listhead aug"><span>Augment</span><span class="h-app">Appears</span><span class="h-wr">WR</span><span class="h-d">vs champ</span></div>`;
            const augs = [...c.augments[S.rarity]].sort((x, y) => (y.wr || 0) - (x.wr || 0));
            html += augs.length ? augs.map(a => {
                const d = a.wr != null && base != null ? a.wr - base : null;
                return `<div class="aram-arow${a.appearance != null && a.appearance < LOW_APPEARANCE ? ' low' : ''}">
                    ${a.icon ? `<img class="aram-aug" src="${esc(a.icon)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '<span class="aram-aug"></span>'}
                    <span class="aram-aname">${esc(a.name)}</span><span class="aram-app">${fmt2(a.appearance)}%</span><span class="aram-wr">${fmt2(a.wr)}%</span><span class="aram-delta ${deltaCls(d)}">${signed(d)}</span></div>`;
            }).join('') : '<div class="aram-empty small">No augments of this rarity listed.</div>';
        }
        // Items: LoLalytics (regular ARAM) only
        const li = b.items && b.items.ok ? b.items.data : null;
        html += `<h3>Items &mdash; LoLalytics ARAM win rates <span class="aram-hint">(all ARAM, last 30 days, all ranks) &middot; sorted by win rate; dimmed = few games</span></h3>`;
        if (!li) html += `<div class="aram-empty small">LoLalytics build not available: ${esc((b.items && b.items.error) || 'unknown error')}</div>`;
        else {
            const gam = g => `<span class="aram-games">${fmtInt(g)} games</span>`;
            const lowGames = Math.max(LOW_GAMES_MIN, (li.games || 0) * LOW_GAMES_FRAC);
            const optRows = (rows, name) => sortByWr(rows, lowGames).map(o => {
                const row = rateRow(o.icon === false ? '<span class="aram-item"></span>' : itemIcon(o.id), o.pick, o.wr, li.wr, gam(o.games), name(o));
                return o.low ? lowRow(row) : row;
            }).join('');
            html += `<div class="dg-prov-row">${chip('aram-items', { title: 'ARAM items', short: 'LoLalytics ARAM', source: 'LoLalytics (regular ARAM)', url: li.url || `https://lolalytics.com/lol/${slug}/aram/build/`, rank: li.tierLabel || 'All ranks',
                period: 'Last 30 days', games: li.games, fetchedAt: b.items.fetchedAt, stale: !!b.items.stale, note: 'Regular ARAM, not Mayhem: its win rates are not comparable with Mayhem win rates. Cached for about 6 hours.',
                onRefresh: async () => { await loadBuild(slug, true); return { message: 'Fetched again.' }; } })}</div>`;
            html += `<div class="aram-statline">Regular ARAM WR <b>${fmt2(li.wr)}%</b> (not comparable with Mayhem WR) &middot; ${fmtInt(li.games)} games &middot; ${esc(li.tier || '')}</div>`;
            html += `<div class="aram-apply"><span class="aram-apply-t">Send to client</span>
                <button class="aram-btn" data-apply="items" title="Save these items as a 'DravenGap' item set for this champion on Howling Abyss (shown in the in-game shop)">Save item set</button>
                ${li.spells && li.spells.ids && li.spells.ids.length === 2 ? `<button class="aram-btn" data-apply="spells" title="Set these summoner spells (champion select only)">Set spells</button>` : ''}
                <span class="aram-apply-msg" id="aram-apply-msg">${esc(S.applyMsg && S.applyMsg.slug === slug ? S.applyMsg.text : '')}</span></div>`;
            if (li.spells) html += `<div class="aram-isec"><h4>Summoner spells</h4>${rateRow(li.spells.ids.map((id, i) => spellIcon(id, li.spells.names[i])).join(''), null, li.spells.wr, li.wr, gam(li.spells.games), li.spells.names.join(' + '))}</div>`;
            if (li.start) html += `<div class="aram-isec"><h4>Starting items</h4>${rateRow(li.start.items.map(x => itemIcon(x.id, x.count)).join(''), null, li.start.wr, li.wr, gam(li.start.games), li.start.items.map(x => item(x.id).name).join(' + '))}</div>`;
            if (li.boots && li.boots.length) {
                const rows = li.boots.map(o => ({ ...o, icon: o.other ? false : true }));
                html += `<div class="aram-isec"><h4>Boots</h4>${optRows(rows, o => o.other ? 'Other / no boots' : item(o.id).name)}</div>`;
            }
            if (li.core) html += `<div class="aram-isec"><h4>Core build</h4>${rateRow(li.core.items.map(id => itemIcon(id)).join('<i class="aram-arrow">&rsaquo;</i>'), null, li.core.wr, li.wr, gam(li.core.games), li.core.items.map(id => item(id).name).join(' > '))}</div>`;
            for (const slot of [4, 5, 6]) {
                const opts = (li.slots && li.slots[slot]) || [];
                if (opts.length) html += `<div class="aram-isec"><h4>Item ${slot} options</h4>${optRows(opts, o => item(o.id).name)}</div>`;
            }
        }
        const fetched = [b.champ && b.champ.fetchedAt, b.items && b.items.fetchedAt].filter(Boolean);
        html += `<div class="aram-foot">Sources: augments from <a class="aram-link" target="_blank" rel="noopener" href="https://arammayhem.com/build/${esc(slug)}/">arammayhem.com/build/${esc(slug)}</a> &middot; items from
            <a class="aram-link" target="_blank" rel="noopener" href="${esc(li ? li.url : `https://lolalytics.com/lol/${slug}/aram/build/?patch=30&tier=all`)}">lolalytics.com ARAM build</a>
            ${fetched.length ? ` &middot; fetched ${ageText(Math.min(...fetched))}${st || (b.items && b.items.stale) ? ' (refreshing in background)' : ''}` : ''}</div>`;
        el.innerHTML = html;
    }
    // Item set from the LoLalytics rows shown below: starting items, boots, the core build, then the best few options per slot
    function itemSetBlocks(li) {
        const lowGames = Math.max(LOW_GAMES_MIN, (li.games || 0) * LOW_GAMES_FRAC);
        const top = (rows, n) => sortByWr(rows || [], lowGames).filter(r => !r.low && !r.other && r.id).slice(0, n).map(r => Number(r.id));
        const blocks = [];
        if (li.start && li.start.items.length) blocks.push({ type: 'Starting items', items: li.start.items.map(x => Number(x.id)) });
        const boots = top((li.boots || []).filter(r => Number(r.id) !== 1001), 2); // tier-2 boots only (plain Boots is a step, not a choice)
        if (boots.length) blocks.push({ type: 'Boots (best win rate)', items: boots });
        if (li.core && li.core.items.length) blocks.push({ type: 'Core build', items: li.core.items.map(Number) });
        for (const slot of [4, 5, 6]) { const o = top(li.slots && li.slots[slot], 3); if (o.length) blocks.push({ type: `Item ${slot} options`, items: o }); }
        return blocks;
    }
    async function applyToClient(kind) {
        const slug = S.selected, e = S.bySlug.get(slug), b = S.build[slug];
        const li = b && b.items && b.items.ok ? b.items.data : null;
        if (!e || !li) return;
        const say = text => { S.applyMsg = { slug, text }; const m = document.getElementById('aram-apply-msg'); if (m) m.textContent = text; };
        say('Sending…');
        let r;
        try {
            if (kind === 'items') {
                r = await api.invoke('lcu:apply-itemset', { championKey: Number(e.ddKey), map: 12, title: `${e.name} ARAM`, blocks: itemSetBlocks(li) });
                if (r && r.ok) return say(`Item set "${r.title}" saved: open the shop in game to use it.`);
            } else {
                const ids = li.spells.ids.map(Number);
                r = await api.invoke('lcu:apply-spells', { spell1Id: ids[0], spell2Id: ids[1] });
                if (r && r.ok) return say(`Spells set: ${li.spells.names.join(' + ')}.`);
            }
        } catch (err) { r = { error: err.message }; }
        say((r && r.error) || 'Could not reach the League client.');
    }
    function onRightClick(ev) {
        const ap = ev.target.closest('[data-apply]');
        if (ap) { applyToClient(ap.dataset.apply); return; }
        const r = ev.target.closest('[data-rarity]');
        if (r) { S.rarity = r.dataset.rarity; renderBuild(); return; }
        if (ev.target.closest('[data-act="retry"]')) loadBuild(S.selected, true);
    }

    // ---- lifecycle ------------------------------------------------------------------------------------------------------
    api.on('aram:updated', ev => {   // a background refresh finished: swap in the new data
        if (!ev) return;
        if (ev.kind === 'tier-list') loadTier(false).then(() => { renderTop(); renderLeft(); });
        else if (S.selected && String(ev.key || '').includes(S.selected)) loadBuild(S.selected, false);
    });

    async function activate() {
        if (S.active) return;
        S.active = true;
        if (!root.firstChild) skeleton();
        renderTop(); renderLeft(); renderBuild();
        await DD.ready;
        if (!S.active) return;
        if (!S.tier) { await loadTier(false); buildMaps(); renderTop(); renderLeft(); }
        renderBuild();
        startPolling();
    }
    function deactivate() { S.active = false; stopPolling(); }

    DD.onView(name => { if (name === 'aram') activate(); else deactivate(); });
    if (DD.currentView() === 'aram') activate();                        // the saved game mode may show this view before our script ran
    DD.ready.then(() => { if (DD.currentView() === 'aram') activate(); });

    window.__aramDebug = { state: S, unmapped, available, norm, itemSetBlocks };      // for the test harness
    // From other views (command palette): open the ARAM view on a champion (Data Dragon numeric key); waits for the tier list
    window.DDAram = {
        miniData,
        selectedKey: () => { const e = S.selected && S.bySlug.get(S.selected); return e ? e.ddKey : null; },   // back / forward (workflow.js)
        // Champion hub: the arammayhem.com entry of a Data Dragon champion key (loads the tier list once, cache first) or null
        async entryFor(key) {
            if (!S.tier) { await DD.ready; await loadTier(false); buildMaps(); }
            const e = S.tier ? entryByKey(Number(key)) : null;
            return e ? { slug: e.slug, name: e.name, wr: e.wr, tier: e.tier, rank: e.rank, avgWr: S.tier.avgWr, patch: S.tier.patch, count: S.tier.champions.length, fetchedAt: S.tier.fetchedAt } : null;
        },
        async selectByKey(key) {
            DD.showView('aram');
            for (let i = 0; i < 50 && !S.tier; i++) await new Promise(r => setTimeout(r, 100));
            const e = entryByKey(Number(key));
            if (e) select(e.slug);
            return !!e;
        }
    };
})();
