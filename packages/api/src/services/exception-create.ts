/**
 * What a founder may open (POST /api/exceptions), checked against the chain-backed state before any row exists, and
 * the blast radius code computes for it (the most money the change could move; never a request value alone). A balance
 * release names the inspection evidence recorded on its milestone, the hash the founder's release signs (rcfix H-4).
 */
import { constitutionOk, type ExceptionKind, type LineKey } from "@hogee/core";
import type { ApiDeps, Scope } from "../context";
import { fail } from "../http/problem";
import { compileEnv, loadDraft, stillCurrent } from "./compile";
import { isTimelockKind } from "./exceptions";
import { assertLoosenAllowed } from "./loosen";
import type { PolicyWorld } from "./policy-context";
import { one, pool } from "./sql";

interface Req {
  readonly kind: ExceptionKind;
  readonly payload: Record<string, unknown>;
}

const big = (s: unknown): bigint => BigInt(String(s));

/** The milestone a RELEASE_ESCROW_BALANCE names, as stored (evidence_hash: the recorded inspection, or none). */
export interface EscrowMilestoneRow {
  readonly amount_minor: string;
  readonly funded_minor: string;
  readonly released_minor: string;
  readonly evidence_hash: string | null;
}

async function milestone(deps: ApiDeps, scope: Scope, p: Record<string, unknown>) {
  return one<EscrowMilestoneRow>(
    pool(deps.db),
    "select amount_minor::text as amount_minor, funded_minor::text as funded_minor, released_minor::text as released_minor, evidence_hash from escrow_milestones where facility_id = $1 and order_id = $2 and idx = $3",
    [scope.facilityId, p.orderId, p.idx],
  );
}

/**
 * Why a RELEASE_ESCROW_BALANCE cannot be opened, or null when it can. The founder's MilestoneRelease signs the
 * milestone's recorded inspection hash (signing/founder-payments.ts), never the request's, so a request naming another
 * hash would show the loan officer a check code the release does not carry (rcfix H-4): refused, and so is a milestone
 * with no recorded inspection yet, in the words the founder's release uses.
 */
export function escrowReleaseRefusal(m: EscrowMilestoneRow | undefined, evidenceHash: string): string | null {
  if (!m) return "No such escrow milestone";
  if (big(m.funded_minor) < big(m.amount_minor) || big(m.released_minor) > 0n) return "That milestone is not funded and waiting for release";
  if (!m.evidence_hash) return "Upload the inspection evidence first";
  if (m.evidence_hash.toLowerCase() !== evidenceHash.toLowerCase()) return "The delivery check code does not match the inspection evidence recorded for that milestone";
  return null;
}

/**
 * The same refusal when the founder approves an open balance release (rcfix-officer follow-up): an inspection
 * re-uploaded after the request opened changes the hash the release signs, so the request's check code must still be it.
 */
export async function escrowReleaseStillRefusal(deps: ApiDeps, scope: Scope, payload: Record<string, unknown>): Promise<string | null> {
  return escrowReleaseRefusal(await milestone(deps, scope, payload), String(payload.evidenceHash));
}

export async function checkCreate(deps: ApiDeps, scope: Scope, r: Req, world: PolicyWorld): Promise<void> {
  const p = r.payload;
  if (isTimelockKind(r.kind)) return assertLoosenAllowed(deps, r, world.ctx);
  const db = pool(deps.db);
  switch (r.kind) {
    case "RELEASE_STAGE": {
      const stage = world.ctx.stages.find((s) => s.stageId === p.stageId);
      if (!stage || world.manifest.stages[0]?.stageId === p.stageId) throw fail("CONFLICT", "No such later funding stage in the committed plan");
      if (stage.released) throw fail("CONFLICT", "That stage is already released");
      const open = await one(db, "select 1 as x from exceptions where facility_id = $1 and kind = 'RELEASE_STAGE' and payload->>'stageId' = $2 and status in ('OPEN', 'APPROVED')", [scope.facilityId, p.stageId]);
      if (open) throw fail("CONFLICT", "A release of that stage is already pending");
      return;
    }
    case "REPLAN": {
      const loaded = await loadDraft(db, scope, String(p.draftId));
      if (!loaded || loaded.preview) throw fail("CONFLICT", "No signable draft with that id");
      if (!constitutionOk(loaded.draft.constitutionReport) || !stillCurrent(loaded.draft, await compileEnv(deps, scope))) throw fail("CONFLICT", "That draft is not a current, valid replan");
      if (loaded.draft.manifest.version < 2) throw fail("CONFLICT", "That draft is a first plan, not a replan");
      return;
    }
    case "RELEASE_ESCROW_BALANCE": {
      const refusal = escrowReleaseRefusal(await milestone(deps, scope, p), String(p.evidenceHash));
      if (refusal) throw fail("CONFLICT", refusal);
      return;
    }
    default:
      throw fail("VALIDATION", `${r.kind} cannot be requested here`);
  }
}

export async function blastRadiusOf(deps: ApiDeps, scope: Scope, r: Req, world: PolicyWorld): Promise<bigint> {
  const p = r.payload;
  const lineState = (k: unknown) => world.ctx.lines[k as LineKey];
  const remaining = (k: unknown) => {
    const s = lineState(k);
    return s ? big(s.allocatedMinor) - big(s.spentMinor) - big(s.escrowedMinor) : 0n;
  };
  switch (r.kind) {
    case "RAISE_CAP": {
      const s = lineState(p.lineKey);
      const cur = s ? big(p.cap === "perTx" ? s.perTxCapMinor : s.windowCapMinor) : 0n;
      const d = big(p.newCapMinor) - cur;
      return d > 0n ? d : 0n;
    }
    case "MOVE_POCKETS":
    case "WITHDRAW_RESERVE":
      return big(p.amountMinor);
    case "ADD_PAYEE":
      return remaining(p.lineKey);
    case "EXTEND_EXPIRY":
    case "UNPAUSE": {
      if (p.lineKey) return remaining(p.lineKey);
      const b = world.snapshot.balances;
      const free = b.releasedMinor - b.spentMinor - b.escrowedMinor;
      return free > 0n ? free : 0n;
    }
    case "RELEASE_STAGE":
      return big(world.manifest.stages.find((s) => s.stageId === p.stageId)?.releaseMinor ?? "0");
    case "REPLAN":
      return big((await loadDraft(pool(deps.db), scope, String(p.draftId)))?.draft.blastRadiusMinor ?? "0");
    case "RELEASE_ESCROW_BALANCE":
      return big((await milestone(deps, scope, p))?.amount_minor ?? "0");
    case "POLICY_ESCALATION":
      return big((p.proposal as { amountMinor?: string } | undefined)?.amountMinor ?? "0");
  }
}
