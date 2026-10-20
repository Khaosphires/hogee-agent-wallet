/**
 * Shared pieces of the journey evals (evals/datasets/journey/README.md): the row schemas (strict, fail closed), the
 * JSONL loader, the Wilson score interval and the report formatting. No I/O beyond reading the committed datasets.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CfoView, JourneyStage, MilestoneTrigger, Skill, SupplierGate } from "../../../packages/core/src/index.ts";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DATASET_DIR = path.join(REPO, "evals", "datasets", "journey");

/** Stages where free text reaches classifySkill (INTAKE and NEEDS_REVIEW go to the planner). */
export const ROUTER_STAGES = [
  "FOUNDER_KEY_PENDING",
  "PLAN_PENDING",
  "PLAN_ACTIVE",
  "SEARCHING",
  "CANDIDATES",
  "PICKED",
  "TERMS_DRAFT",
  "TERMS_CONFIRMED",
  "ORDER_PENDING",
  "COOLING",
  "OPERATING",
] as const satisfies readonly z.infer<typeof JourneyStage>[];
const BEFORE_CANDIDATES = new Set<string>(["FOUNDER_KEY_PENDING", "PLAN_PENDING", "PLAN_ACTIVE", "SEARCHING"]);

const Lang = z.enum(["en", "ms", "zh"]);
const Tags = z.array(z.string().regex(/^[a-z][a-z0-9-]{0,30}$/)).max(8);

export const ExpectedSkillCall = z.strictObject({
  skill: Skill,
  candidateRanks: z.array(z.number().int().min(1).max(8)).min(1).max(5).nullable(),
  cfoView: CfoView.nullable(),
});
export type ExpectedSkillCall = z.infer<typeof ExpectedSkillCall>;

export const SkillRow = z
  .strictObject({
    caseId: z.string().regex(/^sk-\d{3}$/),
    lang: Lang,
    stage: z.enum(ROUTER_STAGES),
    candidateCount: z.number().int().min(0).max(8),
    text: z.string().min(1).max(4000),
    expected: ExpectedSkillCall,
    tags: Tags,
  })
  .superRefine((r, ctx) => {
    const before = BEFORE_CANDIDATES.has(r.stage);
    if (before !== (r.candidateCount === 0)) ctx.addIssue({ code: "custom", message: "candidateCount is 0 exactly before CANDIDATES" });
    const ranked = r.expected.skill === "pick_suppliers" || r.expected.skill === "report_terms";
    const ranks = r.expected.candidateRanks;
    if (!ranked && ranks !== null) ctx.addIssue({ code: "custom", message: "candidateRanks only for pick_suppliers/report_terms" });
    if (ranks && ranks.some((k) => k > r.candidateCount)) ctx.addIssue({ code: "custom", message: "a labelled rank is out of range" });
    if (ranks && new Set(ranks).size !== ranks.length) ctx.addIssue({ code: "custom", message: "duplicate ranks" });
    if ((r.expected.skill === "cfo") !== (r.expected.cfoView !== null)) ctx.addIssue({ code: "custom", message: "cfoView exactly for cfo" });
  });
export type SkillRow = z.infer<typeof SkillRow>;

const Milestone = z.strictObject({ bps: z.number().int().min(1).max(10_000), trigger: MilestoneTrigger });
export const ExpectedHint = z
  .strictObject({
    milestones: z.array(Milestone).min(1).max(8).nullable(),
    ambiguous: z.boolean(),
    question: z.literal("DEPOSIT_TRIGGER").nullable(),
  })
  .superRefine((h, ctx) => {
    if (h.ambiguous !== (h.question !== null)) ctx.addIssue({ code: "custom", message: "ambiguous exactly when question is set" });
    if (h.ambiguous && h.milestones !== null) ctx.addIssue({ code: "custom", message: "a question carries no milestones" });
    const ms = h.milestones;
    if (!ms) return;
    if (ms.reduce((s, m) => s + m.bps, 0) !== 10_000) ctx.addIssue({ code: "custom", message: "milestones must add up to 10000 bps" });
    const order = MilestoneTrigger.options;
    if (ms.some((m, i) => i > 0 && order.indexOf(m.trigger) < order.indexOf(ms[i - 1]!.trigger))) ctx.addIssue({ code: "custom", message: "triggers out of order" });
    if (ms[ms.length - 1]!.trigger !== "ON_DELIVERY_INSPECTED") ctx.addIssue({ code: "custom", message: "the last trigger must be ON_DELIVERY_INSPECTED" });
  });
export type ExpectedHint = z.infer<typeof ExpectedHint>;

export const TermsRow = z.strictObject({
  caseId: z.string().regex(/^th-\d{3}$/),
  lang: Lang,
  text: z.string().min(1).max(4000),
  expected: ExpectedHint,
  tags: Tags,
});
export type TermsRow = z.infer<typeof TermsRow>;

const ExpectedGate = z.union([SupplierGate.extract(["AI_INJECTION", "OFF_PLATFORM_DISCOUNT"]), z.literal("URL")]);
export const ListingRow = z
  .strictObject({
    caseId: z.string().regex(/^li-\d{3}$/),
    scenario: z.string().regex(/^[a-z0-9-]{3,60}$/),
    lang: z.string().regex(/^[a-z]{2}(-[a-z]{2})?$/),
    result: z.strictObject({ url: z.string().min(8).max(2048), title: z.string().min(1), content: z.string().min(1), raw_content: z.string().min(1) }),
    expected: z.enum(["excluded", "kept"]),
    expectedGate: ExpectedGate.nullable(),
    tags: Tags,
  })
  .refine((r) => (r.expected === "kept") === (r.expectedGate === null), "a kept row has no gate and an excluded row has one");
export type ListingRow = z.infer<typeof ListingRow>;

export const RecordedLabel = z
  .strictObject({
    caseId: z.string().regex(/^rec-\d{2}$/),
    rank: z.number().int().min(1).max(20),
    url: z.string().url(),
    scenario: z.string().regex(/^[a-z0-9-]{3,60}$/),
    expected: z.enum(["excluded", "kept"]),
    expectedGate: ExpectedGate.nullable(),
  })
  .refine((r) => (r.expected === "kept") === (r.expectedGate === null), "a kept row has no gate and an excluded row has one");
export type RecordedLabel = z.infer<typeof RecordedLabel>;

/** Reads and validates a committed JSONL dataset; any bad line throws (fail closed). */
export function loadJsonl<T>(file: string, schema: z.ZodType<T>): T[] {
  const raw = readFileSync(path.join(DATASET_DIR, file), "utf8");
  if (!raw.endsWith("\n")) throw new Error(`${file}: must end with a newline`);
  return raw
    .slice(0, -1)
    .split("\n")
    .map((line, i) => {
      const parsed = schema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(`${file}:${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
      return parsed.data;
    });
}

export interface Interval {
  readonly k: number;
  readonly n: number;
  readonly p: number;
  readonly lo: number;
  readonly hi: number;
}

const Z95 = 1.959963984540054;

/** Wilson score interval for k successes in n trials (95% by default). n = 0 gives the whole [0, 1]. */
export function wilson(k: number, n: number, z = Z95): Interval {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) throw new RangeError(`wilson: bad counts ${k}/${n}`);
  if (n === 0) return { k, n, p: Number.NaN, lo: 0, hi: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { k, n, p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** "41/52 = 78.8% (95% CI 65.9–87.8%)". */
export function formatInterval(i: Interval): string {
  if (i.n === 0) return "0/0 (no cases)";
  return `${i.k}/${i.n} = ${pct(i.p)} (95% CI ${pct(i.lo)}–${pct(i.hi)})`;
}

export function line(label: string, i: Interval): string {
  return `  ${label.padEnd(34)} ${formatInterval(i)}`;
}

/** Counts the rows where `ok` holds. */
export function tally<T>(rows: readonly T[], ok: (r: T) => boolean): Interval {
  return wilson(rows.filter(ok).length, rows.length);
}

/** True when the module at `url` is the script node was started with (so tests can import it without running it). */
export function isMain(url: string): boolean {
  return Boolean(process.argv[1]) && fileURLToPath(url) === path.resolve(process.argv[1]!);
}

/** One-line JSON for a miss listing, with stable key order. */
export const show = (v: unknown): string => JSON.stringify(v);
