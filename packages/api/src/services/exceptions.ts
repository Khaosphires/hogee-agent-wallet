/**
 * Exception rows (§26.5) and their on-chain encodings. Every field the founder or lender signs is derived here by code
 * from the payload and server state: a LoosenRequest's target / aux / newValue (HogeeKinds LOOSEN_*), for ADD_PAYEE
 * the payout account hash of an ONBOARDED payee (catalog), and for WITHDRAW_RESERVE the server country's tax payee,
 * never a value from the request (T1).
 */
import { LINE_LABEL } from "@hogee/agent";
import { Exception, TIMELOCK_EXCEPTION_KINDS, formatBu, type ExceptionKind, type ExceptionStatus } from "@hogee/core";
import type { Hex } from "viem";
import { HOGEE_KINDS, lineKeyToLineId, shortIdToBytes32, ZERO_BYTES32 } from "../chain-lib";
import { payoutHashOf, taxPayeeFor } from "../catalog/payees";
import type { ApiDeps, OnboardedPayee, Scope } from "../context";
import { fail } from "../http/problem";
import { one, rows, type Q } from "./sql";
import { LIST_EXCEPTIONS_LIMIT } from "./writer-bounds";

export interface ExceptionRow {
  id: string;
  kind: ExceptionKind;
  title: string;
  payload: Record<string, unknown>;
  requested_by: string;
  requires_founder: boolean;
  requires_lender: boolean;
  status: ExceptionStatus;
  founder_sig: { kind: number; data: string } | null;
  loosen_id: string | null;
  queued_unix: string | null;
  executable_at: string | null;
  queued_tx: string | null;
  executed_tx: string | null;
  blast_radius_minor: string;
  trace_id: string | null;
}

const COLS = `id, kind, title, payload, requested_by, requires_founder, requires_lender, status, founder_sig, loosen_id,
  extract(epoch from queued_at)::bigint::text as queued_unix, executable_at::text as executable_at, queued_tx, executed_tx,
  blast_radius_minor::text as blast_radius_minor, trace_id`;

export const isTimelockKind = (k: ExceptionKind): boolean => (TIMELOCK_EXCEPTION_KINDS as readonly string[]).includes(k);

export async function exceptionRow(q: Q, scope: Scope, id: string): Promise<ExceptionRow | undefined> {
  return one<ExceptionRow>(q, `select ${COLS} from exceptions where facility_id = $1 and id = $2`, [scope.facilityId, id]);
}

export async function requireException(q: Q, scope: Scope, id: string): Promise<ExceptionRow> {
  const r = await exceptionRow(q, scope, id);
  if (!r) throw fail("NOT_FOUND", "No such exception");
  return r;
}

/**
 * The console's rows (re-check L1): at most LIST_EXCEPTIONS_LIMIT in all. The OPEN rows of the filter come first (newest
 * first), then the newest others. OPEN rows are listed up to the whole limit, so a flood of decided rows cannot hide a
 * request the officer must decide; past the limit the newest OPEN rows are cut first, so the oldest waiting request is
 * the last to go. Founder OPEN rows (the founder's and the agent's through MCP) are capped (MAX_OPEN_FOUNDER_EXCEPTIONS),
 * and the spend path's are one per proposal.
 */
export async function exceptionRows(q: Q, scope: Scope, status?: ExceptionStatus): Promise<ExceptionRow[]> {
  const filter = "facility_id = $1 and ($2::text is null or status::text = $2)";
  return rows<ExceptionRow>(
    q,
    `with open_rows as (
       select ${COLS}, created_at from exceptions where ${filter} and status = 'OPEN' order by created_at, id limit $3::int
     ), other_rows as (
       select ${COLS}, created_at from exceptions where ${filter} and status <> 'OPEN' order by created_at desc, id
        limit greatest(0, $3::int - (select count(*)::int from open_rows))
     )
     select * from (select *, 0 as listed_group from open_rows union all select *, 1 as listed_group from other_rows) listed
      order by listed_group, created_at desc, id`,
    [scope.facilityId, status ?? null, LIST_EXCEPTIONS_LIMIT],
  );
}

const REQUESTERS = new Set(["agent", "founder", "officer", "worker"]);

export function toException(r: ExceptionRow): Exception {
  const timelock = r.queued_unix && r.executable_at ? { queuedAt: r.queued_unix, executableAt: r.executable_at } : null;
  return Exception.parse({
    exceptionId: r.id,
    kind: r.kind,
    title: r.title,
    payload: r.payload,
    requestedBy: REQUESTERS.has(r.requested_by) ? r.requested_by : "worker",
    requires: { founder: r.requires_founder, lender: r.requires_lender },
    status: r.status,
    timelock,
    txs: { ...(r.queued_tx ? { queue: r.queued_tx } : {}), ...(r.executed_tx ? { execute: r.executed_tx } : {}) },
    blastRadiusMinor: r.blast_radius_minor,
    traceId: r.trace_id ?? `trace-${r.id}`,
  });
}

/** Who must act on each kind (§26.5 table). */
export function requiresOf(kind: ExceptionKind): { founder: boolean; lender: boolean } {
  if (isTimelockKind(kind)) return { founder: true, lender: true };
  if (kind === "RELEASE_STAGE" || kind === "POLICY_ESCALATION") return { founder: false, lender: true };
  return { founder: true, lender: false }; // REPLAN, RELEASE_ESCROW_BALANCE
}

export interface LoosenFields {
  readonly kind: number;
  readonly target: Hex;
  readonly aux: Hex;
  readonly newValue: bigint;
}

const lineId = (k: string): Hex => lineKeyToLineId(k as never);

/**
 * WITHDRAW_RESERVE's destination (hardening run-8, critic gap 6): only the server country's tax payee, lhdn-tax for MY
 * and iras-tax for SG. Treasury accepts any static platform payee, and final-1 holds both countries', so the chain
 * alone does not keep them apart: the other country's tax payee, a line's platform payee or anything else is refused.
 */
export function reserveTaxPayee(deps: Pick<ApiDeps, "config">, requested: unknown): OnboardedPayee {
  const tax = serverTaxPayee(deps.config.countryCode);
  if (requested !== tax.payeeId) throw fail("CONFLICT", `The reserve goes only to the tax payee ${tax.payeeId}`);
  return tax;
}

function serverTaxPayee(country: ApiDeps["config"]["countryCode"]): OnboardedPayee {
  try {
    return taxPayeeFor(country);
  } catch {
    throw fail("CONFLICT", `This server has no tax payee for a reserve withdrawal (${country})`);
  }
}

/** The LoosenRequest operands of a timelock exception (TreasuryLoosenRules._checkLoosen layout). */
export async function loosenFields(deps: ApiDeps, e: Pick<ExceptionRow, "kind" | "payload">): Promise<LoosenFields> {
  const p = e.payload as Record<string, string | undefined>;
  switch (e.kind) {
    case "RAISE_CAP":
      return { kind: p.cap === "perTx" ? HOGEE_KINDS.LOOSEN_RAISE_PER_TX_CAP : HOGEE_KINDS.LOOSEN_RAISE_WINDOW_CAP, target: lineId(p.lineKey as string), aux: ZERO_BYTES32, newValue: BigInt(p.newCapMinor as string) };
    case "ADD_PAYEE": {
      const payee = (await deps.catalog.payees()).find((x) => x.payeeId === p.payeeId);
      if (!payee) throw fail("CONFLICT", "Only an onboarded payee can be added to a line");
      return { kind: HOGEE_KINDS.LOOSEN_ADD_PAYEE, target: shortIdToBytes32(payee.payeeId), aux: lineId(p.lineKey as string), newValue: BigInt(payoutHashOf(payee)) };
    }
    case "EXTEND_EXPIRY":
      return p.target === "agent"
        ? { kind: HOGEE_KINDS.LOOSEN_EXTEND_AGENT_EXPIRY, target: ZERO_BYTES32, aux: ZERO_BYTES32, newValue: BigInt(p.newExpiresAt as string) }
        : { kind: HOGEE_KINDS.LOOSEN_EXTEND_LINE_EXPIRY, target: lineId(p.lineKey as string), aux: ZERO_BYTES32, newValue: BigInt(p.newExpiresAt as string) };
    case "MOVE_POCKETS":
      return { kind: HOGEE_KINDS.LOOSEN_MOVE_POCKETS, target: lineId(p.fromLineKey as string), aux: lineId(p.toLineKey as string), newValue: BigInt(p.amountMinor as string) };
    case "UNPAUSE":
      return { kind: HOGEE_KINDS.LOOSEN_UNPAUSE, target: p.lineKey ? lineId(p.lineKey) : ZERO_BYTES32, aux: ZERO_BYTES32, newValue: 0n };
    case "WITHDRAW_RESERVE":
      return { kind: HOGEE_KINDS.LOOSEN_WITHDRAW_RESERVE, target: shortIdToBytes32(reserveTaxPayee(deps, p.taxPayeeId).payeeId), aux: ZERO_BYTES32, newValue: BigInt(p.amountMinor as string) };
    default:
      throw fail("CONFLICT", `${e.kind} is not a timelocked loosening`);
  }
}

const line = (k: unknown): string => LINE_LABEL[k as keyof typeof LINE_LABEL] ?? String(k);

/** Templated titles (no request text reaches them). */
export function titleOf(kind: ExceptionKind, p: Record<string, unknown>): string {
  switch (kind) {
    case "RAISE_CAP":
      return `Raise the ${line(p.lineKey)} ${p.cap === "perTx" ? "per-payment" : "7-day"} limit to ${formatBu(p.newCapMinor as string)} BU`;
    case "ADD_PAYEE":
      return `Allow payee ${String(p.payeeId)} on the ${line(p.lineKey)} pocket`;
    case "EXTEND_EXPIRY":
      return p.target === "agent" ? "Extend the agent's authority" : `Extend the ${line(p.lineKey)} pocket's end date`;
    case "MOVE_POCKETS":
      return `Move ${formatBu(p.amountMinor as string)} BU from ${line(p.fromLineKey)} to ${line(p.toLineKey)}`;
    case "UNPAUSE":
      return p.lineKey ? `Resume the ${line(p.lineKey)} pocket` : "Resume all payments";
    case "WITHDRAW_RESERVE":
      return `Withdraw ${formatBu(p.amountMinor as string)} BU from the reserve to ${String(p.taxPayeeId)}`;
    case "RELEASE_ESCROW_BALANCE":
      return `Release escrow milestone ${String(p.idx)} of order ${String(p.orderId)}`;
    case "RELEASE_STAGE":
      return `Release funding ${String(p.stageId)}`;
    case "REPLAN":
      return "Commit a tighter plan version";
    case "POLICY_ESCALATION":
      return "Review a flagged payment";
  }
}
