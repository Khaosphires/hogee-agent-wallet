/**
 * POST /api/chat rate limits (G0 §9 "still open"): the sliding-window counter, its key bound, the three scopes and the
 * once-per-window refusal trace. Route behaviour (429, Retry-After, nothing stored) is in chat-guard.test.ts.
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { ChatRateLimiter, DEFAULT_ACTION_RATE, DEFAULT_CHAT_RATE, LOCAL_CLIENT, OncePer, RATE_WINDOW_MS, WindowCounter, clientAddress } from "../src/http/rate-limit";

describe("WindowCounter", () => {
  it("admits `limit` hits per sliding window and names the wait until the oldest hit leaves it", () => {
    const c = new WindowCounter(3, 1_000);
    for (const t of [0, 100, 200]) {
      expect(c.waitMs("k", t)).toBe(0);
      c.hit("k", t);
    }
    expect(c.waitMs("k", 300)).toBe(700); // the hit at 0 leaves the window at 1,000
    expect(c.waitMs("k", 999)).toBe(1);
    expect(c.waitMs("k", 1_000)).toBe(0); // rolled over: one slot is free again
    c.hit("k", 1_000);
    expect(c.waitMs("k", 1_000)).toBe(100); // 100, 200, 1,000 are live
  });

  it("keeps keys apart", () => {
    const c = new WindowCounter(1, 1_000);
    c.hit("a", 0);
    expect(c.waitMs("a", 1)).toBeGreaterThan(0);
    expect(c.waitMs("b", 1)).toBe(0);
  });

  it("is memory-bounded: expired keys go first, then the least recently used", () => {
    const c = new WindowCounter(5, 1_000, 3);
    c.hit("old", 0);
    c.hit("a", 500);
    c.hit("b", 600);
    c.hit("c", 1_200); // full at 3: "old" has expired and is swept
    expect(c.size).toBe(3);
    expect(c.keys()).toEqual(["a", "b", "c"]);
    c.hit("a", 1_300); // touching "a" makes "b" the least recently used
    c.hit("d", 1_400); // nothing expired: "b" is evicted
    expect(c.size).toBe(3);
    expect(c.keys()).toEqual(["c", "a", "d"]);
  });

  it("never holds more than maxKeys keys under a flood of new keys", () => {
    const c = new WindowCounter(1, 60_000, 50);
    for (let i = 0; i < 10_000; i += 1) c.hit(`k${i}`, i);
    expect(c.size).toBe(50);
  });

  it("refuses a bad configuration", () => {
    expect(() => new WindowCounter(0, 1_000)).toThrow();
    expect(() => new WindowCounter(1, 0)).toThrow();
    expect(() => new WindowCounter(1, 1_000, 0)).toThrow();
  });
});

describe("ChatRateLimiter", () => {
  const keys = (session: string, client = LOCAL_CLIENT) => ({ session, client });

  it("limits each persona chat session", () => {
    const l = new ChatRateLimiter({ perSession: 2, perClient: 100, perServer: 100 });
    expect(l.take(keys("s1"), 0)).toBeNull();
    expect(l.take(keys("s1"), 1)).toBeNull();
    expect(l.take(keys("s1"), 2)).toEqual({ scope: "session", retryAfterMs: RATE_WINDOW_MS - 2 });
    expect(l.take(keys("s2"), 3)).toBeNull(); // another session is not affected
  });

  it("limits each client address across sessions", () => {
    const l = new ChatRateLimiter({ perSession: 100, perClient: 2, perServer: 100 });
    expect(l.take(keys("s1", "10.0.0.1"), 0)).toBeNull();
    expect(l.take(keys("s2", "10.0.0.1"), 0)).toBeNull();
    expect(l.take(keys("s3", "10.0.0.1"), 0)?.scope).toBe("client");
    expect(l.take(keys("s3", "10.0.0.2"), 0)).toBeNull();
  });

  it("limits the whole server across clients and sessions", () => {
    const l = new ChatRateLimiter({ perSession: 100, perClient: 100, perServer: 2 });
    expect(l.take(keys("s1", "a"), 0)).toBeNull();
    expect(l.take(keys("s2", "b"), 0)).toBeNull();
    expect(l.take(keys("s3", "c"), 0)?.scope).toBe("server");
  });

  it("counts nothing for a refused turn, so a refused caller does not use up another scope", () => {
    const l = new ChatRateLimiter({ perSession: 1, perClient: 2, perServer: 100 });
    expect(l.take(keys("s1"), 0)).toBeNull();
    for (let i = 0; i < 5; i += 1) expect(l.take(keys("s1"), 0)?.scope).toBe("session");
    expect(l.take(keys("s2"), 0)).toBeNull(); // the client scope still has its second slot
  });

  it("admits again once the window rolls over", () => {
    const l = new ChatRateLimiter({ perSession: 1, perClient: 1, perServer: 1 });
    expect(l.take(keys("s1"), 0)).toBeNull();
    expect(l.take(keys("s1"), RATE_WINDOW_MS - 1)).not.toBeNull();
    expect(l.take(keys("s1"), RATE_WINDOW_MS)).toBeNull();
  });

  it("is atomic under a burst of concurrent turns: exactly the limit is admitted", async () => {
    const l = new ChatRateLimiter({ perSession: 100, perClient: 100, perServer: 7 });
    const admitted = await Promise.all(Array.from({ length: 50 }, async (_, i) => l.take(keys(`s${i}`), 0) === null));
    expect(admitted.filter(Boolean)).toHaveLength(7);
  });

  it("traces the first refusal of a window only", () => {
    const l = new ChatRateLimiter({ perSession: 1, perClient: 1, perServer: 1 });
    expect(l.traceRefusal(0)).toBe(true);
    expect(l.traceRefusal(RATE_WINDOW_MS - 1)).toBe(false);
    expect(l.traceRefusal(RATE_WINDOW_MS)).toBe(true);
  });
});

describe("OncePer", () => {
  it("is due once per interval", () => {
    const o = new OncePer(10);
    expect([o.due(0), o.due(5), o.due(9), o.due(10), o.due(11)]).toEqual([true, false, false, true, false]);
  });
});

describe("clientAddress", () => {
  const app = new Hono().post("/x", (c) => c.text(clientAddress(c)));

  it("ignores X-Forwarded-For and X-Real-IP (no trusted-proxy rule): a mounted app sees one local client", async () => {
    const res = await app.request("/x", { method: "POST", headers: { "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.9" } });
    expect(await res.text()).toBe(LOCAL_CLIENT);
  });

  it("uses the socket address when the runtime hands one over (node server adapter)", async () => {
    const res = await app.request("/x", { method: "POST", headers: { "x-forwarded-for": "203.0.113.9" } }, { incoming: { socket: { remoteAddress: "10.1.2.3" } } });
    expect(await res.text()).toBe("10.1.2.3");
  });
});

// VISION-DECISIONS §9: actions have their own bucket; the text limits are unchanged.
describe("action bucket", () => {
  it("allows 30 actions a minute per session, with client and server bounds; text limits stay 10/20/30", () => {
    expect(DEFAULT_ACTION_RATE).toEqual({ perSession: 30, perClient: 60, perServer: 120 });
    expect(DEFAULT_CHAT_RATE).toEqual({ perSession: 10, perClient: 20, perServer: 30 });
    const l = new ChatRateLimiter(DEFAULT_ACTION_RATE);
    for (let i = 0; i < 30; i += 1) expect(l.take({ session: "s1", client: "c" }, i)).toBeNull();
    expect(l.take({ session: "s1", client: "c" }, 30)?.scope).toBe("session");
    expect(l.take({ session: "s2", client: "c" }, 31)).toBeNull();
    expect(l.take({ session: "s1", client: "c" }, RATE_WINDOW_MS + 1)).toBeNull();
  });
});
