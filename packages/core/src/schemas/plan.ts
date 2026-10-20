/**
 * PlanIntent, PlanManifest, PlanDraft, PlanRecord (project.md §4, §26.5, §26.6).
 *
 * Schemas here are STRUCTURAL only. They deliberately do not enforce the §8.3 constitution:
 * a constitution-violating manifest must stay representable so T21 ("founder signs a malicious plan")
 * can be built, sent and reverted on-chain. The constitution lives in core's compiler/policy (task 1.10).
 */
import { z } from "zod";
import {
  AdsPacing,
  ConstitutionCode,
  CountryCode,
  ENTITY_TYPES_BY_COUNTRY,
  EntityType,
  HorizonDays,
  IntentSlot,
  LINE_KEYS,
  LineEmphasis,
  LineKey,
  PlanStatus,
  ProductCategory,
  Residency,
  SellChannel,
  StageGateMetric,
} from "./enums";
import {
  Address,
  Bps,
  CurrencyCode,
  DigitString,
  Hex32,
  Id,
  Iso2,
  Minor,
  PayeeId,
  PlanVersion,
  PosInt,
  SchemaVersion,
  StageId,
  Seconds,
  SourceMeta,
  UnixSeconds,
  partialKeyed,
  stringToBytes32,
} from "./primitives";

/** lineId = stringToHex(lineKey, { size: 32 }) (§26.3). */
export function lineIdOf(lineKey: LineKey): string {
  return stringToBytes32(lineKey);
}

// ---- PlanIntent (the only thing the LLM fills) ---------------------------------------------
// G0-DECISION: intentVersion is the integer literal 1.
export const INTENT_VERSION = 1 as const;

export const PlanIntent = z
  .strictObject({
    intentVersion: z.literal(INTENT_VERSION),
    countryCode: CountryCode,
    residency: Residency,
    entityType: EntityType,
    productCategory: ProductCategory,
    sellChannel: SellChannel,
    buyFrom: Iso2.describe("Sourcing country, ISO2 (e.g. CN)"),
    budgetCeilingMinor: Minor.describe("User-confirmed budget ceiling"),
    horizonDays: HorizonDays,
    // G0-DECISION: lineEmphasis is an object with optional LineKey keys (not a JSON-Schema propertyNames
    // record) so LLM tool schemas stay simple. Missing key = no emphasis.
    lineEmphasis: partialKeyed(LINE_KEYS, LineEmphasis),
    adsPacing: AdsPacing,
    answeredSlots: z.array(IntentSlot),
    // G0-DECISION: assumptions are {slot, text} so E4 can score which slots were assumed vs asked.
    assumptions: z.array(z.strictObject({ slot: IntentSlot, text: z.string().min(1).max(500) })),
  })
  .superRefine((intent, ctx) => {
    if (!ENTITY_TYPES_BY_COUNTRY[intent.countryCode].includes(intent.entityType)) {
      ctx.addIssue({
        code: "custom",
        path: ["entityType"],
        message: `entity type ${intent.entityType} is not valid for ${intent.countryCode}`,
      });
    }
  });
export type PlanIntent = z.infer<typeof PlanIntent>;

// ---- PlanManifest (built by code only) -----------------------------------------------------
export const StageGate = z.strictObject({
  metric: StageGateMetric,
  target: DigitString.describe("Minor units when metric = salesMinor; a count when metric = orders"),
  deadline: UnixSeconds,
});
export type StageGate = z.infer<typeof StageGate>;

// Stage order = array order; index 0 is released at commitPlan (IHogee.sol Stage).
export const PlanStage = z.strictObject({
  // G0-DECISION (chain freeze): stageId is a ShortId, bytes32 on-chain via stringToHex (e.g. "stage-1").
  stageId: StageId,
  releaseMinor: Minor,
  // G0-DECISION: gate is null for the first stage (released at commitPlan; on-chain METRIC_NONE).
  // Always present (never omitted) for stable JCS hashing.
  gate: StageGate.nullable(),
});
export type PlanStage = z.infer<typeof PlanStage>;

export const PlanLine = z
  .strictObject({
    lineKey: LineKey,
    lineId: Hex32.describe("stringToHex(lineKey, {size: 32})"),
    purpose: z.string().min(1).max(200),
    amountMinor: Minor,
    perTxCapMinor: Minor,
    windowCapMinor: Minor,
    // G0-DECISION: windowSeconds is a duration digit string (same format as chain-mirrored unix seconds).
    windowSeconds: Seconds,
    validUntil: UnixSeconds,
    payeeIds: z.array(PayeeId),
    escrowOnly: z.boolean(),
    // Coordinator note 3: on-chain Line.pacingMinor; pacing absent ⇔ pacingMinor 0 (invoice line).
    pacing: z.strictObject({ period: z.literal("day"), amountMinor: Minor }).optional(),
  })
  .superRefine((line, ctx) => {
    if (line.pacing && line.pacing.amountMinor === "0") {
      ctx.addIssue({ code: "custom", path: ["pacing", "amountMinor"], message: "pacing amount must be > 0 (omit pacing for invoice lines)" });
    }
    if (line.lineId !== lineIdOf(line.lineKey)) {
      ctx.addIssue({ code: "custom", path: ["lineId"], message: `lineId must equal stringToHex("${line.lineKey}", {size: 32})` });
    }
  });
export type PlanLine = z.infer<typeof PlanLine>;

// G0-DECISION: sourceRef is a JSON Pointer into the country pack ("/indirectTax/rate"), or
// "constitution:<CODE>" / "compiler:<id>" for rules not taken from the pack. `source` (optional) copies the
// leaf's provenance so the UI can show source + date without fetching the pack.
export const PlanRule = z.strictObject({
  ruleId: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/),
  text: z.string().min(1).max(500),
  sourceRef: z.string().regex(/^(\/.*|constitution:[A-Z0-9_]+|compiler:[a-z0-9_.-]+)$/),
  source: SourceMeta.optional(),
});
export type PlanRule = z.infer<typeof PlanRule>;

export const PlanManifest = z
  .strictObject({
    schemaVersion: SchemaVersion,
    // G0-DECISION: planId is bytes32 (Hex32), random per facility plan series.
    planId: Hex32,
    // G0-DECISION: plan version is a JS integer starting at 1 (G0-REVIEW M10: ≤ uint32).
    version: PlanVersion,
    prevPlanHash: Hex32.describe("ZERO_HEX32 for version 1"),
    facilityId: Id,
    countryCode: CountryCode,
    countryPackVersion: z.string().min(1).max(64),
    countryPackHash: Hex32,
    displayCurrency: CurrencyCode,
    totalMinor: Minor,
    reserveBps: Bps,
    agent: z.strictObject({ address: Address, expiresAt: UnixSeconds }),
    stages: z.array(PlanStage).min(1),
    lines: z.array(PlanLine).min(1),
    rules: z.array(PlanRule),
    aigc: z.strictObject({ model: z.string().min(1).max(100), promptHash: Hex32 }),
    compilerVersion: z.string().min(1).max(64),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.lines.forEach((l, i) => {
      if (seen.has(l.lineKey)) ctx.addIssue({ code: "custom", path: ["lines", i, "lineKey"], message: `duplicate line ${l.lineKey}` });
      seen.add(l.lineKey);
    });
    const stageIds = new Set<string>();
    m.stages.forEach((s, i) => {
      if (stageIds.has(s.stageId)) ctx.addIssue({ code: "custom", path: ["stages", i, "stageId"], message: `duplicate stage ${s.stageId}` });
      stageIds.add(s.stageId);
    });
  });
export type PlanManifest = z.infer<typeof PlanManifest>;

// ---- PlanDraft ---------------------------------------------------------------------------------
export const PlanDiffEntry = z.strictObject({
  path: z.string().describe("JSON Pointer into the manifest"),
  baseline: z.json().describe("Value in the deterministic baseline (null if absent)"),
  proposed: z.json().describe("Value in the proposed manifest (null if absent)"),
});
export type PlanDiffEntry = z.infer<typeof PlanDiffEntry>;

export const ConstitutionCheck = z.strictObject({ code: ConstitutionCode, ok: z.boolean() });
export type ConstitutionCheck = z.infer<typeof ConstitutionCheck>;

export const PlanDraft = z.strictObject({
  draftId: Id,
  intent: PlanIntent,
  manifest: PlanManifest,
  baseline: PlanManifest,
  diff: z.array(PlanDiffEntry),
  blastRadiusMinor: Minor.describe("Max loss if the AI is fully compromised"),
  constitutionReport: z.array(ConstitutionCheck),
});
export type PlanDraft = z.infer<typeof PlanDraft>;

// ---- GET /api/plans/current, /api/plans/versions ----------------------------------------------
export const PlanRecord = z.strictObject({
  manifest: PlanManifest,
  status: PlanStatus,
  planHash: Hex32,
  // G0-DECISION: txHash is null until commitPlan is broadcast (spec lists it without `?`).
  txHash: Hex32.nullable(),
});
export type PlanRecord = z.infer<typeof PlanRecord>;
