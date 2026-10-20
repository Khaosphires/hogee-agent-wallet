/**
 * What every case gets: the world, the bundle, a transcript, shared run state, and row helpers that fetch the
 * receipt / trace a row points at and write them into the bundle before the row is kept.
 */
import type { EvidenceTaskId } from "@hogee/core";
import type { Hex } from "viem";
import { Transcript, type Forced } from "../actions";
import { txFacts, type Bundle, type RowInput, type TxFacts } from "../evidence";
import { http, type Http } from "../flows";
import type { Stack } from "../stack";
import type { WebRun } from "../web/run-state";

export interface RunState {
  sessionId?: string;
  draftId?: string;
  planRequestId?: string;
  planActionId?: string;
  openActionId?: string;
  registerActionId?: string;
  supplierRequestId?: string;
  shortlistRequestId?: string;
  /** A LOGISTICS invoice the agent paid (T7, T14, T17). */
  paidLogistics?: { paymentId: string; invoiceId: string; invoiceHash: Hex; amountMinor: string; txHash: Hex };
  /** The plug demo's PLATFORM_FEES payment (T19, D-plug, T7). */
  plug?: { paymentId: string; invoiceId: string; invoiceHash: Hex; amountMinor: string; txHash: Hex };
  /** The early RAISE_CAP loosening (T9, S12). */
  raise?: { exceptionId: string; loosenId: Hex };
  saleEventId?: string;
  /** The compiled draft of D-poison's chat (v2 of the plan; T20 commits it). */
  poisonDraftId?: string;
  /** A world whose cases set it up themselves (the SG world): done, or why it failed (every later case then fails). */
  worldReady?: boolean;
  worldSetupError?: string;
  /** The WEB world's ports and journey state (Anvil only; src/run-web.ts). */
  web?: WebRun;
}

export interface Ctx {
  readonly s: Stack;
  readonly b: Bundle;
  readonly state: RunState;
  readonly h: Http;
  readonly taskId: EvidenceTaskId;
  /** Receipt into the bundle + a row; returns whether the row passed. */
  tx(r: Omit<RowInput, "facts" | "taskId"> & { readonly hash?: Hex; readonly facts?: TxFacts | null }): Promise<boolean>;
  /** A forced-send result as a row: pass iff it was mined as a revert with `expectedError`. */
  forced(title: string, f: Forced, expectedError: NonNullable<RowInput["expectedError"]>, extra?: Partial<RowInput>): Promise<boolean>;
  /** Trace into the bundle + a refusal/offchain row; returns whether the row passed. */
  traced(r: Omit<RowInput, "taskId"> & { readonly traceId: string; readonly traceFacilityId?: string }): Promise<boolean>;
  /** An off-chain row backed by artifacts only (no tx, no trace). */
  plain(r: Omit<RowInput, "taskId">): boolean;
  artifact(name: string, value: unknown): string;
  note(text: string): void;
}

/**
 * `dir` is the case's artifact directory: the task id, or `<id>-<variant>` for a country or WEB variant, so a variant
 * never overwrites the main case's artifacts under the same id.
 */
export function caseContext(s: Stack, b: Bundle, state: RunState, taskId: EvidenceTaskId, dir: string = taskId): Ctx {
  const h = http(new Transcript());
  const withHttp = (artifacts: readonly string[] | undefined): string[] => {
    const rel = h.t.save(b, dir);
    return [...(artifacts ?? []), ...(rel ? [rel] : [])];
  };
  const ctx: Ctx = {
    s,
    b,
    state,
    h,
    taskId,
    async tx(r) {
      const facts = r.facts ?? (r.hash ? await txFacts(s.client, s.deployment, r.hash) : null);
      const { facts: _f, hash: _h, ...rest } = r;
      if (!facts) {
        b.row(s.deployment, { ...rest, taskId, ok: false, layer: "offchain", artifacts: withHttp(r.artifacts) });
        return false;
      }
      const receipt = await b.receipt(s.client, facts);
      const traces = r.traceId ? [await b.trace(s.db, s.facilityId, r.traceId)] : [];
      b.row(s.deployment, { ...rest, taskId, facts, artifacts: [receipt, ...traces, ...withHttp(r.artifacts)] });
      return r.ok;
    },
    async forced(title, f, expectedError, extra = {}) {
      if (!f.facts) {
        const rel = b.write(`artifacts/${taskId}/not-signed-${Date.now()}.json`, { title, refusedToSign: f.refusedToSign });
        b.note(`DEFECT? the forced send was not signed because the call would SUCCEED: ${f.refusedToSign ?? "?"}`);
        b.row(s.deployment, { taskId, title: `${title} (call would succeed: NOT blocked on-chain)`, expected: "revert", expectedError, ok: false, layer: "offchain", artifacts: [rel] });
        return false;
      }
      const ok = f.facts.status === "reverted" && f.facts.revert?.name === expectedError;
      if (!ok) b.note(`expected ${expectedError}, got ${f.facts.status} ${f.facts.revert?.name ?? ""}`);
      return ctx.tx({ title, expected: "revert", expectedError, ok, facts: f.facts, ...extra });
    },
    async traced(r) {
      const trace = await b.trace(s.db, r.traceFacilityId ?? s.facilityId, r.traceId);
      const anchor = r.anchor ? [await b.receipt(s.client, r.anchor)] : [];
      const { traceFacilityId: _tf, ...rest } = r;
      b.row(s.deployment, { ...rest, taskId, layer: r.layer ?? "agent_refusal", artifacts: [trace, ...anchor, ...withHttp(r.artifacts)] });
      return r.ok;
    },
    plain(r) {
      b.row(s.deployment, { ...r, taskId, layer: r.layer ?? "offchain", artifacts: withHttp(r.artifacts) });
      return r.ok;
    },
    artifact(name, value) {
      return b.write(`artifacts/${dir}/${name}.json`, value);
    },
    note(text) {
      b.note(text);
    },
  };
  return ctx;
}

export interface CaseDef {
  readonly id: EvidenceTaskId;
  /** A country variant of the attack run in its own world (e.g. "SG"); its rows are filed under `id`. */
  readonly variant?: string;
  readonly title: string;
  /** The §13.2 layers (or §19.1 expectation) this case shows, for the README coverage table and report.json. */
  readonly layers: string;
  /** Runs only on Anvil; on Sepolia the case is written as not run with this reason. */
  readonly anvilOnly?: string;
  /** §19.1 scripted tasks that are this attack: the case's rows are copied to these ids. */
  readonly aliases?: readonly { readonly id: EvidenceTaskId; readonly title: string }[];
  run(ctx: Ctx): Promise<void>;
}
