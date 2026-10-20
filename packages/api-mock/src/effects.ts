/** What an executed exception changes in the mock's ledger (mirrors Treasury.executeLoosen / releaseStage). */
import { parseMinor, type Exception } from "@hogee/core";
import { addMinor, currentPlan, updatePocket, type MockState } from "./store";
import { createScriptedPayment } from "./transitions";

export function applyExceptionEffects(st: MockState, e: Exception): void {
  switch (e.kind) {
    case "RAISE_CAP": {
      const { lineKey, cap, newCapMinor } = e.payload;
      updatePocket(st, lineKey, (p) => (cap === "perTx" ? { ...p, perTxCap: newCapMinor } : { ...p, windowCap: newCapMinor }));
      return;
    }
    case "EXTEND_EXPIRY": {
      const payload = e.payload;
      if (payload.target === "agent") st.balances = { ...st.balances, agent: { ...st.balances.agent, expiresAt: payload.newExpiresAt } };
      else updatePocket(st, payload.lineKey, (p) => ({ ...p, validUntil: payload.newExpiresAt }));
      return;
    }
    case "MOVE_POCKETS": {
      const amount = parseMinor(e.payload.amountMinor);
      updatePocket(st, e.payload.fromLineKey, (p) => ({ ...p, allocated: addMinor(p.allocated, -amount), available: addMinor(p.available, -amount) }));
      updatePocket(st, e.payload.toLineKey, (p) => ({ ...p, allocated: addMinor(p.allocated, amount), available: addMinor(p.available, amount) }));
      return;
    }
    case "UNPAUSE": {
      const lineKey = e.payload.lineKey;
      if (lineKey) updatePocket(st, lineKey, (p) => ({ ...p, paused: false, circuitOpen: false }));
      else st.balances = { ...st.balances, paused: false };
      return;
    }
    case "WITHDRAW_RESERVE":
      createScriptedPayment(st, {
        kind: "WITHDRAW_RESERVE",
        lineKey: null,
        payeeId: e.payload.taxPayeeId,
        amountMinor: e.payload.amountMinor,
        invoiceHash: `0x${"0".repeat(64)}`,
        reason: "Reserve withdrawal to the tax payee after the timelock",
        policy: { verdict: "NEEDS_OFFICER", reasonCode: "TIMELOCK_EXECUTED", summary: "Signed by the founder and the loan officer; the timelock passed with no veto" },
      });
      return;
    case "RELEASE_STAGE": {
      const stage = currentPlan(st)?.manifest.stages.find((s) => s.stageId === e.payload.stageId);
      if (stage) st.balances = { ...st.balances, releasedMinor: addMinor(st.balances.releasedMinor, parseMinor(stage.releaseMinor)) };
      return;
    }
    case "POLICY_ESCALATION": {
      // officerApprove re-checked the payee binding and the caps (spendRefusal) before this runs.
      const { lineKey, payeeId, amountMinor } = e.payload.proposal;
      createScriptedPayment(st, {
        kind: "SPEND",
        lineKey,
        payeeId,
        amountMinor,
        reason: `Escalated ${lineKey} spend to ${payeeId}`,
        policy: {
          verdict: "NEEDS_OFFICER",
          reasonCode: "OFFICER_OVERRIDE",
          summary: "Officer override: the loan officer approved a spend the policy escalated; payee binding and caps were re-checked before sending",
        },
      });
      return;
    }
    // ADD_PAYEE binds a payee (no ledger change); RELEASE_ESCROW_BALANCE and REPLAN complete through the
    // founder's signature (signing.ts).
    case "ADD_PAYEE":
    case "RELEASE_ESCROW_BALANCE":
    case "REPLAN":
      return;
  }
}
