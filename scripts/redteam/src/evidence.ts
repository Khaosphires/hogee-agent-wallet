/**
 * The evidence bundle the run writes (project.md §16): evidence/<run-id>/
 *   evidence.json            EvidenceRow[] in the FROZEN schema (@hogee/core EvidenceRow; every row is parsed before
 *                            it is kept, so a malformed row is a runner bug that stops the run)
 *   receipts/<txHash>.json   the transaction, its receipt, the decoded Hogee call, events and revert
 *   traces/<traceId>.json    the trace events (hash-chained, as stored) a row points at
 *   artifacts/<case>/*.json  HTTP transcripts and other inputs/outputs of a case
 *   not-run/<taskId>.json    why a case could not run on this target
 *   report.json              per-case status (pass | fail | not_run) for the runner's summary; NOT a frozen file
 *   run.json                 target, chain, deployments, git commit, tool versions (manifest.json is the 1.16
 *                            exporter's: BundleManifest needs verified-source URLs, which an Anvil run has none of)
 * Rows never claim more than the chain or the database show: a tx row carries the mined receipt's hash and block, a
 * refusal row the id of a trace that exists in `traces/`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOGEE_ABIS, lookupRevert, type HogeePublicClient } from "@hogee/chain";
import { EvidenceRow, type EvidenceTaskId } from "@hogee/core";
import type { Db } from "@hogee/db";
import { decodeEventLog, decodeFunctionData, getAddress, type Abi, type Hex } from "viem";
import type { Deployment } from "./api-internals";

export type CaseStatus = "pass" | "fail" | "not_run";

export interface CaseReport {
  readonly taskId: EvidenceTaskId;
  readonly title: string;
  status: CaseStatus;
  readonly notes: string[];
  readonly rows: number[];
  reason?: string;
}

export interface TxFacts {
  readonly txHash: Hex;
  readonly status: "success" | "reverted";
  readonly block: number;
  readonly contract: string;
  readonly function: string;
  readonly from: string;
  readonly events: readonly { name: string; args: Record<string, unknown> }[];
  readonly revert: { name: string; args: readonly unknown[] } | null;
  readonly gasUsed: string;
}

const json = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
const ALL_ABIS: readonly [string, Abi][] = Object.entries(HOGEE_ABIS) as [string, Abi][];

function contractOf(deployment: Deployment, to: string | null | undefined): string {
  if (!to) return "";
  for (const [name, c] of Object.entries(deployment.contracts)) if (getAddress(c.address) === getAddress(to)) return name;
  return "";
}

function decodeCall(contract: string, input: Hex): string {
  const abi = (HOGEE_ABIS as Record<string, Abi>)[contract];
  if (!abi) return "";
  try {
    return decodeFunctionData({ abi, data: input }).functionName;
  } catch {
    return "";
  }
}

function decodeLogs(logs: readonly { data: Hex; topics: readonly Hex[] }[]): { name: string; args: Record<string, unknown> }[] {
  const out: { name: string; args: Record<string, unknown> }[] = [];
  for (const log of logs) {
    for (const [, abi] of ALL_ABIS) {
      try {
        const d = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        out.push({ name: String(d.eventName), args: (d.args ?? {}) as Record<string, unknown> });
        break;
      } catch {
        // not this contract's event
      }
    }
  }
  return out;
}

export async function txFacts(client: HogeePublicClient, deployment: Deployment, hash: Hex): Promise<TxFacts> {
  const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
  const contract = contractOf(deployment, tx.to);
  const fn = decodeCall(contract, tx.input);
  const revert = receipt.status === "reverted" ? (await lookupRevert(client, hash)).decoded : null;
  return {
    txHash: hash.toLowerCase() as Hex,
    status: receipt.status,
    block: Number(receipt.blockNumber),
    contract,
    function: fn,
    from: tx.from,
    events: decodeLogs(receipt.logs as never),
    revert: revert ? { name: revert.name, args: revert.args } : null,
    gasUsed: receipt.gasUsed.toString(),
  };
}

const short = (v: unknown): string => {
  const s = typeof v === "bigint" ? v.toString() : typeof v === "string" ? v : JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  return s.length > 70 ? `${s.slice(0, 66)}…` : s;
};

export function eventSummary(f: TxFacts): string | undefined {
  if (f.events.length === 0) return undefined;
  const s = f.events.map((e) => `${e.name}(${Object.entries(e.args).map(([k, v]) => `${k}=${short(v)}`).join(", ")})`).join("; ");
  return s.length > 500 ? `${s.slice(0, 497)}…` : s;
}

export function revertSummary(f: TxFacts): string | undefined {
  if (!f.revert) return f.status === "reverted" ? "UNDECODED_REVERT" : undefined;
  const args = f.revert.args.length > 0 ? `(${f.revert.args.map((a) => short(a)).join(",")})` : "";
  return `${f.revert.name}${args}`.slice(0, 200);
}

export interface RowInput {
  readonly taskId: EvidenceTaskId;
  readonly title: string;
  readonly expected: EvidenceRow["expected"];
  readonly expectedError?: EvidenceRow["expectedError"];
  readonly ok: boolean;
  readonly facts?: TxFacts;
  /** agent_refusal or offchain when there is no tx (a tx row's layer follows its receipt). */
  readonly layer?: "agent_refusal" | "offchain";
  readonly traceId?: string;
  readonly decisionId?: string;
  readonly payoutId?: string;
  readonly artifacts?: readonly string[];
  /** A refusal row may also carry the tx that anchored it (recordDenied). */
  readonly anchor?: TxFacts;
}

export class Bundle {
  readonly rows: EvidenceRow[] = [];
  readonly reports = new Map<EvidenceTaskId, CaseReport>();
  private current: CaseReport | null = null;
  readonly startedAt = new Date().toISOString();

  constructor(
    readonly dir: string,
    private readonly chain: { readonly chainId: number; readonly target: "anvil" | "sepolia" },
  ) {
    mkdirSync(dir, { recursive: true });
  }

  write(rel: string, value: unknown): string {
    const file = join(this.dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof value === "string" ? value : json(value));
    return rel;
  }

  explorerUrl(hash: string): string | undefined {
    return this.chain.target === "sepolia" ? `https://sepolia.etherscan.io/tx/${hash}` : undefined;
  }

  async receipt(client: HogeePublicClient, facts: TxFacts): Promise<string> {
    const [tx, receipt] = await Promise.all([client.getTransaction({ hash: facts.txHash }), client.getTransactionReceipt({ hash: facts.txHash })]);
    return this.write(`receipts/${facts.txHash}.json`, { facts, transaction: tx, receipt });
  }

  async trace(db: Db, facilityId: string, traceId: string): Promise<string> {
    const r = await db.$client.query(
      `select trace_id, seq, ts, actor, kind, summary, policy_verdict, reason_code, plan_version, payment_id, invoice_hash, decision_id, tx_hash,
              payout_id, prev_hash, hash from traces where facility_id = $1 and trace_id = $2 order by seq`,
      [facilityId, traceId],
    );
    if (r.rows.length === 0) throw new Error(`trace ${traceId} has no events: a refusal row must point at a stored trace`);
    return this.write(`traces/${traceId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`, r.rows);
  }

  /** Starts a case; its rows and notes are collected under it. */
  begin(taskId: EvidenceTaskId, title: string): CaseReport {
    const rep: CaseReport = this.reports.get(taskId) ?? { taskId, title, status: "pass", notes: [], rows: [] };
    this.reports.set(taskId, rep);
    this.current = rep;
    return rep;
  }

  /** The row indices a case added since `from` (for alias copies). */
  rowsOf(taskId: EvidenceTaskId): readonly EvidenceRow[] {
    return (this.reports.get(taskId)?.rows ?? []).map((i) => this.rows[i] as EvidenceRow);
  }

  /** Copies a case's rows to an alias task id (a §19.1 scripted task that IS a §13.2 attack), same hashes and traces. */
  alias(from: EvidenceTaskId, to: EvidenceTaskId, title: string): void {
    const src = this.reports.get(from);
    const rep = this.begin(to, title);
    for (const row of this.rowsOf(from)) this.add(to, { ...row, taskId: to, title: `${title} | ${row.title}`.slice(0, 200) });
    if (src) {
      rep.status = src.status;
      if (src.reason) rep.reason = src.reason;
      rep.notes.push(`rows copied from ${from} (same run, same tx hashes and traces)`);
    }
  }

  note(text: string): void {
    this.current?.notes.push(text);
  }

  /** Validates and keeps a row; a failed outcome fails the case. */
  add(taskId: EvidenceTaskId, row: EvidenceRow): EvidenceRow {
    const parsed = EvidenceRow.parse(row);
    this.rows.push(parsed);
    const rep = this.reports.get(taskId);
    if (rep) {
      rep.rows.push(this.rows.length - 1);
      if (parsed.outcome === "fail" && rep.status === "pass") rep.status = "fail";
    }
    return parsed;
  }

  row(deployment: Deployment, r: RowInput): EvidenceRow {
    const base = {
      taskId: r.taskId,
      title: r.title.slice(0, 200),
      expected: r.expected,
      ...(r.expectedError ? { expectedError: r.expectedError } : {}),
      outcome: r.ok ? ("pass" as const) : ("fail" as const),
      chainId: deployment.chainId,
      deploymentId: deployment.deploymentId,
      ...(r.decisionId ? { decisionId: r.decisionId } : {}),
      ...(r.traceId ? { traceId: r.traceId } : {}),
      ...(r.payoutId ? { payoutId: r.payoutId } : {}),
      artifacts: [...(r.artifacts ?? [])],
    };
    const tx = r.facts ?? r.anchor;
    const txPart = tx
      ? {
          txHash: tx.txHash,
          block: tx.block,
          contract: tx.contract,
          function: tx.function,
          ...(eventSummary(tx) ? { decodedEvent: eventSummary(tx) } : {}),
          ...(revertSummary(tx) ? { revertReason: revertSummary(tx) } : {}),
          ...(this.explorerUrl(tx.txHash) ? { explorerUrl: this.explorerUrl(tx.txHash) } : {}),
        }
      : { contract: "", function: "" };
    const layer = r.facts ? (r.facts.status === "success" ? "onchain_success" : "onchain_revert") : (r.layer ?? "offchain");
    return this.add(r.taskId, { ...base, ...txPart, layer } as EvidenceRow);
  }

  /** An honest "not run" row: offchain, outcome fail, the reason in not-run/<taskId>.json. Never a pass. */
  notRun(deployment: Deployment, taskId: EvidenceTaskId, title: string, reason: string, artifacts: readonly string[] = []): void {
    const rep = this.reports.get(taskId);
    const partial = rep !== undefined && rep.rows.length > 0;
    const prior = rep?.status;
    const rel = this.write(`not-run/${taskId}${partial ? "-variant" : ""}.json`, { taskId, title, reason, target: this.chain.target });
    this.row(deployment, { taskId, title: `NOT RUN: ${title}`.slice(0, 200), expected: "refused", ok: false, layer: "offchain", artifacts: [rel, ...artifacts] });
    if (!rep) return;
    if (partial && prior) {
      rep.status = prior; // the case ran; one variant could not run on this target
      rep.notes.push(`variant not run: ${reason}`);
    } else {
      rep.status = "not_run";
      rep.reason = reason;
    }
  }

  fail(taskId: EvidenceTaskId, reason: string): void {
    const rep = this.reports.get(taskId);
    if (rep) {
      rep.status = "fail";
      rep.reason = rep.reason ? `${rep.reason}; ${reason}` : reason;
    }
  }

  finish(meta: Record<string, unknown>): void {
    this.write("evidence.json", this.rows);
    this.write("report.json", { ...meta, startedAt: this.startedAt, finishedAt: new Date().toISOString(), cases: [...this.reports.values()] });
  }
}
