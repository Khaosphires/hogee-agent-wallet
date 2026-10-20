/**
 * Terms the founder could be talked into ("60% up front", "two deposits", "pay the rest on shipment") built from the
 * CURRENT limits of the SUPPLIER pocket, each aimed at exactly one TERMS_* refusal (VISION-DECISIONS §8 rule order).
 * The expected code is not the red team's guess: every attack is run through core termsToSchedule first (the same
 * pure function the API calls at confirm, prepare and finalize), and an attack whose first failing code is not the
 * intended one is reported as not constructible under these limits instead of being sent.
 *
 * Totals are sized away from the other thresholds, so a server whose free pocket is a little smaller than the one read
 * here (v-terms also subtracts what open escrow orders still have to fund) still fails on the intended rule first.
 */
import { BU_MINOR, termsToSchedule, type MilestoneTrigger, type TermsErrorCode, type TermsLimits } from "@hogee/core";

export interface TermsMilestoneIn {
  readonly bps: number;
  readonly trigger: MilestoneTrigger;
}

export interface TermsAttack {
  readonly name: string;
  readonly expected: TermsErrorCode;
  readonly totalMinor: bigint;
  readonly milestones: readonly TermsMilestoneIn[];
  /** What the founder would have been asked to accept, in plain words (row titles). */
  readonly story: string;
}

export interface TermsAttackSet {
  readonly attacks: readonly TermsAttack[];
  /** Attacks these limits cannot express with the intended code first (never sent; listed in the artifact). */
  readonly skipped: readonly { readonly name: string; readonly expected: TermsErrorCode; readonly why: string }[];
}

const bu = (n: bigint): bigint => n * BU_MINOR;
const floorBu = (minor: bigint): bigint => minor - (minor % BU_MINOR);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const M = (bps: number, trigger: MilestoneTrigger): TermsMilestoneIn => ({ bps, trigger });

/** The candidate attacks before the oracle check (a total of 0n means "not constructible": `why` says why). */
function candidates(l: TermsLimits): (TermsAttack & { readonly why?: string })[] {
  const free = floorBu(l.freeMinor);
  const p = l.perTxCapMinor;
  // 49% deposit over the per-payment cap, at 2.5x the cap (well inside the pocket when the pocket allows it).
  const overPerTx = min(floorBu((p * 5n) / 2n), free);
  // 60% deposit kept under the per-payment cap: total ≤ cap / 0.6, and small next to the pocket.
  const sixty = min(floorBu((p * 10_000n) / 6_000n), floorBu(free / 2n));
  const small = min(bu(500n), free);
  return [
    { name: "two-deposits", expected: "TERMS_WEB_AUTO_COUNT", totalMinor: small, milestones: [M(1000, "ON_ORDER"), M(1000, "ON_ORDER"), M(8000, "ON_DELIVERY_INSPECTED")], story: "two payments on order (10% + 10%), the rest after the delivery check" },
    {
      name: "deposit-over-per-payment-cap",
      expected: "TERMS_AUTO_OVER_PER_TX",
      totalMinor: (overPerTx * 4_900n) / 10_000n > p ? overPerTx : 0n,
      milestones: [M(4900, "ON_ORDER"), M(5100, "ON_DELIVERY_INSPECTED")],
      story: "a 49% deposit larger than one payment may be",
      why: "the pocket is too small for a 49% deposit above the per-payment cap",
    },
    { name: "sixty-percent-up-front", expected: "TERMS_UPFRONT_OVER_HALF", totalMinor: sixty >= bu(20n) ? sixty : 0n, milestones: [M(6000, "ON_ORDER"), M(4000, "ON_DELIVERY_INSPECTED")], story: "60% paid on order, 40% after the delivery check", why: "the cap or pocket leaves no room for a 60% deposit" },
    { name: "over-the-pocket", expected: "TERMS_OVER_POCKET", totalMinor: floorBu(l.freeMinor) + BU_MINOR, milestones: [M(10_000, "ON_DELIVERY_INSPECTED")], story: "an order 1 BU larger than the free supplier budget, all after the delivery check" },
    { name: "deposit-rounds-to-zero", expected: "TERMS_MILESTONE_ZERO", totalMinor: min(bu(100n), free), milestones: [M(1, "ON_ORDER"), M(9999, "ON_DELIVERY_INSPECTED")], story: "a 0.01% deposit (under 1 BU)" },
    { name: "balance-before-deposit", expected: "TERMS_TRIGGER_ORDER", totalMinor: small, milestones: [M(7000, "ON_DELIVERY_INSPECTED"), M(3000, "ON_ORDER")], story: "the delivery-check payment listed before the deposit" },
    { name: "rest-on-shipment", expected: "TERMS_LAST_NOT_INSPECTED", totalMinor: small, milestones: [M(3000, "ON_ORDER"), M(7000, "ON_SHIPMENT")], story: "30% on order and the rest on shipment, with no delivery check" },
    { name: "parts-add-to-110", expected: "TERMS_PCT_SUM", totalMinor: small, milestones: [M(3000, "ON_ORDER"), M(8000, "ON_DELIVERY_INSPECTED")], story: "parts adding up to 110%" },
    { name: "total-not-whole-bu", expected: "TERMS_TOTAL_INVALID", totalMinor: small + 50n, milestones: [M(10_000, "ON_DELIVERY_INSPECTED")], story: "a total of half a BU more than a whole number" },
    { name: "deposit-over-window", expected: "TERMS_UPFRONT_OVER_WINDOW", ...overWindow(l), story: "one deposit inside the per-payment cap but over what is left of the rolling window" },
  ];
}

/** One auto part in (window, min(perTx, total / 2)]; only constructible after the window has been partly used. */
function overWindow(l: TermsLimits): { totalMinor: bigint; milestones: readonly TermsMilestoneIn[]; why?: string } {
  const total = floorBu(l.freeMinor);
  const ceiling = min(l.perTxCapMinor, total / 2n);
  if (total <= 0n || ceiling <= l.windowCapMinor) return { totalMinor: 0n, milestones: [M(10_000, "ON_DELIVERY_INSPECTED")], why: "what is left of the window is not below the per-payment cap and half the total" };
  for (let bps = Number((ceiling * 10_000n) / total); bps > 0; bps -= 1) {
    const amount = floorBu((total * BigInt(bps)) / 10_000n);
    if (amount <= l.windowCapMinor) break;
    if (amount <= ceiling) return { totalMinor: total, milestones: [M(bps, "ON_ORDER"), M(10_000 - bps, "ON_DELIVERY_INSPECTED")] };
  }
  return { totalMinor: 0n, milestones: [M(10_000, "ON_DELIVERY_INSPECTED")], why: "no whole-bps deposit lands between the window and the cap" };
}

/** The attacks for a web supplier under `limits`, each confirmed against core termsToSchedule. */
export function termsAttacks(limits: TermsLimits): TermsAttackSet {
  const attacks: TermsAttack[] = [];
  const skipped: { name: string; expected: TermsErrorCode; why: string }[] = [];
  for (const c of candidates(limits)) {
    const { why, ...attack } = c;
    if (attack.totalMinor <= 0n) {
      skipped.push({ name: attack.name, expected: attack.expected, why: why ?? "no total fits" });
      continue;
    }
    const r = termsToSchedule({ totalMinor: attack.totalMinor, milestones: attack.milestones, origin: "web" }, limits);
    if (r.ok || r.code !== attack.expected) {
      skipped.push({ name: attack.name, expected: attack.expected, why: `core termsToSchedule answers ${r.ok ? "ok" : r.code} under these limits` });
      continue;
    }
    attacks.push(attack);
  }
  return { attacks, skipped };
}

/**
 * HTTP status of each TERMS_* refusal (v-terms' STATUS_OF, confirmed by v-terms 19 Oct): rule and form content 422,
 * what depends on the facility's current state 409, a sanctions hit 403 (screening unavailable is 503 on its own).
 */
export const TERMS_HTTP_STATUS: Readonly<Record<TermsErrorCode, 403 | 409 | 422>> = Object.freeze({
  TERMS_COUNT: 422,
  TERMS_PCT_RANGE: 422,
  TERMS_PCT_SUM: 422,
  TERMS_TRIGGER_ORDER: 422,
  TERMS_LAST_NOT_INSPECTED: 422,
  TERMS_TOTAL_INVALID: 422,
  TERMS_OVER_POCKET: 409,
  TERMS_MILESTONE_ZERO: 422,
  TERMS_AUTO_NOT_FIRST: 422,
  TERMS_WEB_AUTO_COUNT: 422,
  TERMS_AUTO_OVER_PER_TX: 409,
  TERMS_UPFRONT_OVER_HALF: 422,
  TERMS_UPFRONT_OVER_WINDOW: 409,
  TERMS_CANDIDATE: 409,
  TERMS_CURRENCY: 409,
  TERMS_PAYEE_PERSONAL: 422,
  TERMS_ACCOUNT_FORMAT: 422,
  TERMS_HOLDER_MISMATCH: 422,
  TERMS_SANCTIONS: 403,
  TERMS_ALREADY_BOUND: 409,
  TERMS_SUPERSEDED: 409,
});

/**
 * The demo order (P1, 19 Oct; VISION-WAVE1-NOTES int-live2): 2,500 BU at 30/70, a 750 BU deposit paid by the agent and a
 * 1,750 BU balance after the delivery check. The worker escrows the balance right after cooling, so the order holds
 * 2,500 BU of Mei's 4,000 BU stage-1 release and leaves room for packaging, ads and logistics.
 */
export const DEMO_ORDER = Object.freeze({ totalMinor: bu(2_500n), milestones: [M(3000, "ON_ORDER"), M(7000, "ON_DELIVERY_INSPECTED")] as const, depositMinor: bu(750n), balanceMinor: bu(1_750n) });

/** Limits read from GET /api/balances' SUPPLIER pocket (window remaining unknown there: bounded by the window cap). */
export function limitsFromPocket(p: { readonly available: string; readonly perTxCap: string; readonly windowCap: string }): TermsLimits {
  return { freeMinor: BigInt(p.available), perTxCapMinor: BigInt(p.perTxCap), windowCapMinor: BigInt(p.windowCap) };
}
