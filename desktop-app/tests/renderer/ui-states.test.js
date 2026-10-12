// Shared loading / empty / error states (ui-states.js) and Settings > Appearance (density, UI scale) in the real window, plus the first
// adopters: the tier list and multi-search.
const H = require('../lib/renderer-harness');
const R = H.results();

(async () => {
    try {
        let multi = (e, a) => ({ ok: false, code: 'RATE_LIMITED', error: 'Rate limited by the Riot API. Try again in 90s.', retryAt: Date.now() + 90000 });
        const h = await H.boot({ ipc: { 'profile:multi': (e, a) => multi(e, a) } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 40000);
        await h.sleep(500);

        // ---- the helpers
        const html = await h.ev(`(() => { const U = DD.ui; const now = Date.now();
            return { loading: U.loading('Fetching…'), skel: U.loading('x', { rows: 3 }), empty: U.empty('Nothing here', 'Try later <b>', { label: 'Open', act: 'settings' }), emptyBare: U.empty('Bare'),
                str: U.error('Plain text problem'), rate: U.error({ code: 'RATE_LIMITED', error: 'x' }, { retryAt: now + 72000 }), rate0: U.error({ code: 'RATE_LIMITED', error: 'x' }),
                stale: U.error('x', { stale: true, when: 'saved 2 h ago' }), offline: U.error({ code: 'OFFLINE', error: 'Could not reach the Riot API.' }), key: U.error({ code: 'NO_KEY', error: 'No Riot API key saved.' }),
                nf: U.error({ code: 'NOT_FOUND', error: 'Not found.' }), retry: U.error('boom', { onRetry: () => {} }) }; })()`);
        R.ok('loading: spinner + text, optional skeleton rows', /dg-loading/.test(html.loading) && /Fetching…/.test(html.loading) && /dg-spin/.test(html.loading) && (html.skel.match(/<i /g) || []).length === 3);
        R.ok('empty: title, escaped hint, action; hint and action are optional', /Nothing here/.test(html.empty) && /Try later &lt;b&gt;/.test(html.empty) && /data-ui-act="settings"/.test(html.empty) && !/<b>/.test(html.empty) && !/dg-state-h|dg-state-a/.test(html.emptyBare));
        R.ok('error: plain text -> "Something went wrong" block', /dg-err/.test(html.str) && /Something went wrong/.test(html.str) && /Plain text problem/.test(html.str));
        R.ok('error: rate limit shows "Resumes in 1:12"', /Waiting for the rate limit/.test(html.rate) && /Resumes in <span class="dg-count"[^>]*>1:12<\/span>/.test(html.rate), html.rate);
        R.ok('error: rate limit without a time still reads fine', /Waiting for the rate limit/.test(html.rate0) && !/dg-count/.test(html.rate0));
        R.ok('error: stale -> slim banner "Source unavailable, showing saved data"', /dg-note/.test(html.stale) && /Source unavailable, showing saved data \(saved 2 h ago\)\./.test(html.stale) && !/dg-err/.test(html.stale));
        R.ok('error: OFFLINE, NO_KEY (with an Open Settings button), NOT_FOUND, and a retry button', /Source unavailable/.test(html.offline) && /A Riot API key is needed/.test(html.key) && /Open Settings/.test(html.key) && /data-ui-act="settings"/.test(html.key)
            && /Not found/.test(html.nf) && /Check the spelling/.test(html.nf) && /Try again/.test(html.retry) && /data-ui-fn=/.test(html.retry));

        // ---- live behaviour: countdown, auto retry, retry button, built-in actions
        const live = await h.ev(`(async () => { window.__r = { manual: 0, auto: 0 };
            const box = document.createElement('div'); box.id = 'ui-test-box'; document.body.appendChild(box);
            box.innerHTML = DD.ui.error({ code: 'RATE_LIMITED', error: 'x' }, { retryAt: Date.now() + 2300, onRetry: () => { window.__r.auto++; }, autoRetry: true })
                + DD.ui.error('boom', { onRetry: () => { window.__r.manual++; } }) + DD.ui.empty('E', '', { label: 'Go', onClick: () => { window.__r.manual += 10; } });
            const first = box.querySelector('.dg-count').textContent;
            box.querySelectorAll('button')[1].click();
            const btns = [...box.querySelectorAll('button')]; btns.find(b => b.textContent === 'Go').click();
            await new Promise(r => setTimeout(r, 3600));
            return { first, after: box.querySelector('.dg-count').textContent, r: window.__r, ready: !!box.querySelector('.dg-err.ready') }; })()`);
        R.ok('the countdown ticks and runs the auto retry once when it reaches zero', /^0:0?[1-3]$/.test(live.first) && live.after === 'now' && live.r.auto === 1 && live.ready, live);
        R.ok('Try again and function actions call their handlers', live.r.manual === 11, live.r);
        await h.ev(`document.getElementById('ui-test-box').innerHTML = DD.ui.empty('E', '', { label: 'Open settings', act: 'settings' }); document.querySelector('#ui-test-box button').click(); 1`);
        R.ok('the built-in "settings" action opens Settings', await h.ev(`document.getElementById('settings-modal').style.display === 'flex'`));
        await h.ev(`document.getElementById('settings-close-btn').click(); document.getElementById('ui-test-box').remove(); 1`);

        // ---- tier list: loading, empty, error + retry
        const tier = await h.ev(`(async () => { const out = {}; const body = () => document.getElementById('tl-body') ? document.getElementById('tl-body').innerHTML : '';
            const real = DD.tierData; let release; let calls = 0;
            DD.tierData = () => { calls++; return new Promise(res => { release = res; }); };
            DD.showView('tierlist'); await new Promise(r => setTimeout(r, 200));
            out.loading = /dg-loading/.test(body()) && /Loading the tier list/.test(body()) && /dg-skel/.test(body());
            release(null); await new Promise(r => setTimeout(r, 200));
            out.empty = /dg-empty/.test(body()) && /No data for this Time Period and Rank/.test(body()) && /data-ui-act="saved-data"/.test(body());
            DD.tierData = async () => ({ error: 'Could not read the dataset.' });
            DDTier.reload(); await new Promise(r => setTimeout(r, 200));
            out.error = /dg-err/.test(body()) && /Could not read the dataset/.test(body()) && /Try again/.test(body());
            DD.tierData = real;
            document.querySelector('#tl-body .dg-err .dg-state-btn').click(); await new Promise(r => setTimeout(r, 300));
            for (let i = 0; i < 100 && !document.querySelector('#tierlist-root .tl-row'); i++) await new Promise(r => setTimeout(r, 100));
            out.retryLoaded = !!document.querySelector('#tierlist-root .tl-row') && !/dg-err/.test(body());
            return out; })()`);
        R.ok('tier list: loading state while the data loads', tier.loading, tier);
        R.ok('tier list: no data -> DD.ui empty state with a Saved data button', tier.empty, tier);
        R.ok('tier list: an error -> DD.ui error with a working Try again', tier.error && tier.retryLoaded, tier);

        // ---- multi-search: empty state, rate limit countdown, auto retry
        await h.ev(`DD.showView('scout'); 1`);
        await h.sleep(200);
        R.ok('multi-search: empty state before a search', await h.ev(`/Nothing searched yet/.test(document.getElementById('ms-cards').textContent) && !!document.querySelector('#ms-cards .dg-empty')`));
        await h.ev(`DDScout.setText('Alpha#EUW'); DDScout.search(); 1`);
        await h.waitFor(`!!document.querySelector('#ms-cards .ms-card.err .dg-count')`, 10000);
        const ms = await h.ev(`document.querySelector('#ms-cards .ms-card.err').textContent.replace(/\\s+/g, ' ')`);
        R.ok('multi-search: a rate-limited player shows "Resumes in 1:2x"/"1:30" and a Try now button', /Waiting for the rate limit/.test(ms) && /Resumes in 1:(2[5-9]|30)/.test(ms) && /Try now/.test(ms), ms);
        multi = (e, a) => ({ ok: true, profile: { gameName: a.gameName, tagLine: a.tagLine, platform: a.platform, summonerLevel: 50, ranked: [], mastery: [] }, form: { results: [] }, tags: [] });
        await h.ev(`document.querySelector('#ms-cards .ms-card.err .dg-state-btn').click(); 1`);
        R.ok('multi-search: Try now looks the player up again', await h.waitFor(`document.querySelector('#ms-cards .ms-card:not(.err):not(.loading)') && /Level 50/.test(document.getElementById('ms-cards').textContent)`, 8000));

        // ---- density
        await h.ev(`DD.showView('tierlist'); 1`);
        await h.waitFor(`!!document.querySelector('#tierlist-root .tl-table td')`, 15000);
        const pad = () => h.ev(`getComputedStyle(document.querySelector('#tierlist-root .tl-table td')).paddingTop`);
        const padComfortable = await pad();
        R.ok('default density is Comfortable (no class)', !(await h.ev(`document.body.classList.contains('density-compact')`)) && (await h.ev(`document.getElementById('density-select').value`)) === 'comfortable', padComfortable);
        await h.ev(`(() => { const s = document.getElementById('density-select'); s.value = 'compact'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
        await h.sleep(300);
        const padCompact = await pad();
        R.ok('Density: Compact adds the body class (and html), tightens the tier list rows and is saved', await h.ev(`document.body.classList.contains('density-compact') && document.documentElement.classList.contains('density-compact')`)
            && parseFloat(padCompact) < parseFloat(padComfortable) && h.settings().density === 'compact' && (await h.ev(`JSON.parse(localStorage.getItem('dg-ui')).density`)) === 'compact', { padComfortable, padCompact, saved: h.settings().density });
        const recPad = await h.ev(`(() => { const li = document.createElement('li'); document.getElementById('recommendation-list').appendChild(li); const v = getComputedStyle(li).paddingTop; li.remove(); return v; })()`);
        R.ok('compact also tightens the draft table rows', parseFloat(recPad) < 8, recPad);

        // ---- UI scale
        const zoom = () => h.w.webContents.getZoomFactor();
        await h.ev(`(() => { const r = document.getElementById('ui-scale-range'); r.value = '110'; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
        await h.sleep(300);
        R.ok('UI scale 110% sets the window zoom, the label and the setting', Math.abs(zoom() - 1.1) < 0.001 && h.settings().uiScale === 110 && (await h.ev(`document.getElementById('ui-scale-label').textContent`)) === '110%', { zoom: zoom(), saved: h.settings().uiScale });
        R.ok('the app still lays out at 110% (header and sidebar visible)', await h.ev(`document.querySelector('.sidebar').getBoundingClientRect().height > 300 && document.querySelector('.app-container').getBoundingClientRect().width > 300`));
        await h.ev(`DD.ui.setScale(150); 1`); await h.sleep(150);
        const hi = zoom();
        await h.ev(`DD.ui.setScale(50); 1`); await h.sleep(150);
        R.ok('the scale is limited to 90-125%', Math.abs(hi - 1.25) < 0.001 && Math.abs(zoom() - 0.9) < 0.001 && h.settings().uiScale === 90, { hi, lo: zoom() });

        // ---- both survive a restart (a reload applies them again from the saved settings)
        await h.ev(`DD.ui.setScale(115); 1`); await h.sleep(150);
        await h.ev(`location.reload(); 1`);
        await h.sleep(500);
        await h.waitFor(`typeof DD !== 'undefined' && !!DD.ui && document.querySelectorAll('.champion-tile').length > 50`, 40000);
        await h.sleep(500);
        R.ok('after a restart: density, scale and the Settings controls come back', await h.ev(`document.body.classList.contains('density-compact') && document.getElementById('density-select').value === 'compact' && document.getElementById('ui-scale-range').value === '115'`)
            && Math.abs(zoom() - 1.15) < 0.001, { zoom: zoom() });
        await h.ev(`document.getElementById('ui-scale-reset-btn').click(); 1`); await h.sleep(300);
        R.ok('Reset goes back to Comfortable and 100%', !(await h.ev(`document.body.classList.contains('density-compact')`)) && Math.abs(zoom() - 1) < 0.001 && h.settings().uiScale === 100 && h.settings().density === 'comfortable', h.settings());
        R.ok('the setup card did not appear in a normal start', !(await h.ev(`!!document.getElementById('onboarding-card')`)));
        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.filter(l => /Error/.test(l)).slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
