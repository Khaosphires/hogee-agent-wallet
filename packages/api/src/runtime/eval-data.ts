/**
 * Eval datasets for /api/eval/* (P3's files, project.md §26.8), read like the rest of the catalog: contained regular
 * files under their data root (files.ts readContained), validated with the frozen zod schemas, malformed rows skipped
 * and logged (by line number, never by content), nothing trusted.
 *
 *   evals/datasets/e2/prompts.jsonl         E2PromptRow per line (frozen)
 *   evals/datasets/e2/hidden-answers.jsonl  {promptId, slot, answer} per line: the TRUE value of a vague prompt's
 *                                           hiddenSlot, as the founder would type it ("citizen", "RM 8,000"). The
 *                                           frozen E2PromptRow names the slot but not its value, so the auto-answer
 *                                           (LABELING.md §2.4) needs this file (task 1.13 decision; P3 writes it).
 *   data/suppliers/eval/set-XX/listings/*.json + raw text at listing.rawTextRef, and an optional
 *   data/suppliers/eval/set-XX/spec.json (ShortlistSpec) for the set's buyer need.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { E2PromptRow, Id, IntentSlot, ShortlistSpec } from "@hogee/core";
import { z } from "zod";
import type { ApiLogger, E2PromptCase, SupplierEvalSet } from "../context";
import { MAX_DATASET_FILE_BYTES, cachedLoad, completeFixtures, loadSupplierDir, readContained, readContainedJson, type DataRoots } from "./files";

const SET_ID = /^set-[0-9]{2}$/;

export const HiddenAnswerRow = z.strictObject({ promptId: Id, slot: IntentSlot, answer: z.string().trim().min(1).max(500) });
type HiddenAnswerRow = z.infer<typeof HiddenAnswerRow>;

/**
 * Valid rows of a JSONL file under `root` keyed by promptId (first row wins), read contained (readContained, ≤ 2 MB);
 * `read` is false when the file is absent or refused.
 */
async function jsonlRows<T extends { promptId: string }>(root: string, path: string, schema: z.ZodType<T>, event: string, log: ApiLogger): Promise<{ rows: Map<string, T>; read: boolean }> {
  const out = new Map<string, T>();
  if (!existsSync(path)) return { rows: out, read: false };
  const text = await readContained(root, path, MAX_DATASET_FILE_BYTES, log);
  if (text === null) return { rows: out, read: false };
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      raw = undefined;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return log.warn(`${event}_line_invalid`, { line: i + 1 });
    if (out.has(parsed.data.promptId)) return log.warn(`${event}_line_duplicate`, { line: i + 1 });
    out.set(parsed.data.promptId, parsed.data);
  });
  return { rows: out, read: true };
}

export function e2PromptLoader(repo: string | undefined, log: ApiLogger): (promptId: string) => Promise<E2PromptCase | null> {
  const load = async (): Promise<{ prompts: Map<string, E2PromptRow>; answers: Map<string, HiddenAnswerRow>; complete: boolean }> => {
    if (!repo) return { prompts: new Map(), answers: new Map(), complete: false };
    const dir = join(repo, "evals", "datasets", "e2");
    const [prompts, answers] = await Promise.all([
      jsonlRows(dir, join(dir, "prompts.jsonl"), E2PromptRow, "e2_prompt", log),
      jsonlRows(dir, join(dir, "hidden-answers.jsonl"), HiddenAnswerRow, "e2_hidden_answer", log),
    ]);
    return { prompts: prompts.rows, answers: answers.rows, complete: prompts.read && answers.read };
  };
  // Cached only once both files were read: an absent or refused file is looked for again on the next request.
  const loaded = cachedLoad(load, ({ complete }) => complete);
  return async (promptId) => {
    const { prompts, answers } = await loaded(undefined);
    const row = prompts.get(promptId);
    if (!row) return null;
    const answer = answers.get(promptId);
    return { row, hiddenAnswer: row.hiddenSlot !== undefined && answer?.slot === row.hiddenSlot ? answer.answer : null };
  };
}

export function supplierSetLoader(dataDir: string | undefined, roots: DataRoots | undefined, log: ApiLogger): (setId: string) => Promise<SupplierEvalSet | null> {
  const load = async (setId: string): Promise<SupplierEvalSet | null> => {
    if (!dataDir || !roots || !SET_ID.test(setId)) return null;
    const dir = join(dataDir, "suppliers", "eval", setId);
    if (!existsSync(join(dir, "listings"))) return null;
    const listings = await loadSupplierDir(join(dir, "listings"), roots, log);
    const specPath = join(dir, "spec.json");
    let spec: ShortlistSpec | null = null;
    if (existsSync(specPath)) {
      const parsed = ShortlistSpec.safeParse(await readContainedJson(roots.suppliers, specPath, log));
      if (parsed.success) spec = parsed.data;
      else log.error("supplier_set_spec_invalid", { setId });
    }
    return { setId, listings, spec };
  };
  return cachedLoad(load, (set) => set !== null && completeFixtures(set.listings));
}
