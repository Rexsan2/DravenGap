// desktop-app/dodgeball-audio.js
// Mundo Dodgeball sound: everything is synthesised with WebAudio (no sound files). Effects are panned by arena x
// (pan -1..1). A quiet river + wind bed plays while the view is open and the context is suspended when it closes.

export function createAudio(initialMuted) {
    let ctx = null, master = null, sfxBus = null, ambBus = null, noiseBuf = null, ambNodes = null;
    let muted = !!initialMuted, wantAmbience = false;

    function ensure() {
        if (ctx) return ctx;
        try {
            ctx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) { return null; }
        master = ctx.createGain(); master.gain.value = muted ? 0 : 0.9;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
        master.connect(comp).connect(ctx.destination);
        sfxBus = ctx.createGain(); sfxBus.gain.value = 1; sfxBus.connect(master);
        ambBus = ctx.createGain(); ambBus.gain.value = 0; ambBus.connect(master);
        const n = ctx.sampleRate * 2;
        noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
        return ctx;
    }
    function ready() {
        if (muted) return null;
        const a = ensure(); if (!a) return null;
        if (a.state === 'suspended') a.resume().catch(() => {});
        return a;
    }
    function out(pan) {
        if (!pan || !ctx.createStereoPanner) return sfxBus;
        const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); p.connect(sfxBus);
        return p;
    }
    function env(g, t, peak, attack, decay) {
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(peak, t + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    }
    function osc(type, f0, f1, dur, peak, dest, delay, attack) {
        const t = ctx.currentTime + (delay || 0);
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = type; o.frequency.setValueAtTime(f0, t);
        if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
        env(g, t, peak, attack || 0.005, dur);
        o.connect(g).connect(dest); o.start(t); o.stop(t + dur + 0.05);
        return o;
    }
    function noise(dur, peak, dest, filter, delay, attack) {
        const t = ctx.currentTime + (delay || 0);
        const s = ctx.createBufferSource(), g = ctx.createGain();
        s.buffer = noiseBuf; s.loop = true;
        let node = s;
        if (filter) {
            const f = ctx.createBiquadFilter();
            f.type = filter.type; f.Q.value = filter.q || 0.8;
            f.frequency.setValueAtTime(filter.f0, t);
            if (filter.f1) f.frequency.exponentialRampToValueAtTime(filter.f1, t + dur);
            node.connect(f); node = f;
        }
        env(g, t, peak, attack || 0.004, dur);
        node.connect(g).connect(dest);
        s.start(t, Math.random()); s.stop(t + dur + 0.05);
    }

    const chord = (notes, type, dur, vol, spread) => notes.forEach((f, i) => osc(type, f, 0, dur, vol, sfxBus, i * (spread || 0)));

    const SFX = {
        throw(pan) {
            const o = out(pan);
            noise(0.26, 0.22, o, { type: 'bandpass', f0: 3200, f1: 500, q: 1.4 }, 0, 0.03);
            osc('triangle', 2600, 2400, 0.09, 0.025, o, 0.01);
        },
        chop(pan) {   // player cleaver lands on a bot
            const o = out(pan);
            noise(0.07, 0.5, o, { type: 'highpass', f0: 1800 });
            osc('sine', 160, 45, 0.22, 0.55, o);
            noise(0.18, 0.22, o, { type: 'bandpass', f0: 420, f1: 220, q: 2 }, 0.02);
        },
        hurt(pan) {   // the player gets hit
            const o = out(pan);
            noise(0.09, 0.55, o, { type: 'highpass', f0: 1200 });
            osc('sine', 120, 38, 0.32, 0.7, o);
            const t = ctx.currentTime, so = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
            so.type = 'sawtooth'; so.frequency.setValueAtTime(140, t); so.frequency.exponentialRampToValueAtTime(78, t + 0.35);
            f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 3;
            env(g, t, 0.16, 0.02, 0.35);
            so.connect(f).connect(g).connect(o); so.start(t); so.stop(t + 0.45);
        },
        kill(pan) {
            const o = out(pan);
            osc('sine', 90, 30, 0.7, 0.7, o);
            noise(0.6, 0.25, o, { type: 'lowpass', f0: 900, f1: 120 }, 0.03, 0.02);
            osc('sawtooth', 180, 60, 0.6, 0.06, o, 0.05, 0.05);
        },
        flash(pan) {
            const o = out(pan);
            osc('sine', 500, 2600, 0.16, 0.18, o);
            noise(0.22, 0.12, o, { type: 'highpass', f0: 4000 }, 0, 0.01);
            osc('triangle', 1800, 900, 0.25, 0.05, o, 0.04);
        },
        drop(pan) {   // cleaver bites into the dirt
            const o = out(pan);
            noise(0.08, 0.3, o, { type: 'lowpass', f0: 700 });
            osc('triangle', 1900, 1500, 0.12, 0.05, o, 0.005);
            osc('sine', 110, 60, 0.12, 0.2, o);
        },
        splash(pan) {
            const o = out(pan);
            noise(0.5, 0.3, o, { type: 'lowpass', f0: 2400, f1: 250 }, 0, 0.01);
            noise(0.25, 0.12, o, { type: 'bandpass', f0: 1500, f1: 3000, q: 3 }, 0.05);
        },
        dodge(pan) { const o = out(pan); noise(0.2, 0.08, o, { type: 'bandpass', f0: 1800, f1: 900, q: 2 }, 0, 0.04); osc('sine', 880, 1320, 0.12, 0.05, o, 0.05); },
        land(pan) { const o = out(pan); osc('sine', 75, 32, 0.45, 0.6, o); noise(0.35, 0.22, o, { type: 'lowpass', f0: 600, f1: 90 }, 0, 0.01); },
        thud(pan) { const o = out(pan); osc('sine', 60, 30, 0.35, 0.45, o); noise(0.25, 0.15, o, { type: 'lowpass', f0: 400, f1: 80 }); },
        step(pan) { const o = out(pan); noise(0.05, 0.035, o, { type: 'lowpass', f0: 500 }); },
        round() {
            chord([196, 294], 'sawtooth', 0.5, 0.05);
            const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900; f.connect(sfxBus);
            osc('sawtooth', 98, 0, 0.9, 0.08, f, 0, 0.08);
        },
        fight() { osc('square', 392, 0, 0.12, 0.05, sfxBus); osc('square', 587, 0, 0.3, 0.05, sfxBus, 0.12); osc('sine', 98, 49, 0.5, 0.4, sfxBus); },
        announce() { chord([523, 659, 784, 1046], 'triangle', 0.5, 0.06, 0.05); osc('sine', 131, 65, 0.6, 0.3, sfxBus); },
        clear() { [523, 659, 784, 1046].forEach((f, i) => osc('triangle', f, 0, 0.35, 0.08, sfxBus, i * 0.09)); },
        lose() { [392, 311, 262, 196].forEach((f, i) => osc('sawtooth', f, f * 0.97, 0.45, 0.05, sfxBus, i * 0.17)); osc('sine', 80, 30, 1.2, 0.4, sfxBus, 0.5); },
        combo(level) { osc('triangle', 660 * Math.pow(1.06, Math.min(level, 12)), 0, 0.12, 0.05, sfxBus); },
        click() { osc('triangle', 1200, 900, 0.05, 0.05, sfxBus); }
    };

    function startAmbience() {
        if (ambNodes || !ctx) return;
        const mk = (f0, q, gain, lfoRate) => {
            const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
            const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = f0; f.Q.value = q;
            const g = ctx.createGain(); g.gain.value = gain;
            const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = lfoRate; lg.gain.value = f0 * 0.35;
            lfo.connect(lg).connect(f.frequency);
            s.connect(f).connect(g).connect(ambBus); s.start(); lfo.start();
            return [s, lfo];
        };
        ambNodes = [...mk(900, 0.7, 0.05, 0.31), ...mk(2200, 1.5, 0.018, 0.53), ...mk(260, 0.5, 0.06, 0.07)];
    }

    return {
        get muted() { return muted; },
        unlock() { if (ready()) { if (wantAmbience) this.ambience(true); } },
        setMuted(m) {
            muted = !!m;
            if (ctx) master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.05);
            if (!muted) this.unlock();
        },
        ambience(on) {
            wantAmbience = on;
            if (!ctx) { if (on && !muted) ready(); if (!ctx) return; }
            if (on && !muted) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); startAmbience(); ambBus.gain.setTargetAtTime(0.55, ctx.currentTime, 0.8); }
            else ambBus.gain.setTargetAtTime(0, ctx.currentTime, 0.2);
        },
        suspend() { if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {}); },
        play(name, pan, arg) {
            if (!ready() || !SFX[name]) return;
            try { SFX[name](name === 'combo' ? arg : pan); } catch (e) { /* audio is best effort */ }
        }
    };
}
