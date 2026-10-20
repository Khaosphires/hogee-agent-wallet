/**
 * Journey eval checks (no function under test runs here): the committed datasets parse strictly, have the documented
 * composition and wording, the recorded labels line up with the recorded search, the Wilson interval matches known
 * values, the scorers compare what README §A–§C say, and no runner writes into the datasets.
 *
 *   pnpm exec tsx --test evals/scripts/journey/journey.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DATASET_DIR, REPO, ListingRow, RecordedLabel, SkillRow, TermsRow, loadJsonl, wilson } from "./lib.ts";
import { classOf, sameHint, scoreTerms } from "./run-terms.ts";
import { runSkills, scoreSkill, summarise as summariseSkills } from "./run-skills.ts";

const { checkText } = (await import(path.join(REPO, "scripts", "lint-wording", "index.mjs"))) as { checkText: (t: string) => unknown[] };

const count = <T>(rows: readonly T[], key: (r: T) => string): Record<string, number> =>
  rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [key(r)]: (acc[key(r)] ?? 0) + 1 }), {});

const sequential = (ids: readonly string[], prefix: string, width: number) =>
  ids.forEach((id, i) => assert.equal(id, `${prefix}${String(i + 1).padStart(width, "0")}`));

/** Every string inside a value, recursively. */
const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);

describe("wilson", () => {
  it("matches published 95% Wilson intervals", () => {
    const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 5e-4, `${a} vs ${b}`);
    const a = wilson(8, 10);
    close(a.lo, 0.4902);
    close(a.hi, 0.9433);
    const b = wilson(0, 10);
    close(b.lo, 0);
    close(b.hi, 0.2775);
    const c = wilson(10, 10);
    close(c.lo, 0.7225);
    close(c.hi, 1);
    const d = wilson(45, 52);
    assert.ok(d.lo < d.p && d.p < d.hi);
    assert.deepEqual([wilson(0, 0).lo, wilson(0, 0).hi], [0, 1]);
    assert.throws(() => wilson(3, 2), RangeError);
  });
});

describe("scorers", () => {
  const terms = loadJsonl("terms.jsonl", TermsRow);
  it("terms: exact match needs the same milestones in order and the same question", () => {
    const row = terms.find((r) => classOf(r.expected) === "schedule")!;
    assert.equal(scoreTerms(row, row.text, row.expected).exact, true);
    const reversed = { ...row.expected, milestones: [...row.expected.milestones!].reverse() };
    assert.equal(sameHint(row.expected, reversed), row.expected.milestones!.length === 1);
    const none = { milestones: null, ambiguous: false, question: null } as const;
    const question = { milestones: null, ambiguous: true, question: "DEPOSIT_TRIGGER" } as const;
    assert.equal(sameHint(none, question), false);
    assert.equal(scoreTerms(row, row.text, none).wrongPrefill, false);
    const other = { milestones: [{ bps: 10_000, trigger: "ON_DELIVERY_INSPECTED" as const }], ambiguous: false, question: null };
    assert.equal(scoreTerms({ ...row, expected: none }, row.text, other).wrongPrefill, true);
  });

  it("skills: ranks compare as sets for pick/report, view only for cfo", () => {
    const row = (expected: SkillRow["expected"]): SkillRow => ({ caseId: "sk-999", lang: "en", stage: "CANDIDATES", candidateCount: 5, text: "x", tags: [], expected });
    const pick = row({ skill: "pick_suppliers", candidateRanks: [2, 4], cfoView: null });
    assert.equal(scoreSkill(pick, { skill: "pick_suppliers", candidateRanks: [4, 2], cfoView: null }).fullOk, true);
    assert.equal(scoreSkill(pick, { skill: "pick_suppliers", candidateRanks: [2], cfoView: null }).fullOk, false);
    assert.equal(scoreSkill(pick, { skill: "pick_suppliers", candidateRanks: [2], cfoView: null }).skillOk, true);
    const cfo = row({ skill: "cfo", candidateRanks: null, cfoView: "pnl" });
    assert.equal(scoreSkill(cfo, { skill: "cfo", candidateRanks: null, cfoView: "overview" }).fullOk, false);
    const help = row({ skill: "help", candidateRanks: null, cfoView: null });
    assert.equal(scoreSkill(help, { skill: "help", candidateRanks: [1], cfoView: null }).fullOk, true);
    assert.equal(scoreSkill(help, null, "boom").skillOk, false);
  });
});

describe("skills runner (scripted classifier, no model)", () => {
  const rows = loadJsonl("skills.jsonl", SkillRow);
  it("an oracle that returns each label (rows run in order) scores 100%", async () => {
    let i = 0;
    const out = await runSkills(rows, async (input) => {
      const row = rows[i++]!;
      assert.equal(input.stage, row.stage);
      assert.equal(input.candidateCount, row.candidateCount);
      return { ...row.expected, candidateRanks: row.expected.candidateRanks ? [...row.expected.candidateRanks] : null };
    });
    assert.ok(out !== "stub");
    const r = summariseSkills(out);
    assert.deepEqual([r.skill.k, r.full.k, r.attacksOutOfScope.k], [rows.length, rows.length, 10]);
  });
  it("reports the stub instead of scoring it", async () => {
    assert.equal(await runSkills(rows.slice(0, 3), async () => { throw new Error("NOT_IMPLEMENTED: classifySkill"); }), "stub");
  });
  it("counts a thrown model error as a miss", async () => {
    const out = await runSkills(rows.slice(0, 2), async () => { throw new Error("timeout"); });
    assert.ok(out !== "stub" && summariseSkills(out).skill.k === 0 && out.every((o) => o.error?.includes("timeout")));
    assert.equal(summariseSkills(out).errors, 2);
  });
});

describe("datasets", () => {
  it("skills.jsonl: 88 strict rows with the documented skill and view counts", () => {
    const rows = loadJsonl("skills.jsonl", SkillRow);
    sequential(rows.map((r) => r.caseId), "sk-", 3);
    assert.deepEqual(count(rows, (r) => r.expected.skill), { help: 6, status: 9, plan: 8, pick_suppliers: 12, find_suppliers: 9, report_terms: 14, out_of_scope: 15, cfo: 15 });
    assert.deepEqual(count(rows.filter((r) => r.expected.cfoView), (r) => r.expected.cfoView!), { overview: 3, forecast: 2, reserve: 2, spending: 2, pnl: 3, sales: 3 });
    assert.ok(rows.filter((r) => r.tags.includes("attack")).every((r) => r.expected.skill === "out_of_scope"));
    assert.equal(rows.filter((r) => r.tags.includes("attack")).length, 10);
    assert.equal(new Set(rows.map((r) => r.text)).size, rows.length);
  });

  it("terms.jsonl: 52 strict rows, 28 schedules / 9 questions / 15 nothing", () => {
    const rows = loadJsonl("terms.jsonl", TermsRow);
    sequential(rows.map((r) => r.caseId), "th-", 3);
    assert.deepEqual(count(rows, (r) => classOf(r.expected)), { schedule: 28, none: 15, question: 9 });
    assert.equal(new Set(rows.map((r) => r.text)).size, rows.length);
  });

  it("listings.jsonl: 20 injected (2 by URL) and 10 clean controls", () => {
    const rows = loadJsonl("listings.jsonl", ListingRow);
    sequential(rows.map((r) => r.caseId), "li-", 3);
    assert.deepEqual(count(rows, (r) => r.expected), { excluded: 20, kept: 10 });
    assert.equal(rows.filter((r) => r.expectedGate === "URL").length, 2);
    assert.ok(rows.every((r) => r.result.url.startsWith("https://")));
  });

  it("recorded-labels.jsonl: one label per recorded result, in rank order", () => {
    const labels = loadJsonl("recorded-labels.jsonl", RecordedLabel);
    const fixture = JSON.parse(readFileSync(path.join(REPO, "data", "suppliers", "search", "recorded", "drinkware_food_contact-CN.json"), "utf8")) as { results: { url: string }[] };
    assert.deepEqual(labels.map((l) => l.url), fixture.results.map((r) => r.url));
    assert.deepEqual(labels.map((l) => l.rank), fixture.results.map((_, i) => i + 1));
  });

  it("every file and every string in it passes the wording lint", () => {
    for (const name of readdirSync(DATASET_DIR)) {
      const raw = readFileSync(path.join(DATASET_DIR, name), "utf8");
      assert.deepEqual(checkText(raw), [], name);
      if (name.endsWith(".jsonl")) for (const l of raw.trim().split("\n")) for (const s of strings(JSON.parse(l))) assert.deepEqual(checkText(s), [], `${name}: ${s.slice(0, 60)}`);
    }
  });
});

describe("integrity", () => {
  it("no runner writes files (the datasets are read-only inputs)", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    for (const f of readdirSync(dir).filter((n) => n.startsWith("run-") || n === "lib.ts")) {
      assert.doesNotMatch(readFileSync(path.join(dir, f), "utf8"), /writeFile|appendFile|createWriteStream/, f);
    }
  });
});
