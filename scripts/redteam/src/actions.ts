/**
 * The two ways a case acts, plus HTTP with transcripts:
 *   forcedSend    a call the attacker would make, signed by the key that would make it and sent through @hogee/chain's
 *                 crash-safe sender with an explicit gas limit (no eth_estimateGas), so the revert is MINED and has a
 *                 hash (§13.1 principle 6). It uses the normal path: a chain_actions row, a Postgres nonce, the raw tx
 *                 stored before broadcast, and the sender's spend guard (a value-moving call is never signed when its
 *                 eth_call would succeed: then the attack would NOT be blocked on-chain, and the case fails).
 *   policyRefusal the agent's decision layer: a proposal through core evaluateProposal on the API's chain-backed
 *                 policy world, and its verdict traced (actor policy, kind DENIAL), exactly as POST /api/demo/attack
 *                 does for its canned attacks. Nothing is signed.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_FORCED_REVERT_GAS, SpendActionRefusedError, sendForcedRevert, toTxRequest, type HogeeCall, type TxSigner } from "@hogee/chain";
import { evaluateProposal, type EvidenceTaskId, type PolicyDecision, type PolicyProposal, type TraceEvent } from "@hogee/core";
import { agentActionsContext, ensureAction, loadActionWorld } from "@hogee/worker";
import type { PolicyContext } from "@hogee/core";
import { appendTrace, newId, policyWorld, type PolicyWorld } from "./api-internals";
import { txFacts, type Bundle, type TxFacts } from "./evidence";
import type { Stack } from "./stack";

let seq = 0;

export interface Forced {
  readonly facts: TxFacts | null;
  /** Set when the sender refused to sign because the call would succeed (the chain would NOT block it). */
  readonly refusedToSign?: string;
}

export async function forcedSend(s: Stack, caseId: EvidenceTaskId | string, call: HogeeCall, signer: TxSigner, gas: bigint = DEFAULT_FORCED_REVERT_GAS): Promise<Forced> {
  seq += 1;
  const id = `rt-${String(caseId).toLowerCase()}-${Date.now().toString(36)}-${seq}`;
  const request = toTxRequest(call, s.deployment.contracts);
  await ensureAction(s.db, { facilityId: s.facilityId, id, kind: call.kind, refId: `redteam:${caseId}`, request, requestJson: { redteam: caseId, forced: true } });
  try {
    const r = await sendForcedRevert(s.db, {
      action: { facilityId: s.facilityId, id },
      request,
      gas,
      account: signer,
      client: s.client,
      chainId: s.deployment.chainId,
      capWei: s.workerDeps().config.maxFeeWei,
      deployment: s.deployment,
      receiptTimeoutMs: s.infra.cfg.target === "anvil" ? 30_000 : 300_000,
    });
    return { facts: await txFacts(s.client, s.deployment, r.txHash) };
  } catch (error: unknown) {
    // Never leave an unsigned row for the relay (it would refuse the unknown kind later).
    await s.db.$client.query("update chain_actions set revert_reason = 'REDTEAM: forced send not signed' where facility_id = $1 and id = $2 and raw_signed_tx is null", [
      s.facilityId,
      id,
    ]);
    if (error instanceof SpendActionRefusedError) return { facts: null, refusedToSign: error.message };
    throw error;
  }
}

export interface Refusal {
  readonly decision: PolicyDecision;
  readonly trace: TraceEvent;
}

export async function policyRefusal(s: Stack, caseId: string, title: string, build: (w: PolicyWorld) => PolicyProposal): Promise<Refusal> {
  const world = await policyWorld(s.deps, { facilityId: s.facilityId, founderId: s.founderId });
  const decision = evaluateProposal(build(world), world.ctx);
  const deny = decision.verdict === "DENY";
  const trace = await appendTrace(s.db, {
    facilityId: s.facilityId,
    traceId: newId("trace"),
    actor: "policy",
    kind: deny ? "DENIAL" : "POLICY_VERDICT",
    verdict: decision.verdict,
    ...(/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(decision.reasonCode) ? { reasonCode: decision.reasonCode } : {}),
    summary: `Red-team ${caseId} (${title}): ${deny ? "refused by policy" : "policy verdict"} ${decision.verdict} ${decision.reasonCode}; nothing signed`.slice(0, 500),
  });
  return { decision, trace };
}

/**
 * The same refusal on the WORKER's decision context (agent-actions: one chain snapshot + the payments table, escrow
 * orders included), for proposals the worker decides itself (escrow funding).
 */
export async function workerPolicyRefusal(s: Stack, caseId: string, title: string, build: (ctx: PolicyContext) => PolicyProposal): Promise<Refusal> {
  const d = s.workerDeps();
  const loaded = await loadActionWorld(d, s.facilityId);
  if (!("world" in loaded)) throw new Error(`the worker has no decision world: ${loaded.status}`);
  const { ctx } = await agentActionsContext(d, loaded.world);
  const decision = evaluateProposal(build(ctx), ctx);
  const deny = decision.verdict === "DENY";
  const trace = await appendTrace(s.db, {
    facilityId: s.facilityId,
    traceId: newId("trace"),
    actor: "policy",
    kind: deny ? "DENIAL" : "POLICY_VERDICT",
    verdict: decision.verdict,
    ...(/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(decision.reasonCode) ? { reasonCode: decision.reasonCode } : {}),
    summary: `Red-team ${caseId} (${title}): worker context, ${deny ? "refused by policy" : "policy verdict"} ${decision.verdict} ${decision.reasonCode}; nothing signed`.slice(0, 500),
  });
  return { decision, trace };
}

/** HTTP transcript of a case (request, status, body), written under artifacts/<case>/http.json. */
export class Transcript {
  readonly entries: { label: string; method: string; path: string; body?: unknown; status: number; response: unknown }[] = [];

  async call(label: string, method: "GET" | "POST", path: string, res: Promise<Response>, body?: unknown): Promise<{ status: number; json: unknown }> {
    const r = await res;
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // a stream or plain text
    }
    this.entries.push({ label, method, path, ...(body === undefined ? {} : { body }), status: r.status, response: typeof parsed === "string" ? parsed.slice(0, 4000) : parsed });
    return { status: r.status, json: parsed };
  }

  /** artifacts/<dir>/http.json, or http-<n>.json when a case sharing the directory already wrote one (never replaced). */
  save(b: Bundle, dir: string): string | null {
    if (this.entries.length === 0) return null;
    let rel = `artifacts/${dir}/http.json`;
    for (let n = 2; existsSync(join(b.dir, rel)); n += 1) rel = `artifacts/${dir}/http-${n}.json`;
    return b.write(rel, this.entries);
  }
}

export function expectOk<T>(r: { status: number; json: unknown }, what: string): T {
  if (r.status >= 300) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  return r.json as T;
}
