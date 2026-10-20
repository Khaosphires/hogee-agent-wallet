/**
 * Which schema governs which repo data file (project.md §26.8). Single source of truth for
 * scripts/gen-json-schemas.ts (→ data/schemas/*.schema.json) and scripts/validate-data.ts.
 */
import { z } from "zod";
import { AutonomyStats, Balances } from "./balances";
import { ChatMessage } from "./chat";
import { CountryPack } from "./country-pack";
import {
  E1AttackRow,
  E1CleanRow,
  E2LabelRow,
  E2PromptRow,
  E5DocRow,
  HashVectors,
  PiiCanaryFile,
  PiiRecognizersFile,
  SanctionsRow,
  SupplierEvalLabel,
} from "./datasets";
import { EscrowSchedule } from "./escrow";
import { BundleManifest, EvidenceRow, EvidenceRows } from "./evidence";
import { Exception } from "./exception";
import { Payment } from "./payment";
import { PlanDraft, PlanRecord } from "./plan";
import { OrderId } from "./primitives";
import { Facility, Session } from "./session";
import { RecordedListingReading, RecordedTavilySearch } from "./search";
import { Shortlist, Supplier, SupplierFile, SupplierWithEvidence } from "./supplier";
import { TraceEvent } from "./trace";

/**
 * fixtures/scenario-rina/<file> → schema. Each maps to an API response schema so api-mock can serve
 * fixtures directly (G0-DECISION):
 * - facility.json: Facility (seed only; no route returns it)
 * - session.json: GET /api/session; chat.json: GET /api/chat/:sessionId
 * - plan-draft.json: POST /api/plans/draft; plan-current.json: GET /api/plans/current
 * - shortlist.json: GET /api/suppliers/shortlist/:id; suppliers.json: array of GET /api/suppliers/:id
 * - balances.json, payments.json, traces.json, exceptions.json, autonomy.json: the matching GET routes
 * - escrow.json: { [orderId]: GET /api/escrow/:orderId response }
 */
export const SCENARIO_RINA_FILE_SCHEMAS = {
  "facility.json": Facility,
  "session.json": Session,
  "chat.json": z.array(ChatMessage),
  "plan-draft.json": PlanDraft,
  "plan-current.json": PlanRecord,
  "shortlist.json": Shortlist,
  "suppliers.json": z.array(SupplierWithEvidence),
  "balances.json": Balances,
  "payments.json": z.array(Payment),
  "traces.json": z.array(TraceEvent),
  "exceptions.json": z.array(Exception),
  "autonomy.json": AutonomyStats,
  "escrow.json": z.record(OrderId, EscrowSchedule),
} as const satisfies Record<string, z.ZodType>;
export type ScenarioRinaFile = keyof typeof SCENARIO_RINA_FILE_SCHEMAS;

export interface DataFileSchema {
  /** Output file name stem: data/schemas/<name>.schema.json */
  readonly name: string;
  readonly title: string;
  /** Which files it governs (documentation). */
  readonly appliesTo: string;
  readonly schema: z.ZodType;
}

const scenarioEntries: DataFileSchema[] = Object.entries(SCENARIO_RINA_FILE_SCHEMAS).map(([file, schema]) => ({
  name: `scenario-rina-${file.replace(/\.json$/, "")}`,
  title: `fixtures/scenario-rina/${file}`,
  appliesTo: `fixtures/scenario-rina/${file}`,
  schema,
}));

/** Every schema P3 produces data for. */
export const DATA_FILE_SCHEMAS: readonly DataFileSchema[] = [
  { name: "country-pack", title: "CountryPack", appliesTo: "data/country-packs/<CC>.json", schema: CountryPack },
  {
    name: "supplier",
    title: "Supplier",
    appliesTo: "data/suppliers/eval/set-XX/listings/*.json, and the supplier of each data/suppliers/demo/*.json",
    schema: Supplier,
  },
  { name: "supplier-file", title: "SupplierFile", appliesTo: "data/suppliers/demo/*.json ({supplier, evidence[]} or a plain Supplier)", schema: SupplierFile },
  { name: "supplier-eval-label", title: "SupplierEvalLabel", appliesTo: "each line of data/suppliers/eval/labels.jsonl", schema: SupplierEvalLabel },
  { name: "e1-attack-row", title: "E1AttackRow", appliesTo: "each line of evals/datasets/e1/attacks.jsonl", schema: E1AttackRow },
  { name: "e1-clean-row", title: "E1CleanRow", appliesTo: "each line of evals/datasets/e1/clean.jsonl", schema: E1CleanRow },
  { name: "e2-prompt-row", title: "E2PromptRow", appliesTo: "each line of evals/datasets/e2/prompts.jsonl", schema: E2PromptRow },
  { name: "e2-label-row", title: "E2LabelRow", appliesTo: "each line of evals/datasets/e2/labels.jsonl", schema: E2LabelRow },
  { name: "e5-doc-row", title: "E5DocRow", appliesTo: "each line of evals/datasets/e5/docs.jsonl", schema: E5DocRow },
  { name: "hash-vectors", title: "HashVectors", appliesTo: "data/golden/hash-vectors.json", schema: HashVectors },
  { name: "evidence-row", title: "EvidenceRow", appliesTo: "each element of evidence/<run-id>/evidence.json", schema: EvidenceRow },
  { name: "evidence", title: "EvidenceRow[]", appliesTo: "evidence/<run-id>/evidence.json, fixtures/evidence-sample/evidence.json", schema: EvidenceRows },
  { name: "bundle-manifest", title: "BundleManifest", appliesTo: "evidence/<run-id>/manifest.json", schema: BundleManifest },
  { name: "sanctions-row", title: "SanctionsRow", appliesTo: "each row of data/sanctions/un_sc.csv (header name,aliases,listId,listedOn)", schema: SanctionsRow },
  { name: "pii-recognizers", title: "PiiRecognizersFile", appliesTo: "data/pii/recognizers.json", schema: PiiRecognizersFile },
  { name: "pii-canary-patterns", title: "PiiCanaryFile", appliesTo: "data/pii/canary-patterns.json", schema: PiiCanaryFile },
  // VISION-DECISIONS §8 (recorded web search mode).
  { name: "recorded-tavily-search", title: "RecordedTavilySearch", appliesTo: "data/suppliers/search/recorded/<category>-<buyFrom>.json", schema: RecordedTavilySearch },
  { name: "recorded-listing-reading", title: "RecordedListingReading", appliesTo: "data/suppliers/search/reader/<supplierId>.json", schema: RecordedListingReading },
  ...scenarioEntries,
];
