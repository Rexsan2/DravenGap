// Fix pass D2 (Premades, Duo, glossary): checks for the review findings fixed in premades-view.js, duo-view.js, glossary.js and
// multisearch.js.
//   Premades: an answer for the previous Time Period is dropped (D2-F4); "Most played together" opens the row clicked when ARAM combos
//   come first (D2-F2); Escape on a "?" popover leaves the details panel open (D2-F20); new games saved in Profile reload the list
//   (D2-F6); "Last N patches" counts your games from every released patch, labelled as a range (D2-F11).
//   Duo: no draft data shows an error and is tried again (D2-F14); Rank changes recompute and the tab keeps following the draft after
//   another view (A1-F4); a Hangul tagline is accepted (D2-F21); new games reload the partner list (D2-F6). Glossary "duo" (D2-F19).
const H = require('../lib/renderer-harness');
const R = H.results();

const PUUID = 'P'.padEnd(78, 'x');
const session = { localPlayerCellId: 0, actions: [[]], theirTeam: [{ cellId: 5, championId: 0, championPickIntent: 0 }],
    myTeam: [{ cellId: 0, championId: 0, championPickIntent: 0, assignedPosition: 'middle' }, { cellId: 1, championId: 0, championPickIntent: 0, assignedPosition: 'jungle' }] };
const none = { ok: true, scanned: 60, games: 0, w: 0, pairs: [], lanes: [], partnerChamps: {} };
const hist = (games, w, theirPos, theirs) => ({ ok: true, puuid: PUUID, scanned: 60, games, w, lanes: [{ myPos: 'MIDDLE', theirPos, games, w }],
    pairs: [{ mine: 103, theirs, games: 5, w: 3, myPos: 'MIDDLE', theirPos }], partnerChamps: { [theirPos]: { [theirs]: 8 } } });
const friends = [{ name: 'Alpha', tag: 'EUW', games: 20, w: 12, l: 8, wr: 60 }, { name: 'Bravo', tag: 'EUW', games: 14, w: 7, l: 7, wr: 50 }, { name: 'Charlie', tag: 'EUW', games: 9, w: 6, l: 3, wr: 67 }];

(async () => {
    let h;
    try {
        const playedCalls = [], histCalls = [];
        let played = friends.slice(), bravoDelay = 0;
        h = await H.boot({ ipc: {
            'get-champ-select': () => session,
            'profile:owner': () => ({ ok: true, owner: { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1', puuid: PUUID }, source: 'client' }),
            'profile:me': () => ({ ok: true, me: { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' }, lcu: true, phase: 'ChampSelect' }),
            'profile:duo': () => ({ ok: true, lcu: true, inLobby: true, partners: [{ gameName: 'Alpha', tagLine: 'EUW', positions: ['JUNGLE'], assigned: 'JUNGLE', championId: 0 }], me: { positions: ['MIDDLE'], assigned: 'MIDDLE' } }),
            'profile:played': (e, a) => { playedCalls.push(a); return { ok: true, scanned: 60, list: played.slice() }; },
            'profile:multi': (e, a) => ({ ok: true, profile: { gameName: a.gameName, mastery: [] }, form: { games: 0, results: [] } }),
            'profile:duo-history': async (e, a) => {
                histCalls.push(a);
                const n = a.partner.gameName, wide = Array.isArray(a.patches) && a.patches.includes('16.18');
                if (n === 'Alpha') return hist(20, 12, 'JUNGLE', 64);
                if (n === 'Bravo') { if (bravoDelay) await new Promise(r => setTimeout(r, bravoDelay)); return wide ? hist(30, 21, 'BOTTOM', 222) : hist(14, 7, 'BOTTOM', 222); }
                return none;
            },
            // an ARAM combo (no lanes) comes first, as it often does with friends; the Summoner's Rift one second
            'profile:group-history': () => ({ ok: true, scanned: 60, games: 12, w: 7, lineups: [{ pos: ['MIDDLE', 'JUNGLE', 'BOTTOM'], games: 3, w: 2 }],
                combos: [{ champs: [22, 51, 69], pos: ['', '', ''], games: 9, w: 5 }, { champs: [103, 64, 222], pos: ['MIDDLE', 'JUNGLE', 'BOTTOM'], games: 3, w: 2 }] })
        } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        await h.ev(`window.addEventListener('unhandledrejection', e => console.error('Uncaught rejection: ' + String(e.reason && e.reason.stack || e.reason).replace(/\\s+/g, ' ').slice(0, 280))); 1`);
        await h.sleep(1000);
        const side =() => h.ev(`document.getElementById('pm-side').textContent.replace(/\\s+/g, ' ')`);
        const big = () => h.ev(`(document.querySelector('#pm-main .pm-big') || {}).textContent || ''`);
        const setPeriod = v => h.ev(`(() => { const s = document.getElementById('time-period-select'); s.value = '${v}'; s.dispatchEvent(new Event('change')); return s.value; })()`);

        // ================================================================ Premades
        await h.ev(`DD.showView('premades'); 1`);
        R.ok('Premades lists the first friend', await h.waitFor(`/Together/.test(document.getElementById('pm-main').textContent)`, 20000), await side());

        // D2-F4: select Bravo (slow answer), switch the Time Period at once: the record shown is the new period's, and stays
        bravoDelay = 1200;
        await h.ev(`(() => { document.querySelector('#premades-root [data-friend="bravo#euw"]').click(); const s = document.getElementById('time-period-select'); s.value = '30'; s.dispatchEvent(new Event('change')); return 1; })()`);
        const newRec = await h.waitFor(`(document.querySelector('#pm-main .pm-big') || {}).textContent === '21-9'`, 15000);
        await h.sleep(2000);
        R.ok('D2-F4: a Time Period change during a friend\'s read ends with the new period\'s record (no stale answer)', newRec && (await big()) === '21-9', { shown: await big(), calls: histCalls.filter(a => a.partner.gameName === 'Bravo').map(a => a.patches) });
        R.ok('D2-F11: several patches are labelled as one range', /Last 30 Days \(16\.18–16\.19\)/.test(await side()), await side());
        bravoDelay = 0;
        await setPeriod('patch');
        await h.waitFor(`/Current|Patch 16\\.19/.test(document.getElementById('pm-side').textContent) && !/16\\.18/.test(document.getElementById('pm-side').textContent) && !!document.querySelector('#pm-main .pm-big')`, 15000);

        // D2-F2: 3-stack; "Most played together" lists only the Summoner's Rift combo; a click opens that combo
        const tick = name => h.ev(`(() => { const c = document.querySelector('#premades-root [data-stack="${name}#euw"]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
        await tick('alpha'); await tick('bravo');
        const rows = await h.waitFor(`document.querySelectorAll('#premades-root [data-played]').length === 1`, 20000);
        const idx = await h.ev(`document.querySelector('#premades-root [data-played]').dataset.played`);
        await h.ev(`document.querySelector('#premades-root [data-played] span').click(); 1`);
        const opened = await h.waitFor(`/combo value/.test(document.getElementById('pm-detail').textContent)`, 15000);
        const det = await h.ev(`document.getElementById('pm-detail').textContent.replace(/\\s+/g, ' ')`);
        R.ok('D2-F2: with an ARAM combo first, the played row opens the combo clicked (Ahri, Lee Sin, Jinx), never "undefined"', rows && idx === '1' && opened && /Ahri/.test(det) && /Lee Sin/.test(det) && /Jinx/.test(det) && !/undefined/.test(det), { idx, det: det.slice(0, 300) });
        await h.ev(`document.querySelector('#pm-detail [data-close]').click(); 1`);

        // D2-F20: a "?" popover inside the pair panel: Escape closes the popover only
        await h.ev(`(() => { const r = [...document.querySelectorAll('#premades-root .pm-main [data-pair]')].find(x => /Your pairs/.test(x.closest('.pm-card').textContent)) || document.querySelector('#premades-root .pm-main [data-pair]'); r.querySelector('span').click(); return 1; })()`);
        await h.waitFor(`/pair edge/.test(document.getElementById('pm-detail').textContent) && !!document.querySelector('#pm-detail .dg-help')`, 15000);
        await h.ev(`document.querySelector('#pm-detail .dg-help').click(); 1`);
        const popOpen = await h.waitFor(`document.querySelector('.dg-pop') && document.querySelector('.dg-pop').style.display === 'block'`, 3000);
        await h.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
        const afterEsc = await h.ev(`({ pop: document.querySelector('.dg-pop').style.display, detail: document.getElementById('pm-detail').hidden })`);
        R.ok('D2-F20: Escape on a "?" popover closes it and leaves the details panel open', popOpen && afterEsc.pop === 'none' && afterEsc.detail === false, afterEsc);
        await h.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
        R.ok('a second Escape closes the details panel', await h.ev(`document.getElementById('pm-detail').hidden`));

        // D2-F6: a game saved in Profile (profile:update matches, owner) reloads the list while the view is shown
        played = [...friends, { name: 'Delta', tag: 'EUW', games: 2, w: 2, l: 0, wr: 100 }];
        h.send('profile:update', { kind: 'matches', owner: true, puuid: PUUID, group: 'all', added: 1, ids: ['EUW1_9'] });
        R.ok('D2-F6: Premades reads your games again after profile:update { kind: matches, owner }', await h.waitFor(`/Delta/.test(document.getElementById('pm-side').textContent)`, 10000), await side());

        // D2-F11: Last 3 patches with nothing saved in the archive: your games from all 3 released patches (16.17–16.19) count
        await h.ev(`(() => { const s = document.getElementById('time-period-select'); s.add(new Option('Last 3 patches', 'last3')); s.value = 'last3'; return s.value; })()`);
        const before = playedCalls.length;
        await h.ev(`DDPremades.reload().then(() => 1)`);
        await h.waitFor(`!!document.querySelector('#pm-side .pm-friend')`, 10000);
        const last = playedCalls.slice(before).pop();
        const label = await side();
        R.ok('D2-F11: "Last 3 patches" asks for your games from the 3 newest released patches, labelled 16.17–16.19', !!last && JSON.stringify(last.patches) === JSON.stringify(['16.19', '16.18', '16.17']) && /Last 3 patches \(16\.17–16\.19\)/.test(label), { patches: last && last.patches, label: label.slice(0, 160) });
        await h.ev(`(() => { const s = document.getElementById('time-period-select'); s.value = 'patch'; s.querySelector('option[value="last3"]').remove(); return 1; })()`);

        // ================================================================ Duo
        await h.ev(`DD.showView('draft'); 1`);
        // the tab settles first (partner, history, pairs), so nothing else changes its signature below
        await h.ev(`(() => { window.__realDuo = DD.duoPairs; window.__duoCalls = 0; DD.duoPairs = async (...a) => { window.__duoCalls++; return window.__realDuo(...a); }; document.getElementById('duo-tab-btn').click(); return 1; })()`);
        await h.waitFor(`document.querySelectorAll('#duo-view .duo-table tbody tr').length > 3`, 20000);
        await h.sleep(3000);
        // D2-F14: the dataset can't be read (DD.duoPairs -> null): an error line, not "Ranking pairs…" forever; tried again later
        await h.ev(`(() => { DD.duoPairs = async () => { window.__duoCalls++; return null; }; DDDuo.compute(true); return 1; })()`);
        const errLine = await h.waitFor(`/No draft data for this Time Period and Rank/.test(document.getElementById('duo-view').textContent)`, 10000);
        R.ok('D2-F14: no draft data shows an error line instead of "Ranking pairs…"', errLine && !(await h.ev(`/Ranking pairs/.test(document.getElementById('duo-view').textContent)`)), await h.ev(`document.getElementById('duo-view').textContent.replace(/\\s+/g, ' ').slice(0, 300)`));
        await h.ev(`(() => { DD.duoPairs = async (...a) => { window.__duoCalls++; return window.__realDuo(...a); }; return 1; })()`);
        const t0 = Date.now();
        R.ok('D2-F14: the Duo tab tries again by itself (same draft, same filters) and shows the pairs once the data is there', await h.waitFor(`document.querySelectorAll('#duo-view .duo-table tbody tr').length > 3`, 20000), { afterMs: Date.now() - t0 });

        // A1-F4: a Rank change recomputes the pairs while the tab is open
        let n0 = await h.ev(`window.__duoCalls`);
        await h.ev(`(() => { const s = document.getElementById('rank-select'); s.value = 'emerald_plus'; s.dispatchEvent(new Event('change')); return s.value; })()`);
        R.ok('A1-F4: changing Rank recomputes the Duo pairs', await h.waitFor(`window.__duoCalls > ${n0}`, 10000), { before: n0, after: await h.ev(`window.__duoCalls`) });
        await h.ev(`(() => { const s = document.getElementById('rank-select'); s.value = 'platinum_plus'; s.dispatchEvent(new Event('change')); return 1; })()`);
        await h.sleep(3000);
        // A1-F4: another view and back: the tab still follows the draft (a champion placed recomputes) without clicking the tab
        await h.ev(`DD.showView('profile'); 1`);
        await h.sleep(3500);
        await h.ev(`DD.showView('draft'); 1`);
        await h.sleep(500);
        n0 = await h.ev(`window.__duoCalls`);
        await h.ev(`(async () => { const s = document.querySelector('.role-slot[data-side="right"][data-role="TOP"]'); s.click(); document.querySelector('.champion-tile[data-champion-name="Garen"]').click(); return 1; })()`);
        const followed = await h.waitFor(`window.__duoCalls > ${n0}`, 9000);
        R.ok('A1-F4: back from another view, the Duo tab follows the draft again', followed && (await h.ev(`document.getElementById('duo-view').style.display`)) !== 'none',
            { before: n0, after: await h.ev(`window.__duoCalls`), duo: await h.ev(`document.getElementById('duo-view').style.display`), tab: await h.ev(`DD.draftTab()`) });

        // D2-F21: a Hangul tagline is accepted as a partner
        await h.ev(`(() => { const i = document.querySelector('#duo-view [data-duo="typed"]'); i.value = 'Kimchi#한국'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#duo-view [data-duo="use"]').click(); return 1; })()`);
        const hangul = await h.waitFor(`/Kimchi/.test(document.querySelector('#duo-view [data-duo="partner"]').textContent)`, 8000);
        await h.sleep(500);
        R.ok('D2-F21: "Name#한국" is a Riot ID (no "Use the form Name#TAG"), and your games together are read for it', hangul && !(await h.ev(`/Use the form/.test(document.getElementById('duo-view').textContent)`)) && histCalls.some(a => a.partner.tagLine === '한국'),
            histCalls.slice(-2).map(a => a.partner));

        const ms = await h.ev(`DDScout.parse('Kimchi#한국 joined the lobby\\nAlpha #EUW joined the lobby\\nTokyo#日本語, kimchi#한국')`);
        R.ok('D2-F21: multi-search reads Riot IDs with Hangul / Japanese taglines', JSON.stringify(ms.map(x => x.gameName + '#' + x.tagLine)) === JSON.stringify(['Kimchi#한국', 'Alpha#EUW', 'Tokyo#日本語']), ms);

        // D2-F6: new games saved in Profile reload "players you often play with"
        played = [...friends, { name: 'Echo', tag: 'EUW', games: 3, w: 1, l: 2, wr: 33 }];
        h.send('profile:update', { kind: 'matches', owner: true, puuid: PUUID, group: 'all', added: 1, ids: ['EUW1_10'] });
        R.ok('D2-F6: the Duo partner list is read again after profile:update { kind: matches, owner }', await h.waitFor(`/Echo#EUW/.test(document.querySelector('#duo-view [data-duo="partner"]').textContent)`, 10000),
            await h.ev(`document.querySelector('#duo-view [data-duo="partner"]').textContent`));

        // ================================================================ glossary
        const duoText = await h.ev(`DD.glossary.duo.html`);
        R.ok('D2-F19: the Duo glossary entry names the ally prior, not a jungle prior', !/jungle prior/i.test(duoText) && /ally prior/.test(duoText) && /pair edge/.test(duoText), duoText.slice(0, 300));

        const errs = h.logs.filter(l => /Uncaught|TypeError|ReferenceError/.test(l));
        R.ok('no uncaught errors', errs.length === 0, errs.slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
