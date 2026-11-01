// Profile view fixes, the expanded match (code review 2026-11-01, fixer P1): another player's post-game card and Review tab name
// the player instead of "you"; the Review items note shows one patch range; ARAM Mayhem games (recorded from the client) ask Riot
// for no timeline; replay "Watch from" opens the replay unless THIS game's replay is open now (no sticky `running`), "Opened."
// only after a real open; a replay state that moves on its own (no client, checking) is read again.
const H = require('../lib/renderer-harness');
const { APP } = require('../lib/common');
const C = require(APP + 'profile-compact');
const TLm = require(APP + 'profile-timeline');
const { timeline } = require('../lib/timeline-fixture');
const R = H.results();
const PU = n => ('P' + n).padEnd(78, 'x');
const now = Date.now();
// a recent Summoner's Rift game where the viewed player is participant 1 (Top, Ahri), and an ARAM Mayhem game recorded from the client
const gameOf = (name, id, o = {}) => { const raw = require('../lib/raw-match')(PU(name), now)(id, { queueId: 420, ageH: 0.5, ...o }); if (o.lcu) raw.metadata.src = 'lcu'; return C.compactMatch(raw); };
const rawTl = id => { const t = timeline(id); t.info.frames[12].events.push({ type: 'CHAMPION_KILL', timestamp: 720000, killerId: 6, victimId: 1, assistingParticipantIds: [7], position: { x: 2000, y: 12500 } }); return t; };
const tlFor = cm => TLm.deriveTimeline(TLm.compactTimeline(rawTl(cm.id)), cm.players.map(p => p.team));
const ITEMS = { data: { 3031: { name: 'Infinity Edge', gold: { total: 3400 }, into: [] }, 3006: { name: 'Berserker\'s Greaves', gold: { total: 1100 }, into: [] } } };

(async () => {
    try {
        const games = { Alpha: [gameOf('Alpha', 'EUW1_7001')], TestOwner: [gameOf('TestOwner', 'EUW1_7101'), gameOf('TestOwner', 'EUW1_7102', { queueId: 2400, mode: 'ARAM', positions: false, ageH: 5, lcu: true })] };
        const tls = {}; for (const cm of [...games.Alpha, ...games.TestOwner]) tls[cm.id] = tlFor(cm);
        const tlCalls = [], opens = [], seeks = [];
        const V = { state: () => ({ ok: true, state: 'watch', apiEnabled: true, running: false }), seek: () => ({ ok: true }) };
        const h = await H.boot({ size: [1400, 900], ipc: {
            'profile:owner': () => ({ ok: true, owner: { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1', puuid: PU('TestOwner') }, source: 'client' }),
            'profile:lookup': (e, a) => ({ ok: true, profile: { puuid: PU(a.gameName), gameName: a.gameName, tagLine: a.tagLine, platform: 'EUW1', isOwner: a.gameName === 'TestOwner', summonerLevel: 100, profileIconId: 29, ranked: [], mastery: [] } }),
            'profile:matches': (e, a) => { const n = Object.keys(games).find(k => PU(k) === a.puuid); return { ok: true, puuid: a.puuid, group: a.group, start: 0, nextStart: 1, hasMore: false, matches: games[n] || [] }; },
            'profile:ledger': () => ({ ok: true, rows: [], total: 0 }),
            'profile:timeline': (e, a) => { tlCalls.push(a.id); return tls[a.id] ? { ok: true, timeline: tls[a.id], cached: true } : { ok: false, code: 'NOT_FOUND', error: 'none' }; },
            'lcu:replay-state': () => V.state(),
            'lcu:replay-open': (e, a) => { opens.push(a.gameId); return { ok: true }; },
            'lcu:replay-seek': (e, a) => { seeks.push(a.time); return V.seek(); }
        } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        // the harness serves no item.json: give the view two items (Infinity Edge is a completed item), and a saved Coachless table for two patches
        await h.ev(`(() => { const f0 = window.fetch; window.fetch = (u, o) => /item\\.json$/.test(String(u)) ? Promise.resolve(new Response(${JSON.stringify(JSON.stringify(ITEMS))}, { headers: { 'Content-Type': 'application/json' } })) : f0(u, o);
            DD.buildsTables = async () => ({ saved: true, patches: ['16.20', '16.19'], legendaries: [{ id: 3072, name: 'Bloodthirster', pp: 0.95, adj: 0.03, pickRate: 0.05 }] }); return 1; })()`);
        const S = `DDProfile.state`;
        const open = async (name, tag) => { await h.ev(`DDProfile.open({ gameName: '${name}', tagLine: '${tag}', platform: 'EUW1' }); 1`); await h.waitFor(`!!${S}.profile && ${S}.profile.gameName === '${name}' && ${S}.matches.length > 0`, 10000); await h.sleep(150); };
        const tab = async (id, t) => { await h.ev(`(() => { if (!${S}.expanded.has('${id}')) document.querySelector('#profile-root .pf-match[data-id="${id}"] .pf-mrow').click(); return 1; })()`);
            await h.waitFor(`!!document.querySelector('#profile-root .pf-match[data-id="${id}"] .pf-mtab[data-t="${t}"]')`, 5000);
            await h.ev(`document.querySelector('#profile-root .pf-match[data-id="${id}"] .pf-mtab[data-t="${t}"]').click(); 1`); };
        const text = sel => h.ev(`(() => { const e = document.querySelector('${sel}'); return e ? e.textContent.replace(/\\s+/g, ' ') : null; })()`);

        await h.ev(`DD.showView('profile'); 1`);
        await h.waitFor(`!!${S}.profile && ${S}.profile.gameName === 'TestOwner'`, 10000);

        // ---- B1-F18 + B1-F20: someone else's game
        await open('Alpha', 'EUW');
        const pg = await text('#profile-root .pf-postgame');
        R.ok('B1-F18: another player\'s post-game card is "Alpha’s last game" (not "Your last game")', /Alpha’s last game/.test(pg) && !/Your last game|your usual/.test(pg), pg && pg.slice(0, 160));
        await tab('EUW1_7001', 'review');
        await h.waitFor(`!!document.querySelector('#profile-root .pf-review') && /Coachless/.test(document.querySelector('#profile-root .pf-review').textContent)`, 8000);
        const rv = await text('#profile-root .pf-review');
        R.ok('B1-F18: their Review tab says "Alpha’s lane" / "Alpha’s items" and "their" deaths', /Alpha’s lane/.test(rv) && /Alpha’s items/.test(rv) && /their 1 death/.test(rv) && !/Your lane|Your items|your 1 death/.test(rv), rv.slice(0, 200));
        const tip = await h.ev(`(document.querySelector('#profile-root .pf-rv-map g.d') || { dataset: {} }).dataset.tip`);
        R.ok('B1-F18: the map\'s death mark says "Alpha died to"', /Alpha died to/.test(tip || ''), tip);
        R.ok('B1-F20: the Coachless note shows one patch range ("16.19–16.20")', /Coachless, Emerald\+, 16\.19–16\.20\)/.test(rv) && /not in their build/.test(rv), (rv.match(/Strong in the data[^)]*\)/) || [rv.slice(-120)])[0]);
        R.ok('(no replay box on someone else\'s game)', !/Replay ready|Open the League client/.test(rv));

        // ---- B1-F21: an ARAM Mayhem game recorded from the client asks Riot for no timeline
        await open('TestOwner', 'META');
        const t0 = tlCalls.length;
        await tab('EUW1_7102', 'build');
        await h.sleep(300);
        const bt = await text('#profile-root .pf-match[data-id="EUW1_7102"] .pf-expand');
        await tab('EUW1_7102', 'review'); await h.sleep(200);
        const rt = await text('#profile-root .pf-match[data-id="EUW1_7102"] .pf-expand');
        R.ok('B1-F21: Build / Review of a Mayhem game: no timeline request, and a note instead of "Riot only keeps timelines for recent games"',
            !tlCalls.slice(t0).includes('EUW1_7102') && /No timeline for ARAM Mayhem games/.test(bt) && /No timeline for ARAM Mayhem games/.test(rt) && !/recent games/.test(bt + rt), { calls: tlCalls.slice(t0), bt: bt.slice(-160) });
        await h.ev(`document.querySelector('#profile-root .pf-match[data-id="EUW1_7102"] .pf-mrow').click(); 1`);

        // ---- C-F15: "Open the League client" is read again (here when the tab is drawn again 3 s later)
        V.state = () => ({ ok: false, code: 'NO_CLIENT', error: 'Open the League client to watch replays.' });
        await tab('EUW1_7101', 'review');
        await h.waitFor(`/Open the League client to watch replays/.test(document.querySelector('#profile-root .pf-rv-replay').textContent)`, 8000);
        V.state = () => ({ ok: true, state: 'watch', apiEnabled: true, running: false });
        await h.sleep(3200);
        await tab('EUW1_7101', 'build'); await h.sleep(100); await tab('EUW1_7101', 'review');
        R.ok('C-F15: after the client starts, the Replay box is read again and offers the buttons', await h.waitFor(`/Replay ready/.test(document.querySelector('#profile-root .pf-rv-replay').textContent) && !!document.querySelector('#profile-root .pf-rv-replay [data-act="replayjump"]')`, 5000), await text('#profile-root .pf-rv-replay'));

        // ---- B1-F5: "Watch from" opens the replay unless this game's replay is open right now
        const jump = () => h.ev(`document.querySelector('#profile-root .pf-rv-replay [data-act="replayjump"]').click(); 1`);
        const msg = () => text('#profile-root .pf-rv-replay > .pf-muted');
        await jump();
        await h.waitFor(`/Jumped to/.test(document.querySelector('#profile-root .pf-rv-replay').textContent)`, 5000);
        R.ok('B1-F5: the first "Watch from" opens the replay, then seeks', opens.length === 1 && seeks.length === 1 && /Jumped to/.test(await msg()), { opens: opens.length, seeks: seeks.length });
        // the user closed the replay: main now reports running:false for this game; the second click opens it again (it used to only seek, for 2 minutes)
        await jump();
        await h.waitFor(`/Jumped to/.test(document.querySelector('#profile-root .pf-rv-replay').textContent) && ${S}.replay['EUW1_7101'].running`, 5000); await h.sleep(200);
        R.ok('B1-F5: after the replay was closed, the next "Watch from" opens it again (no sticky running)', opens.length === 2 && seeks.length === 2, { opens: opens.length, seeks: seeks.length });
        // main says this game's replay is open, but the seek fails (closed meanwhile): it is opened once more and the seek retried
        V.state = () => ({ ok: true, state: 'watch', apiEnabled: true, running: true });
        let fails = 1; V.seek = () => (fails-- > 0 ? { ok: false, error: 'The replay is not open, or its Replay API is off.' } : { ok: true });
        await jump(); await h.sleep(600);
        R.ok('B1-F5: a failed seek on a replay that looked open opens it once more and retries', opens.length === 3 && seeks.length === 4 && /Jumped to/.test(await msg()), { opens: opens.length, seeks: seeks.length, msg: await msg() });
        V.seek = () => ({ ok: true });
        await h.ev(`document.querySelector('#profile-root .pf-rv-replay [data-act="replayopen"]').click(); 1`); await h.sleep(400);
        R.ok('B1-F5: "Open the replay" while it is open says so (no "Opened.", no second open)', opens.length === 3 && /already open/.test(await msg()) && !/Opened\./.test(await msg()), await msg());
        V.state = () => ({ ok: true, state: 'watch', apiEnabled: true, running: false });
        await h.ev(`document.querySelector('#profile-root .pf-rv-replay [data-act="replayopen"]').click(); 1`); await h.sleep(400);
        R.ok('B1-F5: and while it is not open, opens it ("Opened.")', opens.length === 4 && /Opened\./.test(await msg()), await msg());

        // ---- C-F15: "checking" is read again on its own a few seconds later
        await open('Alpha', 'EUW'); await open('TestOwner', 'META');   // (a new profile load forgets the replay states)
        V.state = () => ({ ok: true, state: 'checking', apiEnabled: true, running: false });
        await tab('EUW1_7101', 'review');
        await h.waitFor(`/Replay: checking/.test(document.querySelector('#profile-root .pf-rv-replay').textContent)`, 8000);
        V.state = () => ({ ok: true, state: 'watch', apiEnabled: true, running: false });
        R.ok('C-F15: "Replay: checking" turns into "Replay ready." without a click', await h.waitFor(`/Replay ready/.test(document.querySelector('#profile-root .pf-rv-replay').textContent)`, 6000), await text('#profile-root .pf-rv-replay'));

        const errs = h.logs.filter(l => /Uncaught|TypeError|ReferenceError/.test(l));
        R.ok('no uncaught errors', errs.length === 0, errs);
    } catch (e) { R.ok('test ran', false, String(e && e.stack || e)); }
    R.finish();
})();
