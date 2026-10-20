"use client";

/**
 * Mei's receipts as one hook, read by Receipts and by Activity on the Wallet page. Both call the same queries (the same
 * keys), so React Query serves them from one cache: no request is added by reading them twice.
 *
 * Supplier payments follow the order's schedule (the order card's source); the supplier's name comes from structured
 * data (GET /api/suppliers/:id, wording-checked again here), never from a chat text part (lib/receipts.ts).
 */
import { useQueries } from "@tanstack/react-query";
import { cardSafeName } from "@hogee/core";
import { apiCall } from "@/lib/api/client";
import { apiKey } from "@/lib/api/hooks";
import { queryView, type QueryView } from "@/lib/api/query-policy";
import { usePayments } from "@/lib/api/queries";
import { receiptsOf, supplierPayees, type Receipt, type SupplierOrderIn } from "@/lib/receipts";

/** The schedule moves only when a payment lands; the payments list polls already, so this need not race it. */
const ESCROW_POLL_MS = 5_000;
/** A web-derived name shown on a card is at most this long (as the candidates card). */
const NAME_MAX = 80;

/** Each supplier payee's latest order and its schedule; the supplier's checked display name. */
function useSupplierOrders(payees: readonly string[]) {
  const suppliers = useQueries({
    queries: payees.map((id) => ({
      queryKey: apiKey("getSupplier", { params: { id } }),
      queryFn: ({ signal }: { signal: AbortSignal }) => apiCall("getSupplier", { params: { id } }, { signal }),
      staleTime: 60_000,
    })),
  });
  const withOrder = suppliers.flatMap((q, i) => (q.data?.orderId ? [{ supplierId: payees[i] ?? "", orderId: q.data.orderId, name: q.data.displayName }] : []));
  const escrows = useQueries({
    queries: withOrder.map((o) => ({
      queryKey: apiKey("getEscrow", { params: { orderId: o.orderId } }),
      queryFn: ({ signal }: { signal: AbortSignal }) => apiCall("getEscrow", { params: { orderId: o.orderId } }, { signal }),
      refetchInterval: ESCROW_POLL_MS,
    })),
  });
  const orders: SupplierOrderIn[] = withOrder.flatMap((o, i) => {
    const schedule = escrows[i]?.data;
    return schedule ? [{ supplierId: o.supplierId, orderId: o.orderId, schedule }] : [];
  });
  const names: ReadonlyMap<string, string> = new Map(withOrder.map((o) => [o.supplierId, cardSafeName(o.name, NAME_MAX)]));
  return { orders, names };
}

export interface ReceiptsView {
  /** The payments list as a query view: a failed refresh keeps the last list (refreshFailed), the error only without one. */
  readonly view: QueryView<readonly Receipt[]>;
  readonly names: ReadonlyMap<string, string>;
}

/** Every receipt, newest first, with the supplier names they need. */
export function useReceipts(): ReceiptsView {
  const payments = queryView(usePayments());
  const all = payments.kind === "data" ? payments.data : [];
  const { orders, names } = useSupplierOrders(supplierPayees(all));
  const view: QueryView<readonly Receipt[]> = payments.kind === "data" ? { kind: "data", data: receiptsOf(all, orders), refreshFailed: payments.refreshFailed } : payments;
  return { view, names };
}
