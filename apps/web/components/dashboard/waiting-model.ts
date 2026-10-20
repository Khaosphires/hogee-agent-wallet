/**
 * "Waiting for your signature" (UX round 3, Steve #2) as pure functions, so they are unit-tested: what each row says
 * and which rows show. A request is never shown by its stored title (free text from whoever filed it); its title is the
 * template for its kind (lib/exception-copy KIND_LABEL), plus the pocket's plain name when the request names one, and
 * one subtitle: its status (STATUS_LABEL) and how much is at risk. One request per kind shows (the latest, the API's
 * last); the others of that kind wait under "Earlier requests".
 */
import type { Exception } from "@hogee/core";
import { KIND_LABEL } from "../../lib/exception-copy";
import { lineLabel } from "../../lib/format";

/** "Raise a limit · Ads": the kind's template, and the pocket when the request is about one. */
export function requestTitle(e: Pick<Exception, "kind" | "payload">): string {
  const payload: unknown = e.payload;
  const lineKey = typeof payload === "object" && payload !== null && "lineKey" in payload && typeof payload.lineKey === "string" ? payload.lineKey : null;
  return lineKey ? `${KIND_LABEL[e.kind]} · ${lineLabel(lineKey)}` : KIND_LABEL[e.kind];
}

export interface WaitingGroups<E> {
  /** One per kind, the latest of each, in the order their kinds first appear. */
  readonly latest: readonly E[];
  /** The rest, oldest first. */
  readonly earlier: readonly E[];
}

/** Splits the waiting requests (oldest first, as the API lists them) into the latest per kind and the earlier ones. */
export function groupWaiting<E extends Pick<Exception, "kind" | "exceptionId">>(waiting: readonly E[]): WaitingGroups<E> {
  const lastOfKind = new Map<string, E>();
  for (const e of waiting) lastOfKind.set(e.kind, e);
  const latestIds = new Set([...lastOfKind.values()].map((e) => e.exceptionId));
  return { latest: [...lastOfKind.values()], earlier: waiting.filter((e) => !latestIds.has(e.exceptionId)) };
}

/** The banner's words: "1 request waits for your signature", "2 requests wait for your signature". */
export const waitingBanner = (n: number): string => (n === 1 ? "1 request waits for your signature" : `${n} requests wait for your signature`);
