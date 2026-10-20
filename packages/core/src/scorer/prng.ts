/**
 * Deterministic randomness for rank stability (§11): a seeded 32-bit PRNG and a Dirichlet sampler that uses
 * integer arithmetic only, so the same seed gives the same draws in any language (no Math.log/cos).
 *
 * Dirichlet(α₁..α_k) with integer α: sort n−1 uniform points in [0, 2³²) (n = Σα); the n spacings between
 * 0, the points and 2³² are Dirichlet(1,…,1); summing consecutive groups of α_i spacings gives Dirichlet(α).
 * With α = the frozen weights (25, 20, 20, 10, 10, 10, 5; concentration 100) each sampled weight has mean
 * w/100 and a standard deviation of about 20% of the 20-point weights (√(p(1−p)/101) / p).
 */

/** mulberry32: a tiny, well-mixed 32-bit generator built from integer ops (identical in every JS engine). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

export const DIRICHLET_SCALE = 2 ** 32;

/** One Dirichlet(α) draw as non-negative integers summing to exactly 2³². */
export function dirichletDraw(alphas: readonly number[], next: () => number): number[] {
  if (alphas.some((a) => !Number.isInteger(a) || a < 1)) throw new Error("alphas must be positive integers");
  const n = alphas.reduce((s, a) => s + a, 0);
  const points = Array.from({ length: n - 1 }, () => next()).sort((x, y) => x - y);
  const cuts = [0, ...points, DIRICHLET_SCALE];
  const out: number[] = [];
  let at = 0;
  for (const a of alphas) {
    out.push((cuts[at + a] ?? DIRICHLET_SCALE) - (cuts[at] ?? 0));
    at += a;
  }
  return out;
}
