/**
 * The founder's needs checklist (VISION-DECISIONS §3 `needs.ts`, §2 NEEDS_GROUPS / NEEDS_STATUSES).
 *
 * Plain TS types matching the v-contract zod schemas field for field, kept here until `schemas/needs.ts` lands. P1 then
 * replaces this file's body with one line:
 *   export type { NeedsChecklist, NeedsGroup, NeedsItem, NeedsStatus } from "../schemas/index";
 * Nothing else in this folder needs to change. The folder's index exports no type, so the barrel never sees two
 * declarations of the same name.
 */
import type { LineKey } from "../schemas/enums";
import type { Bps, CurrencyCode, Id, Minor } from "../schemas/primitives";

/** VISION-DECISIONS §2 NEEDS_GROUPS, in this order. */
export type NeedsGroup = "REGISTRATION" | "BUDGET_LINE" | "SUPPLIER" | "ACCOUNT" | "TAX_RESERVE";
/** VISION-DECISIONS §2 NEEDS_STATUSES. */
export type NeedsStatus = "TODO" | "IN_PLAN" | "DONE";

export interface NeedsItem {
  itemId: Id;
  group: NeedsGroup;
  /** ≤ 120 characters. */
  title: string;
  /** ≤ 300 characters; null when the pack lacks the fact the detail would state. */
  detail: string | null;
  amountMinor: Minor | null;
  lineKey: LineKey | null;
  /** PlanRule.sourceRef grammar: a JSON Pointer into the country pack, `compiler:<id>` or `constitution:<CODE>`. */
  sourceRef: string | null;
  status: NeedsStatus;
}

export interface NeedsChecklist {
  draftId: Id;
  currency: CurrencyCode;
  totalMinor: Minor;
  reserveBps: Bps;
  /** 1..40 items, ordered by group (NEEDS_GROUPS order), then by a fixed key order within the group. */
  items: NeedsItem[];
}

export interface NeedsOptions {
  /** The facility's reserve floor in bps (integer 0..10000), the same value the compiler saw. */
  readonly reserveFloorBps: number;
}
