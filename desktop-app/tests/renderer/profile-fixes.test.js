// Profile view fixes (code review 2026-11-01, fixer P1): your new game reaches every queue tab and the toast's "Open" shows it,
// "Review the game" / Follow my game open YOUR profile (also via WaitingForStats), a failed background refresh stops saying
// "Refreshing...", Insights re-run after a queue change mid-load, your own profile keeps Goals / LP / "your account" without the
// client, apex ranks have no division, "Load season history" says how it ended, Live game Retry re-checks the game, the clock stops
// at game over, the client-closed note, typed text survives repaints, a failed first match load still shows the season card,
// returning to Profile keeps the pages, nothing of the previous profile carries over, and "No account yet" Retry asks again.
const H = require('../lib/renderer-harness');
const { APP } = require('../lib/common');
const C = require(APP + 'profile-compact'), INS = require(APP + 'profile-insights');
const R = H.results();
const PU = n => ('P' + n).padEnd(78, 'x');
const OWN = PU('TestOwner');
const now = Date.now(), DAY = 864e5;
const raw = require('../lib/raw-match')(OWN, now);
const ownerMatch = (id, o) => C.compactMatch(raw(id, o));
const insightsData = INS.insights([ownerMatch('EUW1_9001', { queueId: 420, ageH: 30 }), ownerMatch('EUW1_9002', { queueId: 420, ageH: 40, win: false })], OWN);
// season ledger rows (the Goals card): 12 Mid games, 6 Top games
const row = (i, o) => ({ id: 'EUW1_' + i, q: 420, c: 103, w: 1, k: 5, d: 4, a: 6, cs: 200, dur: 1200, end: now - (i + 1) * 3 * DAY, pos: 'MIDDLE', vis: 20, kp: 50, rm: 0, ...o });
const rows = [...Array.from({ length: 12 }, (_, i) => row(i)), ...Array.from({ length: 6 }, (_, i) => row(200 + i, { pos: 'TOP', end: now - 50 * DAY }))];
// LP history: the last recorded game left you in Master (the client reports apex ranks with division "I")
const lpList = [{ q: 'RANKED_SOLO_5x5', after: { tier: 'DIAMOND', rank: 'I', lp: 90 }, delta: 20, win: true, at: now - 2 * DAY },
    { q: 'RANKED_SOLO_5x5', after: { tier: 'MASTER', rank: 'I', lp: 245 }, delta: 18, win: true, at: now - DAY }];
// a live game you are in (10 players)
const liveGame = { ok: true, inGame: true, gameKey: 'EUW1_555', game: { queueId: 420, startTime: now - 600e3, source: 'riot', bans: [], opgg: false,
    players: Array.from({ length: 10 }, (_, i) => ({ idx: i, teamId: i < 5 ? 100 : 200, championId: [103, 1, 2, 3, 4, 5, 6, 7, 8, 9][i], spell1Id: 4, spell2Id: 14, perks: null,
        name: i ? 'Mate' + i : 'TestOwner', tag: i ? 'EUW' : 'META', puuid: i ? PU('M' + i) : OWN, me: !i, bot: false, loaded: true, ranked: [], tags: [] })) } };

(async () => {
    try {
        const V = { ownerOk: true, isOwner: true, stale: {}, updatedAt: {}, note: {}, matchFail: {}, hasMore: false, holdIns: false,
            matches: () => [], live: () => ({ ok: true, inGame: false }) };
        const calls = { matches: [], lookup: [], live: [], ledger: [] }, insPending = [];
        const prof = a => ({ puuid: PU(a.gameName), gameName: a.gameName, tagLine: a.tagLine, platform: a.platform || 'EUW1', isOwner: a.gameName === 'TestOwner' && V.isOwner,
            summonerLevel: 100, profileIconId: 29, ranked: [], mastery: [], updatedAt: V.updatedAt[a.gameName] || 0 });
        const h = await H.boot({ ipc: {
            'profile:owner': () => (V.ownerOk ? { ok: true, owner: { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1', puuid: OWN }, source: 'client' } : { ok: false, code: 'NO_ACCOUNT', error: 'none' }),
            'profile:me': () => ({ ok: true, me: { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' }, lcu: true, phase: 'None' }),
            'profile:static': () => ({ ok: true, queues: { 420: 'Ranked Solo/Duo', 450: 'ARAM' } }),
            'profile:lookup': (e, a) => { calls.lookup.push(a); return { ok: true, stale: !!V.stale[a.gameName], profile: prof(a) }; },
            'profile:matches': (e, a) => { calls.matches.push(a); const f = V.matchFail[a.puuid]; if (f) return f;
                return { ok: true, puuid: a.puuid, group: a.group, start: a.start, nextStart: a.start + 1, hasMore: V.hasMore, note: V.note[a.puuid] || null, matches: V.matches(a) }; },
            'profile:ledger': (e, a) => { calls.ledger.push(a.puuid); return { ok: true, rows: a.puuid === OWN ? rows : [], total: rows.length }; },
            'profile:insights': (e, a) => (V.holdIns ? new Promise(res => insPending.push({ a, res })) : { ok: true, ...insightsData, scanned: 2, group: a.group }),
            'profile:lp-history': () => ({ ok: true, list: lpList }),
            'profile:played': () => ({ ok: true, list: [], scanned: 0 }),
            'profile:backfill': () => ({ ok: true, running: true }),
            'profile:live': (e, a) => { calls.live.push(a || {}); return V.live(a || {}); }
        } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        const S = `DDProfile.state`;
        const viewing = () => h.ev(`${S}.profile ? ${S}.profile.gameName : null`);
        const openAcct = async (name, tag = name === 'TestOwner' ? 'META' : 'EUW') => { await h.ev(`DDProfile.open({ gameName: '${name}', tagLine: '${tag}', platform: 'EUW1' }); 1`); await h.waitFor(`!!${S}.profile && ${S}.profile.gameName === '${name}' && !${S}.loadingMatches`, 10000); await h.sleep(150); };
        const text = sel => h.ev(`(() => { const e = document.querySelector('${sel}'); return e ? e.textContent : null; })()`);

        await h.ev(`DD.showView('profile'); 1`);
        await h.waitFor(`!!${S}.profile && ${S}.profile.gameName === 'TestOwner' && !!${S}.ledger`, 10000);

        // ---- B1-F9: text typed in "Filter by champion" survives a background repaint of the match list
        const focused = await h.ev(`(() => { const i = document.getElementById('pf-cfilter'); i.focus(); i.value = 'ah'; i.setSelectionRange(2, 2); return document.activeElement === i; })()`);
        let n0 = calls.matches.length;
        h.send('profile:update', { kind: 'matches', puuid: OWN, group: 'all', added: 1 });
        await h.waitFor(`true`); await h.sleep(400);
        const kept = await h.ev(`(() => { const i = document.getElementById('pf-cfilter'); return { value: i && i.value, focus: document.activeElement === i, caret: i && i.selectionStart }; })()`);
        R.ok('B1-F9: the filter box keeps its text, caret and focus when the list is repainted', focused && calls.matches.length > n0 && kept.value === 'ah' && kept.focus && kept.caret === 2, { focused, kept });
        await h.ev(`(() => { const i = document.getElementById('pf-cfilter'); i.value = ''; i.blur(); return 1; })()`);

        // ---- B1-F1: your post-game update (group 'all') reloads the Ranked Solo tab, and the toast's "Open" brings the new game into view
        await h.ev(`document.querySelector('#profile-root .pf-qtab[data-g="solo"]').click(); 1`);
        await h.waitFor(`${S}.group === 'solo' && !${S}.loadingMatches`, 5000);
        n0 = calls.matches.length;
        h.send('profile:update', { kind: 'matches', owner: true, puuid: OWN, group: 'all', added: 1, ids: ['EUW1_77'] });
        await h.waitFor(`true`); await h.sleep(400);
        const after = calls.matches.slice(n0);
        R.ok('B1-F1: the owner push (group all) reloads the open Ranked Solo list', after.some(a => a.group === 'solo'), after.map(a => a.group));
        V.matches = a => (a.group === 'all' ? [ownerMatch('EUW1_77', { queueId: 450, ageH: 0.2 })] : []);
        n0 = calls.matches.length;
        await h.ev(`DDProfile.openOwner(); 1`);
        await h.waitFor(`${S}.group === 'all' && ${S}.matches.some(m => m.id === 'EUW1_77')`, 5000);
        R.ok('B1-F1: "Open" on your own profile switches to the All list, reloads it and shows the new game (post-game card)',
            (await h.ev(`${S}.group === 'all' && ${S}.tab === 'summary' && ${S}.matches[0].id === 'EUW1_77'`)) && calls.matches.slice(n0).some(a => a.group === 'all') && !!(await text('#pf-right .pf-postgame')),
            { group: await h.ev(`${S}.group`), ids: await h.ev(`${S}.matches.map(m => m.id)`) });
        V.matches = () => [];

        // ---- B1-F14: back on the view, the loaded pages stay; a push while away reloads on return
        V.hasMore = true; V.matches = a => [ownerMatch('EUW1_' + (500 + a.start), { queueId: 420, ageH: 10 + a.start })];
        await openAcct('TestOwner');
        await h.ev(`document.querySelector('#profile-root .pf-more').click(); 1`);
        await h.waitFor(`${S}.matches.length === 2 && !${S}.loadingMatches`, 5000);
        n0 = calls.matches.length;
        await h.ev(`DD.showView('draft'); 1`); await h.sleep(150); await h.ev(`DD.showView('profile'); 1`); await h.sleep(400);
        R.ok('B1-F14: returning to Profile keeps "Show more" pages (no reload)', (await h.ev(`${S}.matches.length`)) === 2 && calls.matches.length === n0, { n: await h.ev(`${S}.matches.length`), calls: calls.matches.length - n0 });
        await h.ev(`DD.showView('draft'); 1`);
        h.send('profile:update', { kind: 'matches', owner: true, puuid: OWN, group: 'all', added: 1 });
        await h.sleep(300);
        const hiddenCalls = calls.matches.length - n0;
        await h.ev(`DD.showView('profile'); 1`); await h.sleep(400);
        R.ok('B1-F14: a game added while away reloads the list on return (not while hidden)', hiddenCalls === 0 && calls.matches.length > n0, { hiddenCalls, total: calls.matches.length - n0 });
        V.hasMore = false; V.matches = () => [];
        await openAcct('TestOwner');

        // ---- B1-F7: "Load season history" says how it ended
        await h.ev(`document.querySelector('#profile-root [data-act="backfill"]').click(); 1`); await h.sleep(200);
        h.send('profile:progress', { kind: 'backfill', puuid: OWN, done: 0, total: 100, state: 'error', error: { ok: false, code: 'KEY_REJECTED', error: 'rejected' } });
        await h.waitFor(`/key rejected/.test(document.querySelector('#profile-root .pf-head').textContent)`, 3000);
        const head1 = await text('#profile-root .pf-head');
        R.ok('B1-F7: an expired key ends the run with "Season history not loaded: Riot API key rejected"', /Season history not loaded: Riot API key rejected/.test(head1), head1.replace(/\s+/g, ' ').slice(0, 200));
        await h.ev(`document.querySelector('#profile-root [data-act="backfill"]').click(); 1`); await h.sleep(200);
        const head2 = await text('#profile-root .pf-head');
        h.send('profile:progress', { kind: 'backfill', puuid: OWN, done: 12, total: 100, state: 'done', error: null });
        await h.waitFor(`/12 games loaded/.test(document.querySelector('#profile-root .pf-head').textContent)`, 3000);
        R.ok('B1-F7: the next run clears it, and a finished run says how many games it loaded', !/key rejected/.test(head2) && /Season history: 12 games loaded/.test(await text('#profile-root .pf-head')));

        // ---- B1-F4 / B1-F19: without the client (isOwner false) your own profile keeps Goals, LP history and "your account"
        V.isOwner = false;
        await openAcct('TestOwner');
        await h.ev(`DDProfile.showTab('insights'); 1`);
        await h.waitFor(`!!document.querySelector('#profile-root .pf-goals') && !!document.querySelector('#profile-root .pf-lp-sum')`, 6000);
        R.ok('B1-F4: Goals and LP history show on your profile while the client is closed', !!(await text('#profile-root .pf-goals')) && !!(await text('#profile-root .pf-lp-sum')) && (await h.ev(`${S}.profile.isOwner`)) === false);
        R.ok('B1-F4: the header still says "your account"', /your account/.test(await text('#profile-root .pf-sub')));
        const lp = await text('#profile-root .pf-lp-sum');
        R.ok('B1-F19: LP history shows an apex rank without a division ("Master 245 LP")', /Now Master 245 LP/.test(lp) && !/Master I/.test(lp), lp.replace(/\s+/g, ' ').slice(0, 80));

        // ---- B1-F9 (goals): a goal being typed survives a profile repaint
        const gFocus = await h.ev(`(() => { const i = document.querySelector('#profile-root .pf-goal-in[data-k="csMin"]'); i.focus(); i.value = '12.5'; return document.activeElement === i; })()`);
        h.send('profile:update', { kind: 'profile', puuid: OWN, profile: { ...prof({ gameName: 'TestOwner', tagLine: 'META' }), updatedAt: now } });
        await h.sleep(400);
        const g = await h.ev(`(() => { const i = document.querySelector('#profile-root .pf-goal-in[data-k="csMin"]'); return { v: i && i.value, f: document.activeElement === i }; })()`);
        R.ok('B1-F9: a goal value being typed keeps its text and focus through a profile update', gFocus && g.v === '12.5' && g.f, { gFocus, g });
        await h.ev(`document.activeElement && document.activeElement.blur(); 1`);
        V.isOwner = true;

        // ---- B1-F2: changing the Insights queue while a load runs starts the new queue's load when the first answer arrives
        V.holdIns = true;
        await h.ev(`document.querySelector('#profile-root [data-act="insreload"]').click(); 1`);
        await h.waitFor(`true`); await h.sleep(200);
        await h.ev(`(() => { const s = document.querySelector('#profile-root [data-act="insgroup"]'); s.value = 'solo'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
        await h.sleep(200);
        const first = insPending.shift();
        if (first) first.res({ ok: true, ...insightsData, scanned: 2, group: first.a.group });
        await h.sleep(400);
        const second = insPending.shift();
        if (second) second.res({ ok: true, ...insightsData, scanned: 2, group: second.a.group });
        await h.sleep(300);
        R.ok('B1-F2: the queue chosen mid-load is computed (no endless "Crunching your games…")', first && first.a.group === 'all' && second && second.a.group === 'solo'
            && (await h.ev(`!!${S}.ins && ${S}.ins.group === 'solo'`)) && !/Crunching/.test(await text('#pf-insights')), { first: first && first.a.group, second: second && second.a.group });
        V.holdIns = false;
        await h.ev(`(() => { const s = document.querySelector('#profile-root [data-act="insgroup"]'); s.value = 'all'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);

        // ---- B1-F13: at game over the live clock stops
        V.live = () => liveGame;
        await h.ev(`DDProfile.showTab('live'); 1`);
        await h.waitFor(`!!document.querySelector('#pf-live .pf-timer[data-start]')`, 5000);
        h.send('profile:live', { active: false, phase: 'EndOfGame' });
        await h.sleep(1600);
        const clock = await h.ev(`(() => { const t = document.querySelector('#pf-live .pf-timer'); return t ? { text: t.textContent, start: t.hasAttribute('data-start') } : null; })()`);
        R.ok('B1-F13: the last scoreboard stays, its clock reads "Game over" and stops', clock && clock.text === 'Game over' && !clock.start && !!(await text('#pf-live .pf-lv-team')), clock);
        V.live = () => ({ ok: true, inGame: false });
        await h.ev(`DDProfile.showTab('summary'); 1`);

        // ---- B1-F8 (+ the note for B1-F16): a cached profile older than 2 min, whose background refresh fails
        V.stale.Stale = true; V.updatedAt.Stale = now - 3 * 3600e3; V.note[PU('Stale')] = 'No Riot API key: your games come from the League client (test note).';
        await openAcct('Stale');
        const lab1 = await text('#pf-updated');
        R.ok('B1-F8: "Refreshing..." with the age of the cached ranks (not "just now")', /Refreshing\.\.\./.test(lab1) && /3h ago/.test(lab1), lab1);
        h.send('profile:update', { kind: 'profile-error', puuid: PU('Stale'), error: { ok: false, code: 'OFFLINE', error: 'offline' } });
        await h.waitFor(`!/Refreshing/.test(document.getElementById('pf-updated').textContent)`, 3000);
        const lab2 = await text('#pf-updated');
        R.ok('B1-F8: a failed refresh says so instead of "Refreshing..." for good', /Could not refresh: Offline/.test(lab2) && !/Refreshing/.test(lab2), lab2);
        R.ok('(the keyless note shows on that profile)', /test note/.test(await text('#pf-right')));

        // ---- B1-F16 + B1-F11: the next profile's first match page fails
        V.matchFail[PU('Bravo')] = { ok: false, code: 'NO_KEY', error: 'No key' };
        const l0 = calls.ledger.length;
        await openAcct('Bravo');
        await h.sleep(300);
        R.ok('B1-F16: the previous profile\'s note does not carry over', (await h.ev(`${S}.matchNote`)) === null && !(await text('#pf-right .pf-keyless-note')) && /No Riot API key/.test(await text('#pf-right .pf-error')));
        const champCard = await text('#pf-left .pf-card');
        R.ok('B1-F11: "Champions this season" is still read from the cache (no endless "Loading...")', calls.ledger.slice(l0).includes(PU('Bravo')) && !/Loading/.test(champCard), champCard && champCard.replace(/\s+/g, ' ').slice(0, 100));

        // ---- B1-F6 + B1-F15: Live game errors on someone else's profile
        V.live = () => ({ ok: false, code: 'RATE_LIMITED', error: 'Rate limited (test).', retryAt: Date.now() + 12000 });
        await h.ev(`DDProfile.showTab('live'); 1`);
        await h.waitFor(`!!document.querySelector('#pf-live .pf-error button')`, 5000);
        const lk = calls.lookup.length, lv = calls.live.length;
        V.live = () => ({ ok: true, inGame: false, reason: 'no-client' });
        await h.ev(`document.querySelector('#pf-live .pf-error button').click(); 1`);
        await h.sleep(500);
        R.ok('B1-F6: Live game Retry checks the game again (stays on Live, no profile reload)', calls.live.length > lv && calls.lookup.length === lk && (await h.ev(`${S}.tab`)) === 'live', { live: calls.live.length - lv, lookups: calls.lookup.length - lk });
        R.ok('B1-F15: with the client closed the Live tab says so (not "Not in game")', /League client is not running/.test(await text('#pf-live')), await text('#pf-live'));
        V.live = () => ({ ok: true, inGame: false });
        await h.ev(`DDProfile.showTab('summary'); 1`);

        // ---- B1-F3 + B1-F10: Follow my game's end of game (through WaitingForStats) and the flow bar's Review open YOUR profile
        await openAcct('Alpha');
        const toasts = () => h.ev(`[...document.querySelectorAll('.dg-toast')].filter(t => /Game over/.test(t.textContent)).length`);
        const t0 = await toasts();
        await h.ev(`DD.followGame.onPhase({ prev: 'InProgress', next: 'WaitingForStats', queueId: 420 }); 1`);
        const toOwner = await h.waitFor(`!!${S}.profile && ${S}.profile.gameName === 'TestOwner' && ${S}.tab === 'summary'`, 8000);
        R.ok('B1-F10/B1-F3: InProgress -> WaitingForStats opens YOUR profile (not Alpha\'s) with the "Game over" toast', toOwner && (await h.ev(`DD.currentView()`)) === 'profile' && (await toasts()) === t0 + 1, { viewing: await viewing() });
        await h.ev(`DD.followGame.onPhase({ prev: 'WaitingForStats', next: 'PreEndOfGame', queueId: 420 }); DD.followGame.onPhase({ prev: 'PreEndOfGame', next: 'EndOfGame', queueId: 420 }); 1`);
        await h.sleep(300);
        R.ok('B1-F10: the later end-of-game phases do not fire again', (await toasts()) === t0 + 1);
        await openAcct('Alpha');
        await h.ev(`document.querySelector('#flow-bar [data-fb-step="review"]').click(); 1`);
        R.ok('B1-F3: the flow bar\'s "Review the game" opens YOUR profile', await h.waitFor(`!!${S}.profile && ${S}.profile.gameName === 'TestOwner'`, 8000), await viewing());

        // ---- B1-F17: "No account yet" Retry asks for the owner again
        V.ownerOk = false;
        await h.ev(`DDProfile.openOwner(); 1`);
        await h.waitFor(`!!document.querySelector('#profile-root .pf-error-NO_ACCOUNT button')`, 5000);
        V.ownerOk = true;
        await h.ev(`document.querySelector('#profile-root .pf-error-NO_ACCOUNT button').click(); 1`);
        R.ok('B1-F17: Retry on "No account yet" opens your profile once there is one', await h.waitFor(`!!${S}.profile && ${S}.profile.gameName === 'TestOwner'`, 8000), await viewing());

        const errs = h.logs.filter(l => /Uncaught|TypeError|ReferenceError/.test(l));
        R.ok('no uncaught errors', errs.length === 0, errs);
    } catch (e) { R.ok('test ran', false, String(e && e.stack || e)); }
    R.finish();
})();
