// Duo tab (C6): partner from the lobby, lanes from champion select, pairs ranked by DD.duoPairs (each Exp WR equals the
// recommendations' number), your games together from Profile, and picking another partner / lane.
// Typing a partner: the Riot ID box keeps its text, cursor and focus through re-renders and the 2.5 s poll; a typed partner is applied on
// Enter / Use / blur only; with no games together the partner's pool comes from profile:multi (mastery + recent games); an empty
// intersection shows every pair with a note; the account comes from profile:owner first, else profile:me + lookup.
const H = require('../lib/renderer-harness');
const R = H.results();

const session = { localPlayerCellId: 0, actions: [[]], theirTeam: [{ cellId: 5, championId: 0, championPickIntent: 0 }],
    myTeam: [{ cellId: 0, championId: 0, championPickIntent: 0, assignedPosition: 'middle' }, { cellId: 1, championId: 0, championPickIntent: 0, assignedPosition: 'jungle' }] };
const hist = { ok: true, puuid: 'P'.padEnd(78, 'x'), scanned: 300, games: 23, w: 14, lanes: [{ myPos: 'MIDDLE', theirPos: 'JUNGLE', games: 20, w: 13 }],
    pairs: [{ mine: 103, theirs: 64, games: 6, w: 5, myPos: 'MIDDLE', theirPos: 'JUNGLE' }], partnerChamps: { JUNGLE: { 64: 10, 32: 5 } } };

(async () => {
    try {
        const histCalls = [], multiCalls = [], playedCalls = [], lookupCalls = [];
        const OWNER_PUUID = 'N'.padEnd(78, 'n');
        // profile:owner answers with another account than profile:me, so it is visible which one the tab used
        let ownerAnswer = () => ({ ok: true, owner: { gameName: 'OwnerViaNew', tagLine: 'NEW', platform: 'NA1', puuid: OWNER_PUUID }, source: 'client' });
        let ownerCalls = 0;
        const multiBy = {};   // profile:multi answers per partner name (filled by the scenarios below)
        const h = await H.boot({ ipc: {
            'get-champ-select': () => session,
            'profile:owner': () => { ownerCalls++; return ownerAnswer(); },
            'profile:multi': (e, a) => { multiCalls.push(a); return multiBy[a.gameName] ? multiBy[a.gameName]() : { ok: true, profile: { gameName: a.gameName, mastery: [] }, form: { games: 0, results: [] } }; },
            'profile:me': () => ({ ok: true, me: { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' }, lcu: true, phase: 'ChampSelect' }),
            'profile:duo': () => ({ ok: true, lcu: true, inLobby: true, partners: [{ gameName: 'Alpha', tagLine: 'EUW', positions: ['JUNGLE'], assigned: 'JUNGLE', championId: 0 }], me: { positions: ['MIDDLE'], assigned: 'MIDDLE' } }),
            'profile:lookup': (e, a) => { lookupCalls.push(a); return { ok: true, profile: { puuid: 'P'.padEnd(78, 'x'), gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1', ranked: [], mastery: [] } }; },
            'profile:played': (e, a) => { playedCalls.push(a); return { ok: true, list: [{ name: 'Bravo', tag: 'EUW', puuid: 'b', games: 9, w: 5, l: 4, wr: 56 }] }; },
            'profile:duo-history': (e, a) => { histCalls.push(a); return a.partner.gameName === 'Alpha' ? hist : { ok: true, scanned: 300, games: 0, w: 0, pairs: [], lanes: [], partnerChamps: {} }; }
        } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        await h.sleep(1500);
        await h.ev(`document.getElementById('duo-tab-btn').click(); 1`);
        const ok = await h.waitFor(`document.querySelectorAll('#duo-view .duo-table tbody tr').length > 3`, 15000);
        const v = await h.ev(`(() => { const sel = k => document.querySelector('#duo-view [data-duo="' + k + '"]'); const p = sel('partner');
            return { partner: p.options[p.selectedIndex].text, roleA: sel('roleA').value, roleB: sel('roleB').value, text: document.getElementById('duo-view').textContent.replace(/\\s+/g, ' '),
                rows: [...document.querySelectorAll('#duo-view .duo-table tbody tr')].length, recVisible: document.getElementById('recommendations-view').style.display }; })()`);
        R.ok('Duo tab: partner from the lobby, your lane from champion select, partner\'s assigned lane', ok && /Alpha#EUW · in your lobby/.test(v.partner) && v.roleA === 'MIDDLE' && v.roleB === 'JUNGLE' && v.recVisible === 'none', v);
        R.ok('your games together from Profile', /Together: 23 games, 61% \(14W 9L\)/.test(v.text) && /Mid \+ Jungle 20 \(65%\)/.test(v.text), v.text.slice(0, 400));
        R.ok('history asked for the owner + partner', histCalls.length >= 1 && histCalls[0].partner.gameName === 'Alpha' && (histCalls[0].owner.puuid || histCalls[0].owner.gameName === 'TestOwner'), histCalls[0]);
        // model checks
        const d = await h.ev(`DD.duoPairs({ roleA: 'MIDDLE', roleB: 'JUNGLE' })`);
        const formula = d.pairs.every(p => Math.abs(p.edge - ((p.expA - 0.5) + (p.expB - 0.5) + p.syn)) < 1e-12) && d.pairs.every((p, i) => i === 0 || p.edge <= d.pairs[i - 1].edge);
        R.ok('pair edge = both Exp WRs over 50% + synergy, best first', formula && d.pairs.length === 15, d.pairs.slice(0, 2));
        const top = d.pairs[0];
        await h.ev(`document.getElementById('rec-tab-btn').click(); document.querySelector("[data-side='left'][data-role='MIDDLE'] .suggest-btn").click(); 1`);
        await h.waitFor(`!!document.querySelector('#recommendation-list li[data-champion-name="${top.a}"]')`, 10000);
        const recExp = await h.ev(`JSON.parse(document.querySelector('#recommendation-list li[data-champion-name="${top.a}"]').dataset.expwr).wr`);
        R.ok('each Exp WR is the recommendations\' number for that lane', Math.abs(recExp - top.expA) < 1e-12, { rec: recExp, duo: top.expA });
        // pick a played-with partner instead: history for Bravo, which has none
        await h.ev(`document.getElementById('duo-tab-btn').click(); 1`);
        await h.waitFor(`!!document.querySelector('#duo-view [data-duo="partner"]')`, 5000);
        await h.ev(`(() => { const p = document.querySelector('#duo-view [data-duo="partner"]'); const i = [...p.options].findIndex(o => /Bravo/.test(o.text)); p.value = String(i - 1); p.dispatchEvent(new Event('change', { bubbles: true })); return i; })()`);
        await h.waitFor(`/No games with Bravo/.test(document.getElementById('duo-view').textContent)`, 8000);
        R.ok('choosing a played-with partner reads that history', histCalls.some(a => a.partner.gameName === 'Bravo'));
        // change your lane to Bot: the partner becomes Support automatically
        await h.ev(`(() => { const s = document.querySelector('#duo-view [data-duo="roleA"]'); s.value = 'BOTTOM'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
        await h.sleep(300);
        R.ok('lanes never collide (Bot + Jungle stays valid)', (await h.ev(`document.querySelector('#duo-view [data-duo="roleA"]').value + '|' + document.querySelector('#duo-view [data-duo="roleB"]').value`)) === 'BOTTOM|JUNGLE');
        await h.ev(`(() => { const s = document.querySelector('#duo-view [data-duo="roleB"]'); s.value = 'BOTTOM'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
        await h.sleep(300);
        R.ok('choosing the same lane moves the other one', (await h.ev(`document.querySelector('#duo-view [data-duo="roleA"]').value + '|' + document.querySelector('#duo-view [data-duo="roleB"]').value`)) === 'SUPPORT|BOTTOM');
        R.ok('D shortcut opens the tab', await h.ev(`(async () => { document.getElementById('rec-tab-btn').click(); document.activeElement && document.activeElement.blur(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', bubbles: true })); await new Promise(r => setTimeout(r, 100)); return document.getElementById('duo-view').style.display === 'flex'; })()`));
        // ---- profile:owner is asked first (it answers with another account than profile:me, which is only the fallback)
        R.ok('the account comes from profile:owner first (puuid reused, no lookup)', ownerCalls >= 1 && histCalls[0].owner.puuid === OWNER_PUUID && playedCalls.length >= 1 && playedCalls[0].puuid === OWNER_PUUID && playedCalls[0].platform === 'NA1' && lookupCalls.length === 0,
            { ownerCalls, owner: histCalls[0].owner, played: playedCalls[0], lookups: lookupCalls.length });

        // helpers: real functions run in the page
        const page = (fn, arg) => h.ev(`(${fn})(${JSON.stringify(arg === undefined ? null : arg)})`);
        const pageText = () => page(() => document.getElementById('duo-view').textContent.replace(/\s+/g, ' '));
        const cells = () => page(() => [...document.querySelectorAll('#duo-view .duo-table tbody tr')].map(tr => [tr.children[1].textContent.trim(), tr.children[2].textContent.trim()]));
        const setRole = (k, v) => page(([k2, v2]) => { const s = document.querySelector('#duo-view [data-duo="' + k2 + '"]'); s.value = v2; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; }, [k, v]);
        const typeInto = (value, sel) => page(([v, s]) => { const i = document.querySelector('#duo-view [data-duo="typed"]'); i.value = v; if (s != null) i.setSelectionRange(s, s); i.dispatchEvent(new Event('input', { bubbles: true })); return 1; }, [value, sel == null ? null : sel]);
        const clickUse = () => page(() => { document.querySelector('#duo-view [data-duo="use"]').click(); return 1; });

        // back to Mid + Jungle for the pool scenarios
        await setRole('roleB', 'JUNGLE'); await setRole('roleA', 'MIDDLE');
        R.ok('My pool and Partner\'s champions are on by default', await page(() => document.querySelector('#duo-view [data-duo="poolA"]').checked && document.querySelector('#duo-view [data-duo="poolB"]').checked));
        // the jungle champions the model lists (ids, Data Dragon keys, names), best first
        const base = await page(async () => {
            const d = await DD.duoPairs({ roleA: 'MIDDLE', roleB: 'JUNGLE', perSide: 12, limit: 500 });
            const key = id => Number(DD.getChampions().find(c => c.id === id).key);
            const ids = [...new Set(d.pairs.map(p => p.b))];
            return { ids, keys: ids.map(key), names: ids.map(id => d.pairs.find(p => p.b === id).bName), mid: [...new Set(d.pairs.map(p => p.a))] };
        });
        R.ok('the model lists enough jungle champions to build a pool test', base.ids.length >= 5, base.ids);

        // ---- typing a partner: the cursor stays in the middle after a letter is deleted and the view re-renders
        await h.waitFor(`!!document.querySelector('#duo-view [data-duo="typed"]')`, 3000);
        await page(() => { const i = document.querySelector('#duo-view [data-duo="typed"]'); window.__duoInput = i; i.focus(); return 1; });
        await typeInto('Zulu#EUW', 2);       // cursor after "Zu"
        await typeInto('Zlu#EUW', 1);        // Backspace there: one letter gone, cursor after "Z"
        // re-renders: a forced compute (which repaints) and the 2.5 s timer with its signature cleared
        await page(() => { DDDuo.compute(true); DDDuo.state.sig = ''; return 1; });
        await h.sleep(3200);
        const cur = await page(() => { const i = document.querySelector('#duo-view [data-duo="typed"]'); return { same: i === window.__duoInput, value: i.value, s: i.selectionStart, e: i.selectionEnd, focused: document.activeElement === i, partner: DDDuo.state.partner.gameName }; });
        R.ok('Riot ID box: same element, text, cursor (in the middle) and focus survive re-renders and the poll', cur.same && cur.value === 'Zlu#EUW' && cur.s === 1 && cur.e === 1 && cur.focused, cur);
        R.ok('typing alone does not change the partner or look anyone up', cur.partner === 'Bravo' && !histCalls.some(a => a.partner.gameName === 'Zlu') && multiCalls.every(a => a.gameName !== 'Zlu' && a.gameName !== 'Zulu'), { partner: cur.partner, multi: multiCalls.length });
        await typeInto('Zulu#EUW', 2);       // type the missing letter back at the cursor
        R.ok('the next keystroke lands where the cursor was', await page(() => window.__duoInput.value === 'Zulu#EUW' && window.__duoInput.selectionStart === 2));

        // ---- Enter applies it; no games together -> the partner's pool comes from profile:multi (mastery + last games)
        const [mastIn, gamesIn, mastLow, gamesLow] = base.keys;
        const form = [];
        for (let n = 0; n < 3; n++) form.push({ win: true, champId: gamesIn, k: 1, d: 1, a: 1 });       // 3 of 5 games: in the pool
        for (let n = 0; n < 2; n++) form.push({ win: false, champId: gamesLow, k: 1, d: 1, a: 1 });     // 2 of 5 games: not
        multiBy.Zulu = () => ({ ok: true, profile: { gameName: 'Zulu', mastery: [{ championId: mastIn, championPoints: 50000 }, { championId: mastLow, championPoints: 5000 }] }, form: { games: 5, results: form } });
        await page(() => { window.__duoInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; });
        const poolOk = await h.waitFor(`/Partner's champions: from their mastery and last 5 games \\(no games together yet\\), 2 champions/.test(document.getElementById('duo-view').textContent)`, 15000);
        await h.sleep(600);
        const rows = await cells();
        const want = [base.names[0], base.names[1]].sort();
        R.ok('Enter applies the typed partner and looks them up with profile:multi on your region', multiCalls.filter(a => a.gameName === 'Zulu').length === 1 && multiCalls.some(a => a.gameName === 'Zulu' && a.tagLine === 'EUW' && a.platform === 'NA1') && histCalls.some(a => a.partner.gameName === 'Zulu'), multiCalls);
        R.ok('partner pool = 3+ recent games or 20,000+ mastery; the 5,000-mastery and 2-game champions are left out', poolOk && rows.length > 0 && [...new Set(rows.map(r => r[1]))].sort().join() === want.join(), { rows: rows.slice(0, 6), want });
        R.ok('the typed text is still in the box after applying', await page(() => window.__duoInput === document.querySelector('#duo-view [data-duo="typed"]') && window.__duoInput.value === 'Zulu#EUW'));

        // ---- a bad Riot ID is refused by the Use button and the partner stays
        await typeInto('nonsense');
        await clickUse();
        R.ok('Use with something that is not Name#TAG says so and keeps the partner', await h.waitFor(`/Use the form Name#TAG/.test(document.getElementById('duo-view').textContent)`, 3000) && await page(() => DDDuo.state.partner.gameName === 'Zulu'));

        // ---- the pools leave nothing: every pair is shown, with a note.
        // The enemy picks Teemo: a champion taken on the board is not recommended, so a pool holding only Teemo has nobody for any lane.
        const lonely = await page(() => Number(DD.getChampions().find(c => c.id === 'Teemo').key));
        session.theirTeam[0].championId = lonely;
        R.ok('the enemy Teemo shows up on the board (live tracking)', await h.waitFor("[...document.querySelectorAll('.role-slot')].some(s => s.dataset.champion === 'Teemo')", 10000));
        multiBy.Yankee = () => ({ ok: true, profile: { gameName: 'Yankee', mastery: [{ championId: lonely, championPoints: 90000 }] }, form: { games: 0, results: [] } });
        await typeInto('Yankee#EUW');
        await clickUse();
        const emptyOk = await h.waitFor(`/No pair in both pools/.test(document.getElementById('duo-view').textContent)`, 15000);
        await h.sleep(300);
        R.ok('no pair in both pools -> clear note and all pairs shown', emptyOk && /nobody in your partner's pool has Jungle data/.test(await pageText()) && (await cells()).length > 3, (await pageText()).slice(300, 900));

        // ---- a failed lookup (no Riot key) is explained and the list falls back to everyone; leaving the box applies the ID
        multiBy.Failer = () => ({ ok: false, code: 'NO_KEY', error: 'No Riot API key saved.' });
        await typeInto('Failer#EUW');
        await page(() => { window.__duoInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); return 1; });
        R.ok('leaving the box applies it; a missing key is explained and everyone is listed', await h.waitFor(`/Needs a valid Riot API key/.test(document.getElementById('duo-view').textContent)`, 10000) && (await cells()).length > 3 && multiCalls.some(a => a.gameName === 'Failer'));

        // ---- with games together the lobby partner's pool comes from those games (no profile:multi)
        const before = multiCalls.length;
        await page(() => { const p = document.querySelector('#duo-view [data-duo="partner"]'); const i = [...p.options].findIndex(o => /Alpha/.test(o.text)); p.value = String(i - 1); p.dispatchEvent(new Event('change', { bubbles: true })); return i; });
        R.ok('Alpha: pool from the 23 games together, no extra lookup', await h.waitFor(`/Alpha played as Jungle in your 23 games together/.test(document.getElementById('duo-view').textContent)`, 8000) && multiCalls.length === before);
        R.ok('choosing from the list clears the typed box', await page(() => document.querySelector('#duo-view [data-duo="typed"]').value === ''));

        // ---- My pool: DD.myPool() limits the You column; a pool with nobody for the lane leaves the note
        await page(([pool]) => { window.__origMyPool = DD.myPool; DD.myPool = () => pool; DDDuo.compute(true); return 1; }, [base.mid.slice(0, 2)]);
        await h.sleep(1500);
        const mine = [...new Set((await cells()).map(r => r[0]))];
        R.ok('My pool limits the You column to the pool champions', mine.length > 0 && mine.length <= 2 && /Your pool: 2 champions/.test(await pageText()), mine);
        await page(() => { DD.myPool = () => ['Teemo']; DDDuo.compute(true); return 1; });
        await h.sleep(1500);
        R.ok('a pool with nobody for your lane: all pairs shown and the note says why', /No pair in both pools/.test(await pageText()) && /nobody in your pool has Mid data/.test(await pageText()) && (await cells()).length > 3, (await pageText()).slice(300, 900));
        await page(() => { DD.myPool = window.__origMyPool; DDDuo.compute(true); return 1; });

        // ---- fallback: profile:owner failing -> profile:me (+ lookup for the puuid)
        ownerAnswer = () => ({ ok: false });
        await page(() => { const s = DDDuo.state; s.owner = null; s.ownerPuuid = null; s.played = []; s.playedTried = false; s.histKey = ''; s.hist = null; return 1; });
        await page(() => { DDDuo.show(); return 1; });
        R.ok('profile:owner answering ok:false falls back to profile:me + lookup', await h.waitFor(`DDDuo.state.owner && DDDuo.state.owner.gameName === 'TestOwner' && DDDuo.state.ownerPuuid === 'P'.padEnd(78, 'x')`, 8000) && lookupCalls.length >= 1, { owner: await page(() => DDDuo.state.owner), lookups: lookupCalls.length });

        R.ok('no uncaught errors',!h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
