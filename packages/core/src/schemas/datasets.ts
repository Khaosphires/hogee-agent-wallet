/**
 * Dataset rows produced by P3 (project.md §15, §26.8): E1, E2, E5, supplier eval labels,
 * golden hash vectors, sanctions CSV rows, and the PII recognizer and canary files.
 */
import { z } from "zod";
import {
  AttackerGoalKind,
  CountryCode,
  DutyRoute,
  E1Category,
  E1Vector,
  EntityType,
  EvidenceTaskId,
  IntentSlot,
  Lang,
  LineKey,
  PiiEntity,
  ProductApproval,
  Registration,
  SupplierDefect,
} from "./enums";
import { Bps, Hex32, Id, IsoDate, Minor, NonNegInt, PayeeId, PosInt, SupplierId } from "./primitives";

// G0-DECISION: all character offsets in datasets are Unicode CODE POINT indices (Python str semantics,
// what Presidio returns), `end` exclusive. In JS use [...text].length / Array.from(text).
export const CodePointSpan = z
  .strictObject({ start: NonNegInt, end: PosInt })
  .refine((s) => s.start < s.end, { message: "start must be < end", path: ["end"] });
export type CodePointSpan = z.infer<typeof CodePointSpan>;

// ---- E1 (attack eval) ------------------------------------------------------------------------
export const E1AttackRow = z.strictObject({
  caseId: Id,
  category: E1Category,
  vector: E1Vector,
  lang: Lang,
  payload: z.string().min(1).max(20_000),
  attackerGoal: z.strictObject({
    kind: AttackerGoalKind,
    target: z.string().min(1).max(200).describe("Attacker payee address, canary string, amount, ..."),
  }),
  expected: z.literal("blocked"),
  taskRef: EvidenceTaskId.optional(),
});
export type E1AttackRow = z.infer<typeof E1AttackRow>;

// G0-DECISION: a clean row names the bound payee, line and amount it should pay, so the runner can check
// the payment that happened (false-block rate) without trusting the Reader.
export const E1CleanRow = z.strictObject({
  caseId: Id,
  vector: z.literal("invoice"),
  lang: Lang,
  payload: z.string().min(1).max(20_000),
  payeeId: PayeeId,
  lineKey: LineKey,
  amountMinor: Minor,
  expected: z.literal("paid"),
});
export type E1CleanRow = z.infer<typeof E1CleanRow>;

/** Either E1 row; discriminated by `expected`. Body field `case` of POST /api/eval/case. */
export const E1Case = z.discriminatedUnion("expected", [E1AttackRow, E1CleanRow]);
export type E1Case = z.infer<typeof E1Case>;

// ---- E2 (plan quality) -----------------------------------------------------------------------
export const E2PromptRow = z
  .strictObject({
    promptId: Id,
    country: CountryCode,
    lang: Lang,
    vague: z.boolean(),
    hiddenSlot: IntentSlot.optional(),
    text: z.string().min(1).max(4000),
  })
  .refine((r) => !r.vague || r.hiddenSlot !== undefined, { message: "vague prompts need a hiddenSlot", path: ["hiddenSlot"] });
export type E2PromptRow = z.infer<typeof E2PromptRow>;

export const E2LabelRow = z.strictObject({
  promptId: Id,
  fields: z.strictObject({
    entityType: EntityType,
    registrations: z.array(Registration),
    indirectTaxRegistered: z.boolean(),
    eInvoicing: z.boolean(),
    dutyRoute: DutyRoute,
    productApproval: ProductApproval,
    reserveBps: Bps,
    licenceCostMinor: Minor,
  }),
});
export type E2LabelRow = z.infer<typeof E2LabelRow>;

// ---- E5 (privacy) ----------------------------------------------------------------------------
export const E5DocRow = z
  .strictObject({
    docId: Id,
    text: z.string().min(1).max(20_000),
    spans: z.array(z.strictObject({ start: NonNegInt, end: PosInt, entity: PiiEntity })),
  })
  .superRefine((doc, ctx) => {
    const length = Array.from(doc.text).length;
    doc.spans.forEach((s, i) => {
      if (s.start >= s.end || s.end > length) {
        ctx.addIssue({ code: "custom", path: ["spans", i], message: `span [${s.start}, ${s.end}) outside text (code-point length ${length})` });
      }
    });
  });
export type E5DocRow = z.infer<typeof E5DocRow>;

// ---- Supplier eval labels (data/suppliers/eval/labels.jsonl) --------------------------------
export const SupplierEvalLabel = z
  .strictObject({
    setId: z.string().regex(/^set-[0-9]{2}$/, "must be set-XX"),
    supplierId: SupplierId,
    // G0-DECISION: span = code-point offsets into the listing's raw text file.
    defects: z.array(z.strictObject({ type: SupplierDefect, span: CodePointSpan.optional() })),
    expectedExcluded: z.boolean(),
    // G0-DECISION: humanRank holds one rank per blinded human labeller (empty until labelled).
    humanRank: z.array(PosInt),
  })
  // G0-DECISION: label consistency — excluded iff at least one hard-gate defect (any defect except FAKE_REPORT).
  .refine((l) => l.expectedExcluded === l.defects.some((d) => d.type !== "FAKE_REPORT"), {
    message: "expectedExcluded must be true iff a hard-gate defect (not FAKE_REPORT) is present",
    path: ["expectedExcluded"],
  });
export type SupplierEvalLabel = z.infer<typeof SupplierEvalLabel>;

// ---- Golden hash vectors (data/golden/hash-vectors.json) ------------------------------------
export const HashVector = z.strictObject({
  name: z.string().min(1).max(100),
  input: z.json(),
  jcs: z.string().describe("RFC 8785 canonical JSON of input"),
  keccak256: Hex32.describe("keccak256(utf8(jcs))"),
});
export type HashVector = z.infer<typeof HashVector>;

export const HashVectors = z
  .array(HashVector)
  .min(1)
  .refine((v) => new Set(v.map((x) => x.name)).size === v.length, "vector names must be unique");
export type HashVectors = z.infer<typeof HashVectors>;

// ---- Sanctions CSV (data/sanctions/un_sc.csv: name,aliases,listId,listedOn) -----------------
// G0-DECISION: aliases are ';'-separated in one cell (may be empty); listedOn is YYYY-MM-DD or empty.
export const SANCTIONS_CSV_COLUMNS = ["name", "aliases", "listId", "listedOn"] as const;
export const SanctionsRow = z.strictObject({
  name: z.string().min(1).max(300),
  aliases: z.string().max(4000),
  listId: z.string().min(1).max(64),
  listedOn: z.union([IsoDate, z.literal("")]),
});
export type SanctionsRow = z.infer<typeof SanctionsRow>;

// ---- PII recognizers and canary (data/pii/*.json) --------------------------------------------
// w2-core (docs/decisions/privacy.md §4): moved here from packages/privacy/src/config.ts so validate:data and
// gen:schemas cover the two files; the shapes are unchanged (Presidio ad-hoc recognizer format plus hogee_* keys).
// Added here: every regex must compile as a JavaScript RegExp, and names are unique. packages/privacy still applies its
// linear-time (ReDoS) check when it compiles them, and its validators must be exactly PII_VALIDATOR_NAMES.
/** packages/privacy/src/validators.ts VALIDATORS keys: a TypeScript re-check named by hogee_validator / validator. */
export const PII_VALIDATOR_NAMES = ["MY_NRIC", "MY_NRIC_PLAIN", "ID_NIK", "ID_NPWP", "SG_NRIC", "CREDIT_CARD", "MY_BANK_ACCOUNT", "ID_MOBILE", "EMAIL"] as const;
export const PiiValidatorName = z.enum(PII_VALIDATOR_NAMES);
export type PiiValidatorName = z.infer<typeof PiiValidatorName>;

const compilesAsRegExp = (source: string): boolean => {
  try {
    new RegExp(source, "g");
    return true;
  } catch {
    return false;
  }
};

const PiiComment = z.union([z.string(), z.array(z.string())]).optional();
const PiiName = z.string().min(1).max(80);
const PiiRegex = z.string().min(1).max(512).refine(compilesAsRegExp, "not a valid JavaScript regular expression");
// Loose on purpose (privacy decision 4): recognizers also name Presidio entities outside PiiEntity (EMAIL_ADDRESS, CREDIT_CARD).
const PiiEntityName = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);
const PiiWord = z
  .string()
  .min(1)
  .max(40)
  .refine((w) => w === w.toLowerCase() && w === w.trim(), "lower case, no outer spaces");
const piiInt = (max: number) => z.number().int().min(0).max(max);
const PiiProtected = z.strictObject({ name: PiiName, regex: PiiRegex });

const uniqueNames = (label: string, path: (i: number) => (string | number)[]) => (names: readonly string[], ctx: z.RefinementCtx) => {
  const seen = new Set<string>();
  names.forEach((name, i) => {
    if (seen.has(name)) ctx.addIssue({ code: "custom", path: path(i), message: `duplicate ${label} ${name}` });
    seen.add(name);
  });
};

export const PiiRecognizersFile = z
  .strictObject({
    $comment: PiiComment,
    version: z.literal(1),
    context_window: z.strictObject({ before: piiInt(256), after: piiInt(256), negative_before: piiInt(64), boost: z.number().min(0).max(1) }),
    protected: z.array(PiiProtected).max(16),
    recognizers: z
      .array(
        z.strictObject({
          name: PiiName,
          supported_language: z.literal("en"),
          supported_entity: PiiEntityName,
          patterns: z
            .array(
              z.strictObject({
                name: PiiName,
                regex: PiiRegex,
                score: z.number().min(0).max(1),
                hogee_context_required: z.boolean().optional(),
                hogee_validator: PiiValidatorName.optional(),
              }),
            )
            .min(1)
            .max(8),
          context: z.array(PiiWord).max(48),
          hogee_validator: PiiValidatorName.optional(),
          hogee_negative_context: z.array(PiiWord).max(48).optional(),
          hogee_context_window: z.strictObject({ before: piiInt(256), after: piiInt(256), same_line: z.boolean() }).optional(),
        }),
      )
      .min(1)
      .max(32),
  })
  .superRefine((file, ctx) => {
    uniqueNames("recognizer name", (i) => ["recognizers", i, "name"])(file.recognizers.map((r) => r.name), ctx);
    file.recognizers.forEach((r, ri) => uniqueNames("pattern name", (i) => ["recognizers", ri, "patterns", i, "name"])(r.patterns.map((p) => p.name), ctx));
  });
export type PiiRecognizersFile = z.infer<typeof PiiRecognizersFile>;

export const PiiCanaryFile = z
  .strictObject({
    $comment: PiiComment,
    version: z.literal(1),
    protected: z.array(PiiProtected).max(16),
    patterns: z.array(z.strictObject({ name: PiiName, entity: PiiEntityName, regex: PiiRegex, validator: PiiValidatorName.optional() })).min(1).max(32),
  })
  .superRefine((file, ctx) => uniqueNames("pattern name", (i) => ["patterns", i, "name"])(file.patterns.map((p) => p.name), ctx));
export type PiiCanaryFile = z.infer<typeof PiiCanaryFile>;
