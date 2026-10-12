// desktop-app/dodgeball-scene.js
// The 3D world for Mundo Dodgeball (three.js). Owns the renderer, camera, terrain, water, foliage, props, Mundos,
// cleavers, particles and post-processing. The view feeds it the game state every frame (sync) plus game events
// (onEvent); it never changes game state. Logical arena coordinates (x right, y down, 1280 x 720) map onto the ground
// plane as world x = (x - 640) / 40, world z = (y - 360) / 40, so the arena is 32 x 18 units with the river on x = 0.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import * as TX from './dodgeball-textures.js';
import { createKit, Mundo, buildCleaver } from './dodgeball-mundo.js';
import { W, H, RIVER } from './dodgeball-game.js';

const K = 1 / 40;
export const wx = x => (x - W / 2) * K;
export const wz = y => (y - H / 2) * K;
const AX = W / 2 * K, AZ = H / 2 * K, RW = RIVER * K;   // 16, 9, 1.15
const SX = 84, SZ = 56;                                   // terrain size
const WATER_Y = -0.34, CLEAVER_Y = 1.9;
export const AIM_Y = 1.6;                                 // cursor aim plane (chest height): clicking a Mundo's body aims at him

const rand = (a, b) => a + Math.random() * (b - a);
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };

// ---- terrain ---------------------------------------------------------------------------------------------------------
function terrainInfo(x, z) {
    const ox = Math.max(0, Math.abs(x) - AX), oz = Math.max(0, Math.abs(z) - AZ);
    const out = Math.hypot(ox, oz);
    return { out, arena: 1 - smooth(0, 1.8, out), bank: 1 - smooth(RW + 0.15, RW + 1.0, Math.abs(x)) };
}
export function heightAt(x, z) {
    const I = terrainInfo(x, z), ax = Math.abs(x);
    let h = (TX.fbm(x * 0.35 + 10, z * 0.35 + 50, 3) - 0.5) * 0.07 * I.arena;
    const valley = smooth(RW + 0.6, RW + 6, ax);                       // the river cuts a valley through the hills
    const hill = (smooth(0.6, 10, I.out) * (z < 0 ? 4.2 : 1.4) + smooth(9, 22, I.out) * 8) * (0.55 + TX.fbm(x * 0.09 + 3, z * 0.09 + 5, 4) * 0.9) * valley;
    h += hill + (TX.fbm(x * 0.45 + 7, z * 0.45 + 3, 3) - 0.5) * 0.35 * (1 - I.arena);
    const ch = 1 - smooth(RW - 0.3, RW + 0.7, ax);                     // river channel
    return h * (1 - ch) + (-0.95 + (TX.fbm(x * 2 + 1, z * 0.7, 2) - 0.5) * 0.18) * ch;
}

// ---- small shader helpers --------------------------------------------------------------------------------------------
const NOISE_GLSL = `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.-2.*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y); }
`;

// ---- particles -------------------------------------------------------------------------------------------------------
class Particles {
    constructor(max, blending, tex) {
        this.max = max; this.n = 0;
        this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 3); this.size = new Float32Array(max); this.alpha = new Float32Array(max);
        this.vel = new Float32Array(max * 3); this.c0 = new Float32Array(max * 3); this.c1 = new Float32Array(max * 3);
        this.life = new Float32Array(max); this.life0 = new Float32Array(max); this.s0 = new Float32Array(max); this.s1 = new Float32Array(max);
        this.a0 = new Float32Array(max); this.grav = new Float32Array(max); this.drag = new Float32Array(max); this.flags = new Uint8Array(max);
        const geo = new THREE.BufferGeometry();
        const mk = (arr, n) => { const a = new THREE.BufferAttribute(arr, n); a.setUsage(THREE.DynamicDrawUsage); return a; };
        geo.setAttribute('position', mk(this.pos, 3)); geo.setAttribute('aColor', mk(this.col, 3));
        geo.setAttribute('aSize', mk(this.size, 1)); geo.setAttribute('aAlpha', mk(this.alpha, 1));
        geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
        this.mat = new THREE.ShaderMaterial({
            uniforms: { uTex: { value: tex }, uScale: { value: 600 } },
            vertexShader: `attribute float aSize; attribute float aAlpha; attribute vec3 aColor; uniform float uScale;
                varying vec3 vColor; varying float vAlpha;
                void main(){ vColor = aColor; vAlpha = aAlpha; vec4 mv = modelViewMatrix * vec4(position, 1.0);
                  gl_PointSize = aSize * uScale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }`,
            fragmentShader: `uniform sampler2D uTex; varying vec3 vColor; varying float vAlpha;
                void main(){ vec4 t = texture2D(uTex, gl_PointCoord); float a = t.a * vAlpha; if (a < 0.003) discard;
                  gl_FragColor = vec4(vColor * t.rgb, a); }`,
            transparent: true, depthWrite: false, blending
        });
        this.points = new THREE.Points(geo, this.mat);
        this.points.frustumCulled = false;
        this.points.renderOrder = blending === THREE.AdditiveBlending ? 6 : 5;
        this.geo = geo;
    }
    // o: x y z vx vy vz life size size1 color color1 alpha grav drag flags
    emit(o) {
        if (this.n >= this.max) return;
        const i = this.n++, i3 = i * 3;
        this.pos[i3] = o.x; this.pos[i3 + 1] = o.y; this.pos[i3 + 2] = o.z;
        this.vel[i3] = o.vx || 0; this.vel[i3 + 1] = o.vy || 0; this.vel[i3 + 2] = o.vz || 0;
        const c = o.color, c1 = o.color1 || o.color;
        this.c0[i3] = c.r; this.c0[i3 + 1] = c.g; this.c0[i3 + 2] = c.b;
        this.c1[i3] = c1.r; this.c1[i3 + 1] = c1.g; this.c1[i3 + 2] = c1.b;
        this.life[i] = this.life0[i] = o.life; this.s0[i] = o.size; this.s1[i] = o.size1 == null ? o.size : o.size1;
        this.a0[i] = o.alpha == null ? 1 : o.alpha; this.grav[i] = o.grav || 0; this.drag[i] = o.drag || 0; this.flags[i] = o.flags || 0;
    }
    update(dt, ground, onLand) {
        let i = 0;
        while (i < this.n) {
            this.life[i] -= dt;
            const i3 = i * 3;
            if (this.life[i] <= 0) { this.kill(i); continue; }
            const d = Math.max(0, 1 - this.drag[i] * dt);
            this.vel[i3] *= d; this.vel[i3 + 1] = this.vel[i3 + 1] * d + this.grav[i] * dt; this.vel[i3 + 2] *= d;
            this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += this.vel[i3 + 1] * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
            if (this.flags[i] & 1) { // collides with the ground
                const gy = ground(this.pos[i3], this.pos[i3 + 2]);
                if (this.pos[i3 + 1] < gy) {
                    if (onLand && (this.flags[i] & 2)) onLand(this.pos[i3], gy, this.pos[i3 + 2]);
                    this.kill(i); continue;
                }
            }
            const k = 1 - this.life[i] / this.life0[i];
            this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * k;
            this.alpha[i] = this.a0[i] * (k < 0.1 ? k / 0.1 : 1) * (1 - Math.pow(k, 2.2));
            this.col[i3] = this.c0[i3] + (this.c1[i3] - this.c0[i3]) * k;
            this.col[i3 + 1] = this.c0[i3 + 1] + (this.c1[i3 + 1] - this.c0[i3 + 1]) * k;
            this.col[i3 + 2] = this.c0[i3 + 2] + (this.c1[i3 + 2] - this.c0[i3 + 2]) * k;
            i++;
        }
        this.geo.setDrawRange(0, this.n);
        for (const a of ['position', 'aColor', 'aSize', 'aAlpha']) this.geo.attributes[a].needsUpdate = true;
    }
    kill(i) {
        const j = --this.n;
        if (i === j) return;
        const cp3 = arr => { arr[i * 3] = arr[j * 3]; arr[i * 3 + 1] = arr[j * 3 + 1]; arr[i * 3 + 2] = arr[j * 3 + 2]; };
        cp3(this.pos); cp3(this.vel); cp3(this.c0); cp3(this.c1); cp3(this.col);
        for (const a of [this.life, this.life0, this.s0, this.s1, this.a0, this.grav, this.drag, this.flags, this.size, this.alpha]) a[i] = a[j];
    }
    clear() { this.n = 0; this.geo.setDrawRange(0, 0); }
}

// ---- the scene -------------------------------------------------------------------------------------------------------
export class DodgeballScene {
    constructor(canvas, quality) {
        this.canvas = canvas;
        this.quality = quality === 'low' ? 'low' : 'high';
        const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
        r.outputColorSpace = THREE.SRGBColorSpace;
        r.toneMapping = THREE.ACESFilmicToneMapping;
        r.toneMappingExposure = 1.0;
        r.shadowMap.enabled = true;
        r.shadowMap.type = THREE.PCFShadowMap;

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(34, 16 / 9, 0.5, 600);
        this.clock = 0;
        this.shake = 0; this.zoomPunch = 0; this.flashWhite = 0; this.damage = 0; this.lowHp = 0;
        this.camBase = new THREE.Vector3(); this.camTarget = new THREE.Vector3(0, 0, 0.9);
        this.raycaster = new THREE.Raycaster();
        this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        this.tmpV = new THREE.Vector3();
        this.cssW = 1; this.cssH = 1;

        this.mundos = new Map();          // unit id -> { m: Mundo, unit, spawnT, landed, gone }
        this.flying = new Map();          // cleaver id -> { obj, trail, hist }
        this.dropped = [];                // falling / stuck cleavers
        this.decals = []; this.rings = []; this.ripples = [];

        this.buildTextures();
        this.kit = createKit(this.T);
        this.buildLights();
        this.buildSky();
        this.buildTerrain();
        this.buildWater();
        this.buildRocks();
        this.buildTrees();
        this.buildGrass();
        this.buildProps();
        this.buildFx();
        this.buildIndicators();
        this.buildPost();
        this.applyQuality();
    }

    // ---- construction ------------------------------------------------------------------------------------------------
    buildTextures() {
        this.T = {
            skin: TX.makeSkin(), cloth: TX.makeCloth(0x3c4352), leather: TX.makeLeather(),
            steel: TX.makeSteel(false), bloodSteel: TX.makeSteel(true), wood: TX.makeWood(),
            rock: TX.makeRock(), bark: TX.makeBark(), softDot: TX.makeSoftDot(0.35), spark: TX.makeSoftDot(0.12),
            splats: [1, 2, 3, 4].map(TX.makeSplat), banners: [TX.makeBanner(0), TX.makeBanner(1)],
            ground: TX.makeGround(SX, SZ, terrainInfo), groundDetail: TX.makeGroundDetail()
        };
        this.T.groundDetail.repeat.set(SX / 2.2, SZ / 2.2);
        this.T.rock.map.repeat.set(2, 2); this.T.rock.normalMap.repeat.set(2, 2);
        this.T.skin.map.repeat.set(1.5, 1.5); this.T.skin.normalMap.repeat.set(1.5, 1.5);
        this.T.cloth.map.repeat.set(3, 3); this.T.cloth.normalMap.repeat.set(3, 3);
    }

    buildLights() {
        const s = this.scene;
        this.hemi = new THREE.HemisphereLight(0xcfe0ff, 0x5b4a33, 0.85);
        s.add(this.hemi);
        const sun = this.sun = new THREE.DirectionalLight(0xffe0b5, 3.3);
        sun.position.set(-24, 21, 11);
        sun.target.position.set(0, 0, 0);
        sun.castShadow = true;
        const sc = sun.shadow.camera;
        sc.left = -30; sc.right = 30; sc.top = 21; sc.bottom = -21; sc.near = 2; sc.far = 100;
        sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.035;
        s.add(sun, sun.target);
        const rim = new THREE.DirectionalLight(0x9fbcff, 0.9);
        rim.position.set(12, 9, -22);
        s.add(rim);
        // fixed pool of effect lights (changing the light count would recompile every shader mid-fight)
        this.fxLights = [0, 1, 2].map(() => { const l = new THREE.PointLight(0xffffff, 0, 9, 2); l.position.set(0, -50, 0); s.add(l); return { l, peak: 0, t: 1, dur: 0.3 }; });
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        pmrem.dispose();
        s.environment = this.envTex;
        s.environmentIntensity = 0.32;
    }

    buildSky() {
        const horizon = new THREE.Color(0xe9c9a0), zenith = new THREE.Color(0x4f7fc4);
        this.scene.fog = new THREE.Fog(horizon.clone().lerp(new THREE.Color(0x9fb6c9), 0.4), 42, 130);
        this.scene.background = this.scene.fog.color.clone();
        const mat = new THREE.ShaderMaterial({
            uniforms: { uH: { value: horizon }, uZ: { value: zenith }, uSun: { value: this.sun.position.clone().normalize() } },
            vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
            fragmentShader: `uniform vec3 uH; uniform vec3 uZ; uniform vec3 uSun; varying vec3 vDir;
                void main(){ float h = clamp(vDir.y, 0., 1.); vec3 c = mix(uH, uZ, pow(h, 0.55));
                  float s = max(dot(normalize(vDir), normalize(uSun)), 0.); c += vec3(1.,.85,.6) * (pow(s, 64.) * 1.5 + pow(s, 6.) * .25);
                  gl_FragColor = vec4(c, 1.);
                  #include <tonemapping_fragment>
                  #include <colorspace_fragment>
                }`,
            side: THREE.BackSide, depthWrite: false, fog: false
        });
        const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), mat);
        sky.renderOrder = -10;
        this.scene.add(sky);
    }

    buildTerrain() {
        const geo = new THREE.PlaneGeometry(SX, SZ, 336, 224).rotateX(-Math.PI / 2);
        const p = geo.attributes.position;
        for (let i = 0; i < p.count; i++) p.setY(i, heightAt(p.getX(i), p.getZ(i)));
        geo.computeVertexNormals();
        const mat = new THREE.MeshStandardMaterial({
            map: this.T.ground, normalMap: this.T.groundDetail, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.96, metalness: 0
        });
        this.ground = new THREE.Mesh(geo, mat);
        this.ground.receiveShadow = true;
        this.scene.add(this.ground);
    }

    buildWater() {
        const geo = new THREE.PlaneGeometry(RW * 2 + 1.8, SZ, 24, 160).rotateX(-Math.PI / 2);
        this.waterU = {
            uTime: { value: 0 }, uSunDir: { value: this.sun.position.clone().normalize() }, uSunColor: { value: new THREE.Color(0xfff0d0) },
            uDeep: { value: new THREE.Color(0x0f3d4a) }, uShallow: { value: new THREE.Color(0x3f8a86) }, uSky: { value: new THREE.Color(0xa9c8e8) },
            uHalf: { value: RW + 0.35 }
        };
        const mat = new THREE.ShaderMaterial({
            uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, this.waterU]),
            vertexShader: `uniform float uTime; varying vec3 vWorld;
                #include <fog_pars_vertex>
                void main(){ vec4 wp = modelMatrix * vec4(position, 1.);
                  wp.y += sin(wp.z * 1.7 - uTime * 2.3) * 0.018 + sin(wp.x * 3.1 + wp.z * 0.7 + uTime * 1.7) * 0.012;
                  vWorld = wp.xyz; vec4 mvPosition = viewMatrix * wp; gl_Position = projectionMatrix * mvPosition;
                  #include <fog_vertex>
                }`,
            fragmentShader: `uniform float uTime; uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uSky; uniform float uHalf;
                varying vec3 vWorld;
                #include <fog_pars_fragment>
                ${NOISE_GLSL}
                float wh(vec2 p){ float t = uTime;
                  return vnoise(p * vec2(2.0, 1.1) + vec2(0., t * 1.3)) * 0.5 + vnoise(p * vec2(4.6, 2.8) + vec2(t * .2, t * 2.2)) * 0.3
                       + vnoise(p * vec2(9.0, 7.0) + vec2(-t * .4, t * 3.0)) * 0.15; }
                void main(){
                  vec2 p = vWorld.xz; float e = 0.04;
                  float h0 = wh(p); vec3 n = normalize(vec3((h0 - wh(p + vec2(e, 0.))) * 3.2, 1., (h0 - wh(p + vec2(0., e))) * 3.2));
                  vec3 V = normalize(cameraPosition - vWorld);
                  float fres = 0.04 + 0.96 * pow(1. - max(dot(n, V), 0.), 5.);
                  float edge = clamp(abs(vWorld.x) / uHalf, 0., 1.4);
                  vec3 col = mix(uDeep, uShallow, smoothstep(0.15, 1.0, edge));
                  col = mix(col, uSky, clamp(fres * 1.4, 0., 0.85));
                  vec3 Hh = normalize(normalize(uSunDir) + V);
                  col += uSunColor * (pow(max(dot(n, Hh), 0.), 220.) * 4.0 + pow(max(dot(n, Hh), 0.), 30.) * 0.15);
                  float fn = vnoise(p * vec2(3.2, 1.4) + vec2(0., uTime * 1.6));
                  float foam = smoothstep(0.78, 1.02, edge + fn * 0.28);
                  float streak = smoothstep(0.74, 0.92, vnoise(vec2(p.x * 7., p.y * 0.9 + uTime * 2.4))) * (1. - edge);
                  col = mix(col, vec3(0.86, 0.93, 0.95), clamp(foam * 0.75 + streak * 0.12, 0., 1.));
                  float a = mix(0.82, 0.5, smoothstep(0.35, 1.0, edge)) + fres * 0.25 + foam * 0.35;
                  gl_FragColor = vec4(col, clamp(a, 0., 1.));
                  #include <tonemapping_fragment>
                  #include <colorspace_fragment>
                  #include <fog_fragment>
                }`,
            transparent: true, depthWrite: false, fog: true
        });
        this.water = new THREE.Mesh(geo, mat);
        this.water.position.y = WATER_Y;
        this.water.renderOrder = 3;
        this.scene.add(this.water);
    }

    rockGeometry(seed) {
        let g = new THREE.IcosahedronGeometry(1, 4);
        g.deleteAttribute('normal'); g.deleteAttribute('uv');
        g = mergeVertices(g);
        const p = g.attributes.position, uv = new Float32Array(p.count * 2);
        for (let i = 0; i < p.count; i++) {
            const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
            const n = TX.fbm(x * 1.3 + seed * 7, y * 1.3 + z * 1.1 + seed * 3, 4);
            const flat = y < -0.35 ? 0.65 + (y + 1) * 0.5 : 1;
            const r = (0.72 + n * 0.55) * flat;
            p.setXYZ(i, x * r * (1 + seed * 0.08), Math.max(y * r * 0.72, -0.42), z * r);
            uv[i * 2] = Math.atan2(z, x) / (Math.PI * 2) + 0.5; uv[i * 2 + 1] = y * 0.5 + 0.5;
        }
        g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        g.computeVertexNormals();
        return g;
    }

    buildRocks() {
        const mat = new THREE.MeshStandardMaterial({ map: this.T.rock.map, normalMap: this.T.rock.normalMap, roughness: 0.92, metalness: 0 });
        const geos = [0, 1, 2].map(s => this.rockGeometry(s));
        const placements = [[], [], []];
        const put = (x, z, s, sink) => placements[Math.floor(Math.random() * 3)].push({ x, z, s, sink: sink == null ? 0.25 : sink, ry: rand(0, Math.PI * 2) });
        // stones lining the arena edge (outside the playable area)
        for (let x = -AX - 0.9; x <= AX + 0.9; x += rand(0.9, 1.6)) {
            if (Math.abs(x) < RW + 0.6) continue;
            put(x + rand(-0.2, 0.2), -AZ - rand(0.7, 1.2), rand(0.22, 0.5));
            if (Math.random() < 0.8) put(x + rand(-0.2, 0.2), AZ + rand(0.8, 1.3), rand(0.18, 0.38));
        }
        for (let z = -AZ - 0.9; z <= AZ + 0.9; z += rand(0.9, 1.6)) for (const sx of [-1, 1]) put(sx * (AX + rand(0.7, 1.2)), z + rand(-0.2, 0.2), rand(0.22, 0.5));
        // boulders on the outskirts
        for (let i = 0; i < 70; i++) {
            const x = rand(-36, 36), z = rand(-26, 14);
            const I = terrainInfo(x, z);
            if (I.out < 2.2 || Math.abs(x) < RW + 1.4) continue;
            put(x, z, rand(0.5, 2.0) * (z < -AZ ? 1.2 : 0.8), 0.35);
        }
        // river stones, some breaking the surface
        for (let z = -27; z < 27; z += rand(0.7, 2.2)) put(rand(-RW + 0.2, RW - 0.2), z, rand(0.18, 0.5), 0.1);
        for (let z = -27; z < 27; z += rand(1.0, 2.6)) for (const sx of [-1, 1]) put(sx * rand(RW - 0.1, RW + 0.5), z, rand(0.2, 0.45), 0.2);

        const dummy = new THREE.Object3D();
        this.rocks = geos.map((g, k) => {
            const list = placements[k];
            const im = new THREE.InstancedMesh(g, mat, list.length);
            list.forEach((r, i) => {
                dummy.position.set(r.x, heightAt(r.x, r.z) - r.s * r.sink, r.z);
                dummy.rotation.set(rand(-0.15, 0.15), r.ry, rand(-0.15, 0.15));
                dummy.scale.set(r.s * rand(0.85, 1.3), r.s, r.s * rand(0.85, 1.2));
                dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix);
                const c = new THREE.Color().setHSL(0.09, 0.06, rand(0.6, 0.85), THREE.SRGBColorSpace); im.setColorAt(i, c);
            });
            im.castShadow = true; im.receiveShadow = true;
            this.scene.add(im);
            return im;
        });
    }

    buildTrees() {
        const trunk = new THREE.CylinderGeometry(0.1, 0.2, 1.8, 8).translate(0, 0.9, 0);
        const layers = [];
        const tiers = [[1.35, 1.5, 1.05], [1.1, 1.3, 1.85], [0.85, 1.15, 2.55], [0.55, 0.95, 3.2], [0.28, 0.7, 3.75]];
        tiers.forEach(([rad, h, y], li) => {
            const c = new THREE.ConeGeometry(rad, h, 14, 3, true);
            const p = c.attributes.position;
            for (let i = 0; i < p.count; i++) {
                const x = p.getX(i), yy = p.getY(i), z = p.getZ(i);
                const a = Math.atan2(z, x), n = TX.vnoise(a * 2.2 + li * 5, yy * 2 + li, 0);
                const k = 0.78 + n * 0.45, droop = yy < -h * 0.4 ? -0.12 * n : 0;
                p.setXYZ(i, x * k, yy + droop, z * k);
            }
            c.translate(0, y, 0);
            c.deleteAttribute('uv');
            layers.push(c);
        });
        const foliage = mergeGeometries(layers);
        foliage.computeVertexNormals();
        const trunkMat = new THREE.MeshStandardMaterial({ map: this.T.bark.map, normalMap: this.T.bark.normalMap, roughness: 0.95 });
        const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, side: THREE.DoubleSide });
        const spots = [];
        for (let tries = 0; spots.length < 120 && tries < 5000; tries++) {
            const x = rand(-41, 41), z = rand(-27.5, 27.5);
            const I = terrainInfo(x, z);
            if (I.out < 3.2 || Math.abs(x) < RW + 2.6) continue;
            if (z > AZ + 1 && Math.abs(x) < AX + 6) continue;    // keep the camera side clear
            if (spots.some(s => Math.hypot(s.x - x, s.z - z) < 2.4)) continue;
            spots.push({ x, z, s: rand(0.85, 1.7) });
        }
        const tI = new THREE.InstancedMesh(trunk, trunkMat, spots.length), fI = new THREE.InstancedMesh(foliage, leafMat, spots.length);
        const d = new THREE.Object3D();
        spots.forEach((t, i) => {
            d.position.set(t.x, heightAt(t.x, t.z) - 0.1, t.z);
            d.rotation.set(rand(-0.04, 0.04), rand(0, 6.28), rand(-0.04, 0.04));
            d.scale.set(t.s, t.s * rand(0.9, 1.25), t.s);
            d.updateMatrix(); tI.setMatrixAt(i, d.matrix); fI.setMatrixAt(i, d.matrix);
            fI.setColorAt(i, new THREE.Color().setHSL(rand(0.26, 0.34), rand(0.3, 0.45), rand(0.17, 0.26), THREE.SRGBColorSpace));
        });
        for (const m of [tI, fI]) { m.castShadow = true; m.receiveShadow = true; this.scene.add(m); }
        // bushes
        let bg = new THREE.IcosahedronGeometry(1, 2); bg.deleteAttribute('normal'); bg.deleteAttribute('uv'); bg = mergeVertices(bg);
        const bp = bg.attributes.position;
        for (let i = 0; i < bp.count; i++) { const x = bp.getX(i), y = bp.getY(i), z = bp.getZ(i), k = 0.75 + TX.fbm(x * 2 + 3, y * 2 + z * 2, 3) * 0.6; bp.setXYZ(i, x * k, Math.max(y * k * 0.75, -0.2), z * k); }
        bg.computeVertexNormals();
        const bushes = [];
        for (let tries = 0; bushes.length < 46 && tries < 2000; tries++) {
            const x = rand(-34, 34), z = rand(-24, 15);
            const I = terrainInfo(x, z);
            if (I.out < 1.6 || Math.abs(x) < RW + 1.2) continue;
            bushes.push({ x, z, s: rand(0.4, 0.95) });
        }
        const leafN = this.T.groundDetail.clone(); leafN.repeat.set(3, 3); leafN.needsUpdate = true;
        const bI = new THREE.InstancedMesh(bg, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, normalMap: leafN, normalScale: new THREE.Vector2(2.2, 2.2) }), bushes.length);
        bushes.forEach((b, i) => {
            d.position.set(b.x, heightAt(b.x, b.z), b.z); d.rotation.set(0, rand(0, 6.28), 0); d.scale.set(b.s * rand(1, 1.5), b.s, b.s * rand(1, 1.4));
            d.updateMatrix(); bI.setMatrixAt(i, d.matrix);
            bI.setColorAt(i, new THREE.Color().setHSL(rand(0.22, 0.3), rand(0.3, 0.45), rand(0.2, 0.3), THREE.SRGBColorSpace));
        });
        bI.castShadow = true; bI.receiveShadow = true;
        this.scene.add(bI);
    }

    buildGrass() {
        if (this.grass) { this.scene.remove(this.grass); this.grass.geometry.dispose(); this.grass.material.dispose(); this.grass = null; }
        const count = this.quality === 'high' ? 34000 : 9000;
        // one blade: 4 tapered segments with a slight forward curve; aH carries 0..1 height for wind + shading
        const segs = 4, pos = [], hgt = [], idx = [];
        for (let i = 0; i <= segs; i++) {
            const t = i / segs, w = 0.055 * (1 - t * 0.92), z = t * t * 0.18;
            pos.push(-w, t, z, w, t, z); hgt.push(t, t);
            if (i < segs) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill(0).flatMap(() => [0, 1, 0]), 3));
        geo.setAttribute('aH', new THREE.Float32BufferAttribute(hgt, 1));
        geo.setIndex(idx);
        const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, side: THREE.DoubleSide });
        this.grassU = { uTime: { value: 0 }, uUnits: { value: Array.from({ length: 6 }, () => new THREE.Vector3(0, 0, -1)) } };
        mat.onBeforeCompile = sh => {
            Object.assign(sh.uniforms, this.grassU);
            sh.vertexShader = sh.vertexShader
                .replace('#include <common>', `#include <common>
                    attribute float aH; uniform float uTime; uniform vec3 uUnits[6]; varying float vGH;`)
                .replace('#include <project_vertex>', `
                    vec4 mvPosition = vec4(transformed, 1.0);
                    #ifdef USE_INSTANCING
                    mvPosition = instanceMatrix * mvPosition;
                    #endif
                    float hk = aH * aH;
                    vec2 base = (instanceMatrix * vec4(0., 0., 0., 1.)).xz;
                    float gust = sin(uTime * 0.9 + base.x * 0.15 + base.y * 0.1) * 0.5 + 0.5;
                    float wv = sin(uTime * 2.1 + base.x * 0.7 + base.y * 0.5) * 0.6 + sin(uTime * 3.7 + base.x * 1.9) * 0.25;
                    mvPosition.x += (wv * 0.06 + gust * 0.1) * hk;
                    mvPosition.z += wv * 0.03 * hk;
                    for (int i = 0; i < 6; i++) {
                        vec3 u = uUnits[i]; if (u.z < 0.) continue;
                        vec2 d = mvPosition.xz - u.xy; float dist = length(d);
                        float push = 1. - smoothstep(0.25, u.z, dist);
                        mvPosition.xz += (d / max(dist, 0.001)) * push * hk * 0.45;
                        mvPosition.y -= push * hk * 0.22;
                    }
                    vGH = aH;
                    mvPosition = modelViewMatrix * mvPosition;
                    gl_Position = projectionMatrix * mvPosition;`);
            sh.fragmentShader = sh.fragmentShader
                .replace('#include <common>', '#include <common>\nvarying float vGH;')
                .replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb *= mix(0.32, 1.12, vGH);');
        };
        const im = new THREE.InstancedMesh(geo, mat, count);
        const d = new THREE.Object3D(), c = new THREE.Color();
        let n = 0, guard = 0;
        while (n < count && guard++ < count * 6) {
            const cx = rand(-36, 36), cz = rand(-25, 14);
            const I = terrainInfo(cx, cz);
            const density = I.arena > 0.5 ? 0.28 : 1;
            if (Math.random() > density) continue;
            const clump = 6 + Math.floor(Math.random() * 14), tall = I.arena > 0.5 ? 0.45 : 1;
            for (let k = 0; k < clump && n < count; k++) {
                const x = cx + rand(-0.4, 0.4), z = cz + rand(-0.4, 0.4), y = heightAt(x, z);
                if (y < WATER_Y + 0.1) continue;
                d.position.set(x, y - 0.02, z);
                d.rotation.set(rand(-0.15, 0.15), rand(0, Math.PI * 2), rand(-0.15, 0.15));
                const hgt = rand(0.22, 0.55) * tall;
                d.scale.set(rand(0.8, 1.3), hgt, 1);
                d.updateMatrix(); im.setMatrixAt(n, d.matrix);
                const dry = Math.random() < 0.18 ? 1 : 0;
                c.setHSL(dry ? rand(0.12, 0.16) : rand(0.21, 0.28), dry ? 0.35 : rand(0.4, 0.55), dry ? rand(0.45, 0.55) : rand(0.32, 0.46), THREE.SRGBColorSpace);
                im.setColorAt(n, c);
                n++;
            }
        }
        im.count = n;
        im.receiveShadow = true;
        im.frustumCulled = false;
        this.grass = im;
        this.scene.add(im);
    }

    buildProps() {
        // braziers at the arena corners
        const stone = new THREE.MeshStandardMaterial({ map: this.T.rock.map, normalMap: this.T.rock.normalMap, roughness: 0.9 });
        const iron = new THREE.MeshStandardMaterial({ color: 0x2b2725, metalness: 0.85, roughness: 0.55 });
        const coal = new THREE.MeshStandardMaterial({ color: 0x220a02, emissive: 0xff5a14, emissiveIntensity: 2.5, roughness: 1 });
        const bowlProfile = [[0.05, 0], [0.42, 0.04], [0.55, 0.2], [0.6, 0.36], [0.56, 0.38], [0.48, 0.24], [0.05, 0.12]].map(([x, y]) => new THREE.Vector2(x, y));
        const bowlGeo = new THREE.LatheGeometry(bowlProfile, 20);
        this.braziers = [];
        for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
            const x = sx * (AX + 1.9), z = sz * (AZ + 1.7), y = heightAt(x, z);
            const g = new THREE.Group(); g.position.set(x, y, z);
            const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.42, 1.3, 8), stone); pillar.position.y = 0.65;
            const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.36, 0.14, 8), stone); cap.position.y = 1.35;
            const bowl = new THREE.Mesh(bowlGeo, iron); bowl.position.y = 1.4;
            const coals = new THREE.Mesh(new THREE.SphereGeometry(0.45, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), coal); coals.position.y = 1.62; coals.scale.y = 0.35;
            for (const m of [pillar, cap, bowl]) { m.castShadow = true; m.receiveShadow = true; }
            g.add(pillar, cap, bowl, coals);
            this.scene.add(g);
            const light = new THREE.PointLight(0xff8a3a, 22, 11, 2); light.position.set(x, y + 2.2, z);
            this.scene.add(light);
            this.braziers.push({ x, y: y + 1.75, z, light, seed: Math.random() * 10 });
        }
        // team banners behind each bank
        const pole = new THREE.MeshStandardMaterial({ map: this.T.wood, roughness: 0.8 });
        this.bannerU = { uTime: { value: 0 } };
        for (const team of [0, 1]) {
            const mat = new THREE.MeshStandardMaterial({ map: this.T.banners[team], side: THREE.DoubleSide, roughness: 0.9, alphaTest: 0.5 });
            mat.onBeforeCompile = sh => {
                sh.uniforms.uTime = this.bannerU.uTime;
                sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
                    .replace('#include <begin_vertex>', `#include <begin_vertex>
                        float hang = 1. - uv.y;
                        transformed.z += sin(uTime * 2.4 + position.y * 2.2 + position.x * 2.5) * 0.14 * hang + hang * hang * 0.1;
                        transformed.x += sin(uTime * 1.7 + position.y * 3.) * 0.03 * hang;`);
            };
            for (const off of [-1, 1]) {
                const x = (team === 0 ? -1 : 1) * (AX * 0.5 + off * 3.2), z = -AZ - 2.3, y = heightAt(x, z);
                const g = new THREE.Group(); g.position.set(x, y, z);
                const p1 = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 4, 8), pole); p1.position.y = 2;
                const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.5, 8), pole); bar.rotation.z = Math.PI / 2; bar.position.set(0, 3.85, 0.05);
                const tip = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.3, 8), iron); tip.position.y = 4.15;
                const cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 2.4, 10, 18), mat); cloth.position.set(0, 2.62, 0.09);
                for (const m of [p1, bar, tip]) { m.castShadow = true; m.receiveShadow = true; }
                cloth.receiveShadow = true;
                g.add(p1, bar, tip, cloth);
                this.scene.add(g);
            }
        }
    }

    buildFx() {
        this.addFx = new Particles(5000, THREE.AdditiveBlending, this.T.spark);
        this.normFx = new Particles(4000, THREE.NormalBlending, this.T.softDot);
        this.scene.add(this.addFx.points, this.normFx.points);
        // floating motes / pollen in the light
        const N = 360, mp = new Float32Array(N * 3), ms = new Float32Array(N);
        for (let i = 0; i < N; i++) { mp[i * 3] = rand(-26, 26); mp[i * 3 + 1] = rand(0.3, 4); mp[i * 3 + 2] = rand(-16, 11); ms[i] = Math.random(); }
        const mg = new THREE.BufferGeometry();
        mg.setAttribute('position', new THREE.BufferAttribute(mp, 3)); mg.setAttribute('aSeed', new THREE.BufferAttribute(ms, 1));
        this.moteU = { uTime: { value: 0 }, uScale: { value: 600 }, uTex: { value: this.T.spark } };
        const mm = new THREE.ShaderMaterial({
            uniforms: this.moteU,
            vertexShader: `attribute float aSeed; uniform float uTime; uniform float uScale; varying float vA;
                void main(){ vec3 p = position; float t = uTime * (0.15 + aSeed * 0.2) + aSeed * 40.;
                  p += vec3(sin(t) * 0.8, sin(t * 1.3) * 0.4, cos(t * 0.8) * 0.8);
                  vec4 mv = modelViewMatrix * vec4(p, 1.); gl_PointSize = (0.06 + aSeed * 0.05) * uScale / -mv.z;
                  vA = (0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * 2. + aSeed * 30.))) * 0.55; gl_Position = projectionMatrix * mv; }`,
            fragmentShader: `uniform sampler2D uTex; varying float vA; void main(){ vec4 t = texture2D(uTex, gl_PointCoord); gl_FragColor = vec4(vec3(1., .9, .6) * t.rgb, t.a * vA); }`,
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
        });
        this.motes = new THREE.Points(mg, mm); this.motes.frustumCulled = false;
        this.scene.add(this.motes);
        // shared pieces for decals, shockwave rings and ripples
        this.decalGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
        this.ringGeo = new THREE.RingGeometry(0.82, 1, 64).rotateX(-Math.PI / 2);
    }

    buildIndicators() {
        // skillshot indicator: a ground rectangle from Mundo toward the cursor
        const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0.5, 0, 0);
        this.aimU = { uColor: { value: new THREE.Color(0x9ccfff) }, uReady: { value: 1 }, uTime: { value: 0 }, uLen: { value: 19 } };
        this.aim = new THREE.Mesh(geo, new THREE.ShaderMaterial({
            uniforms: this.aimU,
            vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
            fragmentShader: `uniform vec3 uColor; uniform float uReady; uniform float uTime; uniform float uLen; varying vec2 vUv;
                void main(){
                  float u = vUv.x, v = abs(vUv.y - 0.5) * 2.;
                  float edge = smoothstep(0.84, 0.94, v) * (1. - smoothstep(0.97, 1.0, v));
                  float fill = (1. - v * 0.3) * mix(0.32, 0.08, u);
                  float dash = step(0.5, fract(u * uLen * 0.9 - uTime * 3.)) * smoothstep(0.7, 0.0, v) * 0.18;
                  float tipU = (u - 0.9) / 0.1; float arrow = step(0., tipU) * smoothstep(0.08, 0.0, abs(v - (1. - tipU)) - 0.02);
                  float startFade = smoothstep(0.0, 0.04, u);
                  float a = (fill + edge * 0.9 + dash + arrow) * startFade * mix(0.35, 1., uReady);
                  gl_FragColor = vec4(uColor * mix(0.5, 1.4, uReady), a * 0.85);
                }`,
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
        }));
        this.aim.renderOrder = 4; this.aim.visible = false;
        this.scene.add(this.aim);
        // right-click marker
        const mm = new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
        this.marker = new THREE.Group();
        this.marker.add(new THREE.Mesh(this.kit.g.ring, mm), new THREE.Mesh(this.kit.g.ringTicks, mm));
        this.marker.visible = false; this.marker.renderOrder = 4; this.markerT = 1; this.markerMat = mm;
        this.scene.add(this.marker);
    }

    buildPost() {
        const r = this.renderer;
        const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: this.quality === 'high' ? 4 : 0 });
        this.composer = new EffectComposer(r, rt);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.55, 0.86);
        this.composer.addPass(this.bloom);
        this.grade = new ShaderPass({
            uniforms: { tDiffuse: { value: null }, uVig: { value: 0.42 }, uDamage: { value: 0 }, uLow: { value: 0 }, uTime: { value: 0 }, uSat: { value: 1.08 }, uFlash: { value: 0 } },
            vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
            fragmentShader: `uniform sampler2D tDiffuse; uniform float uVig; uniform float uDamage; uniform float uLow; uniform float uTime; uniform float uSat; uniform float uFlash;
                varying vec2 vUv;
                void main(){
                  vec4 c = texture2D(tDiffuse, vUv);
                  vec2 d = vUv - 0.5; float r = length(d * vec2(1.0, 0.75));
                  c.rgb *= mix(1. - uVig, 1., smoothstep(0.8, 0.22, r));
                  float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
                  c.rgb = mix(vec3(l), c.rgb, uSat - uLow * 0.35);
                  float edge = smoothstep(0.28, 0.75, r);
                  c.rgb = mix(c.rgb, vec3(0.75, 0.02, 0.02) * (0.25 + l), edge * uDamage);
                  c.rgb += vec3(0.35, 0., 0.) * edge * uLow * (0.55 + 0.45 * sin(uTime * 6.5));
                  c.rgb += vec3(uFlash);
                  gl_FragColor = c;
                }`
        });
        this.composer.addPass(this.grade);
        this.composer.addPass(new OutputPass());
    }

    setQuality(q) {
        q = q === 'low' ? 'low' : 'high';
        if (q === this.quality) return;
        this.quality = q;
        for (const pass of this.composer.passes) if (pass.dispose) pass.dispose();
        this.composer.dispose();
        this.buildPost();
        this.buildGrass();
        this.applyQuality();
        this.resize(this.cssW, this.cssH, true);
    }
    applyQuality() {
        const hi = this.quality === 'high';
        const size = hi ? 2048 : 1024;
        if (this.sun.shadow.mapSize.x !== size) {
            this.sun.shadow.mapSize.set(size, size);
            if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
        }
        this.bloom.enabled = hi;
    }

    // ---- camera ------------------------------------------------------------------------------------------------------
    resize(w, h, force) {
        if (!force && w === this.cssW && h === this.cssH) return;
        this.cssW = Math.max(1, w); this.cssH = Math.max(1, h);
        const dpr = Math.min(window.devicePixelRatio || 1, this.quality === 'high' ? 2 : 1);
        this.renderer.setPixelRatio(dpr);
        this.renderer.setSize(this.cssW, this.cssH, false);
        this.composer.setPixelRatio(dpr);
        this.composer.setSize(this.cssW, this.cssH);
        this.bloom.resolution.set(this.cssW * dpr / 2, this.cssH * dpr / 2);
        this.camera.aspect = this.cssW / this.cssH;
        this.camera.updateProjectionMatrix();
        this.fitCamera();
        const scale = this.cssH * dpr / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
        this.addFx.mat.uniforms.uScale.value = scale; this.normFx.mat.uniforms.uScale.value = scale; this.moteU.uScale.value = scale;
    }
    // back the camera off along a fixed pitch until the whole arena (plus Mundos' heads) fits between the HUD bars
    fitCamera() {
        const cam = this.camera, pitch = THREE.MathUtils.degToRad(52), t = this.camTarget, v = this.tmpV;
        const pts = [[-AX - 0.3, 0, AZ + 0.5], [AX + 0.3, 0, AZ + 0.5], [-AX + 1, 4.4, -AZ], [AX - 1, 4.4, -AZ]];
        const topLimit = 1 - 2 * (34 / this.cssH), botLimit = -1 + 2 * (12 / this.cssH);
        let d = 14;
        for (; d < 120; d += 0.2) {
            cam.position.set(t.x, t.y + Math.sin(pitch) * d, t.z + Math.cos(pitch) * d);
            cam.lookAt(t); cam.updateMatrixWorld(); cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
            let ok = true;
            for (const [x, y, z] of pts) {
                v.set(x, y, z).project(cam);
                const isBottom = y === 0;
                if (Math.abs(v.x) > 0.97 || v.y > topLimit || (isBottom && v.y < botLimit)) { ok = false; break; }
            }
            if (ok) break;
        }
        this.camBase.copy(cam.position);
    }

    pick(clientX, clientY, height) {
        const r = this.canvas.getBoundingClientRect();
        const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
        this.raycaster.setFromCamera(ndc, this.camera);
        this.groundPlane.constant = -(height || 0);
        const hit = this.raycaster.ray.intersectPlane(this.groundPlane, this.tmpV);
        if (!hit) return null;
        return { x: hit.x / K + W / 2, y: hit.z / K + H / 2 };
    }
    // world -> css pixels inside the canvas; returns null when behind the camera
    project(x, y, z) {
        const v = this.tmpV.set(x, y, z).project(this.camera);
        if (v.z > 1) return null;
        return { x: (v.x + 1) / 2 * this.cssW, y: (1 - v.y) / 2 * this.cssH };
    }
    unitScreen(u, height) {
        const e = this.mundos.get(u.id);
        const y = e ? e.m.root.position.y : 0;
        return this.project(wx(u.x), y + (height == null ? 4.0 : height), wz(u.y));
    }

    // ---- effects -----------------------------------------------------------------------------------------------------
    addShake(a) { this.shake = Math.min(1.2, this.shake + a); }
    light(x, y, z, color, intensity, dur) {
        let best = this.fxLights[0];
        for (const f of this.fxLights) if (f.t >= 1 || f.peak * (1 - f.t) < best.peak * (1 - best.t)) best = f;
        best.l.position.set(x, y, z); best.l.color.set(color); best.peak = intensity; best.t = 0; best.dur = dur || 0.3;
    }
    shockwave(x, z, color, size, dur) {
        const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
        const m = new THREE.Mesh(this.ringGeo, mat);
        m.position.set(x, heightAt(x, z) + 0.06, z); m.renderOrder = 4;
        this.scene.add(m);
        this.rings.push({ m, t: 0, dur: dur || 0.45, size: size || 2.2 });
    }
    ripple(x, z) {
        const mat = new THREE.MeshBasicMaterial({ color: 0xcfe9ff, transparent: true, opacity: 0.6, depthWrite: false });
        const m = new THREE.Mesh(this.ringGeo, mat);
        m.position.set(x, WATER_Y + 0.03, z); m.renderOrder = 4;
        this.scene.add(m);
        this.ripples.push({ m, t: 0 });
    }
    decal(x, z, size) {
        if (Math.abs(x) < RW + 0.2) return;
        if (this.decals.length > 46) { const old = this.decals.shift(); old.m.removeFromParent(); old.m.material.dispose(); }
        const mat = new THREE.MeshStandardMaterial({
            map: this.T.splats[Math.floor(Math.random() * 4)], color: new THREE.Color().setHSL(0.995, 0.85, rand(0.16, 0.24), THREE.SRGBColorSpace),
            transparent: true, depthWrite: false, roughness: 0.25, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
        });
        const m = new THREE.Mesh(this.decalGeo, mat);
        m.position.set(x, heightAt(x, z) + 0.03, z); m.rotation.y = rand(0, Math.PI * 2);
        m.scale.setScalar(size); m.receiveShadow = true; m.renderOrder = 1;
        this.scene.add(m);
        this.decals.push({ m, t: 0 });
    }
    blood(x, y, z, dx, dz, n) {
        const dark = new THREE.Color(0x5a0505), red = new THREE.Color(0x9b0d0d);
        for (let i = 0; i < n; i++) {
            const sp = rand(1.5, 6.5);
            this.normFx.emit({ x, y, z, vx: dx * sp + rand(-2, 2), vy: rand(1, 5), vz: dz * sp + rand(-2, 2), life: rand(0.7, 1.3),
                size: rand(0.07, 0.16), size1: 0.05, color: red, color1: dark, alpha: 1, grav: -16, drag: 0.6, flags: Math.random() < 0.3 ? 3 : 1 });
        }
        for (let i = 0; i < n / 3; i++) { // mist
            this.normFx.emit({ x: x + rand(-0.1, 0.1), y: y + rand(-0.1, 0.2), z: z + rand(-0.1, 0.1), vx: dx * rand(0.5, 2), vy: rand(0, 1), vz: dz * rand(0.5, 2),
                life: rand(0.35, 0.6), size: 0.3, size1: 0.9, color: red, alpha: 0.35, drag: 3 });
        }
    }
    sparks(x, y, z, n, color, speed) {
        const c = new THREE.Color(color || 0xffc46b), c1 = new THREE.Color(0xff4a10);
        for (let i = 0; i < n; i++) {
            const a = rand(0, Math.PI * 2), e = rand(-0.2, 1), sp = rand(2, speed || 9);
            this.addFx.emit({ x, y, z, vx: Math.cos(a) * sp, vy: e * sp * 0.7 + 1.5, vz: Math.sin(a) * sp, life: rand(0.2, 0.5), size: rand(0.06, 0.12), size1: 0.02,
                color: c, color1: c1, alpha: 1, grav: -14, drag: 1.2, flags: 1 });
        }
    }
    dust(x, z, n, scale, color) {
        const c = new THREE.Color(color || 0x8a7558), y = heightAt(x, z) + 0.1;
        for (let i = 0; i < n; i++) {
            const a = rand(0, Math.PI * 2), sp = rand(0.8, 3.2) * (scale || 1);
            this.normFx.emit({ x: x + Math.cos(a) * 0.3, y: y + rand(0, 0.3), z: z + Math.sin(a) * 0.3, vx: Math.cos(a) * sp, vy: rand(0.2, 1.2), vz: Math.sin(a) * sp,
                life: rand(0.6, 1.3), size: rand(0.3, 0.6) * (scale || 1), size1: rand(1.0, 1.8) * (scale || 1), color: c, alpha: 0.32, drag: 2.4 });
        }
    }
    splash(x, z, n) {
        const c = new THREE.Color(0xd8f1ff);
        for (let i = 0; i < n; i++) {
            const a = rand(0, Math.PI * 2), sp = rand(0.5, 2.6);
            this.normFx.emit({ x, y: WATER_Y + 0.05, z, vx: Math.cos(a) * sp, vy: rand(2.5, 5.5), vz: Math.sin(a) * sp, life: rand(0.5, 0.9),
                size: rand(0.06, 0.14), size1: 0.04, color: c, alpha: 0.85, grav: -15, flags: 0 });
        }
        this.ripple(x, z); setTimeout(() => this.ripple(x, z), 180);
    }
    flashBurst(x, z) {
        const y = heightAt(x, z) + 1.2, c = new THREE.Color(0xfff3b0), c1 = new THREE.Color(0xffb020);
        for (let i = 0; i < 40; i++) {
            const a = rand(0, Math.PI * 2), e = rand(-1, 1), sp = rand(2, 7);
            this.addFx.emit({ x, y: y + rand(-0.8, 0.8), z, vx: Math.cos(a) * sp * Math.sqrt(1 - e * e), vy: e * sp, vz: Math.sin(a) * sp * Math.sqrt(1 - e * e),
                life: rand(0.25, 0.55), size: rand(0.1, 0.22), size1: 0.02, color: c, color1: c1, drag: 3 });
        }
        this.addFx.emit({ x, y, z, life: 0.28, size: 2.6, size1: 0.4, color: c, alpha: 0.9 });
        this.shockwave(x, z, 0xffe9a0, 2.4, 0.4);
        this.light(x, y, z, 0xfff0b0, 40, 0.3);
    }

    // ---- events from the game --------------------------------------------------------------------------------------
    onEvent(e) {
        switch (e.type) {
            case 'throw': {
                const ent = this.mundos.get(e.unit.id);
                if (ent) ent.m.triggerThrow(e.cleaver.ang);
                break;
            }
            case 'hit': {
                const u = e.unit, x = wx(u.x), z = wz(u.y), y = heightAt(x, z) + 1.5;
                const len = Math.hypot(e.cleaver.vx, e.cleaver.vy) || 1, dx = e.cleaver.vx / len, dz = e.cleaver.vy / len;
                this.blood(x - dx * 0.3, y, z - dz * 0.3, dx, dz, u.team === 0 ? 42 : 32);
                this.sparks(x - dx * 0.5, y, z - dz * 0.5, 14);
                this.light(x, y + 0.5, z, 0xff5030, 25, 0.25);
                const ent = this.mundos.get(u.id); if (ent) ent.m.triggerHurt();
                this.addShake(u.team === 0 ? 0.55 : 0.25);
                if (u.team === 0) this.damage = 1;
                this.decal(x + dx * rand(0.4, 1.2), z + dz * rand(0.4, 1.2), rand(0.7, 1.2));
                this.removeFlying(e.cleaver.id);
                break;
            }
            case 'kill': {
                const ent = this.mundos.get(e.unit.id);
                if (ent) { ent.m.triggerDeath(); ent.diedAt = this.clock; }
                const x = wx(e.unit.x), z = wz(e.unit.y);
                this.blood(x, 1.6, z, 0, 0, 60);
                this.addShake(0.7); this.zoomPunch = 1;
                this.light(x, 2, z, 0xff3020, 45, 0.5);
                break;
            }
            case 'flash': {
                this.flashBurst(wx(e.fromX), wz(e.fromY));
                this.flashBurst(wx(e.unit.x), wz(e.unit.y));
                const ent = this.mundos.get(e.unit.id); if (ent) ent.m.triggerFlash();
                break;
            }
            case 'drop': this.dropCleaver(e.cleaver); break;
            case 'clear': {
                const ent = this.mundos.get(this.lastPlayerId); if (ent) ent.m.triggerFlex();
                this.flashWhite = 0.05;
                break;
            }
            case 'newgame': this.clearTransient(); break;
        }
    }

    clearTransient() {
        for (const d of this.decals) { d.m.removeFromParent(); d.m.material.dispose(); }
        for (const d of this.dropped) d.obj.removeFromParent();
        for (const [, f] of this.flying) { f.obj.removeFromParent(); f.trail.removeFromParent(); f.trail.geometry.dispose(); }
        this.decals = []; this.dropped = []; this.flying.clear();
        this.damage = 0;
    }

    // ---- cleavers ----------------------------------------------------------------------------------------------------
    makeFlying(c) {
        const pivot = new THREE.Group(), cl = buildCleaver(this.kit);
        cl.rotation.x = -Math.PI / 2; cl.position.x = -0.15;
        pivot.add(cl);
        pivot.rotation.order = 'YXZ';
        this.scene.add(pivot);
        // ribbon trail
        const N = 18, geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
        const a = new Float32Array(N * 2); for (let i = 0; i < N; i++) a[i * 2] = a[i * 2 + 1] = 1 - i / (N - 1);
        geo.setAttribute('aT', new THREE.BufferAttribute(a, 1));
        const idx = []; for (let i = 0; i < N - 1; i++) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
        geo.setIndex(idx);
        const color = c.team === 0 ? new THREE.Color(0xbfe0ff) : new THREE.Color(0xff6a4a);
        const trail = new THREE.Mesh(geo, new THREE.ShaderMaterial({
            uniforms: { uColor: { value: color } },
            vertexShader: `attribute float aT; varying float vT; void main(){ vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
            fragmentShader: `uniform vec3 uColor; varying float vT; void main(){ gl_FragColor = vec4(uColor * (0.6 + vT * 1.6), vT * vT * 0.75); }`,
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
        }));
        trail.frustumCulled = false; trail.renderOrder = 6;
        this.scene.add(trail);
        const f = { obj: pivot, trail, hist: [], N, spin: c.team === 0 ? 1 : -1, ang: c.ang };
        this.flying.set(c.id, f);
        return f;
    }
    removeFlying(id) {
        const f = this.flying.get(id); if (!f) return;
        f.obj.removeFromParent(); f.trail.removeFromParent(); f.trail.geometry.dispose(); f.trail.material.dispose();
        this.flying.delete(id);
    }
    updateTrail(f) {
        const p = f.trail.geometry.attributes.position, N = f.N;
        const h = f.hist;
        for (let i = 0; i < N; i++) {
            const a = h[Math.min(i, h.length - 1)] || { x: 0, y: 0, z: 0 }, b = h[Math.min(i + 1, h.length - 1)] || a;
            let dx = a.x - b.x, dz = a.z - b.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
            const w = 0.32 * (1 - i / N);
            p.setXYZ(i * 2, a.x - dz * w, a.y, a.z + dx * w);
            p.setXYZ(i * 2 + 1, a.x + dz * w, a.y, a.z - dx * w);
        }
        p.needsUpdate = true;
    }
    dropCleaver(c) {
        const f = this.flying.get(c.id);
        const x = wx(c.x), z = wz(c.y), dir = { x: c.vx / 920, z: c.vy / 920 };
        let obj;
        if (f) { obj = f.obj; f.trail.removeFromParent(); f.trail.geometry.dispose(); f.trail.material.dispose(); this.flying.delete(c.id); }
        else { obj = new THREE.Group(); const cl = buildCleaver(this.kit); cl.rotation.x = -Math.PI / 2; cl.position.x = -0.15; obj.add(cl); obj.rotation.order = 'YXZ'; this.scene.add(obj); }
        obj.position.set(x, CLEAVER_Y, z);
        this.dropped.push({ obj, x, z, vx: dir.x * 9, vz: dir.z * 9, vy: 1.2, state: 'fall', t: 0, ang: c.ang, team: c.team });
        if (this.dropped.length > 18) { const old = this.dropped.shift(); old.obj.removeFromParent(); }
    }
    updateDropped(dt) {
        for (const d of this.dropped) {
            d.t += dt;
            const o = d.obj;
            if (d.state === 'fall') {
                d.vy -= 22 * dt; d.vx *= 1 - dt * 1.5; d.vz *= 1 - dt * 1.5;
                o.position.x += d.vx * dt; o.position.y += d.vy * dt; o.position.z += d.vz * dt;
                o.rotation.y += 18 * dt * (d.team === 0 ? 1 : -1);
                o.rotation.z = Math.min(1.1, d.t * 3);
                const px = o.position.x, pz = o.position.z, gy = heightAt(px, pz);
                const inWater = Math.abs(px) < RW + 0.15;
                if (inWater && o.position.y < WATER_Y + 0.1) {
                    d.state = 'sink'; d.t = 0; this.splash(px, pz, 26); this.emit && this.emit('splash', px);
                } else if (o.position.y < gy + 0.25) {
                    if (Math.abs(px) > AX + 6 || Math.abs(pz) > AZ + 6) { d.state = 'gone'; continue; }
                    d.state = 'stuck'; d.t = 0;
                    // bite into the dirt: blade along the travel direction, nose down
                    o.rotation.set(0, -d.ang, 0); o.rotation.order = 'YXZ';
                    const cl = o.children[0]; cl.rotation.set(0, 0, -0.75); cl.position.set(-0.15, 0, 0);
                    o.position.y = gy + 0.12;
                    this.dust(px, pz, 8, 0.6);
                    this.sparks(px, gy + 0.1, pz, 5, 0xffe0a0, 4);
                    this.emit && this.emit('drop', px);
                }
            } else if (d.state === 'stuck') {
                if (d.t > 7) o.position.y -= dt * 0.25;
                if (d.t > 10) d.state = 'gone';
            } else if (d.state === 'sink') {
                o.position.y -= dt * 0.9; o.rotation.z += dt * 2;
                if (d.t > 1.2) d.state = 'gone';
            }
        }
        this.dropped = this.dropped.filter(d => { if (d.state === 'gone') { d.obj.removeFromParent(); return false; } return true; });
    }

    // ---- per-frame sync with the game state ----------------------------------------------------------------------------
    sync(G, dt, view) {
        this.clock += dt;
        const t = this.clock;
        const units = G.player ? [G.player, ...G.bots] : [];
        if (G.player) this.lastPlayerId = G.player.id;
        const live = new Set();

        // Mundos
        for (const u of units) {
            live.add(u.id);
            let e = this.mundos.get(u.id);
            if (!e) {
                const m = new Mundo(this.kit, u.team, u.team === 0 ? 'player' : u.L.tier);
                m.onStep = () => {
                    const r = m.root.position;
                    this.dust(r.x, r.z, 2, 0.35);
                    if (u.team === 0 && this.emit) this.emit('step', r.x);
                };
                this.scene.add(m.root);
                e = { m, unit: u, spawnT: view.instantSpawn ? 1 : u.team === 0 ? -0.25 : -(0.55 + Math.random() * 0.9), landed: !!view.instantSpawn, diedAt: null, dustDone: false };
                this.mundos.set(u.id, e);
            }
            const x = wx(u.x), z = wz(u.y), gy = heightAt(x, z);
            let y = gy;
            if (!e.landed) { // drop in from the sky
                e.spawnT += dt;
                const k = Math.max(0, Math.min(1, e.spawnT / 0.55));
                y = gy + 9 * (1 - k * k);
                e.m.root.visible = e.spawnT > 0;
                if (k >= 1) {
                    e.landed = true;
                    this.dust(x, z, 22, 1.2); this.shockwave(x, z, u.team === 0 ? 0x7fb2ff : 0xff7a6a, 2.6, 0.5);
                    this.addShake(0.35);
                    this.emit && this.emit('land', x);
                    if (u.team === 1 || G.mode !== 'menu') setTimeout(() => e.m.triggerFlex(), 150 + Math.random() * 300);
                }
            }
            if (e.m.dead && !e.dustDone && e.m.deathT > 0.75) { e.dustDone = true; this.dust(x, z, 18, 1.1); this.addShake(0.3); this.emit && this.emit('thud', x); }
            e.m.update(dt, { x, y, z, face: u.face, ready: u.qcd <= 0 });
            if (u.dead && u.team === 0) e.m.root.position.y = Math.max(e.m.root.position.y, gy - 0.05); // the player's body stays
        }
        for (const [id, e] of this.mundos) {
            if (live.has(id)) continue;
            if (!e.m.dead || e.m.deathT > 3.4) { // vanished (new game) or finished sinking
                if (!e.m.dead) this.dust(e.m.root.position.x, e.m.root.position.z, 10, 0.8);
                e.m.dispose(); this.mundos.delete(id); continue;
            }
            e.m.update(dt, { x: e.m.root.position.x, y: heightAt(e.m.root.position.x, e.m.root.position.z), z: e.m.root.position.z, face: 0, ready: false });
        }

        // grass bends away from Mundos
        const uu = this.grassU.uUnits.value; let k = 0;
        for (const [, e] of this.mundos) { if (k >= 6) break; const p = e.m.root.position; if (e.m.dead && e.m.deathT > 1) continue; uu[k++].set(p.x, p.z, 1.15); }
        for (; k < 6; k++) uu[k].set(0, 0, -1);

        // flying cleavers
        const seen = new Set();
        for (const c of G.cleavers) {
            seen.add(c.id);
            const f = this.flying.get(c.id) || this.makeFlying(c);
            const x = wx(c.x), z = wz(c.y);
            f.obj.position.set(x, CLEAVER_Y, z);
            f.obj.rotation.y += f.spin * 26 * dt;
            f.obj.rotation.z = 0.22;
            f.hist.unshift({ x, y: CLEAVER_Y, z }); if (f.hist.length > f.N) f.hist.pop();
            this.updateTrail(f);
            if (Math.random() < 0.5) this.addFx.emit({ x: x + rand(-0.1, 0.1), y: CLEAVER_Y, z: z + rand(-0.1, 0.1), life: 0.25, size: 0.12, size1: 0.02,
                color: c.team === 0 ? new THREE.Color(0x9fd0ff) : new THREE.Color(0xff7050), alpha: 0.7, drag: 2 });
        }
        for (const id of [...this.flying.keys()]) if (!seen.has(id)) this.removeFlying(id);
        this.updateDropped(dt);

        // aim indicator + click marker
        const p = G.player;
        const showAim = p && !p.dead && (G.mode === 'play' || G.mode === 'intro') && view.aim;
        this.aim.visible = !!showAim;
        if (showAim) {
            const x = wx(p.x), z = wz(p.y), ang = Math.atan2(view.aim.y - p.y, view.aim.x - p.x);
            this.aim.position.set(x + Math.cos(ang) * 0.7, heightAt(x, z) + 0.07, z + Math.sin(ang) * 0.7);
            this.aim.rotation.y = -ang;
            this.aim.scale.set(780 * K - 0.7, 1, 0.68);
            const ready = p.qcd <= 0 && G.mode === 'play';
            this.aimU.uReady.value += ((ready ? 1 : 0) - this.aimU.uReady.value) * Math.min(1, dt * 12);
            this.aimU.uLen.value = 19;
        }
        if (this.markerT < 1) {
            this.markerT += dt / 0.5;
            const s = 1.3 - 0.75 * Math.min(1, this.markerT * 1.4);
            this.marker.scale.setScalar(s * 0.55);
            this.markerMat.opacity = Math.max(0, 1 - this.markerT) * 0.95;
            this.marker.visible = this.markerT < 1;
            this.marker.rotation.y += dt * 2;
        }

        // ambient: braziers, fire, embers, smoke
        for (const b of this.braziers) {
            const fl = 0.75 + Math.sin(t * 13 + b.seed) * 0.08 + Math.sin(t * 7.3 + b.seed * 2) * 0.1 + Math.random() * 0.08;
            b.light.intensity = 22 * fl;
            const fire = new THREE.Color(0xffd27a), fire1 = new THREE.Color(0xff3a08);
            for (let i = 0; i < 3; i++) this.addFx.emit({ x: b.x + rand(-0.22, 0.22), y: b.y, z: b.z + rand(-0.22, 0.22), vx: rand(-0.2, 0.2), vy: rand(1.2, 2.4), vz: rand(-0.2, 0.2),
                life: rand(0.35, 0.75), size: rand(0.35, 0.6), size1: 0.06, color: fire, color1: fire1, alpha: 0.8, drag: 0.5 });
            if (Math.random() < 0.25) this.addFx.emit({ x: b.x + rand(-0.2, 0.2), y: b.y + 0.3, z: b.z + rand(-0.2, 0.2), vx: rand(-0.6, 0.6), vy: rand(1.5, 3), vz: rand(-0.6, 0.6),
                life: rand(1, 2), size: 0.06, size1: 0.02, color: fire, color1: fire1, drag: 0.4 });
            if (Math.random() < 0.3) this.normFx.emit({ x: b.x + rand(-0.15, 0.15), y: b.y + 0.7, z: b.z + rand(-0.15, 0.15), vx: rand(-0.2, 0.3), vy: rand(0.6, 1.0), vz: rand(-0.2, 0.2),
                life: rand(1.6, 2.6), size: 0.4, size1: 1.6, color: new THREE.Color(0x3a3530), alpha: 0.16, drag: 0.2 });
        }
        const gfn = (x, z) => heightAt(x, z);
        this.addFx.update(dt, gfn);
        this.normFx.update(dt, gfn, (x, y, z) => { if (Math.random() < 0.5) this.decal(x, z, rand(0.18, 0.4)); });

        for (const r of this.rings) {
            r.t += dt; const k2 = Math.min(1, r.t / r.dur);
            r.m.scale.setScalar(0.3 + r.size * (1 - Math.pow(1 - k2, 3)));
            r.m.material.opacity = 0.9 * (1 - k2);
        }
        this.rings = this.rings.filter(r => { if (r.t >= r.dur) { r.m.removeFromParent(); r.m.material.dispose(); return false; } return true; });
        for (const r of this.ripples) { r.t += dt; r.m.scale.setScalar(0.2 + r.t * 1.6); r.m.material.opacity = 0.55 * Math.max(0, 1 - r.t / 1.1); }
        this.ripples = this.ripples.filter(r => { if (r.t > 1.1) { r.m.removeFromParent(); r.m.material.dispose(); return false; } return true; });
        for (const d of this.decals) { d.t += dt; if (d.t > 14) d.m.material.opacity = Math.max(0, 1 - (d.t - 14) / 4); }
        this.decals = this.decals.filter(d => { if (d.t > 18) { d.m.removeFromParent(); d.m.material.dispose(); return false; } return true; });
        for (const f of this.fxLights) {
            if (f.t >= 1) { f.l.intensity = 0; continue; }
            f.t = Math.min(1, f.t + dt / f.dur); f.l.intensity = f.peak * Math.pow(1 - f.t, 2);
        }

        // uniforms
        this.waterU.uTime.value = t; this.grassU.uTime.value = t; this.bannerU.uTime.value = t; this.moteU.uTime.value = t; this.aimU.uTime.value = t;

        // camera. Menu: slow cinematic orbit low over the valley. Game over: push in on the fallen player. Otherwise the
        // fitted gameplay view with a gentle drift toward the player, trauma shake and a zoom punch on kills. The
        // camera eases between these so pressing Play swoops down into the arena.
        this.shake = Math.max(0, this.shake - dt * 1.8);
        this.zoomPunch = Math.max(0, this.zoomPunch - dt * 2.5);
        const s2 = this.shake * this.shake, px = p ? wx(p.x) : 0, pz = p ? wz(p.y) : 0;
        const ox = (TX.vnoise(t * 22, 1) - 0.5) * s2 * 0.9, oy = (TX.vnoise(t * 22, 7) - 0.5) * s2 * 0.6, oz = (TX.vnoise(t * 22, 13) - 0.5) * s2 * 0.9;
        const wantPos = this.tmpPos || (this.tmpPos = new THREE.Vector3()), wantLook = this.tmpLook || (this.tmpLook = new THREE.Vector3());
        let ease = 2.2;
        if (G.mode === 'menu') {
            const a = t * 0.045 + 0.6;
            wantPos.set(Math.sin(a) * 25, 9.5 + Math.sin(t * 0.11) * 1.5, Math.cos(a) * 21);
            wantLook.set(0, 1.4, 0);
            ease = 1.2;
        } else if (G.mode === 'over' && p) {
            const k = Math.min(1, (p.deathT || 0) / 5);
            wantPos.set(px + 5 - k * 1.5, 11 - k * 2.5, pz + 11 - k * 2.5);
            wantLook.set(px + 3.2 - k * 0.6, 0.6, pz);   // body sits left of the results panel
            ease = 1.0;
        } else {
            wantPos.set(this.camBase.x + px * 0.06, this.camBase.y, this.camBase.z + pz * 0.04);
            wantLook.set(this.camTarget.x + px * 0.054, this.camTarget.y, this.camTarget.z + pz * 0.036);
            if (this.camMode !== 'game') ease = 2.0;
            else ease = 30;   // locked on (no lag while playing)
        }
        const mode = G.mode === 'menu' ? 'menu' : G.mode === 'over' ? 'over' : 'game';
        if (!this.camPos) { this.camPos = wantPos.clone(); this.camLook = wantLook.clone(); }
        if (mode !== this.camMode) { this.camMode = mode; this.camBlend = 0; }
        this.camBlend = Math.min(1, (this.camBlend || 0) + dt * 0.5);
        const kc = 1 - Math.exp(-dt * (this.camBlend < 1 && mode === 'game' ? 2.6 : ease));
        this.camPos.lerp(wantPos, dt > 0 ? kc : 0); this.camLook.lerp(wantLook, dt > 0 ? kc : 0);
        if (mode === 'game' && this.camBlend >= 1) { this.camPos.copy(wantPos); this.camLook.copy(wantLook); }
        const cam = this.camera;
        cam.position.set(this.camPos.x + ox, this.camPos.y + oy, this.camPos.z + oz);
        cam.lookAt(this.camLook.x + ox * 0.9, this.camLook.y, this.camLook.z + oz * 0.9);
        const fov = 34 - this.zoomPunch * 1.6;
        if (Math.abs(cam.fov - fov) > 0.001) { cam.fov = fov; cam.updateProjectionMatrix(); }

        // post grade
        this.damage = Math.max(0, this.damage - dt * 2.2);
        this.flashWhite = Math.max(0, this.flashWhite - dt * 0.6);
        const hpK = p && !p.dead ? p.hp / p.maxHp : 1;
        this.lowHp += ((hpK <= 0.4 && G.mode === 'play' ? 1 : 0) - this.lowHp) * Math.min(1, dt * 3);
        const gu = this.grade.uniforms;
        gu.uDamage.value = this.damage * 0.85; gu.uLow.value = this.lowHp; gu.uTime.value = t; gu.uFlash.value = this.flashWhite;
        gu.uSat.value = G.mode === 'over' || G.mode === 'paused' ? 0.45 : 1.08;
    }

    showMarker(lx, ly) {
        const x = wx(lx), z = wz(ly);
        this.marker.position.set(x, heightAt(x, z) + 0.06, z);
        this.markerT = 0; this.marker.visible = true;
    }

    render() { this.composer.render(); }

    compile() { try { this.renderer.compile(this.scene, this.camera); } catch (e) { /* optional warm-up */ } }
}
