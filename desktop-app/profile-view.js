// desktop-app/profile-view.js
// Renderer side of the Profile view (op.gg-style profiles + live game); renders into #profile-root only.
// Talks to profile-main.js through window.electronAPI.feature ('profile:*'). Data Dragon assets come from window.DD.
(function () {
    'use strict';
    const root = document.getElementById('profile-root');
    if (!root || !window.electronAPI || !window.electronAPI.feature || !window.DD) return;
    const api = window.electronAPI.feature;
    const DEFAULT_ACCOUNT = { gameName: 'LolalyticsDiff', tagLine: 'META', platform: 'EUW1' };
    const REGIONS = ['EUW1', 'EUN1', 'NA1', 'KR', 'BR1', 'LA1', 'LA2', 'OC1', 'TR1', 'RU', 'JP1', 'PH2', 'SG2', 'TH2', 'TW2', 'VN2', 'ME1'];
    const GROUP_ORDER = ['all', 'solo', 'flex', 'normal', 'aram', 'mayhem', 'arena'];
    const GROUP_LABEL = { all: 'All', solo: 'Ranked Solo', flex: 'Flex', normal: 'Normal', aram: 'ARAM', mayhem: 'ARAM Mayhem', arena: 'Arena' };
    const GROUP_QUEUES = { all: null, solo: [420], flex: [440], normal: [400, 430, 480, 490], aram: [450], mayhem: [2400], arena: [1700, 1710, 1750] };
    // "All" never adds Arena and the other non-5v5 modes (owner decision 2026-10-11); CS, gold and vision per minute use Summoner's Rift
    // queues only. profile:static sends the real lists (profile-compact.js) at start-up; these are the same values for the first paint.
    let ALL_EXCLUDE = [1700, 1710, 1750, 1800, 1810, 1820, 1830, 1840, 2000, 2010, 2020];
    let SR_Q = [400, 420, 430, 440, 480, 490, 700, 830, 840, 850, 1400];
    const qIn = (group, q) => { const l = GROUP_QUEUES[group]; return l ? l.includes(q) : !ALL_EXCLUDE.includes(q); };
    const isSr = q => SR_Q.includes(q);
    const isArena = m => !!m && (m.mode === 'CHERRY' || GROUP_QUEUES.arena.includes(m.queueId));
    const arenaHalf = m => m.winPlaces || (m.queueId === 1750 ? 3 : 4);   // places that count as a "win" (top half of the lobby)
    function applyGroups(stat) {
        const g = stat && stat.groups;
        if (g) { for (const k of GROUP_ORDER) if (g[k] && (g[k].queues === null || Array.isArray(g[k].queues))) GROUP_QUEUES[k] = g[k].queues; if (g.all && Array.isArray(g.all.exclude)) ALL_EXCLUDE = g.all.exclude; }
        if (stat && Array.isArray(stat.srQueues)) SR_Q = stat.srQueues;
    }
    const POS_LABEL = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', UTILITY: 'Support' };
    const UPDATE_COOLDOWN = 30000;

    const S = {
        inited: false, acct: null, profile: null, stale: false, group: 'all', matches: [], nextStart: 0, hasMore: false, loadingMatches: false, matchTok: 0,
        ledger: null, ledgerGroup: 'all', tab: 'summary', expanded: new Set(), error: null, loadingProfile: false, lastUpdate: 0, cooldownUntil: 0,
        live: null, liveLoading: false, liveBadge: false, livePhase: null, liveBuf: {}, backfill: null, recent: [], queues: {}, token: 0, scout: {}, seasons: null, seasonQ: 'RANKED_SOLO_5x5', seasonAll: false, seasonRec: false,
        mtab: {}, mpick: {}, tl: {}, rv: {}, played: null, liveOpen: new Set(),
        ins: null, insGroup: 'all', insSort: 'g', insLoading: false, bt: null,
        liveWho: 'viewed', liveBy: {}, liveTok: 0, owner: null, champFilter: null, goals: null, goalRole: null
    };
    const D = { versions: [], spells: {}, runes: {}, trees: {}, items: {}, itemVer: {}, ready: false, shards: {}, shardsAsked: false };

    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const num = n => (n == null ? '-' : Number(n).toLocaleString('en-US'));
    const patch = () => (window.DD.getLatestPatch && window.DD.getLatestPatch()) || (D.versions[0]) || '';
    const base = () => window.DD.ddragonBase || 'https://ddragon.leagueoflegends.com';
    const champByKey = () => { const m = new Map(); for (const c of (window.DD.getChampions() || [])) m.set(Number(c.key), c); return m; };
    let champMap = new Map();
    const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
    const kdaRatio = (k, d, a) => d === 0 ? (k + a > 0 ? 'Perfect' : '0.00') : ((k + a) / d).toFixed(2);
    const kdaNum = (k, d, a) => d === 0 ? Infinity : (k + a) / d;
    const fmtDur = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    function ago(ts) {
        const s = Math.max(0, (Date.now() - ts) / 1000);
        if (s < 60) return 'just now';
        if (s < 3600) return `${Math.floor(s / 60)}m ago`;
        if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
        if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
        return `${Math.floor(s / 86400 / 30)}mo ago`;
    }
    const idKey = a => `${a.platform}|${a.gameName.toLowerCase()}#${a.tagLine.toLowerCase()}`;

    // ---------- Data Dragon assets ----------
    function champImg(id) {
        const c = champMap.get(Number(id));
        return c ? `${base()}/cdn/${patch()}/img/champion/${c.image.full}` : '';
    }
    const champName = id => { const c = champMap.get(Number(id)); return c ? c.name : `#${id}`; };
    function icon(src, cls, title) { return src ? `<img class="${cls}" loading="lazy" src="${esc(src)}" alt="" title="${esc(title || '')}">` : `<span class="${cls} pf-empty" title="${esc(title || '')}"></span>`; }
    function itemImg(id) {
        if (!id) return '<span class="pf-item pf-empty"></span>';
        const v = D.itemVer[id] || patch();
        const nm = D.items[id] ? D.items[id].name : `Item ${id}`;
        return `<img class="pf-item" loading="lazy" data-item="${id}" data-vi="0" src="${base()}/cdn/${v}/img/item/${id}.png" alt="" title="${esc(nm)}">`;
    }
    // Items removed from the latest Data Dragon: walk back through older versions (like the Builds tab does).
    root.addEventListener('error', e => {
        const t = e.target;
        if (!t || t.tagName !== 'IMG') return;
        if (t.dataset.item && D.versions.length) {
            const i = (parseInt(t.dataset.vi, 10) || 0) + 1;
            if (i < 45 && D.versions[i]) {
                t.dataset.vi = i; t.src = `${base()}/cdn/${D.versions[i]}/img/item/${t.dataset.item}.png`;
                t.addEventListener('load', () => { D.itemVer[t.dataset.item] = D.versions[i]; }, { once: true });
                return;
            }
        }
        t.style.visibility = 'hidden';
    }, true);
    function spellImg(id) {
        const s = D.spells[id];
        return s ? icon(`${base()}/cdn/${patch()}/img/spell/${s.image.full}`, 'pf-spell', s.name) : icon('', 'pf-spell');
    }
    function runeImg(id, cls) {
        const r = D.runes[id] || D.trees[id];
        return r ? icon(`${base()}/cdn/img/${r.icon}`, cls || 'pf-rune', r.name) : icon('', cls || 'pf-rune');
    }
    async function loadStatic() {
        const b = base();
        const get = u => fetch(u).then(r => r.ok ? r.json() : null).catch(() => null);
        const [versions] = await Promise.all([get(`${b}/api/versions.json`)]);
        D.versions = Array.isArray(versions) ? versions : [];
        const v = patch() || D.versions[0];
        const [spells, runes, items] = await Promise.all([get(`${b}/cdn/${v}/data/en_US/summoner.json`), get(`${b}/cdn/${v}/data/en_US/runesReforged.json`), get(`${b}/cdn/${v}/data/en_US/item.json`)]);
        if (spells) for (const k of Object.keys(spells.data)) D.spells[spells.data[k].key] = spells.data[k];
        if (runes) for (const t of runes) { D.trees[t.id] = t; for (const sl of t.slots) for (const r of sl.runes) D.runes[r.id] = r; }
        if (items) D.items = items.data || {};
        D.ready = true;
    }
    function tierName(t) { return t ? t[0] + t.slice(1).toLowerCase() : 'Unranked'; }

    // ---------- rank emblems (fetched and cached by the main process; memoised here as blob URLs so repaints never flicker) ----------
    const EMB = { mini: new Map(), big: new Map(), asked: { mini: new Set(), big: new Set() } };
    const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
    const ALL_TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER', 'UNRANKED'];
    function toBlobUrl(dataUrl) {
        try {
            const i = dataUrl.indexOf(','), mime = dataUrl.slice(5, dataUrl.indexOf(';'));
            const bin = atob(dataUrl.slice(i + 1)), u8 = new Uint8Array(bin.length);
            for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
            return URL.createObjectURL(new Blob([u8], { type: mime }));
        } catch (e) { return dataUrl; }
    }
    // <img> for a tier; src is filled at once when the emblem is already known, else by hydrateEmblems() when it arrives
    function emb(tier, size, cls) {
        const t = ALL_TIERS.includes(tier) ? tier : 'UNRANKED', sz = size === 'big' ? 'big' : 'mini';
        const url = EMB[sz].get(t) || (sz === 'big' && t === 'UNRANKED' ? EMB.mini.get(t) : null);
        return `<img class="pf-emb pf-emb-${sz} ${cls || ''}" data-emb="${t}" data-sz="${sz}" ${url ? 'data-ready="1"' : ''} alt="${esc(tierName(tier === 'UNRANKED' ? null : tier))}" src="${url || BLANK}">`;
    }
    function hydrateEmblems() {
        let list; try { list = root.querySelectorAll('img[data-emb]'); } catch (e) { return; }
        for (const el of list) {
            const sz = el.dataset.sz, t = el.dataset.emb;
            const url = EMB[sz].get(t) || (sz === 'big' && t === 'UNRANKED' ? EMB.mini.get(t) : null);
            if (url && el.getAttribute('src') !== url) { el.src = url; el.setAttribute('data-ready', '1'); }
        }
    }
    async function ensureEmblems(size, tiers) {
        const want = [...new Set(tiers.filter(t => ALL_TIERS.includes(t) && !EMB[size].has(t) && !EMB.asked[size].has(t)))];
        if (size === 'big' && want.includes('UNRANKED')) want.splice(want.indexOf('UNRANKED'), 1);   // drawn from the mini crest
        if (!want.length) return;
        want.forEach(t => EMB.asked[size].add(t));
        const r = await api.invoke('profile:emblems', { tiers: want, size }).catch(() => null);
        if (!r || !r.ok) { want.forEach(t => EMB.asked[size].delete(t)); return; }   // allow a later retry
        for (const [t, d] of Object.entries(r.emblems || {})) if (typeof d === 'string' && d.startsWith('data:image/')) EMB[size].set(t, toBlobUrl(d));
        hydrateEmblems();
    }
    const rankTiers = list => (list || []).map(e => e && e.tier).filter(Boolean);


    // ---------- error presentation ----------
    function errHtml(e) {
        if (!e) return '';
        const map = {
            NO_KEY: ['No Riot API key', 'Add your personal Riot API key in Settings to look up players.'],
            KEY_REJECTED: ['Riot API key rejected', 'Personal keys can expire or be revoked. Paste a fresh key in Settings, then use "Test key".'],
            NOT_FOUND: ['Not found', e.error || 'That Riot ID was not found. Check the spelling, tag and region.'],
            RATE_LIMITED: ['Rate limited', e.error || 'Too many requests.'],
            OFFLINE: ['Offline', 'Could not reach the Riot API. Check your internet connection.'],
            BAD_INPUT: ['Check the Riot ID', e.error || 'Enter a Riot ID like Name#TAG.'],
            BAD_REGION: ['Region', e.error || 'Pick a region.'],
            NO_ACCOUNT: ['No account yet', e.error || 'Start the League client, or set your Riot ID in Settings > Default account.']
        };
        const m = map[e.code] || ['Something went wrong', e.error || 'Unexpected error'];
        let extra = '';
        if (e.code === 'RATE_LIMITED' && e.retryAt) extra = ` <span class="pf-retry" data-retry="${e.retryAt}"></span>`;
        return `<div class="pf-error pf-error-${esc(e.code || 'x')}"><b>${esc(m[0])}</b><span>${esc(m[1])}${extra}</span><button class="pf-btn" data-act="retry">Retry</button></div>`;
    }

    // ---------- layout shell ----------
    function shell() {
        root.innerHTML = `
        <div class="pf-wrap">
          <div class="pf-top">
            <button type="button" class="pf-btn pf-home" id="pf-home" data-act="home" style="display:none" title="Back to your own profile (Alt+Home)"></button>
            <form class="pf-search" autocomplete="off">
              <input class="pf-input" id="pf-q" placeholder="Riot ID, e.g. Name#TAG" spellcheck="false">
              <select class="pf-select" id="pf-region">${REGIONS.map(r => `<option>${r}</option>`).join('')}</select>
              <button class="pf-btn pf-primary" type="submit">Search</button>
            </form>
            <div class="pf-recent" id="pf-recent"></div>
            <div class="pf-grow"></div>
            <span class="pf-updated" id="pf-updated"></span>
            <button class="pf-btn" id="pf-update" data-act="update">Update</button>
            <button class="pf-btn pf-live-badge" id="pf-livebadge" data-act="golive" style="display:none">&#9679; In game - view live</button>
          </div>
          <div id="pf-body" class="pf-bodywrap"></div>
        </div>`;
        root.querySelector('.pf-search').addEventListener('submit', e => { e.preventDefault(); submitSearch(); });
        root.addEventListener('click', onClick);
    }

    function parseRiotId(text) {
        const t = String(text || '').trim(); const i = t.lastIndexOf('#');
        if (i < 1 || i === t.length - 1) return null;
        return { gameName: t.slice(0, i).trim(), tagLine: t.slice(i + 1).trim() };
    }
    function submitSearch() {
        const q = root.querySelector('#pf-q'), reg = root.querySelector('#pf-region');
        const id = parseRiotId(q.value);
        if (!id) { S.error = { code: 'BAD_INPUT', error: 'Enter a Riot ID like Name#TAG (the # and tag are required).' }; S.profile = null; paintBody(); return; }
        openAccount({ ...id, platform: reg.value });
    }

    // ---------- navigation / data loading ----------
    async function openAccount(acct, opts = {}) {
        const token = ++S.token;
        S.acct = acct; S.profile = null; S.matches = []; S.nextStart = 0; S.hasMore = false; S.ledger = null; S.error = null; S.tab = 'summary'; S.seasons = null; S.seasonAll = false; S.seasonRec = false;
        S.expanded = new Set(); S.mtab = {}; S.mpick = {}; S.tl = {}; S.rv = {}; S.played = null; S.live = null; S.group = 'all'; S.ledgerGroup = 'all'; S.loadingProfile = true; S.backfill = null;
        S.ins = null; S.bt = null; S.insLoading = false; S.champFilter = null;
        S.liveTok++; S.liveWho = 'viewed'; S.liveLoading = false;   // a late live answer for the previous profile is dropped
        S.matchTok++; S.loadingMatches = false; // abandon any match load still running for the previous account
        root.querySelector('#pf-q').value = `${acct.gameName}#${acct.tagLine}`;
        root.querySelector('#pf-region').value = acct.platform;
        paintBody();
        const r = await api.invoke('profile:lookup', { ...acct, force: !!opts.force }).catch(e => ({ ok: false, code: 'ERROR', error: e.message }));
        if (token !== S.token) return;
        S.loadingProfile = false;
        if (!r.ok) { S.error = r; paintBody(); return; }
        S.profile = r.profile; S.stale = r.stale; S.lastUpdate = Date.now();
        S.acct = { gameName: r.profile.gameName, tagLine: r.profile.tagLine, platform: r.profile.platform };
        root.querySelector('#pf-q').value = `${S.acct.gameName}#${S.acct.tagLine}`;
        addRecent(S.acct); noteOwnerIcon();
        paintBody();
        loadMatches(true, !!opts.force, token);
        loadSeasons(!!opts.force);
    }
    async function loadMatches(reset, refresh, token = S.token) {
        if (!S.profile) return;
        if (!reset && S.loadingMatches) return; // "Show more" while a page is loading: ignore
        // Every load gets its own token; a newer load (other account, queue tab, Update) supersedes this one,
        // and only the latest load clears the loading flag.
        const mt = ++S.matchTok;
        S.loadingMatches = true; if (reset) { S.matches = []; S.nextStart = 0; }
        paintMatches();
        const group = S.group, champ = S.champFilter;
        const r = await api.invoke('profile:matches', { puuid: S.profile.puuid, platform: S.profile.platform, group, start: S.nextStart, refresh: !!refresh, champId: champ }).catch(e => ({ ok: false, code: 'ERROR', error: e.message }));
        if (mt !== S.matchTok) return;
        S.loadingMatches = false;
        if (token !== S.token || group !== S.group || champ !== S.champFilter) return;
        if (!r.ok) { S.matchError = r; paintMatches(); return; }
        if (r.puuid && r.puuid !== S.profile.puuid) S.profile.puuid = r.puuid; // the id was re-resolved (API key changed)
        S.matchError = r.warning || null;
        const seen = new Set(S.matches.map(m => m.id));
        for (const m of r.matches) if (!seen.has(m.id)) S.matches.push(m);
        S.nextStart = r.nextStart; S.hasMore = r.hasMore;
        paintBody(); // left column (recent summary) depends on the matches too
        loadLedger(token);
    }
    async function loadLedger(token = S.token) {
        if (!S.profile) return;
        const r = await api.invoke('profile:ledger', { puuid: S.profile.puuid }).catch(() => null);
        if (token !== S.token || !r || !r.ok) return;
        S.ledger = r; paintLeft();
        if (S.tab === 'insights' && S.profile.isOwner && !(document.activeElement && document.activeElement.classList.contains('pf-goal-in'))) paintInsights();   // the goals card reads the ledger
        if (root.querySelector('#pf-right .pf-postgame')) paintMatches(); // the post-game card compares with the season averages
        loadPlayed(token);
    }
    // teammates seen in >= 2 cached games (cache only, no Riot requests; follows the queue filter of the champion card)
    async function loadPlayed(token = S.token) {
        if (!S.profile) return;
        const group = S.ledgerGroup, puuid = S.profile.puuid;
        const r = await api.invoke('profile:played', { puuid, platform: S.profile.platform, group }).catch(() => null);
        if (token !== S.token || !S.profile || S.profile.puuid !== puuid || group !== S.ledgerGroup) return;
        S.played = r && r.ok ? r : null; paintLeft();
    }
    // ---- which game does the Live game tab show? ----
    // 'viewed' = the profile on screen, 'me' = the account the League client is signed in to (the request carries no Riot ID, so the
    // main process reads the client). On your own profile they are the same game. Answers are kept per key so a late reply for another
    // profile never lands on the one on screen. The client saying "your game started" always means 'me', whoever's profile is open.
    const sameName = (a, b) => !!a && !!b && String(a.gameName).toLowerCase() === String(b.gameName).toLowerCase() && String(a.tagLine).toLowerCase() === String(b.tagLine).toLowerCase();
    const sameAcct = (a, b) => sameName(a, b) && String(a.platform || '').toUpperCase() === String(b.platform || '').toUpperCase();
    const onOwnProfile = () => !!(S.profile && S.profile.isOwner) || (!!S.owner && !!S.acct && sameAcct(S.acct, S.owner));
    const inMyGame = () => !!(S.livePhase && S.livePhase.active);
    const liveKey = who => (who === 'me' || !S.profile ? 'me' : 'v:' + idKey(S.acct));
    async function loadLive(force, who) {
        who = onOwnProfile() || !S.profile ? 'me' : (who || S.liveWho || 'viewed');
        S.liveWho = who;
        const key = liveKey(who), tok = ++S.liveTok, have = S.liveBy[key];
        S.liveLoading = true; S.live = have && !force ? have : null; paintLiveTab();
        const viewed = S.profile ? { gameName: S.profile.gameName, tagLine: S.profile.tagLine, platform: S.profile.platform } : null;
        const args = who === 'me' && !onOwnProfile() ? {} : (viewed || {});
        args.champs = (window.DD.getChampions() || []).map(c => [Number(c.key), String(c.name), String(c.id || c.name)]).filter(x => Number.isInteger(x[0]));
        const r = await api.invoke('profile:live', args).catch(e => ({ ok: false, code: 'ERROR', error: e.message }));
        if (tok !== S.liveTok) return;   // a newer request (or another profile) replaced this one; the main process streams only the newest
        S.liveLoading = false;
        const res = r.ok ? r : { error: r };
        res.who = who; res.platform = args.platform || (S.owner && S.owner.platform) || (S.acct && S.acct.platform) || 'EUW1';
        S.liveBy[key] = res;
        const prevKey = S.live && S.live.gameKey;
        S.live = res;
        S.liveAt = Date.now();
        if (r.ok && r.inGame) {
            if (prevKey !== r.gameKey) S.liveOpen = new Set();
            const buf = S.liveBuf[r.gameKey];
            if (buf) for (const ev of buf) applyLiveEvent(r, ev);
            if (who === 'me') S.liveBadge = true;
        }
        paintLiveTab();
    }
    function applyLivePatch(live, patchObj) {
        const p = live.game.players[patchObj.idx];
        if (p) { Object.assign(p, patchObj); if (!patchObj.stage || patchObj.stage === 'core') p.loaded = true; }
    }
    // one profile:progress event of the live game: a player patch, team overviews, premade groups, the final budget, or a roster upgrade
    function applyLiveEvent(live, ev) {
        if (ev.upgrade && ev.upgrade.game) { live.game = ev.upgrade.game; live.premades = []; live.teams = null; live.finished = false; live.budget = null; }
        if (ev.patch) applyLivePatch(live, ev.patch);
        if (ev.teams) live.teams = ev.teams;
        if (ev.premades) live.premades = ev.premades;
        if (ev.finished) { live.finished = true; live.budget = ev.budget || null; }
    }

    // ---------- Insights tab (profile:insights: cached games of this season; the draft check uses the draft view's model) ----------
    async function loadInsights(force) {
        if (!S.profile || S.insLoading) return;
        const token = S.token, puuid = S.profile.puuid, group = S.insGroup, champ = S.champFilter;
        S.insLoading = true; if (force) { S.ins = null; S.bt = null; } paintInsights();
        const r = await api.invoke('profile:insights', { puuid, group, champId: champ }).catch(e => ({ ok: false, error: e.message }));
        S.insLoading = false;
        if (token !== S.token || group !== S.insGroup) return;
        if (champ !== S.champFilter) { loadInsights(); return; }   // the filter changed while this was computed
        S.ins = r && r.ok ? r : { error: (r && r.error) || 'Could not compute insights.' };
        paintInsights();
        if (S.ins.draft && S.ins.draft.length && window.DD.draftWinChances) runBacktest(token, S.ins);
    }
    async function runBacktest(token, ins) {
        const games = ins.draft.slice(-300);
        S.bt = { loading: true, n: games.length }; paintInsights();
        let res;
        try { res = await window.DD.draftWinChances(games.map(g => ({ my: g.my, enemy: g.enemy }))); } catch (e) { res = null; }
        if (token !== S.token || S.ins !== ins) return;
        if (!res) { S.bt = { error: 'The draft data is not loaded yet (open Summoner\'s Rift once).' }; paintInsights(); return; }
        const pts = games.map((g, i) => ({ p: res.results[i] && res.results[i].wr, y: g.w ? 1 : 0, patch: g.patch })).filter(x => typeof x.p === 'number');
        if (!pts.length) { S.bt = { error: 'None of these games could be scored (champions missing from the selected dataset).', label: res.label }; paintInsights(); return; }
        const brier = pts.reduce((t, x) => t + (x.p - x.y) ** 2, 0) / pts.length;
        const acc = pts.filter(x => (x.p > 0.5) === (x.y === 1)).length / pts.length;
        const edges = [0, 0.47, 0.49, 0.51, 0.53, 1.01];
        const bins = edges.slice(0, -1).map((lo, i) => {
            const b = pts.filter(x => x.p >= lo && x.p < edges[i + 1]);
            const n = b.length, wr = n ? b.reduce((t, x) => t + x.y, 0) / n : null;
            return { lo, hi: edges[i + 1], n, pred: n ? b.reduce((t, x) => t + x.p, 0) / n : null, wr, se: n ? Math.sqrt(Math.max(wr * (1 - wr), 0.05) / n) : null };
        });
        const good = pts.filter(x => x.p >= 0.52), bad = pts.filter(x => x.p <= 0.48);
        const wrOf = l => l.length ? l.reduce((t, x) => t + x.y, 0) / l.length : null;
        S.bt = { label: res.label, n: pts.length, brier, skill: 1 - brier / 0.25, acc, bins, avgEdge: pts.reduce((t, x) => t + x.p, 0) / pts.length - 0.5,
            good: { n: good.length, wr: wrOf(good) }, bad: { n: bad.length, wr: wrOf(bad) }, patches: [...new Set(pts.map(x => x.patch))].filter(Boolean) };
        paintInsights();
    }
    const fmtPct = (v, d = 0) => v == null ? '–' : `${(v * 100).toFixed(d)}%`;
    const wrCls = v => v == null ? '' : v >= 0.5 ? 'pf-pos' : 'pf-neg';
    // "?" definition chip and data-source chip from glossary.js (empty strings if it is missing)
    const help = key => (window.DD && window.DD.help ? window.DD.help(key) : '');
    const provChip = (id, info) => (window.DD && window.DD.provChip ? window.DD.provChip(id, info) : '');
    function tile(label, value, sub, cls, tip) {
        return `<div class="pf-tile" title="${esc(tip || '')}"><span class="pf-tile-l">${label}</span><b class="${cls || ''}">${value}</b>${sub ? `<span class="pf-tile-s">${sub}</span>` : ''}</div>`;
    }
    function formChart(trend) {
        if (!trend || trend.length < 2) return '';
        // drawn at the panel's real width (1 unit = 1 px) and scaled evenly, so dots stay round and the text keeps its size
        const box = root.querySelector('#pf-insights'), W = Math.max(420, Math.min(1600, ((box && box.clientWidth) || 680) - 40)), H = 150, P = 24, n = trend.length;
        const x = i => P + i * (W - 2 * P) / (n - 1), yS = v => H - P - v / 10 * (H - 2 * P), yW = v => H - P - v * (H - 2 * P);
        const roll = trend.map((g, i) => { const w = trend.slice(Math.max(0, i - 9), i + 1); return w.filter(t => t.w).length / w.length; });
        const line = roll.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yW(v).toFixed(1)}`).join('');
        const dots = trend.map((g, i) => typeof g.sc === 'number'
            ? `<circle cx="${x(i).toFixed(1)}" cy="${yS(g.sc).toFixed(1)}" r="${g.bd ? 4.5 : 3}" class="${g.w ? 'w' : 'l'}${g.bd ? ' b' : ''}"><title>${esc(champName(g.c))} ${g.k}/${g.d}/${g.a} · DD Score ${g.sc.toFixed(1)}${g.bd ? ' · ' + g.bd : ''} · ${g.w ? 'Win' : 'Loss'} · ${esc(new Date(g.end).toLocaleDateString())}</title></circle>` : '').join('');
        const grid = [0.5].map(v => `<line x1="${P}" x2="${W - P}" y1="${yW(v)}" y2="${yW(v)}" class="mid"/>`).join('');
        return `<svg class="pf-form" viewBox="0 0 ${W} ${H}">${grid}<path d="${line}" class="roll"/>${dots}
            <text x="${P}" y="12" class="lab">DD Score per game (dots: blue win, red loss, ringed MVP/ACE) · line: win rate over the last 10</text></svg>`;
    }
    function champTable(list) {
        const cols = [['g', 'Games'], ['wr', 'WR'], ['kda', 'KDA'], ['kp', 'KP'], ['csMin', 'CS/m'], ['dmgMin', 'DMG/m'], ['goldMin', 'Gold/m'], ['visMin', 'Vis/m'], ['share', 'DMG%'], ['score', 'DD']];
        const k = S.insSort;
        const val = (c, key) => key === 'kda' ? (c.kda == null ? 99 : c.kda) : (c[key] == null ? -1 : c[key]);
        const rows = list.slice().sort((a, b) => val(b, k) - val(a, k) || b.g - a.g).slice(0, 25);
        return `<table class="pf-ctable"><thead><tr><th class="l">Champion</th>${cols.map(([key, l]) => `<th data-act="inssort" data-k="${key}" class="${k === key ? 'on' : ''}" title="Sort by ${l}">${l}</th>`).join('')}</tr></thead><tbody>
            ${rows.map(c => `<tr><td class="l">${icon(champImg(c.c), 'pf-pimg', champName(c.c))}${cfName(c.c, 'span')}</td><td>${c.g}</td>
              <td class="${wrCls(c.wr)}">${fmtPct(c.wr)}</td><td>${c.kda == null ? 'Perfect' : c.kda.toFixed(2)}</td><td>${fmtPct(c.kp)}</td>
              <td>${c.csMin == null ? '–' : c.csMin.toFixed(1)}</td><td>${Math.round(c.dmgMin)}</td><td>${c.goldMin == null ? '–' : Math.round(c.goldMin)}</td><td>${c.visMin == null ? '–' : c.visMin.toFixed(2)}</td><td>${fmtPct(c.share)}</td>
              <td class="${c.score == null ? '' : scoreCls(c.score)}">${c.score == null ? '–' : c.score.toFixed(1)}</td></tr>`).join('')}</tbody></table>`;
    }
    function rateBars(list) {
        return `<div class="pf-rbars">${list.map(r => `<div class="pf-rbar" title="${r.n} games${r.hours ? ' · ' + r.hours + 'h' : ''}"><span>${esc(r.label)}</span>
            <i><u style="width:${r.wr == null ? 0 : Math.round(r.wr * 100)}%" class="${r.wr == null ? '' : r.wr >= 0.5 ? 'w' : 'l'}"></u></i>
            <b class="${wrCls(r.wr)}">${r.n ? fmtPct(r.wr) : '–'}</b><em>${r.n}</em></div>`).join('')}</div>`;
    }
    function backtestCard() {
        const B = S.bt;
        let body;
        if (!B) body = '<div class="pf-muted">No full 5v5 Summoner\'s Rift games with positions in this selection.</div>';
        else if (B.loading) body = `<div class="pf-muted">Scoring ${B.n} drafts with the draft model…</div>`;
        else if (B.error) body = `<div class="pf-muted">${esc(B.error)}</div>`;
        else {
            body = `<div class="pf-bt-top">
                ${tile('Games scored', B.n, esc(B.label || ''))}
                ${tile('Picked the winner', fmtPct(B.acc), 'favoured side won', wrCls(B.acc), 'Share of games the team the model favoured (above 50%) won')}
                ${tile('Skill vs coin flip', `${B.skill >= 0 ? '+' : ''}${(B.skill * 100).toFixed(1)}%`, `Brier ${B.brier.toFixed(3)} vs 0.250`, B.skill > 0 ? 'pf-pos' : 'pf-neg', 'Brier skill score: 1 - Brier / 0.25. Above 0 = the probabilities beat always saying 50%.')}
                ${tile('Your average draft', `${B.avgEdge >= 0 ? '+' : ''}${(B.avgEdge * 100).toFixed(1)} pts`, 'model win chance minus 50%', B.avgEdge >= 0 ? 'pf-pos' : 'pf-neg')}</div>
              <table class="pf-ctable pf-bt"><thead><tr><th class="l">Model said</th><th>Games</th><th>Predicted</th><th>Actual WR</th><th class="l">± (1 SE)</th></tr></thead><tbody>
              ${B.bins.map(b => `<tr><td class="l">${b.lo === 0 ? 'under ' + fmtPct(b.hi) : b.hi > 1 ? fmtPct(b.lo) + ' +' : fmtPct(b.lo) + '–' + fmtPct(b.hi)}</td><td>${b.n}</td><td>${b.n ? fmtPct(b.pred, 1) : '–'}</td>
                <td class="${wrCls(b.wr)}">${b.n ? fmtPct(b.wr) : '–'}</td><td class="l pf-muted">${b.n ? '± ' + fmtPct(b.se) : ''}</td></tr>`).join('')}</tbody></table>
              <div class="pf-muted pf-foot">Good drafts (model ≥ 52%): ${B.good.n} games, won ${fmtPct(B.good.wr)} · bad drafts (≤ 48%): ${B.bad.n} games, won ${fmtPct(B.bad.wr)}.
                Uses the draft view's current data (${esc(B.label || '')}) for games from patch${B.patches.length > 1 ? 'es' : ''} ${esc(B.patches.slice(0, 4).join(', '))}${B.patches.length > 4 ? '…' : ''}; change Time Period / Rank there to re-test. Small samples are noisy: read the ± column.</div>`;
        }
        return `<div class="pf-card pf-wide"><div class="pf-card-h"><span>Draft model check</span><span class="pf-muted">does Exp WR predict your games?</span></div>${body}</div>`;
    }
    function paintInsights() {
        const el = root.querySelector('#pf-insights'); if (!el || !S.profile) return;
        const I = S.ins;
        const head = `<div class="pf-ins-head"><select class="pf-select pf-mini" data-act="insgroup">${GROUP_ORDER.map(g => `<option value="${g}" ${g === S.insGroup ? 'selected' : ''}>${GROUP_LABEL[g]}</option>`).join('')}</select>
            <span class="pf-muted" title="${S.insGroup === 'all' ? 'Arena and the other non-5v5 modes are not included. CS, gold and vision per minute use Summoner’s Rift games only.' : ''}">${I && I.n ? `${I.n} ${esc(GROUP_LABEL[S.insGroup] || '')} games${S.champFilter ? ` on <b>${esc(champName(S.champFilter))}</b>` : ''} this season (cached on this PC)${S.insGroup === 'all' ? ' · no Arena' : ''}` : ''}</span>${champFilterChip()}<span class="pf-grow"></span>
            <button class="pf-btn pf-small" data-act="insreload">Recalculate</button></div>`;
        if (!I || S.insLoading) { el.innerHTML = head + '<div class="pf-muted pf-pad">Crunching your games…</div>'; return; }
        if (I.error) { el.innerHTML = head + `<div class="pf-muted pf-pad">${esc(I.error)}</div>`; return; }
        const goals = S.profile.isOwner && !S.champFilter && S.insGroup !== 'arena' ? goalsCard() : '';   // from the season's games, whatever the queue tab
        if (!I.n) { el.innerHTML = head + goals + `<div class="pf-muted pf-pad">No cached games this season for this queue${S.champFilter ? ` on ${esc(champName(S.champFilter))}` : ''} yet. Use "Load season history" in the header.</div>`; return; }
        if (I.arena) { el.innerHTML = head + arenaInsightsHtml(I.arena); return; }
        const o = I.overall, L = I.lane, H = I.habits;
        const streak = H.streak ? `${H.streak.n} ${H.streak.win ? 'win' : 'loss'}${H.streak.n === 1 ? '' : (H.streak.win ? 's' : 'es')} in a row` : '';
        let html = head + goals + `<div class="pf-tiles">
            ${tile('Win rate', fmtPct(o.wr, 1), `${o.w}W ${o.g - o.w}L`, wrCls(o.wr))}
            ${tile('KDA', o.kda == null ? 'Perfect' : o.kda.toFixed(2), `${o.k.toFixed(1)} / ${o.d.toFixed(1)} / ${o.a.toFixed(1)}`)}
            ${tile('Kill participation', fmtPct(o.kp), 'of team kills')}
            ${tile('Damage share', fmtPct(o.share, 1), `${Math.round(o.dmgMin)} dmg/min`, '', 'Your share of your team’s damage to champions')}
            ${tile('Gold / min', o.goldMin == null ? '–' : Math.round(o.goldMin), o.csMin == null ? 'no Summoner’s Rift games' : `${o.csMin.toFixed(1)} CS/min`, '', 'CS, gold and vision per minute use Summoner’s Rift games only')}
            ${tile('Vision / min', o.visMin == null ? '–' : o.visMin.toFixed(2), 'vision score', '', 'Summoner’s Rift games only')}
            ${tile('Deaths / 10 min', o.deaths10.toFixed(2), 'lower is better')}
            ${tile('DD Score' + help('dd-score'), o.score == null ? '–' : o.score.toFixed(2), `${o.mvp} MVP · ${o.ace} ACE`, o.score == null ? '' : scoreCls(o.score), SCORE_TIP)}
            ${tile('Streak', streak || '–', `${H.sessions} sessions, ${H.avgSession.toFixed(1)} games each`, H.streak ? (H.streak.win ? 'pf-pos' : 'pf-neg') : '')}</div>`;
        html += `<div class="pf-card pf-wide"><div class="pf-card-h"><span>Form</span><span class="pf-muted">last ${I.trend.length} games</span></div>${formChart(I.trend)}</div>`;
        html += `<div class="pf-ins-grid">`;
        html += `<div class="pf-card"><div class="pf-card-h"><span>Roles</span></div><table class="pf-ctable"><thead><tr><th class="l">Role</th><th>Games</th><th>WR</th><th>KDA</th><th>DD</th></tr></thead><tbody>
            ${I.roles.map(r => `<tr><td class="l">${POS_LABEL[r.pos] || r.pos}</td><td>${r.g}</td><td class="${wrCls(r.wr)}">${fmtPct(r.wr)}</td><td>${r.kda == null ? 'Perfect' : r.kda.toFixed(2)}</td><td class="${r.score == null ? '' : scoreCls(r.score)}">${r.score == null ? '–' : r.score.toFixed(1)}</td></tr>`).join('') || '<tr><td class="l pf-muted" colspan="5">No positions recorded</td></tr>'}</tbody></table></div>`;
        html += `<div class="pf-card"><div class="pf-card-h"><span>Lane vs your opponent</span><span class="pf-muted">${L.n} games</span></div>
            ${L.n ? `<div class="pf-lane-sum">Ahead in gold at the end in <b class="${wrCls(L.aheadGold)}">${fmtPct(L.aheadGold)}</b> of games · average <b class="${L.avgGold >= 0 ? 'pf-pos' : 'pf-neg'}">${L.avgGold >= 0 ? '+' : ''}${Math.round(L.avgGold)}</b> gold, ${L.avgCs >= 0 ? '+' : ''}${L.avgCs.toFixed(0)} CS
              <br>Win rate when ahead <b class="${wrCls(L.wrAhead)}">${fmtPct(L.wrAhead)}</b> · when behind <b class="${wrCls(L.wrBehind)}">${fmtPct(L.wrBehind)}</b></div>
              <div class="pf-opps">${L.opponents.map(x => `<div class="pf-opp" title="${esc(champName(x.c))}: ${x.g} games, ${x.w} won, ${Math.round(x.gold)} average gold difference">${icon(champImg(x.c), 'pf-pimg', champName(x.c))}<b class="${wrCls(x.wr)}">${fmtPct(x.wr)}</b><span>${x.g}g</span></div>`).join('')}</div>
              <div class="pf-muted pf-foot">Most-met lane opponents (your win rate against them). End-of-game gold includes everything after lane.</div>` : '<div class="pf-muted">No games with a known lane opponent.</div>'}</div>`;
        html += `<div class="pf-card"><div class="pf-card-h"><span>Habits</span><span class="pf-muted">tilt, sessions, timing</span></div>
            <div class="pf-tilt">After a win: <b class="${wrCls(H.afterWin.wr)}">${H.afterWin.n ? fmtPct(H.afterWin.wr) : '–'}</b> <span class="pf-muted">(${H.afterWin.n})</span> · after a loss: <b class="${wrCls(H.afterLoss.wr)}">${H.afterLoss.n ? fmtPct(H.afterLoss.wr) : '–'}</b> <span class="pf-muted">(${H.afterLoss.n})</span>
              ${H.afterWin.n >= 10 && H.afterLoss.n >= 10 && H.afterWin.wr - H.afterLoss.wr >= 0.08 ? '<div class="pf-warn">You win clearly less right after a loss: a short break may pay off.</div>' : ''}</div>
            <div class="pf-sub-h">Game in session</div>${rateBars(H.sessionPos)}
            <div class="pf-sub-h">Time of day</div>${rateBars(H.timeOfDay)}
            <div class="pf-sub-h">Game length</div>${rateBars(H.length)}</div>`;
        html += `</div>`;
        html += `<div class="pf-ins-grid">${vsLaneCard(I.vsLane)}${curveCard(I.curve)}${lengthCard()}${S.profile.isOwner ? lpCard() : ''}</div>`;
        html += `<div class="pf-card pf-wide"><div class="pf-card-h"><span>Champions</span><span class="pf-muted">click a column to sort · click a portrait for builds</span></div>${champTable(I.champions)}</div>`;
        html += backtestCard();
        el.innerHTML = html;
        if (S.profile.isOwner && !S.lp && !S.lpLoading) loadLp();
    }
    // Arena: placement instead of win / loss; the "win" of the mode is the better half of the lobby (top 3 of 6 teams, top 4 of 8)
    function arenaInsightsHtml(A) {
        const max = Math.max(1, ...A.dist), mid = ((A.places || 8) + 1) / 2;
        const halfText = (A.lobbies || [8]).map(n => `top ${n / 2} of ${n}`).join(' or ');
        let h = `<div class="pf-tiles">
            ${tile('Games', A.n, 'Arena this season')}
            ${tile('Average placement', A.avgPlace.toFixed(2), `1st is best, ${ordinal(A.places || 8)} is worst`, A.avgPlace <= mid ? 'pf-pos' : 'pf-neg', `The middle of the field is ${mid}`)}
            ${tile('Top-half rate', fmtPct(A.topHalf), `placed in the better half (${halfText} teams)`, wrCls(A.topHalf))}
            ${tile('1st place', A.firsts, `${fmtPct(A.n ? A.firsts / A.n : null)} of games`)}
            ${tile('KDA', A.kda == null ? 'Perfect' : A.kda.toFixed(2), 'kills + assists per death')}</div>`;
        h += `<div class="pf-card pf-wide"><div class="pf-card-h"><span>Placements</span><span class="pf-muted">how often you finished in each place</span></div>
            <div class="pf-arena-dist">${A.dist.map((n, i) => `<div title="${ordinal(i + 1)}: ${n} game${n === 1 ? '' : 's'}"><span>${n}</span><i class="${i < (A.places || 8) / 2 ? 'w' : 'l'}" style="height:${Math.round(n / max * 70)}px"></i><b>${ordinal(i + 1)}</b></div>`).join('')}</div></div>`;
        h += `<div class="pf-card pf-wide"><div class="pf-card-h"><span>Champions</span><span class="pf-muted">click a portrait for builds</span></div>
            <table class="pf-ctable"><thead><tr><th class="l">Champion</th><th>Games</th><th>Avg place</th><th>Top half</th><th>1st</th></tr></thead><tbody>
            ${A.champions.slice(0, 25).map(c => `<tr><td class="l">${icon(champImg(c.c), 'pf-pimg', champName(c.c))}${cfName(c.c, 'span')}</td><td>${c.g}</td><td>${c.avg.toFixed(2)}</td>
              <td class="${wrCls(c.topHalf)}">${fmtPct(c.topHalf)}</td><td>${c.first}</td></tr>`).join('')}</tbody></table></div>`;
        if (A.duos && A.duos.length) h += `<div class="pf-card pf-wide"><div class="pf-card-h"><span>Duo partners</span><span class="pf-muted">2+ games together</span></div>
            ${A.duos.map(d => `<div class="pf-pw"><a class="pf-plink" data-act="open" data-n="${esc(d.name)}" data-t="${esc(d.tag)}">${esc(d.name)}<i>#${esc(d.tag)}</i></a><span>${d.g}</span><span class="pf-muted">avg ${d.avg.toFixed(1)}</span><b class="${wrCls(d.topHalf)}">${fmtPct(d.topHalf)} top half</b></div>`).join('')}</div>`;
        return h;
    }
    // Strengths and areas to improve (iTero-style coaching): your stats minus your lane opponent's in the same games
    function vsLaneCard(V) {
        if (!V) return '';
        const fmt = (s, v) => `${v >= 0 ? '+' : ''}${s.k === 'kp' ? v.toFixed(1) : v.toFixed(s.digits)}${s.unit}`;
        const line = s => `<div class="pf-vs ${s.verdict}"><span>${esc(s.label)}</span><b class="${s.verdict === 'strength' ? 'pf-pos' : s.verdict === 'weakness' ? 'pf-neg' : ''}">${s.mean == null ? '–' : fmt(s, s.mean)}</b>
            <em>${s.mean == null ? `needs ${8} games` : `better in ${Math.round(s.ahead * 100)}% of games`}</em></div>`;
        const st = V.strengths.map(s => esc(s.label.toLowerCase())), wk = V.weaknesses.map(s => esc(s.label.toLowerCase()));
        const sum = !V.n ? '' : `<div class="pf-vs-sum">${st.length ? `<b class="pf-pos">Strengths:</b> ${st.join(', ')}. ` : ''}${wk.length ? `<b class="pf-neg">Work on:</b> ${wk.join(', ')}.` : ''}${!st.length && !wk.length ? 'Level with your lane opponents in every stat (no gap is clearly beyond noise).' : ''}</div>`;
        return `<div class="pf-card"><div class="pf-card-h"><span>Strengths and areas to improve</span><span class="pf-muted">you minus your lane opponent · ${V.n} games</span></div>
            ${V.n ? sum + V.stats.map(line).join('') : '<div class="pf-muted">No games with a known lane opponent yet.</div>'}
            <div class="pf-muted pf-foot">Per minute where it applies. Marked green / red only when the gap is a real one: at least a fifth of its game-to-game spread and twice its noise. Your opponents are the same rank as you, so this is a fair yardstick.</div></div>`;
    }
    // Learning curve (leagueofgraphs-style): win rate by how many times you had played the champion
    // ---------- goals (your own profile): CS / min, deaths / 10 min and vision / min per role, today / last 7 days / season ----------
    // From the season's saved games (ledger rows), Summoner's Rift queues only. Targets are yours (settings.goals[role]); until you
    // set one it is a small step from your season average. Support has no CS goal.
    const GOAL_METRICS = [['csMin', 'CS / min', 1, 1], ['d10', 'Deaths / 10 min', 1, -1], ['visMin', 'Vision / min', 2, 1]];   // key, label, decimals, better (+1 higher, -1 lower)
    function goalAgg(rows) {
        let min = 0, cs = 0, d = 0, vis = 0;
        for (const r of rows) { min += (r.dur || 0) / 60; cs += r.cs || 0; d += r.d || 0; vis += r.vis || 0; }
        return min > 0 ? { g: rows.length, csMin: cs / min, d10: d / min * 10, visMin: vis / min } : { g: 0 };
    }
    function goalData() {
        const rows = ((S.ledger && S.ledger.rows) || []).filter(r => !r.rm && isSr(r.q) && POS_LABEL[r.pos]);
        if (!rows.length) return null;
        const now = Date.now(), day = new Date(); day.setHours(0, 0, 0, 0);
        const count = {};
        for (const r of rows) if (now - r.end < 30 * 864e5) count[r.pos] = (count[r.pos] || 0) + 1;
        const all = {}; for (const r of rows) all[r.pos] = (all[r.pos] || 0) + 1;
        const roles = Object.keys(all).filter(p => all[p] >= 5).sort((a, b) => (count[b] || 0) - (count[a] || 0) || all[b] - all[a]);
        if (!roles.length) return null;
        const role = roles.includes(S.goalRole) ? S.goalRole : roles[0];
        const mine = rows.filter(r => r.pos === role);
        return { role, roles, season: goalAgg(mine), week: goalAgg(mine.filter(r => now - r.end < 7 * 864e5)), today: goalAgg(mine.filter(r => r.end >= day.getTime())) };
    }
    function defaultGoal(key, season, role) {
        if (key === 'csMin') return role === 'UTILITY' ? null : Math.round(((season.csMin || 0) + 0.5) * 10) / 10;
        if (key === 'd10') return Math.round((season.d10 || 0) * 0.9 * 10) / 10;
        return Math.round(((season.visMin || 0) + 0.1) * 100) / 100;
    }
    function goalsCard() {
        const G = goalData();
        if (!G) return '';
        const set = (S.goals && S.goals[G.role]) || {};
        const cell = (v, key, target, better, dec) => {
            if (v == null || !isFinite(v)) return '<td class="pf-muted">–</td>';
            const hit = target == null ? null : better > 0 ? v >= target : v <= target;
            return `<td class="${hit == null ? '' : hit ? 'pf-pos' : 'pf-neg'}">${v.toFixed(dec)}</td>`;
        };
        const rowsHtml = GOAL_METRICS.map(([key, label, dec, better]) => {
            const target = set[key] != null ? set[key] : defaultGoal(key, G.season, G.role);
            if (target == null) return '';
            return `<tr><td class="l">${label}<span class="pf-muted"> ${better > 0 ? '(higher is better)' : '(lower is better)'}</span></td>
              <td><input class="pf-goal-in" type="number" step="${dec === 2 ? '0.05' : '0.1'}" min="0" data-act="goal" data-k="${key}" data-role="${G.role}" value="${target}" title="Your target${set[key] == null ? ' (suggested: a small step from your season average; type your own)' : ''}"></td>
              ${cell(G.today[key], key, target, better, dec)}${cell(G.week[key], key, target, better, dec)}${cell(G.season[key], key, target, better, dec)}</tr>`;
        }).join('');
        const sel = G.roles.length > 1 ? `<select class="pf-select pf-mini" data-act="goalrole">${G.roles.map(p => `<option value="${p}"${p === G.role ? ' selected' : ''}>${POS_LABEL[p]}</option>`).join('')}</select>` : `<span class="pf-muted">${POS_LABEL[G.role]}</span>`;
        return `<div class="pf-card pf-wide pf-goals"><div class="pf-card-h"><span>Goals</span>${sel}<span class="pf-muted">Summoner’s Rift games · green = target met</span></div>
            <table class="pf-ctable"><thead><tr><th class="l">Target</th><th>Goal</th><th>Today (${G.today.g || 0})</th><th>Last 7 days (${G.week.g || 0})</th><th>Season (${G.season.g})</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`;
    }
    async function loadGoals() { try { const s = await window.electronAPI.getSettings(); S.goals = (s && s.goals) || {}; } catch (e) { S.goals = {}; } }
    async function saveGoal(role, key, value) {
        const v = Number(value);
        S.goals = S.goals || {};
        const g = { ...(S.goals[role] || {}) };
        if (value === '' || !isFinite(v) || v < 0) delete g[key]; else g[key] = v;
        S.goals = { ...S.goals, [role]: g };
        try { if (window.DD.patchSettings) await window.DD.patchSettings({ goals: S.goals }); } catch (e) { /* kept for this session */ }
        paintInsights();
    }
    // Win rate by game length, this player: the season's saved games of the Insights queue (and champion),
    // in LoLalytics' buckets. Few games per bucket: the W-L is shown and nothing is concluded under 10 games.
    const LEN_BUCKETS = [['<15', 0, 15], ['15-20', 15, 20], ['20-25', 20, 25], ['25-30', 25, 30], ['30-35', 30, 35], ['35-40', 35, 40], ['40+', 40, 1e9]];
    function lengthCard() {
        const since = (S.ledger && S.ledger.seasonStart) || 0;
        const rows = ((S.ledger && S.ledger.rows) || []).filter(r => !r.rm && r.end >= since && qIn(S.insGroup, r.q) && !(r.pl > 0) && (!S.champFilter || r.c === S.champFilter));
        if (rows.length < 10) return '';
        const b = LEN_BUCKETS.map(([label, lo, hi]) => { const g = rows.filter(r => r.dur / 60 >= lo && r.dur / 60 < hi); return { label, n: g.length, w: g.filter(r => r.w).length }; });
        const max = Math.max(...b.map(x => x.n), 1);
        return `<div class="pf-card"><div class="pf-card-h"><span>By game length</span><span class="pf-muted">${rows.length} games · minutes</span></div>
            <table class="pf-ctable"><thead><tr><th class="l">Length</th><th>Games</th><th>W-L</th><th>WR</th></tr></thead><tbody>
            ${b.map(x => `<tr><td class="l">${x.label}<span class="pf-lenbar" style="width:${Math.round(x.n / max * 60)}px"></span></td><td>${x.n}</td><td>${x.n ? `${x.w}-${x.n - x.w}` : '–'}</td><td class="${x.n >= 10 ? wrCls(x.w / x.n) : 'pf-muted'}">${x.n ? fmtPct(x.w / x.n) : '–'}</td></tr>`).join('')}</tbody></table>
            <div class="pf-muted pf-foot">Grey: under 10 games, too few to read anything into.</div></div>`;
    }
    function curveCard(C) {
        if (!C || !C.some(b => b.n)) return '';
        return `<div class="pf-card"><div class="pf-card-h"><span>Learning curve</span><span class="pf-muted">your win rate by game number on a champion</span></div>${rateBars(C)}
            <div class="pf-muted pf-foot">Counted among the games saved here, oldest first: "Games 1–3" are your first three saved games on each champion. A big jump from the first games to later ones means new picks cost you games.</div></div>`;
    }
    // LP history (op.gg / dpm.lol style): your LP change per ranked game, recorded from the League client
    async function loadLp() {
        S.lpLoading = true;
        const r = await api.invoke('profile:lp-history').catch(() => null);
        S.lpLoading = false;
        S.lp = r && r.ok ? r : { list: [], error: true };
        if (S.tab === 'insights') paintInsights();
    }
    function lpCard() {
        const L = S.lp;
        if (!L) return `<div class="pf-card"><div class="pf-card-h"><span>LP history</span></div><div class="pf-muted">Loading…</div></div>`;
        const q = S.insGroup === 'flex' ? 'RANKED_FLEX_SR' : 'RANKED_SOLO_5x5';
        const list = (L.list || []).filter(e => e.q === q && e.after);
        if (!list.length) return `<div class="pf-card"><div class="pf-card-h"><span>LP history</span><span class="pf-muted">${q === 'RANKED_FLEX_SR' ? 'Flex' : 'Solo/Duo'}</span></div>
            <div class="pf-muted">Nothing recorded yet. DravenGap reads your LP from the League client before and after every ranked game (and notes dodges), so the graph starts with your next ranked game.</div></div>`;
        const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND'], DIV = { IV: 0, III: 1, II: 2, I: 3 };
        const score = x => (TIERS.indexOf(x.tier) >= 0 ? TIERS.indexOf(x.tier) * 400 + (DIV[x.rank] || 0) * 100 + Math.min(99, x.lp) : 2800 + x.lp);
        const pts = list.slice(-60), ys = pts.map(e => score(e.after));
        const lo = Math.min(...ys) - 20, hi = Math.max(...ys) + 20, W = 520, H = 120, P = 18;
        const x = i => P + (pts.length < 2 ? (W - 2 * P) / 2 : i * (W - 2 * P) / (pts.length - 1)), y = v => H - P - (v - lo) / Math.max(1, hi - lo) * (H - 2 * P);
        const path = ys.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
        const lines = [];
        for (let t = Math.ceil(lo / 100) * 100; t <= hi; t += 100) lines.push(`<line x1="${P}" x2="${W - P}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" class="mid"/><text x="${W - P + 2}" y="${(y(t) + 3).toFixed(1)}" class="lab">${t >= 2800 ? 'M+' : TIERS[Math.floor(t / 400)][0] + (4 - (Math.floor(t / 100) % 4))}</text>`);
        const last = pts[pts.length - 1], net = pts.reduce((t, e) => t + (e.delta || 0), 0);
        return `<div class="pf-card"><div class="pf-card-h"><span>LP history</span><span class="pf-muted">${q === 'RANKED_FLEX_SR' ? 'Flex' : 'Solo/Duo'} · last ${pts.length} recorded</span></div>
            <svg class="pf-form pf-lp" viewBox="0 0 ${W + 24} ${H}">${lines.join('')}<path d="${path}" class="roll"/>${pts.map((e, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(ys[i]).toFixed(1)}" r="3" class="${e.dodge ? 'b' : e.win ? 'w' : 'l'}"><title>${e.dodge ? 'Dodge' : e.win ? 'Win' : 'Loss'} ${e.delta == null ? '' : (e.delta >= 0 ? '+' : '') + e.delta + ' LP'} · ${esc(new Date(e.at).toLocaleString())}</title></circle>`).join('')}</svg>
            <div class="pf-lp-sum">Now <b>${esc(last.after.tier.charAt(0) + last.after.tier.slice(1).toLowerCase())} ${esc(last.after.rank)} ${last.after.lp} LP</b> · net <b class="${net >= 0 ? 'pf-pos' : 'pf-neg'}">${net >= 0 ? '+' : ''}${net} LP</b> over these games
              · last: ${pts.slice(-8).reverse().map(e => `<span class="${e.delta >= 0 ? 'pf-pos' : 'pf-neg'}">${e.delta == null ? '?' : (e.delta >= 0 ? '+' : '') + e.delta}${e.dodge ? ' (dodge)' : ''}</span>`).join(' ')}</div></div>`;
    }

    // ---------- the owner ("which account is mine?"): one answer from the main process (profile:owner), used at start-up, by the Home button and the palette ----------
    function acctOf(o) { return { gameName: o.gameName, tagLine: o.tagLine, platform: o.platform || 'EUW1' }; }
    async function refreshOwner() {
        const st = await readSettings(), pa = st.profileAccount;
        const fb = pa && pa.gameName && pa.tagLine ? { gameName: pa.gameName, tagLine: pa.tagLine, platform: pa.platform || 'EUW1' } : null;
        const [r, me] = await Promise.all([api.invoke('profile:owner', fb ? { fallback: fb } : {}).catch(() => null), api.invoke('profile:me').catch(() => null)]);
        let o = null;
        if (r && r.ok && r.owner) o = { ...r.owner, source: r.source };
        else if (fb) o = { ...fb, source: 'settings' };
        if (o) {
            const m = me && me.ok && me.me;
            const keep = S.owner && sameName(S.owner, o) ? S.owner.icon : undefined;
            o.icon = m && m.profileIconId != null && sameName(m, o) ? m.profileIconId : keep;
            if (me && me.ok && !S.livePhase && ACTIVE_PHASE.has(me.phase)) S.livePhase = { active: true, phase: me.phase };
        }
        S.owner = o;
        paintHome();
        return o;
    }
    const ACTIVE_PHASE = new Set(['GameStart', 'InProgress', 'Reconnect']);
    function noteOwnerIcon() {
        if (S.owner && S.profile && S.profile.profileIconId != null && sameName(S.acct, S.owner)) { S.owner.icon = S.profile.profileIconId; paintHome(); }
    }
    // the Home button: your icon and Riot ID; hidden while your own profile is open
    function paintHome() {
        const b = root.querySelector('#pf-home'); if (!b) return;
        const o = S.owner;
        if (!o || onOwnProfile()) { b.style.display = 'none'; return; }
        const ic = o.icon != null ? `${base()}/cdn/${patch()}/img/profileicon/${o.icon}.png` : '';
        const sig = `${o.gameName}#${o.tagLine}|${ic}`;
        if (b.dataset.sig === sig && b.style.display !== 'none') return;   // painted every second by paintTop: rebuild only on a change
        b.dataset.sig = sig;
        b.innerHTML = (ic ? `<img class="pf-home-img" src="${esc(ic)}" alt="">` : '<span class="pf-home-glyph" aria-hidden="true">&#8962;</span>') + `<span>${esc(o.gameName)}<i>#${esc(o.tagLine)}</i></span>`;
        b.title = `Back to your own profile (${o.gameName}#${o.tagLine}, Alt+Home)`;
        b.style.display = '';
    }
    async function openOwner() {
        const o = await refreshOwner();
        if (!o) { S.acct = null; S.profile = null; S.error = { code: 'NO_ACCOUNT' }; paintBody(); return; }
        if (S.profile && S.acct && sameAcct(S.acct, o)) { paintTop(); return; }   // already there
        return openAccount(acctOf(o));
    }

    // ---------- recents ----------
    async function readSettings() { try { return (await window.electronAPI.getSettings()) || {}; } catch (e) { return {}; } }
    async function addRecent(a) {
        S.recent = [a, ...S.recent.filter(x => idKey(x) !== idKey(a))].slice(0, 8);
        paintRecent();
        try { if (window.DD.patchSettings) await window.DD.patchSettings({ profileRecent: S.recent }); } catch (e) { /* settings are a convenience */ }
    }
    function paintRecent() {
        const el = root.querySelector('#pf-recent'); if (!el) return;
        el.innerHTML = S.recent.map((a, i) => `<button class="pf-chip" data-act="recent" data-i="${i}" title="${esc(a.platform)}">${esc(a.gameName)}<i>#${esc(a.tagLine)}</i></button>`).join('');
    }

    // ---------- painting ----------
    function paintBody() {
        const body = root.querySelector('#pf-body'); if (!body) return;
        if (S.error && !S.profile) { body.innerHTML = errHtml(S.error); paintTop(); startTick(); return; }
        if (!S.acct) { body.innerHTML = '<div class="pf-empty-state">Search a Riot ID to see a profile.</div>'; paintTop(); return; }
        if (S.loadingProfile || !S.profile) { body.innerHTML = skeleton(); paintTop(); return; }
        body.innerHTML = `
          ${headerHtml()}
          <div class="pf-tabs">
            <button class="pf-tab ${S.tab === 'summary' ? 'on' : ''}" data-act="tab" data-t="summary">Summary</button>
            <button class="pf-tab ${S.tab === 'insights' ? 'on' : ''}" data-act="tab" data-t="insights" title="Your season in numbers: form, roles, champions, lane, habits, and how well the draft model predicts your games">Insights</button>
            <button class="pf-tab ${S.tab === 'live' ? 'on' : ''}" data-act="tab" data-t="live">Live game${S.liveBadge ? ' <span class="pf-dot"></span>' : ''}</button>
          </div>
          <div id="pf-insights" style="${S.tab === 'insights' ? '' : 'display:none'}"></div>
          <div id="pf-summary" style="${S.tab === 'summary' ? '' : 'display:none'}">
            <div class="pf-cols"><div class="pf-left" id="pf-left"></div><div class="pf-right" id="pf-right"></div></div>
          </div>
          <div id="pf-live" style="${S.tab === 'live' ? '' : 'display:none'}"></div>`;
        paintLeft(); paintMatches(); paintLiveTab(); paintInsights(); paintTop(); startTick();
    }
    function paintTop() {
        const u = root.querySelector('#pf-update'), lab = root.querySelector('#pf-updated'), lb = root.querySelector('#pf-livebadge');
        if (!u) return;
        const left = S.cooldownUntil - Date.now();
        u.disabled = !S.profile || left > 0;
        u.textContent = left > 0 ? `Update (${Math.ceil(left / 1000)}s)` : 'Update';
        lab.textContent = S.profile ? `${S.stale ? 'Refreshing... ' : ''}Last updated ${ago(S.lastUpdate)}` : '';
        lb.style.display = S.liveBadge && S.tab !== 'live' ? '' : 'none';
        paintRecent(); paintHome();
    }
    function skeleton() {
        return `<div class="pf-skel"><div class="pf-sk-head"></div><div class="pf-cols"><div class="pf-left">${'<div class="pf-sk-card"></div>'.repeat(3)}</div><div class="pf-right">${'<div class="pf-sk-row"></div>'.repeat(6)}</div></div></div>`;
    }

    function rankCard(label, e) {
        if (!e) return `<div class="pf-rank pf-unranked">${emb('UNRANKED', 'big', 'pf-emb-dim')}<div><div class="pf-rank-q">${label}</div><div class="pf-rank-t">Unranked</div></div></div>`;
        const apex = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(e.tier);
        const total = e.wins + e.losses, wr = pct(e.wins, total);
        return `<div class="pf-rank">${emb(e.tier, 'big')}
          <div class="pf-rank-info"><div class="pf-rank-q">${label}</div><div class="pf-rank-t">${tierName(e.tier)}${apex ? '' : ' ' + esc(e.rank)} <span class="pf-lp">${e.leaguePoints} LP</span></div>
          <div class="pf-rank-wl">${e.wins}W ${e.losses}L &middot; <span class="${wr >= 50 ? 'pf-pos' : 'pf-neg'}">${wr}% WR</span></div></div></div>`;
    }
    function headerHtml() {
        ensureEmblems('big', rankTiers(S.profile.ranked));
        ensureEmblems('mini', ALL_TIERS);
        const p = S.profile, solo = p.ranked.find(e => e.queueType === 'RANKED_SOLO_5x5'), flex = p.ranked.find(e => e.queueType === 'RANKED_FLEX_SR');
        const ic = p.profileIconId != null ? `${base()}/cdn/${patch()}/img/profileicon/${p.profileIconId}.png` : '';
        const bfw = S.backfill && S.backfill.resumeAt && S.backfill.resumeAt > Date.now() ? ` &middot; rate limit, resumes in <span class="pf-bfwait" data-resume="${S.backfill.resumeAt}">${fmtDur(Math.ceil((S.backfill.resumeAt - Date.now()) / 1000))}</span>` : '';
        const bf = S.backfill && S.backfill.state === 'running' ? `Loading season history ${S.backfill.done}/${S.backfill.total}` : '';
        return `<div class="pf-head">
          <div class="pf-avatar">${icon(ic, 'pf-avatar-img', '')}<span class="pf-level">${num(p.summonerLevel)}</span></div>
          <div class="pf-id"><div class="pf-name">${esc(p.gameName)}<i>#${esc(p.tagLine)}</i></div>
            <div class="pf-sub">${esc(p.platform)}${p.isOwner ? ' &middot; your account' : ''}${bf ? ' &middot; ' + esc(bf) + bfw + ' <button class="pf-btn pf-small" data-act="backfill-cancel">Cancel</button>' : ''}</div>
            <div class="pf-head-actions"><button class="pf-btn pf-small" data-act="backfill" ${S.backfill && S.backfill.state === 'running' ? 'disabled' : ''}>Load season history</button></div></div>
          <div class="pf-ranks">${rankCard('Ranked Solo/Duo', solo)}${rankCard('Ranked Flex', flex)}</div></div>`;
    }

    // left column: champion stats (season ledger), recent summary, mastery
    function champStats(rows) {
        const m = new Map();
        for (const r of rows) {
            const c = m.get(r.c) || { c: r.c, g: 0, w: 0, k: 0, d: 0, a: 0, cs: 0, dur: 0, scs: 0, sdur: 0, pl: 0, pln: 0, top4: 0 };
            c.g++; c.w += r.w; c.k += r.k; c.d += r.d; c.a += r.a; c.cs += r.cs; c.dur += r.dur; m.set(r.c, c);
            if (isSr(r.q)) { c.scs += r.cs; c.sdur += r.dur; }   // CS / min: Summoner's Rift games only
            if (r.pl) { c.pl += r.pl; c.pln++; if (r.pl <= (r.tp || (r.q === 1750 ? 3 : 4))) c.top4++; }   // Arena placements; top4 = better half of the lobby
        }
        return [...m.values()].sort((x, y) => y.g - x.g || y.w - x.w);
    }
    function paintLeft() {
        const el = root.querySelector('#pf-left'); if (!el || !S.profile) return;
        let html = '';
        // champion stats
        const rows = S.ledger ? S.ledger.rows.filter(r => qIn(S.ledgerGroup, r.q)) : null;
        html += `<div class="pf-card"><div class="pf-card-h"><span>Champions this season</span>
          <select class="pf-select pf-mini" data-act="ledgergroup">${GROUP_ORDER.map(g => `<option value="${g}" ${g === S.ledgerGroup ? 'selected' : ''}>${GROUP_LABEL[g]}</option>`).join('')}</select></div>`;
        if (!rows) html += '<div class="pf-muted">Loading...</div>';
        else if (!rows.length) html += '<div class="pf-muted">No cached games yet. Use "Load season history".</div>';
        else {
            html += '<div class="pf-cs-list">' + champStats(rows).slice(0, 8).map(c => {
                if (S.ledgerGroup === 'arena') {   // placement instead of win / loss
                    const avg = c.pln ? (c.pl / c.pln).toFixed(1) : '–', t4 = c.pln ? pct(c.top4, c.pln) : null;
                    return `<div class="pf-cs">${icon(champImg(c.c), 'pf-cs-img', champName(c.c))}
                      <div class="pf-cs-n">${cfName(c.c, 'b')}<span>${c.g} played</span></div>
                      <div class="pf-cs-k"><b>${avg}</b><span>avg place</span></div>
                      <div class="pf-cs-w"><b class="${t4 == null ? '' : t4 >= 50 ? 'pf-pos' : 'pf-neg'}">${t4 == null ? '–' : t4 + '%'}</b><span>top half</span></div></div>`;
                }
                const wr = pct(c.w, c.g), kda = kdaRatio(c.k, c.d, c.a);
                const csm = c.sdur ? (c.scs / (c.sdur / 60)).toFixed(1) : null;
                return `<div class="pf-cs">${icon(champImg(c.c), 'pf-cs-img', champName(c.c))}
                  <div class="pf-cs-n">${cfName(c.c, 'b')}<span title="Summoner’s Rift games only">CS ${csm == null ? '–' : csm + '/min'}</span></div>
                  <div class="pf-cs-k"><b>${kda}${kda === 'Perfect' ? '' : ':1'}</b><span>${(c.k / c.g).toFixed(1)}/${(c.d / c.g).toFixed(1)}/${(c.a / c.g).toFixed(1)}</span></div>
                  <div class="pf-cs-w"><b class="${wr >= 50 ? 'pf-pos' : 'pf-neg'}">${wr}%</b><span>${c.g} played</span></div></div>`;
            }).join('') + `</div><div class="pf-muted pf-foot">${rows.length} cached games</div>`;
        }
        html += '</div>';
        // recent 20
        const recent = S.matches.filter(m => !m.remake).slice(0, 20).map(m => ({ m, p: m.players.find(x => x.puuid === S.profile.puuid) })).filter(x => x.p);
        if (recent.length && S.group === 'arena') {
            const withPl = recent.filter(x => x.p.plc > 0), pl = withPl.map(x => x.p.plc), t4 = withPl.filter(x => x.p.plc <= arenaHalf(x.m)).length;
            html += `<div class="pf-card"><div class="pf-card-h"><span>Last ${recent.length} Arena games</span></div>
              <div class="pf-recent-sum"><div class="pf-donut" style="--p:${pct(t4, pl.length)}"><b>${pct(t4, pl.length)}%</b></div>
              <div><div>Top half in ${t4} of ${pl.length}</div><div class="pf-kda"><b>${pl.length ? (pl.reduce((a, b) => a + b, 0) / pl.length).toFixed(1) : '–'}</b> average place</div><div class="pf-muted">1st = best; top half = top 3 of 6 teams (top 4 of 8)</div></div></div></div>`;
        } else if (recent.length) {
            const w = recent.filter(x => x.p.win).length, K = sum(recent, 'k'), Dd = sum(recent, 'd'), A = sum(recent, 'a');
            const champs = champStats(recent.map(x => ({ c: x.p.champId, q: x.m.queueId, w: x.p.win ? 1 : 0, k: x.p.k, d: x.p.d, a: x.p.a, cs: x.p.cs, dur: x.m.dur }))).slice(0, 3);
            const pos = {}; for (const x of recent) if (POS_LABEL[x.p.pos]) pos[x.p.pos] = (pos[x.p.pos] || 0) + 1;
            const posList = Object.entries(pos).sort((a, b) => b[1] - a[1]).slice(0, 3);
            html += `<div class="pf-card"><div class="pf-card-h"><span>Last ${recent.length} games</span></div>
              <div class="pf-recent-sum"><div class="pf-donut" style="--p:${pct(w, recent.length)}"><b>${pct(w, recent.length)}%</b></div>
              <div><div>${w}W ${recent.length - w}L</div><div class="pf-kda"><b>${kdaRatio(K, Dd, A)}</b> KDA</div><div class="pf-muted">${(K / recent.length).toFixed(1)} / ${(Dd / recent.length).toFixed(1)} / ${(A / recent.length).toFixed(1)}</div>${avgScoreHtml(recent)}</div></div>
              <div class="pf-mini-champs">${champs.map(c => `<div title="${esc(champName(c.c))}">${icon(champImg(c.c), 'pf-cs-img', '')}<span>${c.w}-${c.g - c.w}</span></div>`).join('')}</div>
              <div class="pf-pos-list">${posList.map(([k, n]) => `<span>${POS_LABEL[k] || k} <b>${n}</b></span>`).join('')}</div></div>`;
        }
        html += playedCard();
        html += seasonsCard();
        // mastery
        if (S.profile.mastery.length) {
            html += `<div class="pf-card"><div class="pf-card-h"><span>Mastery</span></div>${S.profile.mastery.slice(0, 5).map(m => `
              <div class="pf-ms">${icon(champImg(m.championId), 'pf-cs-img', '')}<b>${esc(champName(m.championId))}</b><span>Lv ${m.championLevel}</span><span class="pf-muted">${num(m.championPoints)} pts</span></div>`).join('')}</div>`;
        }
        el.innerHTML = html;
        hydrateEmblems();
    }
    const SCORE_TIP = "DD Score: op.gg-style 0-10 performance score computed by DravenGap (op.gg's exact formula isn't public)";
    function avgScoreHtml(recent) {
        const sc = recent.map(x => x.p.sc).filter(v => typeof v === 'number');
        if (!sc.length) return '';
        const avg = sc.reduce((a, b) => a + b, 0) / sc.length;
        return `<div class="pf-avgsc" title="${esc(SCORE_TIP)}">DD Score <b class="${scoreCls(avg)}">${avg.toFixed(1)}</b> <span class="pf-muted">avg of ${sc.length}</span></div>`;
    }
    function playedCard() {
        const P = S.played;
        if (!P || !P.list) return '';
        const h = `<div class="pf-card" id="pf-played"><div class="pf-card-h"><span>Recently played with</span><span class="pf-muted">${esc(GROUP_LABEL[S.ledgerGroup] || '')}</span></div>`;
        if (!P.list.length) return h + `<div class="pf-muted">No teammate in 2+ cached games${P.scanned ? ` (of ${P.scanned})` : ''}.</div></div>`;
        return h + `<div class="pf-pw pf-pw-head"><span>Player</span><span>Games</span><span>W-L</span><span>WR</span></div>`
            + P.list.slice(0, 8).map(x => `<div class="pf-pw"><a class="pf-plink" data-act="open" data-n="${esc(x.name)}" data-t="${esc(x.tag)}" title="${esc(x.name)}#${esc(x.tag)}">${esc(x.name)}<i>#${esc(x.tag)}</i></a>
              <span>${x.games}</span><span class="pf-muted">${x.w}-${x.l}</span><b class="${x.wr >= 50 ? 'pf-pos' : 'pf-neg'}">${x.wr}%</b></div>`).join('')
            + `<div class="pf-muted pf-foot">From ${P.scanned} cached games, same team</div></div>`;
    }
    const SRC_HINT = { opgg: 'Source: op.gg', client: 'Source: League client', recorded: 'Source: recorded by DravenGap' };
    const Q_LABEL = { RANKED_SOLO_5x5: 'Solo/Duo', RANKED_FLEX_SR: 'Flex' };
    const rankTxt = x => x ? `${tierName(x.tier)}${['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(x.tier) || !x.rank ? '' : ' ' + x.rank}` : '';
    function seasonsCard() {
        const D2 = S.seasons;
        if (!D2) return '';
        if (D2.loading) return '<div class="pf-card"><div class="pf-card-h"><span>Past seasons</span></div><div class="pf-muted">Loading...</div></div>';
        const all = D2.seasons || [];
        const has = q => all.some(x => x.queue === q);
        const both = has('RANKED_SOLO_5x5') && has('RANKED_FLEX_SR');
        const q = both ? S.seasonQ : (has('RANKED_FLEX_SR') && !has('RANKED_SOLO_5x5') ? 'RANKED_FLEX_SR' : 'RANKED_SOLO_5x5');
        const rows = all.filter(x => x.queue === q);
        const shown = S.seasonAll ? rows : rows.slice(0, 6);
        const pk = D2.peak && D2.peak[q];
        const og = D2.opgg || {};
        const note = og.ok === false ? `<div class="pf-muted pf-foot" title="${esc(og.error || '')}">op.gg unavailable${og.backoff ? ' (will retry later)' : ''}${rows.length ? '; showing other sources' : ''}</div>` : '';
        let h = `<div class="pf-card" id="pf-seasons"><div class="pf-card-h"><span>Past seasons</span>`;
        if (both) h += `<span class="pf-seg">${['RANKED_SOLO_5x5', 'RANKED_FLEX_SR'].map(k => `<button class="pf-seg-b ${k === q ? 'on' : ''}" data-act="sq" data-q="${k}">${Q_LABEL[k]}</button>`).join('')}</span>`;
        else h += `<span class="pf-muted">${Q_LABEL[q]}</span>`;
        h += '</div>';
        if (pk) h += `<div class="pf-peak" title="Highest rank across the listed seasons">Peak ${emb(pk.tier, 'mini', 'pf-emb-xs')}<b>${esc(rankTxt(pk))}</b> <span class="pf-muted">${esc(pk.season)}${pk.lp != null ? ' &middot; ' + pk.lp + ' LP' : ''}</span></div>`;
        if (!rows.length) h += `<div class="pf-muted">${og.ok === false ? 'No past-season data.' : 'No ranked seasons found.'}</div>`;
        else h += shown.map(x => `<div class="pf-ps" title="${esc(SRC_HINT[x.source] || '')}">
            <span class="pf-ps-s">${esc(x.season)}</span>${emb(x.tier, 'mini', 'pf-emb-sm')}
            <span class="pf-ps-t"><span class="pf-tier-txt t-${esc(x.tier)}">${esc(rankTxt(x))}</span>${x.lp != null ? ` <span class="pf-muted">${x.lp} LP</span>` : ''}</span>
            ${x.peak ? `<span class="pf-ps-pk pf-muted" title="Highest that season">peak ${esc(rankTxt(x.peak))}</span>` : ''}
            ${x.source !== 'opgg' ? `<span class="pf-ps-src pf-muted">${x.source === 'client' ? 'client' : 'rec.'}</span>` : ''}</div>`).join('');
        if (rows.length > 6) h += `<button class="pf-btn pf-small pf-ps-more" data-act="sall">${S.seasonAll ? 'Show fewer' : `Show all ${rows.length}`}</button>`;
        const rec = (D2.recorded || []).filter(r => r.queue === q);
        if (rec.length) {
            h += `<div class="pf-foot"><button class="pf-link" data-act="srec">${S.seasonRec ? 'Hide' : 'Show'} recorded this season (${rec.length})</button></div>`;
            if (S.seasonRec) h += rec.slice(0, 12).map(r => `<div class="pf-ps pf-rec" title="${SRC_HINT.recorded}"><span class="pf-ps-s">${esc(r.date)}</span>${emb(r.tier, 'mini', 'pf-emb-sm')}<span class="pf-ps-t"><b>${esc(rankTxt(r))}</b> <span class="pf-muted">${r.lp} LP</span></span></div>`).join('');
        }
        return h + note + '</div>';
    }
    async function loadSeasons(force) {
        const p = S.profile; if (!p) return;
        const token = S.token;
        S.seasons = S.seasons && !force ? S.seasons : { loading: true };
        if (S.seasons.loading) paintLeft();
        const r = await api.invoke('profile:seasons', { gameName: p.gameName, tagLine: p.tagLine, platform: p.platform, puuid: p.puuid, force: !!force }).catch(e => ({ ok: false, error: e.message }));
        if (token !== S.token || !S.profile || S.profile.puuid !== p.puuid) return;
        S.seasons = r && r.ok ? r : { seasons: [], opgg: { ok: false, error: (r && r.error) || 'failed' }, recorded: [], peak: {} };
        ensureEmblems('mini', rankTiers(S.seasons.seasons).concat((S.seasons.recorded || []).map(x => x.tier), Object.values(S.seasons.peak || {}).map(x => x.tier)));
        paintLeft();
    }
    const sum = (arr, k) => arr.reduce((s, x) => s + x.p[k], 0);

    function paintMatches() {
        const el = root.querySelector('#pf-right'); if (!el || !S.profile) return;
        let html = `<div class="pf-qtabs">${GROUP_ORDER.map(g => `<button class="pf-qtab ${g === S.group ? 'on' : ''}" data-act="group" data-g="${g}">${GROUP_LABEL[g]}</button>`).join('')}
            <span class="pf-grow"></span>${S.champFilter ? champFilterChip() : `<input class="pf-cfilter" id="pf-cfilter" list="pf-champ-list" placeholder="Filter by champion" spellcheck="false" autocomplete="off" title="Show only one champion's games (or click a champion's name in Profile)"><datalist id="pf-champ-list">${champOptions()}</datalist>`}</div>`;
        if (S.matchError) html += errHtml(S.matchError);
        if (!S.matches.length && S.loadingMatches) html += '<div class="pf-sk-row"></div>'.repeat(5);
        else if (!S.matches.length) html += `<div class="pf-empty-state">No ${S.group === 'all' ? '' : GROUP_LABEL[S.group] + ' '}games${S.champFilter ? ` on ${esc(champName(S.champFilter))}` : ''} found${S.champFilter && S.hasMore ? ' yet' : ''}.${S.champFilter && S.hasMore ? '<br><button class="pf-btn" data-act="more">Look further back</button>' : ''}</div>`;
        else html += lastGameCard() + S.matches.map(matchRow).join('');
        if (S.hasMore && S.matches.length) html += `<button class="pf-btn pf-more" data-act="more" ${S.loadingMatches ? 'disabled' : ''}>${S.loadingMatches ? 'Loading...' : 'Show more'}</button>`;
        el.innerHTML = html;
    }

    // Post-game card: the newest game when it ended within the last 3 hours. Compares it with the player's season averages
    // (cached games) and shows what the draft model gave the team before the game (the draft view's current data).
    const POSTGAME_MS = 3 * 3600 * 1000;
    const draftMemo = {};   // match id -> { wr } | { none } | 'pending'
    function lastGameCard() {
        if (S.group !== 'all') return '';
        const m = S.matches.find(x => !x.remake);
        if (!m || Date.now() - m.end > POSTGAME_MS) return '';
        const me = m.players.find(p => p.puuid === S.profile.puuid);
        if (!me) return '';
        const rows = ((S.ledger && S.ledger.rows) || []).filter(r => qIn('all', r.q));   // never Arena / Swarm
        const avg = k => rows.length ? rows.reduce((t, r) => t + (r[k] || 0), 0) / rows.length : null;
        const kda = (k, d, a) => d ? (k + a) / d : k + a;
        const avgKda = rows.length ? kda(avg('k'), avg('d'), avg('a')) : null;
        const srRows = rows.filter(r => isSr(r.q));   // CS / min is compared with your Summoner's Rift games, and only for a Summoner's Rift game
        const csMin = me.cs / (m.dur / 60), avgCs = isSr(m.queueId) && srRows.length ? srRows.reduce((t, r) => t + r.cs, 0) / Math.max(1, srRows.reduce((t, r) => t + r.dur, 0) / 60) : null;
        const scs = S.matches.map(x => (x.players.find(p => p.puuid === S.profile.puuid) || {}).sc).filter(v => typeof v === 'number');
        const avgSc = scs.length ? scs.reduce((a, b) => a + b, 0) / scs.length : null;
        const cmp = (v, a, fmt, better = 1) => a == null ? '' : `<span class="${(v - a) * better >= 0 ? 'pf-pos' : 'pf-neg'}">${(v - a) >= 0 ? '+' : ''}${fmt(v - a)}</span> vs your usual`;
        // draft check (once per game, asynchronously)
        const team = m.players.filter(p => p.team === me.team), enemy = m.players.filter(p => p.team !== me.team);
        const posOk = ps => ps.length === 5 && ps.every(p => POS_LABEL[p.pos]);
        let draft = '';
        if (m.mode === 'CLASSIC' && posOk(team) && posOk(enemy) && window.DD.draftWinChances) {
            const d = draftMemo[m.id];
            if (!d) {
                draftMemo[m.id] = 'pending';
                const side = ps => { const o = {}; for (const p of ps) o[p.pos] = p.champId; return o; };
                window.DD.draftWinChances([{ my: side(team), enemy: side(enemy) }]).then(r => {
                    draftMemo[m.id] = r && r.results[0] ? { wr: r.results[0].wr, label: r.label } : { none: true };
                    if (S.matches[0] === m || S.matches.find(x => !x.remake) === m) paintMatches();
                }).catch(() => { draftMemo[m.id] = { none: true }; });
            } else if (d !== 'pending' && !d.none) {
                const verdict = d.wr >= 0.52 ? 'a good draft' : d.wr <= 0.48 ? 'a tough draft' : 'an even draft';
                draft = `<div class="pf-pg-draft">Draft check: your team's draft was <b class="${d.wr >= 0.5 ? 'pf-pos' : 'pf-neg'}">${(d.wr * 100).toFixed(1)}%</b> to win (${verdict}) · ${me.win ? (d.wr <= 0.48 ? 'you won it anyway' : d.wr >= 0.52 ? 'and you converted it' : 'won on the Rift, not in the draft') : (d.wr >= 0.52 ? 'the draft was not the problem' : d.wr <= 0.48 ? 'the draft was against you' : 'the draft did not decide this one')}
                    <span class="pf-muted">(${esc(d.label || '')})</span></div>`;
            }
        }
        const badge = me.bd ? `<span class="pf-badge ${me.bd === 'MVP' ? 'mvp' : 'ace'}">${me.bd}</span>` : (me.rk ? `<span class="pf-muted">${ordinal(me.rk)}</span>` : '');
        return `<div class="pf-postgame ${me.win ? 'win' : 'loss'}">
            <div class="pf-pg-h">${icon(champImg(me.champId), 'pf-pg-img', champName(me.champId))}
              <div><div class="pf-pg-t">${me.win ? 'Victory' : 'Defeat'} · ${esc(champName(me.champId))} · ${ago(m.end)}</div>
              <div class="pf-pg-s"><b>${me.k}/${me.d}/${me.a}</b> · DD Score ${typeof me.sc === 'number' ? `<b class="${scoreCls(me.sc)}">${me.sc.toFixed(1)}</b>` : '–'} ${badge}</div></div>
              <span class="pf-grow"></span>${m.mode === 'CLASSIC' ? `<button type="button" class="pf-btn pf-small" data-act="review" data-id="${esc(m.id)}" data-copy-hide title="Lane at 10 / 15 / 20 min, gold swings, deaths on the map, your items vs the data">Review this game</button>` : ''}${window.DD.copyAsImage ? '<button type="button" class="pf-btn pf-small" data-act="copypg" data-copy-hide title="Copy this card as an image (for Discord)">Copy as image</button>' : ''}<span class="pf-muted pf-pg-tag">Your last game</span></div>
            <div class="pf-pg-cmp">
              <span>KDA ${kda(me.k, me.d, me.a).toFixed(2)} ${cmp(kda(me.k, me.d, me.a), avgKda, v => v.toFixed(2))}</span>
              <span>CS/min ${csMin.toFixed(1)} ${cmp(csMin, avgCs, v => v.toFixed(1))}</span>
              ${typeof me.sc === 'number' ? `<span>DD ${me.sc.toFixed(1)} ${cmp(me.sc, avgSc, v => v.toFixed(1))}</span>` : ''}
              <span>KP ${me.kp}%</span></div>${draft}</div>`;
    }
    function ordinal(n) { return n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'); }

    function playerLink(p, cls) {
        return p.name ? `<a class="pf-plink ${cls || ''}" data-act="open" data-n="${esc(p.name)}" data-t="${esc(p.tag)}" title="${esc(p.name)}#${esc(p.tag)}">${esc(p.name)}</a>` : '<span class="pf-plink">-</span>';
    }
    function matchRow(m) {
        const me = m.players.find(p => p.puuid === S.profile.puuid);
        if (!me) return '';
        const qn = S.queues[m.queueId] || `Queue ${m.queueId}`;
        const arena = isArena(m), won = arena && me.plc ? me.plc <= arenaHalf(m) : me.win;   // Arena: the better half of the lobby is the "win"
        const cls = m.remake ? 'remake' : won ? 'win' : 'loss';
        const cspm = m.dur ? (me.cs / (m.dur / 60)).toFixed(1) : '0.0';
        const teamOf = t => m.players.filter(p => p.team === t);
        const col = ps => `<div class="pf-pcol">${ps.map(p => `<div class="pf-prow ${p.puuid === me.puuid ? 'me' : ''}" data-pos="${esc(p.pos || '')}">${icon(champImg(p.champId), 'pf-pimg', champName(p.champId))}${playerLink(p)}</div>`).join('')}</div>`;
        const teams = [...new Set(m.players.map(p => p.team))];
        const mates = arena ? `<div class="pf-pcol">${m.players.filter(p => p !== me && me.sub && p.sub === me.sub).map(p => `<div class="pf-prow" title="Your team">${icon(champImg(p.champId), 'pf-pimg', champName(p.champId))}${playerLink(p)}</div>`).join('')}</div>` : '';
        const open = S.expanded.has(m.id);
        return `<div class="pf-match ${cls}" data-id="${esc(m.id)}">
          <div class="pf-mrow" data-act="expand" data-id="${esc(m.id)}">
            <div class="pf-m-info"><b class="pf-q">${esc(qn)}</b>${m.src === 'lcu' ? '<span class="pf-src-lcu" title="Recorded from the League client after the game: Riot’s API does not return this mode">from the client</span>' : ''}<span>${ago(m.end)}</span><span class="pf-res">${m.remake ? 'Remake' : arena && me.plc ? ordinal(me.plc) + ' place' : me.win ? 'Victory' : 'Defeat'} &middot; ${fmtDur(m.dur)}</span>${scoreChip(me)}</div>
            <div class="pf-m-champ"><div class="pf-champ-wrap" data-pos="${esc(me.pos || '')}">${icon(champImg(me.champId), 'pf-champ', champName(me.champId))}<span class="pf-clvl">${me.lvl}</span></div>
              <div class="pf-sr">${spellImg(me.s1)}${spellImg(me.s2)}</div><div class="pf-sr">${runeImg(me.keystone, 'pf-rune')}${runeImg(me.sStyle, 'pf-rune pf-rune2')}</div></div>
            <div class="pf-m-kda"><div class="pf-kdaline"><b>${me.k}</b> / <b class="pf-neg">${me.d}</b> / <b>${me.a}</b></div><div class="pf-muted">${kdaRatio(me.k, me.d, me.a)}${me.d === 0 && me.k + me.a > 0 ? '' : ':1'} KDA</div>${me.multi >= 2 ? `<span class="pf-multi">${['', '', 'Double', 'Triple', 'Quadra', 'Penta'][Math.min(me.multi, 5)]} kill</span>` : ''}</div>
            <div class="pf-m-stats">${arena ? `<span>Damage ${num(me.dmg)}</span><span>Gold ${num(me.gold)}</span>` : `<span>KP ${me.kp}%</span><span>CS ${me.cs} (${cspm})</span><span>Vision ${me.vis}</span>`}</div>
            <div class="pf-m-items">${me.items.slice(0, 6).map(itemImg).join('')}<span class="pf-trink">${itemImg(me.items[6])}</span></div>
            <div class="pf-m-players">${arena ? mates : teams.map(t => col(teamOf(t))).join('')}</div>
            <div class="pf-m-x">${open ? '&#9650;' : '&#9660;'}</div>
          </div>${open ? expandHtml(m, me) : ''}</div>`;
    }
    // ---------- DD Score display ----------
    const scoreCls = v => v >= 8 ? 'sc-top' : v >= 6 ? 'sc-good' : v >= 4.5 ? 'sc-mid' : 'sc-low';
    function scoreChip(p) {
        if (typeof p.sc !== 'number') return '';
        const b = p.bd === 'MVP' || p.bd === 'ACE' ? p.bd : '';
        return `<span class="pf-score" title="${esc(SCORE_TIP)}"><b class="${scoreCls(p.sc)}">${p.sc.toFixed(1)}</b>${b ? `<i class="pf-badge ${b.toLowerCase()}">${b}</i>` : `<em>${esc(p.bd || '')}</em>`}</span>`;
    }

    // ---------- expanded match: Overview / Build / Analysis ----------
    const MTABS = [['overview', 'Overview'], ['build', 'Build'], ['analysis', 'Analysis'], ['review', 'Review']];
    function repaintMatch(id) {
        const card = root.querySelector(`.pf-match[data-id="${CSS.escape(id)}"]`), m = S.matches.find(x => x.id === id);
        if (card && m) card.outerHTML = matchRow(m);
    }
    function expandHtml(m, me) {
        const tab = S.mtab[m.id] || 'overview';
        const tabs = `<div class="pf-mtabs">${MTABS.map(([k, l]) => `<button class="pf-mtab ${k === tab ? 'on' : ''}" data-act="mtab" data-id="${esc(m.id)}" data-t="${k}">${l}</button>`).join('')}</div>`;
        const body = tab === 'build' ? buildTab(m, me) : tab === 'analysis' ? analysisTab(m, me) : tab === 'review' ? reviewTab(m, me) : isArena(m) ? arenaBoard(m, me) : scoreboard(m, me);
        return `<div class="pf-expand">${tabs}${body}</div>`;
    }
    // Arena: everyone by final placement (the players of one team share a place)
    function arenaBoard(m, me) {
        const ps = [...m.players].sort((a, b) => (a.plc || 99) - (b.plc || 99) || (a.sub || 0) - (b.sub || 0));
        const maxDmg = Math.max(1, ...m.players.map(p => p.dmg));
        return `<table class="pf-sb ${me.plc && me.plc <= arenaHalf(m) ? 'win' : 'loss'}"><thead><tr><th class="l">Place</th><th class="l">Player</th><th>KDA</th><th>Damage</th><th>Gold</th><th class="l">Items</th></tr></thead><tbody>
          ${ps.map(p => `<tr class="${p.puuid === me.puuid ? 'me' : ''}"><td class="l"><b>${p.plc ? ordinal(p.plc) : '-'}</b></td><td class="l"><div class="pf-sb-p">${icon(champImg(p.champId), 'pf-pimg', champName(p.champId))}${playerLink(p)}</div></td>
          <td><b>${p.k}/${p.d}/${p.a}</b></td><td><div class="pf-bar"><i style="width:${pct(p.dmg, maxDmg)}%"></i></div>${num(p.dmg)}</td><td>${num(p.gold)}</td>
          <td class="l"><div class="pf-m-items">${p.items.slice(0, 6).map(itemImg).join('')}</div></td></tr>`).join('')}</tbody></table>`;
    }
    function scoreboard(m, me) {
        const maxDmg = Math.max(1, ...m.players.map(p => p.dmg));
        const teamBlock = tid => {
            const t = (m.teams || []).find(x => x.id === tid) || {};
            const ps = m.players.filter(p => p.team === tid);
            return `<table class="pf-sb ${t.win ? 'win' : 'loss'}"><thead><tr><th class="l">${t.win ? 'Victory' : 'Defeat'} &middot; ${tid === 100 ? 'Blue' : 'Red'} team</th><th title="${esc(SCORE_TIP)}">DD Score</th><th>KDA</th><th>Damage</th><th>Gold</th><th>CS</th><th>Wards</th><th class="l">Items</th></tr></thead><tbody>
              ${ps.map(p => `<tr class="${p.puuid === me.puuid ? 'me' : ''}" data-pos="${esc(p.pos || '')}"><td class="l"><div class="pf-sb-p">${icon(champImg(p.champId), 'pf-pimg', champName(p.champId))}<span class="pf-lvl">${p.lvl}</span><span class="pf-sr2">${spellImg(p.s1)}${spellImg(p.s2)}</span>${playerLink(p)}</div></td>
              <td>${scoreChip(p) || '<span class="pf-muted">-</span>'}</td>
              <td><b>${p.k}/${p.d}/${p.a}</b><div class="pf-muted">${kdaRatio(p.k, p.d, p.a)} &middot; ${p.kp}%</div></td>
              <td><div class="pf-bar"><i style="width:${pct(p.dmg, maxDmg)}%"></i></div>${num(p.dmg)}</td><td>${num(p.gold)}</td><td>${p.cs}</td>
              <td>${p.vis}<div class="pf-muted">${p.cw}/${p.wp}/${p.wk}</div></td><td class="l"><div class="pf-m-items">${p.items.slice(0, 6).map(itemImg).join('')}${itemImg(p.items[6])}</div></td></tr>`).join('')}
              </tbody></table>
              <div class="pf-obj">Kills ${t.kills || 0} &middot; Towers ${t.tower || 0} &middot; Dragons ${t.dragon || 0} &middot; Barons ${t.baron || 0} &middot; Heralds ${t.herald || 0} &middot; Inhibitors ${t.inhib || 0}</div>`;
        };
        const teams = [...new Set(m.players.map(p => p.team))].sort();
        return teams.map(teamBlock).join('');
    }

    // participant picker shared by Build and Analysis (defaults to the viewed player)
    const pickedOf = (m, me) => (S.mpick[m.id] != null && m.players[S.mpick[m.id]]) || me;
    function pickerHtml(m, me, cur) {
        const teams = [...new Set(m.players.map(p => p.team))].sort();
        return `<div class="pf-picker">${teams.map(t => `<span class="pf-pick-team ${t === 100 ? 'blue' : 'red'}">${m.players.map((p, i) => p.team === t ? `<button class="pf-pick ${p === cur ? 'on' : ''}" data-act="mpick" data-id="${esc(m.id)}" data-i="${i}" title="${esc(p.name)}#${esc(p.tag)} - ${esc(champName(p.champId))}">${icon(champImg(p.champId), 'pf-pimg', '')}</button>` : '').join('')}</span>`).join('')}
          <span class="pf-pick-name"><b>${esc(cur.name || '-')}</b> <span class="pf-muted">${esc(champName(cur.champId))} &middot; ${cur.k}/${cur.d}/${cur.a}</span>${scoreChip(cur)}</span></div>`;
    }

    // --- runes ---
    const SHARD_BASE = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/perk-images/statmods/';
    const SHARD_FALLBACK = { 5001: ['Health Scaling', 'statmodshealthscalingicon.png'], 5002: ['Armor', 'statmodsarmoricon.png'], 5003: ['Magic Resist', 'statmodsmagicresicon.png'], 5005: ['Attack Speed', 'statmodsattackspeedicon.png'],
        5007: ['Ability Haste', 'statmodscdrscalingicon.png'], 5008: ['Adaptive Force', 'statmodsadaptiveforceicon.png'], 5010: ['Move Speed', 'statmodsmovementspeedicon.png'], 5011: ['Health', 'statmodshealthplusicon.png'], 5013: ['Tenacity and Slow Resist', 'statmodstenacityicon.png'] };
    const SHARD_ROWS = [[5008, 5005, 5007], [5008, 5010, 5001], [5011, 5013, 5001]];   // offense, flex, defense
    function shardInfo(id) {
        const d = D.shards[id], f = SHARD_FALLBACK[id];
        return { name: (d && d.name) || (f && f[0]) || `Shard ${id}`, src: (d && d.icon) || (f ? SHARD_BASE + f[1] : '') };
    }
    async function loadShards() {   // CommunityDragon perks.json refines names/icons; the table above works without it
        if (D.shardsAsked) return; D.shardsAsked = true;
        const cd = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/';
        try {
            const list = await fetch(cd + 'v1/perks.json').then(r => r.ok ? r.json() : null);
            if (Array.isArray(list)) for (const x of list) if (x && x.id >= 5000 && x.id < 6000 && x.iconPath) D.shards[x.id] = { name: x.name, icon: cd + String(x.iconPath).replace('/lol-game-data/assets/', '').toLowerCase() };
        } catch (e) { /* offline or blocked: keep the built-in table */ }
    }
    function runeIc(id, on, big) {
        const r = D.runes[id];
        return `<span class="pf-rn ${on ? 'on' : 'off'} ${big ? 'big' : ''}" title="${esc(r ? r.name : 'Rune ' + id)}">${r ? `<img loading="lazy" src="${esc(base() + '/cdn/img/' + r.icon)}" alt="">` : ''}</span>`;
    }
    function runesHtml(p) {
        if (!p.pk) return '<div class="pf-muted">Rune data is not available for this game.</div>';
        const [pStyle, pSel, sStyle, sSel, stat] = p.pk;
        const chosen = new Set([...pSel, ...sSel]);
        const tree = (id, skipKeystone) => {
            const t = D.trees[id];
            if (!t) return `<div class="pf-muted">Tree ${esc(id)}</div>`;
            return `<div class="pf-tree"><div class="pf-tree-h"><img loading="lazy" src="${esc(base() + '/cdn/img/' + t.icon)}" alt=""><b>${esc(t.name)}</b></div>${t.slots.map((sl, k) => (skipKeystone && k === 0) ? '' : `<div class="pf-rslot ${k === 0 ? 'key' : ''}">${sl.runes.map(r => runeIc(r.id, chosen.has(r.id), k === 0)).join('')}</div>`).join('')}</div>`;
        };
        const shards = `<div class="pf-tree"><div class="pf-tree-h"><b>Stat shards</b></div>${SHARD_ROWS.map((row, k) => `<div class="pf-rslot">${row.map(id => { const on = stat && stat[k] === id, si = shardInfo(id); return `<span class="pf-rn shard ${on ? 'on' : 'off'}" title="${esc(si.name)}">${si.src ? `<img loading="lazy" src="${esc(si.src)}" alt="">` : ''}</span>`; }).join('')}</div>`).join('')}</div>`;
        return `<div class="pf-runes">${tree(pStyle, false)}${tree(sStyle, true)}${shards}</div>`;
    }

    // --- timeline-backed pieces ---
    // minVersion 2 = with the kills (the Review tab's minimap); an older cached timeline is fetched once more for it
    function ensureTimeline(m, force, minVersion = 1) {
        const cur = S.tl[m.id];
        if (cur && !force && !(cur.data && (cur.data.v || 1) < minVersion)) return;   // loading, loaded or failed: a failed one is retried only by the Retry button
        S.tl[m.id] = { loading: true };
        api.invoke('profile:timeline', { id: m.id, platform: S.profile.platform, minVersion }).catch(e => ({ ok: false, code: 'ERROR', error: e.message })).then(r => {
            S.tl[m.id] = r && r.ok ? { data: r.timeline } : { error: r };
            if (S.expanded.has(m.id) && ['build', 'analysis', 'review'].includes(S.mtab[m.id])) repaintMatch(m.id);
        });
    }
    function tlStatus(m) {
        const t = S.tl[m.id];
        if (!t || t.loading) return '<div class="pf-tl-wait"><span class="pf-sk-inline"></span> Loading match timeline...</div>';
        if (t.error) return `<div class="pf-tl-err">${esc((t.error.error) || 'Could not load the timeline.')} <button class="pf-btn pf-small" data-act="tlretry" data-id="${esc(m.id)}">Retry</button></div>`;
        return '';
    }
    function itemTimelineHtml(m, p) {
        const t = S.tl[m.id];
        if (!t || !t.data) return tlStatus(m);
        const pl = t.data.players[p.pid];
        if (!pl || !pl.items.length) return '<div class="pf-muted">No purchases recorded.</div>';
        return `<div class="pf-itl">${pl.items.map(g => `<div class="pf-itl-g"><span class="pf-itl-m">${g.m} min</span><span class="pf-itl-i">${g.items.map(x => x.s ? `<span class="pf-sold" title="Sold">${itemImg(x.i)}</span>` : itemImg(x.i)).join('')}</span></div>`).join('')}</div>`;
    }
    function skillsHtml(m, p) {
        const t = S.tl[m.id];
        if (!t || !t.data) return tlStatus(m);
        const pl = t.data.players[p.pid], sk = pl && pl.skills;
        if (!sk || !sk.seq.length) return '<div class="pf-muted">No skill data.</div>';
        let h = `<div class="pf-skill-prio">${sk.prio ? esc(sk.prio) : ''}</div><div class="pf-skg">`;
        h += '<div class="pf-skrow pf-skhead"><span></span>' + Array.from({ length: 18 }, (_, i) => `<span>${i + 1}</span>`).join('') + '</div>';
        for (let s = 1; s <= 4; s++) h += `<div class="pf-skrow"><b class="pf-sk-l s${s}">${'QWER'[s - 1]}</b>${Array.from({ length: 18 }, (_, i) => `<span class="pf-skc ${sk.seq[i] === s ? 'on s' + s : ''}"></span>`).join('')}</div>`;
        return h + '</div>';
    }
    function buildTab(m, me) {
        loadShards();
        ensureTimeline(m, false);
        const p = pickedOf(m, me);
        return `${pickerHtml(m, me, p)}
          <div class="pf-build">
            <div class="pf-bcol"><div class="pf-sec-h">Runes</div>${runesHtml(p)}</div>
            <div class="pf-bcol"><div class="pf-sec-h">Final build</div><div class="pf-m-items">${p.items.slice(0, 6).map(itemImg).join('')}<span class="pf-trink">${itemImg(p.items[6])}</span></div>
              <div class="pf-sec-h">Skill order</div>${skillsHtml(m, p)}</div>
          </div>
          <div class="pf-sec-h">Item purchase order</div>${itemTimelineHtml(m, p)}`;
    }

    // --- analysis ---
    const STATS = [['dmg', 'Damage dealt to champions'], ['taken', 'Damage taken'], ['gold', 'Gold earned'], ['cs', 'CS'], ['vis', 'Vision score'], ['wp', 'Wards placed']];
    function statCard(m, key, label, cur) {
        const max = Math.max(1, ...m.players.map(p => p[key] || 0));
        const rows = [...m.players].sort((a, b) => a.team - b.team || (b[key] || 0) - (a[key] || 0));
        return `<div class="pf-an-card"><div class="pf-an-h">${esc(label)}</div>${rows.map(p => `<div class="pf-an-r ${p === cur ? 'me' : ''}">${icon(champImg(p.champId), 'pf-pimg', champName(p.champId))}<div class="pf-an-bar ${p.team === 100 ? 'blue' : 'red'}"><i style="width:${pct(p[key] || 0, max)}%"></i></div><span>${num(p[key] || 0)}</span></div>`).join('')}</div>`;
    }
    function goldChart(m) {
        const t = S.tl[m.id];
        if (!t || !t.data) return tlStatus(m);
        const pts = t.data.gold;
        if (!pts || pts.length < 2) return '<div class="pf-muted">Not enough timeline frames.</div>';
        const W = 620, H = 170, L = 44, R = 10, T = 10, B = 22;
        const maxM = Math.max(1, pts[pts.length - 1].m), maxD = Math.max(1000, ...pts.map(q => Math.abs(q.d))) * 1.1;
        const X = v => L + v / maxM * (W - L - R), Y = d => T + (H - T - B) / 2 * (1 - d / maxD), y0 = Y(0);
        const line = pts.map((q, i) => `${i ? 'L' : 'M'}${X(q.m).toFixed(1)} ${Y(q.d).toFixed(1)}`).join(' ');
        const area = `${line} L${X(maxM).toFixed(1)} ${y0.toFixed(1)} L${X(0).toFixed(1)} ${y0.toFixed(1)} Z`;
        const kfmt = v => (v >= 0 ? '+' : '-') + (Math.abs(v) / 1000).toFixed(1) + 'k';
        const xt = []; for (let v = 0; v <= maxM; v += maxM > 30 ? 10 : 5) xt.push(v);
        const cid = String(m.id).replace(/[^A-Za-z0-9_]/g, '');
        return `<svg class="pf-gold-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Team gold difference over time">
          <defs><clipPath id="gc-up-${cid}"><rect x="0" y="0" width="${W}" height="${y0.toFixed(1)}"/></clipPath><clipPath id="gc-dn-${cid}"><rect x="0" y="${y0.toFixed(1)}" width="${W}" height="${H}"/></clipPath></defs>
          <path d="${area}" fill="#3b82f6" fill-opacity=".30" clip-path="url(#gc-up-${cid})"/><path d="${area}" fill="#ef4444" fill-opacity=".30" clip-path="url(#gc-dn-${cid})"/>
          <line x1="${L}" x2="${W - R}" y1="${y0.toFixed(1)}" y2="${y0.toFixed(1)}" stroke="currentColor" stroke-opacity=".35"/>
          <path d="${line}" fill="none" stroke="currentColor" stroke-opacity=".85" stroke-width="1.6"/>
          <text x="${L - 6}" y="${T + 8}" text-anchor="end" class="pf-svg-t">${kfmt(maxD)}</text><text x="${L - 6}" y="${(y0 + 4).toFixed(1)}" text-anchor="end" class="pf-svg-t">0</text><text x="${L - 6}" y="${H - B}" text-anchor="end" class="pf-svg-t">${kfmt(-maxD)}</text>
          ${xt.map(v => `<text x="${X(v).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="pf-svg-t">${v}m</text>`).join('')}</svg>
          <div class="pf-muted pf-gold-leg"><span class="pf-lg blue"></span>Blue team ahead <span class="pf-lg red"></span>Red team ahead &middot; final ${kfmt(pts[pts.length - 1].d)}</div>`;
    }
    function analysisTab(m, me) {
        ensureTimeline(m, false);
        const cur = pickedOf(m, me);
        return `<div class="pf-an-grid">${STATS.map(([k, l]) => statCard(m, k, l, cur)).join('')}</div>
          <div class="pf-sec-h">Team gold difference</div>${goldChart(m)}`;
    }

    // ---------- review: your lane against your opponent at 10 / 15 / 20 minutes, the biggest gold swings,
    // your deaths and kills on the map, and your items against the saved Coachless table. From the match timeline (one request, cached). ----------
    const REVIEW_MIN = [10, 15, 20];
    function laneOpponent(m, p) { return p.pos ? m.players.find(q => q.team !== p.team && q.pos === p.pos) || null : null; }
    function frameAt(T, min) { return T.series.find(s => s.m >= min) || null; }
    function reviewLane(m, p, T) {
        const o = laneOpponent(m, p);
        if (!o) return '<div class="pf-muted">No lane opponent in this game (no positions, e.g. ARAM).</div>';
        const rows = REVIEW_MIN.map(min => {
            const f = frameAt(T, min); if (!f) return null;
            const a = p.pid - 1, b = o.pid - 1, d = { g: f.g[a] - f.g[b], c: f.c[a] - f.c[b], x: f.x[a] - f.x[b] };
            const cell = (v, fmt) => `<td class="${v > 0 ? 'pf-pos' : v < 0 ? 'pf-neg' : ''}">${v > 0 ? '+' : ''}${fmt(v)}</td>`;
            return `<tr><td class="l">${min} min</td>${cell(d.g, v => num(v))}${cell(d.c, v => String(v))}${cell(d.x, v => num(v))}<td class="pf-muted">${num(f.g[a])} vs ${num(f.g[b])} gold · ${f.c[a]} vs ${f.c[b]} CS</td></tr>`;
        }).filter(Boolean);
        if (!rows.length) return '<div class="pf-muted">The game ended before 10 minutes.</div>';
        return `<table class="pf-ctable pf-rv-lane"><thead><tr><th class="l">${icon(champImg(p.champId), 'pf-pimg', '')} vs ${icon(champImg(o.champId), 'pf-pimg', '')} ${esc(champName(o.champId))}</th><th>Gold</th><th>CS</th><th>XP</th><th class="l"></th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
    }
    // the 3-minute windows where your team's gold lead moved most (not overlapping), from your side
    function reviewSwings(m, p, T) {
        const sgn = p.team === 100 ? 1 : -1, g = T.gold;
        const cand = [];
        for (let i = 0; i + 3 < g.length; i++) cand.push({ from: Math.round(g[i].m), to: Math.round(g[i + 3].m), d: sgn * (g[i + 3].d - g[i].d) });
        cand.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
        const out = [];
        for (const c of cand) { if (Math.abs(c.d) < 1500 || out.length >= 3) break; if (!out.some(o => c.from < o.to && o.from < c.to)) out.push(c); }
        if (!out.length) return '<div class="pf-muted">No big swing: the gold lead never moved 1,500+ in three minutes.</div>';
        return `<ul class="pf-rv-swings">${out.sort((a, b) => a.from - b.from).map(c => `<li><b>${c.from}–${c.to} min</b>: your team <b class="${c.d > 0 ? 'pf-pos' : 'pf-neg'}">${c.d > 0 ? 'gained' : 'lost'} ${num(Math.abs(c.d))} gold</b></li>`).join('')}</ul>`;
    }
    // Summoner's Rift map: x 0-14870, y 0-14980 (match-v5 positions); y grows upwards
    function reviewMap(m, p, T) {
        if (!T.kills) return '<div class="pf-muted">Loading the deaths and kills…</div>';
        if (m.mode && m.mode !== 'CLASSIC') return '<div class="pf-muted">The map is for Summoner\u2019s Rift games.</div>';
        const S2 = 220, X = v => (v / 14870 * S2).toFixed(1), Y = v => (S2 - v / 14980 * S2).toFixed(1);
        const nm = pid => { const q = m.players.find(x => x.pid === pid); return q ? champName(q.champId) : 'a tower or minions'; };
        const mine = T.kills.filter(k => k.v === p.pid || k.p === p.pid || k.as.includes(p.pid));
        const dots = mine.map(k => {
            const died = k.v === p.pid, kill = k.p === p.pid;
            const tip = `${k.m.toFixed(0)} min: ${died ? `died to ${nm(k.p)}` : kill ? `killed ${nm(k.v)}` : `assist on ${nm(k.v)}`}`;
            return died ? `<g class="d"><title>${esc(tip)}</title><path d="M${X(k.x) - 4} ${Y(k.y) - 4}l8 8m0-8l-8 8"/></g>` : `<circle class="${kill ? 'k' : 'a'}" cx="${X(k.x)}" cy="${Y(k.y)}" r="${kill ? 4 : 2.5}"><title>${esc(tip)}</title></circle>`;
        }).join('');
        const nd = mine.filter(k => k.v === p.pid).length, nk = mine.filter(k => k.p === p.pid).length;
        const early = mine.filter(k => k.v === p.pid && k.m < 15).length;
        return `<div class="pf-rv-mapwrap"><svg class="pf-rv-map" viewBox="0 0 ${S2} ${S2}" width="${S2}" height="${S2}"><image href="${esc(base())}/cdn/${esc(patch())}/img/map/map11.png" width="${S2}" height="${S2}" opacity=".55"/>${dots}</svg>
            <div class="pf-muted">✕ your ${nd} death${nd === 1 ? '' : 's'}${early ? ` (${early} before 15 min)` : ''} · ● your ${nk} kill${nk === 1 ? '' : 's'} · small dots: assists. Hover for the time and who.</div></div>`;
    }
    // completed items (no further upgrade, 2,000+ gold) in the order bought, against the saved Coachless table for this champion and lane
    const BUILDS_POS = { TOP: 'TOP', JUNGLE: 'JUNGLE', MIDDLE: 'MIDDLE', BOTTOM: 'BOTTOM', UTILITY: 'SUPPORT' };
    function reviewItems(m, p, T) {
        const pl = T.players[p.pid];
        const done = [];
        for (const g of (pl && pl.items) || []) for (const x of g.items) {
            const it = D.items[x.i];
            if (x.s || !it || (it.into && it.into.length) || !(it.gold && it.gold.total >= 2000) || done.some(d => d.i === x.i)) continue;
            done.push({ i: x.i, m: g.m });
        }
        if (!done.length) return '<div class="pf-muted">No completed item in this game.</div>';
        const key = `${m.id}|${p.pid}`, role = BUILDS_POS[p.pos], ch = champMap.get(Number(p.champId));
        let data = S.rv[key];
        if (data === undefined && role && ch && window.DD.buildsTables) {
            S.rv[key] = null;   // loading
            window.DD.buildsTables(ch.id, role).then(r => { S.rv[key] = r || { saved: false }; if (S.expanded.has(m.id) && S.mtab[m.id] === 'review') repaintMatch(m.id); }).catch(() => { S.rv[key] = { saved: false }; });
        }
        const rows = data && data.saved ? data.legendaries || [] : [];
        const byId = new Map(rows.map(r => [r.id, r]));
        const tag = r => !r ? '' : r.pp >= 0.9 && r.adj > 0 ? '<span class="pf-rv-good" title="Strong evidence it helps (PP 90%+)">strong pick</span>' : r.pp != null && r.pp < 0.5 && r.adj < 0 ? '<span class="pf-rv-bad" title="More likely to hurt than help in this data">weak pick</span>' : '';
        let h = `<div class="pf-rv-items">${done.map(d => `<div class="pf-rv-item">${itemImg(d.i)}<span>${Math.round(d.m)} min</span>${tag(byId.get(d.i))}</div>`).join('')}</div>`;
        if (!role) return h;
        if (data === undefined || data === null) return h + '<div class="pf-muted">Reading the Coachless table…</div>';
        if (!data.saved) return h + `<div class="pf-muted">No Coachless data saved for ${esc(champName(p.champId))} ${esc(POS_LABEL[p.pos] || '')}: open it in Builds to download it (one champion and role, on demand).</div>`;
        const skipped = rows.filter(r => r.pp >= 0.9 && r.adj > 0 && r.pickRate >= 0.02 && !done.some(d => d.i === r.id)).sort((a, b) => b.adj - a.adj).slice(0, 2);
        return h + (skipped.length ? `<div class="pf-rv-note">Strong in the data and not in your build: ${skipped.map(r => `${itemImg(r.id)} <b>${esc(r.name)}</b> <span class="pf-pos">+${(r.adj * 100).toFixed(1)} WPA</span>`).join(' · ')} <span class="pf-muted">(Coachless, Emerald+, ${esc((data.patches || []).join(', '))})</span></div>` : '<div class="pf-muted">Every strong item in the data for this champion is in your build, or none is clearly better.</div>');
    }
    function reviewTab(m, me) {
        ensureTimeline(m, false, 2);
        const t = S.tl[m.id];
        if (!t || !t.data) return tlStatus(m);
        const T = t.data, p = me;
        return `<div class="pf-review">
            <div class="pf-rv-col"><div class="pf-sec-h">Your lane, ahead (+) or behind (−)</div>${reviewLane(m, p, T)}
              <div class="pf-sec-h">What moved the game</div>${reviewSwings(m, p, T)}
              <div class="pf-sec-h">Your items</div>${reviewItems(m, p, T)}</div>
            <div class="pf-rv-col"><div class="pf-sec-h">Deaths and kills</div>${reviewMap(m, p, T)}</div></div>`;
    }

    // ---------- live tab ----------
    // Two tables (one per team); rows fill in as profile:progress patches arrive:
    //   champion + spells + runes | player + tags | rank + LP + ranked WR | champion stats | mastery | past-season peak | details
    // Tags, team overviews and premade groups are computed by the main process (profile-live.js); this file only draws them.
    const TAG_CLS = { good: 'tg-good', bad: 'tg-bad', info: 'tg-info', warn: 'tg-warn', purple: 'tg-purple' };
    const APEX_T = ['MASTER', 'GRANDMASTER', 'CHALLENGER'];
    const LINK_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>';
    const PREMADE_SRC = { party: 'same party in your lobby', match: 'played together in cached matches', ids: 'share recent matches' };
    let liveTimer = null;
    function scheduleLivePaint() {
        if (liveTimer) return;
        liveTimer = setTimeout(() => { liveTimer = null; paintLiveTab(); }, 120);
    }
    const rankLabel = e => e ? `${tierName(e.tier)}${APEX_T.includes(e.tier) || !e.rank ? '' : ' ' + e.rank}` : '';
    const f1 = v => (Math.round(v * 10) / 10).toFixed(1);

    function tagPills(p) {
        return (p.tags || []).map(t => `<span class="pf-tag ${TAG_CLS[t.cls] || ''}" title="${esc(t.tip || t.label)}">${esc(t.label)}</span>`).join('');
    }
    function premadeOf(g, idx) { return ((S.live && S.live.premades) || []).find(x => x.members.includes(idx)) || null; }
    function premadePill(p, grp) {
        if (!grp) return '';
        const others = grp.members.filter(i => i !== p.idx).map(i => { const q = S.live.game.players[i]; return q && q.name ? q.name : 'player ' + (i + 1); });
        const src = grp.src.map(s => PREMADE_SRC[s] || s).join(', ');
        return `<span class="pf-prem" style="--gc:${esc(grp.color)}" title="${esc(grp.kind)}: with ${esc(others.join(', '))} (${esc(src)})">${LINK_SVG}${esc(grp.kind)}</span>`;
    }

    // --- runes ---
    function perkPage(perks) {
        if (!perks || !Array.isArray(perks.ids) || perks.ids.length < 6) return null;
        const id = perks.ids;
        return { pk: [perks.style, id.slice(0, 4), perks.sub, id.slice(4, 6), id.slice(6, 9)] };
    }
    function shardIc(id) {
        const si = shardInfo(id);
        return `<span class="pf-rn shard on" title="${esc(si.name)}">${si.src ? `<img loading="lazy" src="${esc(si.src)}" alt="">` : ''}</span>`;
    }
    function runeCell(p) {
        if (!p.perks || !p.perks.ids || !p.perks.ids.length) return '<div class="pf-sr"><span class="pf-rune pf-empty" title="Runes appear once the game is on Riot\'s servers"></span><span class="pf-rune pf-empty"></span></div>';
        const key = p.perks.ids[0];
        const pg = perkPage(p.perks);
        let pop = '';
        if (pg) {
            const [ps, psel, ss, ssel, stat] = pg.pk, tn = id => (D.trees[id] ? D.trees[id].name : '');
            pop = `<div class="pf-rpop"><div class="pf-rp-row"><span class="pf-rp-t">${esc(tn(ps))}</span>${psel.map(r => runeIc(r, true, r === psel[0])).join('')}</div>
              <div class="pf-rp-row"><span class="pf-rp-t">${esc(tn(ss))}</span>${ssel.map(r => runeIc(r, true)).join('')}</div>
              <div class="pf-rp-row"><span class="pf-rp-t">Shards</span>${stat.map(shardIc).join('')}</div></div>`;
        }
        return `<div class="pf-sr pf-runecell">${runeImg(key, 'pf-rune')}${runeImg(p.perks.sub, 'pf-rune pf-rune2')}${pop}</div>`;
    }
    function fullRunes(p) {
        const pg = perkPage(p.perks);
        if (!pg) return '<div class="pf-muted">Rune data is not available yet (Riot\'s live-game service shows runes once the game has started).</div>';
        loadShards();
        return runesHtml(pg);
    }

    // --- cells ---
    function rankCell(p) {
        if (p.bot) return '<span class="pf-muted">Bot</span>';
        if (!p.loaded) return '<span class="pf-sk-inline"></span>';
        const solo = (p.ranked || []).find(e => e.queueType === 'RANKED_SOLO_5x5');
        if (!solo) return '<span class="pf-muted">Unranked</span>';
        const total = solo.wins + solo.losses, wr = pct(solo.wins, total);
        return `<div class="pf-rk">${emb(solo.tier, 'mini', 'pf-emb-sm')}<div><div><span class="pf-tier-txt t-${esc(solo.tier)}">${esc(rankLabel(solo))}</span> <span class="pf-muted">${solo.leaguePoints} LP</span></div>
          <div class="pf-muted"><span class="${wr >= 50 ? 'pf-pos' : 'pf-neg'}">${wr}%</span> &middot; ${solo.wins}W ${solo.losses}L</div></div></div>`;
    }
    // champion stats: op.gg (ranked solo this season) first, else the games cached on this device
    function champCell(p) {
        if (p.bot) return '';
        const og = p.og;
        if (og && og.state === 'ok' && og.champ && og.champ.exact) {
            const c = og.champ, tip = `Source: op.gg, ${og.queue || 'ranked'} ${og.season || 'this season'}${og.stale ? ' (cached copy; refresh failed)' : ''}`;
            if (!c.g) return `<div title="${esc(tip)}"><span class="pf-muted">0 games on ${esc(champName(p.championId))}</span><div class="pf-muted">${esc(og.season || '')} ${esc(og.queue || '')}</div></div>`;
            const wr = pct(c.w, c.g);
            return `<div title="${esc(tip)}"><div><b>${c.g}</b> <span class="pf-muted">game${c.g === 1 ? '' : 's'}</span> &middot; <span class="${wr >= 50 ? 'pf-pos' : 'pf-neg'}">${wr}%</span> <span class="pf-muted">${c.w}W ${c.l}L</span></div>
              <div class="pf-muted">${c.kda.toFixed(2)} KDA (${f1(c.k)}/${f1(c.d)}/${f1(c.a)}) &middot; ${f1(c.cs)} cs/m</div></div>`;
        }
        if (og && og.state === 'ok' && og.champ && !og.champ.exact) {
            return `<div title="Source: op.gg ${esc(og.queue || '')} ${esc(og.season || '')}: op.gg lists only a player's most played champions"><span class="pf-muted">Under ${og.champ.max + 1} games on ${esc(champName(p.championId))}</span><div class="pf-muted">not in top ${og.top ? og.top.length : ''} champions</div></div>`;
        }
        const pending = S.live && S.live.game.opgg && !p.og;
        const cc = p.champ;
        if (cc && cc.games) {
            const wr = pct(cc.wins, cc.games), kda = kdaRatio(cc.k, cc.d, cc.a), csm = cc.dur ? (cc.cs / (cc.dur / 60)).toFixed(1) : null;
            return `<div title="Source: recent games stored on this device${p.og && p.og.state === 'fail' ? ' (op.gg unavailable: ' + esc(p.og.error) + ')' : ''}"><div><b>${cc.games}</b> <span class="pf-muted">recent</span> &middot; <span class="${wr >= 50 ? 'pf-pos' : 'pf-neg'}">${wr}%</span> <span class="pf-muted">${cc.wins}W ${cc.games - cc.wins}L</span></div>
              <div class="pf-muted">${kda}${kda === 'Perfect' ? '' : ' KDA'}${csm ? ' &middot; ' + csm + ' cs/m' : ''}</div></div>`;
        }
        if (pending) return '<span class="pf-sk-inline"></span>';
        return `<span class="pf-muted" title="${esc(p.og && p.og.state === 'fail' ? 'op.gg unavailable: ' + p.og.error : 'No data')}">${p.og && p.og.state === 'fail' ? 'op.gg unavailable' : '-'}</span>`;
    }
    function formLine(p) {
        const sc = S.scout[p.puuid];
        if (sc) return `<span title="Source: Riot match history (last ${sc.games} games)">Last ${sc.games}: <b class="${sc.wins >= sc.games / 2 ? 'pf-pos' : 'pf-neg'}">${sc.wins}-${sc.games - sc.wins}</b></span>`;
        if (p.form && p.form.games >= 3) return `<span title="Source: recent games stored on this device">Cached last ${p.form.games}: ${p.form.wins}-${p.form.games - p.form.wins}</span>`;
        return '';
    }
    function masteryCell(p) {
        if (p.bot) return '';
        if (!p.mastery) return p.loaded ? '<span class="pf-muted">-</span>' : '<span class="pf-sk-inline"></span>';
        if (!p.mastery.points) return '<span class="pf-muted">none</span>';
        return `<div title="${num(p.mastery.points)} mastery points"><b>Lv ${p.mastery.level}</b><div class="pf-muted">${p.mastery.points >= 10000 ? Math.round(p.mastery.points / 1000) + 'k' : num(p.mastery.points)}</div></div>`;
    }
    function peakCell(p) {
        if (p.bot) return '';
        const og = p.og;
        if (!og) return S.live.game.opgg ? '<span class="pf-sk-inline"></span>' : '<span class="pf-muted">-</span>';
        if (og.state !== 'ok') return '<span class="pf-muted" title="op.gg unavailable">-</span>';
        if (!og.peak) return '<span class="pf-muted" title="No ranked past seasons on op.gg">-</span>';
        const k = og.peak;
        return `<div class="pf-rk" title="Best rank across past seasons (${k.kind === 'peak' ? 'season peak' : 'season end'}, ${esc(k.season)}). Source: op.gg">${emb(k.tier, 'mini', 'pf-emb-sm')}<div><div><span class="pf-tier-txt t-${esc(k.tier)}">${esc(rankLabel(k))}</span></div><div class="pf-muted">${esc(k.season)}</div></div></div>`;
    }

    function liveRow(p) {
        const grp = premadeOf(S.live.game, p.idx);
        const open = S.liveOpen.has(p.idx);
        const nm = p.bot ? '<span class="pf-muted">Bot</span>' : (p.name ? playerLink(p) : '<span class="pf-muted">Hidden</span>');
        const err = p.error ? ` <span class="pf-warn" title="${esc(p.error.error || 'Some data could not be loaded')}">!</span>` : '';
        return `<div class="pf-lv-row ${p.me ? 'me' : ''} ${open ? 'open' : ''}" ${grp ? `style="--gc:${esc(grp.color)}"` : ''} data-idx="${p.idx}">
          <div class="pf-lv-champ">${icon(champImg(p.championId), 'pf-lv-img', champName(p.championId))}<div class="pf-sr">${spellImg(p.spell1Id)}${spellImg(p.spell2Id)}</div>${runeCell(p)}</div>
          <div class="pf-lv-pl"><div class="pf-lv-name">${premadePill(p, grp)}${nm}${err}</div><div class="pf-muted pf-lv-cn">${esc(champName(p.championId))}</div><div class="pf-tags">${tagPills(p)}</div></div>
          <div>${rankCell(p)}</div>
          <div>${champCell(p)}${formLine(p) ? `<div class="pf-muted pf-formline">${formLine(p)}</div>` : ''}</div>
          <div>${masteryCell(p)}</div>
          <div>${peakCell(p)}</div>
          <div class="pf-lv-x"><button class="pf-btn pf-small" data-act="liveopen" data-i="${p.idx}" title="Details">${open ? '&#9650;' : '&#9660;'}</button></div>
          ${open ? liveDetail(p) : ''}</div>`;
    }
    function liveDetail(p) {
        const og = p.og && p.og.state === 'ok' ? p.og : null;
        let h = '<div class="pf-lv-detail">';
        h += `<div><div class="pf-sec-h">Runes</div>${fullRunes(p)}</div>`;
        let mid = '<div class="pf-sec-h">Season on op.gg</div>';
        if (og) {
            if (og.all) mid += `<div class="pf-muted">${esc(og.queue)} ${esc(og.season || '')}: ${og.all.g} games, ${pct(og.all.w, og.all.g)}% WR, ${og.all.kda.toFixed(2)} KDA, ${f1(og.all.cs)} cs/m</div>`;
            if (og.top && og.top.length) mid += og.top.map(c => `<div class="pf-lv-top"><b>${esc(c.name)}</b><span>${c.g} g</span><span class="${pct(c.w, c.g) >= 50 ? 'pf-pos' : 'pf-neg'}">${pct(c.w, c.g)}%</span><span class="pf-muted">${c.kda.toFixed(2)} KDA</span><span class="pf-muted">${f1(c.cs)} cs/m</span></div>`).join('');
            if (og.roles) {
                const tot = Object.values(og.roles).reduce((a, r) => a + r.g, 0);
                mid += '<div class="pf-sec-h">Role share</div><div class="pf-roles">' + ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'].filter(k => og.roles[k]).map(k => `<span title="${og.roles[k].g} games"><i style="height:${tot ? Math.max(2, Math.round(og.roles[k].g / tot * 36)) : 2}px"></i>${POS_LABEL[k]}<b>${og.roles[k].pct}%</b></span>`).join('') + '</div>';
            }
        } else mid += `<div class="pf-muted">${p.og && p.og.state === 'fail' ? 'op.gg unavailable: ' + esc(p.og.error) + (p.og.backoff ? ' (will retry later)' : '') : 'Loading...'}</div>`;
        h += `<div>${mid}</div>`;
        const sc = S.scout[p.puuid];
        let rg = '<div class="pf-sec-h">Recent form</div>';
        if (p.puuid && !p.bot) rg += `<button class="pf-btn pf-small" data-act="scout" data-i="${p.idx}">${sc ? 'Reload last 5' : 'Last 5 games'}</button> <span class="pf-muted">~6 Riot requests</span>`;
        if (sc) rg += `<div class="pf-lv-form">${sc.results.map(r => `<span class="${r.win ? 'w' : 'l'}" title="${esc(champName(r.champId))} ${r.k}/${r.d}/${r.a}">${icon(champImg(r.champId), 'pf-pimg', '')}<i>${r.win ? 'W' : 'L'}</i></span>`).join('')}</div>`;
        else if (p.form && p.form.games) rg += `<div class="pf-muted">${p.form.wins}-${p.form.games - p.form.wins} in the last ${p.form.games} games stored on this device</div>`;
        h += `<div>${rg}</div></div>`;
        return h;
    }

    function teamBlock(g, tid) {
        const ps = g.players.filter(p => p.teamId === tid);
        const T = (S.live.teams && S.live.teams[tid]) || null;
        const bans = (g.bans || []).filter(b => b.teamId === tid && b.championId > 0).map(b => icon(champImg(b.championId), 'pf-ban', 'Banned: ' + champName(b.championId))).join('');
        let avg = '<span class="pf-muted">scouting...</span>';
        if (T && T.ranked > 0 && T.avgRank) {
            const r = T.avgRank;
            avg = `${emb(r.tier, 'mini', 'pf-emb-xs')}<span class="pf-tier-txt t-${esc(r.tier)}">${r.apex ? 'Master+' : esc(rankLabel(r))}</span> <span class="pf-muted">${r.lp} LP &middot; ${T.ranked}/${T.players} ranked</span>`;
        } else if (T && T.loaded >= T.players && T.players) avg = '<span class="pf-muted">no ranked players</span>';
        const wr = T && T.avgWr != null ? `<span class="${T.avgWr >= 50 ? 'pf-pos' : 'pf-neg'}">${T.avgWr}%</span>` : '<span class="pf-muted">-</span>';
        const colH = `<div class="pf-lv-cols"><span>Champion</span><span>Player</span><span>Rank (solo)</span><span title="${esc(champHint(g))}">Champion stats</span><span>Mastery</span><span title="Best past-season rank (op.gg)">Past peak</span><span></span></div>`;
        return `<section class="pf-lv-team ${tid === 100 ? 'blue' : 'red'}">
          <header class="pf-lv-th"><b>${tid === 100 ? 'Blue' : 'Red'} team</b><span class="pf-lv-avg" title="Average of the solo ranks of the players that are ranked">Avg rank ${avg}</span>
            <span class="pf-lv-avg" title="Mean of the players' ranked solo win rates">Avg WR ${wr}</span><span class="pf-grow"></span>${bans ? `<span class="pf-lv-bans" title="Bans"><span class="pf-muted">Bans</span>${bans}</span>` : ''}</header>
          ${colH}${ps.map(liveRow).join('')}</section>`;
    }
    function champHint(g) {
        const gt = g.queueId === 440 ? 'Ranked Flex' : 'Ranked Solo/Duo';
        return `This season's ${gt} games on the champion being played (op.gg). Falls back to games stored on this device.`;
    }

    // the element that actually scrolls the live view (the page itself or an ancestor), so repaints keep the reading position
    function scroller(el) {
        for (let n = el; n && n !== document.body; n = n.parentElement) { const o = getComputedStyle(n).overflowY; if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) return n; }
        return document.scrollingElement || document.documentElement;
    }
    // On someone else's profile the tab shows their game; one line says whose game it is and offers the other one
    function liveNote() {
        if (!S.profile || onOwnProfile()) return '';
        const who = `${esc(S.profile.gameName)}<i>#${esc(S.profile.tagLine)}</i>`;
        if (S.liveWho === 'me') return `<div class="pf-live-note">Showing <b>your</b> game. You are viewing ${who}. <button class="pf-link" data-act="liveviewed">Show ${esc(S.profile.gameName)}’s game</button></div>`;
        if (inMyGame()) return `<div class="pf-live-note">You are in a game: <button class="pf-link" data-act="livemine">show my game</button></div>`;
        return '';
    }
    function paintLiveTab() {
        const el = root.querySelector('#pf-live'); if (!el) return;
        el.style.display = S.tab === 'live' ? '' : 'none';
        if (S.tab !== 'live') return;
        const note = liveNote();
        if (S.liveLoading && !S.live) { el.innerHTML = note + skeleton(); return; }
        const L = S.live;
        if (!L) { el.innerHTML = note; return; }
        if (L.error) { el.innerHTML = note + errHtml(L.error); return; }
        if (!L.inGame) { el.innerHTML = note + `<div class="pf-empty-state">Not in game.<br><button class="pf-btn" data-act="livereload">Check again</button></div>`; return; }
        const g = L.game;
        const done = g.players.filter(p => p.loaded).length, total = g.players.filter(p => !p.bot).length;
        const ogDone = g.players.filter(p => p.og).length;
        const scr = scroller(el), scroll = scr.scrollTop;
        el.innerHTML = note + `<div class="pf-live-head"><b>${esc(S.queues[g.queueId] || 'Game')}</b> <span class="pf-timer" data-start="${g.startTime}">${g.startTime ? fmtDur(Math.max(0, (Date.now() - g.startTime) / 1000)) : (g.source === 'lcu' ? 'Loading screen' : '')}</span>
          <span class="pf-muted">${done < total ? `Scouting ${done}/${total}...` : 'Ranks loaded'}${g.opgg ? (ogDone < total ? ` &middot; op.gg ${ogDone}/${total}` : ' &middot; op.gg done') : ''}${L.finished && L.budget ? ` &middot; ${L.budget.riot} Riot request${L.budget.riot === 1 ? '' : 's'}` : ''}${g.source === 'lcu' ? ' &middot; roster from the client; runes and bans appear when Riot\'s live-game service has the game' : ''}</span>
          <span class="pf-grow"></span>${provChip('live', { title: 'Live game data', short: 'Riot API + op.gg', source: g.source === 'lcu' ? 'League client + Riot API' : 'Riot API (spectator-v5)', rows: [['Players scouted', `${done}/${total}`], ['op.gg champion stats', g.opgg ? `${ogDone}/${total}` : 'off'], ['Riot requests', L.budget ? String(L.budget.riot) : '…']],
              fetchedAt: S.liveAt || null, note: 'Ranks, mastery and recent form come from the Riot API (ranks from the client when it runs); season champion stats and past ranks from op.gg. Everything is cached and rate-limited.',
              onRefresh: async () => { loadLive(true); return { message: 'Checking the game again…' }; } })} ${help('tags')}
          <button class="pf-btn pf-small" data-act="livereload">Refresh</button></div>${teamBlock(g, 100)}${teamBlock(g, 200)}`;
        scr.scrollTop = scroll;
        hydrateEmblems();
        const tiers = []; for (const p of g.players) { for (const e of p.ranked || []) tiers.push(e.tier); if (p.og && p.og.peak) tiers.push(p.og.peak.tier); }
        for (const T of Object.values(L.teams || {})) if (T && T.avgRank) tiers.push(T.avgRank.tier);
        ensureEmblems('mini', tiers);
    }

    // ---------- events ----------
    // Clicking a champion portrait opens its Coachless builds (Builds view). In match rows/scoreboards the player's lane
    // picks the role; elsewhere the champion's usual role. The Build tab's player picker keeps its own meaning.
    const BUILDS_ROLE = { TOP: 'TOP', JUNGLE: 'JUNGLE', MIDDLE: 'MIDDLE', BOTTOM: 'BOTTOM', UTILITY: 'SUPPORT' };
    function openChampBuilds(e) {
        const pic = e.target.closest('img.pf-champ, img.pf-pimg, img.pf-cs-img, img.pf-lv-img, img.pf-ban');
        if (!pic || !root.contains(pic) || pic.closest('.pf-pick') || !window.DD.openBuilds) return false;
        const m = /\/img\/champion\/([^/.]+)\.png/.exec(pic.getAttribute('src') || '');
        if (!m) return false;
        const posEl = pic.closest('[data-pos]');
        e.preventDefault(); e.stopPropagation();
        window.DD.openBuilds(decodeURIComponent(m[1]), posEl ? BUILDS_ROLE[posEl.dataset.pos] || null : null);
        return true;
    }
    async function onClick(e) {
        if (openChampBuilds(e)) return;
        const t = e.target.closest('[data-act]'); if (!t || !root.contains(t)) return;
        const act = t.dataset.act;
        if (act === 'open') { e.stopPropagation(); if (t.dataset.t) openAccount({ gameName: t.dataset.n, tagLine: t.dataset.t, platform: (t.closest('.pf-lv-row') && S.live && S.live.platform) || (S.acct || DEFAULT_ACCOUNT).platform }); }
        else if (act === 'home') openOwner();
        else if (act === 'livemine') loadLive(true, 'me');
        else if (act === 'liveviewed') loadLive(true, 'viewed');
        else if (act === 'expand') {
            const id = t.dataset.id; S.expanded.has(id) ? S.expanded.delete(id) : S.expanded.add(id);
            repaintMatch(id);
        }
        else if (act === 'mtab') { S.mtab[t.dataset.id] = t.dataset.t; repaintMatch(t.dataset.id); }
        else if (act === 'review') {   // the post-game card: open that match on its Review tab
            const id = t.dataset.id; S.expanded.add(id); S.mtab[id] = 'review'; repaintMatch(id);
            const card = root.querySelector(`.pf-match[data-id="${CSS.escape(id)}"]`); if (card) card.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
        else if (act === 'mpick') { S.mpick[t.dataset.id] = +t.dataset.i; repaintMatch(t.dataset.id); }
        else if (act === 'tlretry') { const m = S.matches.find(x => x.id === t.dataset.id); if (m) { ensureTimeline(m, true); repaintMatch(m.id); } }
        else if (act === 'sq') { S.seasonQ = t.dataset.q; paintLeft(); }
        else if (act === 'sall') { S.seasonAll = !S.seasonAll; paintLeft(); }
        else if (act === 'srec') { S.seasonRec = !S.seasonRec; paintLeft(); }
        else if (act === 'group') { S.group = t.dataset.g; S.matchError = null; loadMatches(true, false); }
        else if (act === 'more') loadMatches(false, false);
        else if (act === 'cfilter') setChampFilter(Number(t.dataset.c) || null);
        else if (act === 'copypg') { const c = t.closest('.pf-postgame'); if (c) window.DD.copyAsImage(c, 'the post-game card'); }
        else if (act === 'tab') { S.tab = t.dataset.t; if (S.tab === 'live') { S.liveBadge = false; loadLive(); } paintBody(); if (S.tab === 'insights') loadInsights(); }
        else if (act === 'inssort') { S.insSort = S.insSort === t.dataset.k ? 'g' : t.dataset.k; paintInsights(); }
        else if (act === 'insreload') loadInsights(true);
        else if (act === 'golive') { S.tab = 'live'; S.liveBadge = false; paintBody(); loadLive(false, 'me'); }   // the red badge is your game
        else if (act === 'livereload') loadLive(true);
        else if (act === 'liveopen') { const i = +t.dataset.i; S.liveOpen.has(i) ? S.liveOpen.delete(i) : S.liveOpen.add(i); paintLiveTab(); }
        else if (act === 'retry') { if (S.acct) openAccount(S.acct, { force: true }); }
        else if (act === 'recent') { const a = S.recent[+t.dataset.i]; if (a) openAccount(a); }
        else if (act === 'update') {
            if (!S.profile || Date.now() < S.cooldownUntil) return;
            S.cooldownUntil = Date.now() + UPDATE_COOLDOWN; paintTop();
            const token = S.token;
            const r = await api.invoke('profile:lookup', { ...S.acct, force: true }).catch(() => null);
            if (token !== S.token) return;
            if (r && r.ok) { S.profile = r.profile; S.lastUpdate = Date.now(); S.stale = false; S.error = null; }
            else if (r) S.matchError = r;
            await loadMatches(true, true); loadLedger(); paintBody(); loadSeasons(false);
        }
        else if (act === 'backfill') {
            S.backfill = { state: 'running', done: 0, total: 100 }; paintBody();
            const r = await api.invoke('profile:backfill', { puuid: S.profile.puuid, platform: S.profile.platform, max: 100 }).catch(() => null);
            if (!r || !r.ok) { S.backfill = null; paintBody(); }
        }
        else if (act === 'backfill-cancel') { if (S.profile) api.invoke('profile:backfill-cancel', { puuid: S.profile.puuid }).catch(() => null); }
        else if (act === 'scout') {
            const p = S.live && S.live.game && S.live.game.players[+t.dataset.i]; if (!p || !p.puuid) return;
            t.disabled = true; t.textContent = '...';
            const r = await api.invoke('profile:scout', { puuid: p.puuid, platform: S.live.platform || S.acct.platform, championId: p.championId, gameKey: S.live.gameKey, idx: p.idx }).catch(() => null);
            if (r && r.ok) S.scout[p.puuid] = r.form;
            paintLiveTab();
        }
    }
    root.addEventListener('change', e => {
        const t = e.target;
        if (t.dataset && t.dataset.act === 'ledgergroup') { S.ledgerGroup = t.value; S.played = null; paintLeft(); loadPlayed(); }
        if (t.dataset && t.dataset.act === 'insgroup') { S.insGroup = t.value; S.ins = null; S.bt = null; paintInsights(); loadInsights(); }
        if (t.dataset && t.dataset.act === 'goal') saveGoal(t.dataset.role, t.dataset.k, t.value);
        if (t.dataset && t.dataset.act === 'goalrole') { S.goalRole = t.value; paintInsights(); }
        if (t.id === 'pf-cfilter') { const c = champByName(t.value); if (c) setChampFilter(c); else if (t.value.trim()) t.select(); }
    });
    root.addEventListener('keydown', e => { if (e.target.id === 'pf-cfilter' && e.key === 'Enter') { const c = champByName(e.target.value); if (c) setChampFilter(c); } });

    // ---------- champion filter: the match list, Insights and the champion table follow it ----------
    function champOptions() { return [...(window.DD.getChampions() || [])].sort((a, b) => String(a.name).localeCompare(String(b.name))).map(c => `<option value="${esc(c.name)}"></option>`).join(''); }
    function champByName(v) {
        const q = String(v || '').trim().toLowerCase(); if (!q) return null;
        const list = window.DD.getChampions() || [];
        const c = list.find(x => String(x.name).toLowerCase() === q) || list.find(x => String(x.id).toLowerCase() === q);
        return c ? Number(c.key) : null;
    }
    // a champion's name that sets the filter (its portrait next to it still opens Builds)
    const cfName = (c, tag) => `<${tag} class="pf-cfname" data-act="cfilter" data-c="${c}" title="Show only ${esc(champName(c))} games">${esc(champName(c))}</${tag}>`;
    function champFilterChip() {
        return S.champFilter ? `<span class="pf-cfchip">${icon(champImg(S.champFilter), 'pf-cs-img', '')}<b>${esc(champName(S.champFilter))}</b> only<button type="button" class="pf-cfx" data-act="cfilter" data-c="" title="Show every champion" aria-label="Clear the champion filter">&times;</button></span>` : '';
    }
    function setChampFilter(c) {
        if (!S.profile || c === S.champFilter) return;
        S.champFilter = c;
        S.matchError = null;
        loadMatches(true, false);
        S.ins = null; S.bt = null;
        if (S.tab === 'insights') { paintInsights(); loadInsights(); }
    }

    function onUpdate(ev) {
        if (!ev) return;
        const isCur = S.profile && ev.puuid === S.profile.puuid;
        if (ev.kind === 'lp') { S.lp = null; if (S.tab === 'insights') paintInsights(); return; }   // a ranked game's LP was recorded
        if (ev.kind === 'profile' && isCur) { S.profile = ev.profile; S.stale = false; S.lastUpdate = Date.now(); paintBody(); }
        else if (ev.kind === 'matches' && isCur) { if (!ev.group || ev.group === S.group || S.group === 'all') loadMatches(true, false); loadLedger(); }
        else if (ev.kind === 'ledger' && isCur) { loadLedger(); if (S.tab === 'insights') loadInsights(); }
        else if (ev.kind === 'matches-error' && isCur) { S.matchError = ev.error; paintMatches(); }
    }
    let ledgerTimer = null;
    function onProgress(ev) {
        if (!ev) return;
        if (ev.kind === 'backfill' && S.profile && ev.puuid === S.profile.puuid) {
            S.backfill = ev; if (ev.state !== 'running') { S.backfill = null; } const h = root.querySelector('.pf-head'); if (h) h.outerHTML = headerHtml();
            // keep the "Champions this season" card in step with the games cached so far (throttled; the final 'ledger' update also reloads)
            if (ev.state === 'running' && !ledgerTimer) ledgerTimer = setTimeout(() => { ledgerTimer = null; loadLedger(); }, 1500);
        } else if (ev.kind === 'live') {
            if (S.live && S.live.gameKey === ev.gameKey) {
                applyLiveEvent(S.live, ev);
                scheduleLivePaint();
            } else (S.liveBuf[ev.gameKey] = S.liveBuf[ev.gameKey] || []).push(ev);
        }
    }
    function onLive(ev) {
        S.livePhase = ev;
        S.liveBadge = !!(ev && ev.active);
        if (!S.liveBadge) { if (S.tab === 'live' && S.live && S.live.inGame) { /* keep the last scoreboard visible */ } }
        else if (S.tab === 'live') loadLive(true, 'me');   // the client says YOUR game started: it is yours, whichever profile is open
        paintTop(); if (S.tab === 'live') paintLiveTab();
        const tab = root.querySelector('.pf-tab[data-t="live"]'); if (tab) tab.innerHTML = 'Live game' + (S.liveBadge ? ' <span class="pf-dot"></span>' : '');
    }

    // timers: update clock, cooldown, live timer, retry countdown
    let tickTimer = null;
    function startTick() {
        if (tickTimer) return;
        tickTimer = setInterval(() => {
            if (window.DD.currentView() !== 'profile') return;
            paintTop();
            root.querySelectorAll('.pf-timer[data-start]').forEach(el => { const s = +el.dataset.start; if (s) el.textContent = fmtDur(Math.max(0, (Date.now() - s) / 1000)); });
            root.querySelectorAll('.pf-bfwait[data-resume]').forEach(el => { el.textContent = fmtDur(Math.max(0, Math.ceil((+el.dataset.resume - Date.now()) / 1000))); });
            root.querySelectorAll('.pf-retry[data-retry]').forEach(el => { const l = Math.ceil((+el.dataset.retry - Date.now()) / 1000); el.textContent = l > 0 ? `(${l}s)` : '(you can retry now)'; });
        }, 1000);
    }

    // ---------- init ----------
    async function init() {
        if (S.inited) return; S.inited = true;
        shell();
        root.querySelector('#pf-body').innerHTML = skeleton();
        await window.DD.ready;
        champMap = champByKey();
        const st = await readSettings();
        S.recent = Array.isArray(st.profileRecent) ? st.profileRecent.filter(a => a && a.gameName && a.tagLine && a.platform).slice(0, 8) : [];
        const [stat] = await Promise.all([api.invoke('profile:static').catch(() => null), refreshOwner(), loadStatic(), loadGoals()]);
        if (stat && stat.ok) { S.queues = stat.queues; applyGroups(stat); }
        // start on your own account: the client's, else the last one seen, else Settings > Default account (profile:owner)
        const acct = S.owner ? acctOf(S.owner) : DEFAULT_ACCOUNT;
        const pending = S.pendingAcct, tab = S.tab, who = S.pendingWho; S.pendingAcct = null; S.pendingWho = null;
        await openAccount(pending || acct);
        if (tab && tab !== 'summary') showTab(tab, who);
    }
    api.on('profile:update', onUpdate);
    api.on('profile:progress', onProgress);
    api.on('profile:live', onLive);
    window.DD.onView(name => { if (name === 'profile') { if (!S.inited) init(); else { refreshOwner().catch(() => {}); paintTop(); if (S.profile && S.profile.isOwner) loadMatches(true, false); } } });
    // Alt+Home: back to your own profile
    if (typeof document.addEventListener === 'function') document.addEventListener('keydown', e => { if (e.altKey && e.key === 'Home' && S.inited && window.DD.currentView() === 'profile') { e.preventDefault(); openOwner(); } });
    if (window.DD.currentView() === 'profile') init();
    // From other views (command palette, "Follow my game"): open an account or a tab. Before the view has started, the
    // account is remembered and used instead of the default one.
    function showTab(t, who) {
        if (!['summary', 'insights', 'live'].includes(t)) return;
        S.tab = t;
        if (t === 'live') { S.liveBadge = false; loadLive(false, who); }
        if (S.profile) { paintBody(); if (t === 'insights') loadInsights(); }
    }
    window.DDProfile = {
        open: openAccount, state: S, showTab: t => showTab(t), openOwner() { window.DD.showView('profile'); return S.inited ? openOwner() : undefined; },
        // sidebar / Follow my game / palette: no account + the live tab means YOUR game
        openFromOutside(acct, tab) {
            const who = !acct && tab === 'live' ? 'me' : undefined;
            if (!S.inited) { S.pendingAcct = acct; S.pendingWho = who; S.tab = tab || 'summary'; window.DD.showView('profile'); return; }
            window.DD.showView('profile');
            if (acct) openAccount(acct).then(() => { if (tab) showTab(tab); }); else if (tab) showTab(tab, who);
        }
    };
})();
