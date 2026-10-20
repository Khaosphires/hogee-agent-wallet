/** TanStack Query bindings for apiCall. Live data polls every 1.5 s (project.md §26.6; no websockets). */
import { useMutation, useQuery, useQueryClient, type QueryClient, type UseQueryOptions } from "@tanstack/react-query";
import type { RouteName, RouteRes } from "@hogee/api-contract";
import { apiCall, type ApiClientError, type ApiReq } from "./client";

export const POLL_MS = 1_500;

export const apiKey = <N extends RouteName>(name: N, req?: ApiReq<N>) => [name, req ?? null] as const;

interface QueryOpts<N extends RouteName> {
  /** Poll every 1.5 s (default true). */
  readonly poll?: boolean;
  readonly enabled?: boolean;
  readonly refetchInterval?: UseQueryOptions<RouteRes<N>, ApiClientError>["refetchInterval"];
}

export function useApiQuery<N extends RouteName>(name: N, req?: ApiReq<N>, opts: QueryOpts<N> = {}) {
  return useQuery<RouteRes<N>, ApiClientError>({
    queryKey: apiKey(name, req),
    queryFn: ({ signal }) => apiCall(name, req, { signal }),
    refetchInterval: opts.refetchInterval ?? (opts.poll === false ? false : POLL_MS),
    enabled: opts.enabled,
  });
}

/**
 * After an action that changes money (a signature, fund, release, pause, …): every active query refetches at once (the
 * server is the source of truth), so balances (5 s) and the CFO report (15 s) never make the founder wait for a poll.
 */
export const refreshAfterAction = (queryClient: QueryClient): Promise<void> => queryClient.invalidateQueries();

/** A mutation; on success every query refetches (refreshAfterAction). */
export function useApiMutation<N extends RouteName>(name: N) {
  const queryClient = useQueryClient();
  return useMutation<RouteRes<N>, ApiClientError, ApiReq<N>>({
    mutationFn: (req) => apiCall(name, req),
    onSuccess: () => refreshAfterAction(queryClient),
  });
}
