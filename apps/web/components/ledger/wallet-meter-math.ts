/**
 * The wallet meter's maths (DESIGN.md §6, "What the agent can spend"), in bigint: each part as a share of the signed
 * limit, scaled down to fit the track when they add up to more, with the excess reported so the meter can say how
 * far over the signature a request would go. Percentages have two decimals; never a JS number for money.
 */
import { parseMinor } from "@hogee/core";

export interface WalletParts {
  limitMinor: string;
  paidMinor: string;
  agentMinor: string;
  waitingMinor: string;
}

export interface WalletSegments {
  paidPct: number;
  agentPct: number;
  waitingPct: number;
  /** Everything committed against the limit, capped at 100. */
  usedPct: number;
  /** How far the parts go past the limit (a minor-unit string, "0" when inside it). */
  overMinor: string;
}

const pct = (part: bigint, whole: bigint): number => (whole === 0n ? 0 : Number((part * 10_000n) / whole) / 100);

export function walletSegments(p: WalletParts): WalletSegments {
  const limit = parseMinor(p.limitMinor, "limitMinor");
  const paid = parseMinor(p.paidMinor, "paidMinor");
  const agent = parseMinor(p.agentMinor, "agentMinor");
  const waiting = parseMinor(p.waitingMinor, "waitingMinor");
  const total = paid + agent + waiting;
  const over = total > limit ? total - limit : 0n;
  // Past the limit the track is the total, so the parts keep their proportions and still fill it exactly.
  const scale = total > limit ? total : limit;
  return {
    paidPct: pct(paid, scale),
    agentPct: pct(agent, scale),
    waitingPct: pct(waiting, scale),
    usedPct: limit === 0n ? 0 : Math.min(100, pct(total, limit)),
    overMinor: over.toString(),
  };
}
