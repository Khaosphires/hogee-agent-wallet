/**
 * classifySkill eval (evals/datasets/journey/skills.jsonl, README §A). Each founder message goes through the real
 * redactor and then classifySkill with the guarded planner model built the way the API builds it
 * (createModelRegistry(process.env) + agentModelsForRequest). It needs a configured planner model: without one, or
 * while classifySkill is still the v-contract stub, it prints "not run" and the reason and exits 0. It never reads a
 * .env file; it only sees the process environment.
 *
 *   pnpm exec tsx evals/scripts/journey/run-skills.ts [--json] [--limit N]
 */
import { classifySkill } from "../../../packages/agent/src/router/classify.ts";
import { agentModelsForRequest } from "../../../packages/agent/src/agent.ts";
import { MemoryCallSink } from "../../../packages/agent/src/guard/call-log.ts";
import { createModelRegistry, ModelConfigError } from "../../../packages/agent/src/models/registry.ts";
import type { GuardedModel } from "../../../packages/agent/src/guard/guarded-model.ts";
import { redact } from "../../../packages/privacy/src/index.ts";
import { SKILLS, type SkillCall } from "../../../packages/core/src/index.ts";
import { isMain, line, loadJsonl, show, tally, SkillRow, type Interval } from "./lib.ts";

export interface SkillOutcome {
  readonly row: SkillRow;
  readonly actual: SkillCall | null;
  readonly error: string | null;
  readonly skillOk: boolean;
  readonly fullOk: boolean;
}

const sameSet = (a: readonly number[] | null, b: readonly number[] | null): boolean =>
  a === null || b === null ? a === b : new Set(a).size === new Set(b).size && a.every((x) => b.includes(x));

/**
 * Skill must match. The full call also needs the ranks (as a set) for pick_suppliers/report_terms and the view for
 * cfo; ranks and view are not compared for other skills (the API's code nulls them there).
 */
export function scoreSkill(row: SkillRow, actual: SkillCall | null, error: string | null = null): SkillOutcome {
  const skillOk = actual !== null && actual.skill === row.expected.skill;
  const ranked = row.expected.skill === "pick_suppliers" || row.expected.skill === "report_terms";
  const fullOk =
    skillOk &&
    (!ranked || sameSet(row.expected.candidateRanks, actual!.candidateRanks)) &&
    (row.expected.skill !== "cfo" || row.expected.cfoView === actual!.cfoView);
  return { row, actual, error, skillOk, fullOk };
}

export interface SkillReport {
  readonly skill: Interval;
  readonly full: Interval;
  readonly bySkill: Readonly<Record<string, Interval>>;
  readonly byTag: Readonly<Record<string, Interval>>;
  readonly attacksOutOfScope: Interval;
  /** Rows where classifySkill threw (network, budget, abort): scored as misses; rerun before quoting the numbers. */
  readonly errors: number;
  readonly confusion: Readonly<Record<string, number>>;
}

export function summarise(outcomes: readonly SkillOutcome[]): SkillReport {
  const tags = [...new Set(outcomes.flatMap((o) => o.row.tags))].sort();
  const confusion: Record<string, number> = {};
  for (const o of outcomes.filter((x) => !x.skillOk)) {
    const key = `${o.row.expected.skill}→${o.actual?.skill ?? "error"}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
  }
  return {
    skill: tally(outcomes, (o) => o.skillOk),
    full: tally(outcomes, (o) => o.fullOk),
    bySkill: Object.fromEntries(SKILLS.map((s) => [s, tally(outcomes.filter((o) => o.row.expected.skill === s), (o) => o.skillOk)])),
    byTag: Object.fromEntries(tags.map((t) => [t, tally(outcomes.filter((o) => o.row.tags.includes(t)), (o) => o.skillOk)])),
    attacksOutOfScope: tally(outcomes.filter((o) => o.row.tags.includes("attack")), (o) => o.actual?.skill === "out_of_scope"),
    errors: outcomes.filter((o) => o.error !== null).length,
    confusion,
  };
}

/** The guarded planner model, or the reason there is none (a ModelConfigError message; it never holds a key). */
function plannerModel(): GuardedModel | string {
  try {
    const registry = createModelRegistry(process.env, { require: ["planner"] });
    return agentModelsForRequest(registry, { sink: new MemoryCallSink() }, { facilityId: "fac-eval", traceId: null }).planner;
  } catch (e) {
    if (e instanceof ModelConfigError) return e.message;
    throw e;
  }
}

const STUB_RE = /NOT_IMPLEMENTED/;

function print(outcomes: readonly SkillOutcome[], r: SkillReport): void {
  const out = ["classifySkill on evals/datasets/journey/skills.jsonl (real redactor first)", ""];
  out.push(line("skill correct", r.skill), line("full SkillCall correct", r.full));
  for (const [s, i] of Object.entries(r.bySkill)) out.push(line(`  expected ${s}`, i));
  for (const [t, i] of Object.entries(r.byTag)) out.push(line(`  tag ${t}`, i));
  out.push(line("attack rows → out_of_scope", r.attacksOutOfScope));
  if (r.errors > 0) out.push(`  WARNING: ${r.errors} row(s) threw (scored as misses); rerun before quoting these numbers`);
  out.push("", "  expected→actual skill on misses: " + Object.entries(r.confusion).map(([k, v]) => `${k} ${v}`).join(", "), "", "Misses:");
  for (const o of outcomes.filter((x) => !x.fullOk)) {
    out.push(`  ${o.row.caseId} [${o.row.stage}, ${o.row.candidateCount} cards${o.row.tags.length ? ", " + o.row.tags.join(",") : ""}] ${show(o.row.text)}`);
    out.push(`      expected ${show(o.row.expected)}`, `      actual   ${o.error ? "error: " + o.error : show(o.actual)}`);
  }
  process.stdout.write(out.join("\n") + "\n");
}

function notRun(reason: string): void {
  process.stdout.write(`classifySkill eval: not run (${reason})\n`);
}

export type Classify = (input: { text: string; stage: SkillRow["stage"]; candidateCount: number }) => Promise<SkillCall>;

/** Redacts each row and classifies it; "stub" when classify is still the v-contract stub. */
export async function runSkills(rows: readonly SkillRow[], classify: Classify): Promise<SkillOutcome[] | "stub"> {
  const outcomes: SkillOutcome[] = [];
  for (const row of rows) {
    const { text } = await redact(row.text);
    try {
      outcomes.push(scoreSkill(row, await classify({ text, stage: row.stage, candidateCount: row.candidateCount })));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (STUB_RE.test(msg)) return "stub";
      outcomes.push(scoreSkill(row, null, `${e instanceof Error ? e.name : "error"}: ${msg.slice(0, 200)}`));
    }
  }
  return outcomes;
}

async function main(): Promise<void> {
  const rows = loadJsonl("skills.jsonl", SkillRow);
  const limitAt = process.argv.indexOf("--limit");
  const limit = limitAt > 0 ? Number(process.argv[limitAt + 1]) : rows.length;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit needs a positive integer");
  const model = plannerModel();
  if (typeof model === "string") return notRun(`no planner model configured: ${model}`);
  const outcomes = await runSkills(rows.slice(0, limit), (input) => classifySkill(input, { model }));
  if (outcomes === "stub") return notRun("classifySkill is still the v-contract stub on this commit");
  const report = summarise(outcomes);
  if (process.argv.includes("--json")) process.stdout.write(JSON.stringify({ report, misses: outcomes.filter((o) => !o.fullOk) }, null, 2) + "\n");
  else print(outcomes, report);
}

if (isMain(import.meta.url)) {
  main().catch((e: unknown) => {
    process.stderr.write(`run-skills failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
