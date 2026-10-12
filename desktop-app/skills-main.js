// desktop-app/skills-main.js
// Skill order for Summoner's Rift builds. Registers one IPC channel:
//   build:skills  {champion, role, force?} -> { ok, data: { lane, queue, games, priority:{pick,win}, order:{pick,win}, url }, fetchedAt, stale }
//                                            | { ok:false, code, error }
// Source: LoLalytics' build page of that champion and lane, Emerald+ (the same bracket as the Coachless builds), read from the
// page state (aram-parsers.js parseLolalyticsSkills). Coachless has a skill-order endpoint, but it refuses requests (HTTP 403).
// Etiquette is aram-main's: fetched only when a champion's Builds or game plan asks, at most 2 requests per host, a failed URL is
// not retried for 60 s, and a disk cache (userData/skills-cache, 6 h; stale entries are served and refreshed in the background).
const path = require('path');
const A = require('./aram-main')._internals;
const parsers = require('./aram-parsers');

const LANES = { TOP: 'top', JUNGLE: 'jungle', MIDDLE: 'middle', BOTTOM: 'bottom', SUPPORT: 'support' };
const ID_RE = /^[A-Za-z][A-Za-z0-9]{0,30}$/;   // Data Dragon champion id, e.g. MonkeyKing
const skillsUrl = (champion, role) => `https://lolalytics.com/lol/${A.lolalyticsSlug(String(champion).toLowerCase())}/build/?lane=${LANES[role]}&tier=emerald_plus`;

function register(deps) {
    const { ipcMain, userDataPath, sendToWindow } = deps;
    const fetchText = deps.skillsFetch || A.fetchPage;     // tests inject a stub
    const cache = A.createCache(path.join(userDataPath, 'skills-cache'));
    const load = A.createLoader(cache, ev => { try { sendToWindow && sendToWindow('build:skills-updated', ev); } catch (e) { /* window gone */ } });
    ipcMain.handle('build:skills', (e, a) => {
        const champion = String((a && a.champion) || ''), role = a && a.role;
        if (!ID_RE.test(champion) || !LANES[role]) return { ok: false, code: 'BAD_REQUEST', error: 'Unknown champion or role.' };
        const url = skillsUrl(champion, role);
        return load(`skills-${champion.toLowerCase()}-${LANES[role]}`, 'skills', async () => {
            const d = parsers.parseLolalyticsSkills(await fetchText(url));
            if (!d) throw Object.assign(new Error('Could not read the skill order (the LoLalytics page layout may have changed)'), { code: 'PARSE' });
            d.url = url;
            return d;
        }, !!(a && a.force));
    });
    ipcMain.handle('build:skills-cache-info', () => ({ ok: true, data: { files: cache.list() } }));
}

module.exports = { register, skillsUrl, LANES };
