// desktop-app/profile-lcu.js
// Cheap LCU access for the Profile view: credentials are cached (getLeagueCredentials spawns a process per call)
// and only looked up again after a failure, with back-off while the client isn't running. Concurrent callers share one
// lookup, and a lookup that has not answered after credTimeoutMs (a hung process spawn) counts as a failure, so the
// phase poller and every other caller carry on.
function createLcu({ getLeagueCredentials, lcuRequest, credTimeoutMs = 10000 }) {
    let creds = null, fails = 0, nextTry = 0, pending = null;

    function ensureCreds() {
        if (creds) return Promise.resolve(creds);
        if (Date.now() < nextTry) return Promise.resolve(null);
        if (pending) return pending;
        const p = (async () => {
            let t = null;
            try {
                const c = await Promise.race([getLeagueCredentials(), new Promise((_, rej) => { t = setTimeout(() => rej(new Error('credential lookup timed out')), credTimeoutMs); if (t.unref) t.unref(); })]);
                creds = c; fails = 0; return c;
            } catch (e) { fails++; nextTry = Date.now() + Math.min(60000, 8000 * fails); return null; }
            finally { clearTimeout(t); }
        })();
        pending = p;
        p.then(() => { if (pending === p) pending = null; });
        return p;
    }
    function invalidate() { creds = null; }

    // GET a path. null when the client is down or the endpoint has no data (non-200).
    async function get(path) {
        const c = await ensureCreds();
        if (!c) return null;
        try { return await lcuRequest(path, c); }
        catch (e) { creds = null; return null; } // connection refused: client closed or restarted
    }
    return { get, invalidate, isUp: () => !!creds, creds: ensureCreds }; // creds(): cached { port, password } or null (client down)
}

// One credential cache per getLeagueCredentials function, so the Profile and ARAM views (both registered with the same
// deps) share a single lookup + back-off instead of each spawning wmic/PowerShell.
const sharedByCreds = new WeakMap();
function getSharedLcu(deps) {
    const key = deps.getLeagueCredentials;
    if (typeof key !== 'function') return createLcu(deps);
    const hit = sharedByCreds.get(key);
    if (hit && hit.lcuRequest === deps.lcuRequest) return hit.lcu;
    const lcu = createLcu(deps);
    sharedByCreds.set(key, { lcu, lcuRequest: deps.lcuRequest });
    return lcu;
}

const ACTIVE_PHASES = new Set(['GameStart', 'InProgress', 'Reconnect']);

// Polls the gameflow phase and calls onChange(prev, next). Stops polling the process list while the client is down
// (the back-off in createLcu limits attempts to one spawn every 8-60 s).
function createPhasePoller(lcu, onChange, intervalMs = 5000) {
    let last = null, timer = null, busy = false;
    async function tick() {
        if (busy) return;
        busy = true;
        try {
            const phase = await lcu.get('/lol-gameflow/v1/gameflow-phase');
            const next = typeof phase === 'string' ? phase : null;
            if (next === null && lcu.isUp()) lcu.invalidate(); // answered with an error: stale credentials
            if (next !== last) { const prev = last; last = next; try { onChange(prev, next); } catch (e) { console.error('profile phase handler', e); } }
        } finally { busy = false; }
    }
    return {
        start(firstDelay = 2000) {
            if (timer) return;
            const t = setTimeout(tick, firstDelay); if (t.unref) t.unref();
            timer = setInterval(tick, intervalMs);
            if (timer.unref) timer.unref();
        },
        stop() { clearInterval(timer); timer = null; },
        tick, phase: () => last
    };
}

module.exports = { createLcu, getSharedLcu, createPhasePoller, ACTIVE_PHASES };
