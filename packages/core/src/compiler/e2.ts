/**
 * E2 label fields of a compiled plan (evals/datasets/e2/LABELING.md §3), derived from the PlanDraft alone:
 * the compliance facts travel in the manifest's rule ids (rule-ids.ts) and the reserve in manifest.reserveBps.
 * Pure: never reads human rule text, the LLM output, or anything outside the draft.
 */
import { E2LabelRow } from "../schemas/datasets";
import { ENTITY_TYPES, PRODUCT_APPROVALS, REGISTRATIONS, type DutyRoute, type EntityType, type ProductApproval, type Registration } from "../schemas/enums";
import type { PlanDraft } from "../schemas/plan";
import { toMinor } from "../money/index";
import { RULE_ID_PATTERNS } from "./rule-ids";

export type E2Fields = E2LabelRow["fields"];

export class E2DeriveError extends Error {
  override readonly name = "E2DeriveError";
}

const upper = (s: string): string => s.toUpperCase();

function exactlyOne<T>(values: readonly T[], what: string): T {
  if (values.length !== 1) throw new E2DeriveError(`expected exactly one ${what} rule, found ${values.length}`);
  return values[0] as T;
}

/** The 8 E2 fields of a draft, following LABELING.md. Throws E2DeriveError if the draft lacks a required rule. */
export function deriveE2Fields(draft: PlanDraft): E2Fields {
  const ids = draft.manifest.rules.map((r) => r.ruleId);
  const match = (re: RegExp) => ids.map((id) => re.exec(id)).filter((m): m is RegExpExecArray => m !== null);

  const entityType = exactlyOne(
    match(RULE_ID_PATTERNS.entity)
      .map((m) => m[1] ?? "")
      .filter((t): t is EntityType => (ENTITY_TYPES as readonly string[]).includes(t)),
    "entity",
  );

  let licence = 0n;
  const registrations: Registration[] = [];
  for (const m of match(RULE_ID_PATTERNS.registration)) {
    const code = upper(m[1] ?? "");
    if (!(REGISTRATIONS as readonly string[]).includes(code)) throw new E2DeriveError(`unknown registration ${code}`);
    registrations.push(code as Registration);
    licence += BigInt(m[2] ?? "0");
  }

  const indirect = exactlyOne(match(RULE_ID_PATTERNS.indirectTax), "indirect-tax")[1] === "registered";
  const eInvoicing = exactlyOne(match(RULE_ID_PATTERNS.eInvoicing), "einvoicing")[1] === "required";
  const dutyRoute = upper(exactlyOne(match(RULE_ID_PATTERNS.duty), "duty")[1] ?? "") as DutyRoute;

  const approvalMatch = exactlyOne(match(RULE_ID_PATTERNS.approval), "approval");
  const approval = upper(approvalMatch[1] ?? approvalMatch[2] ?? "");
  if (!(PRODUCT_APPROVALS as readonly string[]).includes(approval)) throw new E2DeriveError(`unknown approval ${approval}`);
  licence += BigInt(approvalMatch[3] ?? "0");

  return E2LabelRow.shape.fields.parse({
    entityType,
    registrations: [...new Set(registrations)].sort(),
    indirectTaxRegistered: indirect,
    eInvoicing,
    dutyRoute,
    productApproval: approval as ProductApproval,
    reserveBps: draft.manifest.reserveBps,
    licenceCostMinor: toMinor(licence),
  });
}

export interface E2FieldScore {
  readonly field: keyof E2Fields;
  readonly correct: boolean;
}

/** Score derived fields against a label row: `registrations` as a set, everything else exact (LABELING §1). */
export function scoreE2Fields(derived: E2Fields, label: E2Fields): E2FieldScore[] {
  const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set([...a, ...b]).size === new Set(a).size;
  return (Object.keys(label) as (keyof E2Fields)[]).map((field) => ({
    field,
    correct:
      field === "registrations" ? sameSet([...new Set(derived.registrations)], [...new Set(label.registrations)]) : derived[field] === label[field],
  }));
}
