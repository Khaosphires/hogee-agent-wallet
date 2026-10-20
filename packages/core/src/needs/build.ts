/**
 * buildNeeds(draft, pack, {reserveFloorBps}) → the founder's needs checklist (VISION-DECISIONS §8 core-needs): what the
 * business needs, shown before the founder approves it by signing the plan.
 *
 * Pure and deterministic. Every item comes from the compiled draft (lines, rules, reserve) or from the pack the draft
 * was compiled with, which is checked by hash; the compliance items are re-derived with the compiler's own
 * deriveCompliance and must match a rule the draft carries. Anything else fails closed with NeedsError.
 */
import { deriveCompliance } from "../compiler/compliance";
import { CompileError } from "../compiler/errors";
import { hashObject } from "../hash/index";
import { CountryPack } from "../schemas/country-pack";
import { PlanDraft } from "../schemas/plan";
import { NeedsError } from "./errors";
import { accountItems, budgetLineItems, counterpartyItems, registrationItems, reserveRateBps, taxReserveItem, type NeedsContext } from "./items";
import type { NeedsChecklist, NeedsOptions } from "./types";
import { assertChecklist } from "./validate";

function floorOf(opts: unknown): number {
  const floor = typeof opts === "object" && opts !== null ? (opts as { reserveFloorBps?: unknown }).reserveFloorBps : undefined;
  if (typeof floor !== "number" || !Number.isInteger(floor) || floor < 0 || floor > 10_000) {
    throw new NeedsError("INVALID_INPUT", "reserveFloorBps must be an integer 0..10000");
  }
  return floor;
}

/** Parse the inputs and tie the pack to the draft: same country, same currency, same countryPackHash. */
function contextOf(rawDraft: unknown, rawPack: unknown, opts: unknown): NeedsContext {
  const draft = PlanDraft.safeParse(rawDraft);
  if (!draft.success) throw new NeedsError("INVALID_INPUT", `draft: ${draft.error.message}`);
  const pack = CountryPack.safeParse(rawPack);
  if (!pack.success) throw new NeedsError("INVALID_INPUT", `country pack: ${pack.error.message}`);
  const floorBps = floorOf(opts);
  const { manifest, intent } = draft.data;
  const p = pack.data;
  if (manifest.countryCode !== p.countryCode || intent.countryCode !== p.countryCode || manifest.displayCurrency !== p.currency) {
    throw new NeedsError("PACK_MISMATCH", `draft ${manifest.countryCode}/${manifest.displayCurrency}, pack ${p.countryCode}/${p.currency}`);
  }
  if (hashObject(p) !== manifest.countryPackHash) {
    throw new NeedsError("PACK_MISMATCH", `the pack is not the one the draft was compiled with (draft pack version ${manifest.countryPackVersion})`);
  }
  try {
    return { draft: draft.data, pack: p, profile: deriveCompliance(intent, p, floorBps), floorBps };
  } catch (e) {
    if (e instanceof CompileError) throw new NeedsError("DRAFT_MISMATCH", `the draft's intent does not derive from its pack: ${e.message}`);
    throw e;
  }
}

/** The needs checklist of a compiled draft (see module doc). Throws NeedsError. */
export function buildNeeds(draft: PlanDraft, pack: CountryPack, opts: NeedsOptions): NeedsChecklist {
  const ctx = contextOf(draft, pack, opts);
  const { manifest } = ctx.draft;
  return assertChecklist({
    draftId: ctx.draft.draftId,
    currency: manifest.displayCurrency,
    totalMinor: manifest.totalMinor,
    reserveBps: reserveRateBps(ctx),
    items: [...registrationItems(ctx), ...budgetLineItems(ctx), ...counterpartyItems(ctx), ...accountItems(ctx), taxReserveItem(ctx)],
  });
}
