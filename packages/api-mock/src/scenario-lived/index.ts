/**
 * The sample business (MOCK_SCENARIO=lived, the demo-data switch's ON; docs/decisions/ux2-demo-data.md): Mei about
 * three weeks in, mock mode only. store.ts getState hands out a fresh store marked lived; readyState fills it once
 * (build.ts plays story.ts through the mock's transitions) before any request is served, and every request waits for it.
 * A build that fails rejects every request (fail closed): the store is never served half built.
 *
 * Its chat: a session the store has not seen starts with a short history (store.ts seededChat): a welcome-back line
 * with the finished first order's card, then the second order's messages exactly as the journey sends them (the
 * founder's "Deal saved" press, the reply with the SupplierApproval card, her "Signed" press, the reply with the order
 * card). From there typed text and presses run the journey (journey/index.ts), whose Next step is that order's
 * delivery check.
 */
import {
  ChatMessage,
  actionLabel,
  actionUserParts,
  replyToAction,
  textPart,
  type ChatAction,
  type JourneyEnv,
  type JourneyPart,
} from "@hogee/core";
import type { MockEnv } from "../env";
import { getState, markBuilt, nextId, uuidV7, type MockState } from "../store";
import { orderCard, playStory, type BuiltStory } from "./build";
import { WELCOME_BACK } from "./story";

const builds = new WeakMap<MockState, Promise<void>>();

const message = (st: MockState, role: "user" | "assistant", parts: readonly JourneyPart[]): ChatMessage =>
  ChatMessage.parse({ id: nextId(st, "msg"), role, parts: parts.map((p) => ({ ...p })) });

/**
 * The history a new session starts with (fresh ids each time; every message passes ChatMessage). Action ids are UUIDv7
 * minted at the moment of the press in the story (the web reads a press's time from its id), so the thread and the
 * wallet rail date them "7 days ago", not "just now".
 */
export function sampleTranscript(st: MockState, story: Pick<BuiltStory, "orders" | "latest">): ChatMessage[] {
  const { termsId, saved, signed, savedAtMs, signedAtMs } = story.latest;
  const at = (ms: number): JourneyEnv => ({ newActionId: () => uuidV7(st, ms) });
  const save: ChatAction = { type: "terms_saved", actionId: at(savedAtMs).newActionId(), termsId };
  const sign: ChatAction = { type: "signed", actionId: at(signedAtMs).newActionId(), kind: "SupplierApproval", refId: termsId };
  return [
    message(st, "assistant", [textPart(WELCOME_BACK), orderCard(story.orders.first.termsId)]),
    message(st, "user", actionUserParts(save, actionLabel(save))),
    message(st, "assistant", replyToAction(save, saved, {}, at(savedAtMs)).parts),
    message(st, "user", actionUserParts(sign, actionLabel(sign))),
    message(st, "assistant", replyToAction(sign, signed, {}, at(signedAtMs)).parts),
  ];
}

/** Fills a fresh lived store with the sample business, dated relative to `builtAtMs`. */
export async function buildSampleBusiness(st: MockState, env: MockEnv, builtAtMs = Date.now()): Promise<void> {
  const story = await playStory(st, env, builtAtMs);
  st.sample = {
    builtAtMs,
    commitAtMs: story.commitAtMs,
    sales: story.sales.map((s) => ({ saleId: s.saleId as never, amountMinor: s.amountMinor, at: new Date(s.atMs), txHash: null })),
    revenueMinor: story.sales.reduce((sum, s) => sum + s.amountMinor, 0n),
    transcript: (store) => sampleTranscript(store, story),
    seededChats: 0,
  };
  markBuilt(st);
}

/**
 * The store for this env, ready to serve: in the lived scenario it waits for the sample business to be built (once per
 * store). Every route goes through it (http.ts).
 */
export async function readyState(env: MockEnv): Promise<MockState> {
  const st = getState(env);
  if (st.scenario !== "lived") return st;
  let build = builds.get(st);
  if (!build) {
    build = buildSampleBusiness(st, env);
    builds.set(st, build);
  }
  await build;
  return st;
}
