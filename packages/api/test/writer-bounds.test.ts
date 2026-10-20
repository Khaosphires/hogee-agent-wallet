/**
 * Audit run-7 bounds on the other founder-persona writers (services/writer-bounds.ts): when a shortlist or an
 * exception is handed out again, when a new exception is refused (a shortlist never is), how shortlist starts are
 * serialized, and when an inspection upload writes nothing or is traced. The rows and traces actually written are in test/live/writer-bounds.live.test.ts.
 */
import { describe, expect, it } from "vitest";
import { CHAT_SESSION_MAX_MESSAGES, Id, TEXT } from "@hogee/core";
import {
  chatFullTraceId,
  decideChatTurn,
  decideException,
  decideShortlist,
  decideUpload,
  inspectionTraceId,
  MAX_OPEN_FOUNDER_EXCEPTIONS,
  MAX_UPLOADS_PER_MILESTONE,
  serialized,
} from "../src/services/writer-bounds";

const h = (c: string) => `0x${c.repeat(64)}`;

describe("decideShortlist", () => {
  it("hands out a matching recent shortlist again", () => {
    expect(decideShortlist("sl-1")).toEqual({ reuse: "sl-1" });
  });

  it("creates any new spec: never a refusal (re-check M2)", () => {
    expect(decideShortlist(undefined)).toEqual({ create: true });
  });
});

describe("serialized (re-check L3)", () => {
  it("runs the calls of one key one at a time, in order, and other keys alongside", async () => {
    const log: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => (release = done));
    const first = serialized("fac-1", async () => {
      log.push("a:start");
      await gate;
      log.push("a:end");
      return "a";
    });
    const second = serialized("fac-1", async () => {
      log.push("b");
      return "b";
    });
    const other = serialized("fac-2", async () => {
      log.push("c");
      return "c";
    });
    expect(await other).toBe("c");
    expect(log).toEqual(["a:start", "c"]);
    release();
    expect(await Promise.all([first, second])).toEqual(["a", "b"]);
    expect(log).toEqual(["a:start", "c", "a:end", "b"]);
  });

  it("keeps going after a failed call", async () => {
    const failed = serialized("fac-3", async () => {
      throw new Error("check down");
    });
    await expect(failed).rejects.toThrow("check down");
    expect(await serialized("fac-3", async () => "next")).toBe("next");
  });
});

describe("decideException", () => {
  it("hands out the OPEN duplicate again, even at the cap", () => {
    expect(decideException("exc-1", MAX_OPEN_FOUNDER_EXCEPTIONS)).toEqual({ reuse: "exc-1" });
  });

  it(`creates below ${MAX_OPEN_FOUNDER_EXCEPTIONS} OPEN founder requests and refuses from there`, () => {
    expect(decideException(undefined, MAX_OPEN_FOUNDER_EXCEPTIONS - 1)).toEqual({ create: true });
    const refused = decideException(undefined, MAX_OPEN_FOUNDER_EXCEPTIONS);
    expect("refuse" in refused && refused.refuse).toMatch(/loan officer/);
  });
});

describe("decideChatTurn (audit run-9 lead 2)", () => {
  it(`takes a turn while the session's messages fit under ${CHAT_SESSION_MAX_MESSAGES}, then refuses with the full-session sentence`, () => {
    expect(decideChatTurn(0, 2)).toEqual({ create: true });
    expect(decideChatTurn(CHAT_SESSION_MAX_MESSAGES - 2, 2)).toEqual({ create: true });
    expect(decideChatTurn(CHAT_SESSION_MAX_MESSAGES - 1, 2)).toEqual({ refuse: TEXT.sessionFull });
    expect(decideChatTurn(CHAT_SESSION_MAX_MESSAGES, 1)).toEqual({ refuse: TEXT.sessionFull });
  });

  it("a full session's refusals share one trace id (only the first is written)", () => {
    const sessionId = "01a14202-2800-7000-8000-0000000000a1";
    expect(chatFullTraceId(sessionId)).toBe(`chat-full-${sessionId}`);
    expect(Id.safeParse(chatFullTraceId(sessionId)).success).toBe(true);
  });
});

describe("decideUpload", () => {
  it("writes nothing for the stored hash (any case), even at the cap", () => {
    expect(decideUpload(h("a"), h("a"), 0)).toEqual({ unchanged: true });
    expect(decideUpload(h("A").replace("0X", "0x"), h("a"), MAX_UPLOADS_PER_MILESTONE)).toEqual({ unchanged: true });
  });

  it(`always stores a new hash: traced below ${MAX_UPLOADS_PER_MILESTONE} uploads, then one final event, then untraced (re-check M1)`, () => {
    expect(decideUpload(null, h("a"), 0)).toEqual({ write: true, trace: "recorded" });
    expect(decideUpload(h("a"), h("b"), MAX_UPLOADS_PER_MILESTONE - 1)).toEqual({ write: true, trace: "recorded" });
    expect(decideUpload(h("a"), h("b"), MAX_UPLOADS_PER_MILESTONE)).toEqual({ write: true, trace: "last" });
    expect(decideUpload(null, h("b"), MAX_UPLOADS_PER_MILESTONE)).toEqual({ write: true, trace: "last" });
    expect(decideUpload(h("a"), h("b"), MAX_UPLOADS_PER_MILESTONE + 1)).toEqual({ write: true, trace: null });
    expect(decideUpload(h("a"), h("b"), MAX_UPLOADS_PER_MILESTONE + 500)).toEqual({ write: true, trace: null });
  });

  it("names one trace per milestone, a valid trace id", () => {
    expect(inspectionTraceId("order-a-001", 2)).toBe("inspection:order-a-001:2");
    expect(inspectionTraceId("order-a-001", 2)).not.toBe(inspectionTraceId("order-a-001", 1));
    expect(Id.safeParse(inspectionTraceId("order-abcdefghijklmnopqrst-999", 7)).success).toBe(true);
  });
});
