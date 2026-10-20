/**
 * The wallet inspector's "Recently" (ux2-chat): the last few things that happened, from data the chat page already
 * has, with no new request: the founder's presses in this thread (timed by chat-time pressTime; journey-client
 * actionEventText words them) and the recent sales in the CFO report the rail already reads. Pure.
 */
import type { ChatAction } from "@hogee/core";
import { actionEventText } from "../../lib/journey-client";
import { pressTime, serverMintedIds, type TimedMessage } from "./chat-time";

export type RecentKind = "signed" | "press" | "sale";

export interface RecentThing {
  readonly key: string;
  readonly kind: RecentKind;
  /** unix ms */
  readonly at: number;
  /** "You signed your plan"; a sale's line is drawn from `amountMinor`. */
  readonly text: string;
  readonly amountMinor?: string;
}

export interface RecentSale {
  readonly saleId: string;
  readonly amountMinor: string;
  /** ISO date-time */
  readonly at: string;
}

const actionOfMessage = (m: TimedMessage): ChatAction | null => {
  if (m.role !== "user") return null;
  for (const p of m.parts) if (p.type === "data-action") return ((p.data as { action?: ChatAction } | undefined)?.action ?? null) as ChatAction | null;
  return null;
};

/**
 * The founder's presses in the thread that leave a line, with their time (chat-time pressTime: when this page saw the
 * press, else the id's own time when the browser minted it at the press; a Next button's server-minted id gives none).
 */
export function pressesOf(messages: readonly TimedMessage[], pressedAt: ReadonlyMap<string, number> = new Map()): RecentThing[] {
  const minted = serverMintedIds(messages);
  const out: RecentThing[] = [];
  for (const m of messages) {
    const action = actionOfMessage(m);
    if (!action) continue;
    const text = actionEventText(action);
    const at = pressTime(action.actionId, pressedAt, minted);
    if (!text || at === null) continue;
    out.push({ key: `press:${action.actionId}`, kind: action.type === "signed" ? "signed" : "press", at, text });
  }
  return out;
}

/** The newest `limit` things, newest first: presses and sales together (a sale with a bad time is left out). */
export function recentThings(presses: readonly RecentThing[], sales: readonly RecentSale[], limit = 3): RecentThing[] {
  const fromSales: RecentThing[] = sales.flatMap((s) => {
    const at = Date.parse(s.at);
    return Number.isFinite(at) ? [{ key: `sale:${s.saleId}`, kind: "sale" as const, at, text: "Sale", amountMinor: s.amountMinor }] : [];
  });
  return [...presses, ...fromSales].sort((a, b) => b.at - a.at).slice(0, limit);
}
