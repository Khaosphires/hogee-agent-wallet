/**
 * parseTermsHint eval (evals/datasets/journey/terms.jsonl, README §B). Offline: each founder message goes through the
 * real redactor (@hogee/privacy redact, as the API does) and then parseTermsHint; the result is compared with the label
 * written before any run. Labels are never changed to match.
 *
 *   pnpm exec tsx evals/scripts/journey/run-terms.ts           report + every miss
 *   pnpm exec tsx evals/scripts/journey/run-terms.ts --json    the same as one JSON object
 */
import { parseTermsHint } from "../../../packages/core/src/index.ts";
import { redact } from "../../../packages/privacy/src/index.ts";
import { isMain, line, loadJsonl, show, tally, wilson, TermsRow, type ExpectedHint, type Interval } from "./lib.ts";

export type HintClass = "schedule" | "question" | "none";

export interface TermsOutcome {
  readonly row: TermsRow;
  readonly redacted: string;
  readonly actual: ExpectedHint;
  readonly exact: boolean;
  /** A prefill was produced and it is not the labelled one (the founder would have to catch it in the form). */
  readonly wrongPrefill: boolean;
}

export const classOf = (h: ExpectedHint): HintClass => (h.milestones ? "schedule" : h.question ? "question" : "none");

/** Exact equality: same milestones in the same order (or both null), same ambiguity and question. */
export function sameHint(a: ExpectedHint, b: ExpectedHint): boolean {
  if (a.ambiguous !== b.ambiguous || a.question !== b.question) return false;
  if (a.milestones === null || b.milestones === null) return a.milestones === b.milestones;
  return a.milestones.length === b.milestones.length && a.milestones.every((m, i) => m.bps === b.milestones![i]!.bps && m.trigger === b.milestones![i]!.trigger);
}

export function scoreTerms(row: TermsRow, redacted: string, actual: ExpectedHint): TermsOutcome {
  const exact = sameHint(row.expected, actual);
  return { row, redacted, actual, exact, wrongPrefill: actual.milestones !== null && !exact };
}

async function runOne(row: TermsRow): Promise<TermsOutcome> {
  const { text: redacted } = await redact(row.text);
  const hint = parseTermsHint(redacted);
  const actual: ExpectedHint = {
    milestones: hint.milestones ? hint.milestones.map((m) => ({ bps: m.bps, trigger: m.trigger })) : null,
    ambiguous: hint.ambiguous,
    question: hint.question,
  };
  return scoreTerms(row, redacted, actual);
}

export interface TermsReport {
  readonly overall: Interval;
  readonly byClass: Readonly<Record<HintClass, Interval>>;
  readonly withoutConvention: Interval;
  readonly conventionOnly: Interval;
  readonly byLang: Readonly<Record<string, Interval>>;
  readonly byTag: Readonly<Record<string, Interval>>;
  readonly wrongPrefill: Interval;
  readonly confusion: Readonly<Record<string, number>>;
}

export function summarise(outcomes: readonly TermsOutcome[]): TermsReport {
  const byClass = Object.fromEntries((["schedule", "question", "none"] as const).map((c) => [c, tally(outcomes.filter((o) => classOf(o.row.expected) === c), (o) => o.exact)])) as Record<HintClass, Interval>;
  const langs = [...new Set(outcomes.map((o) => o.row.lang))].sort();
  const tags = [...new Set(outcomes.flatMap((o) => o.row.tags))].sort();
  const confusion: Record<string, number> = {};
  for (const o of outcomes) {
    const key = `${classOf(o.row.expected)}→${classOf(o.actual)}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
  }
  return {
    overall: tally(outcomes, (o) => o.exact),
    byClass,
    withoutConvention: tally(outcomes.filter((o) => !o.row.tags.includes("convention")), (o) => o.exact),
    conventionOnly: tally(outcomes.filter((o) => o.row.tags.includes("convention")), (o) => o.exact),
    byLang: Object.fromEntries(langs.map((l) => [l, tally(outcomes.filter((o) => o.row.lang === l), (o) => o.exact)])),
    byTag: Object.fromEntries(tags.map((t) => [t, tally(outcomes.filter((o) => o.row.tags.includes(t)), (o) => o.exact)])),
    wrongPrefill: wilson(outcomes.filter((o) => o.wrongPrefill).length, outcomes.length),
    confusion,
  };
}

function print(outcomes: readonly TermsOutcome[], r: TermsReport): void {
  const out: string[] = ["parseTermsHint on evals/datasets/journey/terms.jsonl (real redactor first)", ""];
  out.push(line("exact match, all rows", r.overall));
  for (const [c, i] of Object.entries(r.byClass)) out.push(line(`  expected ${c}`, i));
  out.push(line("rows without a convention tag", r.withoutConvention));
  out.push(line("rows with a convention tag", r.conventionOnly));
  for (const [l, i] of Object.entries(r.byLang)) out.push(line(`  lang ${l}`, i));
  for (const [t, i] of Object.entries(r.byTag)) out.push(line(`  tag ${t}`, i));
  out.push(line("wrong prefill (lower is better)", r.wrongPrefill));
  out.push("", "  expected→actual class counts: " + Object.entries(r.confusion).map(([k, v]) => `${k} ${v}`).join(", "), "", "Misses:");
  for (const o of outcomes.filter((x) => !x.exact)) {
    out.push(`  ${o.row.caseId} [${o.row.lang}${o.row.tags.length ? " " + o.row.tags.join(",") : ""}] ${show(o.row.text)}`);
    if (o.redacted !== o.row.text) out.push(`      redacted: ${show(o.redacted)}`);
    out.push(`      expected ${show(o.row.expected)}`, `      actual   ${show(o.actual)}${o.wrongPrefill ? "   <- wrong prefill" : ""}`);
  }
  process.stdout.write(out.join("\n") + "\n");
}

async function main(): Promise<void> {
  const rows = loadJsonl("terms.jsonl", TermsRow);
  const outcomes: TermsOutcome[] = [];
  for (const row of rows) outcomes.push(await runOne(row));
  const report = summarise(outcomes);
  if (process.argv.includes("--json")) process.stdout.write(JSON.stringify({ report, misses: outcomes.filter((o) => !o.exact) }, null, 2) + "\n");
  else print(outcomes, report);
}

if (isMain(import.meta.url)) {
  main().catch((e: unknown) => {
    process.stderr.write(`run-terms failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
