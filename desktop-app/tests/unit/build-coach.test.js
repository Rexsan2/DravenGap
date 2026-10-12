// Build coaching rules (C8): only strong evidence produces a suggestion.
const assert = require('assert');
const { APP } = require('../lib/common');
const { computeCoaching, THRESHOLDS } = require(APP + 'build-coach.js');

const row = (id, adj, pp, buys = 100000, pickRate = 0.1) => ({ id, name: 'item' + id, img: '', wpa: adj, adj, pp, buys, pickRate });
const tables = {
    legendaries: [row(3118, 0.001, 0.6), row(4645, -0.006, 0.05), row(3157, 0.0, 0.5), row(6655, 0.012, 0.97, 50000, 0.08),
        row(3089, 0.02, 0.95, 500), /* too few buys */ row(4628, 0.009, 0.85, 20000) /* PP too low */, row(3135, 0.0055, 0.92) /* gain under 0.5 over 3118? 0.0045 */],
    boots: [row(3020, -0.001, 0.3, 130000, 0.6), row(3158, 0.006, 0.99, 59000, 0.27)]
};
const mine = { items: { MIDDLE: { games: 10, freq: { 3118: 8, 4645: 9, 3157: 3, 3020: 10, 9999: 7 } }, UTILITY: { games: 5, freq: { 3118: 5 } } } };

let r = computeCoaching(mine, tables, 'MIDDLE');
assert.strictEqual(r.status, 'ok'); assert.strictEqual(r.games, 10);
const ids = r.rows.map(x => x.item.id);
assert.deepStrictEqual(ids, [4645, 3118, 3020], 'items bought in 40%+ of games, most bought first, legendaries then boots; unknown ids and 30% items left out');
const by = id => r.rows.find(x => x.item.id === id);
assert.strictEqual(by(4645).alt.id, 6655, 'the best strong alternative'); assert.strictEqual(by(4645).warn, true, 'PP 5%: very likely negative');
assert.strictEqual(by(3118).alt.id, 6655); assert.strictEqual(by(3118).warn, false);
assert.strictEqual(by(3020).alt.id, 3158, 'boots compared with boots');
assert(!r.rows.some(x => x.alt && [3089, 4628].includes(x.alt.id)), 'too few buys / PP under 90% never suggested');
// the gain rule: 3135 is only +0.45 over 3118, so with 6655 gone 3118 has no suggestion
r = computeCoaching(mine, { legendaries: tables.legendaries.filter(x => x.id !== 6655), boots: [] }, 'MIDDLE');
assert.strictEqual(r.rows.find(x => x.item.id === 3118).alt, null, 'needs +0.5 WPA');
assert.strictEqual(r.rows.find(x => x.item.id === 4645).alt.id, 3135, '...which 4645 (-0.6) does get');
// support maps to the UTILITY position; few games
assert.strictEqual(computeCoaching(mine, tables, 'SUPPORT').rows[0].item.id, 3118);
assert.strictEqual(computeCoaching({ items: { TOP: { games: 2, freq: { 3118: 2 } } } }, tables, 'TOP').status, 'few-games');
assert.strictEqual(computeCoaching({ items: {} }, tables, 'TOP').status, 'few-games');
assert.strictEqual(computeCoaching({ items: { TOP: { games: 6, freq: { 9999: 6 } } } }, tables, 'TOP').status, 'no-items');
assert.deepStrictEqual([THRESHOLDS.pp, THRESHOLDS.gain, THRESHOLDS.minBuys, THRESHOLDS.minShare], [0.9, 0.005, 1000, 0.4]);
console.log('ALL OK');
