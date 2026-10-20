/** How much of a pocket has gone out, 0–100 to one decimal (an empty or over-full pocket clamps). */
export function usedPct(allocatedMinor: string, leftMinor: string): number {
  const allocated = BigInt(allocatedMinor);
  if (allocated <= 0n) return 0;
  const used = allocated - BigInt(leftMinor);
  if (used <= 0n) return 0;
  if (used >= allocated) return 100;
  return Number((used * 1000n) / allocated) / 10;
}
