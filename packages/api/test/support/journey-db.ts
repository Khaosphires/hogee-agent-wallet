/**
 * An in-memory stand-in for the few Postgres queries the chat journey runs (unit tests only; the live files run the
 * real database). It keeps chat messages (per session) and traces as the store writes them and answers the facts
 * queries from a scripted world: facility, committed plan, founder key, the latest supplier list, the terms rows and
 * the USED terms' order. The bounded reads (the newest-N window, the journey's part projection, the action-id lookup)
 * are answered the way Postgres answers them. `client` answers the one chain read the facts make, Treasury.paused(),
 * from the same world (rcfix-journey A-7); every other chain read throws, as fake-deps' unavailable client.
 */
import type { Db } from "@hogee/db";
import type { HogeePublicClient } from "../../src/chain-lib";

type TermsRow = { id: string; supplier_id: string; status: "CONFIRMED" | "SUPERSEDED" | "USED"; order_id: string | null };

export interface JourneyWorldState {
  committedDraftId: string | null;
  manifest: unknown;
  intent: unknown;
  keyStatus: "PENDING_LENDER" | "REGISTERED";
  list: { id: string; source: "web" | "catalog"; status: "PENDING" | "READY" | "FAILED"; stale?: boolean; search_json?: unknown; result_json?: unknown } | null;
  /** The facility's supplier_terms rows (one, several, or none). */
  terms: TermsRow | readonly TermsRow[] | null;
  /** The USED terms' escrow order and its payee's status (absent: no order row). */
  order?: {
    order_id: string;
    supplier_id: string;
    payee_status: "PENDING" | "COOLING" | "BOUND" | "CANCELLED";
    cooling_until: string | null;
    first_released: string | null;
    /** Every milestone released (UX-PLAN D35); absent: not all. */
    all_released?: boolean | null;
    /** A live RELEASE_MILESTONE row for the first held milestone not released yet (rcfix-journey A-6); absent: none. */
    release_signed?: boolean | null;
  } | null;
  /** What Treasury.paused() reads (absent: false); "unreadable": the chain read fails. */
  paused?: boolean | "unreadable";
}

export interface StoredRow {
  id: string;
  /** The session the row belongs to (rows seeded without one belong to every session). */
  session_id?: string;
  seq: number;
  role: "user" | "assistant";
  parts_json: Record<string, unknown>[];
}

export interface JourneyDb {
  readonly db: Db;
  readonly client: HogeePublicClient;
  readonly world: JourneyWorldState;
  readonly messages: StoredRow[];
  readonly traces: { traceId: string; actor: string; kind: string; summary: string }[];
  readonly sql: string[];
  /** Puts a raw stored message in the session (e.g. a part that no longer parses). */
  seed(row: Omit<StoredRow, "seq">): void;
}

const FACILITY = { facility_id: "fac-rina", cap_minor: "1000000", currency: "MYR", reserve_floor_bps: 500, lender_address: "0x0", deployment_id: "d", chain_id: 31337, opened_tx: null };

/** jsonb containment (`@>`) for the shapes the store asks about. */
function contains(have: unknown, want: unknown): boolean {
  if (Array.isArray(want)) return Array.isArray(have) && want.every((w) => have.some((h) => contains(h, w)));
  if (want !== null && typeof want === "object") {
    if (have === null || typeof have !== "object" || Array.isArray(have)) return false;
    return Object.entries(want).every(([k, v]) => contains((have as Record<string, unknown>)[k], v));
  }
  return have === want;
}

export function journeyDb(initial: Partial<JourneyWorldState> = {}): JourneyDb {
  const world: JourneyWorldState = { committedDraftId: null, manifest: null, intent: null, keyStatus: "REGISTERED", list: null, terms: null, ...initial };
  const messages: StoredRow[] = [];
  const traces: JourneyDb["traces"] = [];
  const sql: string[] = [];
  const ofSession = (sessionId: unknown) => messages.filter((m) => m.session_id === undefined || m.session_id === sessionId).sort((x, y) => x.seq - y.seq);
  const newest = (rows: StoredRow[], limit: unknown) => (typeof limit === "number" ? rows.slice(-limit) : rows);
  const termsRows = (): readonly TermsRow[] => (world.terms === null ? [] : Array.isArray(world.terms) ? world.terms : [world.terms as TermsRow]);
  const answer = (text: string, values: readonly unknown[] = []): Record<string, unknown>[] => {
    sql.push(text);
    if (/from facilities/.test(text)) return [FACILITY];
    if (/from chat_sessions where/.test(text)) return ofSession(values[1]).length > 0 ? [{ "?column?": 1 }] : [];
    if (/jsonb_agg/.test(text)) {
      const types = values[2] as readonly string[];
      return newest(ofSession(values[1]), values[3]).map((m) => ({ seq: m.seq, role: m.role, parts: structuredClone(m.parts_json).filter((p) => types.includes(String(p.type))) }));
    }
    if (/parts_json @>/.test(text)) {
      const want = JSON.parse(String(values[2])) as unknown;
      return [{ used: ofSession(values[1]).some((m) => m.role === "user" && contains(m.parts_json, want)) }];
    }
    if (/select id, seq, role, parts_json from chat_messages/.test(text)) return newest(ofSession(values[1]), values[2]).map((m) => ({ ...m, parts_json: structuredClone(m.parts_json) }));
    if (/select max\(seq\)/.test(text)) {
      const rows = ofSession(values[1]);
      return [{ seq: rows.length > 0 ? Math.max(...rows.map((m) => m.seq)) : null }];
    }
    if (/insert into chat_messages/.test(text)) {
      messages.push({ id: String(values[0]), session_id: String(values[2]), seq: Number(values[3]), role: values[4] as StoredRow["role"], parts_json: JSON.parse(String(values[5])) as StoredRow["parts_json"] });
      return [];
    }
    if (/from plans where facility_id = \$1 and status = 'COMMITTED'/.test(text)) {
      return world.committedDraftId ? [{ id: "plan-1", draft_id: world.committedDraftId, manifest_json: world.manifest, status: "COMMITTED", total_minor: "1000000" }] : [];
    }
    if (/from plans where facility_id = \$1 order by version desc/.test(text)) return world.committedDraftId ? [{ draft_id: world.committedDraftId, status: "COMMITTED" }] : [];
    if (/from plan_drafts where facility_id = \$1 and id = \$2/.test(text)) return world.intent ? [{ intent_json: world.intent }] : [];
    if (/from founders/.test(text)) return [{ key_status: world.keyStatus }];
    if (/from shortlists where facility_id = \$1 order by created_at desc/.test(text)) return world.list ? [{ search_json: null, result_json: null, stale: false, ...world.list }] : [];
    if (/from supplier_terms/.test(text)) {
      const ids = /id = any\(\$2/.test(text) ? (values[1] as readonly string[]) : null;
      return termsRows().filter((t) => ids === null || ids.includes(t.id));
    }
    if (/from escrow_orders o left join payees p/.test(text)) return world.order ? [world.order] : [];
    if (/insert into traces/.test(text)) {
      traces.push({ traceId: String(values[0]), actor: String(values[4]), kind: String(values[5]), summary: String(values[6]) });
      return [];
    }
    if (/count\(\*\)::int as n from traces/.test(text)) return [{ n: traces.filter((t) => t.traceId === values[1]).length }];
    return [];
  };
  const query = async (text: string, values?: readonly unknown[]) => {
    const rows = answer(text, values);
    return { rows, rowCount: rows.length };
  };
  const db = { $client: { query, connect: async () => ({ query, release: () => undefined }) } } as unknown as Db;
  const readContract = async (args: { functionName: string }) => {
    if (args.functionName !== "paused") throw new Error(`client.readContract(${args.functionName}) is not available in this test`);
    if (world.paused === "unreadable") throw new Error("the chain node is down (scripted)");
    return world.paused ?? false;
  };
  const getBlock = async () => {
    throw new Error("client.getBlock is not available in this test");
  };
  const client = { readContract, getBlock } as unknown as HogeePublicClient;
  return {
    db,
    client,
    world,
    messages,
    traces,
    sql,
    seed: (row) => void messages.push({ ...row, seq: Math.max(0, ...ofSession(row.session_id).map((m) => m.seq)) + 1 }),
  };
}
