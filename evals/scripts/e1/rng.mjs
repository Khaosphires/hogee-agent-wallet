// Seeded PRNG for the E1 generator. sfc32, seeded from sha256(`${seed}:${label}`), so each category (and the clean
// set) draws from its own stream: editing one category never shifts the bytes of another.
import { createHash } from 'node:crypto';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function rngFor(seed, label) {
  const h = createHash('sha256').update(`${seed}:${label}`).digest();
  let a = h.readUInt32LE(0);
  let b = h.readUInt32LE(4);
  let c = h.readUInt32LE(8);
  let d = h.readUInt32LE(12);
  const next = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 16; i += 1) next();
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  const chars = (alphabet, n) => Array.from({ length: n }, () => alphabet[int(0, alphabet.length - 1)]).join('');
  return {
    int,
    pick: (xs) => xs[int(0, xs.length - 1)],
    digits: (n) => chars('0123456789', n),
    hex: (n) => chars('0123456789abcdef', n),
    base62: (n) => chars(BASE62, n),
    upper: (n) => chars('ABCDEFGHJKLMNPQRSTUVWXYZ', n),
  };
}
