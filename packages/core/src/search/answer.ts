/**
 * The provider answer as core's strict WebSearchAnswer. checks' parser (the one Tavily parser) and core's schema can
 * disagree on a single result (e.g. a host with "_", which a URL allows and core's Host does not): such a result is
 * dropped and counted with the off-list ones, so one odd listing never fails the whole search.
 */
import { WebSearchAnswer, WebSearchResult } from "../schemas/search";

/** The listing sites a web search reads; must equal @hogee/checks LISTING_DOMAINS (parity-tested in packages/api). */
export const WEB_LISTING_DOMAINS = ["alibaba.com", "made-in-china.com", "globalsources.com", "1688.com"] as const;

/** True for a host on (or under) a listing site: the UI's second check before it links a listing. */
export function isListingHost(host: string): boolean {
  return WEB_LISTING_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

export interface ProviderAnswer {
  readonly provider: string;
  readonly results: readonly unknown[];
  readonly droppedOffList: number;
  readonly retrievedAt: string;
  readonly bodySha256: string;
}

/** Strict answer: results core's schema refuses (or off the listing sites) are dropped and counted; the rest must parse. */
export function coreWebAnswer(a: ProviderAnswer): WebSearchAnswer {
  const kept = a.results.flatMap((r) => {
    const parsed = WebSearchResult.safeParse(r);
    return parsed.success && isListingHost(parsed.data.host) && new URL(parsed.data.url).hostname === parsed.data.host ? [parsed.data] : [];
  });
  return WebSearchAnswer.parse({ ...a, results: kept, droppedOffList: a.droppedOffList + (a.results.length - kept.length) });
}
