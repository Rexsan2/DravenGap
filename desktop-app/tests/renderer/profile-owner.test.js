// Profile and "your own account" (FEEDBACK items 1 and 2): while someone else's profile is open, the Live game tab shows THEIR
// game, but when the client says YOUR game started the request carries no Riot ID (the main process uses the client's account);
// the Home button shows your Riot ID on other profiles only and opens your profile; Alt+Home does the same.
const H = require('../lib/renderer-harness');
const R = H.results();
const PU = n => ('P' + n).padEnd(78, 'x');
const prof = a => ({ puuid: PU(a.gameName), gameName: a.gameName, tagLine: a.tagLine, platform: a.platform || 'EUW1', isOwner: a.gameName === 'TestOwner', summonerLevel: 100, profileIconId: 29, ranked: [], mastery: [] });

(async () => {
    try {
        const liveCalls = [], lookups = [], matchCalls = [], insCalls = [];
        const h = await H.boot({ ipc: {
            'profile:owner': () => ({ ok: true, owner: { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1', puuid: PU('TestOwner') }, source: 'client' }),
            'profile:me': () => ({ ok: true, me: { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' }, lcu: true, phase: 'None' }),
            'profile:static': () => ({ ok: true, queues: { 420: 'Ranked Solo/Duo' } }),
            'profile:lookup': (e, a) => { lookups.push(a.gameName); return { ok: true, profile: prof(a) }; },
            'profile:matches': (e, a) => { matchCalls.push(a); return { ok: true, puuid: a.puuid, group: a.group, start: 0, nextStart: 0, hasMore: false, matches: [] }; },
            'profile:insights': (e, a) => { insCalls.push(a); return { ok: true, n: 0, scanned: 0, group: a.group }; },
            'profile:ledger': () => ({ ok: true, rows: [], total: 0 }),
            'profile:played': () => ({ ok: true, list: [], scanned: 0 }),
            'profile:live': (e, a) => { liveCalls.push(a || {}); return { ok: true, inGame: false }; }
        } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        const page = f => h.ev(`(${f})()`);
        const homeShown = () => page(() => { const b = document.getElementById('pf-home'); return !!b && b.style.display !== 'none' ? b.textContent : null; });
        const viewing = () => page(() => (DDProfile.state.profile ? DDProfile.state.profile.gameName : null));

        await h.ev(`DD.showView('profile'); 1`);
        R.ok('Profile opens on your own account (profile:owner)', await h.waitFor(`!!DDProfile.state.profile && DDProfile.state.profile.gameName === 'TestOwner'`, 10000), await viewing());
        R.ok('no Home button on your own profile', (await homeShown()) === null);

        await h.ev(`DDProfile.open({ gameName: 'Alpha', tagLine: 'EUW', platform: 'EUW1' }); 1`);
        await h.waitFor(`!!DDProfile.state.profile && DDProfile.state.profile.gameName === 'Alpha'`, 10000);
        await h.sleep(200);
        const home = await homeShown();
        R.ok('on another profile the Home button shows your Riot ID', !!home && /TestOwner/.test(home) && /META/.test(home), home);

        // the Live game tab on Alpha's profile asks for Alpha's game
        liveCalls.length = 0;
        await h.ev(`DDProfile.showTab('live'); 1`);
        await h.waitFor(`true`); await h.sleep(400);
        R.ok("Live game tab on someone else's profile asks for their game", liveCalls.length >= 1 && liveCalls[0].gameName === 'Alpha', liveCalls.map(a => a.gameName || '(mine)'));

        // the client says YOUR game started: no Riot ID in the request, whoever is on screen
        liveCalls.length = 0;
        h.send('profile:live', { active: true, phase: 'InProgress', gameId: 1, queueId: 420 });
        await h.sleep(600);
        R.ok('your game starting asks for your game (no Riot ID), not the viewed player\'s', liveCalls.length >= 1 && liveCalls.every(a => !a.gameName), liveCalls.map(a => a.gameName || '(mine)'));

        // Home: back to your profile, then the button hides again
        await h.ev(`DDProfile.showTab('summary'); document.getElementById('pf-home').click(); 1`);
        R.ok('the Home button opens your profile', await h.waitFor(`!!DDProfile.state.profile && DDProfile.state.profile.gameName === 'TestOwner'`, 10000), await viewing());
        await h.sleep(200);
        R.ok('and hides there', (await homeShown()) === null);

        // Alt+Home from another profile
        await h.ev(`DDProfile.open({ gameName: 'Bravo', tagLine: 'EUW', platform: 'EUW1' }); 1`);
        await h.waitFor(`!!DDProfile.state.profile && DDProfile.state.profile.gameName === 'Bravo'`, 10000);
        await h.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', altKey: true, bubbles: true })); 1`);
        R.ok('Alt+Home opens your profile', await h.waitFor(`!!DDProfile.state.profile && DDProfile.state.profile.gameName === 'TestOwner'`, 10000), await viewing());

        // champion filter (FEEDBACK item 11): typing a name in the box filters the match list; the chip's x clears it
        matchCalls.length = 0;
        await h.ev(`(() => { const i = document.getElementById('pf-cfilter'); i.value = 'ahri'; i.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
        await h.waitFor(`!!document.querySelector('#profile-root .pf-cfchip')`, 5000);
        R.ok('choosing a champion asks for its games only and shows a chip', matchCalls.length >= 1 && matchCalls[matchCalls.length - 1].champId === 103 && /Ahri/.test(await h.ev(`document.querySelector('#profile-root .pf-cfchip').textContent`)), matchCalls.map(a => a.champId));
        R.ok('the empty list says which champion', /No games on Ahri found/.test(await h.ev(`document.querySelector('#profile-root .pf-empty-state').textContent`)));
        insCalls.length = 0;
        await h.ev(`DDProfile.showTab('insights'); 1`);
        await h.waitFor(`true`); await h.sleep(300);
        R.ok('Insights follow the filter', insCalls.length >= 1 && insCalls[insCalls.length - 1].champId === 103, insCalls.map(a => a.champId));
        await h.ev(`DDProfile.showTab('summary'); 1`);
        matchCalls.length = 0;
        await h.ev(`document.querySelector('#profile-root .pf-qtabs .pf-cfx').click(); 1`);
        await h.waitFor(`!!document.getElementById('pf-cfilter')`, 5000);
        R.ok('x clears it (every champion again)', matchCalls.length >= 1 && matchCalls[matchCalls.length - 1].champId == null, matchCalls.map(a => a.champId));

        const errs = h.logs.filter(l => /Uncaught|TypeError|ReferenceError/.test(l));
        R.ok('no uncaught errors', errs.length === 0, errs);
    } catch (e) { R.ok('test ran', false, String(e && e.stack || e)); }
    R.finish();
})();
