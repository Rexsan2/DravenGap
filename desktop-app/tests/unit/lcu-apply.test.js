// Node test (ELECTRON_RUN_AS_NODE) for lcu-apply.js against a stub LCU on 127.0.0.1
const https = require('https'), fs = require('fs'), path = require('path'), assert = require('assert');
const state = {
    pages: [], maxPages: 2, nextId: 10, log: [], inCs: true, spells: null,
    session: { localPlayerCellId: 3, myTeam: [{ cellId: 3, spell1Id: 14, spell2Id: 4 }] },
    sets: { accountId: 77, itemSets: [{ uid: 'mine', title: 'My set' }], timestamp: 1 }
};
const srv = https.createServer({ key: fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'lcu', 'key.pem')), cert: fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'lcu', 'cert.pem')) }, (req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        const j = body ? JSON.parse(body) : null;
        state.log.push(req.method + ' ' + req.url);
        const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
        if (req.headers.authorization !== 'Basic ' + Buffer.from('riot:pw').toString('base64')) return send(401, { message: 'auth' });
        if (req.url === '/lol-perks/v1/pages' && req.method === 'GET') return send(200, state.pages);
        if (req.url === '/lol-perks/v1/pages' && req.method === 'POST') {
            if (state.pages.filter(p => p.isEditable).length >= state.maxPages) return send(400, { message: 'Max pages reached' });
            const p = Object.assign({}, j, { id: state.nextId++, isEditable: true, isDeletable: true });
            state.pages.forEach(x => { x.current = false; });
            state.pages.push(p);
            return send(200, p);
        }
        const m = req.url.match(/^\/lol-perks\/v1\/pages\/(\d+)$/);
        if (m && req.method === 'PUT') { const p = state.pages.find(x => x.id === +m[1]); Object.assign(p, j); return send(201, p); }
        if (req.url === '/lol-perks/v1/currentpage' && req.method === 'PUT') { state.pages.forEach(x => { x.current = x.id === j; }); return send(204); }
        if (req.url === '/lol-champ-select/v1/session') return state.inCs ? send(200, state.session) : send(404, { message: 'No active delegate' });
        if (req.url === '/lol-champ-select/v1/session/my-selection' && req.method === 'PATCH') { state.spells = j; return send(204); }
        if (req.url === '/lol-summoner/v1/current-summoner') return send(200, { summonerId: 555, puuid: 'x' });
        if (req.url === '/lol-item-sets/v1/item-sets/555/sets' && req.method === 'GET') return send(200, state.sets);
        if (req.url === '/lol-item-sets/v1/item-sets/555/sets' && req.method === 'PUT') { state.sets = j; return send(201, j); }
        if (req.url === '/lol-gameflow/v1/gameflow-phase') return send(200, 'ChampSelect');
        send(404, { message: 'nope' });
    });
});

srv.listen(0, '127.0.0.1', async () => {
    const port = srv.address().port;
    const handlers = {};
    const mod = require(path.join(__dirname, '..', '..', 'lcu-apply.js'));
    mod.register({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, getLeagueCredentials: async () => ({ port: String(port), password: 'pw' }), lcuRequest: async () => null });
    const call = (c, a) => handlers[c]({}, a);
    const page = { primaryStyleId: 8100, subStyleId: 8200, selectedPerkIds: [8112, 8139, 8138, 8135, 8226, 8237, 5008, 5008, 5011] };
    try {
        let r = await call('lcu:status');
        assert.strictEqual(r.phase, 'ChampSelect');
        r = await call('lcu:apply-runes', { page: Object.assign({}, page, { selectedPerkIds: [1, 2] }), name: 'x' });
        assert(!r.ok && /9 runes/.test(r.error), JSON.stringify(r));
        r = await call('lcu:apply-runes', { page: Object.assign({}, page, { subStyleId: 8100 }), name: 'x' });
        assert(!r.ok, 'same primary and secondary tree rejected');

        // a free slot: creates DravenGap's page and makes it current
        state.pages = [{ id: 1, name: 'My Ahri', isEditable: true, current: true }, { id: 2, name: 'Preset', isEditable: false, current: false }];
        r = await call('lcu:apply-runes', { page, name: 'Ahri Mid' });
        assert(r.ok && r.action === 'created', JSON.stringify(r));
        const created = state.pages.find(p => p.name.startsWith('DravenGap'));
        assert.deepStrictEqual(created.selectedPerkIds, page.selectedPerkIds);
        assert(created.current && created.name.length <= 25, created.name);

        // second apply: reuses its own page
        const page2 = { primaryStyleId: 8200, subStyleId: 8100, selectedPerkIds: [8214, 8226, 8210, 8237, 8139, 8135, 5005, 5008, 5011] };
        r = await call('lcu:apply-runes', { page: page2, name: 'Ahri Mid' });
        assert(r.ok && r.action === 'updated', JSON.stringify(r));
        assert.strictEqual(state.pages.filter(p => p.name.startsWith('DravenGap')).length, 1, 'reuses its own page');
        assert.deepStrictEqual(state.pages.find(p => p.name.startsWith('DravenGap')).selectedPerkIds, page2.selectedPerkIds);

        // every slot used, no DravenGap page: refuses, deletes nothing; replaces the current page only when asked
        state.pages = [{ id: 1, name: 'A', isEditable: true, current: true }, { id: 3, name: 'B', isEditable: true, current: false }];
        r = await call('lcu:apply-runes', { page, name: 'Ahri Mid' });
        assert(!r.ok && r.code === 'PAGES_FULL', JSON.stringify(r));
        assert.strictEqual(state.pages.length, 2, 'nothing deleted');
        assert.strictEqual(state.pages[0].name, 'A');
        r = await call('lcu:apply-runes', { page, name: 'Ahri Mid', replaceCurrent: true });
        assert(r.ok && r.action === 'updated', JSON.stringify(r));
        assert(state.pages.find(p => p.id === 1).name.startsWith('DravenGap'));
        assert.strictEqual(state.pages.find(p => p.id === 3).name, 'B');

        // spells: Flash stays on F where the player has it
        r = await call('lcu:apply-spells', { spell1Id: 4, spell2Id: 12 });
        assert(r.ok, JSON.stringify(r));
        assert.deepStrictEqual(state.spells, { spell1Id: 12, spell2Id: 4 });
        r = await call('lcu:apply-spells', { spell1Id: 4, spell2Id: 4 });
        assert(!r.ok);
        state.inCs = false;
        r = await call('lcu:apply-spells', { spell1Id: 4, spell2Id: 14 });
        assert(!r.ok && r.code === 'NOT_IN_CHAMP_SELECT', JSON.stringify(r));

        // item set: user's set kept, DravenGap's own set replaced on a second save, junk filtered
        const req = { championKey: 103, map: 11, title: 'Ahri Mid <script>', blocks: [{ type: 'Starters (WPA)', items: [1056, 2003, 'x', -1] }, { type: 'Empty', items: [] }] };
        r = await call('lcu:apply-itemset', req);
        assert(r.ok, JSON.stringify(r));
        r = await call('lcu:apply-itemset', req);
        assert(r.ok);
        assert.strictEqual(state.sets.itemSets.length, 2);
        assert.strictEqual(state.sets.itemSets[1].uid, 'mine');
        const mine = state.sets.itemSets[0];
        assert.deepStrictEqual(mine.blocks, [{ type: 'Starters (WPA)', items: [{ id: '1056', count: 1 }, { id: '2003', count: 1 }] }]);
        assert(!/[<>]/.test(mine.title), mine.title);
        assert.deepStrictEqual(mine.associatedChampions, [103]);
        r = await call('lcu:apply-itemset', Object.assign({}, req, { map: 99 }));
        assert(!r.ok);

        // client down
        const h2 = {};
        mod.register({ ipcMain: { handle: (c, f) => { h2[c] = f; } }, getLeagueCredentials: async () => { throw new Error('no client'); }, lcuRequest: async () => null });
        r = await h2['lcu:apply-runes']({}, { page, name: 'x' });
        assert(!r.ok && r.code === 'NO_CLIENT', JSON.stringify(r));
        console.log('LCU APPLY OK', state.log.length, 'requests');
        srv.close();
        process.exit(0);
    } catch (e) {
        console.log('FAIL', e.message);
        srv.close();
        process.exit(1);
    }
});
