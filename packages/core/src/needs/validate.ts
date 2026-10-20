/**
 * The VISION-DECISIONS §3 `needs.ts` limits, checked on every checklist before it is returned (a local mirror of
 * v-contract's strict zod schema; P1 can point `assertChecklist` at `NeedsChecklist.parse` once it lands). Also checks
 * what the schema cannot: unique item ids and items ordered by group.
 */
import { z } from "zod";
import { LineKey } from "../schemas/enums";
import { PlanRule } from "../schemas/plan";
import { Bps, CurrencyCode, Id, Minor } from "../schemas/primitives";
import { NeedsError } from "./errors";
import type { NeedsChecklist, NeedsGroup } from "./types";

/** VISION-DECISIONS §2 NEEDS_GROUPS order. */
export const NEEDS_GROUP_ORDER = ["REGISTRATION", "BUDGET_LINE", "SUPPLIER", "ACCOUNT", "TAX_RESERVE"] as const satisfies readonly NeedsGroup[];

const NeedsItemLocal = z.strictObject({
  itemId: Id,
  group: z.enum(NEEDS_GROUP_ORDER),
  title: z.string().min(1).max(120),
  detail: z.string().min(1).max(300).nullable(),
  amountMinor: Minor.nullable(),
  lineKey: LineKey.nullable(),
  sourceRef: PlanRule.shape.sourceRef.nullable(),
  status: z.enum(["TODO", "IN_PLAN", "DONE"]),
});

const NeedsChecklistLocal = z.strictObject({
  draftId: Id,
  currency: CurrencyCode,
  totalMinor: Minor,
  reserveBps: Bps,
  items: z.array(NeedsItemLocal).min(1).max(40),
});

/** `c` unchanged if it meets every limit; NeedsError LIMITS otherwise (never trimmed or truncated to fit). */
export function assertChecklist(c: NeedsChecklist): NeedsChecklist {
  const parsed = NeedsChecklistLocal.safeParse(c);
  if (!parsed.success) throw new NeedsError("LIMITS", `checklist breaks the needs schema: ${parsed.error.message}`);
  const ids = new Set(c.items.map((i) => i.itemId));
  if (ids.size !== c.items.length) throw new NeedsError("LIMITS", "duplicate itemId");
  const order = c.items.map((i) => NEEDS_GROUP_ORDER.indexOf(i.group));
  if (order.some((g, k) => k > 0 && g < (order[k - 1] ?? 0))) throw new NeedsError("LIMITS", "items are not ordered by group");
  return c;
}
