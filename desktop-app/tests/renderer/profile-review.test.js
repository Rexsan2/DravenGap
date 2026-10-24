// Post-game review: a match's Review tab reads the timeline with kills (minVersion 2) and shows your lane
// against your opponent at 10 / 15 / 20 minutes, the biggest gold swings, and your deaths and kills on the map.
const H = require('../lib/renderer-harness');
const { APP } = require('../lib/common');
const C = require(APP + 'profile-compact');
const TLm = require(APP + 'profile-timeline');
const { match } = require('../lib/riot-stub');
const { timeline } = require('../lib/timeline-fixture');
const R = H.results();
const PU = 'P'.padEnd(78, 'x');
const cm = C.forViewer(C.compactMatch(match(1, PU)), PU);   // you are participant 1 (Top); participant 6 is the enemy Top
const raw = timeline(cm.id);
raw.info.frames[12].events.push({ type: 'CHAMPION_KILL', timestamp: 720000, killerId: 6, victimId: 1, assistingParticipantIds: [7], position: { x: 2000, y: 12500 } });
const tl = TLm.deriveTimeline(TLm.compactTimeline(raw), cm.players.map(p => p.team));

(async () => {
    try {
        const tlCalls = [];
        const h = await H.boot({ size: [1400, 900], ipc: {
            'profile:owner': () => ({ ok: true, owner: { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1', puuid: PU }, source: 'client' }),
            'profile:lookup': (e, a) => ({ ok: true, profile: { puuid: PU, gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1', isOwner: true, summonerLevel: 100, profileIconId: 29, ranked: [], mastery: [] } }),
            'profile:matches': (e, a) => ({ ok: true, puuid: a.puuid, group: a.group, start: 0, nextStart: 1, hasMore: false, matches: [cm] }),
            'profile:ledger': () => ({ ok: true, rows: [], total: 0 }),
            'profile:timeline': (e, a) => { tlCalls.push(a); return { ok: true, timeline: tl, cached: true }; }
        } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        await h.ev(`DD.showView('profile'); 1`);
        await h.waitFor(`!!document.querySelector('#profile-root .pf-match .pf-mrow')`, 10000);
        await h.ev(`document.querySelector('#profile-root .pf-match .pf-mrow').click(); 1`);
        await h.waitFor(`!!document.querySelector('#profile-root .pf-mtab[data-t="review"]')`, 5000);
        await h.ev(`document.querySelector('#profile-root .pf-mtab[data-t="review"]').click(); 1`);
        R.ok('the Review tab asks for the timeline with kills (minVersion 2)', await h.waitFor(`!!document.querySelector('#profile-root .pf-review')`, 8000) && tlCalls.some(a => a.minVersion === 2), tlCalls);
        const lane = await h.ev(`[...document.querySelectorAll('#profile-root .pf-rv-lane tbody tr')].map(tr => [...tr.children].slice(0, 4).map(td => td.textContent.trim()))`);
        R.ok('lane at 10 / 15 / 20 min against the enemy Top: +404 gold, even CS at 10', lane.length === 3 && lane[0][0] === '10 min' && lane[0][1] === '+404' && lane[0][2] === '0' && lane[2][0] === '20 min', lane);
        R.ok('no 1,500+ gold swing in this game: it says so', /No big swing/.test(await h.ev(`document.querySelector('#profile-root .pf-review').textContent`)));
        const map = await h.ev(`(() => { const s = document.querySelector('#profile-root .pf-rv-map'); return s ? { deaths: s.querySelectorAll('g.d').length, kills: s.querySelectorAll('g.k').length, tip: (s.querySelector('g.d') || { dataset: {} }).dataset.tip, width: s.getBoundingClientRect().width } : null; })()`);
        R.ok('the map: your death (12 min, to the enemy Top) and your kill', map && map.deaths === 1 && map.kills === 1 && /^12:\d\d · you died to/.test(map.tip), map);
        R.ok('the map is drawn large (up to 480 px)', map && map.width > 400, map && map.width);
        // hovering anywhere near a mark shows its box at once (the wide hit circle, not only the 1-px cross)
        const hover = await h.ev(`(() => { const hit = document.querySelector('#profile-root .pf-rv-map g.d .hit'); hit.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            const tip = document.querySelector('#profile-root .pf-rv-tip'); return { shown: !tip.hidden, text: tip.textContent, on: !!document.querySelector('#profile-root .pf-rv-mk.on'), r: Number(hit.getAttribute('r')) }; })()`);
        R.ok('hovering a mark shows who and when at once', hover.shown && /you died to/.test(hover.text) && hover.on && hover.r >= 10, hover);
        await h.ev(`document.querySelector('#profile-root .pf-rv-map image').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); 1`);
        R.ok('moving off the marks hides it', await h.ev(`document.querySelector('#profile-root .pf-rv-tip').hidden`));
        const errs = h.logs.filter(l => /Uncaught|TypeError|ReferenceError/.test(l));
        R.ok('no uncaught errors', errs.length === 0, errs);
    } catch (e) { R.ok('test ran', false, String(e && e.stack || e)); }
    R.finish();
})();
