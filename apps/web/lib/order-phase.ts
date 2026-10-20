/**
 * Where a supplier order stands, for the order card and the chat's Next step bar (one source for both). `phaseOf` reads
 * the order's terms only; the "Goods arrived" mark is a per-browser convenience (localStorage) and a UI gate only
 * (UX-PLAN G8): paying the balance still needs the delivery check's check code on the escrow milestone AND the
 * founder's MilestoneRelease signature. Nothing here calls the API.
 */
import { useSyncExternalStore } from "react";
import type { MilestoneTrigger, OrderTerms } from "@hogee/core";

export type Phase = "unsigned" | "binding" | "cooling" | "paying" | "waiting" | "done" | "replaced";

/** The order's phase from its terms: saved, signed (binding), safety wait, the automatic deposit, waiting, done. */
export function phaseOf(t: Pick<OrderTerms, "status" | "coolingEndsAt" | "schedule">, nowMs: number | null): Phase {
  if (t.status === "SUPERSEDED") return "replaced";
  if (t.status === "CONFIRMED") return "unsigned";
  if (!t.coolingEndsAt) return "binding";
  if (nowMs !== null && Date.parse(t.coolingEndsAt) > nowMs) return "cooling";
  const autoOpen = t.schedule.some((r) => r.autoRelease && !r.released);
  if (autoOpen) return "paying";
  return t.schedule.every((r) => r.released) ? "done" : "waiting";
}

// ---- the "Goods arrived" mark (browser only) ----------------------------------------------------------------------

const KEY_PREFIX = "hogee.goodsArrived.";
export const GOODS_ARRIVED_EVENT = "hogee:goods-arrived";

/** Marks pressed in this page, so a press still counts when storage is blocked (until a reload). */
const memory = new Set<string>();

/** True once the founder pressed Goods arrived for this order in this browser. Never throws. */
export function goodsArrived(orderId: string): boolean {
  if (memory.has(orderId)) return true;
  try {
    return globalThis.localStorage?.getItem(KEY_PREFIX + orderId) === "1";
  } catch {
    return false;
  }
}

/**
 * Marks the order's goods as arrived in this browser and tells every listener in this tab (storage events only reach
 * other tabs). It only opens the upload step: it pays nothing and sends nothing.
 */
export function setGoodsArrived(orderId: string): void {
  // Kept in memory too: with storage blocked (a private window) the mark lasts until the page reloads.
  memory.add(orderId);
  try {
    globalThis.localStorage?.setItem(KEY_PREFIX + orderId, "1");
  } catch {
    // Storage blocked: the memory mark above still counts.
  }
  try {
    globalThis.dispatchEvent?.(new Event(GOODS_ARRIVED_EVENT));
  } catch {
    // No window (server render): nothing listens.
  }
}

function subscribe(listener: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith(KEY_PREFIX)) listener();
  };
  globalThis.addEventListener?.(GOODS_ARRIVED_EVENT, listener);
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    globalThis.removeEventListener?.(GOODS_ARRIVED_EVENT, listener);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

/** The Goods arrived mark for an order, live across the order card and the Next step bar (false on the server). */
export function useGoodsArrived(orderId: string | null | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (orderId ? goodsArrived(orderId) : false),
    () => false,
  );
}

// ---- names of the payments ----------------------------------------------------------------------------------------

const ORDINAL = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth"] as const;

/**
 * The founder's name for payment `i` of a schedule (UX-PLAN D18): "Deposit" (an automatic first payment), "Balance"
 * (the last one), "Second payment" in between; a single payment is the "Full payment". Display only: the signed field
 * stays `idx`, and core MILESTONE_LABELS are never edited (D19).
 */
export function milestoneName(i: number, schedule: readonly { readonly autoRelease: boolean }[]): string {
  const n = schedule.length;
  if (n <= 1) return "Full payment";
  if (i === n - 1) return "Balance";
  if (i === 0 && schedule[0]?.autoRelease) return "Deposit";
  const ordinal = ORDINAL[i];
  return ordinal ? `${ordinal} payment` : `Payment ${i + 1}`;
}

/** "payment 1 of 2": 1-based everywhere (the release row included, D6). */
export const paymentCount = (i: number, n: number): string => `payment ${i + 1} of ${n}`;

// ---- the release step ---------------------------------------------------------------------------------------------

/** The event a milestone waits for, as the founder's gate button says it. */
export const GATE_LABEL: { readonly [T in MilestoneTrigger]: string } = {
  ON_ORDER: "Order placed",
  ON_SAMPLE_OK: "Sample approved",
  ON_SHIPMENT: "Goods shipped",
  ON_DELIVERY_INSPECTED: "Goods arrived",
};

export type BalanceStep = "in-transit" | "upload" | "pay-balance";

/**
 * Where a milestone waiting on the founder stands. A check code already on the milestone skips the gate (it was
 * uploaded, maybe in another browser); otherwise the Goods arrived mark opens the upload. Only `pay-balance` shows the
 * pay button, and that button still needs the check code and the founder's signature (canPayBalance).
 */
export function balanceStepOf(input: { readonly evidenceHash: string | null | undefined; readonly arrived: boolean }): BalanceStep {
  if (input.evidenceHash) return "pay-balance";
  return input.arrived ? "upload" : "in-transit";
}

/** The pay button is enabled only for an unpaid milestone whose delivery check is on record. The mark never counts. */
export const canPayBalance = (m: { readonly released: boolean; readonly evidenceHash?: string | null }): boolean => !m.released && Boolean(m.evidenceHash);
