/**
 * Seeded Mei CFO scenarios for the cfo*.test.ts files (synthetic demo data). Day d is MEI_COMMIT_AT + d days, UTC;
 * day 0 is 2026-10-16. Every scenario keeps the line state consistent with its payments.
 */
import { meiCfoInputs } from "../src/cfo/demo";
import type { CfoInputs, CfoLineIn, CfoPaymentIn, CfoSaleIn } from "../src/cfo/types";
import type { LineKey, PaymentKind, PaymentState } from "../src/schemas/enums";
import type { Hex32 } from "../src/schemas/primitives";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
export const COMMIT_MS = Date.parse("2026-10-16T00:00:00.000Z");

export const at = (day: number, hour = 12): Date => new Date(COMMIT_MS + day * DAY_MS + hour * HOUR_MS);
export const hex32 = (n: number): Hex32 => `0x${n.toString(16).padStart(64, "0")}` as Hex32;

let seq = 0;
export function pay(kind: PaymentKind, lineKey: LineKey | null, amountMinor: bigint, when: Date, extra: Partial<CfoPaymentIn> = {}): CfoPaymentIn {
  seq += 1;
  const state: PaymentState = "FINALIZED";
  return { kind, lineKey, amountMinor, state, at: when, txHash: hex32(seq), ...extra };
}

export const sale = (saleId: string, amountMinor: bigint, when: Date): CfoSaleIn => ({ saleId, amountMinor, at: when, txHash: hex32(10_000 + seq++) });

/** Applies operating spend / escrow funding to the matching line (allocated stays; available shrinks). */
export function withLineUse(lines: readonly CfoLineIn[], use: Partial<Record<LineKey, { spent?: bigint; escrowed?: bigint; windowSpent?: bigint }>>): CfoLineIn[] {
  return lines.map((l) => {
    const u = use[l.lineKey];
    if (!u) return l;
    const spentMinor = l.spentMinor + (u.spent ?? 0n);
    const escrowedMinor = l.escrowedMinor + (u.escrowed ?? 0n);
    return { ...l, spentMinor, escrowedMinor, availableMinor: l.allocatedMinor - spentMinor - escrowedMinor, windowSpentMinor: u.windowSpent ?? l.windowSpentMinor };
  });
}

export const patchLine = (lines: readonly CfoLineIn[], key: LineKey, patch: Partial<CfoLineIn>): CfoLineIn[] =>
  lines.map((l) => (l.lineKey === key ? { ...l, ...patch } : l));

/** Fresh Mei: plan committed, nothing paid or sold. "Now" is day 14, 12:00 UTC (2026-10-30T12:00Z). */
export const fresh = (now = at(14)): CfoInputs => meiCfoInputs(now);

export const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * 14 days of trading, "now" = day 14 12:00Z: two 4,500 sales a day on days 1-14 (126,000), ads paced at 7,500 a day
 * (105,000), platform fees 450 a day (6,300), and the supplier's auto-released sample + deposit (30,000 + 120,000)
 * funded on day 2. Reserve: 5 % of each sale (225 × 28 = 6,300).
 */
export function fourteenDays(salePerDay = 4_500n, opts: { autoReleased?: boolean } = {}): CfoInputs {
  const base = fresh();
  const days = range(1, 14);
  const sales = days.flatMap((d) => [sale(`sale-${d}-a`, salePerDay, at(d, 10)), sale(`sale-${d}-b`, salePerDay, at(d, 11))]);
  const autoReleased = opts.autoReleased ?? true;
  const payments = [
    ...days.map((d) => pay("SPEND", "ADS", 7_500n, at(d, 9))),
    ...days.map((d) => pay("SPEND", "PLATFORM_FEES", 450n, at(d, 9))),
    pay("FUND_MILESTONE", "SUPPLIER", 30_000n, at(2, 15), { autoReleased }),
    pay("FUND_MILESTONE", "SUPPLIER", 120_000n, at(2, 16), { autoReleased }),
  ];
  const skim = (salePerDay * 500n) / 10_000n;
  return {
    ...base,
    sales,
    payments,
    lines: withLineUse(base.lines, {
      ADS: { spent: 105_000n, windowSpent: 52_500n },
      PLATFORM_FEES: { spent: 6_300n, windowSpent: 3_150n },
      SUPPLIER: { escrowed: 150_000n },
    }),
    reserve: { ...base.reserve, skimmedMinor: skim * 28n },
  };
}

/**
 * Burn spike on ADS: an earlier loosen moved 80,000 from contingency into ads (allocation 200,000) and raised its
 * window cap to 100,000; ads paced 7,500 on days 1-7, then 12,500 a day on days 8-14 (87,500 in the last 7 days, 1.6× pace).
 */
export function adsSpike(): CfoInputs {
  const base = fourteenDays();
  const payments = [
    ...base.payments.filter((p) => p.lineKey !== "ADS"),
    ...range(1, 7).map((d) => pay("SPEND", "ADS", 7_500n, at(d, 9))),
    ...range(8, 14).map((d) => pay("SPEND", "ADS", 12_500n, at(d, 9))),
  ];
  const moved = patchLine(base.lines, "CONTINGENCY", { allocatedMinor: 20_000n, availableMinor: 20_000n });
  const lines = patchLine(moved, "ADS", {
    allocatedMinor: 200_000n,
    spentMinor: 140_000n,
    availableMinor: 60_000n,
    windowCapMinor: 100_000n,
    windowSpentMinor: 87_500n,
  });
  return { ...base, payments, lines };
}
