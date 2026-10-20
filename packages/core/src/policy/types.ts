/**
 * Policy engine inputs (project.md §7.2 step 3). The context is a snapshot of on-chain state (mirrored by the
 * worker) plus the committed plan; proposals carry taint labels on every value that matters.
 */
import type { ConstitutionCode, ExceptionKind, LineKey, PolicyVerdict } from "../schemas/enums";
import type { PlanDraft, PlanManifest } from "../schemas/plan";
import type { Hex32, Id, Minor, OrderId, PayeeId, StageId, Taint, UnixSeconds } from "../schemas/primitives";
import type { ConstitutionFacility, RegistryPayee } from "../constitution/types";
import type { Labeled } from "../taint/labels";

/**
 * The reserve's id (Treasury LINE_RESERVE = bytes32("RESERVE")). It is not a line (§26.2): spend and ownerSpend refuse
 * it with ReserveLocked (T8); only a founder + lender WITHDRAW_RESERVE moves reserve BU.
 */
export const RESERVE_LINE_KEY = "RESERVE";
/** What a spend may name as its line: a plan line, or the reserve (always refused, T8). */
export type SpendLineKey = LineKey | typeof RESERVE_LINE_KEY;

export interface PolicyLineState {
  /** Line amount after MOVE_POCKETS. */
  readonly allocatedMinor: Minor;
  readonly spentMinor: Minor;
  readonly escrowedMinor: Minor;
  /** Current caps (tighten/loosen applied). */
  readonly perTxCapMinor: Minor;
  readonly windowCapMinor: Minor;
  /** Sum of spends in the last windowSeconds (Treasury.rollingSpent). */
  readonly windowSpentMinor: Minor;
  /** Live entries in the line's rolling window (Treasury allows MAX_LIVE_SPENDS_PER_WINDOW). Absent = not mirrored. */
  readonly windowLiveSpends?: number;
  readonly validUntil: UnixSeconds;
  readonly paused: boolean;
  readonly circuitOpen: boolean;
  /** Pacing lines: the next on-chain sequence number (Treasury.lineSequence). */
  readonly nextSequence: number;
  /**
   * Payees Treasury.spend may pay from this line: listed on it in the current plan version, plus any a LOOSEN_ADD_PAYEE
   * appended since. Absent = the committed manifest line's payeeIds. A re-commit that drops a payee de-authorises it
   * for spend even though its binding stays.
   */
  readonly payeeIds?: readonly PayeeId[];
}

export interface PolicyPayeeState extends RegistryPayee {
  /** PayeeBinding.paidMinor. */
  readonly paidMinor: Minor;
}

export interface PolicyMilestone {
  readonly amountMinor: Minor;
  readonly fundedMinor: Minor;
  readonly autoRelease: boolean;
  readonly released: boolean;
  /**
   * A release settlement exists for this milestone (Treasury.isIntentUsed(keccak256(abi.encode(orderId, idx))) or a
   * MilestoneReleased event). On-chain this implies `released` (re-check M-1: a failed payout returns the BU to the
   * supplier line and leaves the milestone released for good), so the policy treats it as released (MilestoneLocked)
   * when a stale mirror reads otherwise. Absent = none.
   */
  readonly settlementUsed?: boolean;
}

export interface PolicyEscrowOrder {
  readonly orderId: OrderId;
  readonly payeeId: PayeeId;
  readonly lineKey: LineKey;
  readonly inspectionRequired: boolean;
  readonly milestones: readonly PolicyMilestone[];
}

/** Stored status of a queued loosening (Treasury.queuedLoosen; the view's EXPIRED is a QUEUED one past expiresAt). */
export type LoosenStatus = "QUEUED" | "EXECUTED" | "CANCELLED";

/** A loosening Treasury has queued, with the request founder and lender co-signed. */
export interface PolicyQueuedLoosen {
  /** HogeeTypes.hashLoosenRequest(req). */
  readonly loosenId: Hex32;
  readonly request: LoosenRequestIn;
  readonly status: LoosenStatus;
  /** queuedAt + loosenTimelockSeconds. */
  readonly executableAt: UnixSeconds;
  /** executableAt + 7 days (LOOSEN_GRACE_SECONDS). */
  readonly expiresAt: UnixSeconds;
}

export interface PolicyStageState {
  readonly stageId: StageId;
  readonly released: boolean;
}

export interface PolicyContext {
  readonly now: bigint | UnixSeconds;
  /** The committed plan (current version). With `lines`, `reserveBps` and `agent` it is the state a REPLAN must tighten. */
  readonly plan: PlanManifest;
  readonly planHash: Hex32;
  /** PlanRegistry.planVersion(). */
  readonly planVersion: number;
  readonly paused: boolean;
  readonly agent: { readonly revoked: boolean; readonly expiresAt: UnixSeconds };
  readonly releasedMinor: Minor;
  /** Treasury._fundedMinor: what the lender has funded; spend outflow may not exceed it. Absent = not mirrored. */
  readonly fundedMinor?: Minor;
  /** spend + ownerSpend. */
  readonly totalSpentMinor: Minor;
  readonly totalEscrowedMinor: Minor;
  readonly reserveMinor: Minor;
  /** Current reserveBps (tighten may have raised it). */
  readonly reserveBps: number;
  readonly lines: Readonly<Partial<Record<LineKey, PolicyLineState>>>;
  readonly payees: readonly PolicyPayeeState[];
  readonly usedIntents: ReadonlySet<string>;
  readonly paidInvoices: ReadonlySet<string>;
  readonly escrowOrders: readonly PolicyEscrowOrder[];
  readonly stages: readonly PolicyStageState[];
  /** For REPLAN constitution checks: cap, reserve floor, judging-window end (payees come from `payees`, the live registry). */
  readonly facility: ConstitutionFacility;
  /**
   * Loosenings Treasury has queued (executed and cancelled ones may stay listed). The QUEUED ones with now <= expiresAt
   * are the live list queueLoosen bounds at MAX_QUEUED_LOOSENS. Absent = not mirrored (the bound is not checked).
   */
  readonly loosens?: readonly PolicyQueuedLoosen[];
}

/** What triggered a proposal: a trusted plan tick / user turn, or untrusted content (a listing, an email). */
interface Base {
  readonly origin: Taint;
}

export interface SpendProposalIn extends Base {
  readonly kind: "SPEND";
  /** RESERVE is refused right after the agent gate (ReserveLocked, T8). */
  readonly lineKey: Labeled<SpendLineKey>;
  readonly payeeId: Labeled<PayeeId>;
  readonly amountMinor: Labeled<Minor>;
  readonly invoiceHash: Hex32;
  /** keccak256(abi.encode(planId, lineId, payeeId, invoiceHash, amount)), built by the tx builder. */
  readonly intentId: Hex32;
  readonly planVersion: number;
  /** Invoice spend (Reader flags attached) or a pacing slot of the line. */
  readonly basis: { readonly invoiceId: Id; readonly flags: readonly string[] } | { readonly pacingSlot: number };
}

export interface FundMilestoneProposalIn extends Base {
  readonly kind: "FUND_MILESTONE";
  readonly orderId: Labeled<OrderId>;
  readonly idx: number;
  readonly amountMinor: Labeled<Minor>;
  /** The plan version the agent decided under. Off-chain only: fundMilestone takes no planVersion. */
  readonly planVersion: number;
  /**
   * Reader flags on the supplier invoice this funding answers (bindMilestoneInvoice). Off-chain only: an escalating
   * flag (ESCALATING_INVOICE_FLAGS) sends an otherwise valid funding to the loan officer. Absent = no invoice.
   */
  readonly invoiceFlags?: readonly string[];
}

export const TIGHTEN_ACTIONS = ["LOWER_PER_TX_CAP", "LOWER_WINDOW_CAP", "RAISE_RESERVE_BPS", "REVOKE_AGENT", "PAUSE_LINE", "PAUSE"] as const;
export type TightenAction = (typeof TIGHTEN_ACTIONS)[number];

export interface TightenProposalIn extends Base {
  readonly kind: "TIGHTEN";
  readonly action: TightenAction;
  readonly lineKey?: Labeled<LineKey>;
  /** New cap (minor) or reserve bps (digit string). Untrusted values may only tighten. */
  readonly newValue?: Labeled<string>;
}

export type LoosenRequestIn =
  | { readonly kind: "RAISE_CAP"; readonly lineKey: LineKey; readonly cap: "perTx" | "window"; readonly newCapMinor: Labeled<Minor> }
  | {
      readonly kind: "ADD_PAYEE";
      readonly lineKey: LineKey;
      readonly payeeId: Labeled<PayeeId>;
      /** The payout destination founder and lender sign (LoosenRequest.newValue). Absent = not chosen yet. */
      readonly payoutAccountHash?: Hex32;
    }
  | { readonly kind: "EXTEND_EXPIRY"; readonly target: "agent" | "line"; readonly lineKey?: LineKey; readonly newExpiresAt: Labeled<UnixSeconds> }
  | { readonly kind: "MOVE_POCKETS"; readonly fromLineKey: LineKey; readonly toLineKey: LineKey; readonly amountMinor: Labeled<Minor> }
  | { readonly kind: "UNPAUSE"; readonly lineKey?: LineKey }
  | { readonly kind: "WITHDRAW_RESERVE"; readonly amountMinor: Labeled<Minor>; readonly taxPayeeId: Labeled<PayeeId> };

export interface LoosenProposalIn extends Base {
  readonly kind: "LOOSEN";
  readonly request: LoosenRequestIn;
}

/** Run a queued loosening after its timelock (executeLoosen: anyone may send it; founder and lender already signed). */
export interface ExecuteLoosenProposalIn extends Base {
  readonly kind: "EXECUTE_LOOSEN";
  readonly loosenId: Hex32;
}

export interface ReleaseMilestoneProposalIn extends Base {
  readonly kind: "RELEASE_MILESTONE";
  readonly orderId: OrderId;
  readonly idx: number;
  readonly evidenceHash?: Hex32;
  /** MilestoneRelease.amountMinor the founder signs. Absent = the scheduled amount. */
  readonly amountMinor?: Minor;
}

export interface ReleaseStageProposalIn extends Base {
  readonly kind: "RELEASE_STAGE";
  readonly stageId: StageId;
  /** Recorded sales (oracle fact, Treasury.revenue()); must be trusted. */
  readonly salesMinor: Labeled<Minor>;
  /** Number of recorded sales (oracle fact, revenueLedger().salesCount) for an `orders` gate; must be trusted. */
  readonly salesCount?: Labeled<string>;
}

export interface ReplanProposalIn extends Base {
  readonly kind: "REPLAN";
  readonly draft: PlanDraft;
}

/** Functions the agent key can never call successfully (§13.2 T2, T5, T6, T8, T9, T23, T24). */
export const DIRECT_CALLS = [
  "commitPlan",
  "bindPayee",
  "queueLoosen",
  "executeLoosen",
  "ownerSpend",
  "releaseMilestone",
  "releaseStage",
  "cancelLoosen",
  "fund",
  "openFacility",
  "registerFounderKey",
  "recordSale",
  "confirmSettlement",
  "failSettlement",
  "withdrawReserve",
] as const;
export type DirectCall = (typeof DIRECT_CALLS)[number];

export interface DirectCallProposalIn extends Base {
  readonly kind: "DIRECT_CALL";
  readonly fn: DirectCall;
}

export type PolicyProposal =
  | SpendProposalIn
  | FundMilestoneProposalIn
  | TightenProposalIn
  | LoosenProposalIn
  | ExecuteLoosenProposalIn
  | ReleaseMilestoneProposalIn
  | ReleaseStageProposalIn
  | ReplanProposalIn
  | DirectCallProposalIn;

export interface PolicyDecision {
  readonly verdict: PolicyVerdict;
  /** A §8.5 contract error name when the denial mirrors an on-chain check, else an UPPER_SNAKE policy code. */
  readonly reasonCode: string;
  /** True when a forced send would revert with `reasonCode` (the refusal and the revert line up, §13.1 #6). */
  readonly mirrorsRevert: boolean;
  readonly constitutionCode?: ConstitutionCode;
  /** The exception the proposal becomes when a human must act. */
  readonly exceptionKind?: ExceptionKind;
}
