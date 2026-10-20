/**
 * Rina demo numbers (project.md §26.2). All amounts are minor units: 1 BU = 100 minor, 10,000 BU = "1000000".
 * P3 builds fixtures from these; core/test/rina.test.ts asserts they satisfy the §8.3 constitution.
 */
import type { CountryCode, LineKey } from "../schemas/enums";
import type { CurrencyCode, DeploymentId, Minor, OrderId, PayeeId, ShortId, StageId, SupplierId, UnixSeconds, UuidV7 } from "../schemas/primitives";

export const SECONDS_PER_DAY = 86_400;

// G0-DECISION: fixed demo clock so fixtures are reproducible: plan v1 is committed 2026-10-16T00:00:00Z.
export const RINA_COMMIT_AT_ISO = "2026-10-16T00:00:00Z";
export const RINA_COMMIT_AT: UnixSeconds = String(Date.parse(RINA_COMMIT_AT_ISO) / 1000);
// G0-DECISION: assumed end of the judging window (spec gives none); agent expiry must be later than this.
export const JUDGING_WINDOW_END_ISO = "2026-11-30T23:59:59Z";

const at = (days: number): UnixSeconds => String(Number(RINA_COMMIT_AT) + days * SECONDS_PER_DAY);

// G0-REVIEW (M15): canonical demo ids, all ShortId format (bytes32 on-chain via stringToHex). The contracts
// session aligns its fixtures to these; P3 fixtures and P2's mock must reuse them.
export const RINA_IDS = {
  facilityId: "fac-rina" as ShortId,
  founderId: "founder-rina" as ShortId,
  deploymentId: "final-1" as DeploymentId,
  chainId: 11_155_111,
  supplierAId: "supplier-a" as SupplierId,
  supplierAPayeeId: "supplier-a" as PayeeId,
  supplierAOrderId: "order-a-001" as OrderId,
  adsPayeeId: "shopee-ads" as PayeeId,
  logisticsPayeeId: "spx-logistics" as PayeeId,
  platformFeesPayeeId: "shopee-fees" as PayeeId,
  // Packaging printer: NOT a platform payee; bound later via an ADD_PAYEE exception (plan v1 has none).
  packagingPayeeId: "printer-kl" as PayeeId,
  // Tax authority payee for WITHDRAW_RESERVE.
  taxPayeeId: "lhdn-tax" as PayeeId,
  stage1Id: "stage-1" as StageId,
  stage2Id: "stage-2" as StageId,
} as const;

/** Chat session served by fixtures/scenario-rina/chat.json (GET /api/chat/:sessionId). UUIDv7, not a ShortId. */
export const RINA_SESSION_ID: UuidV7 = "01a14202-2800-7000-8000-0000000000aa";

export interface RinaFacility {
  readonly capMinor: Minor;
  readonly currency: CurrencyCode;
  readonly countryCode: CountryCode;
  readonly reserveFloorBps: number;
}

export const RINA_FACILITY: RinaFacility = {
  capMinor: "1000000",
  currency: "MYR",
  countryCode: "MY",
  // Demo assumption, labelled: MY income-tax set-aside [VERIFY].
  reserveFloorBps: 300,
};

export const RINA_PLAN = {
  reserveBps: 500,
  agentExpiryDays: 60,
  agentExpiresAt: at(60),
  windowSeconds: "604800",
  horizonDays: 60,
  // G0-DECISION: lines are valid for the 60-day horizon (constitution: ≤ now + 90 days).
  validUntil: at(60),
} as const;

/** Static platform payees (§8.3: plans may only use registry or static platform payees). */
export const RINA_PLATFORM_PAYEES = {
  ADS: RINA_IDS.adsPayeeId,
  PLATFORM_FEES: RINA_IDS.platformFeesPayeeId,
  LOGISTICS: RINA_IDS.logisticsPayeeId,
} as const;

export interface RinaLine {
  readonly lineKey: LineKey;
  readonly purpose: string;
  readonly amountMinor: Minor;
  readonly perTxCapMinor: Minor;
  readonly windowCapMinor: Minor;
  readonly escrowOnly: boolean;
  readonly pacingPerDayMinor?: Minor;
  /** Payees at plan v1. The supplier is bound later via SupplierApproval (bindPayee), not by the plan. */
  readonly payeeIds: readonly PayeeId[];
}

export const RINA_LINES: readonly RinaLine[] = [
  {
    lineKey: "SUPPLIER",
    purpose: "Insulated tumblers from the chosen supplier (escrow milestones only)",
    amountMinor: "500000",
    perTxCapMinor: "125000",
    windowCapMinor: "250000",
    escrowOnly: true,
    payeeIds: [],
  },
  {
    lineKey: "PACKAGING",
    purpose: "Custom printed packaging",
    amountMinor: "150000",
    perTxCapMinor: "37500",
    windowCapMinor: "75000",
    escrowOnly: false,
    payeeIds: [],
  },
  {
    lineKey: "LOGISTICS",
    purpose: "Inbound freight and last-mile delivery",
    amountMinor: "80000",
    perTxCapMinor: "20000",
    windowCapMinor: "40000",
    escrowOnly: false,
    payeeIds: [RINA_PLATFORM_PAYEES.LOGISTICS],
  },
  {
    lineKey: "ADS",
    purpose: "Marketplace ads, paced daily",
    amountMinor: "120000",
    perTxCapMinor: "30000",
    windowCapMinor: "60000",
    escrowOnly: false,
    pacingPerDayMinor: "7500",
    payeeIds: [RINA_PLATFORM_PAYEES.ADS],
  },
  {
    lineKey: "PLATFORM_FEES",
    purpose: "Marketplace platform and transaction fees",
    amountMinor: "50000",
    perTxCapMinor: "12500",
    windowCapMinor: "25000",
    escrowOnly: false,
    payeeIds: [RINA_PLATFORM_PAYEES.PLATFORM_FEES],
  },
  {
    lineKey: "CONTINGENCY",
    purpose: "Unplanned costs (owner-approved payees only)",
    amountMinor: "100000",
    perTxCapMinor: "25000",
    windowCapMinor: "50000",
    escrowOnly: false,
    payeeIds: [],
  },
];

export interface RinaStage {
  /** ShortId; bytes32 on-chain via stringToHex. Array index 0 is released at commitPlan. */
  readonly stageId: string;
  readonly releaseMinor: Minor;
  readonly gate: { readonly metric: "salesMinor"; readonly target: Minor; readonly deadline: UnixSeconds } | null;
}

export const RINA_STAGES: readonly RinaStage[] = [
  { stageId: RINA_IDS.stage1Id, releaseMinor: "400000", gate: null },
  { stageId: RINA_IDS.stage2Id, releaseMinor: "600000", gate: { metric: "salesMinor", target: "200000", deadline: at(30) } },
];

export interface RinaMilestone {
  /** 0-based milestone index. */
  readonly idx: number;
  readonly label: "sample" | "deposit" | "balance";
  readonly amountMinor: Minor;
  readonly autoRelease: boolean;
}

/** Supplier A schedule, 430,000 total. The balance needs Rina's MilestoneRelease + inspection evidence AND stage 2. */
export const RINA_SUPPLIER_A_SCHEDULE: readonly RinaMilestone[] = [
  { idx: 0, label: "sample", amountMinor: "30000", autoRelease: true },
  { idx: 1, label: "deposit", amountMinor: "120000", autoRelease: true },
  { idx: 2, label: "balance", amountMinor: "280000", autoRelease: false },
];

export const RINA_SUPPLIER_A_SCHEDULE_TOTAL: Minor = "430000";
