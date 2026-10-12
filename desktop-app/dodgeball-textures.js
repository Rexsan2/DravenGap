// desktop-app/dodgeball-textures.js
// Procedural textures for Mundo Dodgeball, painted once into canvases (nothing is downloaded). Colour maps are sRGB;
// normal and roughness maps are linear. Noise is tileable when a period is given so repeated textures have no seams.
import * as THREE from 'three';

// ---- noise -----------------------------------------------------------------------------------------------------------
const PERM = new Uint8Array(512);
(function seed(s) {
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [p[i], p[j]] = [p[j], p[i]]; }
    for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
})(1337);
const VAL = new Float32Array(256).map((_, i) => PERM[i] / 255);
const fade = t => t * t * (3 - 2 * t);

// value noise in [0,1]; tileable with period p (integer lattice cells) when given
export function vnoise(x, y, p) {
    let xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    let x1 = xi + 1, y1 = yi + 1;
    if (p) { xi = ((xi % p) + p) % p; yi = ((yi % p) + p) % p; x1 = ((x1 % p) + p) % p; y1 = ((y1 % p) + p) % p; }
    const h = (a, b) => VAL[PERM[(PERM[a & 255] + b) & 255]];
    const u = fade(xf), v = fade(yf);
    const a = h(xi, yi), b = h(x1, yi), c = h(xi, y1), d = h(x1, y1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x, y, oct, p) {
    let s = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) { s += amp * vnoise(x * f, y * f, p ? p * f : 0); norm += amp; amp *= 0.5; f *= 2; }
    return s / norm;
}
// ridged noise: sharp creases, good for veins and cracks
export function ridge(x, y, oct, p) {
    let s = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) { s += amp * (1 - Math.abs(vnoise(x * f, y * f, p ? p * f : 0) * 2 - 1)); norm += amp; amp *= 0.5; f *= 2; }
    return s / norm;
}

// ---- helpers ---------------------------------------------------------------------------------------------------------
const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const hex = h => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const mixc = (c1, c2, t) => [mix(c1[0], c2[0], t), mix(c1[1], c2[1], t), mix(c1[2], c2[2], t)];

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

// paint(u, v, out) fills out[0..3] (rgba 0..255) for every pixel; returns the canvas plus a Float32 height buffer if
// paint writes one through out[4]
function paintCanvas(w, h, paint) {
    const c = canvas(w, h), g = c.getContext('2d'), img = g.createImageData(w, h), d = img.data;
    const height = new Float32Array(w * h), out = [0, 0, 0, 255, 0];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        out[3] = 255; out[4] = 0;
        paint(x / w, y / h, out, x, y);
        const i = (y * w + x) * 4;
        d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2]; d[i + 3] = out[3];
        height[y * w + x] = out[4];
    }
    g.putImageData(img, 0, 0);
    return { canvas: c, height };
}

export function normalFromHeight(height, w, h, strength, wrap) {
    const c = canvas(w, h), g = c.getContext('2d'), img = g.createImageData(w, h), d = img.data;
    const at = (x, y) => {
        if (wrap) { x = (x + w) % w; y = (y + h) % h; } else { x = Math.max(0, Math.min(w - 1, x)); y = Math.max(0, Math.min(h - 1, y)); }
        return height[y * w + x];
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * strength, dy = (at(x, y + 1) - at(x, y - 1)) * strength;
        const len = Math.hypot(dx, dy, 1);
        const i = (y * w + x) * 4;
        d[i] = (-dx / len * 0.5 + 0.5) * 255; d[i + 1] = (dy / len * 0.5 + 0.5) * 255; d[i + 2] = (1 / len * 0.5 + 0.5) * 255; d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
}

function tex(c, srgb, repeat) {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
}

// ---- materials' textures ---------------------------------------------------------------------------------------------
// Mundo's skin: bruised purple with green-tinged veins, stitch scars and pores. Returns { map, normalMap, roughnessMap }.
export function makeSkin() {
    const S = 512, P = 8;
    const base = hex(0x8a68b4), dark = hex(0x5b3f80), bruise = hex(0x6d3d6e), vein = hex(0x4f6a52), pale = hex(0xb39ad0);
    const { canvas: c, height } = paintCanvas(S, S, (u, v, o) => {
        const n = fbm(u * P, v * P, 5, P);
        const blot = fbm(u * 3 + 7, v * 3 + 3, 4, 3);
        const vr = ridge(u * 6 + 11, v * 6 + 5, 3, 6);
        const veinAmt = smooth(0.86, 0.96, vr) * 0.55;
        let col = mixc(dark, base, smooth(0.25, 0.75, n));
        col = mixc(col, pale, smooth(0.62, 0.8, fbm(u * 16, v * 16, 2, 16)) * 0.25);
        col = mixc(col, bruise, smooth(0.6, 0.78, blot) * 0.6);
        col = mixc(col, vein, veinAmt);
        const pore = vnoise(u * 180, v * 180, 180);
        o[0] = col[0] * (0.94 + pore * 0.08); o[1] = col[1] * (0.94 + pore * 0.08); o[2] = col[2] * (0.94 + pore * 0.08);
        o[4] = n * 0.6 + pore * 0.25 + veinAmt * 0.9;
    });
    // stitched scars
    const g = c.getContext('2d');
    const scar = (x0, y0, x1, y1) => {
        g.strokeStyle = 'rgba(70,30,60,0.75)'; g.lineWidth = 4; g.lineCap = 'round';
        g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
        g.strokeStyle = 'rgba(30,20,20,0.85)'; g.lineWidth = 1.6;
        const n = Math.round(Math.hypot(x1 - x0, y1 - y0) / 9), nx = -(y1 - y0), ny = x1 - x0, nl = Math.hypot(nx, ny);
        for (let i = 1; i < n; i++) {
            const t = i / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
            g.beginPath(); g.moveTo(x - nx / nl * 5, y - ny / nl * 5); g.lineTo(x + nx / nl * 5, y + ny / nl * 5); g.stroke();
        }
    };
    scar(60, 120, 190, 150); scar(300, 330, 420, 280); scar(380, 60, 470, 140); scar(120, 400, 140, 490);
    const nrm = normalFromHeight(height, S, S, 3.2, true);
    const rough = paintCanvas(256, 256, (u, v, o) => { const r = 150 + fbm(u * 8, v * 8, 4, 8) * 80; o[0] = o[1] = o[2] = r; }).canvas;
    return { map: tex(c, true, true), normalMap: tex(nrm, false, true), roughnessMap: tex(rough, false, true) };
}

// rough woven cloth for the trousers
export function makeCloth(hexBase) {
    const S = 256, base = hex(hexBase);
    const { canvas: c, height } = paintCanvas(S, S, (u, v, o, x, y) => {
        const weave = ((x >> 1) + (y >> 1)) % 2 ? 0.92 : 1.0;
        const thread = 0.85 + 0.15 * Math.sin(x * 1.6) * Math.sin(y * 1.6);
        const dirt = fbm(u * 4, v * 4, 4, 4);
        const k = weave * thread * (0.75 + dirt * 0.4);
        o[0] = base[0] * k; o[1] = base[1] * k; o[2] = base[2] * k;
        o[4] = weave * thread;
    });
    return { map: tex(c, true, true), normalMap: tex(normalFromHeight(height, S, S, 2.2, true), false, true) };
}

export function makeLeather() {
    const S = 256, base = hex(0x4a3020);
    const { canvas: c, height } = paintCanvas(S, S, (u, v, o) => {
        const n = fbm(u * 10, v * 10, 5, 10), cr = ridge(u * 5, v * 5, 3, 5);
        const k = 0.7 + n * 0.5 - smooth(0.9, 0.98, cr) * 0.3;
        o[0] = base[0] * k; o[1] = base[1] * k; o[2] = base[2] * k; o[4] = n + smooth(0.9, 0.98, cr) * -0.5;
    });
    return { map: tex(c, true, true), normalMap: tex(normalFromHeight(height, S, S, 2.5, true), false, true) };
}

// brushed + scratched steel; returns roughness and a blood-smeared colour map for the cleaver blade
export function makeSteel(bloody) {
    const S = 256;
    const rough = paintCanvas(S, S, (u, v, o) => {
        const brushed = vnoise(u * 2, v * 120, 0) * 0.5 + vnoise(u * 4, v * 240, 0) * 0.5;
        const scratch = smooth(0.93, 0.99, ridge(u * 6 + 3, v * 6, 2, 0));
        const r = 70 + brushed * 60 + scratch * 90 + fbm(u * 5, v * 5, 3, 0) * 40;
        o[0] = o[1] = o[2] = r;
    }).canvas;
    const col = paintCanvas(S, S, (u, v, o) => {
        const g = 200 + vnoise(u * 3, v * 90, 0) * 30 - fbm(u * 6, v * 6, 3, 0) * 40;
        let c = [g, g * 1.01, g * 1.04];
        if (bloody) {
            const smear = smooth(0.5, 0.75, fbm(u * 4 + 9, v * 2.5, 4, 0)) * smooth(0.45, 0.95, 1 - v);
            const dry = fbm(u * 20, v * 20, 2, 0);
            c = mixc(c, [110 + dry * 30, 12, 14], smear * 0.9);
        }
        const rust = smooth(0.7, 0.85, fbm(u * 7 + 2, v * 7 + 4, 4, 0)) * 0.35;
        c = mixc(c, [120, 72, 40], rust);
        o[0] = c[0]; o[1] = c[1]; o[2] = c[2];
    }).canvas;
    return { map: tex(col, true, false), roughnessMap: tex(rough, false, false) };
}

export function makeWood() {
    const S = 128, base = hex(0x5e3b22), lite = hex(0x8a5a34);
    const { canvas: c } = paintCanvas(S, S, (u, v, o) => {
        const grain = Math.sin((u * 40 + fbm(u * 2, v * 8, 4, 0) * 12)) * 0.5 + 0.5;
        const col = mixc(base, lite, grain * 0.6 + fbm(u * 6, v * 6, 3, 0) * 0.4);
        o[0] = col[0]; o[1] = col[1]; o[2] = col[2];
    });
    return tex(c, true, true);
}

// rock: lichen-spotted grey stone with cracks
export function makeRock() {
    const S = 512, P = 6;
    const a = hex(0x5f5c57), b = hex(0x858079), dark = hex(0x34322f), lichen = hex(0x5d6634);
    const { canvas: c, height } = paintCanvas(S, S, (u, v, o) => {
        const n = fbm(u * P, v * P, 6, P);
        const cr = ridge(u * 4 + 5, v * 4 + 1, 4, 4);
        const crack = smooth(0.88, 0.97, cr);
        let col = mixc(a, b, smooth(0.3, 0.75, n));
        col = mixc(col, lichen, smooth(0.66, 0.74, fbm(u * 9 + 3, v * 9 + 8, 4, 9)) * 0.3);
        col = mixc(col, dark, crack * 0.8);
        o[0] = col[0]; o[1] = col[1]; o[2] = col[2];
        o[4] = n - crack * 0.6;
    });
    return { map: tex(c, true, true), normalMap: tex(normalFromHeight(height, S, S, 4, true), false, true) };
}

export function makeBark() {
    const S = 256, base = hex(0x3d2b1f), lite = hex(0x6a4c35);
    const { canvas: c, height } = paintCanvas(S, S, (u, v, o) => {
        const r = ridge(u * 10, v * 2, 4, 0);
        const col = mixc(base, lite, r * 0.8 + fbm(u * 8, v * 8, 3, 0) * 0.2);
        o[0] = col[0]; o[1] = col[1]; o[2] = col[2]; o[4] = r;
    });
    return { map: tex(c, true, true), normalMap: tex(normalFromHeight(height, S, S, 3, true), false, true) };
}

// Ground colour for the whole field. groundAt(wx, wz) -> { arena, bank, h } describes the terrain; the map covers
// [-sx/2, sx/2] x [-sz/2, sz/2] in world units.
export function makeGround(sx, sz, info) {
    const w = 960, h = Math.round(960 * sz / sx);
    const grassA = hex(0x34522a), grassB = hex(0x55743a), dry = hex(0x7f7d4e), dirtA = hex(0x5a4936), dirtB = hex(0x7a6650),
        mud = hex(0x3a2e22), pebble = hex(0x9a9282);
    const { canvas: c } = paintCanvas(w, h, (u, v, o) => {
        const wx = (u - 0.5) * sx, wz = (v - 0.5) * sz, I = info(wx, wz);
        const n = fbm(wx * 0.18, wz * 0.18, 4, 0), n2 = fbm(wx * 1.3 + 40, wz * 1.3, 4, 0), fine = vnoise(wx * 9, wz * 9, 0);
        let col = mixc(grassA, grassB, smooth(0.3, 0.7, n));
        col = mixc(col, dry, smooth(0.6, 0.8, fbm(wx * 0.35 + 9, wz * 0.35 + 2, 4, 0)) * 0.5);
        // trodden arena: patchy dirt with grass tufts
        const trod = I.arena * smooth(0.25, 0.6, n2 * 0.7 + I.arena * 0.45);
        let dirt = mixc(dirtA, dirtB, smooth(0.3, 0.8, n2));
        dirt = mixc(dirt, pebble, smooth(0.78, 0.84, vnoise(wx * 5, wz * 5, 0)) * 0.6);
        col = mixc(col, dirt, trod);
        // wet riverbank mud
        col = mixc(col, mud, I.bank);
        const k = 0.88 + fine * 0.2;
        o[0] = col[0] * k; o[1] = col[1] * k; o[2] = col[2] * k;
    });
    return tex(c, true, false);
}

// small tiling normal map with pebbles + soil clumps (applied at a high repeat on top of the ground colour)
export function makeGroundDetail() {
    const S = 256;
    const { height } = paintCanvas(S, S, (u, v, o) => {
        const p = Math.pow(vnoise(u * 24, v * 24, 24), 3);
        o[4] = fbm(u * 8, v * 8, 5, 8) * 0.8 + p * 0.9;
    });
    return tex(normalFromHeight(height, S, S, 5, true), false, true);
}

// riverbed: wet stones and silt
export function makeRiverbed() {
    const S = 256;
    const { canvas: c } = paintCanvas(S, S, (u, v, o) => {
        const cells = vnoise(u * 18, v * 18, 18), n = fbm(u * 6, v * 6, 4, 6);
        const stone = smooth(0.55, 0.62, cells);
        const col = mixc([58, 52, 40], [110, 104, 92], stone * (0.6 + n * 0.4));
        o[0] = col[0]; o[1] = col[1]; o[2] = col[2];
    });
    return tex(c, true, true);
}

// alpha blood splat (white; tinted by material colour)
export function makeSplat(seed) {
    const S = 128, c = canvas(S, S), g = c.getContext('2d');
    let s = seed * 9301 + 49297;
    const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    const blob = (x, y, r, a) => {
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(0.7, `rgba(255,255,255,${a * 0.85})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    };
    blob(64, 64, 26 + rnd() * 10, 0.95);
    for (let i = 0; i < 14; i++) { const a = rnd() * Math.PI * 2, d = 18 + rnd() * 34; blob(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 3 + rnd() * 9, 0.9); }
    for (let i = 0; i < 4; i++) { // streaks
        const a = rnd() * Math.PI * 2; g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 2 + rnd() * 3; g.lineCap = 'round';
        g.beginPath(); g.moveTo(64 + Math.cos(a) * 20, 64 + Math.sin(a) * 20); g.lineTo(64 + Math.cos(a) * (40 + rnd() * 20), 64 + Math.sin(a) * (40 + rnd() * 20)); g.stroke();
    }
    return tex(c, true, false);
}

// soft round sprite (particles, blob shadows, glows)
export function makeSoftDot(inner) {
    const S = 64, c = canvas(S, S), g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(inner || 0.35, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    return tex(c, true, false);
}

// team banner cloth: team colour with a stitched emblem (shield for blue, skull-ish cleaver mark for red)
export function makeBanner(team) {
    const w = 128, h = 256, c = canvas(w, h), g = c.getContext('2d');
    const base = team === 0 ? ['#1e3a8a', '#2563eb'] : ['#7f1d1d', '#dc2626'];
    const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, base[1]); gr.addColorStop(1, base[0]);
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 1200; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.12})`; g.fillRect(Math.random() * w, Math.random() * h, 1, 2); }
    g.strokeStyle = '#e8c872'; g.lineWidth = 4; g.strokeRect(8, 8, w - 16, h - 40);
    // swallowtail notch is cut by alpha
    g.globalCompositeOperation = 'destination-out';
    g.beginPath(); g.moveTo(0, h); g.lineTo(w / 2, h - 34); g.lineTo(w, h); g.closePath(); g.fill();
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#e8c872';
    g.save(); g.translate(w / 2, 100);
    if (team === 0) { // shield
        g.beginPath(); g.moveTo(-26, -30); g.lineTo(26, -30); g.lineTo(26, 4); g.quadraticCurveTo(26, 30, 0, 42); g.quadraticCurveTo(-26, 30, -26, 4); g.closePath(); g.fill();
        g.fillStyle = base[0]; g.fillRect(-4, -22, 8, 52); g.fillRect(-18, -6, 36, 8);
    } else {     // crossed cleavers
        for (const s of [-1, 1]) { g.save(); g.rotate(s * 0.6); g.fillRect(-14, -36, 28, 34); g.fillRect(-3, -2, 6, 34); g.restore(); }
    }
    g.restore();
    return tex(c, true, false);
}
