// desktop-app/lcu-apply.js
// "Apply to client": writes a rune page, summoner spells or an item set into the running League client (LCU API).
// Registers 'lcu:*' IPC channels. Uses the shared, cached LCU connection (profile-lcu.js), so no extra process spawns.
//
// Safety: every payload is validated here (numbers only, bounded sizes); rune pages are only ever created or replaced
// when they are DravenGap's own page (name starts with "DravenGap"), or the current page when the user explicitly asks
// (replaceCurrent). Nothing of the user's is deleted. Item sets are merged into the existing list by a fixed uid.
const https = require('https');
const { getSharedLcu } = require('./profile-lcu');

const PAGE_PREFIX = 'DravenGap';
const agent = new https.Agent({ rejectUnauthorized: false }); // the LCU uses a self-signed certificate on 127.0.0.1

function lcuSend(creds, method, path, body) {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const auth = Buffer.from(`riot:${creds.password}`).toString('base64');
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: '127.0.0.1', port: creds.port, path, method, agent,
            headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) }
        }, res => {
            let text = '';
            res.on('data', c => { text += c; });
            res.on('end', () => {
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
                resolve({ status: res.statusCode, json });
            });
        });
        req.setTimeout(8000, () => req.destroy(new Error('League client did not answer')));
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

const isId = v => Number.isInteger(v) && v > 0 && v < 100000;
const ok2xx = r => r.status >= 200 && r.status < 300;
const errOf = (r, what) => ({ ok: false, error: `${what} failed (${r.status}${r.json && r.json.message ? `: ${r.json.message}` : ''})` });

function validPage(p) {
    if (!p || typeof p !== 'object') return 'No rune page.';
    if (!isId(p.primaryStyleId) || !isId(p.subStyleId) || p.primaryStyleId === p.subStyleId) return 'Invalid rune trees.';
    if (!Array.isArray(p.selectedPerkIds) || p.selectedPerkIds.length !== 9 || !p.selectedPerkIds.every(isId)) return 'A rune page needs 9 runes.';
    if (new Set(p.selectedPerkIds.slice(0, 6)).size !== 6) return 'Duplicate runes in the page.';
    return null;
}

function cleanTitle(t, max) { return String(t || '').replace(/[^\w '&.:+()\-]/g, '').slice(0, max).trim(); }

function register({ ipcMain, getLeagueCredentials, lcuRequest }) {
    const lcu = getSharedLcu({ getLeagueCredentials, lcuRequest });

    async function withClient(fn) {
        const creds = await lcu.creds();
        if (!creds) return { ok: false, code: 'NO_CLIENT', error: 'League client not found. Open the client and try again.' };
        try { return await fn(creds); }
        catch (e) { lcu.invalidate(); return { ok: false, code: 'NO_CLIENT', error: `League client not reachable (${e.message}).` }; }
    }

    ipcMain.handle('lcu:status', () => withClient(async creds => {
        const r = await lcuSend(creds, 'GET', '/lol-gameflow/v1/gameflow-phase');
        return { ok: true, phase: typeof r.json === 'string' ? r.json : null };
    }));

    // { page: { primaryStyleId, subStyleId, selectedPerkIds[9] }, name, replaceCurrent? }
    ipcMain.handle('lcu:apply-runes', (event, req) => withClient(async creds => {
        const page = req && req.page;
        const bad = validPage(page);
        if (bad) return { ok: false, error: bad };
        const name = `${PAGE_PREFIX} ${cleanTitle(req.name, 40)}`.slice(0, 25).trim();
        const body = { name, primaryStyleId: page.primaryStyleId, subStyleId: page.subStyleId, selectedPerkIds: page.selectedPerkIds, current: true };
        const pagesR = await lcuSend(creds, 'GET', '/lol-perks/v1/pages');
        if (!ok2xx(pagesR) || !Array.isArray(pagesR.json)) return errOf(pagesR, 'Reading your rune pages');
        const pages = pagesR.json;
        let target = pages.find(p => p.isEditable && typeof p.name === 'string' && p.name.startsWith(PAGE_PREFIX));
        if (!target && req.replaceCurrent) target = pages.find(p => p.current && p.isEditable);
        if (target) {
            const put = await lcuSend(creds, 'PUT', `/lol-perks/v1/pages/${target.id}`, { ...body, id: target.id });
            if (!ok2xx(put)) return errOf(put, 'Updating the rune page');
            await lcuSend(creds, 'PUT', '/lol-perks/v1/currentpage', target.id).catch(() => null);
            return { ok: true, action: 'updated', name };
        }
        const post = await lcuSend(creds, 'POST', '/lol-perks/v1/pages', body);
        if (ok2xx(post)) return { ok: true, action: 'created', name };
        // usually: every rune page slot is in use
        const editable = pages.filter(p => p.isEditable);
        return { ok: false, code: 'PAGES_FULL', error: `No free rune page (${editable.length} in use). Use "Replace current page", or rename one of your pages to start with "${PAGE_PREFIX}" so it gets reused.`, detail: post.json && post.json.message };
    }));

    // { spell1Id, spell2Id }: champion select only. Flash keeps the side (D/F) it is on now.
    ipcMain.handle('lcu:apply-spells', (event, req) => withClient(async creds => {
        let a = req && req.spell1Id, b = req && req.spell2Id;
        if (!isId(a) || !isId(b) || a === b) return { ok: false, error: 'Invalid summoner spells.' };
        const sess = await lcuSend(creds, 'GET', '/lol-champ-select/v1/session');
        if (!ok2xx(sess) || !sess.json) return { ok: false, code: 'NOT_IN_CHAMP_SELECT', error: 'Summoner spells can only be set during champion select.' };
        const me = (sess.json.myTeam || []).find(p => p.cellId === sess.json.localPlayerCellId);
        const FLASH = 4;
        if (me && (a === FLASH || b === FLASH)) {
            const other = a === FLASH ? b : a;
            if (me.spell2Id === FLASH) { a = other; b = FLASH; } else if (me.spell1Id === FLASH) { a = FLASH; b = other; }
        }
        const r = await lcuSend(creds, 'PATCH', '/lol-champ-select/v1/session/my-selection', { spell1Id: a, spell2Id: b });
        return ok2xx(r) ? { ok: true, spell1Id: a, spell2Id: b } : errOf(r, 'Setting summoner spells');
    }));

    // { championKey, map: 11 | 12, title, blocks: [{ type, items: [id...] }] }: saved as DravenGap's set for that champion and map
    ipcMain.handle('lcu:apply-itemset', (event, req) => withClient(async creds => {
        const champ = req && Number(req.championKey), map = req && Number(req.map);
        if (!isId(champ) || ![11, 12].includes(map)) return { ok: false, error: 'Invalid champion or map.' };
        const blocks = (Array.isArray(req.blocks) ? req.blocks : []).slice(0, 12).map(b => ({
            type: cleanTitle(b && b.type, 60) || 'Items',
            items: (Array.isArray(b && b.items) ? b.items : []).filter(isId).slice(0, 20).map(id => ({ id: String(id), count: 1 }))
        })).filter(b => b.items.length);
        if (!blocks.length) return { ok: false, error: 'No items to save.' };
        const me = await lcuSend(creds, 'GET', '/lol-summoner/v1/current-summoner');
        if (!ok2xx(me) || !me.json || !me.json.summonerId) return errOf(me, 'Reading your account');
        const path = `/lol-item-sets/v1/item-sets/${me.json.summonerId}/sets`;
        const cur = await lcuSend(creds, 'GET', path);
        if (!ok2xx(cur) || !cur.json) return errOf(cur, 'Reading your item sets');
        const uid = `dravengap-${champ}-${map}`;
        const set = {
            uid, title: `${PAGE_PREFIX} ${cleanTitle(req.title, 60)}`.slice(0, 75), type: 'custom', map: 'any', mode: 'any',
            associatedChampions: [champ], associatedMaps: [map], blocks, preferredItemSlots: [], sortrank: 0, startedFrom: 'blank'
        };
        const itemSets = (cur.json.itemSets || []).filter(s => s && s.uid !== uid);
        itemSets.unshift(set);
        const put = await lcuSend(creds, 'PUT', path, { ...cur.json, itemSets, timestamp: Date.now() });
        return ok2xx(put) ? { ok: true, title: set.title, blocks: blocks.length } : errOf(put, 'Saving the item set');
    }));
}

module.exports = { register, _internals: { validPage, cleanTitle, lcuSend } };
