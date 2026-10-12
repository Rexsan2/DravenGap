// desktop-app/profile-timeline.js
// Pure helpers for match-v5 timelines (/lol/match/v5/matches/{id}/timeline):
//   compactTimeline(raw)          -> small permanent form { v, id, frames:[{t,g[],x[],c[],l[]}], ev:[{t,p,k,i,b,a}], sk:[{t,p,s}] }
//                                    v2 (2026-10-11) adds champion kills to ev: { t, k:'K', p: killer (0 = executed), v: victim, x, y, as: [assists] }
//   deriveTimeline(tl, teamByPid) -> what the view renders: per-participant item timeline + skill order, team gold difference,
//                                    per-minute gold / xp / CS of everyone (series) and the kills (v2 only)
// Participant ids are 1-based (index + 1 in info.participants); arrays g/x/c/l are indexed by participantId - 1.
const N = 10;
const TL_VERSION = 2;   // 2: kills with positions (the Review tab's minimap); a v1 timeline is fetched again when the Review tab needs them

function compactTimeline(raw) {
    const info = raw && raw.info;
    if (!info || !Array.isArray(info.frames)) return null;
    const frames = [], ev = [], sk = [];
    for (const f of info.frames) {
        const pf = f.participantFrames || {};
        const g = [], x = [], c = [], l = [];
        for (let i = 1; i <= N; i++) {
            const p = pf[i] || pf[String(i)] || {};
            g.push(p.totalGold || 0); x.push(p.xp || 0); c.push((p.minionsKilled || 0) + (p.jungleMinionsKilled || 0)); l.push(p.level || 0);
        }
        frames.push({ t: f.timestamp || 0, g, x, c, l });
        for (const e of f.events || []) {
            const pid = e.participantId;
            if (!(pid >= 1 && pid <= N)) continue;
            if (e.type === 'ITEM_PURCHASED') ev.push({ t: e.timestamp || 0, p: pid, k: 'B', i: e.itemId || 0 });
            else if (e.type === 'ITEM_SOLD') ev.push({ t: e.timestamp || 0, p: pid, k: 'S', i: e.itemId || 0 });
            else if (e.type === 'ITEM_UNDO') ev.push({ t: e.timestamp || 0, p: pid, k: 'U', b: e.beforeId || 0, a: e.afterId || 0 });
            else if (e.type === 'SKILL_LEVEL_UP' && (!e.levelUpType || e.levelUpType === 'NORMAL') && e.skillSlot >= 1 && e.skillSlot <= 4) sk.push({ t: e.timestamp || 0, p: pid, s: e.skillSlot });
        }
        for (const e of f.events || []) {   // kills: the victim is a participant; the killer can be 0 (tower, minions, executed)
            if (e.type !== 'CHAMPION_KILL' || !(e.victimId >= 1 && e.victimId <= N)) continue;
            const pos = e.position || {};
            ev.push({ t: e.timestamp || 0, k: 'K', p: e.killerId >= 1 && e.killerId <= N ? e.killerId : 0, v: e.victimId, x: pos.x || 0, y: pos.y || 0,
                as: (e.assistingParticipantIds || []).filter(a => a >= 1 && a <= N) });
        }
    }
    return { v: TL_VERSION, id: raw.metadata && raw.metadata.matchId, frames, ev, sk };
}

// Purchases/sales of one participant after applying ITEM_UNDO: an undo with beforeId removes that player's latest
// not-yet-undone purchase of the item (afterId is what the slot becomes, normally 0); an undo with only afterId reverses
// a sale (the item comes back, so the latest sale of it is removed). Events must be in chronological order.
function itemActions(ev, pid) {
    const out = [];
    for (const e of ev || []) {
        if (e.p !== pid) continue;
        if (e.k === 'B' || e.k === 'S') out.push({ t: e.t, k: e.k, i: e.i });
        else if (e.k === 'U') {
            const kind = e.b ? 'B' : (e.a ? 'S' : null), id = e.b || e.a;
            for (let j = out.length - 1; kind && j >= 0; j--) if (out[j].k === kind && out[j].i === id) { out.splice(j, 1); break; }
        }
    }
    return out;
}

// [{ m: minute, items: [{ i, s? }] }] grouped by game minute (s = 1 for a sale)
function itemsByMinute(ev, pid) {
    const groups = [];
    for (const a of itemActions(ev, pid)) {
        const m = Math.floor(a.t / 60000);
        let g = groups[groups.length - 1];
        if (!g || g.m !== m) { g = { m, items: [] }; groups.push(g); }
        g.items.push(a.k === 'S' ? { i: a.i, s: 1 } : { i: a.i });
    }
    return groups;
}

// Skill order: seq[levelIndex] = 1..4 (Q W E R), prio = e.g. "Q > E > W" by when each basic skill was maxed (R excluded).
function skillOrder(sk, pid) {
    const seq = (sk || []).filter(s => s.p === pid).sort((a, b) => a.t - b.t).map(s => s.s).slice(0, 18);
    const cnt = [0, 0, 0, 0, 0], last = [0, 0, 0, 0, 0];
    seq.forEach((s, i) => { cnt[s]++; last[s] = i; });
    const prio = [1, 2, 3].filter(s => cnt[s] > 0).sort((a, b) => cnt[b] - cnt[a] || last[a] - last[b]).map(s => 'QWER'[s - 1]).join(' > ');
    return { seq, prio };
}

// teamByPid: array [teamId of pid 1 ... pid 10]; missing -> pids 1-5 are team 100
function deriveTimeline(tl, teamByPid) {
    if (!tl) return null;
    const team = pid => (teamByPid && teamByPid[pid - 1]) || (pid <= 5 ? 100 : 200);
    const players = {};
    for (let pid = 1; pid <= N; pid++) players[pid] = { items: itemsByMinute(tl.ev, pid), skills: skillOrder(tl.sk, pid) };
    const gold = tl.frames.map(f => {
        let a = 0, b = 0;
        for (let pid = 1; pid <= N; pid++) { if (team(pid) === 100) a += f.g[pid - 1]; else b += f.g[pid - 1]; }
        return { m: Math.round(f.t / 600) / 100, d: a - b };   // blue minus red
    });
    const series = tl.frames.map(f => ({ m: Math.round(f.t / 600) / 100, g: f.g, x: f.x, c: f.c }));
    const kills = (tl.ev || []).filter(e => e.k === 'K').map(e => ({ m: Math.round(e.t / 600) / 100, p: e.p, v: e.v, x: e.x, y: e.y, as: e.as || [] }));
    return { id: tl.id, v: tl.v || 1, players, gold, frames: tl.frames.length, series, kills: (tl.v || 1) >= 2 ? kills : null };
}

module.exports = { compactTimeline, itemActions, itemsByMinute, skillOrder, deriveTimeline, TL_VERSION };
