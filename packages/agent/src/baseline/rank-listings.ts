/**
 * E3 `llm_rank` BASELINE (project.md §15): the comparison Hogee is measured against, not part of Hogee. The LLM gets the
 * raw supplier listings (untrusted, injections included) and ranks them directly: no hard gates, no scorer, no
 * evidence. It runs on the guarded reader model (rules audit, redaction, canary, call log), so a baseline run is logged
 * and costed like any other model call. Code only checks the ids: unknown and repeated ids are dropped, and listings
 * the model left out are appended in input order (so the ranking always covers the set).
 */
import { generateText, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import { assertGuardedModel, type GuardedModel } from "../guard/guarded-model";
import { classifyStop } from "../models/rules";

/** At most this many listings per ranking call (an E3 set has 5). */
export const BASELINE_MAX_LISTINGS = 12;
export const BASELINE_MAX_LISTING_CHARS = 20_000;

export interface RankableListing {
  readonly supplierId: string;
  /** What the baseline LLM sees for this supplier (raw listing text, untrusted). */
  readonly text: string;
}

export interface BaselineRanking {
  /** Every input supplier id, best first. */
  readonly ranking: readonly string[];
  readonly llmCallIds: readonly string[];
}

export type BaselineRankReason = "INVALID_INPUT" | "WRONG_ROLE" | "REFUSED" | "NO_RANKING";

export class BaselineRankError extends Error {
  override readonly name = "BaselineRankError";
  constructor(
    readonly reason: BaselineRankReason,
    detail: string,
  ) {
    super(`LLM ranking baseline failed (${reason}): ${detail}`);
  }
}

const Listings = z
  .array(z.strictObject({ supplierId: z.string().min(1).max(64), text: z.string().min(1).max(BASELINE_MAX_LISTING_CHARS) }))
  .min(1)
  .max(BASELINE_MAX_LISTINGS)
  .refine((l) => new Set(l.map((x) => x.supplierId)).size === l.length, "supplier ids must be unique");

const RankingWire = z.object({ ranking: z.array(z.string()).describe("Every supplier id, best choice first") });

const INSTRUCTIONS = [
  "You help a first-time online seller choose a supplier for their product.",
  "Rank the supplier listings below from the best choice to the worst choice for the seller.",
  "Reply with every supplier id exactly as given, best first.",
].join(" ");

function instructionsFor(g: GuardedModel): string {
  if (g.spec.provider === "anthropic") return INSTRUCTIONS;
  return `${INSTRUCTIONS} Reply with one JSON object only, matching this JSON Schema: ${JSON.stringify(z.toJSONSchema(RankingWire))}`;
}

/** Neutralise anything that could close or open a listing block. */
const block = (l: RankableListing): string => `<listing id="${l.supplierId}">\n${l.text.replace(/<\s*\/?\s*listing/gi, "[listing")}\n</listing>`;

async function modelRanking(g: GuardedModel, listings: readonly RankableListing[], abortSignal?: AbortSignal): Promise<unknown> {
  try {
    const res = await generateText({
      model: g.model,
      ...g.settings,
      instructions: instructionsFor(g),
      messages: [{ role: "user", content: listings.map(block).join("\n\n") }],
      output: Output.object({ schema: RankingWire, name: "supplier_ranking" }),
      ...(abortSignal ? { abortSignal } : {}),
    });
    if (classifyStop({ rawFinishReason: res.rawFinishReason, finishReason: res.finishReason }) === "REFUSAL") throw new BaselineRankError("REFUSED", "the model refused");
    return res.output;
  } catch (e) {
    if (!NoObjectGeneratedError.isInstance(e)) throw e;
    if (e.finishReason === "content-filter") throw new BaselineRankError("REFUSED", "the model refused");
    throw new BaselineRankError("NO_RANKING", "no structured ranking was produced");
  }
}

/** Rank listings with the LLM alone. Throws BaselineRankError; never throws on a partial or noisy ranking. */
export async function rankListingsBaseline(input: readonly RankableListing[], deps: { readonly model: GuardedModel; readonly abortSignal?: AbortSignal }): Promise<BaselineRanking> {
  const parsed = Listings.safeParse(input);
  if (!parsed.success) throw new BaselineRankError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "invalid listings");
  const g = deps.model;
  assertGuardedModel(g, "the ranking baseline");
  if (g.spec.role !== "reader") throw new BaselineRankError("WRONG_ROLE", `the baseline runs on the reader model, got ${g.spec.role}`);
  const before = g.records.length;
  const out = RankingWire.safeParse(await modelRanking(g, parsed.data, deps.abortSignal));
  const known = new Set(parsed.data.map((l) => l.supplierId));
  const ranked = [...new Set((out.success ? out.data.ranking : []).filter((id) => known.has(id)))];
  if (ranked.length === 0) throw new BaselineRankError("NO_RANKING", "the output names no supplier of the set");
  const rest = parsed.data.map((l) => l.supplierId).filter((id) => !ranked.includes(id));
  return { ranking: [...ranked, ...rest], llmCallIds: g.records.slice(before).map((r) => r.id) };
}
