// desktop-app/dodgeball-game.js
// Mundo Dodgeball rules and bot AI. Pure simulation: no DOM, no rendering. Works in a flat "logical" arena of W x H units
// (x right, y down); the 3D scene maps that onto the ground plane. Everything the renderer, HUD and audio react to is
// pushed onto G.events and drained by the view once per frame.

export const W = 1280, H = 720, RIVER = 46;          // logical arena; river half-width (nobody may enter it)
export const UNIT_R = 33, CLEAVER_R = 13;
export const CLEAVER_SPEED = 920, CLEAVER_RANGE = 780;
export const PLAYER_SPEED = 335, PLAYER_HP = 100, PLAYER_Q_CD = 1.25, FLASH_CD = 11, FLASH_DIST = 175;
export const DMG_TO_BOT = 25, DMG_TO_PLAYER = 20, HEAL_BETWEEN = 35, HEAL_ON_HIT = 4;
export const INTRO_TIME = 2.4;

// bot difficulty tiers. dodge = chance a bot even tries to sidestep a given cleaver (rolled once per cleaver)
export const LEVELS = [
    { name: 'Iron Mundo',       tier: 'iron',       color: '#a1a1aa', react: 0.46, aimErr: 0.20,  lead: 0.25, gap: 1.55, speed: 265, qcd: 1.6,  flash: false, dodge: 0.4 },
    { name: 'Gold Mundo',       tier: 'gold',       color: '#facc15', react: 0.33, aimErr: 0.12,  lead: 0.6,  gap: 1.15, speed: 290, qcd: 1.45, flash: false, dodge: 0.62 },
    { name: 'Diamond Mundo',    tier: 'diamond',    color: '#7dd3fc', react: 0.22, aimErr: 0.07,  lead: 0.85, gap: 0.85, speed: 312, qcd: 1.35, flash: true,  dodge: 0.8 },
    { name: 'Challenger Mundo', tier: 'challenger', color: '#f0abfc', react: 0.14, aimErr: 0.045, lead: 1.0,  gap: 0.65, speed: 330, qcd: 1.25, flash: true,  dodge: 0.92 }
];
const ROUNDS = [[0], [1], [0, 0], [2], [1, 1], [3], [2, 2], [1, 2, 1], [3, 3], [2, 3, 2]];
export const roundBots = n => n < ROUNDS.length ? ROUNDS[n] : Array(Math.min(4, 3 + Math.floor((n - ROUNDS.length) / 3))).fill(3);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
const hyp = Math.hypot;

export const bankMin = u => (u.team === 0 ? u.r + 6 : W / 2 + RIVER + u.r);
export const bankMax = u => (u.team === 0 ? W / 2 - RIVER - u.r : W - u.r - 6);
function confine(u) { u.x = clamp(u.x, bankMin(u), bankMax(u)); u.y = clamp(u.y, u.r + 6, H - u.r - 6); }

let nextId = 1;
function makeUnit(team, x, y, lvl) {
    const L = lvl == null ? null : LEVELS[lvl];
    return {
        id: nextId++, team, x, y, px: x, py: y, vx: 0, vy: 0, tx: null, ty: null, r: UNIT_R,
        hp: team === 0 ? PLAYER_HP : 100, maxHp: team === 0 ? PLAYER_HP : 100,
        speed: L ? L.speed : PLAYER_SPEED, qcd: team === 0 ? 0 : rand(0.8, 1.6), qMax: L ? L.qcd : PLAYER_Q_CD,
        fcd: 0, hurtT: 0, dead: false, deathT: 0, face: team === 0 ? 0 : Math.PI,
        lvl, L, name: L ? L.name : 'You', think: 0, nextThrow: L ? rand(0.6, 1.4) : 0, dodging: 0
    };
}

export function createGame() {
    return {
        mode: 'menu',           // menu | intro | play | paused | over
        round: 0, score: 0, combo: 0, bestCombo: 0, thrown: 0, landed: 0, dodged: 0, kills: 0,
        player: null, bots: [], cleavers: [], events: [],
        introT: 0, time: 0, pausedFrom: null, firstBlood: false, roundKills: 0, multiT: 0, multi: 0
    };
}

const emit = (G, type, data) => G.events.push(Object.assign({ type }, data));

// menu backdrop: you and a Challenger Mundo squaring up across the river, nobody moves
export function attract(G) {
    G.mode = 'menu';
    G.player = makeUnit(0, W * 0.2, H * 0.58);
    G.bots = [makeUnit(1, W * 0.8, H * 0.42, 3)];
    G.player.face = Math.atan2(G.bots[0].y - G.player.y, G.bots[0].x - G.player.x);
    G.bots[0].face = G.player.face + Math.PI;
    G.cleavers = [];
}

export function newGame(G) {
    Object.assign(G, { round: 0, score: 0, combo: 0, bestCombo: 0, thrown: 0, landed: 0, dodged: 0, kills: 0, firstBlood: false });
    G.player = makeUnit(0, W * 0.22, H / 2);
    emit(G, 'newgame', {});
    startRound(G);
}

function startRound(G) {
    const lv = roundBots(G.round);
    G.bots = lv.map((l, i) => makeUnit(1, W * 0.78 + rand(-40, 40), (H / (lv.length + 1)) * (i + 1), l));
    G.cleavers = [];
    G.player.tx = G.player.ty = null;
    G.mode = 'intro'; G.introT = INTRO_TIME; G.multi = 0; G.multiT = 0;
    emit(G, 'round', { round: G.round, bots: G.bots });
}

export function pause(G) { if (G.mode === 'play' || G.mode === 'intro') { G.pausedFrom = G.mode; G.mode = 'paused'; } }
export function resume(G) { if (G.mode === 'paused') G.mode = G.pausedFrom || 'play'; }

// ---- actions ---------------------------------------------------------------------------------------------------------
export function throwCleaver(G, u, ang) {
    if (!u || u.dead || u.qcd > 0) return false;
    if (G.mode !== 'play') return false;
    u.qcd = u.qMax; u.face = ang;
    const c = {
        x: u.x + Math.cos(ang) * (u.r + 4), y: u.y + Math.sin(ang) * (u.r + 4),
        vx: Math.cos(ang) * CLEAVER_SPEED, vy: Math.sin(ang) * CLEAVER_SPEED, ang,
        team: u.team, owner: u, dist: 0, age: 0, nearMiss: false, id: nextId++
    };
    G.cleavers.push(c);
    if (u.team === 0) G.thrown++;
    emit(G, 'throw', { unit: u, cleaver: c });
    return true;
}

export function flash(G, u, dx, dy) {
    if (!u || u.dead || u.fcd > 0) return false;
    if (G.mode !== 'play' && G.mode !== 'intro') return false;
    const d = hyp(dx, dy) || 1, k = Math.min(FLASH_DIST, d) / d;
    const fromX = u.x, fromY = u.y;
    u.x += dx * k; u.y += dy * k; confine(u);
    u.px = u.x; u.py = u.y;
    u.tx = u.ty = null; u.fcd = FLASH_CD;
    emit(G, 'flash', { unit: u, fromX, fromY });
    return true;
}

// ---- AI --------------------------------------------------------------------------------------------------------------
function botThink(G, b, dt) {
    const L = b.L, p = G.player;
    b.think -= dt; b.nextThrow -= dt; b.dodging = Math.max(0, b.dodging - dt);

    // 1. dodge the most urgent incoming cleaver it has had time to notice
    let threat = null, best = Infinity;
    for (const c of G.cleavers) {
        if (c.team === b.team || c.age < L.react) continue;
        const roll = c.rolls || (c.rolls = {});
        if (roll[b.id] === undefined) roll[b.id] = Math.random() < L.dodge;
        if (!roll[b.id]) continue;   // this one slips past its guard
        const dx = b.x - c.x, dy = b.y - c.y, sp = CLEAVER_SPEED;
        const ux = c.vx / sp, uy = c.vy / sp;
        const along = dx * ux + dy * uy;
        if (along < -b.r || along > CLEAVER_RANGE - c.dist + b.r) continue;
        const perp = dx * -uy + dy * ux;              // signed perpendicular offset
        const need = b.r + CLEAVER_R + 10 - Math.abs(perp);
        const t = along / sp;
        if (need > 0 && t < best) { best = t; threat = { ux, uy, perp, need, t }; }
    }
    if (threat) {
        // perpendicular escape direction; prefer the side we are already on unless it is walled off
        const nx = -threat.uy, ny = threat.ux;
        let side = threat.perp >= 0 ? 1 : -1;
        const dist = threat.need + 18;
        const fits = s => {
            const x = b.x + nx * s * dist, y = b.y + ny * s * dist;
            return y > b.r + 6 && y < H - b.r - 6 && x > bankMin(b) && x < bankMax(b);
        };
        if (!fits(side)) side = -side;
        b.tx = b.x + nx * side * dist; b.ty = b.y + ny * side * dist;
        b.dodging = 0.25;
        if (L.flash && b.fcd <= 0 && threat.need / b.speed > threat.t * 0.9 && threat.t < 0.35) {
            flash(G, b, nx * side * FLASH_DIST, ny * side * FLASH_DIST);
        }
    } else if (b.dodging <= 0 && (b.think <= 0 || b.tx == null)) {
        // 2. reposition: keep a comfortable distance, juke up and down
        b.think = rand(0.45, 1.4) * (1.2 - b.lvl * 0.15);
        const x = rand(bankMin(b) + 20, bankMax(b) - 10);
        const y = clamp(b.lvl >= 2 && Math.random() < 0.4 ? p.y + rand(-220, 220) : rand(60, H - 60), 40, H - 40);
        b.tx = x; b.ty = y;
    }

    // 3. throw with lead + aim error
    if (b.qcd <= 0 && b.nextThrow <= 0 && !p.dead) {
        const d = hyp(p.x - b.x, p.y - b.y);
        if (d < CLEAVER_RANGE + 40) {
            const t = d / CLEAVER_SPEED;
            const ax = p.x + p.vx * t * L.lead, ay = p.y + p.vy * t * L.lead;
            const ang = Math.atan2(ay - b.y, ax - b.x) + gauss() * L.aimErr;
            throwCleaver(G, b, ang);
            b.nextThrow = L.gap * rand(0.6, 1.4);
        } else {
            b.tx = Math.max(bankMin(b), b.x - 80); b.ty = p.y; // close in
        }
    }
}

// ---- update ----------------------------------------------------------------------------------------------------------
function moveUnit(u, dt, dirx, diry) {
    u.px = u.x; u.py = u.y;
    let mx = 0, my = 0;
    if (dirx || diry) { const d = hyp(dirx, diry); mx = dirx / d; my = diry / d; }
    else if (u.tx != null) {
        const dx = u.tx - u.x, dy = u.ty - u.y, d = hyp(dx, dy);
        if (d < 3) { u.tx = u.ty = null; } else { mx = dx / d; my = dy / d; if (d < u.speed * dt) { mx *= d / (u.speed * dt); my *= d / (u.speed * dt); } }
    }
    u.x += mx * u.speed * dt; u.y += my * u.speed * dt;
    confine(u);
    const ivx = (u.x - u.px) / dt, ivy = (u.y - u.py) / dt;
    u.vx += (ivx - u.vx) * Math.min(1, dt * 12); u.vy += (ivy - u.vy) * Math.min(1, dt * 12); // smoothed, used for AI leading
}

// input: { kx, ky (keyboard direction), moveTo: {x,y}|null, aimX, aimY }
export function update(G, dt, input) {
    G.time += dt;
    if (G.mode === 'intro') { G.introT -= dt; if (G.introT <= 0) { G.mode = 'play'; emit(G, 'fight', {}); } }
    if (G.mode !== 'play' && G.mode !== 'intro') return;

    const p = G.player;
    if (!p.dead) {
        if (input.kx || input.ky) p.tx = p.ty = null;
        if (input.moveTo) { p.tx = input.moveTo.x; p.ty = input.moveTo.y; }
        moveUnit(p, dt, input.kx, input.ky);
        p.face = Math.atan2(input.aimY - p.y, input.aimX - p.x);
    }

    for (const u of [p, ...G.bots]) {
        u.qcd = Math.max(0, u.qcd - dt); u.fcd = Math.max(0, u.fcd - dt); u.hurtT = Math.max(0, u.hurtT - dt);
        if (u.dead) u.deathT += dt;
    }
    if (G.mode === 'intro') return; // bots wait for the banner

    for (const b of G.bots) {
        if (b.dead) continue;
        botThink(G, b, dt);
        moveUnit(b, dt, 0, 0);
        if (!b.dodging) b.face = Math.atan2(p.y - b.y, p.x - b.x);
    }
    // light separation between bots
    for (let i = 0; i < G.bots.length; i++) for (let j = i + 1; j < G.bots.length; j++) {
        const a = G.bots[i], c = G.bots[j]; if (a.dead || c.dead) continue;
        const dx = c.x - a.x, dy = c.y - a.y, d = hyp(dx, dy) || 1, o = a.r + c.r - d;
        if (o > 0) { a.x -= dx / d * o / 2; a.y -= dy / d * o / 2; c.x += dx / d * o / 2; c.y += dy / d * o / 2; confine(a); confine(c); }
    }

    if (G.multiT > 0) { G.multiT -= dt; if (G.multiT <= 0) G.multi = 0; }

    // cleavers
    for (const c of G.cleavers) {
        c.x += c.vx * dt; c.y += c.vy * dt; c.dist += CLEAVER_SPEED * dt; c.age += dt;
        const targets = c.team === 0 ? G.bots : [p];
        for (const u of targets) {
            if (u.dead) continue;
            const d = hyp(u.x - c.x, u.y - c.y);
            if (d < u.r + CLEAVER_R) { hit(G, c, u); c.done = true; break; }
            if (c.team === 1 && d < u.r + CLEAVER_R + 22) c.nearMiss = true;
        }
        if (!c.done && (c.dist >= CLEAVER_RANGE || c.x < -40 || c.x > W + 40 || c.y < -40 || c.y > H + 40)) {
            c.done = true;
            emit(G, 'drop', { cleaver: c, inBounds: c.x > 0 && c.x < W && c.y > 0 && c.y < H });
            if (c.team === 0) { if (G.combo >= 3) emit(G, 'comboLost', { combo: G.combo }); G.combo = 0; }
            else if (c.nearMiss && !p.dead) { G.dodged++; G.score += 15; emit(G, 'dodge', { unit: p }); }
        }
    }
    G.cleavers = G.cleavers.filter(c => !c.done);

    // round end
    if (p.dead && p.deathT > 1.6 && G.mode === 'play') { G.mode = 'over'; emit(G, 'over', {}); }
    else if (!p.dead && G.bots.every(b => b.dead && b.deathT > 1.4)) {
        const bonus = (G.round + 1) * 250;
        G.score += bonus;
        emit(G, 'clear', { round: G.round, bonus });
        G.round++;
        p.hp = Math.min(p.maxHp, p.hp + HEAL_BETWEEN);
        p.qcd = 0; p.fcd = Math.min(p.fcd, 3);
        startRound(G);
    }
}

function hit(G, c, u) {
    const shooter = c.owner;
    let pts = 0, mult = 1;
    if (u.team === 1) {
        G.landed++; G.combo++; G.bestCombo = Math.max(G.bestCombo, G.combo);
        mult = 1 + Math.min(G.combo - 1, 9) * 0.25; pts = Math.round(100 * mult);
        G.score += pts;
        u.hp -= DMG_TO_BOT;
        shooter.qcd *= 0.5; // Mundo refund
        shooter.hp = Math.min(shooter.maxHp, shooter.hp + HEAL_ON_HIT);
    } else {
        u.hp -= DMG_TO_PLAYER;
    }
    u.hurtT = 0.22;
    const dmg = u.team === 1 ? DMG_TO_BOT : DMG_TO_PLAYER;
    emit(G, 'hit', { unit: u, cleaver: c, shooter, dmg, pts, mult, combo: G.combo, x: c.x, y: c.y });
    if (u.team === 1 && !G.firstBlood) { G.firstBlood = true; emit(G, 'firstBlood', {}); }
    if (u.hp <= 0) {
        u.hp = 0; u.dead = true; u.deathT = 0;
        let bonus = 0;
        if (u.team === 1) {
            bonus = 150 * (u.lvl + 1); G.score += bonus; G.kills++;
            G.multi = G.multiT > 0 ? G.multi + 1 : 1; G.multiT = 6;
        }
        emit(G, 'kill', { unit: u, shooter, bonus, multi: u.team === 1 ? G.multi : 0, ace: u.team === 1 && G.bots.every(b => b.dead) });
    }
}
