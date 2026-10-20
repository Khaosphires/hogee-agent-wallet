/**
 * Supplier terms checks (VISION-DECISIONS §9), shared by confirm (POST /api/orders/terms) and the web SupplierApproval
 * (prepare and finalize). Each re-reads server state; none trusts a chat pre-fill, a preset availability or the stored
 * schedule (core-terms audit flag: termsToSchedule runs again with the CURRENT limits every time).
 *
 * A refusal is an ApiProblem whose `details.reason` is the TERMS_* code (plus `idx` for one offending milestone):
 *   VALIDATION  what the founder typed breaks a rule on its own (split, total, payee type, account, holder);
 *   CONFLICT    server state refuses it (candidate, currency, pocket and caps, already bound, superseded);
 *   FORBIDDEN   a sanctions hit; UPSTREAM 503 when screening cannot run (nothing is stored or signed).
 */
import {
  MILESTONE_LABELS,
  WEB_PAYOUT_CHANNEL,
  hashObject,
  termsToSchedule,
  type ApiErrorCode,
  type Hex32,
  type MilestoneInput,
  type ScheduleRow,
  type TermsErrorCode,
  type TermsLimits,
} from "@hogee/core";
import type { ApiDeps, Scope } from "../context";
import { fail, type ApiProblem } from "../http/problem";
import { currencyFor } from "../runtime/env";
import { facilityRow } from "./facility";
import { policyWorld } from "./policy-context";
import { one, pool, rows, type Q } from "./sql";

/** `terms-` + a UUIDv7 (services/ids newId). */
export const TERMS_ID_RE = /^terms-[0-9a-f-]{36}$/;
/** The only payout channel a web supplier gets (fixed server-side, "simulated payout"; the worker pays it on MockRail). */
export const MOCK_ONLY_CHANNEL = WEB_PAYOUT_CHANNEL;
/** apps/worker rail/channels.ts PAYOUT_CHANNELS.MOCK_ONLY: its account form (BANK_ACCOUNT_RE) and currencies (parity-tested). */
export const MOCK_ONLY_ACCOUNT_RE = /^[0-9]{4,34}$/;
export const MOCK_ONLY_CURRENCIES: readonly string[] = ["MYR", "SGD"];

const STATUS_OF: Readonly<Record<TermsErrorCode, ApiErrorCode>> = {
  TERMS_COUNT: "VALIDATION",
  TERMS_PCT_RANGE: "VALIDATION",
  TERMS_PCT_SUM: "VALIDATION",
  TERMS_TRIGGER_ORDER: "VALIDATION",
  TERMS_LAST_NOT_INSPECTED: "VALIDATION",
  TERMS_TOTAL_INVALID: "VALIDATION",
  TERMS_OVER_POCKET: "CONFLICT",
  TERMS_MILESTONE_ZERO: "VALIDATION",
  TERMS_AUTO_NOT_FIRST: "VALIDATION",
  TERMS_WEB_AUTO_COUNT: "VALIDATION",
  TERMS_AUTO_OVER_PER_TX: "CONFLICT",
  TERMS_UPFRONT_OVER_HALF: "VALIDATION",
  TERMS_UPFRONT_OVER_WINDOW: "CONFLICT",
  TERMS_CANDIDATE: "CONFLICT",
  TERMS_CURRENCY: "CONFLICT",
  TERMS_PAYEE_PERSONAL: "VALIDATION",
  TERMS_ACCOUNT_FORMAT: "VALIDATION",
  TERMS_HOLDER_MISMATCH: "VALIDATION",
  TERMS_SANCTIONS: "FORBIDDEN",
  TERMS_ALREADY_BOUND: "CONFLICT",
  TERMS_SUPERSEDED: "CONFLICT",
};

/** Plain-English reason of each schedule rule (core termsToSchedule), for the refusal message. */
const SCHEDULE_MESSAGE: Readonly<Partial<Record<TermsErrorCode, string>>> = {
  TERMS_COUNT: "A schedule has 1 to 8 milestones",
  TERMS_PCT_RANGE: "Each milestone is between 0.01% and 100% of the total",
  TERMS_PCT_SUM: "The milestones must add up to 100%",
  TERMS_TRIGGER_ORDER: "Milestones must follow the order: on order, sample approval, shipment, delivery check",
  TERMS_LAST_NOT_INSPECTED: "The last milestone must be the balance after the delivery check",
  TERMS_TOTAL_INVALID: "The total must be a whole number of budget units above zero",
  TERMS_OVER_POCKET: "The total is more than the supplier pocket has free",
  TERMS_MILESTONE_ZERO: "Every milestone must be at least 1 BU",
  TERMS_AUTO_NOT_FIRST: "Payments the agent makes by itself must come first",
  TERMS_WEB_AUTO_COUNT: "A supplier found on the web gets at most one payment the agent makes by itself",
  TERMS_AUTO_OVER_PER_TX: "The deposit is above the supplier pocket's per-payment cap",
  TERMS_UPFRONT_OVER_HALF: "What the agent pays by itself can be at most half of the total",
  TERMS_UPFRONT_OVER_WINDOW: "The deposit is above what the supplier pocket may still pay this week",
};

/** A refusal naming its TERMS_* reason (and the offending milestone, when there is one). */
export function termsFailure(code: TermsErrorCode, message: string, idx?: number): ApiProblem {
  return fail(STATUS_OF[code], message, { details: { reason: code, ...(idx === undefined ? {} : { idx }) } });
}

export interface TermsSchedule {
  readonly amounts: readonly bigint[];
  readonly autoRelease: readonly boolean[];
  readonly labels: readonly string[];
}

/** core termsToSchedule for a web supplier under `limits`, or its TERMS_* refusal. */
export function webSchedule(totalMinor: bigint, milestones: readonly MilestoneInput[], limits: TermsLimits): TermsSchedule {
  const r = termsToSchedule({ totalMinor, milestones, origin: "web" }, limits);
  if (!r.ok) throw termsFailure(r.code, SCHEDULE_MESSAGE[r.code] ?? "These payment terms break a schedule rule", r.idx);
  return r;
}

/** The schedule rows as confirmed (nothing released yet). */
export function scheduleRowsOf(milestones: readonly MilestoneInput[], s: TermsSchedule): ScheduleRow[] {
  return milestones.map((m, idx) => ({
    idx,
    trigger: m.trigger,
    label: MILESTONE_LABELS[m.trigger],
    amountMinor: (s.amounts[idx] as bigint).toString(),
    autoRelease: s.autoRelease[idx] as boolean,
    released: false,
    txHash: null,
  }));
}

/** One automatic (autoRelease) milestone as supplierLimits counts it against the SUPPLIER window. */
export interface AutoMilestoneUse {
  readonly amountMinor: bigint;
  /** MilestoneEscrow's funded amount, as the worker's sync mirrors it. */
  readonly fundedMinor: bigint;
  /** What its mined FUND_MILESTONE payments carried (a recorded receipt can be ahead of the mirror, or behind it). */
  readonly landedMinor: bigint;
  /** Chain time of the block its latest funding was mined in; null when no mined funding is recorded. */
  readonly landedAt: bigint | null;
  /** Its order's payee is PENDING, COOLING or BOUND, so the order can still be funded. */
  readonly open: boolean;
}

/**
 * What automatic milestones take from the SUPPLIER window now (re-check 9 item 1). Escrow funding never moves the
 * on-chain windowSpent, so without this N orders, each with a deposit inside the window, would pay N times the window:
 * every open order's automatic milestone still to pay, plus every automatic payment that landed within the last
 * windowSeconds (chain time; one whose receipt is not recorded yet counts as paid now). Pure.
 */
export function autoWindowUsedMinor(ms: readonly AutoMilestoneUse[], at: { readonly now: bigint; readonly windowSeconds: bigint }): bigint {
  return ms.reduce((sum, m) => {
    const reached = m.fundedMinor > m.landedMinor ? m.fundedMinor : m.landedMinor;
    const unpaid = m.open && reached < m.amountMinor ? m.amountMinor - reached : 0n;
    const recent = reached > 0n && (m.landedAt === null || m.landedAt + at.windowSeconds > at.now) ? reached : 0n;
    return sum + unpaid + recent;
  }, 0n);
}

/**
 * A catalog schedule's automatic milestones under `limits` (the rules core termsToSchedule applies to web terms): each
 * at most the per-payment cap, and together at most what is left of the window. Held milestones are bounded by neither.
 */
export function autoLimitsProblem(schedule: readonly bigint[], autoRelease: readonly boolean[], limits: TermsLimits): { code: TermsErrorCode; idx?: number } | null {
  const over = schedule.findIndex((x, i) => autoRelease[i] === true && x > limits.perTxCapMinor);
  if (over >= 0) return { code: "TERMS_AUTO_OVER_PER_TX", idx: over };
  const auto = schedule.reduce((sum, x, i) => (autoRelease[i] === true ? sum + x : sum), 0n);
  return auto > limits.windowCapMinor ? { code: "TERMS_UPFRONT_OVER_WINDOW" } : null;
}

interface AutoMilestoneRow {
  amount_minor: string;
  funded_minor: string;
  landed_minor: string;
  landed_block: string | null;
  open: boolean;
}

/**
 * The facility's automatic milestones with their latest mined funding, dated in chain time newest first. Chain time
 * never decreases with the block number, so once one block is outside the window every older one is too: those are
 * not read (the cut-off block's time bounds them), and a funding mined after the snapshot block counts as now.
 */
async function autoMilestones(deps: ApiDeps, scope: Scope, at: { readonly blockNumber: bigint; readonly timestamp: bigint }, windowSeconds: bigint): Promise<AutoMilestoneUse[]> {
  const found = await rows<AutoMilestoneRow>(
    pool(deps.db),
    `select m.amount_minor::text as amount_minor, m.funded_minor::text as funded_minor, p.status in ('PENDING', 'COOLING', 'BOUND') as open,
            coalesce(f.landed_minor, 0)::text as landed_minor, f.landed_block::text as landed_block
       from escrow_milestones m
       join escrow_orders o on o.facility_id = m.facility_id and o.order_id = m.order_id
       join payees p on p.facility_id = o.facility_id and p.id = o.payee_id
       left join lateral (
         select sum(x.amount_minor) as landed_minor, max(x.block) as landed_block from payments x
          where x.facility_id = m.facility_id and x.kind = 'FUND_MILESTONE' and x.order_id = m.order_id and x.milestone_idx = m.idx
            and x.state in ('INCLUDED', 'FINALIZED', 'SETTLEMENT_REQUESTED', 'SETTLED', 'SETTLEMENT_FAILED') and x.block is not null) f on true
      where m.facility_id = $1 and m.auto_release
      order by f.landed_block desc nulls first`,
    [scope.facilityId],
  );
  const out: AutoMilestoneUse[] = [];
  let cutoff: bigint | null = null;
  for (const r of found) {
    let landedAt: bigint | null = null;
    if (r.landed_block !== null) {
      const block = BigInt(r.landed_block);
      if (block > at.blockNumber) landedAt = at.timestamp;
      else if (cutoff !== null) landedAt = cutoff;
      else {
        landedAt = (await deps.client.getBlock({ blockNumber: block })).timestamp;
        if (landedAt + windowSeconds <= at.timestamp) cutoff = landedAt;
      }
    }
    out.push({ amountMinor: BigInt(r.amount_minor), fundedMinor: BigInt(r.funded_minor), landedMinor: BigInt(r.landed_minor), landedAt, open: r.open });
  }
  return out;
}

/**
 * The SUPPLIER pocket's limits now: free = allocated − spent − escrowed (the chain snapshot) − what open escrow orders
 * still have to fund (so two orders never promise the same budget); the per-payment cap; and the window left for a NEW
 * order's automatic milestones: windowCap − windowSpent − autoWindowUsedMinor (re-check 9 item 1). CONFLICT when there
 * is no committed plan or no escrow-only supplier pocket.
 */
export async function supplierLimits(deps: ApiDeps, scope: Scope): Promise<TermsLimits> {
  const world = await policyWorld(deps, scope);
  const line = world.manifest.lines.find((l) => l.lineKey === "SUPPLIER" && l.escrowOnly);
  const state = world.ctx.lines.SUPPLIER;
  const view = line ? world.snapshot.lines.find((l) => l.lineId.toLowerCase() === line.lineId.toLowerCase()) : undefined;
  if (!line || !state || !view) throw termsFailure("TERMS_OVER_POCKET", "The committed plan has no escrow-only supplier pocket");
  const open = await one<{ n: string }>(
    pool(deps.db),
    `select coalesce(sum(m.amount_minor - m.funded_minor), 0)::text as n
       from escrow_milestones m
       join escrow_orders o on o.facility_id = m.facility_id and o.order_id = m.order_id
       join payees p on p.facility_id = o.facility_id and p.id = o.payee_id
      where m.facility_id = $1 and p.status in ('PENDING', 'COOLING', 'BOUND') and m.funded_minor < m.amount_minor`,
    [scope.facilityId],
  );
  const windowSeconds = BigInt(view.pocket.windowSeconds);
  const auto = autoWindowUsedMinor(await autoMilestones(deps, scope, world.snapshot, windowSeconds), { now: world.snapshot.timestamp, windowSeconds });
  const free = BigInt(state.allocatedMinor) - BigInt(state.spentMinor) - BigInt(state.escrowedMinor) - BigInt(open?.n ?? "0");
  const window = BigInt(state.windowCapMinor) - BigInt(state.windowSpentMinor) - auto;
  return { freeMinor: free > 0n ? free : 0n, perTxCapMinor: BigInt(state.perTxCapMinor), windowCapMinor: window > 0n ? window : 0n };
}

/** The facility's currency, when the server prices in it and the MOCK_ONLY channel may pay it; else TERMS_CURRENCY. */
export async function termsCurrency(deps: ApiDeps, q: Q, scope: Scope): Promise<string> {
  const f = await facilityRow(q, scope);
  if (!f) throw fail("CONFLICT", "The loan officer has not opened the facility yet");
  const own = currencyFor(deps.config.countryCode);
  if (f.currency !== own || deps.config.currency !== own || !MOCK_ONLY_CURRENCIES.includes(own)) {
    throw termsFailure("TERMS_CURRENCY", `This server works in ${own}, but the facility is in ${f.currency}; nothing was saved`);
  }
  return own;
}

/** TERMS_ACCOUNT_FORMAT: the MOCK_ONLY account form, and not one digit repeated (a placeholder, never an account). */
export function accountFormatOk(accountNumber: string): boolean {
  return MOCK_ONLY_ACCOUNT_RE.test(accountNumber) && !/^(\d)\1*$/.test(accountNumber);
}

/** The payout destination the founder signs the hash of: the channel is fixed here, never taken from a request. */
export function payoutAccountOf(p: { readonly accountNumber: string; readonly holderName: string }): { channel: string; accountNumber: string; holderName: string } {
  return { channel: MOCK_ONLY_CHANNEL, accountNumber: p.accountNumber, holderName: p.holderName };
}

/** SupplierApproval.quoteHash of web terms: one implementation in core, shared with the mock and pinned by a parity test. */
export { webQuoteHash, type WebQuote } from "@hogee/core";

/**
 * Sanctions on every name that identifies who is paid (the founder's holder and the Reader's seller name): a hit is
 * TERMS_SANCTIONS; screening that cannot run answers 503 and nothing is stored or signed (fail closed).
 */
export async function screenTermsNames(deps: ApiDeps, names: readonly string[]): Promise<void> {
  let hits: boolean[];
  try {
    hits = await Promise.all(
      [...new Set(names)].map(async (name) => {
        const { hit } = await deps.checks.screenSanctions(name);
        if (typeof hit !== "boolean") throw new TypeError("sanctions screening answered without a verdict");
        return hit;
      }),
    );
  } catch (error: unknown) {
    deps.log.warn("terms_sanctions_unavailable", { error });
    throw fail("UPSTREAM", "The sanctions screening could not run, so nothing was saved or signed; try again shortly", {
      status: 503,
      details: { reason: "TERMS_SANCTIONS", unavailable: true },
    });
  }
  if (hits.some(Boolean)) throw termsFailure("TERMS_SANCTIONS", "The account holder or the seller is on a sanctions list; this supplier cannot be paid");
}
