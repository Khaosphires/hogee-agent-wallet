/**
 * A database for web search unit tests (no Postgres): it answers the reads startWebSearch / runWebSearch make by their
 * SQL (facility, founder, committed plan, its draft, reuse, the daily count, the row the read path selects) and records
 * every statement, so a test can read what was stored (search_json, traces, supplier rows) and what was not.
 */
import { MEI_PLAN_INTENT, examplePlanDraft, type PlanIntent } from "@hogee/core";
import type { Db } from "@hogee/db";

export interface SearchDbState {
  /** A committed plan exists (false: NO_PLAN). */
  plan: boolean;
  intent: PlanIntent;
  /** An identical READY search to reuse. */
  reuseId: string | null;
  /** Web searches the facility started in the last 24 h. */
  daily: number;
  /** The row GET /api/suppliers/search/:id reads (search_json + whether it is a stale PENDING). */
  row: { search_json: unknown; stale: boolean } | null;
  readonly statements: { readonly sql: string; readonly params: readonly unknown[] }[];
}

export function searchDbState(over: Partial<SearchDbState> = {}): SearchDbState {
  return { plan: true, intent: MEI_PLAN_INTENT, reuseId: null, daily: 0, row: null, statements: [], ...over };
}

export function searchDb(s: SearchDbState): Db {
  const query = async (sql: string, params: readonly unknown[] = []) => {
    s.statements.push({ sql, params });
    const out = (rows: unknown[], rowCount = rows.length) => ({ rows, rowCount });
    if (/from facilities where/.test(sql)) return out([{ facility_id: "fac-mei", cap_minor: "1000000", currency: "SGD", reserve_floor_bps: 300 }]);
    if (/from founders where/.test(sql)) return out([{ id: "founder-mei", country: "SG", residency: "citizen" }]);
    if (/from plans where facility_id = \$1 and status = 'COMMITTED'/.test(sql)) {
      return out(s.plan ? [{ id: "plan-1", draft_id: "draft-mei-001", manifest_json: examplePlanDraft.manifest, status: "COMMITTED", version: 1 }] : []);
    }
    if (/from plan_drafts where/.test(sql)) return out([{ intent_json: s.intent }]);
    if (/status = 'READY' and spec_json = \$2::jsonb/.test(sql)) return out(s.reuseId ? [{ id: s.reuseId }] : []);
    if (/count\(\*\)::int as n/.test(sql)) return out([{ n: s.daily, wait_s: 3_600 }]);
    if (/select search_json, \(status = 'PENDING'/.test(sql)) return out(s.row ? [s.row] : []);
    if (/^\s*(update|insert)/i.test(sql)) return out([], 1);
    return out([], 0);
  };
  return { $client: { query, connect: async () => ({ query, release: () => undefined }), on: () => undefined } } as unknown as Db;
}

/** The JSON parameters of the statements matching `re` (parsed), in order. */
export function jsonParams(s: SearchDbState, re: RegExp): unknown[] {
  return s.statements.filter((x) => re.test(x.sql)).flatMap((x) => x.params.filter((p): p is string => typeof p === "string" && p.startsWith("{")).map((p) => JSON.parse(p) as unknown));
}
