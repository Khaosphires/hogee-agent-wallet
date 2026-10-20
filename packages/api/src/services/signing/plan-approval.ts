/**
 * PlanApproval (§26.1 step 3): the founder signs a stored, current, non-preview draft compiled by code. The struct
 * commits to the manifest hash and to the exact lines and stages the relayer passes (linesHash / stagesHash, T27).
 * At submit a plans row (SUBMITTED) and an unsigned PlanRegistry.commitPlan action are written; the worker relays it
 * and mirrors the outcome (COMMITTED / REVERTED).
 */
import { LINE_LABEL } from "@hogee/agent";
import { constitutionOk, formatBu, hashObject, type CommittedPlan, type PlanManifest } from "@hogee/core";
import { buildCommitPlan, hashLines, hashStages, manifestToLines, manifestToStages } from "../../chain-lib";
import { fail } from "../../http/problem";
import { insertAction } from "../actions";
import { compileEnv, loadDraft, stillCurrent } from "../compile";
import { newId } from "../ids";
import { one, pool } from "../sql";
import { day, row, type DisplayRow, type SignKind } from "./kinds";
import { toViemMessage } from "./typed";

type Effect = DisplayRow["effect"];

function compare(next: bigint, cur: bigint | undefined, higherLoosens = true): Effect {
  if (cur === undefined || next === cur) return "neutral";
  return next > cur === higherLoosens ? "loosen" : "tighten";
}

function lineRows(m: PlanManifest, current?: CommittedPlan): DisplayRow[] {
  return m.lines.map((l) => {
    const cur = current?.lines.find((c) => c.lineKey === l.lineKey);
    const effects = cur
      ? [compare(BigInt(l.perTxCapMinor), BigInt(cur.perTxCapMinor)), compare(BigInt(l.windowCapMinor), BigInt(cur.windowCapMinor)), compare(BigInt(l.validUntil), BigInt(cur.validUntil))]
      : [];
    const effect: Effect = effects.includes("loosen") ? "loosen" : effects.includes("tighten") ? "tighten" : "neutral";
    const days = Number(BigInt(l.windowSeconds) / 86_400n);
    const pacing = l.pacing ? `; paced ${formatBu(l.pacing.amountMinor)} BU a day` : "";
    const escrow = l.escrowOnly ? "; escrow only" : "";
    return row(
      `${LINE_LABEL[l.lineKey]} pocket`,
      `${formatBu(l.amountMinor)} BU; at most ${formatBu(l.perTxCapMinor)} BU per payment and ${formatBu(l.windowCapMinor)} BU per ${days} days${pacing}${escrow}; until ${day(l.validUntil)}`,
      effect,
    );
  });
}

function gateText(g: PlanManifest["stages"][number]["gate"]): string {
  if (!g) return "the loan officer approves";
  const what = g.metric === "salesMinor" ? `sales reach ${formatBu(g.target)} BU` : `${g.target} orders`;
  return `${what} by ${day(g.deadline)} and the loan officer approves`;
}

function panel(m: PlanManifest, current?: CommittedPlan): DisplayRow[] {
  return [
    row("Plan version", `v${m.version}${m.version > 1 ? " (tighten-only replan)" : ""}`),
    row("Total budget", `${formatBu(m.totalMinor)} BU`, compare(BigInt(m.totalMinor), current ? BigInt(current.totalMinor) : undefined)),
    ...lineRows(m, current),
    row("Reserve on each sale", `${m.reserveBps / 100}% of every sale is set aside`, compare(BigInt(m.reserveBps), current ? BigInt(current.reserveBps) : undefined, false)),
    row("Agent", `${m.agent.address} may pay within these limits until ${day(m.agent.expiresAt)}`, compare(BigInt(m.agent.expiresAt), current ? BigInt(current.agent.expiresAt) : undefined)),
    ...m.stages.map((s, i) => row(`Stage ${i + 1}`, `${formatBu(s.releaseMinor)} BU ${i === 0 ? "released when this plan is committed" : `after ${gateText(s.gate)}`}`)),
  ];
}

export const planApproval: SignKind = {
  async prepare(deps, scope, refId) {
    const db = pool(deps.db);
    const loaded = await loadDraft(db, scope, refId);
    if (!loaded) throw fail("NOT_FOUND", "No such plan draft");
    if (loaded.preview) throw fail("CONFLICT", "A country preview is off-chain only and can't be signed");
    const d = loaded.draft;
    if (!constitutionOk(d.constitutionReport)) throw fail("CONFLICT", "This draft fails the plan constitution and can't be signed");
    const env = await compileEnv(deps, scope);
    if (!stillCurrent(d, env)) throw fail("CONFLICT", "The plan has changed since this draft; draft it again");
    const m = d.manifest;
    const inFlight = await one(db, "select 1 as x from plans where facility_id = $1 and version = $2 and status = 'SUBMITTED'", [scope.facilityId, m.version]);
    if (inFlight) throw fail("CONFLICT", `Plan version ${m.version} is already being committed`);
    const lines = manifestToLines(m);
    const stages = manifestToStages(m);
    return {
      contract: "PlanRegistry",
      title: m.version === 1 ? "Approve your launch plan" : `Approve plan version ${m.version}`,
      rows: panel(m, env.current),
      fields: {
        planId: m.planId,
        version: String(m.version),
        prevPlanHash: m.prevPlanHash,
        planHash: hashObject(m),
        countryPackHash: m.countryPackHash,
        linesHash: hashLines(lines),
        stagesHash: hashStages(stages),
        totalMinor: m.totalMinor,
        reserveBps: String(m.reserveBps),
        agent: m.agent.address.toLowerCase(),
        agentExpiry: m.agent.expiresAt,
      },
    };
  },

  async finalize(deps, scope, req, sig) {
    const loaded = await loadDraft(pool(deps.db), scope, req.ref_id);
    if (!loaded || loaded.preview) throw fail("CONFLICT", "The signed draft is no longer available");
    const m = loaded.draft.manifest;
    const approval = toViemMessage("PlanApproval", req.typed_data_json.message);
    if (approval.planHash !== hashObject(m)) throw fail("CONFLICT", "The signed plan hash is not the stored draft");
    const call = buildCommitPlan({ approval, lines: manifestToLines(m), stages: manifestToStages(m), founder: sig });
    return {
      call,
      async commit(q) {
        const planRowId = newId("plan");
        await q.query(
          `insert into plans (id, facility_id, draft_id, plan_id, version, prev_plan_hash, plan_hash, manifest_json, country_pack_hash, status, signed_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'SUBMITTED', now())`,
          [planRowId, scope.facilityId, loaded.draft.draftId, m.planId, m.version, m.prevPlanHash, hashObject(m), JSON.stringify(m), m.countryPackHash],
        );
        return insertAction(q, {
          facilityId: scope.facilityId,
          kind: "PlanRegistry.commitPlan",
          refId: planRowId,
          request: { approval: req.typed_data_json.message, founder: { kind: sig.kind, data: sig.data } },
        });
      },
    };
  },
};
