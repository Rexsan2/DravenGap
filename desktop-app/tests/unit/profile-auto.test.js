// profile-main phase poller: live push on InProgress, owner history sync after EndOfGame, LCU credential back-off when the client closes.
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const { APP, scratch, sleep } = require('../lib/common');
const { start } = require('../lib/riot-stub');

(async () => {
    const S = await start(); const dir = scratch('pa');
    fs.writeFileSync(path.join(dir, 'personal-history.json'), JSON.stringify({ 'lcu-puuid': [] }));
    const handlers = {}; const pushes = []; let phase = 'None'; let credCalls = 0; let up = true;
    S.state.total = 10;
    require(APP + 'profile-main').register({ ipcMain: { handle: (c, f) => handlers[c] = f }, userDataPath: dir, getRiotApiKey: () => 'ok',
        getLeagueCredentials: async () => { credCalls++; if (!up) throw new Error('down'); return { port: 1 }; },
        lcuRequest: async (p) => { if (!up) throw new Error('ECONNREFUSED'); if (p.includes('gameflow-phase')) return phase; if (p.includes('current-summoner')) return { gameName: 'TestOwner', tagLine: 'META', puuid: 'lcu-puuid', summonerLevel: 5, profileIconId: 1 }; if (p.includes('region')) return { region: 'EUW' }; return null; },
        sendToWindow: (c, p) => pushes.push([c, p]), riotBaseUrl: () => 'http://127.0.0.1:' + S.port, pollMs: 100, pollStartDelay: 50, autoRefreshDelays: [200, 400] });
    await sleep(300);
    const r = await handlers['profile:lookup']({}, { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' });
    await handlers['profile:matches']({}, { puuid: r.profile.puuid, platform: 'EUW1', group: 'all' });
    pushes.length = 0;
    phase = 'InProgress'; await sleep(400);
    assert(pushes.some(p => p[0] === 'profile:live' && p[1].active), 'live push'); console.log('live push on InProgress ok');
    S.state.newer = true;                       // a new game appears on the server
    phase = 'EndOfGame'; await sleep(100); phase = 'None';
    await sleep(1500);
    assert(pushes.some(p => p[0] === 'profile:live' && p[1].active === false), 'inactive push');
    assert(pushes.some(p => p[1].owner && p[1].added === 1), 'owner update');
    const ph = JSON.parse(fs.readFileSync(path.join(dir, 'personal-history.json')));
    assert(Object.keys(ph).length >= 1, 'personal history written'); console.log('owner history sync ok');
    up = false; credCalls = 0; await sleep(1200);
    assert(credCalls <= 2, 'cred lookups while client down: ' + credCalls); console.log('LCU back-off ok (' + credCalls + ' lookups in 1.2 s)');
    console.log('ALL OK'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
