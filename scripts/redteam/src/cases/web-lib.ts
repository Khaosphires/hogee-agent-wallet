/**
 * Helpers of the WEB world's cases: chat actions and text turns over POST /api/chat (parsed with the frozen part
 * schemas), the search poll, the terms form, refusal envelopes, and rows. A row prefers the product's own trace (an
 * error envelope's traceId, the search's trace); when the product wrote none the red team records its observation as
 * an eval-prefixed trace event ("[eval redteam ...]": a measurement, never a facility decision), so every row that ran
 * still points at a stored trace.
 */
import { ApiError, ChatAction, OrderTerms, SupplierSearch, type ChatAction as ChatActionT, type MilestoneTrigger, type OrderTermsInput, type PayoutAccountInput, type TermsLimits } from "@hogee/core";
import { createApiApp, appendTrace, newId, uuidv7, type ApiDeps } from "../api-internals";
import { balances } from "../flows";
import type { Persona } from "../stack";
import type { WebRun } from "../web/run-state";
import { parseUiStream, type StreamParts } from "../web/stream";
import { limitsFromPocket } from "../web/terms-attacks";
import type { Ctx } from "./context";
import type { RowInput } from "../evidence";

export const WEB_ONLY = "the WEB world needs its own fresh final-1 deployment (Mei, SGD) and the recorded web search (Anvil only: Sepolia runs one facility per deployment)";
/** The quantity of Mei's order (the demo: 1,000 tumblers, 2,500 BU in total). */
export const QUANTITY = 1000;
const POLL_MS = 250;
const POLL_LIMIT_MS = 60_000;

export function web(ctx: Ctx): WebRun {
  if (!ctx.state.web) throw new Error("a WEB case ran outside the WEB world");
  return ctx.state.web;
}

/** The world after S2 and S1 (WEB): plan committed and funded. Every later case needs it. */
export function ready(ctx: Ctx): WebRun {
  const w = web(ctx);
  if (!ctx.state.worldReady) throw new Error(`the WEB world is not set up: ${ctx.state.worldSetupError ?? "S2/S1 (WEB) did not finish"}`);
  return w;
}

/** A structured button press with a fresh single-use actionId (parsed: a malformed action is a runner bug). */
export function action(a: Record<string, unknown> & { type: ChatActionT["type"] }): ChatActionT {
  return ChatAction.parse({ ...a, actionId: uuidv7() });
}

export interface Turn {
  readonly status: number;
  readonly stream: StreamParts;
}

async function chatPost(ctx: Ctx, who: Persona, label: string, body: unknown): Promise<Turn> {
  const res = await who.post("/api/chat", body);
  const text = await res.text();
  ctx.h.t.entries.push({ label, method: "POST", path: "/api/chat", body, status: res.status, response: text.slice(0, 4000) });
  return { status: res.status, stream: parseUiStream(text) };
}

/** A button press (no model, no redaction: its own rate bucket). */
export const act = (ctx: Ctx, sessionId: string, a: ChatActionT, label = `action ${a.type}`, who: Persona = ctx.s.founder): Promise<Turn> => chatPost(ctx, who, label, { sessionId, action: a });

/** A typed message; `scripted` are the model results queued for this turn (a fresh scripted model, real guard). */
export async function say(ctx: Ctx, sessionId: string, message: string, scripted: readonly unknown[] = []): Promise<Turn> {
  ctx.s.resetAgent();
  ctx.s.agent.queue(...(scripted as never[]));
  return chatPost(ctx, ctx.s.founder, "chat text", { sessionId, message });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET /api/suppliers/search/:id until READY or FAILED (the card polls the same route). */
export async function pollSearch(ctx: Ctx, searchId: string, who: Persona = ctx.s.founder): Promise<SupplierSearch> {
  const until = Date.now() + POLL_LIMIT_MS;
  for (;;) {
    const r = await who.get(`/api/suppliers/search/${encodeURIComponent(searchId)}`);
    const json = (await r.json()) as unknown;
    if (r.status !== 200) throw new Error(`getSupplierSearch ${searchId}: HTTP ${r.status} ${JSON.stringify(json).slice(0, 300)}`);
    const s = SupplierSearch.parse(json);
    if (s.status !== "PENDING") {
      ctx.h.t.entries.push({ label: `search ${searchId} ${s.status}`, method: "GET", path: `/api/suppliers/search/${searchId}`, status: r.status, response: s });
      return s;
    }
    if (Date.now() > until) throw new Error(`search ${searchId} still PENDING after ${POLL_LIMIT_MS / 1000} s`);
    await sleep(POLL_MS);
  }
}

export interface Refusal {
  readonly status: number;
  readonly code: string | null;
  readonly reason: string | null;
  readonly unavailable: boolean;
  readonly traceId: string | null;
}

/** The ApiError envelope of a response (code, details.reason, details.unavailable, traceId). */
export function refusalOf(r: { status: number; json: unknown }): Refusal {
  const e = ApiError.safeParse(r.json);
  const details = e.success ? (e.data.error.details ?? {}) : {};
  return {
    status: r.status,
    code: e.success ? e.data.error.code : null,
    reason: typeof details.reason === "string" ? details.reason : null,
    unavailable: details.unavailable === true,
    traceId: e.success ? (e.data.error.traceId ?? null) : null,
  };
}

export const refusalText = (r: Refusal): string => `HTTP ${r.status} ${r.code ?? "?"}${r.reason ? ` ${r.reason}` : ""}${r.unavailable ? " (unavailable)" : ""}`;

export function termsInput(o: { searchId: string; supplierId: string; totalMinor: bigint; milestones: readonly { bps: number; trigger: MilestoneTrigger }[]; payout: PayoutAccountInput; quantity?: number }): OrderTermsInput {
  return { supplierId: o.supplierId, searchId: o.searchId, quantity: o.quantity ?? QUANTITY, totalMinor: o.totalMinor.toString(), milestones: o.milestones.map((m) => ({ ...m })), payout: { ...o.payout } };
}

/** POST /api/orders/terms (the ONLY way a payout account arrives). */
export const submitTerms = (ctx: Ctx, label: string, input: OrderTermsInput, who: Persona = ctx.s.founder) => ctx.h.post(who, label, "/api/orders/terms", input);

export function confirmed(r: { status: number; json: unknown }, what: string): OrderTerms {
  if (r.status !== 200) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  return OrderTerms.parse(r.json);
}

export async function readTerms(ctx: Ctx, termsId: string): Promise<OrderTerms> {
  return confirmed(await ctx.h.get(ctx.s.founder, "read terms", `/api/orders/terms/${encodeURIComponent(termsId)}`), "getOrderTerms");
}

/** The SUPPLIER pocket's limits as GET /api/balances shows them (window remaining bounded by the window cap). */
export async function supplierLimits(ctx: Ctx): Promise<TermsLimits> {
  const b = await balances(ctx.s, ctx.h, "balances (SUPPLIER pocket)");
  const p = b.pockets.find((x) => x.lineKey === "SUPPLIER");
  if (!p) throw new Error("no SUPPLIER pocket in /api/balances");
  return limitsFromPocket(p);
}

export interface Counts {
  readonly supplierTerms: number;
  readonly signatureRequests: number;
  readonly chainActions: number;
  readonly payments: number;
  readonly webSearches: number;
}

/** Row counts the invariants compare (nothing a text turn or a replay may create). */
export async function counts(ctx: Ctx): Promise<Counts> {
  const q = async (sql: string): Promise<number> => (await ctx.s.db.$client.query<{ n: number }>(sql, [ctx.s.facilityId])).rows[0]?.n ?? -1;
  return {
    supplierTerms: await q("select count(*)::int as n from supplier_terms where facility_id = $1"),
    signatureRequests: await q("select count(*)::int as n from signature_requests where facility_id = $1"),
    chainActions: await q("select count(*)::int as n from chain_actions where facility_id = $1 and coalesce(ref_id, '') not like 'redteam:%'"),
    payments: await q("select count(*)::int as n from payments where facility_id = $1"),
    webSearches: await q("select count(*)::int as n from shortlists where facility_id = $1 and source = 'web'"),
  };
}

export const sameCounts = (a: Counts, b: Counts, keys: readonly (keyof Counts)[] = Object.keys(a) as (keyof Counts)[]): boolean => keys.every((k) => a[k] === b[k]);
export const changed = (a: Counts, b: Counts): string[] => (Object.keys(a) as (keyof Counts)[]).filter((k) => a[k] !== b[k]);

async function traceExists(ctx: Ctx, traceId: string): Promise<boolean> {
  const r = await ctx.s.db.$client.query("select 1 from traces where facility_id = $1 and trace_id = $2 limit 1", [ctx.s.facilityId, traceId]);
  return r.rows.length > 0;
}

type ObservedRow = Omit<RowInput, "taskId" | "facts" | "anchor" | "traceId" | "layer"> & { readonly layer?: RowInput["layer"] };

/**
 * A row on the product's own trace when it wrote one (`productTraceId`), else on a red-team observation trace
 * (eval-prefixed, actor reader, TOOL_CALL). Refusals on the product's trace are agent_refusal rows; the rest offchain.
 */
export async function observe(ctx: Ctx, row: ObservedRow, productTraceId?: string | null): Promise<boolean> {
  if (productTraceId && (await traceExists(ctx, productTraceId))) {
    return ctx.traced({ ...row, layer: row.layer ?? (row.expected === "refused" ? "agent_refusal" : "offchain"), traceId: productTraceId });
  }
  const traceId = newId("trace");
  await appendTrace(ctx.s.db, { facilityId: ctx.s.facilityId, traceId, actor: "reader", kind: "TOOL_CALL", summary: `[eval redteam ${ctx.taskId} WEB] ${row.ok ? "observed" : "FAILED"}: ${row.title}`.slice(0, 500) });
  return ctx.traced({ ...row, layer: "offchain", traceId });
}

let clientSeq = 10;

/**
 * The world's API with some ports replaced (fresh per-app limiters; same database, chain and persona secrets), seen
 * from its own client address (TEST-NET-2). The web search's limits are per PROCESS and keyed on persona + client
 * (v-search), so each side search is another client, exactly as a second browser would be; within one app the
 * address stays the same, so the 1-a-minute limit still applies there (T26).
 */
export function appWith(ctx: Ctx, over: Partial<ApiDeps>): { founder: Persona; client: string } {
  const deps: ApiDeps = { ...ctx.s.deps, ...over };
  const app = createApiApp(async () => deps);
  const cookie = ctx.s.cookie(ctx.s.country.persona);
  clientSeq += 1;
  const client = `198.51.100.${clientSeq}`;
  const env = { incoming: { socket: { remoteAddress: client } } };
  return {
    client,
    founder: {
      get: async (path) => app.request(path, { headers: { cookie } }, env),
      post: async (path, body, extra = {}) => app.request(path, { method: "POST", headers: { cookie, "content-type": "application/json", ...extra }, body: body === undefined ? "{}" : JSON.stringify(body) }, env),
      form: async (path, form) => app.request(path, { method: "POST", headers: { cookie }, body: form }, env),
    },
  };
}

/** POST /api/suppliers/search on `who`'s app; returns the searchId or the refusal. */
export async function startSearch(ctx: Ctx, who: Persona, label: string, quantity: number): Promise<{ searchId: string | null; refusal: Refusal | null }> {
  const r = await ctx.h.post(who, label, "/api/suppliers/search", { quantity });
  if (r.status === 200 && typeof (r.json as { searchId?: unknown }).searchId === "string") return { searchId: (r.json as { searchId: string }).searchId, refusal: null };
  return { searchId: null, refusal: refusalOf(r) };
}
