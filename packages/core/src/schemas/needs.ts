/**
 * The needs checklist (VISION-DECISIONS §3, §8 core-needs): what the business needs before launch, built by core
 * buildNeeds from the compiled draft and the country pack. Every item cites its source (a pack pointer, a compiler rule
 * or a constitution rule) or carries null; nothing is invented.
 */
import { z } from "zod";
import { LineKey, NeedsGroup, NeedsStatus } from "./enums";
import { PlanRule } from "./plan";
import { Bps, CurrencyCode, Id, Minor } from "./primitives";

export const NeedsItem = z.strictObject({
  itemId: Id,
  group: NeedsGroup,
  title: z.string().min(1).max(120),
  detail: z.string().min(1).max(300).nullable(),
  amountMinor: Minor.nullable(),
  lineKey: LineKey.nullable(),
  // Same format as PlanRule.sourceRef: "/pack/pointer", "compiler:<id>" or "constitution:<CODE>".
  sourceRef: PlanRule.shape.sourceRef.nullable(),
  status: NeedsStatus,
});
export type NeedsItem = z.infer<typeof NeedsItem>;

export const NeedsChecklist = z
  .strictObject({
    draftId: Id,
    currency: CurrencyCode,
    totalMinor: Minor,
    reserveBps: Bps,
    items: z.array(NeedsItem).min(1).max(40),
  })
  .refine((n) => new Set(n.items.map((i) => i.itemId)).size === n.items.length, { message: "item ids are unique", path: ["items"] });
export type NeedsChecklist = z.infer<typeof NeedsChecklist>;
