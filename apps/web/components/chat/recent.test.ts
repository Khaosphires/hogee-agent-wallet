import { describe, expect, it } from "vitest";
import { uuidv7 } from "../../lib/chat-session";
import type { TimedMessage } from "./chat-time";
import { pressesOf, recentThings } from "./recent";

const T = Date.UTC(2026, 9, 19, 6, 2);
const MIN = 60_000;

const press = (id: string, action: Record<string, unknown>): TimedMessage => ({ id, role: "user", parts: [{ type: "text" }, { type: "data-action", data: { action } }] });

describe("pressesOf", () => {
  it("lists the presses that leave a line, with the time their id carries", () => {
    const messages: TimedMessage[] = [
      { id: "u0", role: "user", parts: [{ type: "text" }] },
      press("u1", { type: "signed", kind: "PlanApproval", refId: "draft-1", actionId: uuidv7(T) }),
      press("u2", { type: "show_candidates", searchId: "s1", actionId: uuidv7(T + MIN) }), // leaves no line
      press("u3", { type: "start_search", quantity: 1000, actionId: uuidv7(T + 2 * MIN) }),
      press("u4", { type: "start_terms", supplierId: "x", actionId: "not-a-v7" }), // no time: left out
    ];
    expect(pressesOf(messages)).toEqual([
      { key: expect.stringMatching(/^press:/), kind: "signed", at: T, text: "You signed your plan" },
      { key: expect.stringMatching(/^press:/), kind: "press", at: T + 2 * MIN, text: "You asked Hogee to find suppliers" },
    ]);
  });
});

describe("pressesOf and Next buttons", () => {
  it("leaves out a press of a server-minted Next button unless this page saw it pressed", () => {
    const old = uuidv7(T - 7 * 86_400_000);
    const messages: TimedMessage[] = [
      { id: "a1", role: "assistant", parts: [{ type: "data-next", data: { actions: [{ label: "Find suppliers", action: { type: "start_search", actionId: old } }] } }] },
      press("u2", { type: "start_search", actionId: old }),
    ];
    expect(pressesOf(messages)).toEqual([]);
    expect(pressesOf(messages, new Map([[old, T]])).map((p) => p.at)).toEqual([T]);
  });
});

describe("recentThings", () => {
  it("merges presses and sales, newest first, and keeps three", () => {
    const presses = [
      { key: "p1", kind: "signed" as const, at: T, text: "You signed your plan" },
      { key: "p2", kind: "press" as const, at: T + 10 * MIN, text: "You saved the deal" },
    ];
    const sales = [
      { saleId: "s1", amountMinor: "4200", at: new Date(T + 5 * MIN).toISOString() },
      { saleId: "s2", amountMinor: "3900", at: new Date(T + 20 * MIN).toISOString() },
      { saleId: "bad", amountMinor: "1", at: "yesterday" },
    ];
    expect(recentThings(presses, sales).map((r) => r.key)).toEqual(["sale:s2", "p2", "sale:s1"]);
    expect(recentThings(presses, sales, 10).map((r) => r.key)).toEqual(["sale:s2", "p2", "sale:s1", "p1"]);
    expect(recentThings([], [])).toEqual([]);
  });
});
