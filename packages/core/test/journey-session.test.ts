/**
 * Chat session bounds (audit run-9 lead 2, chat-session-history-unbounded): a session holds at most
 * CHAT_SESSION_MAX_MESSAGES messages and a full one answers a templated "start a new conversation" reply; reads see a
 * window of the newest messages, while the journey's facts read only the HISTORY_PART_TYPES parts of the WHOLE session
 * (readHistory over that projection equals readHistory over every message); the session's own saved terms, newest first.
 */
import { describe, expect, it } from "vitest";
import {
  CHAT_HISTORY_WINDOW,
  CHAT_SESSION_MAX_MESSAGES,
  HISTORY_PART_TYPES,
  TEXT,
  readHistory,
  sessionFull,
  sessionFullReply,
  termsIdsNewestFirst,
  type HistoryMessage,
} from "../src/journey/index";

const W1 = "supplier-wqk3vt7ma2xrb";
const W2 = "supplier-wabcdefgh2345";
const a = (n: number) => `01a14202-2800-7000-8000-${String(n).padStart(12, "0")}`;
const user = (action: object): HistoryMessage => ({ role: "user", parts: [{ type: "text", text: "x" }, { type: "data-action", data: { action } }] });
const assistant = (...parts: object[]): HistoryMessage => ({ role: "assistant", parts: [{ type: "text", text: "y" }, ...parts] });
const sign = (termsId: string) => ({ type: "data-sign", data: { kind: "SupplierApproval", refId: termsId, title: "t", summary: "s", cta: "c" } });
const enquiry = { type: "data-enquiry", data: { supplierIds: [W1], subject: "s", body: "b" } };
const prefill = (supplierId: string) => ({ type: "data-terms", data: { supplierId, searchId: "search-1", milestones: null, preset: null, source: "none", question: null, presetAvailability: [] } });
const needs = { type: "data-needs", data: { draftId: "draft-1", currency: "SGD", totalMinor: "100", reserveBps: 500, items: [] } };

/** What the live store's projection query returns: every message, keeping only the parts readHistory reads. */
const project = (messages: readonly HistoryMessage[]): HistoryMessage[] =>
  messages.map((m) => ({ role: m.role, parts: m.parts.filter((p) => HISTORY_PART_TYPES.includes((p as { type?: string }).type as never)) }));

describe("session bounds", () => {
  it("a session takes a turn only while its messages fit under the cap", () => {
    expect(CHAT_SESSION_MAX_MESSAGES).toBe(600);
    expect(CHAT_HISTORY_WINDOW).toBeLessThan(CHAT_SESSION_MAX_MESSAGES);
    expect(sessionFull(0, 2)).toBe(false);
    expect(sessionFull(CHAT_SESSION_MAX_MESSAGES - 2, 2)).toBe(false);
    expect(sessionFull(CHAT_SESSION_MAX_MESSAGES - 1, 2)).toBe(true);
    expect(sessionFull(CHAT_SESSION_MAX_MESSAGES, 1)).toBe(true);
  });

  it("a full session answers with one templated sentence: no card, no button, no signature", () => {
    const r = sessionFullReply();
    expect(r.parts).toEqual([{ type: "text", text: TEXT.sessionFull }]);
    expect(TEXT.sessionFull).toMatch(/Clear this chat/);
    expect(r.summary).toMatch(/full/);
  });
});

describe("the journey's projection of a session", () => {
  const session: HistoryMessage[] = [
    assistant({ type: "data-plan-draft", data: { draftId: "draft-1" } }, needs),
    assistant({ type: "data-next", data: { actions: [{ label: "Find suppliers", action: { type: "start_search", actionId: a(1) } }] } }),
    user({ type: "start_search", actionId: a(1) }),
    assistant({ type: "data-search", data: { searchId: "search-1" } }),
    user({ type: "pick", actionId: a(2), searchId: "search-1", supplierIds: [W1] }),
    assistant(), // refused: no enquiry
    user({ type: "pick", actionId: a(3), searchId: "search-1", supplierIds: [W1, W2] }),
    assistant(enquiry, { type: "data-next", data: { actions: [{ label: "I've agreed terms", action: { type: "start_terms", actionId: a(4), supplierId: W1 } }] } }),
    user({ type: "start_terms", actionId: a(4), supplierId: W1 }),
    assistant(prefill(W1)),
    user({ type: "terms_saved", actionId: a(5), termsId: "terms-1" }),
    assistant(sign("terms-1")),
    user({ type: "terms_saved", actionId: a(6), termsId: "terms-forged" }),
    assistant(),
    assistant(prefill(W2)),
    user({ type: "show_cfo", actionId: a(7), view: "overview" }),
  ];

  it("readHistory over the projection equals readHistory over every message", () => {
    const full = readHistory(session);
    const projected = readHistory(project(session));
    const { buttonLabel: fullLabel, ...fullFacts } = full;
    const { buttonLabel: projectedLabel, ...projectedFacts } = projected;
    expect(projectedFacts).toEqual(fullFacts);
    for (let n = 1; n <= 8; n += 1) expect(projectedLabel(a(n))).toBe(fullLabel(a(n)));
    expect(full.lastPick).toEqual({ searchId: "search-1", supplierIds: [W1, W2] });
    expect(full.savedTermsIds).toEqual(["terms-1"]);
    expect(full.openTermsSupplierId).toBe(W2);
    expect(full.latestDraftId).toBe("draft-1");
  });

  it("a flood of refused presses stays linear: every reply is looked up once", () => {
    const flood: HistoryMessage[] = [];
    for (let n = 0; n < CHAT_SESSION_MAX_MESSAGES / 2; n += 1) flood.push(user({ type: "pick", actionId: a(100 + n), searchId: "search-1", supplierIds: [W1] }), assistant());
    const h = readHistory(flood);
    expect(h.lastPick).toBeNull();
    expect(h.usedActionIds.size).toBe(CHAT_SESSION_MAX_MESSAGES / 2);
  });
});

describe("termsIdsNewestFirst", () => {
  const saved = (...ids: string[]) =>
    readHistory(ids.flatMap((termsId, n) => [user({ type: "terms_saved", actionId: a(200 + n), termsId }), assistant(sign(termsId))]));

  it("the session's own saved terms, the latest save first, each once", () => {
    expect(termsIdsNewestFirst(saved())).toEqual([]);
    expect(termsIdsNewestFirst(saved("terms-1", "terms-2"))).toEqual(["terms-2", "terms-1"]);
    expect(termsIdsNewestFirst(saved("terms-1", "terms-2", "terms-1"))).toEqual(["terms-1", "terms-2"]);
  });

  it("the press being answered now counts first; an unconfirmed earlier one never does", () => {
    const h = readHistory([
      user({ type: "terms_saved", actionId: a(1), termsId: "terms-forged" }),
      assistant(),
      user({ type: "terms_saved", actionId: a(2), termsId: "terms-1" }),
      assistant(sign("terms-1")),
      user({ type: "terms_saved", actionId: a(3), termsId: "terms-2" }),
    ]);
    expect(termsIdsNewestFirst(h)).toEqual(["terms-2", "terms-1"]);
  });
});
