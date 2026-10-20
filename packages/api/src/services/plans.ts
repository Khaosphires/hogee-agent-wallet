/** Plan rows (§12.1 plans / plan_drafts), facility-scoped. */
import { PlanManifest, type PlanRecord } from "@hogee/core";
import type { Scope } from "../context";
import { one, rows, type Q } from "./sql";

export interface PlanRow {
  id: string;
  plan_id: string;
  version: number;
  plan_hash: string;
  prev_plan_hash: string;
  manifest_json: unknown;
  status: PlanRecord["status"];
  tx_hash: string | null;
  draft_id: string | null;
  total_minor: string;
}

const COLS = "id, plan_id, version, plan_hash, prev_plan_hash, manifest_json, status, tx_hash, draft_id, manifest_json->>'totalMinor' as total_minor";

export async function committedPlanRow(q: Q, scope: Scope): Promise<PlanRow | undefined> {
  return one<PlanRow>(q, `select ${COLS} from plans where facility_id = $1 and status = 'COMMITTED' order by version desc limit 1`, [scope.facilityId]);
}

export async function planRows(q: Q, scope: Scope): Promise<PlanRow[]> {
  return rows<PlanRow>(q, `select ${COLS} from plans where facility_id = $1 order by version, created_at`, [scope.facilityId]);
}

export function planRecord(r: PlanRow): PlanRecord {
  return { manifest: PlanManifest.parse(r.manifest_json), status: r.status, planHash: r.plan_hash as PlanRecord["planHash"], txHash: (r.tx_hash as PlanRecord["txHash"]) ?? null };
}
