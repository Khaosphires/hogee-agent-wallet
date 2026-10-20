"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { NextStepAction } from "@/lib/next-step";

/**
 * What a card may know about the thread around it without new props (the CardProps contract is frozen):
 * which next-step buttons the founder pressed, which signatures she reported as sent, the one card waiting on her,
 * and, per assistant message, the plan drafts whose needs card already carries the "Approve and sign" button (so the
 * sign card doesn't repeat it).
 */
export interface JourneyThread {
  readonly chosenActionIds: ReadonlySet<string>;
  readonly signedKeys: ReadonlySet<string>;
  /** signKey of the one card waiting on the founder (lifted), or null. */
  readonly waitingKey: string | null;
  /** The newest web search the thread shows (journey-client threadFacts), for the message card's supplier links. */
  readonly latestSearchId: string | null;
  /** The suppliers of the newest message drafted after that search (the pick that took effect). */
  readonly pickedSupplierIds: readonly string[];
  /** The Next step bar's button, so a card's chip that would repeat it stays hidden (UX round 3 #4). */
  readonly barAction: NextStepAction | null;
}

const EMPTY: JourneyThread = { chosenActionIds: new Set(), signedKeys: new Set(), waitingKey: null, latestSearchId: null, pickedSupplierIds: [], barAction: null };
const ThreadContext = createContext<JourneyThread>(EMPTY);
const MessageContext = createContext<ReadonlySet<string>>(new Set());

export function JourneyThreadProvider({ value, children }: { readonly value: JourneyThread; readonly children: ReactNode }) {
  return <ThreadContext.Provider value={value}>{children}</ThreadContext.Provider>;
}

export const useJourneyThread = (): JourneyThread => useContext(ThreadContext);

/** Wraps one assistant message: the draft ids of its data-needs parts. */
export function MessageScope({ needsDraftIds, children }: { readonly needsDraftIds: ReadonlySet<string>; readonly children: ReactNode }) {
  return <MessageContext.Provider value={needsDraftIds}>{children}</MessageContext.Provider>;
}

export const useNeedsDraftIdsInMessage = (): ReadonlySet<string> => useContext(MessageContext);
