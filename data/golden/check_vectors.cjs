// Independent JS cross-check. Install the pinned libraries shown in README.md.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const canonicalize = require('canonicalize');
const { keccak_256 } = require('@noble/hashes/sha3');
const digest = s => '0x' + Buffer.from(keccak_256(Buffer.from(s, 'utf8'))).toString('hex');
assert.equal(digest(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'hash-vectors.json'), 'utf8'));
assert(rows.length > 0);
assert.equal(new Set(rows.map(r => r.name)).size, rows.length);
for (const row of rows) {
  const jcs = canonicalize(row.input);
  assert.equal(jcs, row.jcs, `${row.name}: canonical JSON mismatch`);
  assert.equal(digest(jcs), row.keccak256, `${row.name}: Keccak mismatch`);
}
console.log(`${rows.length} vectors agree across Python and JavaScript implementations`);
