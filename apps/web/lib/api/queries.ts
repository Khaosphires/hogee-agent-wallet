/**
 * Named queries the pages share (all through apiCall + route.res). Live data polls every 1.5 s; the money reads at their
 * own pace (query-policy.ts): balances 5 s, autonomy and the CFO report 15 s, none in a hidden tab.
 */
import { useQuery } from "@tanstack/react-query";
import { POLL_MS, useApiMutation, useApiQuery } from "./hooks";
import { autonomyQuery, balancesQuery, cfoReportQuery } from "./query-policy";
import { useSession } from "./use-session";

export const useBalances = () => useQuery(balancesQuery());
export const useCurrentPlan = () => useApiQuery("getCurrentPlan");
export const usePlanVersions = () => useApiQuery("listPlanVersions", undefined, { poll: false });
export const usePayments = () => useApiQuery("listPayments", { query: {} });
export const useTraces = (limit = "200") => useApiQuery("listTraces", { query: { limit } });
export const useExceptions = () => useApiQuery("listExceptions", { query: {} });
export const useAutonomy = () => useQuery(autonomyQuery());

// ---- chat-first (VISION-DECISIONS §5) ----------------------------------------------------------------
/** Starts a web supplier search from the committed plan (the body carries only a quantity). */
export const useStartSupplierSearch = () => useApiMutation("startSupplierSearch");
/** A web supplier search; polls every 1.5 s until it is READY or FAILED, then stops. */
export const useSupplierSearch = (searchId: string | undefined) =>
  useApiQuery("getSupplierSearch", searchId ? { params: { id: searchId } } : undefined, {
    enabled: Boolean(searchId),
    refetchInterval: (query) => (query.state.data && query.state.data.status !== "PENDING" ? false : POLL_MS),
  });
/** Confirms supplier terms and the payout account (the only way an account reaches the server). */
export const useSubmitOrderTerms = () => useApiMutation("submitOrderTerms");
/** Confirmed supplier terms and their schedule (polls: release state mirrors the chain). */
export const useOrderTerms = (termsId: string | undefined) =>
  useApiQuery("getOrderTerms", termsId ? { params: { id: termsId } } : undefined, { enabled: Boolean(termsId) });
/**
 * The AI CFO report: ONE query for every consumer (wallet rail, CFO card, CFO page, wallet tiles), every 15 s, never
 * while the tab is hidden, and never before a 429's Retry-After (query-policy.ts).
 */
export const useCfoReport = () => useQuery(cfoReportQuery());

/** The facility's display currency (for "BU (facility: MYR)"), from the current plan. */
export function useDisplayCurrency(): string | undefined {
  return useCurrentPlan().data?.manifest.displayCurrency;
}

/**
 * True when values taken from an evidence bundle (its rows, anchor and deployments) may link to the explorer: live
 * and replay, never mock. A hash outside a bundle goes through TxHash (lib/explorer.ts txLinkOf), which never links
 * one in replay: the offline demo mints those hashes itself.
 */
export function useLinksToExplorer(): boolean {
  const mode = useSession().data?.mode;
  return mode === "live" || mode === "replay";
}
