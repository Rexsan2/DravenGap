// desktop-app/onboarding.js
// First-run setup check (FEATURES3 B6, FEEDBACK B10): a small 4-step card that shows what works and what to do about the rest.
//   1. League client found           profile:me (falls back to lcu:status)
//   2. Riot API key works            get-riot-key-status, then one profile:test-key request when a key is saved (optional step)
//   3. Default account               settings.profileAccount, filled in from the client; saved with DD.patchSettings
//   4. Draft data downloaded         DD.draftDataStatus(): current patch, Emerald+ (the only rank this card ever downloads)
// It opens by itself once (settings key onboardingDone not set) and only when something needs attention; Skip / Done set
// onboardingDone. After that it only opens when asked: Settings > "Run setup check again" or the Ctrl+K palette ("Run setup check").
// It is a floating card, not a dialog: the app stays usable behind it.
//   DD.onboarding = { open(), close(), isOpen(), runChecks(), finish(), state }
(function () {
    'use strict';
    const DD = window.DD, api = window.electronAPI;
    if (!DD || !api || !api.feature) return;
    const feat = api.feature;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const PLATFORMS = ['EUW1', 'EUN1', 'NA1', 'KR', 'BR1', 'LA1', 'LA2', 'OC1', 'TR1', 'RU', 'JP1', 'PH2', 'SG2', 'TH2', 'TW2', 'VN2', 'ME1'];
    const RIOT_ID_RE = /^([^#]{3,16}?)\s*#\s*([A-Za-z0-9]{3,5})$/;   // same rule as Settings > Default account
    const STEPS = [['client', 'League client'], ['key', 'Riot API key'], ['account', 'Default account'], ['data', 'Draft data']];
    if (window.electronAPI && window.electronAPI.builtinKey) STEPS.splice(1, 1);   // personal build: the key is built in, no step for it
    const ICON = { ok: '✓', todo: '!', fail: '✕', opt: '–', wait: '…' };
    const S = { open: false, min: false, res: {}, tok: {}, me: null, draft: null, msg: '', seq: 0, el: null, last: 0 };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const ago = iso => { const t = Date.parse(iso || ''); if (!t) return ''; const m = Math.round((Date.now() - t) / 60000); return m < 2 ? 'just now' : m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };

    // ------------------------------------------------------------------ the four checks
    // each returns { st: 'ok' | 'todo' | 'fail' | 'opt' | 'wait', text, actions?: [{ label, ob }], form? }
    async function checkClient() {
        let r = null;
        try { r = await feat.invoke('profile:me'); } catch (e) { /* handled below */ }
        if (r && r.ok && r.me && r.me.gameName) {
            S.me = r.me;
            return { st: 'ok', text: `Found. Signed in as ${r.me.gameName}#${r.me.tagLine}${r.me.platform ? ` (${r.me.platform})` : ''}.` };
        }
        if (r && r.ok && r.lcu) return { st: 'todo', text: 'The client is open but nobody is signed in yet. Sign in, then check again.', actions: [{ label: 'Check again', ob: 'recheck:client' }] };
        let s = null;
        try { s = await feat.invoke('lcu:status'); } catch (e) { /* none */ }
        if (s && s.ok) return { st: 'ok', text: 'Found. The League client is running.' };
        S.me = null;
        return { st: 'todo', text: 'League client not found. Start it and sign in (it can take up to a minute to be noticed). Live Tracking, Send to client and the "You" column need it; everything else works without.', actions: [{ label: 'Check again', ob: 'recheck:client' }] };
    }
    async function checkKey() {
        let k = null;
        try { k = await api.getRiotKeyStatus(); } catch (e) { /* none */ }
        if (!k || !k.set) return { st: 'opt', text: 'No key saved. Optional: a key from developer.riotgames.com unlocks Profile lookups, Multi-search and your full match history.', actions: [{ label: 'Open Settings', ob: 'settings' }] };
        setStep('key', { st: 'wait', text: 'Testing the saved key…' });
        let r = null;
        try { r = await feat.invoke('profile:test-key'); } catch (e) { r = { ok: false, error: e.message }; }
        if (r && r.ok) return { st: 'ok', text: `Saved (…${k.hint || ''}) and accepted by Riot.` };
        const code = r && r.code;
        if (code === 'KEY_REJECTED') return { st: 'fail', text: 'Riot rejected the saved key. Development keys expire after 24 hours: paste a fresh one.', actions: [{ label: 'Open Settings', ob: 'settings' }, { label: 'Test again', ob: 'recheck:key' }] };
        if (code === 'OFFLINE') return { st: 'todo', text: 'A key is saved, but Riot could not be reached to test it. Check your connection.', actions: [{ label: 'Test again', ob: 'recheck:key' }] };
        if (code === 'RATE_LIMITED') return { st: 'todo', text: 'A key is saved. Riot is rate limiting right now, so it was not tested.', actions: [{ label: 'Test again', ob: 'recheck:key' }] };
        return { st: 'fail', text: `A key is saved, but the test failed: ${(r && r.error) || 'unknown error'}.`, actions: [{ label: 'Open Settings', ob: 'settings' }, { label: 'Test again', ob: 'recheck:key' }] };
    }
    async function checkAccount() {
        let acc = null;
        try { const s = await api.getSettings(); acc = s && s.profileAccount; } catch (e) { /* none */ }
        if (acc && acc.gameName) {
            S.draft = null;
            return { st: 'ok', text: `${acc.gameName}#${acc.tagLine || ''} on ${acc.platform || 'EUW1'}. Profile opens on this account.` };
        }
        if (!S.draft) S.draft = { id: S.me ? `${S.me.gameName}#${S.me.tagLine}` : '', platform: (S.me && S.me.platform) || 'EUW1', typed: false };
        else if (!S.draft.typed && S.me) S.draft = { id: `${S.me.gameName}#${S.me.tagLine}`, platform: S.me.platform || S.draft.platform, typed: false };
        return { st: 'todo', form: true, text: S.me ? 'Taken from the League client. Save it so Profile opens on you.' : 'Type your Riot ID (Name#TAG) and region so Profile opens on you.' };
    }
    async function checkData() {
        if (!DD.draftDataStatus) return { st: 'opt', text: 'Not available in this window.' };
        let d;
        try { d = await DD.draftDataStatus(); } catch (e) { return { st: 'fail', text: `Could not read the saved data: ${e.message}`, actions: [{ label: 'Check again', ob: 'recheck:data' }] }; }
        if (!d.patch) return { st: 'wait', text: 'Waiting for the app to finish loading…' };
        const label = `Patch ${d.patch} ${d.rankLabel}`;
        if (d.saved) return { st: 'ok', text: `${label} is saved on this PC${d.games ? ` (${Math.round(d.games).toLocaleString()} games${d.savedAt ? ', ' + ago(d.savedAt) : ''})` : ''}. The app keeps it fresh.` };
        if (d.offline) return { st: 'fail', text: `${label} is not saved yet and the data source can't be reached. Connect to the internet, then check again.`, actions: [{ label: 'Check again', ob: 'recheck:data' }] };
        return { st: 'todo', text: `${label} is not downloaded yet${d.others && d.others.length ? ` (you have ${d.others.join(', ')})` : ''}. It is one download from the shared data bucket; only this rank is fetched.`, actions: [{ label: 'Download now', ob: 'download' }] };
    }
    const CHECKS = { client: checkClient, key: checkKey, account: checkAccount, data: checkData };

    // ------------------------------------------------------------------ running them
    function setStep(id, res) { S.res[id] = res; paintStep(id); paintFoot(); }
    async function runOne(id) {
        const t = S.tok[id] = (S.tok[id] || 0) + 1;      // a newer check of the same step replaces an older one
        let res;
        try { res = await CHECKS[id](); } catch (e) { res = { st: 'fail', text: `Check failed: ${e.message}` }; }
        if (t === S.tok[id]) setStep(id, res);
        return res;
    }
    async function runChecks(only) {
        const seq = ++S.seq;
        let ids = (only ? [].concat(only) : STEPS.map(s => s[0])).filter(id => STEPS.some(s => s[0] === id));
        if (ids.includes('client') && !ids.includes('account')) ids = [...ids, 'account'];   // the account is filled in from the client
        for (const id of ids) S.res[id] = { st: 'wait', text: 'Checking…' };
        paint();
        if (ids.includes('client')) await runOne('client');                         // the account step reads what the client reported
        await Promise.all(ids.filter(id => id !== 'client').map(runOne));
        return seq === S.seq ? { ...S.res } : null;
    }
    const needsAttention = () => STEPS.some(([id]) => S.res[id] && (S.res[id].st === 'todo' || S.res[id].st === 'fail'));

    // ------------------------------------------------------------------ card
    function ensureEl() {
        if (S.el) return S.el;
        const el = document.createElement('div');
        el.id = 'onboarding-card';
        el.className = 'ob-card';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Setup check');
        el.style.display = 'none';
        el.innerHTML = `<div class="ob-head"><b>Setup check</b><span class="ob-sub">Four quick checks. None of them blocks the app.</span>
                <button type="button" class="ob-x" data-ob="min" title="Minimize" aria-label="Minimize">&minus;</button><button type="button" class="ob-x" data-ob="skip" title="Close (skip for now)" aria-label="Close">&times;</button></div>
            <div class="ob-body"><ol class="ob-steps">${STEPS.map(([id]) => `<li class="ob-step wait" data-step="${id}"></li>`).join('')}</ol>
            <div class="ob-msg" id="ob-msg" aria-live="polite"></div>
            <div class="ob-foot" id="ob-foot"></div></div>`;
        document.body.appendChild(el);
        el.addEventListener('click', onClick);
        el.addEventListener('input', e => {
            if (e.target.id === 'ob-riotid') S.draft = { ...(S.draft || {}), id: e.target.value, typed: true };
        });
        el.addEventListener('change', e => { if (e.target.id === 'ob-region') S.draft = { ...(S.draft || {}), platform: e.target.value, typed: true }; });
        el.addEventListener('keydown', e => { if (e.target.id === 'ob-riotid' && e.key === 'Enter') { e.preventDefault(); saveAccount(); } });
        return (S.el = el);
    }
    function stepHtml(id, title, n) {
        const r = S.res[id] || { st: 'wait', text: 'Checking…' };
        const form = r.form && S.draft ? `<div class="ob-form"><input type="text" id="ob-riotid" class="ob-in" placeholder="Name#TAG" value="${esc(S.draft.id)}" autocomplete="off" spellcheck="false" aria-label="Riot ID">
                <select id="ob-region" aria-label="Region">${PLATFORMS.map(p => `<option${p === S.draft.platform ? ' selected' : ''}>${p}</option>`).join('')}</select>
                <button type="button" class="ob-b main" data-ob="save-account">Save</button></div>` : '';
        const acts = (r.actions || []).map((a, i) => `<button type="button" class="ob-b${i === 0 && r.st !== 'ok' ? ' main' : ''}" data-ob="${esc(a.ob)}">${esc(a.label)}</button>`).join('');
        return `<span class="ob-ico" aria-hidden="true">${ICON[r.st] || '?'}</span>
            <div class="ob-main"><div class="ob-t">${n}. ${esc(title)}${id === 'key' ? ' <span class="ob-opt">optional</span>' : ''}<span class="ob-st">${{ ok: 'OK', todo: 'To do', fail: 'Problem', opt: 'Not set', wait: 'Checking' }[r.st] || ''}</span></div>
            <div class="ob-x2">${esc(r.text || '')}</div>${form}${acts ? `<div class="ob-acts">${acts}</div>` : ''}</div>`;
    }
    function paintStep(id) {
        if (!S.el) return;
        const li = S.el.querySelector(`[data-step="${id}"]`);
        if (!li) return;
        const r = S.res[id] || { st: 'wait' };
        li.className = `ob-step ${r.st}`;
        const typed = li.querySelector('#ob-riotid');            // keep a half-typed Riot ID when the step repaints
        const focus = document.activeElement === typed;
        li.innerHTML = stepHtml(id, STEPS.find(s => s[0] === id)[1], STEPS.findIndex(s => s[0] === id) + 1);
        if (focus) { const t = li.querySelector('#ob-riotid'); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }
    }
    function paintFoot() {
        if (!S.el) return;
        const foot = S.el.querySelector('#ob-foot');
        const allOk = STEPS.every(([id]) => S.res[id] && (S.res[id].st === 'ok' || S.res[id].st === 'opt'));
        foot.innerHTML = `<span class="ob-hint">Run it again any time from Settings or Ctrl+K.</span>
            <button type="button" class="ob-b" data-ob="recheck-all">Check again</button>
            <button type="button" class="ob-b${allOk ? ' main' : ''}" data-ob="${allOk ? 'finish' : 'skip'}">${allOk ? 'Done' : 'Skip for now'}</button>`;
        S.el.querySelector('#ob-msg').textContent = S.msg || '';
    }
    function paint() {
        const el = ensureEl();
        el.classList.toggle('min', S.min);
        STEPS.forEach(([id]) => paintStep(id));
        paintFoot();
    }

    // ------------------------------------------------------------------ actions
    function setMsg(t) { S.msg = t || ''; const m = S.el && S.el.querySelector('#ob-msg'); if (m) m.textContent = S.msg; }
    async function saveAccount() {
        const d = S.draft || {}, m = RIOT_ID_RE.exec(String(d.id || '').trim());
        if (!m) { setMsg('Use the format Name#TAG (name 3 to 16 characters, tag 3 to 5 letters or digits).'); return; }
        const acc = { gameName: m[1].trim(), tagLine: m[2], platform: d.platform || 'EUW1' };
        await DD.patchSettings({ profileAccount: acc });
        setMsg(`Saved ${acc.gameName}#${acc.tagLine} (${acc.platform}).`);
        await runOne('account');
    }
    async function download() {
        setStep('data', { st: 'wait', text: 'Downloading… this takes a few seconds.' });
        let d = null;
        try { d = await DD.draftDataStatus({ ensure: true }); } catch (e) { d = { error: e.message }; }
        if (d && d.saved) { await runOne('data'); setMsg(''); return; }
        setStep('data', { st: 'fail', text: `The download did not finish${d && d.error ? ` (${d.error})` : ''}. Check your connection and try again.`, actions: [{ label: 'Try again', ob: 'download' }] });
    }
    function openSettingsFromCard() { const b = document.getElementById('settings-btn'); if (b) b.click(); }
    async function finish() {
        S.open = false; if (S.el) S.el.style.display = 'none';
        try { await DD.patchSettings({ onboardingDone: true, onboardingAt: Date.now() }); } catch (e) { console.warn('Could not save the setup state', e); }
    }
    function onClick(e) {
        const b = e.target.closest('[data-ob]');
        if (!b) return;
        const a = b.dataset.ob;
        if (a === 'min') { S.min = !S.min; S.el.classList.toggle('min', S.min); }
        else if (a === 'skip' || a === 'finish') { finish(); if (a === 'skip' && DD.toast) DD.toast('Setup check skipped. Run it again from Settings or Ctrl+K.'); }
        else if (a === 'recheck-all') { setMsg(''); runChecks(); }
        else if (a.startsWith('recheck:')) runChecks(a.slice(8));
        else if (a === 'settings') openSettingsFromCard();
        else if (a === 'save-account') saveAccount();
        else if (a === 'download') download();
    }

    function open() {
        const el = ensureEl();
        S.open = true; S.min = false; S.msg = '';
        el.style.display = '';
        paint();
        return runChecks();
    }
    function close() { S.open = false; if (S.el) S.el.style.display = 'none'; }

    // back from Settings / Saved data: the key, account and data may have changed
    function watchModals() {
        for (const id of ['settings-modal', 'storage-modal']) {
            const m = document.getElementById(id);
            if (!m) continue;
            new MutationObserver(() => { if (S.open && m.style.display === 'none') runChecks(id === 'settings-modal' ? ['key', 'account', 'data'] : ['data']); }).observe(m, { attributes: true, attributeFilter: ['style'] });
        }
    }
    window.addEventListener('focus', () => {                      // the user started the League client and came back
        if (S.open && !S.min && Date.now() - S.last > 5000 && S.res.client && S.res.client.st !== 'ok') { S.last = Date.now(); runChecks('client'); }
    });

    // ------------------------------------------------------------------ first run
    async function firstRun() {
        let s = {};
        try { s = (await api.getSettings()) || {}; } catch (e) { return; }
        if (s.onboardingDone) return;
        await DD.ready;
        for (let i = 0; i < 100; i++) {                           // let the first data load finish (the loading overlay goes away)
            const o = document.getElementById('loading-overlay');
            if (!o || o.style.display === 'none') break;
            await sleep(300);
        }
        await sleep(500);
        const seq = S.seq + 1;
        const res = await runChecks();
        if (!res || S.seq !== seq) return;                        // opened by hand meanwhile
        if (!needsAttention()) { await DD.patchSettings({ onboardingDone: true, onboardingAt: Date.now() }).catch(() => {}); return; }   // all good already: nothing to show
        open();
    }

    // Settings > "Run setup check again"
    document.addEventListener('click', e => {
        if (!e.target.closest || !e.target.closest('#onboarding-run-btn')) return;
        const c = document.getElementById('settings-close-btn'); if (c) c.click();
        open();
    });

    DD.onboarding = { open, close, isOpen: () => S.open, runChecks, finish, state: S };
    watchModals();
    firstRun();
})();
