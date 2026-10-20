/** A verified sale in the mock (SalesOracle.recordSale): the Stripe webhook, the demo sale and the sample business's sales. */
import { bpsFloor, parseMinor } from "@hogee/core";
import { addMinor, appendTrace, currentPlan, mockHash, nextId, nowIso, type MockState } from "./store";

/** Records a verified sale: revenue up, the plan's reserveBps skimmed into the reserve. `atMs` dates its trace. */
export function recordSale(st: MockState, saleKey: string, amountMinor: string, atMs?: number): void {
  const reserveBps = currentPlan(st)?.manifest.reserveBps ?? 0;
  const skim = bpsFloor(parseMinor(amountMinor), reserveBps);
  st.balances = {
    ...st.balances,
    revenueMinor: addMinor(st.balances.revenueMinor, parseMinor(amountMinor)),
    reserveMinor: addMinor(st.balances.reserveMinor, skim),
  };
  st.salesSeen.add(saleKey);
  appendTrace(st, {
    traceId: nextId(st, "trace"),
    actor: "oracle",
    kind: "TX",
    summary: `Sale recorded by the oracle; ${(reserveBps / 100).toFixed(2)}% set aside in the tax reserve`,
    refs: { txHash: mockHash(`tx:sale:${saleKey}`) },
    ...(atMs === undefined ? {} : { ts: nowIso(atMs) }),
  });
}
