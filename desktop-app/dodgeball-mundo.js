// desktop-app/dodgeball-mundo.js
// A procedural Dr. Mundo built from primitives: hierarchy of pivots (hips -> legs, spine -> neck/head, shoulders ->
// elbows -> hands) animated in code: run cycle from ground speed, overhead cleaver throw, hit flinch, death topple,
// double-biceps flex and idle breathing. The character faces +z and his right hand (cleaver hand) is on -x.
import * as THREE from 'three';

const CLEAVER_SCALE = 1.5;
export const MUNDO_SCALE = 1.3;     // whole body; the logic hitbox (UNIT_R) is sized to match
const ease = t => t * t * (3 - 2 * t);
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const wrapAngle = a => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

const EYE_COLORS = { player: 0xd9ff5c, iron: 0xe5e7eb, gold: 0xffcc33, diamond: 0x6fe3ff, challenger: 0xff6bff };

// ---- shared geometry + materials (one kit per scene) -----------------------------------------------------------------
export function createKit(T) {
    const g = {
        sphere: new THREE.SphereGeometry(1, 22, 15),
        sphereLo: new THREE.SphereGeometry(1, 14, 10),
        capsule: new THREE.CapsuleGeometry(1, 1, 6, 18),
        cyl: new THREE.CylinderGeometry(1, 1, 1, 20, 1),
        cylOpen: new THREE.CylinderGeometry(1, 1.08, 1, 20, 1, true),
        cone: new THREE.ConeGeometry(1, 1, 10),
        torus: new THREE.TorusGeometry(1, 0.14, 10, 32),
        box: new THREE.BoxGeometry(1, 1, 1),
        plate: new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 0.75, Math.PI * 0.05, Math.PI * 0.32),
        cleaver: makeCleaverGeometry()
    };
    const m = {
        skin: new THREE.MeshStandardMaterial({ map: T.skin.map, normalMap: T.skin.normalMap, normalScale: new THREE.Vector2(0.7, 0.7), roughnessMap: T.skin.roughnessMap, roughness: 0.82, metalness: 0 }),
        pants: new THREE.MeshStandardMaterial({ map: T.cloth.map, normalMap: T.cloth.normalMap, roughness: 0.95, metalness: 0 }),
        leather: new THREE.MeshStandardMaterial({ map: T.leather.map, normalMap: T.leather.normalMap, roughness: 0.7, metalness: 0 }),
        metal: new THREE.MeshStandardMaterial({ color: 0x9aa1aa, roughnessMap: T.steel.roughnessMap, roughness: 0.6, metalness: 0.95 }),
        plate: new THREE.MeshStandardMaterial({ color: 0x7c838c, roughnessMap: T.steel.roughnessMap, roughness: 0.85, metalness: 0.75 }),
        blade: new THREE.MeshStandardMaterial({ map: T.bloodSteel.map, roughnessMap: T.bloodSteel.roughnessMap, roughness: 0.55, metalness: 0.95 }),
        wood: new THREE.MeshStandardMaterial({ map: T.wood, roughness: 0.8 }),
        rubber: new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.55, metalness: 0.1 }),
        glass: new THREE.MeshStandardMaterial({ color: 0xd8fff0, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.28, depthWrite: false }),
        chem: new THREE.MeshStandardMaterial({ color: 0x4dff3a, emissive: 0x3dff2a, emissiveIntensity: 2.4, roughness: 0.3 }),
        teeth: new THREE.MeshStandardMaterial({ color: 0xe9dfc4, roughness: 0.45 }),
        mouth: new THREE.MeshStandardMaterial({ color: 0x2a0d12, roughness: 0.9 }),
        team: [
            new THREE.MeshStandardMaterial({ map: T.cloth.map, normalMap: T.cloth.normalMap, color: 0x4d8bff, roughness: 0.9 }),
            new THREE.MeshStandardMaterial({ map: T.cloth.map, normalMap: T.cloth.normalMap, color: 0xff4d4d, roughness: 0.9 })
        ],
        ring: [
            new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
            new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })
        ],
        blob: new THREE.MeshBasicMaterial({ map: T.softDot, color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false })
    };
    g.ring = new THREE.RingGeometry(0.78, 0.9, 64).rotateX(-Math.PI / 2);
    g.ringTicks = makeRingTicks();
    g.blob = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    return { g, m };
}

// cleaver: extruded blade (with hang hole) + wooden handle + rivets, merged per material into a small group template.
// Local frame: blade along +x, spine edge up (+y), handle along -x; origin at the blade/handle joint.
function makeCleaverGeometry() {
    const s = new THREE.Shape();
    s.moveTo(0, -0.12);
    s.lineTo(0.47, -0.135);
    s.quadraticCurveTo(0.53, -0.13, 0.52, -0.06);
    s.lineTo(0.5, 0.11);
    s.quadraticCurveTo(0.49, 0.145, 0.45, 0.145);
    s.lineTo(0.02, 0.135);
    s.quadraticCurveTo(-0.01, 0.13, 0, 0.09);
    s.closePath();
    const hole = new THREE.Path(); hole.absarc(0.43, 0.085, 0.032, 0, Math.PI * 2, true); s.holes.push(hole);
    const blade = new THREE.ExtrudeGeometry(s, { depth: 0.018, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2, curveSegments: 12 });
    blade.translate(0, 0, -0.009);
    // remap UVs to 0..1 across the blade so the blood smear texture lands on it
    const uv = blade.attributes.uv, pos = blade.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (pos.getX(i) + 0.01) / 0.55, (pos.getY(i) + 0.14) / 0.3);
    const handle = new THREE.CylinderGeometry(0.03, 0.034, 0.3, 12).rotateZ(Math.PI / 2).translate(-0.15, 0.085, 0);
    const pommel = new THREE.SphereGeometry(0.038, 10, 8).translate(-0.3, 0.085, 0);
    const bolster = new THREE.CylinderGeometry(0.036, 0.036, 0.03, 12).rotateZ(Math.PI / 2).translate(-0.01, 0.085, 0);
    const rivets = [-0.08, -0.2].map(x => new THREE.CylinderGeometry(0.009, 0.009, 0.075, 8).rotateX(Math.PI / 2).translate(x, 0.085, 0));
    return { blade, handle, pommel, bolster, rivets };
}

function makeRingTicks() { // four short chevrons around the selection ring
    const shape = new THREE.Shape();
    shape.moveTo(-0.09, 0); shape.lineTo(0.09, 0); shape.lineTo(0, 0.12); shape.closePath();
    const parts = [];
    for (let i = 0; i < 4; i++) {
        const g = new THREE.ShapeGeometry(shape);
        g.translate(0, 0.94, 0); g.rotateZ(i * Math.PI / 2 + Math.PI / 4);
        parts.push(g);
    }
    const merged = mergeSimple(parts);
    merged.rotateX(-Math.PI / 2);
    return merged;
}
function mergeSimple(geos) { // non-indexed merge of position-only geometries
    let n = 0; const flat = geos.map(g => g.toNonIndexed()); flat.forEach(g => (n += g.attributes.position.count));
    const pos = new Float32Array(n * 3); let o = 0;
    for (const g of flat) { pos.set(g.attributes.position.array, o); o += g.attributes.position.array.length; }
    const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return out;
}

export function buildCleaver(kit) {
    const { g, m } = kit, grp = new THREE.Group();
    const add = (geo, mat) => { const me = new THREE.Mesh(geo, mat); me.castShadow = true; grp.add(me); return me; };
    add(g.cleaver.blade, m.blade);
    add(g.cleaver.handle, m.wood);
    add(g.cleaver.pommel, m.metal);
    add(g.cleaver.bolster, m.metal);
    g.cleaver.rivets.forEach(r => add(r, m.metal));
    grp.scale.setScalar(CLEAVER_SCALE);
    return grp;
}

// fresnel rim in the team colour so silhouettes read from the top-down camera
function addRim(mat, hex) {
    const rim = { value: new THREE.Color(hex) };
    mat.userData.rim = rim; mat.userData.rimBase = rim.value.clone();
    mat.onBeforeCompile = sh => {
        sh.uniforms.uRim = rim;
        sh.fragmentShader = sh.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform vec3 uRim;')
            .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
                float rimF = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
                totalEmissiveRadiance += uRim * rimF * 0.4;`);
    };
    mat.customProgramCacheKey = () => 'mundo-rim';
}

// ---- the character ---------------------------------------------------------------------------------------------------
export class Mundo {
    constructor(kit, team, tier) {
        const { g, m } = kit;
        this.kit = kit; this.team = team;
        this.skin = m.skin.clone();                      // own copy: hit flashes tint it
        addRim(this.skin, team === 0 ? 0x5b8dff : 0xff5a4a);
        this.eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: EYE_COLORS[tier] || EYE_COLORS.player, emissiveIntensity: 3.2 });
        this.chem = m.chem.clone();
        const skin = this.skin, teamMat = m.team[team];

        const mesh = (geo, mat, parent, pos, scl, rot) => {
            const me = new THREE.Mesh(geo, mat);
            if (pos) me.position.set(pos[0], pos[1], pos[2]);
            if (scl) me.scale.set(scl[0], scl[1], scl[2]);
            if (rot) me.rotation.set(rot[0], rot[1], rot[2]);
            me.castShadow = true; me.receiveShadow = true;
            parent.add(me); return me;
        };
        const pivot = (parent, pos) => { const p = new THREE.Group(); p.position.set(pos[0], pos[1], pos[2]); parent.add(p); return p; };

        this.root = new THREE.Group();
        // ground decorations (do not rotate with the body)
        this.blob = new THREE.Mesh(g.blob, m.blob); this.blob.scale.set(2.8, 1, 2.8); this.blob.position.y = 0.025; this.blob.renderOrder = 1;
        this.ring = new THREE.Mesh(g.ring, m.ring[team]); this.ring.position.y = 0.04; this.ring.renderOrder = 2;
        this.ticks = new THREE.Mesh(g.ringTicks, m.ring[team]); this.ticks.position.y = 0.045; this.ticks.renderOrder = 2;
        this.root.add(this.blob, this.ring, this.ticks);

        this.yaw = new THREE.Group(); this.yaw.scale.setScalar(MUNDO_SCALE); this.root.add(this.yaw);
        this.fall = new THREE.Group(); this.yaw.add(this.fall);
        const hips = this.hips = pivot(this.fall, [0, 1.08, 0]);

        // pelvis, trousers, belt
        mesh(g.sphere, m.pants, hips, [0, 0.0, 0], [0.46, 0.3, 0.36]);
        mesh(g.torus, m.leather, hips, [0, 0.13, 0], [0.42, 0.35, 0.42], [Math.PI / 2, 0, 0]).scale.set(0.43, 0.36, 2.2);
        mesh(g.box, m.metal, hips, [0, 0.13, 0.37], [0.15, 0.12, 0.04]);
        // a couple of syringes clipped to the belt
        for (const sx of [-0.3, 0.26]) {
            const syr = pivot(hips, [sx, 0.1, 0.27]); syr.rotation.set(0.2, 0, sx > 0 ? -0.35 : 0.3);
            mesh(g.cyl, m.glass, syr, [0, -0.1, 0], [0.035, 0.2, 0.035]);
            mesh(g.cyl, this.chem, syr, [0, -0.12, 0], [0.026, 0.14, 0.026]);
            mesh(g.cyl, m.metal, syr, [0, -0.25, 0], [0.006, 0.12, 0.006]);
        }

        // legs
        this.legs = [-1, 1].map(side => {
            const thigh = pivot(hips, [side * 0.24, -0.04, 0]);
            mesh(g.capsule, m.pants, thigh, [0, -0.25, 0], [0.2, 0.3, 0.21]);
            const knee = pivot(thigh, [0, -0.5, 0]);
            mesh(g.cylOpen, m.pants, knee, [0, -0.02, 0], [0.19, 0.14, 0.19]);   // ragged cuff
            mesh(g.capsule, skin, knee, [0, -0.22, 0.01], [0.15, 0.28, 0.16]);
            mesh(g.sphere, skin, knee, [0, -0.12, -0.06], [0.13, 0.17, 0.13]);   // calf
            const ankle = pivot(knee, [0, -0.46, 0]);
            mesh(g.sphere, skin, ankle, [0, -0.04, 0.09], [0.15, 0.08, 0.25]);
            for (let i = -1; i <= 1; i++) mesh(g.sphereLo, skin, ankle, [i * 0.065, -0.06, 0.31], [0.045, 0.04, 0.05]);
            return { thigh, knee, ankle, side };
        });

        // torso
        const spine = this.spine = pivot(hips, [0, 0.1, 0]);
        mesh(g.sphere, skin, spine, [0, 0.22, 0.08], [0.46, 0.4, 0.42]);           // belly
        this.chest = pivot(spine, [0, 0.62, 0]);
        mesh(g.sphere, skin, this.chest, [0, 0, 0], [0.64, 0.47, 0.45]);
        for (const sx of [-1, 1]) mesh(g.sphere, skin, this.chest, [sx * 0.21, 0.03, 0.28], [0.27, 0.2, 0.17]); // pecs
        mesh(g.sphere, skin, spine, [0, 0.9, -0.12], [0.52, 0.3, 0.38]);           // trapezius hump
        // chest strap (harness for the chem tank)
        mesh(g.box, m.leather, this.chest, [0.05, 0.02, 0.4], [0.09, 0.95, 0.04], [0.15, 0, -0.62]);
        mesh(g.box, m.metal, this.chest, [0.05, 0.02, 0.43], [0.08, 0.06, 0.02], [0.15, 0, -0.62]);

        // chem tank on the back
        const tank = pivot(spine, [0, 0.66, -0.5]); tank.rotation.x = -0.18;
        mesh(g.cyl, m.glass, tank, [0, 0, 0], [0.18, 0.72, 0.18]);
        this.liquid = mesh(g.cyl, this.chem, tank, [0, -0.04, 0], [0.145, 0.58, 0.145]);
        for (const y of [-0.38, 0.38]) mesh(g.cyl, m.metal, tank, [0, y, 0], [0.2, 0.08, 0.2]);
        mesh(g.torus, m.metal, tank, [0, 0, 0], [0.19, 0.19, 0.4], [Math.PI / 2, 0, 0]);
        mesh(g.cyl, m.metal, tank, [0, 0.45, 0], [0.06, 0.08, 0.06]);
        // rubber tubes from the tank cap into the shoulders
        for (const sx of [-1, 1]) {
            const curve = new THREE.CatmullRomCurve3([
                new THREE.Vector3(sx * 0.04, 1.1, -0.48), new THREE.Vector3(sx * 0.2, 1.22, -0.36),
                new THREE.Vector3(sx * 0.38, 1.12, -0.2), new THREE.Vector3(sx * 0.5, 0.92, -0.06)
            ]);
            mesh(new THREE.TubeGeometry(curve, 16, 0.032, 8, false), m.rubber, spine);
        }

        // neck + head
        this.neck = pivot(spine, [0, 0.98, 0.2]);
        mesh(g.cyl, skin, this.neck, [0, 0.04, 0], [0.19, 0.2, 0.19]);
        const head = this.head = pivot(this.neck, [0, 0.12, 0.02]);
        mesh(g.sphere, skin, head, [0, 0.2, -0.02], [0.2, 0.22, 0.22]);           // cranium
        mesh(g.sphere, skin, head, [0, 0.27, 0.09], [0.21, 0.075, 0.13]);         // brow ridge
        this.jaw = pivot(head, [0, 0.08, 0.02]);
        mesh(g.sphere, skin, this.jaw, [0, -0.05, 0.06], [0.27, 0.14, 0.24]);     // the jaw
        mesh(g.box, m.mouth, this.jaw, [0, 0.0, 0.27], [0.24, 0.035, 0.06]);
        for (const sx of [-1, 1]) mesh(g.cone, m.teeth, this.jaw, [sx * 0.085, 0.045, 0.255], [0.026, 0.075, 0.026]); // tusks
        for (let i = -2; i <= 2; i++) if (Math.abs(i) !== 2) mesh(g.box, m.teeth, this.jaw, [i * 0.03, 0.012, 0.268], [0.022, 0.026, 0.02]);
        for (const sx of [-1, 1]) {
            mesh(g.sphereLo, this.eyeMat, head, [sx * 0.075, 0.215, 0.185], [0.03, 0.026, 0.02]);
            mesh(g.sphereLo, skin, head, [sx * 0.2, 0.17, 0.0], [0.04, 0.06, 0.035]);   // ears
        }
        // riveted plate on the skull
        const plateG = pivot(head, [0, 0.2, -0.02]); plateG.rotation.set(0.15, 0.2, -0.35);
        mesh(g.plate, m.plate, plateG, [0, 0, 0], [0.215, 0.235, 0.228]);
        for (const a of [0.35, 1.05, 1.75]) mesh(g.sphereLo, m.metal, plateG, [Math.cos(a) * 0.15, 0.15, -Math.sin(a) * 0.15], [0.018, 0.018, 0.018]);

        // arms: index 0 = right (cleaver hand, -x), 1 = left
        this.arms = [-1, 1].map(side => {
            const shoulder = pivot(spine, [side * 0.64, 0.8, 0.0]);
            mesh(g.sphere, skin, shoulder, [0, 0, 0], [0.28, 0.27, 0.27]);                       // deltoid
            mesh(g.capsule, skin, shoulder, [0, -0.3, 0], [0.17, 0.3, 0.17]);
            mesh(g.sphere, skin, shoulder, [0, -0.28, 0.08], [0.15, 0.2, 0.14]);                 // bicep
            mesh(g.torus, teamMat, shoulder, [0, -0.13, 0], [0.19, 0.19, 0.9], [Math.PI / 2, 0, 0]);
            const elbow = pivot(shoulder, [0, -0.56, 0]);
            mesh(g.capsule, skin, elbow, [0, -0.25, 0.01], [0.21, 0.26, 0.22]);                 // forearm (huge)
            mesh(g.cyl, teamMat, elbow, [0, -0.43, 0.01], [0.2, 0.14, 0.2]);                   // wrist wraps
            const hand = pivot(elbow, [0, -0.54, 0.01]);
            mesh(g.sphere, skin, hand, [0, -0.04, 0.01], [0.16, 0.17, 0.17]);
            for (let i = -1; i <= 1; i++) mesh(g.sphereLo, skin, hand, [i * 0.07, -0.12, 0.09], [0.05, 0.05, 0.06]); // knuckles
            return { shoulder, elbow, hand, side };
        });
        // the cleaver in the right fist
        this.held = buildCleaver(kit);
        this.held.rotation.y = -Math.PI / 2;
        this.held.position.set(0, -0.06 - 0.085 * CLEAVER_SCALE, 0.15 * CLEAVER_SCALE);
        this.heldWrap = pivot(this.arms[0].hand, [0, 0, 0]);
        this.heldWrap.rotation.x = 0.35;
        this.heldWrap.add(this.held);

        // state
        this.t = Math.random() * 10; this.phase = 0; this.speed = 0; this.lastX = null; this.lastZ = null;
        this.yawAngle = team === 0 ? Math.PI / 2 : -Math.PI / 2;
        this.throwT = 99; this.hurtT = 99; this.deathT = -1; this.flexT = 99; this.flashT = 99; this.heldScale = 1;
        this.hurtDir = 0; this.stepSign = 0; this.onStep = null;
    }

    triggerThrow(angle) { this.throwT = 0; this.heldScale = 0; this.yawAngle = Math.PI / 2 - angle; }
    triggerHurt() { this.hurtT = 0; }
    triggerDeath() { if (this.deathT < 0) this.deathT = 0; }
    triggerFlex() { this.flexT = 0; }
    triggerFlash() { this.flashT = 0; }
    get dead() { return this.deathT >= 0; }

    // st: { x, z, y, face, ready (cleaver ready) }
    update(dt, st) {
        this.t += dt;
        const r = this.root;
        if (this.lastX == null) { this.lastX = st.x; this.lastZ = st.z; }
        const moved = Math.hypot(st.x - this.lastX, st.z - this.lastZ);
        this.lastX = st.x; this.lastZ = st.z;
        const inst = dt > 0 && moved < 2.5 ? moved / dt : 0; // ignore flash teleports
        this.speed += (inst - this.speed) * Math.min(1, dt * 10);
        r.position.set(st.x, st.y, st.z);

        // facing
        if (!this.dead) {
            const target = Math.PI / 2 - st.face;
            this.yawAngle += wrapAngle(target - this.yawAngle) * Math.min(1, dt * (this.throwT < 0.3 ? 30 : 12));
        }
        this.yaw.rotation.y = this.yawAngle;

        const move = this.dead ? 0 : ease(clamp01(this.speed / 6));
        const prevPhase = this.phase;
        this.phase += Math.min(this.speed, 9) * dt * 1.7;
        const s = Math.sin(this.phase), c = Math.cos(this.phase);
        if (this.onStep && move > 0.3 && Math.sign(Math.sin(prevPhase)) !== Math.sign(s)) this.onStep();
        const breathe = Math.sin(this.t * 2.1);

        // ---- base pose: idle + run cycle
        this.hips.position.y = 1.08 - 0.07 * move + Math.abs(s) * 0.1 * move + breathe * 0.005;
        this.hips.rotation.set(0, s * 0.12 * move, 0);
        this.spine.rotation.set(0.26 + 0.14 * move, -s * 0.18 * move, c * 0.03 * move);
        this.chest.scale.setScalar(1 + breathe * 0.018);
        this.neck.rotation.set(-0.2 - 0.1 * move, 0, 0);
        this.head.rotation.set(0, 0, 0);
        this.jaw.rotation.x = 0.03 + Math.max(0, breathe) * 0.03;
        for (const L of this.legs) {
            const ph = L.side < 0 ? s : -s, kc = L.side < 0 ? c : -c;
            L.thigh.rotation.set(-ph * 0.8 * move - 0.05, 0, L.side * 0.06);
            L.knee.rotation.set(Math.max(0, kc) * 1.25 * move + 0.08 + 0.15 * move, 0, 0);
            L.ankle.rotation.set(-0.1 * move + Math.max(0, -kc) * 0.3 * move, 0, 0);
        }
        for (const A of this.arms) {
            const ph = A.side < 0 ? s : -s;   // opposite to the same-side leg
            A.shoulder.rotation.set(ph * 0.6 * move + 0.05, 0, A.side * (0.22 + 0.015 * breathe));
            A.elbow.rotation.set(-0.45 - 0.35 * move + (ph < 0 ? -0.25 : 0) * move, 0, 0);
            A.hand.rotation.set(-0.1, 0, 0);
        }

        // ---- overlays: throw, flex, hurt, flash
        if (this.throwT < 0.6) {
            this.throwT += dt;
            const t = this.throwT, R = this.arms[0];
            let sh, el, tw, hunch;
            if (t < 0.06) { const k = ease(t / 0.06); sh = lerp(0, 2.6, k); el = lerp(-0.45, -1.7, k); tw = lerp(0, -0.45, k); hunch = 0; }
            else if (t < 0.19) { const k = ease((t - 0.06) / 0.13); sh = lerp(2.6, -1.35, k); el = lerp(-1.7, -0.15, k); tw = lerp(-0.45, 0.4, k); hunch = 0.2 * k; }
            else { const k = ease(clamp01((t - 0.19) / 0.38)); sh = lerp(-1.35, 0, k); el = lerp(-0.15, -0.45, k); tw = lerp(0.4, 0, k); hunch = lerp(0.2, 0, k); }
            R.shoulder.rotation.x = sh;       // + = up and back (wind-up), - = forward (release)
            R.shoulder.rotation.z = -0.32;
            R.elbow.rotation.x = el;
            this.spine.rotation.y += tw;
            this.spine.rotation.x += hunch;
            this.arms[1].shoulder.rotation.x = lerp(this.arms[1].shoulder.rotation.x, -0.5, clamp01(1 - Math.abs(t - 0.15) * 4)); // counter arm
        }
        if (this.flexT < 1.8) {
            this.flexT += dt;
            const t = this.flexT, w = ease(clamp01(t / 0.25)) * ease(clamp01((1.8 - t) / 0.35));
            for (const A of this.arms) {
                const side = A.side;
                A.shoulder.rotation.x = lerp(A.shoulder.rotation.x, 0.15, w);
                A.shoulder.rotation.z = lerp(A.shoulder.rotation.z, side * 1.55, w);              // upper arm out level
                A.elbow.rotation.x = lerp(A.elbow.rotation.x, 0, w);
                A.elbow.rotation.z = lerp(0, side * (1.45 + 0.08 * Math.sin(t * 16)), w);          // forearm up: double biceps
            }
            this.spine.rotation.x = lerp(this.spine.rotation.x, 0.05, w);
            this.neck.rotation.x = lerp(this.neck.rotation.x, -0.45, w);
            this.jaw.rotation.x = lerp(this.jaw.rotation.x, 0.35, w * (0.5 + 0.5 * Math.sin(t * 9)));
        } else {
            for (const A of this.arms) A.elbow.rotation.z = 0;
        }
        if (this.hurtT < 0.35) {
            this.hurtT += dt;
            const k = Math.sin(clamp01(this.hurtT / 0.35) * Math.PI);
            this.spine.rotation.x -= 0.45 * k;
            this.neck.rotation.x -= 0.35 * k;
            this.jaw.rotation.x += 0.3 * k;
            this.skin.emissive.setRGB(0.85 * k, 0.06 * k, 0.06 * k);
        } else this.skin.emissive.setRGB(0, 0, 0);
        if (this.flashT < 0.3) {
            this.flashT += dt;
            const k = clamp01(this.flashT / 0.3);
            this.fall.scale.set(1 + (1 - k) * 0.25, 0.7 + 0.3 * ease(k), 1 + (1 - k) * 0.25);
            this.skin.emissive.setRGB(0.9 * (1 - k), 0.85 * (1 - k), 0.4 * (1 - k));
        } else this.fall.scale.set(1, 1, 1);

        // cleaver in hand: hidden after a throw, pops back when ready
        const wantHeld = st.ready && this.throwT > 0.15;
        this.heldScale = wantHeld ? Math.min(1, this.heldScale + dt * 7) : 0;
        this.held.visible = this.heldScale > 0.01;
        this.held.scale.setScalar(CLEAVER_SCALE * ease(this.heldScale));

        // chem tank glow
        const pulse = 2.0 + Math.sin(this.t * 3.1) * 0.6;
        this.chem.emissiveIntensity = this.dead ? Math.max(0, pulse * (1 - this.deathT)) : pulse;
        this.liquid.scale.y = 0.58 + Math.sin(this.t * 2.3) * 0.015;

        // ring
        const ringK = this.dead ? Math.max(0, 1 - this.deathT * 2) : 1;
        this.ring.visible = this.ticks.visible = ringK > 0;
        this.ring.scale.setScalar(1.15 * ringK * (1 + Math.sin(this.t * 4) * 0.015));
        this.ticks.scale.setScalar(1.15 * ringK);
        this.ticks.rotation.y = this.t * 0.8;

        // ---- death: topple backwards like a felled tree, bounce, then sink
        if (this.dead) {
            this.deathT += dt;
            const t = this.deathT;
            const fallK = ease(clamp01(t / 0.75));
            const bounce = t > 0.75 ? Math.sin(Math.min(1, (t - 0.75) / 0.25) * Math.PI) * 0.12 * Math.max(0, 1 - (t - 0.75) * 2) : 0;
            this.fall.rotation.x = -fallK * 1.48 + bounce;
            for (const A of this.arms) { A.shoulder.rotation.z = A.side * lerp(0.22, 1.3, fallK); A.shoulder.rotation.x = -0.6 * fallK; }
            for (const L of this.legs) L.thigh.rotation.x = -0.25 * fallK;
            this.neck.rotation.x = -0.5 * fallK;
            this.jaw.rotation.x = 0.4 * fallK;
            this.eyeMat.emissiveIntensity = Math.max(0, 3.2 * (1 - t * 1.5));
            this.skin.userData.rim.value.copy(this.skin.userData.rimBase).multiplyScalar(Math.max(0, 1 - t * 2.5));
            r.position.y = st.y - Math.max(0, t - 1.6) * 0.9;
        } else {
            this.fall.rotation.x = 0;
        }
    }

    dispose() {
        this.root.removeFromParent();
        this.skin.dispose(); this.eyeMat.dispose(); this.chem.dispose();
        this.root.traverse(o => { if (o.isMesh && o.geometry && o.geometry.type === 'TubeGeometry') o.geometry.dispose(); });
    }
}
