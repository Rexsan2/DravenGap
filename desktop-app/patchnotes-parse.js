// Riot patch notes (leagueoflegends.com) -> per champion: buff / nerf / adjust, with the changes. Pure (no I/O), used by patchnotes-main.js.
// The notes don't label buffs and nerfs (Riot's summary is an image), so each champion is classified from its change lines:
//  - every "Attribute: before ⇒ after" line is compared number by number; for cooldowns, costs, cast times and the like a lower
//    value is better, for everything else higher is better -> +1 (better for the champion), -1 (worse) or 0 (unclear, text only);
//  - the developer context ("too strong", "compensation", "weak"...) decides lines without numbers and breaks mixed cases;
//  - all better = buff, all worse = nerf, both (or nothing measurable and no clear context) = adjust.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rArr: '⇒' };
const unescape = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
});
const text = h => unescape(String(h).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// attributes where a smaller number is better for the champion ("Cooldown Refund" / "Cooldown Reduction" are amounts given back: higher is better)
const LOWER_BETTER = /cooldown(?!\s*(?:refund|reduction))|\bcost\b|cast time|wind-?up|delay|recharge|lockout|charge time|channel(?:ing)? (?:time|duration)|self[- ]damage|damage taken|penalty|refund threshold|time to/i;
const BUFF_WORDS = /\b(buffs?|buffing|buffed|compensat\w*|weak\w*|lagging|struggl\w*|underperform\w*|more power|stronger|power ?up|bring \w+ up)\b/gi;
const NERF_WORDS = /\b(nerfs?|nerfing|nerfed|too strong|too much|too reliable|too oppressive|too dominant|dominant|oppressive|overperform\w*|tone \w* ?down|toning \w* ?down|harder|over-?tuned|frustrat\w*)\b/gi;

// The numbers of one side of a change line. A hyphen or dash between two numbers is a range ("40-200", "levels 1-18", "+0-9%"),
// not a minus sign, and ".55" is 0.55.
const nums = s => (String(s).replace(/(\d)\s*[-–]\s*(?=\.?\d)/g, '$1 ').match(/-?(?:\d+(?:\.\d+)?|\.\d+)/g) || []).map(Number);

// +1 better, -1 worse, 0 unclear
function lineDirection(attr, before, after) {
    const a = nums(before), b = nums(after);
    if (!a.length || !b.length) return 0;
    let up = 0, down = 0;
    if (a.length === b.length) { a.forEach((x, i) => { if (b[i] > x) up++; else if (b[i] < x) down++; }); }
    else { const sa = a.reduce((t, x) => t + x, 0) / a.length, sb = b.reduce((t, x) => t + x, 0) / b.length; if (sb > sa) up++; else if (sb < sa) down++; }
    const d = Math.sign(up - down);
    return LOWER_BETTER.test(attr) ? -d : d;
}

function contextDirection(ctx) {
    const b = (ctx.match(BUFF_WORDS) || []).length, n = (ctx.match(NERF_WORDS) || []).length;
    return Math.sign(b - n);
}

function classify(changes, ctx) {
    const b = changes.filter(c => c.dir > 0).length, n = changes.filter(c => c.dir < 0).length, cd = contextDirection(ctx);
    if (b && !n) return 'buff';
    if (n && !b) return 'nerf';
    if (b && n) return cd > 0 && b >= n ? 'buff' : cd < 0 && n >= b ? 'nerf' : 'adjust';
    return cd > 0 ? 'buff' : cd < 0 ? 'nerf' : 'adjust';
}

// html -> { champions: { DataDragonId: { name, kind, context, changes: [{ section, attr, before, after, text, dir }] } } }
function parsePatchNotes(html) {
    const s = String(html || '');
    const h2 = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
    let start = -1, end = s.length, m;
    while ((m = h2.exec(s))) {
        if (start < 0 && /^champions$/i.test(text(m[1]))) start = h2.lastIndex;
        else if (start >= 0) { end = m.index; break; }
    }
    const champions = {};
    if (start < 0) return { champions };
    const section = s.slice(start, end);
    for (const block of section.split(/class="patch-change-block/).slice(1)) {
        const img = /\/img\/champion\/([A-Za-z0-9]+)\.png/.exec(block);
        const title = /<h3\b[^>]*class="change-title"[^>]*>([\s\S]*?)<\/h3>/.exec(block);
        if (!img || !title) continue;
        const id = img[1];
        const ctxM = /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/.exec(block);
        const context = ctxM ? text(ctxM[1]) : '';
        const changes = [];
        let sectionName = '';
        const tok = /<h4\b[^>]*>([\s\S]*?)<\/h4>|<li\b[^>]*>([\s\S]*?)<\/li>/gi;
        let t;
        while ((t = tok.exec(block))) {
            if (t[1] !== undefined) { sectionName = text(t[1]); continue; }
            const line = text(t[2]);
            if (!line) continue;
            const arrow = line.indexOf('⇒');
            if (arrow < 0) { changes.push({ section: sectionName, text: line, dir: 0 }); continue; }
            const colon = line.lastIndexOf(':', arrow);
            const attr = colon > 0 ? line.slice(0, colon).trim() : '';
            const before = line.slice(colon > 0 ? colon + 1 : 0, arrow).trim(), after = line.slice(arrow + 1).trim();
            changes.push({ section: sectionName, attr, before, after, text: line, dir: lineDirection(attr, before, after) });
        }
        const prev = champions[id];
        if (prev) { prev.changes.push(...changes); if (context) prev.context = (prev.context ? prev.context + ' ' : '') + context; prev.kind = classify(prev.changes, prev.context); continue; }
        champions[id] = { name: text(title[1]), kind: classify(changes, context), context, changes };
    }
    return { champions };
}

// Game patch '16.20' -> the notes' URLs (Riot numbers the notes by year: 16.x is 26.x)
function notesUrls(patch) {
    const m = /^(\d+)\.(\d+)$/.exec(String(patch));
    if (!m) return [];
    const y = Number(m[1]) + 10, n = Number(m[2]);
    return [`https://www.leagueoflegends.com/en-us/news/game-updates/league-of-legends-patch-${y}-${n}-notes/`,
            `https://www.leagueoflegends.com/en-us/news/game-updates/patch-${y}-${n}-notes/`];
}

module.exports = { parsePatchNotes, lineDirection, classify, notesUrls };
