/**
 * The mock journey once the supplier order is signed (v-chat-server; int-e2e expects it): with v-terms' getOrderTerms
 * answering the saved terms USED with an order (stood in for here), `signed{SupplierApproval}` answers with data-order
 * in the SAME reply, and later status turns show it again; cooling then the deposit read from the store.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TEXT, exampleOrderTerms, exampleSupplierSearch, exampleWebCandidate, type ChatAction } from "@hogee/core";
import { app } from "../src/index";
import { readEnv } from "../src/env";
import { getState, resetState } from "../src/store";
import { harness, json, secret } from "./support/harness";

const order = vi.hoisted(() => ({ used: false, coolingEndsAt: null as string | null }));
vi.mock("../src/features/orders", async () => {
  const { exampleOrderTerms: terms } = await import("@hogee/core");
  return {
    // http.ts funds web orders past cooling on every request; these stand-in terms have no store behind them.
    advanceWebOrders: () => undefined,
    orderHandlers: {
      submitOrderTerms: () => terms,
      getOrderTerms: ({ req }: { req: { params: { id: string } } }) =>
        req.params.id !== terms.termsId
          ? { code: "NOT_FOUND", message: "no such terms" }
          : order.used
            ? { ...terms, status: "USED", orderId: "order-wqk3vt7ma2xrb-001", coolingEndsAt: order.coolingEndsAt }
            : terms,
    },
  };
});

const SESSION = "01a14202-2800-7000-8000-00000000f0d1";
const h = harness(app);
let n = 0;
const id = () => `01a14202-2800-7000-8000-${String((n += 1)).padStart(12, "0")}`;

beforeAll(() => {
  process.env.DEMO_MODE = "1";
  process.env.PERSONA_COOKIE_SECRET = secret();
  process.env.OFFICER_TOKEN = secret();
});
beforeEach(() => {
  vi.stubEnv("MOCK_SCENARIO", "fresh");
  resetState(readEnv());
  order.used = false;
  order.coolingEndsAt = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetState(readEnv());
});

async function types(body: unknown): Promise<{ types: string[]; text: string }> {
  const res = await app.request("/api/chat", { ...json(body), headers: { "content-type": "application/json", cookie: await h.cookie("founder") } });
  const chunks = (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)) as { type: string; delta?: string });
  return {
    types: chunks.filter((c) => c.type === "text-start" || c.type.startsWith("data-")).map((c) => (c.type === "text-start" ? "text" : c.type)),
    text: chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join(""),
  };
}
const act = (action: ChatAction) => types({ sessionId: SESSION, action });

describe("mock journey after the supplier order is signed", () => {
  it("signed{SupplierApproval} → data-order in the same reply; cooling, then the order card on a status turn", { timeout: 60_000 }, async () => {
    const st = getState(readEnv());
    st.plans.push({ manifest: st.loaded.scenario["plan-draft.json"].manifest, status: "COMMITTED", planHash: `0x${"ab".repeat(32)}`, txHash: `0x${"cd".repeat(32)}` } as never);
    await act({ type: "start_search", actionId: id() });
    await act({ type: "pick", actionId: id(), searchId: exampleSupplierSearch.searchId, supplierIds: [exampleWebCandidate.supplierId] });
    expect((await act({ type: "terms_saved", actionId: id(), termsId: exampleOrderTerms.termsId })).types).toEqual(["text", "data-sign"]);

    order.used = true;
    order.coolingEndsAt = new Date(Date.now() + 120_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const signed = await act({ type: "signed", actionId: id(), kind: "SupplierApproval", refId: exampleOrderTerms.termsId });
    expect(signed.text).toBe(TEXT.orderSigned);
    expect(signed.types).toEqual(["text", "data-order", "data-next"]);

    const status = await types({ sessionId: SESSION, message: "where are we?" });
    expect(status.types).toEqual(["text", "data-order", "data-next"]);
    // UX-PLAN D5: "where are we?" is the quick what-next reply: the Next step sentence, then the stage's cards.
    expect(status.text).toContain("Next: Safety wait");
  });
});
