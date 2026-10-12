// ARAM Mayhem champion select (aram-main.js): your champion before the bench opens, and the names-removed snapshot.
//  - normaliseChampSelect: mine = myTeam championId, else /lol-champ-select/v1/current-champion, else championPickIntent
//  - aram:champ-select / aram:champ-snapshot through register() against a stub client (no network, no real LCU)
//  - redactSnapshot: summoner names, Riot IDs, puuids and chat tokens never reach the clipboard text
const assert = require('assert');
const { APP, scratch } = require('../lib/common');
const am = require(APP + 'aram-main');
const { normaliseChampSelect, redactSnapshot } = am._internals;

const PUUID = 'p'.padEnd(78, 'q'), PUUID2 = 'r'.padEnd(78, 's');
const flow = queueId => ({ gameData: { queue: { id: queueId, gameMode: queueId === 2400 ? 'KIWI' : 'CLASSIC', name: queueId === 2400 ? 'ARAM: Mayhem' : 'Ranked' }, playerChampionSelections: [{ puuid: PUUID, championId: 0 }] } });
const mkSession = (mine, extra = {}) => ({
    localPlayerCellId: 3, benchEnabled: true, benchChampions: [], rerollsRemaining: 2,
    myTeam: [
        Object.assign({ cellId: 3, championId: 0, championPickIntent: 0, assignedPosition: '', team: 1, spell1Id: 4, spell2Id: 6, puuid: PUUID, summonerId: 1234567, summonerName: 'SecretName', gameName: 'SecretName', tagLine: 'EUW', obfuscatedPuuid: 'abcdef', nameVisibilityType: 'VISIBLE' }, mine),
        { cellId: 4, championId: 54, championPickIntent: 0, team: 1, puuid: PUUID2, summonerId: 7654321, gameName: 'MateName', tagLine: 'NA1', summonerName: 'MateName' }
    ],
    theirTeam: [], timer: { phase: 'BAN_PICK', adjustedTimeLeftInPhase: 20000 }, actions: [[]], bans: { myTeamBans: [], theirTeamBans: [] },
    chatDetails: { chatRoomName: 'c1~0123456789abcdef@sec.pvp.net', chatRoomPassword: 'hunter2-secret' }, note: 'invited by Secret Name#EUW1 earlier', ...extra
});

(async () => {
    // ---- your champion: championId, then current-champion, then championPickIntent
    let asked = 0;
    const cur = v => async () => { asked++; return v; };
    let r = await normaliseChampSelect(mkSession({ championId: 0 }), flow(2400), async () => null, cur(17));
    assert.strictEqual(r.mine, 17, 'championId 0 + current-champion 17 -> 17');
    assert.strictEqual(r.mineSource, 'current-champion');
    assert.deepStrictEqual(r.bench, [], 'empty bench stays empty');
    assert(r.isMayhem && r.inChampSelect && r.rerolls === 2, JSON.stringify(r));

    asked = 0;
    r = await normaliseChampSelect(mkSession({ championId: 99, championPickIntent: 5 }), flow(2400), async () => null, cur(17));
    assert.strictEqual(r.mine, 99); assert.strictEqual(r.mineSource, 'championId'); assert.strictEqual(asked, 0, 'the endpoint is not asked when myTeam already has the champion');

    r = await normaliseChampSelect(mkSession({ championId: 0, championPickIntent: 22 }), flow(2400), async () => null, cur(null));
    assert.strictEqual(r.mine, 22); assert.strictEqual(r.mineSource, 'pick-intent', 'no current-champion -> pick intent');
    r = await normaliseChampSelect(mkSession({ championId: 0, championPickIntent: 22 }), flow(2400), async () => null, async () => { throw new Error('404'); });
    assert.strictEqual(r.mine, 22, 'a failing endpoint falls through to the pick intent');
    r = await normaliseChampSelect(mkSession({ championId: 0, championPickIntent: 22 }), flow(2400), async () => null, cur(17));
    assert.strictEqual(r.mine, 17, 'current-champion comes before the pick intent');
    for (const v of ['17', { championId: 17 }]) { r = await normaliseChampSelect(mkSession({}), flow(2400), async () => null, cur(v)); assert.strictEqual(r.mine, 17, JSON.stringify(v)); }
    r = await normaliseChampSelect(mkSession({}), flow(2400), async () => null, cur(0));
    assert.strictEqual(r.mine, 0); assert.strictEqual(r.mineSource, null, 'nothing known yet');
    r = await normaliseChampSelect(mkSession({}), flow(2400), async () => null);   // old callers without the 4th argument
    assert.strictEqual(r.mine, 0);
    assert.deepStrictEqual(r.team, [{ cellId: 4, championId: 54 }], 'teammates as before');
    console.log('mine resolution ok');

    // ---- through register() against a stub client
    let table = {}; const handlers = {}; let copied = null;
    const deps = { ipcMain: { handle: (c, f) => { handlers[c] = f; } }, userDataPath: scratch('aram-cs'), sendToWindow: () => {},
        getLeagueCredentials: async () => ({ port: 1, password: 'x' }), lcuRequest: async p => (p in table ? JSON.parse(JSON.stringify(table[p])) : null), clipboardWrite: t => { copied = t; return true; } };
    am.register(deps);
    table = {
        '/lol-gameflow/v1/gameflow-phase': 'ChampSelect', '/lol-champ-select/v1/session': mkSession({ championId: 0 }), '/lol-gameflow/v1/session': flow(2400),
        '/lol-champ-select/v1/current-champion': 17, '/lol-summoner/v1/current-summoner/rerollPoints': { numberOfRolls: 2 }
    };
    let res = await handlers['aram:champ-select']();
    assert(res.ok && res.data.inChampSelect && res.data.isMayhem && res.data.mine === 17 && res.data.mineSource === 'current-champion' && res.data.bench.length === 0, JSON.stringify(res));
    table['/lol-champ-select/v1/current-champion'] = null;   // 404 from the client
    res = await handlers['aram:champ-select']();
    assert.strictEqual(res.data.mine, 0, 'champion unknown everywhere -> 0');
    table['/lol-champ-select/v1/session'] = mkSession({ championId: 0, championPickIntent: 31 });
    res = await handlers['aram:champ-select']();
    assert.strictEqual(res.data.mine, 31); assert.strictEqual(res.data.mineSource, 'pick-intent');
    console.log('aram:champ-select ok');

    // ---- snapshot: copied text has no names, puuids, chat tokens
    table['/lol-champ-select/v1/current-champion'] = 17;
    table['/lol-champ-select/v1/session'] = mkSession({ championId: 0 });
    res = await handlers['aram:champ-snapshot']();
    assert(res.ok && res.copied === true && res.text === copied && res.lines > 20, JSON.stringify(res).slice(0, 300));
    for (const secret of ['SecretName', 'MateName', PUUID, PUUID2, 'abcdef', 'hunter2', 'sec.pvp.net', '1234567', '7654321', 'Secret Name#EUW1']) assert(!res.text.includes(secret), 'leaked: ' + secret);
    const snap = JSON.parse(res.text);
    assert.strictEqual(snap.currentChampion, 17); assert.strictEqual(snap.readAs.mine, 17); assert.strictEqual(snap.readAs.mineSource, 'current-champion');
    assert.strictEqual(snap.session.myTeam[0].championId, 0, 'the raw fields stay so the owner can read them');
    assert.strictEqual(snap.session.myTeam[0].championPickIntent, 0); assert.strictEqual(snap.session.myTeam[1].championId, 54);
    assert.strictEqual(snap.session.localPlayerCellId, 3); assert.strictEqual(snap.session.rerollsRemaining, 2); assert.deepStrictEqual(snap.session.benchChampions, []);
    assert.strictEqual(snap.session.myTeam[0].summonerName, '[removed]'); assert.strictEqual(snap.session.chatDetails, '[removed]');
    assert.deepStrictEqual(snap.queue, { id: 2400, gameMode: 'KIWI', name: 'ARAM: Mayhem' });
    assert(snap.removedFields >= 10, 'counts what it removed: ' + snap.removedFields);
    console.log('aram:champ-snapshot ok', res.lines, 'lines');

    // not in champion select / client down
    table['/lol-gameflow/v1/gameflow-phase'] = 'Lobby';
    res = await handlers['aram:champ-snapshot']();
    assert(!res.ok && /Not in champion select \(Lobby\)/.test(res.error), JSON.stringify(res));
    const down = {}; am.register({ ...deps, ipcMain: { handle: (c, f) => { down[c] = f; } }, getLeagueCredentials: async () => { throw new Error('no client'); } });
    res = await down['aram:champ-snapshot']();
    assert(!res.ok && /client/i.test(res.error), JSON.stringify(res));
    console.log('snapshot outside champion select ok');

    // ---- redactSnapshot on its own
    const red = redactSnapshot({ a: { gameName: 'X', tagLine: 'EUW', puuid: PUUID, summonerId: 5, keep: 1, list: [{ summonerName: 'Y', championId: 9 }], empty: { puuid: '' } },
        token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl', long: PUUID2, text: 'Friend#EUW1 and Another One#NA1 queued', ok: 'ARAM: Mayhem champion select' });
    const out = JSON.stringify(red.value);
    assert(!/eyJ|Friend|Another|"X"|"Y"|EUW"|rsrs/.test(out), out);
    assert.strictEqual(red.value.a.keep, 1); assert.strictEqual(red.value.a.list[0].championId, 9); assert.strictEqual(red.value.a.empty.puuid, ''); assert.strictEqual(red.value.ok, 'ARAM: Mayhem champion select');
    assert(red.removed >= 7, String(red.removed));
    console.log('redaction ok');
    console.log('ALL OK'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
