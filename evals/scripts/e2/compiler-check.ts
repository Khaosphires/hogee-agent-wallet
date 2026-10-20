/**
 * E2 compiler cross-check (not part of the generator): compiles each prompt's ground-truth intent with the REAL
 * compiler (@hogee/core compilePlan on data/country-packs/<country>.json), reads the 8 fields back with deriveE2Fields
 * and compares them with the committed labels. The labels are never changed to match: each disagreement is either a
 * labelling bug (fixed in e2/label.mjs, with the reason in evals/docs/evals-e2.md) or a compiler/pack finding.
 * Every disagreement must be listed in KNOWN with its classification; a new one fails the run (exit 1).
 * It also loads the committed files through the API's own reader (e2PromptLoader) to prove every vague prompt gets
 * its hidden answer.
 *
 *   pnpm exec tsx evals/scripts/e2/compiler-check.ts            print the disagreement table; exit 1 on an unknown one
 *
 * The ground-truth intent is what a perfect planner would emit: the prompt's facts (prompts.meta.jsonl `truth`, the
 * hidden slot answered) and the labelled entity type, on the same-country demo facility (Mei for SG, Rina for MY).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CountryPack,
  E2LabelRow,
  JUDGING_WINDOW_END,
  MEI_COMMIT_AT,
  MEI_COMPILE_FACILITY,
  PackFactMissingError,
  PlanIntent,
  RINA_COMMIT_AT,
  RINA_FACILITY,
  RINA_IDS,
  RINA_PLATFORM_REGISTRY,
  ZERO_ADDRESS,
  compilePlan,
  deriveE2Fields,
  fakeAddress,
  fakeHex32,
  scoreE2Fields,
  type CompileFacility,
  type CompileInput,
  type E2Fields,
} from "../../../packages/core/src/index.ts";
import { e2PromptLoader } from "../../../packages/api/src/runtime/eval-data.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DATA = path.join(ROOT, "evals/datasets/e2");

interface Truth {
  readonly residency: "citizen" | "pr" | "foreigner";
  readonly productCategory: PlanIntent["productCategory"];
  readonly buyFrom: string;
  readonly budgetMinor: string;
  readonly sellChannel: PlanIntent["sellChannel"];
  readonly horizonDays: 30 | 60 | 90;
}
interface Meta {
  readonly promptId: string;
  readonly country: "SG" | "MY";
  readonly truth: Truth;
}

/**
 * Every disagreement found on the committed data, keyed `<promptId>` (whole compile failed) or `<promptId>.<field>`,
 * with its classification. Checked against the run both ways: an entry that no longer occurs also fails, so this
 * table always equals the report in evals/docs/evals-e2.md §4.
 */
const gap = (leaves: string): string => `pack gap (MY.json lacks ${leaves}); the compiler is right to fail closed; label stands`;
const TIN_GAP = gap("a Sdn Bhd LHDN_TIN fee: its 0 is scoped to individuals");
const APPAREL_GAP = gap("productApprovals.apparel; LABELING §3.6 says NONE");
const KNOWN: Readonly<Record<string, string>> = {
  "e2-my-003": TIN_GAP,
  "e2-my-007": TIN_GAP,
  "e2-my-008": TIN_GAP,
  "e2-my-011": APPAREL_GAP,
  "e2-my-012": APPAREL_GAP,
  "e2-my-013": gap("both a Sdn Bhd LHDN_TIN fee and productApprovals.apparel"),
  "e2-my-014": APPAREL_GAP,
  "e2-my-016": APPAREL_GAP,
};

const jsonl = <T>(file: string): T[] =>
  readFileSync(path.join(DATA, file), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as T);

const pack = (cc: string): CountryPack => CountryPack.parse(JSON.parse(readFileSync(path.join(ROOT, `data/country-packs/${cc}.json`), "utf8")));
const PACKS = { SG: pack("SG"), MY: pack("MY") };

/** Rina's facility as core/test/fixtures/rina-compile.ts builds it (not exported from core's src). */
const RINA_COMPILE_FACILITY: CompileFacility = {
  facilityId: RINA_IDS.facilityId,
  countryCode: RINA_FACILITY.countryCode,
  currency: RINA_FACILITY.currency,
  capMinor: RINA_FACILITY.capMinor,
  reserveFloorBps: RINA_FACILITY.reserveFloorBps,
  judgingWindowEnd: JUDGING_WINDOW_END,
  payees: RINA_PLATFORM_REGISTRY,
  ownerEOA: ZERO_ADDRESS,
  lender: fakeAddress("lender:final-1"),
  oracle: fakeAddress("oracle:final-1"),
};
const FACILITY = { SG: { facility: MEI_COMPILE_FACILITY, now: MEI_COMMIT_AT }, MY: { facility: RINA_COMPILE_FACILITY, now: RINA_COMMIT_AT } };

function compileInput(meta: Meta, label: E2Fields): CompileInput {
  const t = meta.truth;
  const intent = PlanIntent.parse({
    intentVersion: 1,
    countryCode: meta.country,
    residency: t.residency,
    entityType: label.entityType,
    productCategory: t.productCategory,
    sellChannel: t.sellChannel,
    buyFrom: t.buyFrom,
    budgetCeilingMinor: t.budgetMinor,
    horizonDays: t.horizonDays,
    lineEmphasis: {},
    adsPacing: "standard",
    answeredSlots: ["residency", "productCategory", "buyFrom", "budgetCeilingMinor"],
    assumptions: [],
  });
  const { facility, now } = FACILITY[meta.country];
  return {
    intent,
    countryPack: PACKS[meta.country],
    facility,
    now,
    ids: { draftId: `draft-${meta.promptId}`, planId: fakeHex32(`planId:${meta.promptId}`), agentAddress: fakeAddress(`agent:${meta.promptId}`) },
    aigc: { model: "e2-compiler-check", promptHash: fakeHex32(`promptHash:${meta.promptId}`) },
  };
}

interface Row {
  readonly key: string;
  readonly label: string;
  readonly compiler: string;
}

const show = (v: unknown): string => (Array.isArray(v) ? [...v].sort().join("+") : String(v));

/**
 * WHAT-IF ONLY (never data): MY.json with the two leaves the labels assume filled in, copied from neighbouring MY
 * leaves: LHDN_TIN's fee record widened to sdn_bhd, and apparel given drinkware's sourced NONE entry. It shows whether
 * the prompts that fail closed today would then agree on all 8 fields; the real pack must source both leaves itself.
 */
function whatIfMyPack(): CountryPack {
  const my = PACKS.MY;
  const registrations = (my.registrations ?? []).map((r) => (r.code === "LHDN_TIN" ? { ...r, entityTypes: [...r.entityTypes, "sdn_bhd" as const] } : r));
  const productApprovals = { ...my.productApprovals, apparel: my.productApprovals?.drinkware_food_contact };
  return CountryPack.parse({ ...my, registrations, productApprovals });
}

function compare(meta: Meta, label: E2Fields, packOverride?: CountryPack): Row[] {
  let derived: E2Fields;
  try {
    const input = compileInput(meta, label);
    derived = deriveE2Fields(compilePlan(packOverride ? { ...input, countryPack: packOverride } : input));
  } catch (error: unknown) {
    const why = error instanceof PackFactMissingError ? `PACK_FACT_MISSING ${error.leaves.join(", ")}` : `${(error as Error).name}: ${(error as Error).message}`;
    return [{ key: meta.promptId, label: "a plan", compiler: why }];
  }
  return scoreE2Fields(derived, label)
    .filter((s) => !s.correct)
    .map((s) => ({ key: `${meta.promptId}.${s.field}`, label: show(label[s.field]), compiler: show(derived[s.field]) }));
}

async function loaderProblems(prompts: readonly { promptId: string; vague: boolean }[]): Promise<string[]> {
  const logs: string[] = [];
  const log = { info: () => undefined, warn: (e: string) => void logs.push(e), error: (e: string) => void logs.push(e) };
  const load = e2PromptLoader(ROOT, log as never);
  const problems: string[] = [];
  for (const p of prompts) {
    const found = await load(p.promptId);
    if (!found) problems.push(`${p.promptId}: the API loader does not find it`);
    else if (p.vague !== (found.hiddenAnswer !== null)) problems.push(`${p.promptId}: vague=${p.vague} but hiddenAnswer=${JSON.stringify(found.hiddenAnswer)}`);
  }
  return [...problems, ...logs.map((e) => `loader logged ${e}`)];
}

async function main(): Promise<void> {
  const metas = jsonl<Meta>("prompts.meta.jsonl");
  const labels = new Map(jsonl<unknown>("labels.jsonl").map((raw) => E2LabelRow.parse(raw)).map((r) => [r.promptId, r.fields]));
  const rows = metas.flatMap((m) => {
    const label = labels.get(m.promptId);
    if (!label) throw new Error(`${m.promptId}: no label row`);
    return compare(m, label);
  });
  const seen = new Set(rows.map((r) => r.key));
  const unknown = rows.filter((r) => !(r.key in KNOWN));
  const stale = Object.keys(KNOWN).filter((k) => !seen.has(k));
  const out = [
    `E2 compiler check: ${metas.length} prompts, ${metas.length * 8} labels; ${rows.length} disagreement(s).`,
    "",
    "| Key | Label | Compiler | Classification |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.key} | ${r.label} | ${r.compiler} | ${KNOWN[r.key] ?? "UNCLASSIFIED"} |`),
  ];
  const failedWhole = metas.filter((m) => m.country === "MY" && seen.has(m.promptId));
  const whatIf = failedWhole.flatMap((m) => compare(m, labels.get(m.promptId) as E2Fields, whatIfMyPack()));
  out.push(
    "",
    `What-if (MY.json with LHDN_TIN[sdn_bhd] and productApprovals.apparel filled as the labels assume; not data): ${failedWhole.length} prompt(s) re-compiled, ${whatIf.length} disagreement(s)${whatIf.length ? ":" : "."}`,
    ...whatIf.map((r) => `- ${r.key}: label ${r.label}, compiler ${r.compiler}`),
  );
  const loader = await loaderProblems(jsonl<{ promptId: string; vague: boolean }>("prompts.jsonl"));
  out.push("", loader.length ? `API loader: ${loader.length} problem(s)\n${loader.join("\n")}` : `API loader: all ${metas.length} prompts found, every vague prompt has its hidden answer.`);
  if (stale.length) out.push("", `KNOWN entries that no longer occur: ${stale.join(", ")}`);
  process.stdout.write(`${out.join("\n")}\n`);
  if (unknown.length || stale.length || loader.length || whatIf.length) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`compiler-check failed: ${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 1;
});
