// Game flow bar layout (workflow.js + workflow.css), screenshot-free: at 1100 / 1400 / 1920 px every step of the bar fits in
// 40 px with no horizontal overflow, has exactly one filled (primary) action, collapses to icons when narrow and keeps its
// "..." menu, the review card shows the result / K/D/A / length, and the session shows chips and a W/L dot strip.
const H = require('../lib/renderer-harness');
const R = H.results();

const session = { localPlayerCellId: 0, theirTeam: [{ cellId: 5, championId: 238, championPickIntent: 0 }],
    actions: [[{ actorCellId: 0, type: 'pick', completed: true, championId: 103 }]],
    myTeam: [{ cellId: 0, championId: 103, championPickIntent: 0, assignedPosition: 'middle' }, { cellId: 1, championId: 157, championPickIntent: 0, assignedPosition: 'top' }] };
// two games today, both older than 30 minutes (so the bar is idle until a phase says otherwise); newest first
const games = [
    { q: 420, champId: 145, win: false, k: 12, d: 15, a: 30, at: Date.now() - 4 * 3600e3, dur: 1980 },
    { q: 420, champId: 103, win: true, k: 5, d: 2, a: 7, at: Date.now() - 5 * 3600e3, dur: 1800 }];

// everything the layout checks need, measured in the page
const MEASURE = `(() => {
    const bar = document.getElementById('flow-bar'), br = bar.getBoundingClientRect();
    const kids = [...bar.children].filter(k => !k.classList.contains('fb-msg') && k.getBoundingClientRect().width > 0);
    const rect = sel => { const e = bar.querySelector(sel); return e ? e.getBoundingClientRect() : null; };
    const acts = rect('.fb-acts'), ctx = rect('.fb-ctx'), sess = rect('.fb-session');
    const vis = e => e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0;
    const main = [...bar.querySelectorAll('.fb-act.main')];
    return {
        iw: innerWidth, doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, barScroll: bar.scrollWidth, barClient: bar.clientWidth, h: Math.round(br.height * 10) / 10,
        outside: kids.filter(k => { const r = k.getBoundingClientRect(); return r.right > br.right + 1 || r.left < br.left - 1; }).map(k => k.className),
        overlap: !!(acts && ctx && ctx.right > acts.left + 1) || !!(acts && sess && sess.width && acts.right > sess.left + 1),
        main: main.length, mainKey: main[0] && main[0].dataset.fbAct,
        quiet: [...bar.querySelectorAll('.fb-act:not(.main):not(.fb-more)')].filter(vis).map(b => b.dataset.fbAct),
        labelsShown: [...bar.querySelectorAll('.fb-act:not(.fb-more) .fb-al')].filter(vis).length,
        moreShown: vis(bar.querySelector('.fb-more')),
        steps: [...bar.querySelectorAll('.fb-step')].map(s => s.dataset.fbStep + (s.classList.contains('now') ? ':now' : s.classList.contains('done') ? ':done' : '')).join(',')
    };
})()`;

(async () => {
    try {
        const h = await H.boot({ size: [1100, 800], ipc: {
            'get-champ-select': () => session,
            'profile:me': () => ({ ok: true, me: { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' }, lcu: true, phase: 'None' }),
            'profile:session': () => ({ ok: true, lcu: true, games, w: 1, l: 1, lp: { RANKED_SOLO_5x5: 21 } })
        } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        await h.waitFor(`document.querySelector('#flow-bar .fb-chip')`, 10000);
        const states = [
            ['idle', `DD.flow.onPhase('None')`, `null`],
            ['lobby', `DD.flow.onPhase('Lobby')`, `lobby`],
            ['review', `DD.flow.onPhase('EndOfGame')`, `review`],
            ['game', `DD.flow.state.game = { pick: 'Ahri', locked: true, lane: 'MIDDLE', opp: 'Zed' }; DD.flow.onPhase('InProgress')`, `game`],
            ['select', `DD.flow.onPhase('ChampSelect')`, `select`]
        ];
        const seen = {};
        for (const w of [1100, 1400, 1920]) {
            h.w.setContentSize(w, 800); await h.sleep(500);
            for (const [name, code, step] of states) {
                await h.ev(code + '; 1');
                if (name === 'select') await h.waitFor(`DD.flow.state.st && DD.flow.state.st.pick === 'Ahri' && document.querySelector('[data-fb-act="send"]')`, 8000);
                else await h.sleep(250);
                const m = await h.ev(MEASURE);
                seen[`${name}@${w}`] = m;
                const fit = m.doc <= m.iw && m.body <= m.iw && m.barScroll <= m.barClient && !m.outside.length && !m.overlap;
                R.ok(`${w}px ${name}: no horizontal overflow, nothing outside the bar or overlapping, height <= 40`, fit && m.h <= 40, m);
                R.ok(`${w}px ${name}: exactly one primary action, steps ${step === 'null' ? 'all grey' : 'mark ' + step}`, m.main === 1
                    && (step === 'null' ? !/:now|:done/.test(m.steps) : new RegExp(step + ':now').test(m.steps)), { main: m.main, key: m.mainKey, steps: m.steps });
            }
        }
        // the primary action per step
        R.ok('primary action per step: Tier list idle, Scout lobby, Review the game, Live game, Send to client',
            seen['idle@1400'].mainKey === 'tier' && seen['lobby@1400'].mainKey === 'scout' && seen['review@1400'].mainKey === 'review' && seen['game@1400'].mainKey === 'live' && seen['select@1400'].mainKey === 'send',
            Object.fromEntries(Object.entries(seen).filter(([k]) => /@1400/.test(k)).map(([k, v]) => [k, v.mainKey])));
        // wide: labels; narrow: icons only and the quiet ones in the "..." menu
        R.ok('1920 px: text labels, no "..." menu, Tier list stays a quiet button on Review', await (async () => { await h.ev(`DD.flow.onPhase('EndOfGame'); 1`); await h.sleep(250); const m = await h.ev(MEASURE); return m.labelsShown >= 2 && !m.moreShown && m.quiet.includes('tier'); })());
        h.w.setContentSize(1400, 800); await h.sleep(500);
        const m1400 = await h.ev(MEASURE);
        R.ok('1400 px (1296 px bar): labels kept, quiet buttons visible, no "..." menu', m1400.labelsShown >= 2 && !m1400.moreShown && m1400.quiet.includes('tier'), m1400);
        h.w.setContentSize(1100, 800); await h.sleep(500);
        const m1100 = await h.ev(MEASURE);
        R.ok('1100 px: icons only, Tier list moved into the "..." menu', m1100.labelsShown === 0 && m1100.moreShown && !m1100.quiet.includes('tier'), m1100);
        // tighter than any of the three: the sidebar expanded at 1100, and a 800 px window (the busiest step)
        await h.ev(`DD.flow.onPhase('ChampSelect'); 1`); await h.waitFor(`DD.flow.state.st && DD.flow.state.st.pick === 'Ahri' && document.querySelector('[data-fb-act="send"]')`, 8000);
        const wasCollapsed = await h.ev(`document.body.classList.contains('sb-collapsed')`);
        await h.ev(`document.querySelector('.sidebar').style.transition = 'none'; document.body.classList.remove('sb-collapsed'); 1`); await h.sleep(300);
        const mWideSb = await h.ev(MEASURE);
        R.ok('1100 px with the sidebar expanded: still fits, one primary', mWideSb.doc <= mWideSb.iw && mWideSb.barScroll <= mWideSb.barClient && !mWideSb.outside.length && !mWideSb.overlap && mWideSb.h <= 40 && mWideSb.main === 1, mWideSb);
        await h.ev(`document.body.classList.add('sb-collapsed'); 1`);
        h.w.setContentSize(800, 800); await h.sleep(500);
        const m800 = await h.ev(MEASURE);
        R.ok('800 px: still fits, one primary', m800.doc <= m800.iw && m800.barScroll <= m800.barClient && !m800.outside.length && !m800.overlap && m800.h <= 40 && m800.main === 1, m800);
        h.w.setContentSize(1100, 800); await h.sleep(400);
        if (!wasCollapsed) await h.ev(`document.body.classList.remove('sb-collapsed'); 1`);
        await h.ev(`DD.flow.onPhase('EndOfGame'); 1`); await h.sleep(300);
        // the "..." menu works and keeps the hook
        await h.ev(`document.querySelector('[data-fb="more"]').click(); 1`);
        const menu = await h.ev(`(() => { const m = document.querySelector('.fb-more-menu'); return { shown: m.style.display, items: [...m.querySelectorAll('[data-fb-act]')].map(b => b.dataset.fbAct), inView: m.getBoundingClientRect().right <= innerWidth && m.getBoundingClientRect().left >= 0 }; })()`);
        R.ok('"..." menu lists Tier list and stays inside the window', menu.shown === 'block' && menu.items.includes('tier') && menu.inView, menu);
        await h.ev(`document.querySelector('.fb-more-menu [data-fb-act="tier"]').click(); 1`); await h.sleep(300);
        R.ok('choosing Tier list in the menu opens it and closes the menu', (await h.ev(`DD.currentView()`)) === 'tierlist' && (await h.ev(`document.querySelector('.fb-more-menu').style.display`)) === 'none');
        await h.ev(`DD.showView('draft'); 1`);

        // review card: result colour, K/D/A, length; session chips and the dot strip
        await h.ev(`DD.flow.onPhase('EndOfGame'); 1`); await h.sleep(300);
        h.w.setContentSize(1920, 800); await h.sleep(500);
        const card = await h.ev(`(() => { const c = document.querySelector('#flow-bar .fb-card'), res = c.querySelector('.fb-res'), kda = c.querySelector('.fb-kda');
            return { text: c.textContent.replace(/\\s+/g, ' ').trim(), res: res.textContent, resColor: getComputedStyle(res).color, kda: kda.textContent, tab: getComputedStyle(kda).fontVariantNumeric,
                icon: c.querySelector('.fb-ico.lg') ? c.querySelector('.fb-ico.lg').getBoundingClientRect().width : 0 }; })()`);
        R.ok('review card: "Loss" in red, K/D/A in tabular numbers, 28 px champion icon, game length', card.res === 'Loss' && card.resColor === 'rgb(239, 68, 68)' && card.kda === '12/15/30' && /tabular/.test(card.tab) && card.icon === 28 && /33 min/.test(card.text), card);
        const chips = await h.ev(`(() => { const s = document.querySelector('#flow-bar .fb-session'); const w = s.querySelector('.fb-chip b.w'), l = s.querySelector('.fb-chip b.l'), lp = s.querySelector('.fb-chip.lp');
            return { text: s.textContent.replace(/\\s+/g, ' ').trim(), w: w.textContent, wColor: getComputedStyle(w).color, l: l.textContent, lColor: getComputedStyle(l).color, lp: lp.textContent, lpCls: lp.className, dots: [...s.querySelectorAll('.fb-dots i')].map(i => i.className) }; })()`);
        R.ok('session chips: 1W blue, 1L red, +21 LP, one dot per game (oldest first)', chips.w === '1W' && chips.wColor === 'rgb(96, 165, 250)' && chips.l === '1L' && chips.lColor === 'rgb(239, 68, 68)' && chips.lp === '+21 LP' && /pos/.test(chips.lpCls) && JSON.stringify(chips.dots) === '["w","l"]' && /Today 1W 1L/.test(chips.text), chips);
        R.ok('hooks kept: data-fb-step on 4 steps, back / forward, DD.history / DD.flow / DD.gamePlan / DD.sendAll', await h.ev(`document.querySelectorAll('#flow-bar [data-fb-step]').length === 4 && !!document.querySelector('#flow-bar [data-fb="back"]') && !!document.querySelector('#flow-bar [data-fb="fwd"]')
            && typeof DD.history.back === 'function' && typeof DD.flow.onPhase === 'function' && typeof DD.gamePlan === 'function' && typeof DD.sendAll === 'function' && !!document.querySelector('#flow-bar [data-fb-act="review"]')`));
        // the step buttons still navigate: Review opens the Profile summary
        await h.ev(`document.querySelector('#flow-bar [data-fb-step="review"]').click(); 1`); await h.sleep(500);
        R.ok('step button Review opens Profile', (await h.ev(`DD.currentView()`)) === 'profile');
        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.filter(l => /Error/.test(l)).slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
