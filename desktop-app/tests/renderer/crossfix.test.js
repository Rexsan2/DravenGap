// Cross-owner hand-offs (fixer XO, 2026-11-01): renderer changes other fixers asked for in files they did not own.
//   B2-F11  notifications.js: profile:update { kind:'key-rejected', owner:true } shows "Your Riot key was rejected" + Open Settings
//   B2-F12  profile-view.js / multisearch.js: a lookup whose league part failed (partial.league) shows "Rank unavailable" + Retry,
//           not "Unranked"; Retry looks the player up again
//   D2-F21  app-shell.js: Ctrl+K offers "Open profile" for a Riot ID with a Hangul tagline
//   D2-F3   premades-view.js / duo-view.js: the partner's puuid goes with profile:duo-history / profile:group-history
//   D1-F16  workflow.js: started during an ARAM Mayhem champion select (profile:me answers phase + queueId, no profile:phase push),
//           the flow bar shows the single ARAM action (second boot)
const H = require('../lib/renderer-harness');
const R = H.results();

const PU = n => ('P' + n).padEnd(78, 'x');
const OWN = PU('TestOwner'), PA = PU('Alpha'), PB = PU('Bravo');
const ME = { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' };
const GOLD = { queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', leaguePoints: 40, wins: 10, losses: 9 };
const GONE = { ok: false, code: 'HTTP', error: 'Riot API error (500).' };
const friends = [{ name: 'Alpha', tag: 'EUW', puuid: PA, games: 20, w: 12, l: 8, wr: 60 }, { name: 'Bravo', tag: 'EUW', puuid: PB, games: 14, w: 7, l: 7, wr: 50 }];
const hist = (theirPos, theirs) => ({ ok: true, puuid: OWN, scanned: 60, games: 5, w: 3, lanes: [{ myPos: 'MIDDLE', theirPos, games: 5, w: 3 }],
    pairs: [{ mine: 103, theirs, games: 5, w: 3, myPos: 'MIDDLE', theirPos }], partnerChamps: { [theirPos]: { [theirs]: 5 } } });

(async () => {
    let h;
    try {
        const V = { rankDown: true };
        const calls = { lookup: [], multi: [], duo: [], group: [] };
        const prof = a => ({ puuid: PU(a.gameName), gameName: a.gameName, tagLine: a.tagLine, platform: a.platform || 'EUW1', isOwner: a.gameName === 'TestOwner',
            summonerLevel: 100, profileIconId: 29, ranked: a.gameName === 'Ranked' && !V.rankDown ? [GOLD] : [], mastery: [], updatedAt: 0 });
        const partial = a => (a.gameName === 'Ranked' && V.rankDown ? { partial: { league: GONE } } : {});   // what profile-main.js sends (B2-F12)
        h = await H.boot({ ipc: {
            'profile:owner': () => ({ ok: true, owner: { ...ME, puuid: OWN }, source: 'client' }),
            'profile:me': () => ({ ok: true, me: ME, lcu: true, phase: 'None', queueId: null }),
            'profile:static': () => ({ ok: true, queues: { 420: 'Ranked Solo/Duo' } }),
            'profile:lookup': (e, a) => { calls.lookup.push(a); return { ok: true, stale: false, profile: prof(a), ...partial(a) }; },
            'profile:matches': (e, a) => ({ ok: true, puuid: a.puuid, group: a.group, start: a.start || 0, nextStart: 0, hasMore: false, matches: [] }),
            'profile:ledger': () => ({ ok: true, rows: [], total: 0 }),
            'profile:played': () => ({ ok: true, scanned: 60, list: friends.slice() }),
            'profile:multi': (e, a) => { calls.multi.push(a); return { ok: true, profile: prof(a), form: { games: 0, results: [] }, tags: [], ...partial(a) }; },
            'profile:duo': () => ({ ok: true, lcu: true, inLobby: true, partners: [{ gameName: 'Alpha', tagLine: 'EUW', positions: ['JUNGLE'], assigned: null, championId: 0 }],
                me: { ...ME, positions: ['MIDDLE'], assigned: null } }),
            'profile:duo-history': (e, a) => { calls.duo.push(a); return a.partner.gameName === 'Bravo' ? hist('BOTTOM', 222) : hist('JUNGLE', 64); },
            'profile:group-history': (e, a) => { calls.group.push(a); return { ok: true, scanned: 60, games: 3, w: 2, lineups: [], combos: [] }; }
        } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        await h.ev(`window.addEventListener('unhandledrejection', e => console.error('Uncaught rejection: ' + String(e.reason && e.reason.stack || e.reason).replace(/\\s+/g, ' ').slice(0, 280))); 1`);
        const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await h.sleep(50); } return false; };

        // ================================================================ B2-F11: the key-rejected push
        const KR = `[...document.querySelectorAll('.dg-toast')].filter(t => /Riot key was rejected/.test(t.textContent))`;
        h.send('profile:update', { kind: 'key-rejected', owner: true });
        const shown = await h.waitFor(`${KR}.length === 1`, 5000);
        const tt = await h.ev(`(() => { const t = ${KR}[0]; return t ? { text: t.querySelector('span').textContent, btn: (t.querySelector('button') || {}).textContent } : null; })()`);
        R.ok('B2-F11: profile:update { kind: key-rejected } shows "Your Riot key was rejected: paste a new one in Settings" with Open Settings',
            shown && tt && /^Your Riot key was rejected: paste a new one in Settings/.test(tt.text) && tt.btn === 'Open Settings', tt);
        await h.ev(`(() => { const t = ${KR}[0], b = t && t.querySelector('button'); if (b) b.click(); return 1; })()`);
        R.ok('B2-F11: "Open Settings" opens the Settings dialog', await h.waitFor(`document.getElementById('settings-modal').style.display === 'flex'`, 3000));
        await h.ev(`document.getElementById('settings-close-btn').click(); 1`);
        await h.sleep(400);
        h.send('profile:update', { kind: 'key-rejected', owner: true });
        await h.sleep(600);
        R.ok('B2-F11: the same push again does not show a second toast (one per event)', (await h.ev(`${KR}.length`)) === 0);

        // ================================================================ B2-F12: Profile header
        const PS = `DDProfile.state`;
        const ranks = () => h.ev(`((document.querySelector('#profile-root .pf-ranks') || {}).textContent || '').replace(/\\s+/g, ' ')`);
        await h.ev(`DD.showView('profile'); 1`);
        await h.waitFor(`!!${PS}.profile && ${PS}.profile.gameName === 'TestOwner'`, 10000);
        await h.ev(`DDProfile.open({ gameName: 'Ranked', tagLine: 'EUW', platform: 'EUW1' }); 1`);
        await h.waitFor(`!!${PS}.profile && ${PS}.profile.gameName === 'Ranked' && !!document.querySelector('#profile-root .pf-ranks')`, 10000);
        let rk = await ranks();
        const btns = await h.ev(`document.querySelectorAll('#profile-root [data-act="rankretry"]').length`);
        R.ok('B2-F12: the league request failed: the header says "Rank unavailable" with Retry (not "Unranked")', /Rank unavailable/.test(rk) && !/Unranked/.test(rk) && btns === 2, { rk, btns });
        V.rankDown = false;
        let n0 = calls.lookup.length;
        await h.ev(`(() => { const b = document.querySelector('#profile-root [data-act="rankretry"]'); if (b) b.click(); return 1; })()`);
        const healed = await h.waitFor(`/Gold II/.test(document.querySelector('#profile-root .pf-ranks').textContent)`, 8000);
        rk = await ranks();
        R.ok('B2-F12: Retry looks the player up again (not forced) and shows the rank', healed && calls.lookup.length === n0 + 1 && calls.lookup[n0].gameName === 'Ranked' && !calls.lookup[n0].force
            && !/Rank unavailable/.test(rk) && /Ranked Flex\s*Unranked/.test(rk), { rk, call: calls.lookup[n0] });
        await h.ev(`DDProfile.open({ gameName: 'Plain', tagLine: 'EUW', platform: 'EUW1' }); 1`);
        await h.waitFor(`!!${PS}.profile && ${PS}.profile.gameName === 'Plain' && !!document.querySelector('#profile-root .pf-ranks')`, 10000);
        rk = await ranks();
        R.ok('B2-F12: a player with no rank and no failed part is still "Unranked" (nothing carried over)', (rk.match(/Unranked/g) || []).length === 2 && !/Rank unavailable/.test(rk), rk);

        // ================================================================ D2-F21: Ctrl+K with a Hangul tagline
        const palette = q => h.ev(`(() => { DD.openPalette(); const i = document.querySelector('.dg-pal-in'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input'));
            return [...document.querySelectorAll('.dg-pal-item .dg-pal-l')].map(e => e.textContent).filter(t => /^Open profile/.test(t)); })()`);
        const ascii = await palette('Friend#EUW'), tooLong = await palette('Friend#TOOLONG');
        const hangul = await palette('Kimchi#한국');
        n0 = calls.lookup.length;
        await h.ev(`document.querySelector('.dg-pal-in').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); document.querySelector('.dg-pal-back').style.display = 'none'; 1`);
        await until(() => calls.lookup.slice(n0).some(a => a.gameName === 'Kimchi'), 6000);
        const kl = calls.lookup.slice(n0).find(a => a.gameName === 'Kimchi');
        R.ok('D2-F21: Ctrl+K "Kimchi#한국" offers "Open profile Kimchi#한국" and looks up that tagline', hangul[0] === 'Open profile Kimchi#한국' && !!kl && kl.tagLine === '한국', { hangul, kl });
        R.ok('D2-F21: ASCII tags still work, a 7-letter tag is still not a Riot ID', ascii[0] === 'Open profile Friend#EUW' && tooLong.length === 0, { ascii, tooLong });
        await h.waitFor(`!!${PS}.profile && ${PS}.profile.gameName === 'Kimchi'`, 8000);

        // ================================================================ B2-F12: Multi-search cards
        V.rankDown = true;
        const card = name => h.ev(`(() => { const c = [...document.querySelectorAll('#ms-cards .ms-card')].find(c => c.querySelector('.ms-name').firstChild.textContent === '${name}');
            return c ? { text: c.textContent.replace(/\\s+/g, ' '), retry: !!c.querySelector('[data-rank-retry]'), loading: c.classList.contains('loading') } : null; })()`);
        await h.ev(`DD.showView('scout'); DDScout.setText('Ranked#EUW\\nPlain#EUW'); DDScout.search(); 1`);
        await h.waitFor(`document.querySelectorAll('#ms-cards .ms-card').length === 2 && !document.querySelector('#ms-cards .ms-card.loading')`, 10000);
        let cr = await card('Ranked');
        const cp = await card('Plain');
        R.ok('B2-F12: Multi-search: the card whose rank failed says "rank unavailable" with Retry; the other still says "unranked"',
            cr && /Solo\/Duo: rank unavailable/.test(cr.text) && cr.retry && cp && /Solo\/Duo: unranked/.test(cp.text) && !cp.retry, { cr, cp });
        V.rankDown = false;
        n0 = calls.multi.length;
        await h.ev(`(() => { const b = document.querySelector('#ms-cards [data-rank-retry]'); if (b) b.click(); return 1; })()`);
        await h.waitFor(`[...document.querySelectorAll('#ms-cards .ms-card')].some(c => /Gold II/.test(c.textContent))`, 8000);
        cr = await card('Ranked');
        R.ok('B2-F12: Multi-search Retry looks only that player up again and stays on Multi-search (no profile opened)',
            calls.multi.length === n0 + 1 && calls.multi[n0].gameName === 'Ranked' && /Gold II/.test(cr.text) && !cr.retry && (await h.ev(`DD.currentView()`)) === 'scout', { cr, calls: calls.multi.slice(n0) });

        // ================================================================ D2-F3: Premades sends the friend's puuid
        await h.ev(`DD.showView('premades'); 1`);
        await until(() => calls.duo.some(a => a.partner.gameName === 'Alpha'), 15000);
        const pa = calls.duo.find(a => a.partner.gameName === 'Alpha');
        R.ok('D2-F3: Premades asks for your games with Alpha with her puuid', !!pa && pa.partner.puuid === PA && pa.partner.tagLine === 'EUW', pa && pa.partner);
        await h.waitFor(`!!document.querySelector('#premades-root [data-stack="bravo#euw"]')`, 10000);
        const tick = name => h.ev(`(() => { const c = document.querySelector('#premades-root [data-stack="${name}#euw"]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
        await tick('alpha'); await tick('bravo');
        await until(() => calls.group.some(a => a.partners.length === 2), 15000);
        const g = calls.group.find(a => a.partners.length === 2);
        R.ok('D2-F3: the stack planner sends every partner\'s puuid to group-history', !!g && JSON.stringify(g.partners.map(p => [p.gameName, p.puuid])) === JSON.stringify([['Alpha', PA], ['Bravo', PB]]), g && g.partners);

        // ================================================================ D2-F3: Duo
        let k0 = calls.duo.length;
        await h.ev(`DD.showView('draft'); document.getElementById('duo-tab-btn').click(); 1`);
        await until(() => calls.duo.slice(k0).some(a => a.partner.gameName === 'Alpha'), 15000);
        const lobby = calls.duo.slice(k0).find(a => a.partner.gameName === 'Alpha');
        R.ok('D2-F3: Duo, partner from your lobby: the puuid comes from "games together" when the Riot ID is there', !!lobby && lobby.partner.puuid === PA, lobby && lobby.partner);
        const pick = label => h.ev(`(() => { const s = document.querySelector('#duo-view [data-duo="partner"]'); const o = [...s.options].find(o => o.textContent.startsWith('${label}'));
            if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await h.waitFor(`[...document.querySelectorAll('#duo-view [data-duo="partner"] option')].some(o => o.textContent.startsWith('Bravo#EUW'))`, 10000);
        k0 = calls.duo.length;
        const picked = await pick('Bravo#EUW');
        await until(() => calls.duo.slice(k0).some(a => a.partner.gameName === 'Bravo'), 10000);
        const bv = calls.duo.slice(k0).find(a => a.partner.gameName === 'Bravo');
        R.ok('D2-F3: Duo, partner chosen from "games together": sent with its puuid', picked && !!bv && bv.partner.puuid === PB, bv && bv.partner);
        k0 = calls.duo.length;
        await h.ev(`(() => { const i = document.querySelector('#duo-view [data-duo="typed"]'); i.value = 'Nobody#EUW'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#duo-view [data-duo="use"]').click(); return 1; })()`);
        await until(() => calls.duo.slice(k0).some(a => a.partner.gameName === 'Nobody'), 10000);
        const nb = calls.duo.slice(k0).find(a => a.partner.gameName === 'Nobody');
        R.ok('D2-F3: Duo, a typed Riot ID that is not in "games together": no puuid (name#tag only, as before)', !!nb && !nb.partner.puuid, nb && nb.partner);

        const errs = h.logs.filter(l => /Uncaught|TypeError|ReferenceError/.test(l));
        R.ok('no uncaught errors (first boot)', errs.length === 0, errs.slice(-5));

        // ================================================================ D1-F16: started during an ARAM Mayhem champion select
        await h.close();
        h = await H.boot({ ipc: {
            'profile:owner': () => ({ ok: true, owner: { ...ME, puuid: OWN }, source: 'client' }),
            'profile:me': () => ({ ok: true, me: ME, lcu: true, phase: 'ChampSelect', queueId: 2400 })   // and no profile:phase push
        } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        await h.waitFor(`DD.flow && DD.flow.state.phase === 'ChampSelect' && !!document.querySelector('#flow-bar .fb-act')`, 10000);
        await h.sleep(500);
        const fb = await h.ev(`({ acts: [...document.querySelectorAll('#flow-bar .fb-act:not(.fb-more)')].map(b => b.dataset.fbAct), q: DD.flow.state.queueId,
            text: document.getElementById('flow-bar').textContent.replace(/\\s+/g, ' ').slice(0, 200) })`);
        R.ok('D1-F16: profile:me { phase: ChampSelect, queueId: 2400 } with no push: the flow bar shows exactly one "aram" action', JSON.stringify(fb.acts) === '["aram"]' && fb.q === 2400 && /ARAM champion select/.test(fb.text), fb);
        const errs2 = h.logs.filter(l => /Uncaught|TypeError|ReferenceError/.test(l));
        R.ok('no uncaught errors (second boot)', errs2.length === 0, errs2.slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
