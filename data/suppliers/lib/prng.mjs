/**
 * Seeded PRNG for the supplier generator: mulberry32 (the same generator core's scorer uses for rank stability),
 * so every run with the same seed writes byte-identical files. Never Math.random or the clock.
 */

/** mulberry32: a uint32 seed → a function returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Helpers bound to one stream. */
export function rng(seed) {
  const next = mulberry32(seed);
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  const pick = (list) => list[Math.floor(next() * list.length)];
  const shuffle = (list) => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const chars = (alphabet, n) => Array.from({ length: n }, () => pick([...alphabet])).join("");
  return { next, int, pick, shuffle, chars };
}
