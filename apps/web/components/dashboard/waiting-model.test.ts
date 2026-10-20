import { describe, expect, it } from "vitest";
import { groupWaiting, requestTitle, waitingBanner } from "./waiting-model";

const e = (exceptionId: string, kind: "UNPAUSE" | "RAISE_CAP" | "RELEASE_ESCROW_BALANCE", payload: Record<string, unknown> = {}) => ({ exceptionId, kind, payload }) as never;

describe("waiting for your signature", () => {
  it("titles a request by its kind's template and its pocket, never by its stored title", () => {
    expect(requestTitle({ kind: "RAISE_CAP", payload: { lineKey: "ADS", cap: "perTx", newCapMinor: "50000" } })).toBe("Raise a limit · Ads");
    expect(requestTitle({ kind: "UNPAUSE", payload: {} })).toBe("Restart payments");
    expect(requestTitle({ kind: "RELEASE_ESCROW_BALANCE", payload: { orderId: "order-a-001", idx: 2, evidenceHash: "0x00" } })).toBe("Pay the supplier the balance");
  });

  it("shows one request per kind (the latest); the rest wait under earlier requests", () => {
    const g = groupWaiting([e("u1", "UNPAUSE"), e("r1", "RAISE_CAP"), e("u2", "UNPAUSE"), e("u3", "UNPAUSE")]);
    expect(g.latest.map((x: { exceptionId: string }) => x.exceptionId)).toEqual(["u3", "r1"]);
    expect(g.earlier.map((x: { exceptionId: string }) => x.exceptionId)).toEqual(["u1", "u2"]);
    expect(groupWaiting([])).toEqual({ latest: [], earlier: [] });
  });

  it("counts requests in plain words", () => {
    expect(waitingBanner(1)).toBe("1 request waits for your signature");
    expect(waitingBanner(3)).toBe("3 requests wait for your signature");
  });
});
