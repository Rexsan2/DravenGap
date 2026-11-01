// desktop-app/champion-hub.js
// Champion hub (C1): one page per champion in #champion-root (view 'champion'). Opened from the sidebar (Champions), Ctrl+K,
// a right-click on a champion in the draft grid, a recommendation's "why" panel and the Builds view (window.DDHub.open).
// Tabs: Overview, Matchups (lane opponents), Synergies (allies per role), Builds (saved Coachless data), My stats (your games
// from Profile) and ARAM Mayhem. The matchup page is the "vs <champion>" tab (DD.openMatchup, or a click on a lane opponent):
// the lane effect, both champions' strength and patch changes, your record in it, the build against it and your own notes. Draft numbers come from DD.championData: the dataset and model the recommendations use, so
// both always agree. Nothing is downloaded until a tab needs it, and then only what that tab's own view would fetch.
(function () {
    'use strict';
    const DD = window.DD, root = document.getElementById('champion-root');
    if (!DD || !root) return;
    const api = window.electronAPI && window.electronAPI.feature;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ROLE_LABEL = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', SUPPORT: 'Support' };
    const ROLES = Object.keys(ROLE_LABEL);
    const POS_ROLE = { TOP: 'TOP', JUNGLE: 'JUNGLE', MIDDLE: 'MIDDLE', BOTTOM: 'BOTTOM', UTILITY: 'SUPPORT' };
    const TABS = [['overview', 'Overview'], ['matchups', 'Matchups'], ['synergies', 'Synergies'], ['builds', 'Builds'], ['mine', 'My stats'], ['aram', 'ARAM Mayhem']];
    const COMMON = 0.01;   // "common" opponents / partners: played in at least 1% of that role's games
    const S = { champ: null, role: null, vs: null, tab: 'overview', data: null, loading: false, err: null, builds: null, mine: null, aram: null, recent: [], common: true, sort: 'best', seq: 0 };

    const champOf = id => (DD.getChampions() || []).find(c => c.id === id) || null;
    const img = id => { const c = champOf(id), v = DD.getLatestPatch && DD.getLatestPatch(); return c && v ? `${DD.ddragonBase}/cdn/${v}/img/champion/${c.image.full}` : ''; };
    const nameOf = id => (champOf(id) || {}).name || id;
    const pct = (v, d = 1) => (v == null || !isFinite(v) ? '–' : (v * 100).toFixed(d) + '%');
    const pts = v => (v == null || !isFinite(v) ? '–' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}`);
    const sign = v => (v == null ? '' : v >= 0 ? 'delta-pos' : 'delta-neg');
    const pp = p => (p == null ? '–' : `<span class="${DD.ppClass ? DD.ppClass(p) : ''}">${p > 0.995 ? '>99%' : p < 0.005 ? '<1%' : Math.round(p * 100) + '%'}</span>`);
    const help = k => (DD.help ? DD.help(k) : '');
    const ico = (id, cls = 'ch-ico') => `<img class="${cls}" src="${esc(img(id))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;

    // ------------------------------------------------------------------------------------------------ skeleton + open
    function skeleton() {
        root.innerHTML = `<div class="ch-wrap">
            <div class="ch-top"><input type="text" id="ch-search" class="ch-search" list="ch-dl" placeholder="Champion…" autocomplete="off" spellcheck="false" aria-label="Champion">
                <datalist id="ch-dl"></datalist><div class="ch-recent" id="ch-recent"></div></div>
            <div class="ch-head" id="ch-head"></div>
            <div class="ch-tabs" id="ch-tabs" role="tablist"></div>
            <div class="ch-body" id="ch-body"></div></div>`;
        // the only champion the text can mean opens as you type ("qi" = Qiyana) and the box completes the name inline
        // (DD.completeChampion), so typing the rest of the name never hops to another champion. An exact name that starts others
        // ("Vi": Viego, Viktor) opens from the dropdown, on Enter or when leaving the box; those also clear the box. Deleting never opens.
        const box = root.querySelector('#ch-search');
        const commit = c => { if (!c) return; box.value = ''; if (c.id !== S.champ) open(c.id, null); };
        box.addEventListener('input', e => {
            const c = DD.completeChampion && DD.completeChampion(e.target, undefined, e);
            if (!c) return;
            const t = e.inputType || '';
            if (t === 'insertReplacementText' || t === 'insertFromPaste') commit(c);
            else if (c.id !== S.champ) open(c.id, null);
        });
        box.addEventListener('keydown', e => { if (e.key === 'Enter') commit(DD.uniqueChampion && DD.uniqueChampion(e.target.value)); });
        box.addEventListener('change', () => commit(DD.uniqueChampion && DD.uniqueChampion(box.value)));
        root.addEventListener('click', onClick);
        root.addEventListener('change', onChange);
    }
    async function open(champ, role, o = {}) {
        if (!champOf(champ)) { await DD.ready; if (!champOf(champ)) return; }
        if (DD.currentView() !== 'champion') DD.showView('champion');
        if (!root.firstChild) skeleton();
        if (champ !== S.champ) Object.assign(S, { builds: null, mine: null, aram: null, vs: null });
        if (o.vs && champOf(o.vs) && o.vs !== champ) { S.vs = o.vs; S.tab = 'vs'; }
        else if (S.tab === 'vs' && !S.vs) S.tab = 'overview';
        S.champ = champ; S.role = role || null; S.err = null;
        S.recent = [champ, ...S.recent.filter(x => x !== champ)].slice(0, 8);
        DD.patchSettings({ hubRecent: S.recent }).catch(() => {});
        await load();
    }
    // the page a restart reopens: written once the role is final (the most played one when none was asked for, or the role button
    // clicked last), and only when it changed
    let lastSaved = '';
    function saveLast() {
        const k = `${S.champ}|${S.role || ''}`;
        if (!S.champ || k === lastSaved) return;
        lastSaved = k;
        DD.patchSettings({ hubLast: { champ: S.champ, role: S.role || null } }).catch(() => {});
    }
    async function load() {
        const seq = ++S.seq;
        S.loading = true; paint();
        let d = null;
        try { d = DD.championData ? await DD.championData(S.champ, S.role, S.vs) : null; } catch (e) { S.err = e.message; }
        if (seq !== S.seq) return;
        S.loading = false; S.data = d;
        if (d && d.role) S.role = d.role;
        saveLast();
        paint();
        if (S.tab === 'builds') loadBuilds(); else if (S.tab === 'mine') loadMine(); else if (S.tab === 'aram') loadAram();
    }

    // ------------------------------------------------------------------------------------------------ paint
    function paint() {
        if (!root.firstChild) skeleton();
        const dl = root.querySelector('#ch-dl');
        if (dl && !dl.childElementCount) dl.innerHTML = (DD.getChampions() || []).map(c => c.name).sort().map(n => `<option value="${esc(n)}"></option>`).join('');
        root.querySelector('#ch-recent').innerHTML = S.recent.filter(c => c !== S.champ).map(c => `<button class="ch-chip" data-hub="${esc(c)}" title="${esc(nameOf(c))}">${ico(c, 'ch-chip-img')}${esc(nameOf(c))}</button>`).join('');
        const head = root.querySelector('#ch-head'), tabs = root.querySelector('#ch-tabs'), body = root.querySelector('#ch-body');
        if (!S.champ) {
            head.innerHTML = ''; tabs.innerHTML = '';
            body.innerHTML = `<div class="ch-empty"><h3>Champion pages</h3><p>Type a champion above. You can also open a page from anywhere: <b>right-click</b> a champion in the draft grid, use <b>Ctrl+K</b>, the link at the bottom of a recommendation's <b>why</b> panel, or <b>Champion page</b> in Builds.</p></div>`;
            return;
        }
        const c = champOf(S.champ) || {}, d = S.data;
        const roles = d ? ROLES.filter(r => d.roles[r] && (d.roles[r].freq >= 0.02 || r === S.role)) : [];
        head.innerHTML = `${ico(S.champ, 'ch-img')}<div class="ch-name"><h2>${esc(c.name || S.champ)} <span class="ch-title">${esc(c.title || '')}</span></h2>
            <div class="ch-roles">${roles.map(r => `<button class="ch-role${r === S.role ? ' on' : ''}" data-role="${r}" title="Played here in ${pct(d.roles[r].freq, 0)} of its games">${ROLE_LABEL[r]} <span>${pct(d.roles[r].freq, 0)}</span></button>`).join('') || (S.loading ? '<span class="ch-muted">loading…</span>' : '<span class="ch-muted">no draft data for this champion</span>')}</div></div>
            <div class="ch-actions"><span class="dg-prov-row">${DD.provChip && DD.draftProv ? DD.provChip('hub', DD.draftProv()) : ''}</span>
                <button class="ch-btn" data-act="builds" title="Full Coachless builds for this role">Builds ›</button>${c.key ? '<button class="ch-btn" data-act="aram" title="Open this champion in ARAM Mayhem">ARAM ›</button>' : ''}</div>`;
        const tabList = S.vs ? [TABS[0], ['vs', `vs ${nameOf(S.vs)}`], ...TABS.slice(1)] : TABS;
        tabs.innerHTML = tabList.map(([k, n]) => `<button class="ch-tab${k === S.tab ? ' on' : ''}" data-tab="${k}" role="tab" aria-selected="${k === S.tab}">${n}</button>`).join('');
        if (S.loading && !d) { body.innerHTML = '<div class="ch-empty">Loading…</div>'; return; }
        if (!d) { body.innerHTML = `<div class="ch-empty">${S.err ? 'Could not read the draft data: ' + esc(S.err) : 'No draft data loaded yet.'}</div>`; return; }
        const scroll = body.scrollTop;
        body.innerHTML = ({ overview: overviewHtml, vs: vsHtml, matchups: matchupsHtml, synergies: synergiesHtml, builds: buildsHtml, mine: mineHtml, aram: aramHtml }[S.tab] || overviewHtml)();
        body.scrollTop = scroll;
    }

    const common = list => list.filter(x => !S.common || x.share >= COMMON);
    // lane rows open the matchup page (this champion vs that one); ally rows open the ally's page
    const pairRow = (x, verb) => `<tr class="ch-click" ${verb === 'against' ? `data-vs="${esc(x.champion)}" data-hub-role="${esc(S.role || '')}" title="${esc(nameOf(S.champ))} vs ${esc(nameOf(x.champion))}: the matchup page (its picture: ${esc(nameOf(x.champion))}'s page)"` : `data-hub="${esc(x.champion)}" data-hub-role="${esc(x.role || '')}" title="${esc(nameOf(x.champion))}: open its page"`}>
        <td class="l">${ico(x.champion)}${esc(x.name)}</td><td>${pct(x.share, 1)}</td><td>${Math.round(x.games).toLocaleString()}</td>
        <td class="${sign(x.mean)}"><b>${pts(x.mean)}</b> <span class="ch-muted">± ${(x.sd * 100).toFixed(1)}</span></td><td class="ch-muted">${pts(x.raw)}</td><td>${pp(x.pp)}</td>
        <td class="${x.exp >= 0.5 ? 'delta-pos' : 'delta-neg'}" title="Your Exp WR ${verb} ${esc(x.name)} (nothing else in the draft)">${pct(x.exp)}</td></tr>`;
    const pairHead = (who, verb) => `<thead><tr><th class="l">${who}</th><th title="How often it is played in that role">Played</th><th>Games</th><th>Adjusted Δ ${help('shrunk-delta')}</th><th title="Raw Delta 2 before the sample-size adjustment">Raw Δ</th><th>PP ${help('pp-draft')}</th><th title="Your Exp WR ${verb} it">Exp WR</th></tr></thead>`;
    const mini = (list, empty, lane = false) => list.length ? list.map(x => `<div class="ch-mini ch-click" ${lane ? `data-vs="${esc(x.champion)}" data-hub-role="${esc(S.role || '')}"` : `data-hub="${esc(x.champion)}" data-hub-role="${esc(x.role || '')}"`}>${ico(x.champion)}<span class="ch-mini-n">${esc(x.name)}</span><b class="${sign(x.mean)}">${pts(x.mean)}</b>${pp(x.pp)}</div>`).join('') : `<div class="ch-muted">${empty}</div>`;

    function overviewHtml() {
        const d = S.data, me = d.roles[S.role];
        if (!me) return '<div class="ch-empty">No data for this role.</div>';
        const lane = common(d.matchups);
        const best = lane.filter(x => x.mean > 0).sort((a, b) => b.mean - a.mean).slice(0, 4), worst = lane.filter(x => x.mean < 0).sort((a, b) => a.mean - b.mean).slice(0, 4);
        const allies = Object.entries(d.synergies).flatMap(([r, l]) => common(l).filter(x => x.mean > 0).map(x => ({ ...x, role: r }))).sort((a, b) => b.mean - a.mean).slice(0, 4);
        const tr = me.trend;
        const y = d.you;
        let h = `<div class="ch-grid">
            <div class="ch-card"><div class="ch-card-h">${ROLE_LABEL[S.role]} ${help('base-wr')}</div>
                <div class="ch-big ${me.wr >= 0.5 ? 'delta-pos' : 'delta-neg'}">${pct(me.wr, 2)}</div><div class="ch-muted">base win rate (shrunk) ${me.sd != null ? '± ' + (me.sd * 100).toFixed(2) : ''}</div>
                <div class="ch-kv"><span>Raw win rate</span><b>${pct(me.wrRaw, 2)}</b></div>
                <div class="ch-kv"><span>Games</span><b>~${Math.round(me.games).toLocaleString()}</b></div>
                <div class="ch-kv"><span>Pick rate</span><b>${pct(me.pick, 1)}</b></div>
                <div class="ch-kv"><span>Played in this role</span><b>${pct(me.freq, 0)}</b></div>
                ${tr ? `<div class="ch-kv"><span>vs patch ${esc(tr.prevPatch)} ${help('patch-trend')}</span><b class="${tr.flag ? sign(tr.d) : ''}">${pts(tr.d)}${tr.flag ? (tr.d > 0 ? ' ▲' : ' ▼') : ' (noise)'}</b></div>` : ''}
                <div class="ch-muted ch-foot">${esc(d.label)}</div></div>
            <div class="ch-card"><div class="ch-card-h">Best into <span class="ch-muted">lane, common opponents</span></div>${mini(best, 'No favourable matchup with enough games.', true)}
                <div class="ch-card-h ch-gap">Worst into</div>${mini(worst, 'No losing matchup with enough games.', true)}<button class="link-btn" data-tab="matchups">All matchups ›</button></div>
            <div class="ch-card"><div class="ch-card-h">Best with <span class="ch-muted">allies, any role</span></div>${mini(allies, 'No positive synergy with enough games.')}<button class="link-btn" data-tab="synergies">All synergies ›</button></div>
            <div class="ch-card"><div class="ch-card-h">You ${help('you')}</div>${y ? `
                ${y.offset != null ? `<div class="ch-big ${sign(y.offset)}">${pts(y.offset)}</div><div class="ch-muted">vs an average player, from ${y.games} game${y.games === 1 ? '' : 's'} (${y.wins}W ${y.games - y.wins}L)</div>` : '<div class="ch-muted">No games in your saved history.</div>'}
                ${y.mastery ? `<div class="ch-kv"><span>Mastery</span><b>level ${y.mastery.level} · ${Number(y.mastery.points).toLocaleString()}</b></div>` : ''}`
                : '<div class="ch-muted">Your stats load from the League client (or Settings &gt; Refresh my stats).</div>'}
                <button class="link-btn" data-tab="mine">Your games on ${esc(nameOf(S.champ))} ›</button></div>
            ${DD.skillOrder ? `<div class="ch-card ch-wide"><div class="ch-card-h">Win rate by game length${DD.help ? ' ' + DD.help('length-wr') : ''} <span class="ch-muted">${ROLE_LABEL[S.role]}${DD.lolalyticsPeriod ? `, ${esc(DD.lolalyticsPeriod().label)}, ${esc(DD.lolalyticsPeriod().rankLabel)}` : ''}</span></div>${DD.skillOrder.slot(S.champ, S.role, { kind: 'length' })}${DD.skillOrder.slot(S.champ, S.role)}</div>` : ''}
        </div>`;
        return h;
    }
    // ------------------------------------------------------------------------------------------------ matchup page (vs tab)
    function vsHtml() {
        const d = S.data, me = d.roles[S.role], v = d.vs, opp = S.vs, on = nameOf(opp), mn = nameOf(S.champ);
        if (!me) return '<div class="ch-empty">No data for this role.</div>';
        const pn = id => (window.DDPatchNotes && window.DDPatchNotes.info) ? window.DDPatchNotes.info(id) : null;
        const change = id => { const c = pn(id); return c ? `<div class="ch-kv"><span>Patch ${esc(window.DDPatchNotes.patch() || '')}</span><b class="${c.kind === 'buff' ? 'delta-pos' : c.kind === 'nerf' ? 'delta-neg' : ''}">${c.kind === 'buff' ? '▲ buffed' : c.kind === 'nerf' ? '▼ nerfed' : '= adjusted'}</b></div>` : ''; };
        // your record: from the My stats summary (your lane opponents in your newest games on this champion)
        if (!S.mine) setTimeout(loadMine, 0);
        const oppKey = (champOf(opp) || {}).key, rec = S.mine && S.mine.ok && S.mine.vsOpp ? S.mine.vsOpp[oppKey] : null;
        const note = DD.matchupNote ? DD.matchupNote(S.champ, opp) : null;
        // data-hub-role: a click on either picture keeps this lane (app-shell.js opens that champion's page in the role it finds here)
        return `<div class="ch-vs-head" data-hub-role="${esc(S.role || '')}">${ico(S.champ, 'ch-img')}<b>${esc(mn)}</b><span class="ch-muted">vs</span>${ico(opp, 'ch-img')}<b>${esc(on)}</b>
                <span class="ch-muted">${ROLE_LABEL[S.role]} · ${esc(d.label)}</span>
                <button class="ch-btn" data-swap="1" title="The same matchup from ${esc(on)}'s side">Swap sides ⇄</button></div>
            <div class="ch-grid">
            <div class="ch-card"><div class="ch-card-h">Lane effect ${help('shrunk-delta')}</div>${v ? `
                <div class="ch-big ${sign(v.mean)}">${pts(v.mean)}</div><div class="ch-muted">for ${esc(mn)}, adjusted for sample size ± ${(v.sd * 100).toFixed(1)}</div>
                <div class="ch-kv"><span>Raw Δ</span><b>${pts(v.raw)}</b></div>
                <div class="ch-kv"><span>Games</span><b>${Math.round(v.games).toLocaleString()}${v.low ? ' <span class="ch-muted">(below Min Games: little weight)</span>' : ''}</b></div>
                <div class="ch-kv"><span>PP ${help('pp-draft')}</span><b>${pp(v.pp)}</b></div>
                <div class="ch-kv"><span>${esc(mn)}'s Exp WR here</span><b class="${v.exp >= 0.5 ? 'delta-pos' : 'delta-neg'}">${pct(v.exp)}</b></div>` : '<div class="ch-muted">No games of this matchup in the selected data.</div>'}</div>
            <div class="ch-card"><div class="ch-card-h">The two champions</div>
                <div class="ch-kv"><span>${esc(mn)} base WR</span><b>${pct(me.wr, 2)}</b></div>${change(S.champ)}
                <div class="ch-kv"><span>${esc(on)} base WR</span><b>${d.vsBase ? pct(d.vsBase.wr, 2) : '–'}</b></div>${change(opp)}
                <div class="ch-muted ch-foot">Base win rates in ${ROLE_LABEL[S.role]}; the lane effect comes on top of the difference between them.</div></div>
            <div class="ch-card"><div class="ch-card-h">You in this matchup ${help('you')}</div>${S.mine && S.mine.loading ? '<div class="ch-muted">Reading your games…</div>'
                : rec ? `<div class="ch-big ${rec.w / rec.g >= 0.5 ? 'delta-pos' : 'delta-neg'}">${rec.w}-${rec.g - rec.w}</div><div class="ch-muted">your games as ${esc(mn)} against ${esc(on)} (saved in Profile)</div>`
                : `<div class="ch-muted">No saved games as ${esc(mn)} against ${esc(on)}.</div>`}
                <button class="link-btn" data-tab="mine">All your ${esc(mn)} games ›</button></div>
            <div class="ch-card"><div class="ch-card-h">Build against ${esc(on)}</div><div class="ch-muted">Items, runes and spells from Coachless games of exactly this matchup (downloaded on demand).</div>
                <button class="ch-btn" data-act="builds-vs">Build vs ${esc(on)} ›</button></div>
            <div class="ch-card ch-wide"><div class="ch-card-h">Your notes <span class="ch-muted">shown in the game plan when you play ${esc(mn)} against ${esc(on)}</span></div>
                <textarea class="ch-note-box" data-note="1" rows="4" maxlength="2000" placeholder="Power spikes, what to avoid, when to fight, what worked last time…">${esc(note ? note.text : '')}</textarea>
                <div class="ch-muted" id="ch-note-state">${note ? 'Saved ' + (DD.ago ? DD.ago(note.at) : new Date(note.at).toLocaleDateString()) : 'Saved automatically.'}</div></div>
            </div>`;
    }
    function matchupsHtml() {
        const d = S.data, list = common(d.matchups).slice();
        const sorters = { best: (a, b) => b.mean - a.mean, worst: (a, b) => a.mean - b.mean, played: (a, b) => b.share - a.share, name: (a, b) => a.name.localeCompare(b.name) };
        list.sort(sorters[S.sort] || sorters.best);
        return `<div class="ch-controls"><label><input type="checkbox" data-opt="common"${S.common ? ' checked' : ''}> Common opponents only (played in 1%+ of ${ROLE_LABEL[S.role]} games)</label>
            <label>Sort <select data-opt="sort">${[['best', 'Best first'], ['worst', 'Worst first'], ['played', 'Most played'], ['name', 'Name']].map(([k, n]) => `<option value="${k}"${S.sort === k ? ' selected' : ''}>${n}</option>`).join('')}</select></label></div>
            <table class="ch-table">${pairHead(`${ROLE_LABEL[S.role]} opponent`, 'against')}<tbody>${list.map(x => pairRow({ ...x, role: S.role }, 'against')).join('') || '<tr><td colspan="7" class="ch-muted">No lane matchups with enough games.</td></tr>'}</tbody></table>
            <p class="ch-note">${d.excluded ? `${d.excluded} opponent${d.excluded === 1 ? '' : 's'} with fewer than ${d.minGames} games (Min Games) are not listed. ` : ''}Adjusted Δ is the lane effect with the same sample-size adjustment as Shrunk Δ in the draft; Exp WR adds ${esc(nameOf(S.champ))}'s own strength. Click a row for that champion's page.</p>`;
    }
    function synergiesHtml() {
        const d = S.data;
        const cards = ROLES.filter(r => r !== S.role).map(r => {
            const l = common(d.synergies[r] || []).slice().sort((a, b) => b.mean - a.mean);
            const duo = (S.role === 'BOTTOM' && r === 'SUPPORT') || (S.role === 'SUPPORT' && r === 'BOTTOM');
            // teammates use the duo prior for Bot + Support and the plain ally prior otherwise (the jungle class is for enemies only)
            return `<div class="ch-card"><div class="ch-card-h">With ${ROLE_LABEL[r]}${duo ? ' <span class="ch-tag">duo</span>' : ''}</div>
                <table class="ch-table compact">${pairHead('Partner', 'with')}<tbody>${l.slice(0, 6).map(x => pairRow({ ...x, role: r }, 'with')).join('') || '<tr><td colspan="7" class="ch-muted">Not enough games.</td></tr>'}</tbody></table></div>`;
        }).join('');
        return `<div class="ch-controls"><label><input type="checkbox" data-opt="common"${S.common ? ' checked' : ''}> Common partners only (played in 1%+ of that role's games)</label></div>
            <div class="ch-cols">${cards}</div><p class="ch-note">Ally effects are smaller than lane effects and shrink harder (their own prior). Bot + Support uses the duo prior.</p>`;
    }

    // ------------------------------------------------------------------------------------------------ Builds tab
    // The summary follows the Time Period (Coachless data is Emerald+ and per patch, so the Rank does not change it): the period is
    // part of the key, so a change made in any view is picked up the next time the tab is drawn.
    const buildsKey = () => { const tp = document.getElementById('time-period-select'); return `${S.champ}|${S.role}|${(tp && tp.value) || 'patch'}`; };
    // "16.17–16.20 · 16.19 missing": the patches the period covers as one range, plus the ones with no saved data for this champion
    const rangeOf = list => (DD.patchLabels && DD.patchLabels.range ? DD.patchLabels.range(list || []) : (list || []).join(', '));
    const patchSpan = b => rangeOf(b.patches) + (DD.patchLabels && DD.patchLabels.missingNote && Array.isArray(b.missing) ? DD.patchLabels.missingNote(b.missing) : '');
    async function loadBuilds() {
        const key = buildsKey();
        if (S.builds && S.builds.key === key) return;
        S.builds = { key, loading: true }; paint();
        let r = null;
        try { r = DD.buildsSummary ? await DD.buildsSummary(S.champ, S.role) : null; } catch (e) { r = { error: e.message }; }
        if (S.builds.key !== key) return;
        S.builds = Object.assign({ key }, r || { error: 'Builds are not available.' });
        paint();
    }
    function buildsHtml() {
        const b = S.builds;
        if (!b || b.loading || b.key !== buildsKey()) { setTimeout(loadBuilds, 0); return '<div class="ch-empty">Reading saved builds…</div>'; }
        if (b.error) return `<div class="ch-empty">${esc(b.error)}</div>`;
        const open = `<button class="ch-btn" data-act="builds">${b.saved ? 'Open the full builds' : 'Download in Builds'} ›</button>`;
        if (!b.saved) return `<div class="ch-empty"><p>No Coachless data saved for ${esc(nameOf(S.champ))} ${ROLE_LABEL[S.role]} (${esc(rangeOf(b.patches) || 'this patch')}). It is downloaded on demand, one champion and role at a time, when you open it in Builds.</p>${open}</div>`;
        const icon = (i, extra) => `<span class="ch-item" title="${esc(i.name)}${extra ? ' · ' + esc(extra) : ''}"><img src="${esc(i.img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">${i.wpa != null ? `<em class="${sign(i.wpa)}">${pts(i.wpa)}</em>` : ''}</span>`;
        return `<div class="ch-controls"><span>${Math.round(b.games).toLocaleString()} Emerald+ games · patch${b.patches.length > 1 ? 'es' : ''} ${esc(patchSpan(b))} · Coachless WPA ${help('wpa')}</span>${open}</div>
            <div class="ch-cols">${b.groups.map(g => `<div class="ch-card"><div class="ch-card-h">${esc(g.title)}</div><div class="ch-items">${g.items.map(i => icon(i)).join('')}</div></div>`).join('')}
            ${b.keystone ? `<div class="ch-card"><div class="ch-card-h">Keystone</div><div class="ch-items">${icon(b.keystone, `taken in ${pct(b.keystone.pick, 0)} of games`)}</div><div class="ch-muted">${esc(b.keystone.name)}</div></div>` : ''}
            ${b.spells.length ? `<div class="ch-card"><div class="ch-card-h">Summoner spells</div><div class="ch-items">${b.spells.map(s => icon({ ...s, wpa: null }, `taken in ${pct(s.pick, 0)} of games`)).join('')}</div></div>` : ''}</div>
            ${coachingHtml()}
            <p class="ch-note">Items by WPA adjusted for sample size (the Builds view's Recommended Item Set). WPA is in percentage points.</p>`;
    }

    // ------------------------------------------------------------------------------------------------ My stats tab
    // "Which account is mine?" is answered once, in the main process (profile:owner: the client's account, else the last one seen,
    // else Settings > Default account), so this page, the Duo tab and the Profile cannot disagree.
    async function ownerAccount() {
        let fb = null;
        try { const s = await window.electronAPI.getSettings(); if (s && s.profileAccount && s.profileAccount.gameName && s.profileAccount.tagLine) fb = { gameName: s.profileAccount.gameName, tagLine: s.profileAccount.tagLine, platform: s.profileAccount.platform || 'EUW1' }; } catch (e) { /* none */ }
        try {
            const r = await api.invoke('profile:owner', fb ? { fallback: fb } : {});
            if (r && r.ok && r.owner) return { gameName: r.owner.gameName, tagLine: r.owner.tagLine, platform: r.owner.platform, puuid: r.owner.puuid || undefined };
        } catch (e) { /* the main process could not answer: use the setting */ }
        return fb;
    }
    async function loadMine() {
        if (S.mine && S.mine.champ === S.champ) return;
        const c = champOf(S.champ);
        S.mine = { champ: S.champ, loading: true }; paint();
        let r;
        const acct = await ownerAccount();
        if (!acct) r = { ok: false, error: 'No account yet: start the League client, or set your Riot ID in Settings > Default account.' };
        else r = await api.invoke('profile:champ-summary', { champId: Number(c && c.key), ...acct }).catch(e => ({ ok: false, error: e.message }));
        if (!S.mine || S.mine.champ !== S.champ) return;
        S.mine = Object.assign({ champ: S.champ, acct }, r);
        paint();
    }
    function mineHtml() {
        const m = S.mine;
        if (!m || m.loading) { setTimeout(loadMine, 0); return '<div class="ch-empty">Reading your games…</div>'; }
        if (!m.ok) return `<div class="ch-empty">${esc(m.error || 'Could not read your games.')}</div>`;
        const who = m.acct ? `${esc(m.acct.gameName)}#${esc(m.acct.tagLine)}` : 'you';
        if (!m.games) return `<div class="ch-empty"><p>No games of ${who} on ${esc(nameOf(S.champ))} in the ${m.totalCached} games saved in Profile.</p><p class="ch-muted">Open Profile and use "Load season history" to save more of your games (needs a Riot API key).</p></div>`;
        const kda = m.d ? (m.k + m.a) / m.d : null, n = m.games;
        const roles = Object.entries(m.roles).sort((a, b) => b[1] - a[1]).map(([p, g]) => `${ROLE_LABEL[POS_ROLE[p]] || 'other'} ${g}`).join(' · ');
        const ago = t => (DD.ago ? DD.ago(t) : new Date(t).toLocaleDateString());
        return `<div class="ch-grid">
            <div class="ch-card"><div class="ch-card-h">${who} on ${esc(nameOf(S.champ))}</div><div class="ch-big ${m.w / n >= 0.5 ? 'delta-pos' : 'delta-neg'}">${pct(m.w / n, 0)}</div>
                <div class="ch-muted">${m.w}W ${n - m.w}L in ${n} saved game${n === 1 ? '' : 's'}</div>
                <div class="ch-kv"><span>KDA</span><b>${kda == null ? 'Perfect' : kda.toFixed(2)} <span class="ch-muted">${(m.k / n).toFixed(1)} / ${(m.d / n).toFixed(1)} / ${(m.a / n).toFixed(1)}</span></b></div>
                <div class="ch-kv"><span>CS / min</span><b>${m.mins ? (m.cs / m.mins).toFixed(1) : '–'}</b></div>
                <div class="ch-kv"><span>Kill participation</span><b>${Math.round(m.kp / n)}%</b></div>
                <div class="ch-kv"><span>DD Score ${help('dd-score')}</span><b>${m.score == null ? '–' : m.score.toFixed(1)} <span class="ch-muted">${m.mvp} MVP · ${m.ace} ACE</span></b></div>
                <div class="ch-kv"><span>Roles</span><b>${esc(roles)}</b></div></div>
            ${curveHtml(m.curve)}${vsOppHtml(m.vsOpp)}
            <div class="ch-card ch-wide"><div class="ch-card-h">Recent games</div>${m.last.map(g => `<div class="ch-game ${g.win ? 'w' : 'l'}"><b>${g.win ? 'Win' : 'Loss'}</b>
                <span>${g.k}/${g.d}/${g.a}</span><span class="ch-muted">${esc(ROLE_LABEL[POS_ROLE[g.pos]] || '')}</span><span>${g.sc == null ? '' : 'DD ' + g.sc.toFixed(1)}${g.bd === 'MVP' || g.bd === 'ACE' ? ` <i class="ch-badge">${g.bd}</i>` : ''}</span><span class="ch-muted">${ago(g.end)}</span></div>`).join('')}</div>
            </div><p class="ch-note">From the games saved in Profile (${m.totalCached} in total). The draft's "You" column uses your League client history: see Overview.</p>`;
    }

    // learning curve on this champion (leagueofgraphs-style) and your record against each lane opponent, from your saved games
    function curveHtml(curve) {
        if (!curve || !curve.some(b => b.n)) return '';
        return `<div class="ch-card"><div class="ch-card-h">Learning curve <span class="ch-muted">win rate by game number</span></div>${curve.map(b => `<div class="ch-kv"><span>${esc(b.label)}</span><b class="${b.wr == null ? '' : b.wr >= 0.5 ? 'delta-pos' : 'delta-neg'}">${b.n ? Math.round(b.wr * 100) + '%' : '–'} <span class="ch-muted">${b.n} game${b.n === 1 ? '' : 's'}</span></b></div>`).join('')}</div>`;
    }
    function vsOppHtml(vs) {
        const list = Object.entries(vs || {}).map(([k, v]) => ({ c: (DD.getChampions() || []).find(x => Number(x.key) === Number(k)), ...v })).filter(x => x.c).sort((a, b) => b.g - a.g).slice(0, 8);
        if (!list.length) return '';
        return `<div class="ch-card"><div class="ch-card-h">Against <span class="ch-muted">your lane opponents in these games</span></div>${list.map(x => `<div class="ch-mini ch-click" data-hub="${esc(x.c.id)}">${ico(x.c.id)}<span class="ch-mini-n">${esc(x.c.name)}</span><b class="${x.w / x.g >= 0.5 ? 'delta-pos' : 'delta-neg'}">${x.w}-${x.g - x.w}</b></div>`).join('')}</div>`;
    }

    // ------------------------------------------------------------------------------------------------ ARAM tab
    let ddItems = null;
    async function itemNames() {
        if (ddItems) return ddItems;
        try { const r = await fetch(`${DD.ddragonBase}/cdn/${DD.getLatestPatch()}/data/en_US/item.json`); ddItems = r.ok ? (await r.json()).data || {} : {}; } catch (e) { ddItems = {}; }
        return ddItems;
    }
    async function loadAram() {
        if (S.aram && S.aram.champ === S.champ) return;
        const c = champOf(S.champ);
        S.aram = { champ: S.champ, loading: true }; paint();
        let entry = null, champ = null, items = null;
        try { entry = window.DDAram && window.DDAram.entryFor ? await window.DDAram.entryFor(Number(c && c.key)) : null; } catch (e) { /* tier list unavailable */ }
        if (entry) [champ, items] = await Promise.all([api.invoke('aram:champion', { slug: entry.slug }).catch(e => ({ ok: false, error: e.message })), api.invoke('aram:items', { slug: entry.slug, tier: 'all' }).catch(e => ({ ok: false, error: e.message })), itemNames()]);
        if (!S.aram || S.aram.champ !== S.champ) return;
        S.aram = { champ: S.champ, entry, champ_: champ, items };
        paint();
    }
    function aramHtml() {
        const a = S.aram;
        if (!a || a.loading) { setTimeout(loadAram, 0); return '<div class="ch-empty">Loading ARAM Mayhem data…</div>'; }
        if (!a.entry) return `<div class="ch-empty">${esc(nameOf(S.champ))} is not in the ARAM Mayhem tier list (or arammayhem.com could not be reached).</div>`;
        const e = a.entry, d = e.wr - e.avgWr;
        const c = a.champ_ && a.champ_.ok ? a.champ_.data : null, li = a.items && a.items.ok ? a.items.data : null;
        const item = id => { const it = ddItems && ddItems[id]; return `<span class="ch-item" title="${esc(it ? it.name : '#' + id)}"><img src="${DD.ddragonBase}/cdn/${DD.getLatestPatch()}/img/item/${esc(id)}.png" alt="" loading="lazy" onerror="this.style.visibility='hidden'"></span>`; };
        // by win rate while arammayhem.com listed one; since 2026-10 in its order for the champion, with the augment's tier instead
        const augs = r => { if (!c) return []; const l = c.augments[r].filter(x => x.appearance == null || x.appearance >= 2); return (l.some(x => x.wr != null) ? l.sort((x, y) => (y.wr || 0) - (x.wr || 0)) : l.sort((x, y) => (x.order || 0) - (y.order || 0))).slice(0, 4); };
        const augVal = x => (x.wr != null ? x.wr.toFixed(1) + '%' : x.tier ? `${esc(x.tier)}${x.rank != null ? ' #' + x.rank : ''}` : '–');
        return `<div class="ch-grid">
            <div class="ch-card"><div class="ch-card-h">ARAM: Mayhem ${help('aram')}</div><div class="ch-big ${sign(d / 100)}">${e.wr.toFixed(2)}%</div>
                <div class="ch-muted">tier ${esc(e.tier)} · rank ${e.rank} of ${e.count} · ${d >= 0 ? '+' : ''}${d.toFixed(1)} vs the average</div>
                <div class="ch-muted ch-foot">patch ${esc(e.patch || '?')} · arammayhem.com</div></div>
            ${['prismatic', 'gold', 'silver'].map(r => `<div class="ch-card"><div class="ch-card-h">${r[0].toUpperCase() + r.slice(1)} augments</div>${augs(r).map(x => `<div class="ch-kv"><span>${esc(x.name)}</span><b>${augVal(x)} <span class="ch-muted">${x.appearance == null ? '' : x.appearance.toFixed(1) + '% seen'}</span></b></div>`).join('') || `<div class="ch-muted">${c ? 'None listed.' : 'Not available.'}</div>`}</div>`).join('')}
            <div class="ch-card"><div class="ch-card-h">Items <span class="ch-muted">LoLalytics, regular ARAM</span></div>${li && li.core ? `<div class="ch-items">${li.core.items.map(item).join('')}</div><div class="ch-muted">core build · ${li.core.wr == null ? '–' : li.core.wr.toFixed(1) + '%'} WR in regular ARAM (not Mayhem)</div>` : '<div class="ch-muted">Not available.</div>'}</div>
            </div><div class="ch-controls"><button class="ch-btn" data-act="aram">Open in ARAM Mayhem ›</button></div>`;
    }

    // build coaching (C8) lives in build-coach.js and draws into the Builds tab when it is loaded
    function coachingHtml() { return window.DDCoach && window.DDCoach.html ? window.DDCoach.html(S.champ, S.role, S.builds) : ''; }

    // ------------------------------------------------------------------------------------------------ events
    function onClick(e) {
        const vs = e.target.closest('[data-vs]');
        if (vs) { open(S.champ, S.role, { vs: vs.dataset.vs }); return; }
        if (e.target.closest('[data-swap]') && S.vs) { open(S.vs, S.role, { vs: S.champ }); return; }
        const hub = e.target.closest('[data-hub]');
        if (hub) { open(hub.dataset.hub, hub.dataset.hubRole || null); return; }
        const t = e.target.closest('[data-tab]');
        if (t) { S.tab = t.dataset.tab; paint(); return; }
        const r = e.target.closest('[data-role]');
        if (r && r.closest('.ch-roles')) { S.role = r.dataset.role; load(); return; }
        const a = e.target.closest('[data-act]');
        if (a) {
            const c = champOf(S.champ);
            if (a.dataset.act === 'builds' && DD.openBuilds) DD.openBuilds(S.champ, S.role);
            else if (a.dataset.act === 'builds-vs' && DD.openBuilds && S.vs) DD.openBuilds(S.champ, S.role, S.vs);
            else if (a.dataset.act === 'aram' && window.DDAram && c) window.DDAram.selectByKey(Number(c.key));
        }
    }
    // notes save as you type (debounced); no repaint, so the cursor stays where it is
    let noteTimer = null;
    root.addEventListener('input', e => {
        if (!e.target.dataset || !e.target.dataset.note || !S.vs || !DD.setMatchupNote) return;
        const champ = S.champ, vs = S.vs, text = e.target.value;
        clearTimeout(noteTimer);
        noteTimer = setTimeout(() => DD.setMatchupNote(champ, vs, text).then(() => { const st = root.querySelector('#ch-note-state'); if (st) st.textContent = text.trim() ? 'Saved just now' : 'Note removed'; }).catch(() => {}), 600);
    });
    function onChange(e) {
        const o = e.target.dataset && e.target.dataset.opt;
        if (o === 'common') { S.common = e.target.checked; paint(); }
        else if (o === 'sort') { S.sort = e.target.value; paint(); }
    }
    // the hub follows the Time Period / Rank selection: re-read when it changes while the page is shown, and when it is shown again
    for (const id of ['time-period-select', 'rank-select']) {
        const sel = document.getElementById(id);
        if (sel) sel.addEventListener('change', () => { if (DD.currentView() === 'champion' && S.champ && sel.value !== 'range-pick') setTimeout(load, 0); });
    }
    DD.onView((name, prev) => { if (name === 'champion' && prev !== 'champion' && S.champ && !S.loading) load(); else if (name === 'champion') paint(); });
    window.addEventListener('builds-updated', () => { if (S.builds) { S.builds = null; if (DD.currentView() === 'champion' && S.tab === 'builds') paint(); } });
    window.addEventListener('coach-updated', e => { if (DD.currentView() === 'champion' && S.tab === 'builds' && e.detail && e.detail.champ === S.champ) paint(); });
    // a game of yours was saved in Profile (the post-game refresh): My stats and the matchup page's record are read again
    if (api) api.on('profile:update', ev => {
        if (!ev || ev.kind !== 'matches' || !S.mine) return;
        if (!ev.owner && !(S.mine.acct && S.mine.acct.puuid && ev.puuid === S.mine.acct.puuid)) return;
        S.mine = null;
        if (DD.currentView() === 'champion' && (S.tab === 'mine' || S.tab === 'vs')) paint();
    });
    (async () => {
        try { const s = await window.electronAPI.getSettings(); if (s && Array.isArray(s.hubRecent)) S.recent = s.hubRecent.filter(x => typeof x === 'string').slice(0, 8); if (s && s.hubLast && !S.champ) { S.champ = s.hubLast.champ; S.role = s.hubLast.role || null; lastSaved = `${S.champ}|${S.role || ''}`; } } catch (e) { /* none */ }
        if (DD.currentView() === 'champion') { await DD.ready; if (S.champ) load(); else paint(); }
    })();

    window.DDHub = { open, openMatchup: (champ, role, vs) => open(champ, role, { vs }), state: S, reload: load, paint, setTab: t => { if (TABS.some(x => x[0] === t)) { S.tab = t; paint(); } } };
})();
