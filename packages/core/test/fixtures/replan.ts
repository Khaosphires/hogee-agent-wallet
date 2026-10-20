/** Replan test helpers: patch the committed state, and an executeLoosen oracle for routed requests. */
import type { CommittedPlan, ReplanLoosenRequest } from "../../src/index";

export const withCurrentLine = (c: CommittedPlan, key: string, patch: Partial<CommittedPlan["lines"][number]>): CommittedPlan => ({
  ...c,
  lines: c.lines.map((l) => (l.lineKey === key ? { ...l, ...patch } : l)),
});

/** What executeLoosen does to the on-chain state for each routed request (test oracle). */
export function applyLoosens(current: CommittedPlan, loosens: readonly ReplanLoosenRequest[]): CommittedPlan {
  let c = current;
  const line = (key: string) => c.lines.find((l) => l.lineKey === key)!;
  for (const r of loosens) {
    switch (r.kind) {
      case "RAISE_CAP":
        c = withCurrentLine(c, r.payload.lineKey, r.payload.cap === "perTx" ? { perTxCapMinor: r.payload.newCapMinor } : { windowCapMinor: r.payload.newCapMinor });
        break;
      case "EXTEND_EXPIRY":
        c = r.payload.target === "agent" ? { ...c, agent: { ...c.agent, expiresAt: r.payload.newExpiresAt } } : withCurrentLine(c, r.payload.lineKey, { validUntil: r.payload.newExpiresAt });
        break;
      case "ADD_PAYEE":
        c = withCurrentLine(c, r.payload.lineKey, { payeeIds: [...line(r.payload.lineKey).payeeIds, r.payload.payeeId] });
        break;
      case "MOVE_POCKETS": {
        const amount = BigInt(r.payload.amountMinor);
        const from = BigInt(line(r.payload.fromLineKey).amountMinor) - amount;
        const to = BigInt(line(r.payload.toLineKey).amountMinor) + amount;
        c = withCurrentLine(withCurrentLine(c, r.payload.fromLineKey, { amountMinor: String(from) }), r.payload.toLineKey, { amountMinor: String(to) });
        break;
      }
    }
  }
  return c;
}
