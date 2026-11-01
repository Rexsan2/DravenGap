// Node test (ELECTRON_RUN_AS_NODE) for coachless-scraper.js, on-demand overview (opts.parallel): when every Coachless call fails
// (rate limited, Coachless down) and the summoner spell call fails last, its rejection must not go unhandled (in the main process
// that is a console warning at best, the "A JavaScript error occurred in the main process" box at worst). No network: a stub client.
const path = require('path'), assert = require('assert');
const S = require(path.join(__dirname, '..', '..', 'coachless-scraper.js'));

const unhandled = [];
process.on('unhandledRejection', e => unhandled.push(String(e && e.message || e)));
const tick = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    try {
        // every call rejects; the spell call (the first one made) rejects 30 ms later than the others, after Promise.all has failed
        let n = 0;
        const client = { requests: 0, call: (method, url) => { n++; const spells = /SummonerSpell/.test(url);
            return new Promise((res, rej) => setTimeout(() => rej(Object.assign(new Error('Coachless rate limit (test)'), { code: 'RATE_LIMITED' })), spells ? 40 : 10)); } };
        let threw = null;
        try { await S.scrapeChampionRole({ patch: '16.20', champion: 'Ahri', championKey: 103, role: 'MIDDLE', parallel: true, client }); }
        catch (e) { threw = e; }
        await tick(120);   // let the late spell rejection land
        assert(threw && /rate limit/.test(threw.message), 'the overview fails with the Coachless error: ' + (threw && threw.message));
        assert(n >= 5, 'the parallel burst made its calls: ' + n);
        assert.deepStrictEqual(unhandled, [], 'no unhandled rejection: ' + JSON.stringify(unhandled));

        // the bulk path (spells first, awaited at once) still reports the error the same way
        threw = null;
        try { await S.scrapeChampionRole({ patch: '16.20', champion: 'Ahri', championKey: 103, role: 'MIDDLE', client }); }
        catch (e) { threw = e; }
        await tick(60);
        assert(threw && /rate limit/.test(threw.message), 'bulk path: error reported');
        assert.deepStrictEqual(unhandled, [], 'bulk path: no unhandled rejection');
        console.log('BUILDS SCRAPER FIXES OK');
        process.exit(0);
    } catch (e) {
        console.log('FAIL', e.message);
        process.exit(1);
    }
})();
