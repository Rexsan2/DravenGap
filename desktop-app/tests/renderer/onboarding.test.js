// First-run setup check (onboarding.js) in the real window: a fresh userData shows the 4-step card, stubbed IPC makes steps OK / missing,
// saving the account and downloading the data fix them, Done sets onboardingDone, and the next boot (a reload) does not show it again.
// Also: Settings > "Run setup check again" and the Ctrl+K palette open it, and a boot where everything is already fine stays quiet.
const H = require('../lib/renderer-harness');
const R = H.results();

(async () => {
    try {
        let keyResult = { ok: false, code: 'KEY_REJECTED', error: 'Riot API key rejected.' };
        let keySet = true;
        const h = await H.boot({ onboarding: true, settings: { timePeriod: 'patch', rank: 'platinum_plus' }, ipc: {
            'profile:me': () => ({ ok: true, me: { gameName: 'TestOwner', tagLine: 'META', platform: 'NA1' }, lcu: true, phase: 'None' }),
            'get-riot-key-status': () => (keySet ? { set: true, hint: 'wxyz' } : { set: false, hint: null }),
            'profile:test-key': () => keyResult
        } });
        const card = `document.getElementById('onboarding-card')`;
        const shown = `${card} && ${card}.style.display !== 'none'`;
        const step = id => `(() => { const li = document.querySelector('#onboarding-card [data-step="${id}"]'); return li ? li.className.replace('ob-step ', '') + '|' + li.textContent.replace(/\\s+/g, ' ') : null; })()`;

        // ---- fresh userData: the card opens by itself
        R.ok('a fresh start (onboardingDone not set) shows the setup card', await h.waitFor(shown, 40000));
        await h.waitFor(`!document.querySelector('#onboarding-card .ob-step.wait')`, 15000);
        const s1 = await h.ev(step('client')), s2 = await h.ev(step('key')), s3 = await h.ev(step('account')), s4 = await h.ev(step('data'));
        R.ok('step 1 OK: client found, with the signed-in Riot ID', /^ok\|/.test(s1) && /TestOwner#META \(NA1\)/.test(s1), s1);
        R.ok('step 2 shows a problem when Riot rejects the saved key', /^fail\|/.test(s2) && /rejected/i.test(s2) && /Open Settings/.test(s2), s2);
        R.ok('step 3 is to do, with the client account filled in', /^todo\|/.test(s3) && (await h.ev(`document.getElementById('ob-riotid').value`)) === 'TestOwner#META' && (await h.ev(`document.getElementById('ob-region').value`)) === 'NA1', s3);
        R.ok('step 4 is to do: Emerald+ of the current patch is not downloaded (only another rank is)', /^todo\|/.test(s4) && /Emerald\+/.test(s4) && /Download now/.test(s4), s4);
        R.ok('the card does not block the app (a floating card, the draft is still there)', await h.ev(`getComputedStyle(${card}).position === 'fixed' && document.querySelectorAll('.champion-tile').length > 50 && !document.querySelector('.ob-backdrop')`));
        R.ok('the footer offers Skip, not Done, while something is open', await h.ev(`!!document.querySelector('#ob-foot [data-ob="skip"]') && !document.querySelector('#ob-foot [data-ob="finish"]')`));
        R.ok('nothing was saved yet', h.settings().onboardingDone === undefined && h.settings().profileAccount === undefined, h.settings());

        // ---- step 3: save the account
        await h.ev(`document.querySelector('#onboarding-card [data-ob="save-account"]').click(); 1`);
        await h.waitFor(`/^ok/.test(${step('account')})`, 5000);
        R.ok('Save writes settings.profileAccount and step 3 turns OK', JSON.stringify(h.settings().profileAccount) === JSON.stringify({ gameName: 'TestOwner', tagLine: 'META', platform: 'NA1' }) && /^ok\|/.test(await h.ev(step('account'))), h.settings().profileAccount);
        await h.ev(`document.getElementById('settings-btn').click(); 1`);
        R.ok('Settings still opens over the card (the card never blocks the app)', await h.ev(`document.getElementById('settings-modal').style.display === 'flex'`));
        await h.ev(`document.getElementById('settings-close-btn').click(); 1`);

        // ---- step 2: a fresh key is accepted after "Test again"
        await h.sleep(300);     // closing Settings re-checks key, account and data: wait until they settle, then give the key a fix
        await h.waitFor(`!document.querySelector('#onboarding-card .ob-step.wait') && !!document.querySelector('#onboarding-card [data-ob="recheck:key"]')`, 10000);
        keyResult = { ok: true, ms: 40, message: 'Riot API key accepted.' };
        await h.ev(`document.querySelector('#onboarding-card [data-ob="recheck:key"]').click(); 1`);
        await h.waitFor(`/^ok/.test(${step('key')})`, 5000);
        R.ok('step 2 turns OK after a working key test', /^ok\|/.test(await h.ev(step('key'))) && /wxyz/.test(await h.ev(step('key'))), await h.ev(step('key')));

        // ---- step 4: download Emerald+ of the current patch
        const before = h.S.log.filter(l => /emerald_plus/.test(l)).length;
        await h.ev(`document.querySelector('#onboarding-card [data-ob="download"]').click(); 1`);
        await h.waitFor(`/^ok/.test(${step('data')})`, 30000);
        R.ok('Download now fetches Emerald+ of the current patch only and step 4 turns OK', /^ok\|/.test(await h.ev(step('data'))) && h.S.log.some(l => /^R2 \/patch\/emerald_plus\/all\/champion_stats\.json/.test(l))
            && !h.S.log.some(l => /^R2 \/patch\/(?!emerald_plus|platinum_plus)[a-z_]+\/all/.test(l)) && h.S.log.filter(l => /emerald_plus/.test(l)).length > before, h.S.log.filter(l => /^R2/.test(l)));
        R.ok('the selected Rank / Time Period was not changed by the download', await h.ev(`document.getElementById('rank-select').value === 'platinum_plus'`));

        // ---- all OK: Done
        R.ok('with every step OK the footer says Done', await h.ev(`!!document.querySelector('#ob-foot [data-ob="finish"]') && /Done/.test(document.querySelector('#ob-foot [data-ob="finish"]').textContent)`));
        await h.ev(`document.querySelector('#ob-foot [data-ob="finish"]').click(); 1`);
        await h.sleep(300);
        R.ok('Done hides the card and saves onboardingDone', !(await h.ev(shown)) && h.settings().onboardingDone === true && typeof h.settings().onboardingAt === 'number', h.settings());

        // ---- the next boot: no card, and no new client check
        const keyTests = () => h.calls.filter(c => c[0] === 'profile:test-key').length;
        const testsBefore = keyTests();
        await h.ev(`location.reload(); 1`);
        await h.sleep(500);
        await h.waitFor(`typeof DD !== 'undefined' && !!DD.onboarding && document.querySelectorAll('.champion-tile').length > 50`, 40000);
        await h.sleep(2500);
        R.ok('the next boot does not show the card and does not run the checks', !(await h.ev(`!!${card}`)) && (await h.ev(`DD.onboarding.state.seq`)) === 0 && keyTests() === testsBefore, { testsBefore, now: keyTests() });

        // ---- from Settings and from the Ctrl+K palette
        await h.ev(`document.getElementById('settings-btn').click(); 1`);
        await h.ev(`document.getElementById('onboarding-run-btn').click(); 1`);
        R.ok('Settings > Run setup check again closes Settings and opens the card', await h.waitFor(shown, 5000) && await h.ev(`document.getElementById('settings-modal').style.display === 'none'`));
        await h.waitFor(`!document.querySelector('#onboarding-card .ob-step.wait')`, 15000);
        const again = await Promise.all(['client', 'account', 'data'].map(id => h.ev(step(id))));
        R.ok('opened by hand it checks again (client OK, data OK, account OK)', again.every(s => /^ok\|/.test(s)), again);
        await h.ev(`document.querySelector('#onboarding-card [data-ob="skip"]').click(); 1`);
        R.ok('the x skips: the card is hidden', !(await h.ev(shown)));
        await h.ev(`DD.openPalette(); 1`);
        await h.ev(`(() => { const i = document.querySelector('.dg-pal-in'); i.value = 'setup check'; i.dispatchEvent(new Event('input')); return 1; })()`);
        R.ok('the palette lists "Run setup check"', /Run setup check/.test(await h.ev(`document.querySelector('.dg-pal-list').textContent`)));
        await h.ev(`document.querySelector('.dg-pal-in').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); 1`);
        R.ok('Enter in the palette opens the card', await h.waitFor(shown, 5000));
        await h.ev(`DD.onboarding.close(); 1`);

        // ---- a start where everything is already fine stays quiet and marks itself done
        keySet = false;     // the key is optional: "not set" is not a problem
        await h.ev(`(async () => { const s = await electronAPI.getSettings(); delete s.onboardingDone; delete s.onboardingAt; s.rank = 'emerald_plus'; s.timePeriod = 'patch'; await electronAPI.saveSettings(s); location.reload(); })()`);
        await h.sleep(500);
        await h.waitFor(`typeof DD !== 'undefined' && !!DD.onboarding && document.querySelectorAll('.champion-tile').length > 50`, 40000);
        const quiet = await (async () => { for (let i = 0; i < 120; i++) { if (h.settings().onboardingDone === true) return true; await h.sleep(250); } return false; })();
        R.ok('when every step is already fine the card never opens, and onboardingDone is set', quiet && !(await h.ev(shown)), h.settings());
        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.filter(l => /Error/.test(l)).slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
