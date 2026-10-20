/**
 * Audit run-6 (v-1) bounds on the founder-persona signature writers (services/signing/request-bounds.ts): which open
 * request is handed out again, when a new one is refused, and when refusals close a request. The live behaviour
 * (rows and traces actually written) is in test/live/export-bounds.live.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  contentKey,
  decideRequest,
  MAX_OPEN_REQUESTS,
  MAX_REFUSALS,
  rejectsAfter,
  REUSE_MIN_REMAINING_S,
  type RequestContent,
} from "../src/services/signing/request-bounds";

const request = (over: { nonce?: string; expiry?: string; digest?: string; budget?: string; title?: string } = {}): RequestContent => ({
  typedData: {
    domain: { name: "Hogee", version: "1", verifyingContract: "0x00000000000000000000000000000000000000a1", salt: `0x${"ab".repeat(32)}` },
    types: { PlanApproval: [{ name: "planHash", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "expiry", type: "uint64" }] },
    primaryType: "PlanApproval",
    message: { planHash: `0x${"11".repeat(32)}`, budget: over.budget ?? "1000000", deploymentId: `0x${"22".repeat(32)}`, nonce: over.nonce ?? "123", expiry: over.expiry ?? "2000" },
  },
  displayModel: { title: over.title ?? "Approve plan v1", kind: "PlanApproval", rows: [{ label: "Total budget", value: "RM10,000", effect: "neutral" }], digest: over.digest ?? `0x${"33".repeat(32)}`, chainId: 31337 },
});

describe("contentKey", () => {
  it("ignores the per-request nonce, expiry and digest, and key order (jsonb reorders keys)", () => {
    const a = request();
    const b = request({ nonce: "999999999999", expiry: "3000", digest: `0x${"44".repeat(32)}` });
    expect(contentKey(b)).toBe(contentKey(a));
    const reordered: RequestContent = JSON.parse(JSON.stringify({ displayModel: a.displayModel, typedData: { message: a.typedData.message, primaryType: a.typedData.primaryType, types: a.typedData.types, domain: a.typedData.domain } })) as RequestContent;
    expect(contentKey(reordered)).toBe(contentKey(a));
  });

  it("changes when anything the founder signs or sees changes", () => {
    expect(contentKey(request({ budget: "1000001" }))).not.toBe(contentKey(request()));
    expect(contentKey(request({ title: "Approve plan v2" }))).not.toBe(contentKey(request()));
  });
});

describe("decideRequest", () => {
  const now = 1_000n;
  const key = contentKey(request());
  const open = (id: string, expiresAt: bigint, k = key) => ({ id, expiresAt, key: k });
  const pairs = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "PlanApproval", refId: `draft-${i}` }));

  it("hands out the open request with the same content instead of a new one", () => {
    expect(decideRequest([open("sig-1", now + 900n)], pairs(1), key, now)).toEqual({ reuse: "sig-1" });
  });

  it("reuses a matching request even with the cap full, evicting nothing", () => {
    expect(decideRequest([open("sig-1", now + 900n)], pairs(MAX_OPEN_REQUESTS), key, now)).toEqual({ reuse: "sig-1" });
  });

  it("creates a new one when the open request is stale (other content) or about to expire", () => {
    expect(decideRequest([open("sig-1", now + 900n, contentKey(request({ budget: "5" })))], pairs(1), key, now)).toEqual({ create: true, evict: [] });
    expect(decideRequest([open("sig-1", now + REUSE_MIN_REMAINING_S - 1n)], pairs(1), key, now)).toEqual({ create: true, evict: [] });
    expect(decideRequest([open("sig-1", now + REUSE_MIN_REMAINING_S)], pairs(1), key, now)).toEqual({ reuse: "sig-1" });
    expect(decideRequest([], [], key, now)).toEqual({ create: true, evict: [] });
  });

  it("re-check M2: never refuses; a new pair past the cap evicts the oldest open pairs", () => {
    expect(decideRequest([], pairs(MAX_OPEN_REQUESTS - 1), key, now)).toEqual({ create: true, evict: [] });
    expect(decideRequest([], pairs(MAX_OPEN_REQUESTS), key, now)).toEqual({ create: true, evict: [{ kind: "PlanApproval", refId: "draft-0" }] });
    // Over-full (older data): evicts down to the cap with the new pair.
    expect(decideRequest([], pairs(MAX_OPEN_REQUESTS + 2), key, now)).toEqual({ create: true, evict: pairs(3) });
  });
});

describe("rejectsAfter", () => {
  it("closes a request on its MAX_REFUSALS-th refusal, not before", () => {
    expect(MAX_REFUSALS).toBe(5);
    for (let before = 0; before < MAX_REFUSALS - 1; before += 1) expect(rejectsAfter(before)).toBe(false);
    expect(rejectsAfter(MAX_REFUSALS - 1)).toBe(true);
    expect(rejectsAfter(MAX_REFUSALS)).toBe(true);
  });
});
