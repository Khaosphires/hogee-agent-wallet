/** Plan examples built from the Rina numbers (§26.2). */
import { RINA_COMMIT_AT_ISO, RINA_FACILITY, RINA_IDS, RINA_LINES, RINA_PLAN, RINA_STAGES } from "../../demo/rina";
import { CONSTITUTION_CODES } from "../enums";
import type { PlanDraft, PlanIntent, PlanLine, PlanManifest, PlanRecord } from "../plan";
import { lineIdOf } from "../plan";
import { SCHEMA_VERSION, ZERO_HEX32 } from "../primitives";
import { fakeAddress, fakeHex32 } from "./fake";

export const examplePlanIntent: PlanIntent = {
  intentVersion: 1,
  countryCode: "MY",
  residency: "citizen",
  entityType: "sole_prop",
  productCategory: "drinkware_food_contact",
  sellChannel: "shopee",
  buyFrom: "CN",
  budgetCeilingMinor: "1000000",
  horizonDays: 60,
  lineEmphasis: { SUPPLIER: "high", ADS: "med", CONTINGENCY: "low" },
  adsPacing: "standard",
  answeredSlots: ["residency", "productCategory", "budgetCeilingMinor", "buyFrom"],
  assumptions: [{ slot: "entityType", text: "Sole proprietorship (SSM ezBiz): citizen selling under a business name" }],
};

const lines: PlanLine[] = RINA_LINES.map((l) => ({
  lineKey: l.lineKey,
  lineId: lineIdOf(l.lineKey),
  purpose: l.purpose,
  amountMinor: l.amountMinor,
  perTxCapMinor: l.perTxCapMinor,
  windowCapMinor: l.windowCapMinor,
  windowSeconds: RINA_PLAN.windowSeconds,
  validUntil: RINA_PLAN.validUntil,
  payeeIds: [...l.payeeIds],
  escrowOnly: l.escrowOnly,
  ...(l.pacingPerDayMinor ? { pacing: { period: "day" as const, amountMinor: l.pacingPerDayMinor } } : {}),
}));

const packSource = {
  sourceUrl: "https://example.invalid/my/e-invoicing",
  retrievedAt: RINA_COMMIT_AT_ISO,
  snippetHash: fakeHex32("snippet:my:einvoicing"),
  evidence: "tier3" as const,
  sourceType: "mock" as const,
};

export const examplePlanManifest: PlanManifest = {
  schemaVersion: SCHEMA_VERSION,
  planId: fakeHex32("planId:rina"),
  version: 1,
  prevPlanHash: ZERO_HEX32,
  facilityId: RINA_IDS.facilityId,
  countryCode: RINA_FACILITY.countryCode,
  countryPackVersion: "2026.10.16-example",
  countryPackHash: fakeHex32("countryPackHash:MY"),
  displayCurrency: RINA_FACILITY.currency,
  totalMinor: RINA_FACILITY.capMinor,
  reserveBps: RINA_PLAN.reserveBps,
  agent: { address: fakeAddress("agent:final-1"), expiresAt: RINA_PLAN.agentExpiresAt },
  stages: RINA_STAGES.map((s) => ({ stageId: s.stageId, releaseMinor: s.releaseMinor, gate: s.gate ? { ...s.gate } : null })),
  lines,
  rules: [
    {
      ruleId: "my.einvoicing.threshold",
      text: "MyInvois e-invoicing is not required below RM3M turnover (example rule, mock source).",
      sourceRef: "/eInvoicing/threshold",
      source: packSource,
    },
    {
      ruleId: "constitution.reserve-floor",
      text: "Sales reserve is 5%, at or above the facility floor of 3%.",
      sourceRef: "constitution:RESERVE_BELOW_FLOOR",
    },
  ],
  aigc: { model: "claude-sonnet-5-5", promptHash: fakeHex32("promptHash:rina:v1") },
  compilerVersion: "0.1.0",
};

/** Deterministic baseline: identical except a smaller ads line and a larger contingency line. */
export const examplePlanBaseline: PlanManifest = {
  ...examplePlanManifest,
  lines: lines.map((l) => {
    if (l.lineKey === "ADS") return { ...l, amountMinor: "100000", perTxCapMinor: "25000", windowCapMinor: "50000" };
    if (l.lineKey === "CONTINGENCY") return { ...l, amountMinor: "120000", perTxCapMinor: "30000", windowCapMinor: "60000" };
    return l;
  }),
  aigc: { model: "baseline-rules", promptHash: fakeHex32("promptHash:baseline") },
};

export const examplePlanDraft: PlanDraft = {
  draftId: "draft-rina-001",
  intent: examplePlanIntent,
  manifest: examplePlanManifest,
  baseline: examplePlanBaseline,
  diff: [
    { path: "/lines/3/amountMinor", baseline: "100000", proposed: "120000" },
    { path: "/lines/5/amountMinor", baseline: "120000", proposed: "100000" },
  ],
  // Example: one rolling window of every payee-bound, non-escrow line (40,000 + 60,000 + 25,000).
  blastRadiusMinor: "125000",
  constitutionReport: [
    ...CONSTITUTION_CODES.map((code) => ({ code, ok: true })),
  ],
};

export const examplePlanRecord: PlanRecord = {
  manifest: examplePlanManifest,
  status: "COMMITTED",
  planHash: fakeHex32("planHash:rina:v1"),
  txHash: fakeHex32("tx:commitPlan:v1"),
};
