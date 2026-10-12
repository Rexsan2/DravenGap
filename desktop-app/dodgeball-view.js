// desktop-app/dodgeball-view.js  (ES module)
// Mundo Dodgeball: a 3D queue-time minigame rendered into #dodgeball-root. This file owns the DOM (HUD, screens,
// overlay canvas for health bars / combat text), input, the game loop and audio cues. Rules live in dodgeball-game.js
// and the three.js world in dodgeball-scene.js, which is imported lazily the first time the view opens so the rest of
// the app never pays for it. The loop only runs while the view is visible and the game pauses on window blur.
import * as Game from './dodgeball-game.js';
import { createAudio } from './dodgeball-audio.js';

const root = document.getElementById('dodgeball-root');
const DD = window.DD;

if (root && DD) init();

function init() {
    const STORE = { best: 'dd.dodgeball.best', mute: 'dd.dodgeball.mute', quality: 'dd.dodgeball.quality', autoLow: 'dd.dodgeball.autolow' };
    const store = {
        get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
        set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
    };
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmt = n => Math.round(n).toLocaleString('en-US');
    const rand = (a, b) => a + Math.random() * (b - a);
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];

    // ---- DOM -------------------------------------------------------------------------------------------------------
    root.innerHTML = `
    <div class="db-wrap">
        <div class="db-bar">
            <div class="db-title"><img class="db-icon" data-img="champ" alt="">Mundo Dodgeball</div>
            <div class="db-keys"><kbd>Right-click</kbd>/<kbd>WASD</kbd> move <kbd>Q</kbd>/<kbd>Left-click</kbd> cleaver <kbd>F</kbd> Flash <kbd>Esc</kbd> pause</div>
            <div class="db-best">Best <b data-k="best">0</b></div>
            <button class="db-btn" data-act="quality" title="Graphics quality"></button>
            <button class="db-btn" data-act="mute" title="Sound (M)"></button>
            <button class="db-btn" data-act="restart">Restart</button>
        </div>
        <div class="db-stage" tabindex="-1">
            <canvas class="db-gl"></canvas>
            <canvas class="db-fx"></canvas>
            <div class="db-hud">
                <div class="db-hud-tl">
                    <div class="db-score"><span class="db-score-num" data-k="score">0</span><span class="db-score-lbl">Score</span></div>
                    <div class="db-combo" data-k="combo"></div>
                </div>
                <div class="db-hud-tc">
                    <div class="db-round">Round <b data-k="round">1</b></div>
                    <div class="db-pips" data-k="pips"></div>
                </div>
                <div class="db-hud-tr">
                    <div><span>Accuracy</span><b data-k="acc">0%</b></div>
                    <div><span>Kills</span><b data-k="kills">0</b></div>
                    <div><span>Dodged</span><b data-k="dodged">0</b></div>
                </div>
                <div class="db-hud-bottom">
                    <div class="db-portrait"><img data-img="champ" alt=""><span class="db-lvl" data-k="lvl">1</span></div>
                    <div class="db-bars">
                        <div class="db-abilities">
                            <div class="db-ab" data-ab="q"><div class="db-ab-fallback">Q</div><img data-img="q" alt=""><div class="db-cd"></div><span class="db-cdtext"></span><kbd>Q</kbd></div>
                            <div class="db-ab" data-ab="f"><div class="db-ab-fallback">F</div><img data-img="flash" alt=""><div class="db-cd"></div><span class="db-cdtext"></span><kbd>F</kbd></div>
                        </div>
                        <div class="db-hp"><div class="db-hp-trail"></div><div class="db-hp-fill"></div><div class="db-hp-ticks"></div><span class="db-hp-text" data-k="hp">100 / 100</span></div>
                    </div>
                </div>
            </div>
            <div class="db-announce"><div class="db-ann-main"></div><div class="db-ann-sub"></div></div>
            <div class="db-toast"></div>
            <div class="db-screen" data-screen="loading">
                <div class="db-panel db-loading"><div class="db-spinner"></div><div>Sharpening cleavers…</div></div>
                <div class="db-panel db-menu">
                    <img class="db-menu-art" data-img="champ" alt="">
                    <h1>Mundo Dodgeball</h1>
                    <p class="db-tag">Mundo goes where he pleases. Except across the river.</p>
                    <div class="db-controls">
                        <div><span class="db-keyset"><kbd>Right-click</kbd><kbd>WASD</kbd></span><span>Move</span></div>
                        <div><span class="db-keyset"><kbd>Q</kbd><kbd>Left-click</kbd></span><span>Throw a cleaver at the cursor</span></div>
                        <div><span class="db-keyset"><kbd>F</kbd></span><span>Flash toward the cursor</span></div>
                        <div><span class="db-keyset"><kbd>Esc</kbd></span><span>Pause</span></div>
                    </div>
                    <p class="db-tip">Hits refund half your cooldown and chain into a combo multiplier. Every round brings tougher Mundos.</p>
                    <button class="db-cta" data-act="play">Play</button>
                    <div class="db-menu-best">Best score <b data-k="best2">0</b></div>
                </div>
                <div class="db-panel db-paused">
                    <h2>Paused</h2>
                    <button class="db-cta" data-act="resume">Resume</button>
                    <button class="db-btn db-btn-wide" data-act="restart">Restart</button>
                </div>
                <div class="db-panel db-over">
                    <h2 class="db-over-title">Mundo has fallen</h2>
                    <div class="db-over-score"><span data-k="finalScore">0</span><em data-k="newBest">New best!</em></div>
                    <div class="db-over-stats" data-k="overStats"></div>
                    <button class="db-cta" data-act="play">Queue again</button>
                </div>
                <div class="db-panel db-error"><h2>Couldn't start the 3D arena</h2><p data-k="err"></p></div>
            </div>
        </div>
    </div>`;
    const $ = sel => root.querySelector(sel);
    const K = new Proxy({}, { get: (_, k) => root.querySelector(`[data-k="${k}"]`) });
    const stage = $('.db-stage'), glCanvas = $('.db-gl'), fx = $('.db-fx'), fctx = fx.getContext('2d');
    const screen = $('.db-screen'), hud = $('.db-hud');
    const abQ = $('[data-ab="q"]'), abF = $('[data-ab="f"]');
    const hpFill = $('.db-hp-fill'), hpTrail = $('.db-hp-trail');

    // ---- state -----------------------------------------------------------------------------------------------------
    const G = Game.createGame();
    const audio = createAudio(store.get(STORE.mute, false));
    let scene = null, booting = false, active = false, raf = 0, last = 0;
    let quality = store.get(STORE.quality, 'high') === 'low' ? 'low' : 'high';
    let best = Number(store.get(STORE.best, 0)) || 0, newBest = false;
    let hitStop = 0, slowT = 0, slowDur = 1, slowScale = 1, hpTrailV = 1;
    const perf = { t: 0, frames: 0, sum: 0, done: !!store.get(STORE.autoLow, false) || quality === 'low' };
    const input = { keys: new Set(), rmb: false, mouse: null };
    const floaters = [], bubbles = [];
    const view = { aim: null, ground: null, instantSpawn: false };
    const AIM_Y = 1.6;   // matches the scene's chest-height aim plane

    // ---- small UI helpers ------------------------------------------------------------------------------------------
    function setScreen(name) { screen.dataset.screen = name || ''; hud.classList.toggle('on', !name || name === 'paused'); }
    function paintBest() { K.best.textContent = fmt(best); K.best2.textContent = fmt(best); }
    function paintButtons() {
        $('[data-act="mute"]').textContent = audio.muted ? 'Sound: off' : 'Sound: on';
        $('[data-act="quality"]').textContent = quality === 'high' ? 'Graphics: High' : 'Graphics: Low';
    }
    let toastTimer = 0;
    function toast(text) { const t = $('.db-toast'); t.textContent = text; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 3600); }

    const annQ = []; let annBusy = 0;
    function announce(main, sub, cls, prio) {
        if (prio) annQ.unshift({ main, sub, cls }); else annQ.push({ main, sub, cls });
        if (!annBusy) nextAnnounce();
    }
    function nextAnnounce() {
        const a = annQ.shift();
        if (!a) { annBusy = 0; return; }
        const el = $('.db-announce');
        el.className = 'db-announce';
        void el.offsetWidth;                          // restart the CSS animation
        el.querySelector('.db-ann-main').textContent = a.main;
        el.querySelector('.db-ann-sub').textContent = a.sub || '';
        el.classList.add('on'); if (a.cls) el.classList.add(a.cls);
        annBusy = setTimeout(() => { annBusy = 0; nextAnnounce(); }, 1350);
    }
    function clearAnnounce() { annQ.length = 0; clearTimeout(annBusy); annBusy = 0; $('.db-announce').className = 'db-announce'; }

    function floatText(lx, ly, h, text, color, size, opt) {
        floaters.push(Object.assign({ lx, ly, h, text, color, size: size || 22, t: 0, life: 1.1, rise: 1.3, drift: rand(-14, 14) }, opt || {}));
    }
    function say(unit, text) {
        for (let i = bubbles.length - 1; i >= 0; i--) if (bubbles[i].unit === unit) bubbles.splice(i, 1);
        bubbles.push({ unit, text, t: 0, life: 2.4 });
    }

    function loadImages() {
        const v = DD.getLatestPatch && DD.getLatestPatch();
        if (!v) return;
        const src = {
            champ: `${DD.ddragonBase}/cdn/${v}/img/champion/DrMundo.png`,
            q: `${DD.ddragonBase}/cdn/${v}/img/spell/DrMundoQ.png`,
            flash: `${DD.ddragonBase}/cdn/${v}/img/spell/SummonerFlash.png`
        };
        root.querySelectorAll('img[data-img]').forEach(img => {
            if (img.dataset.loaded) return;
            img.dataset.loaded = '1';
            img.onload = () => img.classList.add('ok');
            img.onerror = () => img.classList.remove('ok');
            img.src = src[img.dataset.img];
        });
    }

    // ---- HUD (only touches the DOM when a value changes) ---------------------------------------------------------------
    const prev = {};
    function setText(key, v) { if (prev[key] !== v) { prev[key] = v; K[key].textContent = v; } }
    function setStyle(el, key, prop, v) { if (prev[key] !== v) { prev[key] = v; el.style.setProperty(prop, v); } }
    function paintHud(dt) {
        const p = G.player; if (!p) return;
        setText('score', fmt(G.score));
        setText('round', String(G.round + 1));
        setText('lvl', String(G.round + 1));
        setText('acc', (G.thrown ? Math.round(100 * G.landed / G.thrown) : 0) + '%');
        setText('kills', String(G.kills));
        setText('dodged', String(G.dodged));
        const comboTxt = G.combo > 1 ? `${G.combo} hit combo  ·  x${(1 + Math.min(G.combo - 1, 9) * 0.25).toFixed(2)}` : '';
        if (prev.combo !== comboTxt) {
            prev.combo = comboTxt; K.combo.textContent = comboTxt;
            K.combo.classList.toggle('on', !!comboTxt);
            if (comboTxt) { K.combo.classList.remove('pop'); void K.combo.offsetWidth; K.combo.classList.add('pop'); }
        }
        const pipSig = G.bots.map(b => (b.dead ? 'x' : b.L.tier)).join(',');
        if (prev.pips !== pipSig) {
            prev.pips = pipSig;
            K.pips.innerHTML = G.bots.map(b => `<span class="db-pip ${b.dead ? 'dead' : ''}" style="--c:${b.L.color}" title="${esc(b.L.name)}"></span>`).join('');
        }
        const hpK = Math.max(0, p.hp / p.maxHp);
        hpTrailV = hpTrailV > hpK ? Math.max(hpK, hpTrailV - dt * 0.6) : hpK;
        setStyle(hpFill, 'hpw', 'width', (hpK * 100).toFixed(2) + '%');
        setStyle(hpTrail, 'hpt', 'width', (hpTrailV * 100).toFixed(2) + '%');
        if (prev.low !== (hpK <= 0.4)) { prev.low = hpK <= 0.4; hpFill.classList.toggle('low', prev.low); }
        setText('hp', `${Math.ceil(p.hp)} / ${p.maxHp}`);
        paintAbility(abQ, 'q', p.qcd, p.qMax);
        paintAbility(abF, 'f', p.fcd, Game.FLASH_CD);
    }
    function paintAbility(el, key, cd, max) {
        const frac = cd > 0 ? cd / max : 0;
        setStyle(el, key + 'p', '--p', frac.toFixed(3));
        const txt = cd > 0 ? (cd >= 1 ? String(Math.ceil(cd)) : cd.toFixed(1)) : '';
        if (prev[key + 't'] !== txt) {
            const was = prev[key + 't'];
            prev[key + 't'] = txt; el.querySelector('.db-cdtext').textContent = txt;
            el.classList.toggle('cooling', !!txt);
            if (!txt && was) { el.classList.remove('ready'); void el.offsetWidth; el.classList.add('ready'); }
        }
    }

    // ---- overlay canvas: health bars, combat text, speech ----------------------------------------------------------
    let fxW = 1, fxH = 1, fxDpr = 1;
    function resize() {
        const r = stage.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) return;
        fxW = r.width; fxH = r.height; fxDpr = window.devicePixelRatio || 1;
        fx.width = Math.round(fxW * fxDpr); fx.height = Math.round(fxH * fxDpr);
        if (scene) scene.resize(Math.round(fxW), Math.round(fxH));
    }
    const ro = new ResizeObserver(() => { if (active) resize(); });
    ro.observe(stage);

    function rr(x, y, w, h, r) { fctx.beginPath(); fctx.roundRect(x, y, w, h, r); }
    function outlined(text, x, y, size, color, weight, align) {
        fctx.font = `${weight || 800} ${size}px "Segoe UI", system-ui, sans-serif`;
        fctx.textAlign = align || 'center'; fctx.textBaseline = 'middle';
        fctx.lineJoin = 'round'; fctx.lineWidth = Math.max(3, size / 5); fctx.strokeStyle = 'rgba(0,0,0,0.85)';
        fctx.strokeText(text, x, y); fctx.fillStyle = color; fctx.fillText(text, x, y);
    }
    function drawOverlay(dt) {
        fctx.setTransform(fxDpr, 0, 0, fxDpr, 0, 0);
        fctx.clearRect(0, 0, fxW, fxH);
        if (!scene || !G.player) return;
        const showBars = G.mode !== 'menu';
        // health bars (LoL style)
        if (showBars) for (const u of [G.player, ...G.bots]) {
            if (u.dead) continue;
            const s = scene.unitScreen(u, 4.1); if (!s) continue;
            const bw = 96, bh = 11, x = Math.round(s.x - bw / 2), y = Math.round(s.y - bh);
            fctx.fillStyle = 'rgba(4,8,12,0.88)'; rr(x - 3, y - 3, bw + 6, bh + 6, 3); fctx.fill();
            fctx.strokeStyle = u.team === 0 ? 'rgba(200,170,110,0.9)' : 'rgba(150,50,50,0.9)'; fctx.lineWidth = 1; rr(x - 2.5, y - 2.5, bw + 5, bh + 5, 3); fctx.stroke();
            const frac = Math.max(0, u.hp / u.maxHp);
            if (u._trail == null || u._trail < frac) u._trail = frac;
            u._trail = Math.max(frac, u._trail - dt * 0.5);
            fctx.fillStyle = 'rgba(255,240,220,0.75)'; fctx.fillRect(x, y, bw * u._trail, bh);
            const g = fctx.createLinearGradient(0, y, 0, y + bh);
            if (u.team === 0) { g.addColorStop(0, '#7ee37e'); g.addColorStop(1, '#2f9a35'); } else { g.addColorStop(0, '#ff6a5e'); g.addColorStop(1, '#b3261e'); }
            fctx.fillStyle = g; fctx.fillRect(x, y, bw * frac, bh);
            fctx.fillStyle = 'rgba(255,255,255,0.18)'; fctx.fillRect(x, y, bw * frac, 3);
            fctx.fillStyle = 'rgba(0,0,0,0.65)';
            for (let hp = 25; hp < u.maxHp; hp += 25) fctx.fillRect(x + Math.round(bw * hp / u.maxHp), y, 1, bh);
            // level-style badge + name
            fctx.fillStyle = 'rgba(4,8,12,0.92)'; rr(x - 24, y - 4, 20, bh + 8, 3); fctx.fill();
            outlined(u.team === 0 ? String(G.round + 1) : u.L.tier[0].toUpperCase(), x - 14, y + bh / 2 + 0.5, 11, u.team === 0 ? '#f0e6d2' : u.L.color, 800);
            outlined(u.team === 0 ? 'You' : u.L.name, s.x, y - 12, 12, u.team === 0 ? '#cfe3ff' : u.L.color, 700);
        }
        // speech bubbles
        for (let i = bubbles.length - 1; i >= 0; i--) {
            const b = bubbles[i]; b.t += dt;
            if (b.t > b.life || (b.unit.dead && b.t > 0.6)) { bubbles.splice(i, 1); continue; }
            const s = scene.unitScreen(b.unit, 4.1); if (!s) continue;
            const a = Math.max(0, Math.min(1, b.t * 6, (b.life - b.t) * 3));
            fctx.globalAlpha = a;
            fctx.font = '700 13px "Segoe UI", system-ui, sans-serif';
            const tw = fctx.measureText(b.text).width + 22, bx = s.x - tw / 2, by = s.y - (showBars ? 62 : 36) - (1 - Math.min(1, b.t * 5)) * 8;
            fctx.fillStyle = 'rgba(246,242,234,0.96)'; rr(bx, by, tw, 26, 13); fctx.fill();
            fctx.beginPath(); fctx.moveTo(s.x - 6, by + 25); fctx.lineTo(s.x + 6, by + 25); fctx.lineTo(s.x, by + 33); fctx.closePath(); fctx.fill();
            fctx.fillStyle = '#1b1320'; fctx.textAlign = 'center'; fctx.textBaseline = 'middle'; fctx.fillText(b.text, s.x, by + 13.5);
            fctx.globalAlpha = 1;
        }
        // floating combat text
        for (let i = floaters.length - 1; i >= 0; i--) {
            const f = floaters[i]; f.t += dt;
            if (f.t > f.life) { floaters.splice(i, 1); continue; }
            const k = f.t / f.life;
            const s = scene.project((f.lx - Game.W / 2) / 40, f.h + k * f.rise, (f.ly - Game.H / 2) / 40); if (!s) continue;
            const pop = f.t < 0.12 ? 0.6 + (f.t / 0.12) * 0.6 : Math.max(1, 1.2 - (f.t - 0.12) * 2);
            fctx.globalAlpha = Math.max(0, Math.min(1, (1 - k) * 2.2));
            outlined(f.text, s.x + f.drift * k, s.y, f.size * pop, f.color, 900);
            fctx.globalAlpha = 1;
        }
    }

    // ---- events from the game -> scene, audio, HUD -------------------------------------------------------------------
    const pan = lx => (lx / Game.W) * 2 - 1;
    const QUIPS = {
        start: ['Mundo goes where he pleases!', 'Mundo is ready!', 'Time for check-up!'],
        kill: ['Mundo smash!', 'Who next?', 'Doctor says: rest.', 'Mundo not even tired!'],
        botSpawn: ['Mundo will get you!', 'Cleaver for you!', 'Mundo is doctor now!', 'Hold still!'],
        botWin: ['Mundo wins!', 'Too slow!', 'Hah! Mundo smash!'],
        hurt: ['Mundo not even hurt!', 'Ow. Mundo angry now.']
    };
    function handleEvents() {
        const evs = G.events.splice(0);
        for (const e of evs) {
            scene.onEvent(e);
            switch (e.type) {
                case 'throw': audio.play('throw', pan(e.unit.x)); break;
                case 'hit':
                    if (e.unit.team === 1) {
                        audio.play('chop', pan(e.unit.x));
                        if (e.combo > 1) audio.play('combo', 0, e.combo);
                        floatText(e.unit.x, e.unit.y, 3.3, `-${e.dmg}`, '#ff8d7a', 26);
                        floatText(e.unit.x, e.unit.y, 4.5, e.combo > 1 ? `+${e.pts}  x${e.mult.toFixed(2)}` : `+${e.pts}`, '#ffd76a', 17, { rise: 1.0, life: 1.2 });
                        hitStop = 0.055;
                    } else {
                        audio.play('hurt', pan(e.unit.x));
                        floatText(e.unit.x, e.unit.y, 3.3, `-${e.dmg}`, '#ff4d4d', 30);
                        hitStop = 0.07;
                        if (e.unit.hp > 0 && Math.random() < 0.25) say(e.unit, pick(QUIPS.hurt));
                    }
                    break;
                case 'kill':
                    audio.play('kill', pan(e.unit.x));
                    if (e.unit.team === 1) {
                        floatText(e.unit.x, e.unit.y, 5.8, `${e.unit.L.name} slain  +${e.bonus}`, '#ffe08a', 18, { life: 1.6, rise: 0.8 });
                        if (e.ace) { slow(0.28, 1.1); announce('ACE', `Round ${G.round + 1} cleared`, 'gold', true); }
                        else if (e.multi >= 2) announce(['', '', 'Double Kill', 'Triple Kill', 'Quadra Kill', 'Pentakill'][Math.min(e.multi, 5)], '', 'red', true);
                        if (Math.random() < 0.45) say(G.player, pick(QUIPS.kill));
                    } else {
                        slow(0.3, 1.4);
                        const killer = e.shooter && !e.shooter.dead ? e.shooter : G.bots.find(b => !b.dead);
                        if (killer) setTimeout(() => say(killer, pick(QUIPS.botWin)), 500);
                    }
                    break;
                case 'flash': audio.play('flash', pan(e.unit.x)); break;
                case 'dodge': audio.play('dodge', pan(e.unit.x)); floatText(e.unit.x, e.unit.y, 4.3, 'Dodged +15', '#8ef0b0', 16, { life: 0.9 }); break;
                case 'comboLost': floatText(G.player.x, G.player.y, 4.5, `Combo lost (${e.combo})`, '#a3a3a3', 14, { life: 1 }); break;
                case 'round': {
                    audio.play('round');
                    announce(`Round ${e.round + 1}`, e.bots.map(b => b.L.name).join('  ·  '), 'round');
                    const speaker = e.bots[Math.floor(Math.random() * e.bots.length)];
                    setTimeout(() => { if (!speaker.dead && G.bots.includes(speaker)) say(speaker, pick(QUIPS.botSpawn)); }, 900);
                    break;
                }
                case 'fight': audio.play('fight'); announce('Fight!', '', 'fight'); break;
                case 'firstBlood': audio.play('announce'); announce('First Blood', '', 'red'); break;
                case 'clear': audio.play('clear'); floatText(G.player.x, G.player.y, 4.9, `Round clear +${e.bonus}`, '#ffe08a', 20, { life: 1.8 }); break;
                case 'over': onGameOver(); break;
                case 'newgame': floaters.length = 0; bubbles.length = 0; setTimeout(() => G.player && !G.player.dead && say(G.player, pick(QUIPS.start)), 700); break;
            }
        }
    }
    function slow(scale, dur) { slowScale = scale; slowT = slowDur = dur; }

    function onGameOver() {
        audio.play('lose');
        newBest = G.score > best;
        if (newBest) { best = G.score; store.set(STORE.best, best); paintBest(); }
        const acc = G.thrown ? Math.round(100 * G.landed / G.thrown) : 0;
        K.overStats.innerHTML = [
            ['Round reached', G.round + 1], ['Mundos slain', G.kills], ['Accuracy', `${acc}%`],
            ['Best combo', `x${G.bestCombo}`], ['Cleavers dodged', G.dodged], ['Best score', fmt(best)]
        ].map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('');
        K.newBest.style.display = newBest ? '' : 'none';
        K.finalScore.textContent = '0';
        setTimeout(() => {
            if (G.mode !== 'over') return;
            setScreen('over');
            const target = G.score, t0 = performance.now();
            const tick = () => { // count the score up
                const k = Math.min(1, (performance.now() - t0) / 900);
                K.finalScore.textContent = fmt(target * (1 - Math.pow(1 - k, 3)));
                if (k < 1 && G.mode === 'over') requestAnimationFrame(tick);
            };
            tick();
        }, 1400);
    }

    // ---- flow ------------------------------------------------------------------------------------------------------
    function startGame() {
        if (!scene) return;
        audio.unlock(); audio.play('click');
        clearAnnounce();
        Game.newGame(G);
        view.instantSpawn = false;
        hpTrailV = 1; newBest = false; hitStop = 0; slowT = 0;
        setScreen(null);
        stage.focus({ preventScroll: true });
    }
    function doPause() { if (G.mode === 'play' || G.mode === 'intro') { Game.pause(G); input.rmb = false; setScreen('paused'); } }
    function doResume() { if (G.mode === 'paused') { Game.resume(G); setScreen(null); audio.unlock(); stage.focus({ preventScroll: true }); } }

    async function boot() {
        if (scene || booting) return;
        booting = true;
        setScreen('loading');
        await new Promise(r => setTimeout(r, 40)); // let the loading screen paint
        try {
            const mod = await import('./dodgeball-scene.js');
            if (DD.ready) await Promise.race([DD.ready, new Promise(r => setTimeout(r, 1500))]); // only icons need it
            scene = new mod.DodgeballScene(glCanvas, quality);
            scene.emit = (name, worldX) => {
                const p = Math.max(-1, Math.min(1, worldX / 16));
                audio.play(name, p * (name === 'step' ? 0.6 : 0.8));
            };
            resize();
            Game.attract(G);
            view.instantSpawn = true;
            scene.sync(G, 0.016, view);
            scene.compile();
            setScreen('menu');
        } catch (e) {
            console.error('Mundo Dodgeball failed to start', e);
            K.err.textContent = (e && e.message) || String(e);
            setScreen('error');
        }
        booting = false;
        if (active && !raf) { last = 0; raf = requestAnimationFrame(frame); }
    }

    function frame(ts) {
        raf = 0;
        if (!active) return;
        const realDt = Math.min(0.05, last ? (ts - last) / 1000 : 0.016);
        last = ts;
        if (scene) {
            // time scaling: a brief hit-stop on impacts, slow motion on the last kill of a round and on death
            let scale = 1;
            if (hitStop > 0) { hitStop -= realDt; scale = 0.06; }
            else if (slowT > 0) { slowT -= realDt; const k = 1 - slowT / slowDur; scale = k < 0.7 ? slowScale : slowScale + (1 - slowScale) * ((k - 0.7) / 0.3); }
            const paused = G.mode === 'paused';
            const dt = paused ? 0 : realDt * scale;

            const p = G.player;
            if (input.mouse) { view.aim = scene.pick(input.mouse.x, input.mouse.y, AIM_Y) || view.aim; view.ground = scene.pick(input.mouse.x, input.mouse.y, 0) || view.ground; }
            if (!view.aim && p) view.aim = { x: p.x + 200, y: p.y };
            let kx = 0, ky = 0;
            if (input.keys.has('KeyA') || input.keys.has('ArrowLeft')) kx--;
            if (input.keys.has('KeyD') || input.keys.has('ArrowRight')) kx++;
            if (input.keys.has('KeyW') || input.keys.has('ArrowUp')) ky--;
            if (input.keys.has('KeyS') || input.keys.has('ArrowDown')) ky++;
            const moveTo = input.rmb && view.ground ? { x: view.ground.x, y: view.ground.y } : null;
            if (dt > 0) Game.update(G, dt, { kx, ky, moveTo, aimX: view.aim ? view.aim.x : 0, aimY: view.aim ? view.aim.y : 0 });
            handleEvents();
            scene.sync(G, dt, view);
            scene.render();
            if (G.mode !== 'menu') paintHud(realDt);
            drawOverlay(paused ? 0 : realDt * Math.max(scale, 0.5));
            autoQuality(realDt);
        }
        raf = requestAnimationFrame(frame);
    }

    // one-time check: if High graphics runs badly in the first seconds of play, drop to Low and say so
    function autoQuality(dt) {
        if (perf.done || G.mode !== 'play') return;
        perf.t += dt; perf.frames++; perf.sum += dt;
        if (perf.t < 5) return;
        perf.done = true; store.set(STORE.autoLow, true);
        if (perf.sum / perf.frames > 0.03) { setQuality('low'); toast('Switched to Low graphics for a smoother game. You can change it in the top bar.'); }
    }
    function setQuality(q) {
        quality = q; store.set(STORE.quality, q); paintButtons();
        if (scene) scene.setQuality(q);
    }

    function activate() {
        active = true;
        loadImages();
        resize();
        audio.ambience(true);
        if (!scene) boot();
        if (!raf) { last = 0; raf = requestAnimationFrame(frame); }
        stage.focus({ preventScroll: true });
    }
    function deactivate() {
        active = false;
        doPause();
        input.keys.clear(); input.rmb = false;
        audio.ambience(false); audio.suspend();
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
    }

    // ---- input -----------------------------------------------------------------------------------------------------
    const playing = () => scene && (G.mode === 'play' || G.mode === 'intro');
    const aimAngle = () => { const p = G.player; return Math.atan2(view.aim.y - p.y, view.aim.x - p.x); };
    stage.addEventListener('contextmenu', e => e.preventDefault());
    stage.addEventListener('mousemove', e => { input.mouse = { x: e.clientX, y: e.clientY }; });
    stage.addEventListener('mousedown', e => {
        input.mouse = { x: e.clientX, y: e.clientY };
        if (e.target.closest('button')) return;
        stage.focus({ preventScroll: true });
        audio.unlock();
        if (!playing()) return;
        view.aim = scene.pick(e.clientX, e.clientY, AIM_Y) || view.aim;
        view.ground = scene.pick(e.clientX, e.clientY, 0) || view.ground;
        if (e.button === 2 && view.ground) { input.rmb = true; scene.showMarker(view.ground.x, view.ground.y); }
        else if (e.button === 0 && view.aim) Game.throwCleaver(G, G.player, aimAngle());
        e.preventDefault();
    });
    window.addEventListener('mouseup', e => { if (e.button === 2) input.rmb = false; });
    window.addEventListener('keydown', e => {
        if (!active) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        const modal = document.getElementById('settings-modal');
        if (modal && modal.style.display && modal.style.display !== 'none') return;
        const code = e.code;
        if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code)) {
            input.keys.add(code); e.preventDefault(); return;
        }
        if (e.repeat) return;
        switch (code) {
            case 'KeyQ': if (playing() && view.aim) Game.throwCleaver(G, G.player, aimAngle()); break;
            case 'KeyF': if (playing() && view.aim) Game.flash(G, G.player, view.aim.x - G.player.x, view.aim.y - G.player.y); break;
            case 'Escape': case 'KeyP': if (G.mode === 'paused') doResume(); else doPause(); break;
            case 'KeyM': audio.setMuted(!audio.muted); store.set(STORE.mute, audio.muted); paintButtons(); break;
            case 'Space': case 'Enter':
                if (G.mode === 'menu' || G.mode === 'over') startGame(); else if (G.mode === 'paused') doResume(); else return;
                break;
            default: return;
        }
        e.preventDefault();
    });
    window.addEventListener('keyup', e => input.keys.delete(e.code));
    window.addEventListener('blur', () => { input.keys.clear(); input.rmb = false; if (active) doPause(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && active) doPause(); });

    root.addEventListener('click', e => {
        const b = e.target.closest('[data-act]'); if (!b) return;
        const act = b.dataset.act;
        if (act === 'play' || act === 'restart') startGame();
        else if (act === 'resume') doResume();
        else if (act === 'mute') { audio.setMuted(!audio.muted); store.set(STORE.mute, audio.muted); paintButtons(); }
        else if (act === 'quality') setQuality(quality === 'high' ? 'low' : 'high');
        b.blur();
    });

    // read-only handle for debugging from DevTools
    Object.defineProperty(window, '__mundoDodgeball', { value: { get game() { return G; }, get scene() { return scene; } } });

    paintBest(); paintButtons();
    if (DD.ready) DD.ready.then(loadImages);
    DD.onView(name => { if (name === 'dodgeball') activate(); else if (active) deactivate(); });
    if (DD.currentView && DD.currentView() === 'dodgeball') activate();
}
