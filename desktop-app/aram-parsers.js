// desktop-app/aram-parsers.js
// Pure HTML parsers for the ARAM Mayhem mode (no I/O, no dependencies; unit-tested against recorded pages).
//   parseTierList(html)       arammayhem.com/tier-list/            -> { patch, dataDate, champions: [...] }
//   parseChampionPage(html)   arammayhem.com/build/<slug>/         -> { meta, balance, augments{prismatic,gold,silver} }  (no items: items come from LoLalytics only)
//   parseLolalytics(html)     lolalytics.com/lol/<c>/aram/build/   -> { wr, games, rank, spells, start, core, boots, slots }
// Parsers are tolerant: a missing section yields an empty list, never an exception; only a page that has none of the
// expected markers returns null (so the caller can report "site layout changed").

const ORIGIN = 'https://arammayhem.com';

function decodeEntities(s) {
    return String(s == null ? '' : s)
        .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
const num = s => { const n = parseFloat(String(s).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const absUrl = u => !u ? '' : /^https?:/i.test(u) ? u : u.startsWith('//') ? 'https:' + u : ORIGIN + (u.startsWith('/') ? '' : '/') + u;

// Drops comments, scripts, styles, class/data-astro attributes (they change with every site build) so patterns stay short.
function clean(html) {
    return String(html || '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/<style[\s\S]*?<\/style>/g, '')
        .replace(/ data-astro-cid-[\w-]+(="[^"]*")?/g, '')
        .replace(/ class="[^"]*"/g, '');
}

function parseTierList(html) {
    const raw = String(html || '');
    const champions = [];
    const re = /<a href="\/build\/([^"\/]+)\/" class="champion-card[^"]*"([^>]*)>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(raw))) {
        const attrs = m[2], inner = m[3];
        const attr = k => { const a = new RegExp(`${k}="([^"]*)"`).exec(attrs); return a ? decodeEntities(a[1]) : ''; };
        const name = (/champion-card-name"[^>]*title="([^"]*)"/.exec(inner) || /alt="([^"]*)"/.exec(inner) || [])[1];
        const tier = (/champion-tier-chip[^>]*>([^<]+)</.exec(inner) || [])[1];
        const delta = (/champion-rank-delta[^>]*>([^<]*)</.exec(inner) || [])[1] || '';
        const img = (/<img[^>]*src="([^"]+)"/.exec(inner) || [])[1];
        const wr = num(attr('data-win-rate'));
        if (wr == null) continue;
        champions.push({
            slug: m[1], name: decodeEntities(name || m[1]), search: attr('data-search'),
            tags: attr('data-tags').split(',').filter(Boolean),
            wr, rank: num(attr('data-hero-rank')), tier: (tier || '').trim() || null,
            rankDelta: delta.trim() || null, image: img ? absUrl(img) : null
        });
    }
    if (!champions.length) return null;
    const patch = (/Patch (\d+\.\d+)/.exec(raw) || [])[1] || null;
    const dataDate = (/Data updated: (\d{4}-\d{2}-\d{2})/.exec(raw) || [])[1] || null;
    const avgWr = champions.reduce((a, c) => a + c.wr, 0) / champions.length;
    return { patch, dataDate, avgWr: Math.round(avgWr * 100) / 100, champions };
}

function parseAugmentGroups(c) {
    const out = { prismatic: [], gold: [], silver: [] };
    const start = c.indexOf('id="best-augments"');
    if (start < 0) return out;
    const nextSection = c.indexOf('<section', start + 10);
    const seg = c.slice(start, nextSection < 0 ? undefined : nextSection);
    // Rarity labels: a bare <div>Prismatic</div> directly before the group's anchors.
    // ("<div>Prismatic</div>" until 2026-10; now "<h3 class=...>Prismatic Augments</h3>")
    const labels = [...seg.matchAll(/<(?:div|h[2-4])[^>]*>\s*(Prismatic|Gold|Silver)(?:\s+Augments)?\s*<\//g)].map(x => ({ at: x.index, rarity: x[1].toLowerCase() }));
    for (let i = 0; i < labels.length; i++) {
        const part = seg.slice(labels[i].at, i + 1 < labels.length ? labels[i + 1].at : undefined);
        // One card at a time (each starts at its own <a href="/augments/...">), so a card missing a stat can't borrow the next card's numbers.
        const starts = [...part.matchAll(/<a\b[^>]*?href="\/augments\/([^"\/]+)\/"/g)].map(x => ({ at: x.index, slug: x[1] }));
        for (let k = 0; k < starts.length; k++) {
            const card = part.slice(starts[k].at, k + 1 < starts.length ? starts[k + 1].at : undefined);
            const name = /<div\b[^>]*?\btitle="([^"]*)"/.exec(card);
            if (!name) continue;
            const icon = /<img[^>]*?src="([^"]*)"/.exec(card);
            const app = /Appearance rate:\s*<span[^>]*>([\d.,]+)%<\/span>/.exec(card), wr = /Win rate:\s*<span[^>]*>([\d.,]+)%<\/span>/.exec(card);
            if (!app && !wr) continue;
            out[labels[i].rarity].push({ slug: starts[k].slug, name: decodeEntities(name[1]), icon: icon ? absUrl(icon[1]) : null, appearance: app ? num(app[1]) : null, wr: wr ? num(wr[1]) : null });
        }
    }
    return out;
}

function parseChampionPage(html) {
    const raw = String(html || '');
    if (!/Best Augments for/.test(raw) && !/id="best-augments"/.test(raw)) return null;
    const c = clean(raw);
    const stat = label => { const m = new RegExp(`<dt>${label}</dt><dd>([\\d.,]+)%`).exec(c); return m ? num(m[1]) : null; };
    const tierM = /<dt>Tier<\/dt><dd>[\s\S]*?<span>([^<]+)<\/span><span>#(\d+)<\/span>(?:<span>(?:<span>[^<]*<\/span>)?([^<]*)<\/span>)?/.exec(c);
    const meta = {
        name: decodeEntities((/<h1>([^<]*?) ARAM Mayhem Build<\/h1>/.exec(c) || [])[1] || ''),
        wr: stat('Win Rate'), pick: stat('Pick Rate'),
        tier: tierM ? tierM[1].trim() : null, rank: tierM ? num(tierM[2]) : null, rankDelta: tierM && tierM[3] ? tierM[3].trim() : null,
        dataDate: (/<time datetime="([^"]+)"/.exec(c) || [])[1] || (/Data date: (\d{4}-\d{2}-\d{2})/.exec(c) || [])[1] || null,
        patch: (/Patch: (\d+\.\d+)/.exec(c) || [])[1] || null,
        roles: [...(/<h1>[\s\S]*?Patch: /.exec(c) || [''])[0].matchAll(/data-slot="badge"[^>]*>([^<]+)</g)].map(x => x[1].trim())
    };
    const balance = [];
    const balRe = /title="ARAM Balance Adjustments"[^>]*><span[^>]*>([^<]*)<\/span><span>([^<]*)<\/span><span>([^<]*)<\/span>/g;
    let b;
    while ((b = balRe.exec(c))) balance.push({ dir: b[1].trim(), label: decodeEntities(b[2]).trim(), value: decodeEntities(b[3]).trim() });
    return { meta, balance, augments: parseAugmentGroups(c) };
}

// ---- LoLalytics (Qwik, server-rendered) -------------------------------------------------------------------------------------
// Reduce the page to a flat token list; item and spell images become "§I<id>§" / "§S<id>:<name>§" tokens. The data blocks read as
//   Summoner Spells | spell... | "49.4% Win Rate" | "26,783 Games"      Starting Items | item... [x N] | "50.68% Win Rate" | "24,495 Games"
//   Core Build | item item "51.9%" "7,511" item | Item 4 | item "51.19%" "18,661" | OR | item "50.91%" "34,951" | Item 5 ...
function lolTokens(html) {
    let h = String(html || '');
    const q = h.indexOf('<script type="qwik/json"'); if (q > 0) h = h.slice(0, q);
    h = h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<img[^>]*?src="[^"]*?item64\/(\d+)[^"]*"[^>]*>/g, '|§I$1§|')
        .replace(/<img[^>]*?src="[^"]*?spell64\/(\d+)[^"]*"[^>]*?alt="([^"]*)"[^>]*>/g, '|§S$1:$2§|');
    return h.replace(/<[^>]+>/g, '|').replace(/\s+/g, ' ').split('|').map(s => decodeEntities(s.trim())).filter(x => x && x !== 'Loading...');
}

// Boots are not in the server-rendered text, but the page embeds its data as Qwik state (<script type="qwik/json">): objects reference
// each other by base-36 indices into `objs`. The main object has `boots` = rows [itemId, winRate, pickRate, games, avgBuyOrder], and
// item3 / item4 / item5 = the same row shape for the page's "Item 4" / "Item 5" / "Item 6" sections (checked against the rendered rows),
// but with every option instead of the 2-3 the page prints. Only those arrays are resolved (not the whole 10k-object graph).
// Returns null when the state or the key is missing.
const QWIK_SLOT_KEYS = { 4: 'item3', 5: 'item4', 6: 'item5' };
const QWIK_SLOT_MAX = 8;
function parseQwikBuild(html) {
    const m = /<script\s+type="qwik\/json"[^>]*>([\s\S]*?)<\/script>/.exec(String(html || ''));
    if (!m) return null;
    let objs;
    try { objs = JSON.parse(m[1]).objs; } catch (e) { return null; }
    if (!Array.isArray(objs)) return null;
    const get = id => {
        if (typeof id === 'string' && /^[0-9a-z]+$/.test(id)) { const i = parseInt(id, 36); if (i >= 0 && i < objs.length) return objs[i]; }
        return id;
    };
    const main = objs.find(o => o && typeof o === 'object' && !Array.isArray(o) && 'boots' in o && 'startItem' in o && 'item1' in o);
    if (!main) return null;
    const rowsOf = key => {
        const rows = get(main[key]);
        if (!Array.isArray(rows)) return [];
        const out = [];
        for (const r of rows) {
            const row = get(r);
            if (!Array.isArray(row)) continue;
            const [id, wr, pick, games] = row.map(v => get(v));
            if (typeof id !== 'number' || typeof wr !== 'number' || typeof games !== 'number') continue;
            out.push({ id, wr, pick: typeof pick === 'number' ? pick : null, games });
        }
        return out;
    };
    const boots = rowsOf('boots').map(b => ({ ...b, other: b.id === 9999 }));   // 9999 = LoLalytics' "other / none" bucket
    const slots = {};
    for (const [slot, key] of Object.entries(QWIK_SLOT_KEYS)) slots[slot] = rowsOf(key).sort((a, b) => b.games - a.games).slice(0, QWIK_SLOT_MAX);
    return { boots, slots };
}

function parseLolalytics(html) {
    const t = lolTokens(html);
    if (!t.length) return null;
    const idx = (s, from = 0) => t.indexOf(s, from);
    const itemId = x => { const m = /^§I(\d+)§$/.exec(x || ''); return m ? +m[1] : null; };
    const isPct = x => /^[\d.]+%$/.test(x || '');
    const isGames = x => /^[\d,]+$/.test(x || '');
    const statPair = from => { // "NN.N% Win Rate" then "N,NNN Games"
        for (let i = from; i < Math.min(t.length, from + 12); i++) {
            const m = /^([\d.]+)% Win Rate$/.exec(t[i]);
            if (m) { const g = /^([\d,]+) Games$/.exec(t[i + 1] || ''); return { wr: +m[1], games: g ? num(g[1]) : null, end: i + 2 }; }
        }
        return { wr: null, games: null, end: from };
    };
    const head = /has a ([\d.]+)% win rate in ([A-Za-z+ ]+?) on Patch (\d+)/.exec(t.join(' '));
    const before = (label, from = 0) => { const i = idx(label, from); return i > 0 ? t[i - 1] : null; };
    const out = {
        wr: head ? +head[1] : num(before('Win Rate')), tierLabel: head ? head[2] : null, patch: head ? head[3] : null,
        pick: num(before('Pick Rate')), games: num(before('Games')), tier: null, rank: null, rankOf: null,
        spells: null, start: null, core: null, boots: [], slots: { 4: [], 5: [], 6: [] }
    };
    const qwik = parseQwikBuild(html);
    out.boots = qwik ? qwik.boots : [];
    const rk = /^(\d+) \/ (\d+)$/.exec(before('Rank') || ''); if (rk) { out.rank = +rk[1]; out.rankOf = +rk[2]; }
    const ti = idx('Tier'); if (ti > 0 && /^[SABCD][+-]?$/.test(t[ti - 1])) out.tier = t[ti - 1];

    const si = idx('Summoner Spells');
    if (si >= 0) {
        const ids = [], names = [];
        for (let i = si + 1; i < si + 8 && i < t.length; i++) {
            const m = /^§S(\d+):(.*)§$/.exec(t[i]);
            if (m) { ids.push(+m[1]); names.push(m[2]); } else if (/Win Rate$/.test(t[i])) break;
        }
        const sp = statPair(si + 1);
        if (ids.length) out.spells = { ids, names, wr: sp.wr, games: sp.games };
    }
    const sti = idx('Starting Items');
    if (sti >= 0) {
        const items = [];
        for (let i = sti + 1; i < sti + 12 && i < t.length; i++) {
            const id = itemId(t[i]);
            if (id != null) items.push({ id, count: 1 });
            else if (/^x \d+$/.test(t[i]) && items.length) items[items.length - 1].count = +t[i].slice(2);
            else if (/Win Rate$/.test(t[i])) break;
        }
        const sp = statPair(sti + 1);
        if (items.length) out.start = { items, wr: sp.wr, games: sp.games };
    }
    const ci = idx('Core Build');
    if (ci >= 0) {
        const end = idx('Item 4', ci) > 0 ? idx('Item 4', ci) : Math.min(t.length, ci + 12);
        const ids = []; let wr = null, games = null;
        for (let i = ci + 1; i < end; i++) {
            const id = itemId(t[i]);
            if (id != null) ids.push(id);
            else if (isPct(t[i]) && wr == null) { wr = num(t[i]); if (isGames(t[i + 1])) games = num(t[i + 1]); }
        }
        if (ids.length) out.core = { items: ids, wr, games };
    }
    for (const slot of [4, 5, 6]) {
        const s = idx(`Item ${slot}`, ci >= 0 ? ci : 0);
        if (s < 0) continue;
        let e = t.length;
        for (const stop of [`Item ${slot + 1}`, 'LEGEND:']) { const k = idx(stop, s + 1); if (k > 0 && k < e) e = k; }
        for (let i = s + 1; i < e; i++) {
            const id = itemId(t[i]);
            if (id != null && isPct(t[i + 1]) && isGames(t[i + 2])) out.slots[slot].push({ id, wr: num(t[i + 1]), games: num(t[i + 2]) });
        }
    }
    // The page state lists every option per slot; the rendered text only the top 2-3. Prefer the full list, keep the text as the fallback.
    if (qwik) for (const slot of [4, 5, 6]) if (qwik.slots[slot].length >= out.slots[slot].length) out.slots[slot] = qwik.slots[slot].map(r => ({ id: r.id, wr: r.wr, games: r.games, pick: r.pick }));
    if (out.wr == null && !out.core && !out.start) return null;
    return out;
}

// Skill order from a LoLalytics build page (Summoner's Rift /lol/<c>/build/ or ARAM /lol/<c>/aram/build/): the page state's
// header + summary. summary.pick = the most played choice, summary.win = the highest win rate one; skillpriority.id is the max
// order ("QWE"), skillorder.id the first 15 level-ups as digits (1 = Q, 2 = W, 3 = E, 4 = R). Returns
// { lane, queue, games, priority: { pick:{order,games,wr}, win:{...} }, order: { pick:{seq:[...],games,wr}, win:{...} }, length } or null.
// length: win rate by game length, [{ label, games, wr }] from the page's time / timeWin (games and wins in LoLalytics' 7 buckets:
// under 15, 15-20, 20-25, 25-30, 30-35, 35-40 and 40+ minutes; their games add up to the page's total), or null.
function parseLolalyticsSkills(html) {
    const m = /<script\s+type="qwik\/json"[^>]*>([\s\S]*?)<\/script>/.exec(String(html || ''));
    if (!m) return null;
    let objs;
    try { objs = JSON.parse(m[1]).objs; } catch (e) { return null; }
    if (!Array.isArray(objs)) return null;
    const get = id => {
        if (typeof id === 'string' && /^[0-9a-z]+$/.test(id)) { const i = parseInt(id, 36); if (i >= 0 && i < objs.length) return objs[i]; }
        return id;
    };
    const isObj = o => o && typeof o === 'object' && !Array.isArray(o);
    const holder = objs.find(o => isObj(o) && 'header' in o && 'summary' in o);
    if (!holder) return null;
    const header = get(holder.header), summary = get(holder.summary);
    if (!isObj(header) || !isObj(summary)) return null;
    const one = (side, key) => {
        const s = get(summary[side]); if (!isObj(s)) return null;
        const x = get(s[key]); if (!isObj(x)) return null;
        return { id: get(x.id), games: get(x.n), wr: get(x.wr) };
    };
    const prio = x => (x && typeof x.id === 'string' && /^[QWE]{3}$/.test(x.id) && typeof x.games === 'number' ? { order: x.id.split(''), games: x.games, wr: typeof x.wr === 'number' ? x.wr : null } : null);
    const seq = x => {
        if (!x || x.id == null || typeof x.games !== 'number') return null;
        const digits = String(x.id).split('').map(Number);
        if (digits.length < 9 || digits.some(d => !(d >= 1 && d <= 4))) return null;
        return { seq: digits.map(d => 'QWER'[d - 1]), games: x.games, wr: typeof x.wr === 'number' ? x.wr : null };
    };
    const out = {
        lane: get(header.lane) || null, queue: get(header.queue) || null, games: get(header.n) || null,
        priority: { pick: prio(one('pick', 'skillpriority')), win: prio(one('win', 'skillpriority')) },
        order: { pick: seq(one('pick', 'skillorder')), win: seq(one('win', 'skillorder')) }
    };
    const tw = objs.find(o => isObj(o) && 'time' in o && 'timeWin' in o);
    if (tw) {
        const t = get(tw.time), w = get(tw.timeWin);
        if (isObj(t) && isObj(w)) {
            const rows = LENGTH_LABELS.map((label, i) => { const g = get(t[i + 1]), v = get(w[i + 1]); return typeof g === 'number' && typeof v === 'number' && g > 0 ? { label, games: g, wr: v / g * 100 } : { label, games: 0, wr: null }; });
            if (rows.some(r => r.games)) out.length = rows;
        }
    }
    return out.priority.pick || out.order.pick ? out : null;
}
const LENGTH_LABELS = ['<15', '15-20', '20-25', '25-30', '30-35', '35-40', '40+'];

module.exports = { parseTierList, parseChampionPage, parseLolalytics, parseQwikBuild, parseLolalyticsSkills, lolTokens, clean };
