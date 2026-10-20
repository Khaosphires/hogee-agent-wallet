/**
 * Mei demo numbers (SG-DECISIONS: Singapore is the main demo country). Mei Tan is a Singapore citizen with a sole
 * proprietorship who sells insulated tumblers (drinkware, food contact) on Shopee Singapore and buys from China.
 *
 * Mei mirrors Rina (demo/rina.ts, §26.2) exactly in minor units, in SGD: budget 1,000,000 (SGD 10,000.00), the same
 * lines, caps, pacing, stages, reserve, expiries and supplier schedule. Only the ids, the currency, the country and the
 * payout rail (SG_PAYNOW in the API payee catalog) differ. Every id carries an `sg`/`mei` marker so nothing collides
 * with Rina's on the shared final-1 deployment, except the supplier: the demo supplier catalog is shared and stored per
 * facility, so Mei's supplier A is the catalog's "supplier-a". Her facility context and compile input are in
 * ./mei-context.ts.
 */
import type { PlanIntent } from "../schemas/plan";
import type { DeploymentId, Minor, OrderId, PayeeId, ShortId, StageId, SupplierId, UnixSeconds, UuidV7 } from "../schemas/primitives";
import { RINA_COMMIT_AT, RINA_COMMIT_AT_ISO, SECONDS_PER_DAY, type RinaFacility, type RinaLine, type RinaMilestone, type RinaStage } from "./rina";

/** Same demo clock as Rina: plan v1 is committed 2026-10-16T00:00:00Z. */
export const MEI_COMMIT_AT_ISO = RINA_COMMIT_AT_ISO;
export const MEI_COMMIT_AT: UnixSeconds = RINA_COMMIT_AT;

const at = (days: number): UnixSeconds => String(Number(MEI_COMMIT_AT) + days * SECONDS_PER_DAY);

/** SG-DECISIONS "Mei's ids and caps": ShortId format, bytes32 on-chain via stringToHex. Stage ids are per plan. */
export const MEI_IDS = {
  facilityId: "fac-mei" as ShortId,
  founderId: "founder-mei" as ShortId,
  deploymentId: "final-1" as DeploymentId,
  chainId: 11_155_111,
  // P1 (22:55): the demo supplier catalog (data/suppliers/demo) is shared by both founders and stored per facility, so
  // Mei's supplier is the same catalog id as Rina's; her order id still carries the sg marker.
  supplierAId: "supplier-a" as SupplierId,
  supplierAPayeeId: "supplier-a" as PayeeId,
  supplierAOrderId: "order-a-001" as OrderId, // the live API names orders per facility: order-<x>-NNN
  adsPayeeId: "shopee-sg-ads" as PayeeId,
  logisticsPayeeId: "spx-sg-logistics" as PayeeId,
  platformFeesPayeeId: "shopee-sg-fees" as PayeeId,
  // Packaging printer: NOT a platform payee; bound later via an ADD_PAYEE exception (plan v1 has none).
  packagingPayeeId: "sg-packaging-printer" as PayeeId,
  // Tax authority payee for WITHDRAW_RESERVE (mirrors Rina's lhdn-tax).
  taxPayeeId: "iras-tax" as PayeeId,
  stage1Id: "stage-1" as StageId,
  stage2Id: "stage-2" as StageId,
} as const;

/** Mei's chat session (UUIDv7, not a ShortId); distinct from RINA_SESSION_ID. */
export const MEI_SESSION_ID: UuidV7 = "01a14202-2800-7000-8000-0000000005ea";

export const MEI_FACILITY: RinaFacility = {
  capMinor: "1000000",
  currency: "SGD",
  countryCode: "SG",
  // Demo assumption, labelled: the same set-aside floor as Rina's [VERIFY with the SG pack].
  reserveFloorBps: 300,
};

export const MEI_PLAN = {
  reserveBps: 500,
  agentExpiryDays: 60,
  agentExpiresAt: at(60),
  windowSeconds: "604800",
  horizonDays: 60,
  validUntil: at(60),
} as const;

/** Static platform payees for a Shopee Singapore seller (§8.3: registry or static platform payees only). */
export const MEI_PLATFORM_PAYEES = {
  ADS: MEI_IDS.adsPayeeId,
  PLATFORM_FEES: MEI_IDS.platformFeesPayeeId,
  LOGISTICS: MEI_IDS.logisticsPayeeId,
} as const;

export type MeiLine = RinaLine;
export type MeiStage = RinaStage;
export type MeiMilestone = RinaMilestone;

export const MEI_LINES: readonly MeiLine[] = [
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
    payeeIds: [MEI_PLATFORM_PAYEES.LOGISTICS],
  },
  {
    lineKey: "ADS",
    purpose: "Marketplace ads, paced daily",
    amountMinor: "120000",
    perTxCapMinor: "30000",
    windowCapMinor: "60000",
    escrowOnly: false,
    pacingPerDayMinor: "7500",
    payeeIds: [MEI_PLATFORM_PAYEES.ADS],
  },
  {
    lineKey: "PLATFORM_FEES",
    purpose: "Marketplace platform and transaction fees",
    amountMinor: "50000",
    perTxCapMinor: "12500",
    windowCapMinor: "25000",
    escrowOnly: false,
    payeeIds: [MEI_PLATFORM_PAYEES.PLATFORM_FEES],
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

export const MEI_STAGES: readonly MeiStage[] = [
  { stageId: MEI_IDS.stage1Id, releaseMinor: "400000", gate: null },
  { stageId: MEI_IDS.stage2Id, releaseMinor: "600000", gate: { metric: "salesMinor", target: "200000", deadline: at(30) } },
];

/** Supplier A (SG) schedule, 430,000 total. The balance needs Mei's MilestoneRelease + inspection evidence AND stage 2. */
export const MEI_SUPPLIER_A_SCHEDULE: readonly MeiMilestone[] = [
  { idx: 0, label: "sample", amountMinor: "30000", autoRelease: true },
  { idx: 1, label: "deposit", amountMinor: "120000", autoRelease: true },
  { idx: 2, label: "balance", amountMinor: "280000", autoRelease: false },
];

export const MEI_SUPPLIER_A_SCHEDULE_TOTAL: Minor = "430000";

/** Mei's PlanIntent (the planner's bounded choices): Rina's choices, in Singapore. */
export const MEI_PLAN_INTENT: PlanIntent = {
  intentVersion: 1,
  countryCode: "SG",
  residency: "citizen",
  entityType: "sg_sole_prop",
  productCategory: "drinkware_food_contact",
  sellChannel: "shopee",
  buyFrom: "CN",
  budgetCeilingMinor: MEI_FACILITY.capMinor,
  horizonDays: 60,
  lineEmphasis: { SUPPLIER: "high", ADS: "med", CONTINGENCY: "low" },
  adsPacing: "standard",
  answeredSlots: ["residency", "productCategory", "budgetCeilingMinor", "buyFrom"],
  assumptions: [{ slot: "entityType", text: "Sole proprietorship (ACRA BizFile+): citizen selling under a business name" }],
};
