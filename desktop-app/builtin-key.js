// Encoding of the key a personal build carries (resources/app-data.bin, written by scripts/build-personal.js).
// This only keeps the key from being plain text in the installed files; it is not protection: anyone with the exe can decode it.
// That is why personal builds are never published.
const crypto = require('crypto');

const pad = n => crypto.createHash('sha256').update('dravengap/app-data/' + n).digest();

function encode(text) {
    const b = Buffer.from(String(text), 'utf8');
    const out = Buffer.alloc(b.length + 1);
    out[0] = 1;                                                   // format version
    for (let i = 0; i < b.length; i++) out[i + 1] = b[i] ^ pad(i >> 5)[i & 31] ^ ((i * 151) & 255);
    return out.reverse();
}

function decode(buf) {
    const b = Buffer.from(buf).reverse();
    if (b[0] !== 1) return '';
    const out = Buffer.alloc(b.length - 1);
    for (let i = 0; i < out.length; i++) out[i] = b[i + 1] ^ pad(i >> 5)[i & 31] ^ ((i * 151) & 255);
    return out.toString('utf8');
}

module.exports = { encode, decode };
