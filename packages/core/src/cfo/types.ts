/**
 * AI CFO shapes (VISION-DECISIONS §3 `cfo.ts`, §8 core-cfo). Pure TS: money is a `bigint` here and a digit string in
 * JSON (toCfoReportJson in ./json.ts gives the §3 wire shape). v-contract builds the zod schema in parallel; the
 * section marked "local mirrors" below repeats §2/§3 names so this folder compiles on its own, and P1 swaps it for
 * imports from ../schemas at merge.
 */
import type { LineKey, PaymentKind, PaymentState } from "../schemas/enums";
import type { CurrencyCode, Hex32, Id, IsoDate, IsoDateTime, PayeeId, StageId, UnixSeconds } from "../schemas/primitives";
import type { TightenAction } from "../policy/types";

// ---- Local mirrors of VISION §2 / §3 (replace with ../schemas imports at merge) --------------------------------
export const CFO_VIEWS = ["overview", "spending", "sales", "pnl", "forecast", "reserve"] as const;
export type CfoView = (typeof CFO_VIEWS)[number];
export const CFO_INSIGHT_KINDS = ["BURN_ALERT", "RUNWAY_SHORT", "STAGE2_ON_TRACK", "STAGE2_AT_RISK", "RESERVE_STATUS", "MOVE_BUDGET"] as const;
export type CfoInsightKind = (typeof CFO_INSIGHT_KINDS)[number];
export const CFO_SUGGESTION_KINDS = ["TIGHTEN", "REQUEST_MOVE", "REQUEST_STAGE_RELEASE"] as const;
export type CfoSuggestionKind = (typeof CFO_SUGGESTION_KINDS)[number];

export const CFO_DISCLAIMER = "Estimates from your own records. Not financial advice." as const;

export interface CfoInsight {
  readonly insightId: Id;
  readonly kind: CfoInsightKind;
  readonly severity: "info" | "warn";
  /** ≤ 80 chars. */
  readonly title: string;
  /** ≤ 280 chars. */
  readonly detail: string;
  readonly lineKey: LineKey | null;
  readonly suggestion: { readonly kind: CfoSuggestionKind; readonly href: string | null } | null;
}

/** A tightening the agent made on its own (recorded by the cfo-guard job). `newValue`: a cap in minor units or reserve bps. */
export interface CfoAgentAction {
  readonly at: IsoDateTime;
  readonly action: TightenAction;
  readonly lineKey: LineKey | null;
  readonly newValue: string;
  /** ≤ 200 chars. */
  readonly reason: string;
  readonly txHash: Hex32 | null;
}

// ---- Inputs ------------------------------------------------------------------------------------------------------
/** A budget line as mirrored from Treasury.pocket at the snapshot (current caps, tighten/loosen applied). */
export interface CfoLineIn {
  readonly lineKey: LineKey;
  readonly allocatedMinor: bigint;
  readonly spentMinor: bigint;
  readonly escrowedMinor: bigint;
  readonly availableMinor: bigint;
  readonly perTxCapMinor: bigint;
  readonly windowCapMinor: bigint;
  readonly windowSpentMinor: bigint;
  /** Unix seconds. */
  readonly validUntil: bigint | UnixSeconds;
  /** Optional (core-cfo addition): pocket.pacingMinor, one slot a day. Absent or 0 = not a pacing line. */
  readonly pacingMinor?: bigint;
  /** Optional (core-cfo addition): pocket.windowSeconds. Absent = LOWER_WINDOW_CAP is never sized for this line. */
  readonly windowSeconds?: bigint;
  /**
   * Optional (fixr-cfo addition): the committed plan's caps for this line (manifest perTxCapMinor / windowCapMinor). The
   * agent never lowers a cap below half of its committed value, and a raise link restores it. Absent = the agent
   * proposes no cap change on this line (it cannot know how far it may go).
   */
  readonly committedPerTxCapMinor?: bigint;
  readonly committedWindowCapMinor?: bigint;
}

export interface CfoPaymentIn {
  readonly kind: PaymentKind;
  /** Null exactly for WITHDRAW_RESERVE. */
  readonly lineKey: LineKey | null;
  readonly amountMinor: bigint;
  readonly state: PaymentState;
  readonly at: Date;
  readonly txHash: Hex32 | null;
  /**
   * Optional (core-cfo addition), FUND_MILESTONE only: this funding completed an autoRelease milestone, so
   * MilestoneEscrow paid the supplier in the same transaction (no RELEASE_MILESTONE row ever follows). Counted as
   * supplier cost. Absent = false (escrowed, not cost).
   */
  readonly autoReleased?: boolean;
}

export interface CfoSaleIn {
  readonly saleId: Id;
  readonly amountMinor: bigint;
  readonly at: Date;
  readonly txHash: Hex32 | null;
}

export interface CfoInputs {
  readonly currency: CurrencyCode;
  readonly now: Date;
  readonly facilityId: Id;
  readonly lines: readonly CfoLineIn[];
  readonly payments: readonly CfoPaymentIn[];
  readonly sales: readonly CfoSaleIn[];
  /** rateBps: the live on-chain rate (tighten may have raised it). skimmed − withdrawn = the reserve balance. */
  readonly reserve: { readonly rateBps: number; readonly skimmedMinor: bigint; readonly withdrawnMinor: bigint; readonly taxPayeeId: PayeeId };
  /** The next gated stage (stage 2 for the demo), or null when none is left. */
  readonly stage: { readonly stageId: StageId; readonly targetMinor: bigint; readonly deadline: Date } | null;
  /** The committed plan's reserveBps. */
  readonly reserveBps: number;
  readonly agentActions: readonly CfoAgentAction[];
  /**
   * Optional (core-cfo addition): Treasury.releasedMinor / fundedMinor. Spend and escrow funding revert CapExceeded
   * once total outflow (spent + escrowed) would pass either, so when given they cap cashAvailable. Absent = not capped.
   */
  readonly releasedMinor?: bigint;
  readonly fundedMinor?: bigint;
}

// ---- Report (bigint money) -----------------------------------------------------------------------------------------
export interface CfoLineSpend {
  readonly lineKey: LineKey;
  readonly allocatedMinor: bigint;
  readonly spentMinor: bigint;
  readonly escrowedMinor: bigint;
  readonly availableMinor: bigint;
}

export interface CfoStageGate {
  readonly stageId: StageId;
  readonly targetMinor: bigint;
  readonly soFarMinor: bigint;
  readonly deadline: IsoDate;
  readonly projectedDate: IsoDate | null;
}

export interface CfoReport {
  readonly asOf: IsoDateTime;
  readonly currency: CurrencyCode;
  readonly facilityId: Id;
  readonly overview: {
    readonly cashAvailableMinor: bigint;
    readonly spentMinor: bigint;
    readonly revenueMinor: bigint;
    readonly reserveMinor: bigint;
    /** Signed. */
    readonly netMinor: bigint;
  };
  readonly spending: {
    readonly byLine: readonly CfoLineSpend[];
    readonly daily: readonly { readonly date: IsoDate; readonly spentMinor: bigint }[];
  };
  readonly sales: {
    readonly count: number;
    readonly revenueMinor: bigint;
    readonly averageMinor: bigint;
    readonly daily: readonly { readonly date: IsoDate; readonly revenueMinor: bigint; readonly count: number }[];
    readonly recent: readonly { readonly saleId: Id; readonly amountMinor: bigint; readonly at: IsoDateTime; readonly txHash: Hex32 | null }[];
    readonly stageGate: CfoStageGate | null;
  };
  readonly pnl: {
    readonly from: IsoDate;
    readonly to: IsoDate;
    readonly revenueMinor: bigint;
    readonly supplierCostMinor: bigint;
    readonly operatingByLine: readonly { readonly lineKey: LineKey; readonly amountMinor: bigint }[];
    readonly operatingMinor: bigint;
    /** Signed. */
    readonly netMinor: bigint;
    readonly reserveSetAsideMinor: bigint;
    readonly basis: "cash";
  };
  readonly forecast: {
    readonly method: "MA7_LINEAR";
    readonly sampleDays: number;
    readonly dailyBurnMinor: bigint;
    readonly dailyRevenueMinor: bigint;
    readonly runwayDays: number | null;
    readonly stage2Date: IsoDate | null;
    readonly reserveIn30dMinor: bigint;
    /** cashMinor is signed. */
    readonly points: readonly { readonly date: IsoDate; readonly cashMinor: bigint }[];
  };
  readonly reserve: {
    readonly rateBps: number;
    readonly skimmedMinor: bigint;
    readonly withdrawnMinor: bigint;
    readonly balanceMinor: bigint;
    readonly taxPayeeId: PayeeId;
    readonly salesCount: number;
  };
  readonly insights: readonly CfoInsight[];
  readonly agentActions: readonly CfoAgentAction[];
  readonly disclaimer: typeof CFO_DISCLAIMER;
}

/** A tighten-only change the agent may make alone (proposeTightenings); the cfo-guard job sends it via evaluateTighten. */
export interface CfoTightening {
  readonly action: TightenAction;
  readonly lineKey: LineKey | null;
  readonly newValue: bigint;
  /** ≤ 200 chars, founder-readable. */
  readonly reason: string;
  /**
   * fixr-cfo addition, cap tightenings only: the in-app change request that raises this cap back to its committed
   * value, prefilled (`/dashboard?raise=<line>&cap=<perTx|window>&to=<minor>#change-requests`). Absent for the reserve.
   */
  readonly raiseHref?: string;
}

/** Bad input (negative money, an invalid date, an impossible reserve): the CFO refuses rather than guess. */
export class CfoInputError extends Error {
  override readonly name = "CfoInputError";
}
