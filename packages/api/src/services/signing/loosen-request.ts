/**
 * LoosenRequest (§8.8, hard rule 3): the founder signs a loosening the chain would accept now (core evaluateLoosen on
 * the chain-backed context); its operands come from code (services/exceptions.ts loosenFields), never the request.
 * At submit the exception becomes FOUNDER_SIGNED and an unsigned Treasury.queueLoosen action is parked: the worker
 * defers it until the loan officer APPROVES, and only then co-signs with the lender key (refused if denied).
 * No simulation here: queueLoosen needs the lender's co-signature, which does not exist yet.
 */
import { formatBu } from "@hogee/core";
import { loosenId } from "../../chain-lib";
import { fail } from "../../http/problem";
import { insertAction } from "../actions";
import { isTimelockKind, loosenFields, requireException } from "../exceptions";
import { assertLoosenAllowed } from "../loosen";
import { policyWorld } from "../policy-context";
import { pool } from "../sql";
import { appendTrace } from "../traces";
import { row, type SignKind } from "./kinds";
import { toViemMessage, type TypedMessage } from "./typed";

const asFields = (f: { kind: number; target: string; aux: string; newValue: bigint }): TypedMessage => ({
  kind: String(f.kind),
  target: f.target.toLowerCase(),
  aux: f.aux.toLowerCase(),
  newValue: f.newValue.toString(),
});

export const loosenRequest: SignKind = {
  async prepare(deps, scope, refId) {
    const e = await requireException(pool(deps.db), scope, refId);
    if (!isTimelockKind(e.kind)) throw fail("CONFLICT", "Only a timelocked loosening is signed as a LoosenRequest");
    if (e.status !== "OPEN") throw fail("CONFLICT", `This request is ${e.status.toLowerCase()}, not open for your signature`);
    await assertLoosenAllowed(deps, e, (await policyWorld(deps, scope)).ctx);
    return {
      contract: "Treasury",
      title: "Request a loosening",
      rows: [
        row("Change", e.title, "loosen"),
        row("Most money this change can move", `${formatBu(e.blast_radius_minor)} BU`, "loosen"),
        row("What happens next", "The loan officer must co-sign; then a waiting period runs during which either of you can veto it"),
      ],
      fields: asFields(await loosenFields(deps, e)),
    };
  },

  async finalize(deps, scope, req, sig) {
    const e = await requireException(pool(deps.db), scope, req.ref_id);
    const expected = asFields(await loosenFields(deps, e));
    const signed = req.typed_data_json.message;
    if (Object.entries(expected).some(([k, v]) => signed[k] !== v)) throw fail("CONFLICT", "The signed loosening is not this request any more");
    const id = loosenId(toViemMessage("LoosenRequest", signed));
    return {
      async commit(q) {
        const moved = await q.query(
          `update exceptions set status = 'FOUNDER_SIGNED', founder_sig = $3::jsonb, loosen_id = $4, updated_at = now()
            where facility_id = $1 and id = $2 and status = 'OPEN'`,
          [scope.facilityId, e.id, JSON.stringify({ kind: sig.kind, data: sig.data }), id],
        );
        if (moved.rowCount !== 1) throw fail("CONFLICT", "This request is no longer open for your signature");
        await appendTrace(q, { facilityId: scope.facilityId, traceId: e.trace_id ?? `trace-${e.id}`, actor: "founder", kind: "SIGNATURE", summary: "Founder signed the loosening; awaiting the loan officer", refs: { exceptionId: e.id } });
        return insertAction(q, { facilityId: scope.facilityId, kind: "Treasury.queueLoosen", refId: e.id, request: { exceptionId: e.id, req: signed, founder: { kind: sig.kind, data: sig.data } } });
      },
    };
  },
};
