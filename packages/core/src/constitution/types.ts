/**
 * Inputs of the constitution mirror (project.md §8.3). These mirror on-chain state the contract reads in
 * commitPlan: the facility (openFacility), the payee registry (bound payees + static platform registry) and
 * the deployment's judging-window end (constructor constant).
 */
import type { LineKey, SellChannel } from "../schemas/enums";
import type { PlanStage } from "../schemas/plan";
import type { Address, Hex32, Minor, PayeeId, Seconds, UnixSeconds } from "../schemas/primitives";

export interface ScheduledMilestone {
  readonly amountMinor: Minor;
  readonly autoRelease: boolean;
}

/**
 * One payee the registry knows. A plan may only name payees that are already here (§8.3, code 9).
 * Binding is per line: a payee bound to LOGISTICS is not payable from ADS (ADD_PAYEE binds one line per request).
 */
export interface RegistryPayee {
  readonly payeeId: PayeeId;
  /** `platform` = static platform registry (e.g. a marketplace's ads account); `bound` = bound via SupplierApproval or ADD_PAYEE. */
  readonly source: "platform" | "bound";
  /** Lines this payee may be paid from. */
  readonly lineKeys: readonly LineKey[];
  /** Platform payees: the sell channels they belong to (absent = any). Used by the compiler only. */
  readonly channels?: readonly SellChannel[];
  /** Bound supplier payees: the signed milestone schedule (SupplierApproval.scheduleHash preimage). */
  readonly schedule?: readonly ScheduledMilestone[];
  /** On-chain PayeeBinding.lifetimeCapMinor. Absent = schedule total for scheduled payees, uncapped otherwise. */
  readonly lifetimeCapMinor?: Minor;
  /** Bound payees: unix seconds when the cooling (veto) period ends. */
  readonly coolingUntil?: UnixSeconds;
}

export interface ConstitutionFacility {
  /** Treasury.openFacility capMinor. */
  readonly capMinor: Minor;
  /** Treasury.openFacility reserveFloorBps (the LENDER sets it from the country pack). */
  readonly reserveFloorBps: number;
  /** Deployment constant: agentExpiry must be strictly later than this (§8.3, code 3). */
  readonly judgingWindowEnd: UnixSeconds;
  /** Bound payees plus the static platform registry. */
  readonly payees: readonly RegistryPayee[];
  /**
   * Role keys the agent must differ from (code 13, role separation; PlanConstitution reads them from Treasury): the
   * founder's registered ownerEOA (zero for a passkey-only owner), the lender and the settlement oracle. Required, so
   * the check cannot pass by omission: pass ZERO_ADDRESS explicitly when one is unknown (a valid agent never equals
   * it). A missing or unreadable value fails closed (MALFORMED_PLAN).
   */
  readonly ownerEOA: Address;
  readonly lender: Address;
  readonly oracle: Address;
  /**
   * Treasury.observer(), the optional cancelLoosen veto (audit run-3: the agent must differ from it too). Absent or
   * ZERO_ADDRESS = no observer, as on-chain; a present value that is not an address fails closed (MALFORMED_PLAN).
   */
  readonly observer?: Address;
}

/**
 * One line of the current on-chain plan (PlanRegistry.line(lineId) after every tighten / executed loosen), as a
 * re-commit is compared against it (G0-AUDIT v-1, code 14).
 */
export interface CommittedLine {
  readonly lineKey: LineKey;
  /** Current allocation (after MOVE_POCKETS). */
  readonly amountMinor: Minor;
  readonly perTxCapMinor: Minor;
  readonly windowCapMinor: Minor;
  readonly windowSeconds: Seconds;
  readonly validUntil: UnixSeconds;
  /** Line.pacingMinor: "0" = invoice line. */
  readonly pacingMinor: Minor;
  readonly escrowOnly: boolean;
  /** The line's current payees: its payeeIds plus payees bound to it since (bindPayee, ADD_PAYEE). */
  readonly payeeIds: readonly PayeeId[];
}

/** The stored plan a re-commit must tighten (PlanRegistry.currentPlan / lineIds / line / stage views). */
export interface CommittedPlan {
  readonly planId: Hex32;
  /** PlanRegistry.planVersion(): 0 = no plan yet. */
  readonly version: number;
  /** Stored planHash (PlanApproval.prevPlanHash must equal it). */
  readonly planHash: Hex32;
  readonly countryPackHash: Hex32;
  readonly totalMinor: Minor;
  /** Current value (TIGHTEN_RAISE_RESERVE_BPS may have raised it). */
  readonly reserveBps: number;
  /** Agent and its current expiry (LOOSEN_EXTEND_AGENT_EXPIRY may have extended it). */
  readonly agent: { readonly address: Address; readonly expiresAt: UnixSeconds };
  readonly stages: readonly PlanStage[];
  /** Stored line order. */
  readonly lines: readonly CommittedLine[];
}
