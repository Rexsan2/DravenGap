// Champion boxes complete a search that can only mean one champion: "qi" opens Qiyana on the champion page and in Builds.
// DD.uniqueChampion: exact names win ("vi" = Vi, not Viego / Viktor), word starts count ("fate" = Twisted Fate), punctuation and
// case are ignored ("kaisa" = Kai'Sa), ambiguous or 1-letter text gives nothing, and deleting never completes.
const H = require('../lib/renderer-harness');
const R = H.results();

(async () => {
    try {
        const h = await H.boot({});
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        await h.sleep(1000);
        const typingVi = await h.ev(`DD.uniqueChampion('vi', undefined, { typing: true })`);
        const m = await h.ev(`Object.fromEntries(['qi', 'QI', 'vi', 'fate', 'kaisa', 'drm', 'ka', 'q', '', 'zzz'].map(t => [t, (DD.uniqueChampion(t) || {}).name || null]))`);
        R.ok('matcher: "qi" = Qiyana in any case', m.qi === 'Qiyana' && m.QI === 'Qiyana', m);
        R.ok('matcher: an exact name wins over longer ones ("vi"), but not while typing', m.vi === 'Vi' && typingVi === null, { m, typingVi });
        R.ok('matcher: a word of the name ("fate"), punctuation ignored ("kaisa", "drm")', m.fate === 'Twisted Fate' && m.kaisa === "Kai'Sa" && m.drm === 'Dr. Mundo', m);
        R.ok('matcher: ambiguous, 1 letter, empty or unknown: nothing', m.ka === null && m.q === null && m[''] === null && m.zzz === null, m);

        const type = (sel, v, inputType = 'insertText') => h.ev(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.focus(); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: ${JSON.stringify(inputType)} })); return 1; })()`);

        // champion page
        await h.ev(`DD.showView('champion'); 1`);
        await h.waitFor(`!!document.querySelector('#ch-search')`, 10000);
        await type('#ch-search', 'qi');
        R.ok('champion page: "qi" opens Qiyana', await h.waitFor(`/Qiyana/.test((document.querySelector('#champion-root .ch-name h2') || {}).textContent || '')`, 10000));
        await type('#ch-search', 'ka');
        await h.sleep(300);
        R.ok('champion page: "ka" (many champions) opens nothing and keeps the text', /Qiyana/.test(await h.ev(`document.querySelector('#champion-root .ch-name h2').textContent`)) && (await h.ev(`document.querySelector('#ch-search').value`)) === 'ka');

        await type('#ch-search', 'vi');
        await h.sleep(300);
        R.ok('champion page: typing "vi" waits (Vi, Viego, Viktor)...', /Qiyana/.test(await h.ev(`document.querySelector('#champion-root .ch-name h2').textContent`)));
        await type('#ch-search', 'vie');
        R.ok('... "vie" opens Viego', await h.waitFor(`/Viego/.test(document.querySelector('#champion-root .ch-name h2').textContent)`, 10000));
        await type('#ch-search', 'vi');
        await h.ev(`document.querySelector('#ch-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); 1`);
        R.ok('... and "vi" + Enter opens Vi', await h.waitFor(`/^Vi the /.test(document.querySelector('#champion-root .ch-name h2').textContent.trim())`, 10000), await h.ev(`document.querySelector('#champion-root .ch-name h2').textContent`));
        await type('#ch-search', 'Ahri', 'insertReplacementText');
        R.ok('... and a name picked from the dropdown opens at once', await h.waitFor(`/Ahri/.test(document.querySelector('#champion-root .ch-name h2').textContent)`, 10000));

        // a whole name typed letter by letter: the box completes inline ("Ah|ri|") and never hops to another champion
        // ("ahri" used to end on Riven: the box was emptied after "ah" and "ri" started a new search)
        const typeLetters = (sel, word) => h.ev(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.focus(); i.value = ''; for (const ch of ${JSON.stringify(word)}) document.execCommand('insertText', false, ch); return i.value; })()`);
        const head = () => h.ev(`document.querySelector('#champion-root .ch-name h2').textContent.trim()`);
        await type('#ch-search', 'Zed', 'insertReplacementText');
        await h.waitFor(`/^Zed/.test(document.querySelector('#champion-root .ch-name h2').textContent.trim())`, 10000);
        const v1 = await typeLetters('#ch-search', 'ahri');
        R.ok('letter by letter: "ahri" opens Ahri and the box reads "Ahri"', await h.waitFor(`/^Ahri/.test(document.querySelector('#champion-root .ch-name h2').textContent.trim())`, 10000) && v1 === 'Ahri', { v1, head: await head() });
        const v2 = await typeLetters('#ch-search', 'darius');
        R.ok('letter by letter: "darius" ends on Darius, not Riven', await h.waitFor(`/^Darius/.test(document.querySelector('#champion-root .ch-name h2').textContent.trim())`, 10000) && v2 === 'Darius', { v2, head: await head() });
        const v3 = await typeLetters('#ch-search', 'twisted fate');
        R.ok('letter by letter: "twisted fate" keeps the space and opens Twisted Fate', v3 === 'Twisted Fate' && await h.waitFor(`/^Twisted Fate/.test(document.querySelector('#champion-root .ch-name h2').textContent.trim())`, 10000), { v3, head: await head() });
        const v4 = await typeLetters('#ch-search', 'kaisa');
        R.ok("letter by letter: \"kaisa\" becomes Kai'Sa", v4 === "Kai'Sa" && await h.waitFor(`/^Kai'Sa/.test(document.querySelector('#champion-root .ch-name h2').textContent.trim())`, 10000), { v4, head: await head() });
        await typeLetters('#ch-search', 'vi');
        await h.sleep(300);
        R.ok('letter by letter: "vi" waits', /^Kai'Sa/.test(await head()) && (await h.ev(`document.querySelector('#ch-search').value`)) === 'vi');
        await h.ev(`document.querySelector('#ch-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); 1`);
        R.ok('... Enter opens Vi and clears the box', await h.waitFor(`/^Vi the /.test(document.querySelector('#champion-root .ch-name h2').textContent.trim()) && document.querySelector('#ch-search').value === ''`, 10000), await head());

        // Builds
        await h.ev(`DD.showView('builds'); 1`);
        await h.waitFor(`!!document.getElementById('builds-champ-input')`, 10000);
        await h.sleep(500);
        await type('#builds-champ-input', 'qi');
        R.ok('Builds: "qi" completes to Qiyana', await h.waitFor(`document.getElementById('builds-champ-input').value === 'Qiyana'`, 5000), await h.ev(`document.getElementById('builds-champ-input').value`));
        await type('#builds-champ-input', 'Qiyan', 'deleteContentBackward');
        await h.sleep(200);
        R.ok('Builds: deleting a letter does not complete it again', (await h.ev(`document.getElementById('builds-champ-input').value`)) === 'Qiyan');
        const b1 = await typeLetters('#builds-champ-input', 'qiyana');
        R.ok('Builds: "qiyana" letter by letter leaves exactly "Qiyana" (the completed tail is replaced, not appended)', b1 === 'Qiyana', b1);

        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
