/**
 * Shared case helpers: chain reads, call builders with attacker-chosen values, owner/role signatures over the
 * deployment's EIP-712 domain (or a foreign one, T28), the E1 Reader/planner path, the recordDenied anchor of an API
 * denial, and the chat path's planner trace.
 */
import { randomBytes } from "node:crypto";
import {
  buildSpend,
  hashPlanApproval,
  hogeeDomain,
  iPlanRegistryAbi,
  intentId as chainIntentId,
  iTreasuryAbi,
  lineKeyToLineId,
  sequenceInvoiceHash,
  shortIdToBytes32,
  toBytes32Tag,
  type HogeeCall,
  type HogeeDomain,
  type LineKey,
  type OnchainLine,
  type OnchainStage,
  type PlanApprovalMessage,
} from "@hogee/chain";
import { trusted, untrusted, type E1Case, type SpendProposalIn } from "@hogee/core";
import { decodeFunctionData, keccak256, toHex, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { evalCaseService } from "../eval-service";
import { txFacts, type TxFacts } from "../evidence";
import { latestTrace, type Http } from "../flows";
import type { Stack } from "../stack";
import { toolCall, uuidv7, type PolicyWorld } from "../api-internals";
import { expectOk } from "../actions";

export const rand32 = (): Hex => `0x${randomBytes(32).toString("hex")}`;
export const ORIGIN = { trust: "trusted", sensitivity: "public" } as const;
export const UNTRUSTED_ORIGIN = { trust: "untrusted", sensitivity: "public" } as const;

export async function planVersion(s: Stack): Promise<number> {
  return Number(await s.client.readContract({ address: s.deployment.contracts.PlanRegistry.address, abi: iPlanRegistryAbi, functionName: "planVersion" }));
}

/** Treasury.lineSequence: the next pacing slot of a line (what POST /api/proposals/spend takes as pacingSlot). */
export async function lineSequence(s: Stack, lineKey: LineKey): Promise<bigint> {
  return BigInt(await s.client.readContract({ address: s.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: "lineSequence", args: [lineKeyToLineId(lineKey)] }));
}

export async function paused(s: Stack): Promise<boolean> {
  return s.client.readContract({ address: s.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: "paused" });
}

/** Treasury.spend with attacker-chosen values (decision and rationale are any non-zero bytes32). */
export async function spendCall(s: Stack, o: { lineKey: LineKey | "RESERVE"; payeeId: string; amountMinor: bigint; invoiceHash?: Hex; planVersion?: number }): Promise<HogeeCall> {
  return buildSpend({
    lineId: o.lineKey === "RESERVE" ? toBytes32Tag("RESERVE") : lineKeyToLineId(o.lineKey),
    payeeId: shortIdToBytes32(o.payeeId),
    amountMinor: o.amountMinor,
    invoiceHash: o.invoiceHash ?? rand32(),
    planVersion: o.planVersion ?? (await planVersion(s)),
    decisionId: rand32(),
    rationaleHash: rand32(),
  });
}

/** A SPEND proposal shaped like the API's own (core evaluateProposal input). */
export function spendProposal(
  w: PolicyWorld,
  o: { lineKey: LineKey | "RESERVE"; payeeId: string; amountMinor: string; invoiceHash: Hex; payeeTrusted?: boolean; amountTrusted?: boolean; planVersion?: number; pacingSlot?: number },
): SpendProposalIn {
  const lineId = o.lineKey === "RESERVE" ? toBytes32Tag("RESERVE") : lineKeyToLineId(o.lineKey);
  return {
    kind: "SPEND",
    origin: ORIGIN,
    lineKey: trusted(o.lineKey as never, "redteam-proposal"),
    payeeId: o.payeeTrusted === false ? untrusted(o.payeeId as never, "document-text") : trusted(o.payeeId as never, "redteam-proposal"),
    amountMinor: o.amountTrusted ? trusted(o.amountMinor as never, "plan-manifest") : untrusted(o.amountMinor as never, "document-text"),
    invoiceHash: o.invoiceHash,
    intentId: chainIntentId({ planId: w.manifest.planId as Hex, lineId, payeeId: shortIdToBytes32(o.payeeId), invoiceHash: o.invoiceHash, amountMinor: BigInt(o.amountMinor) }).toLowerCase() as never,
    planVersion: o.planVersion ?? w.ctx.planVersion,
    basis: o.pacingSlot !== undefined ? { pacingSlot: o.pacingSlot } : { invoiceId: `inv-redteam-${Date.now()}`, flags: [] },
  };
}

export const pacingHash = (slot: bigint): Hex => sequenceInvoiceHash(slot);

// ---- EIP-712 -------------------------------------------------------------------------------------

export type ContractKey = "PlanRegistry" | "Treasury" | "MilestoneEscrow";

/** The deployment's domain for `contract`, or a foreign one (another chain tag / deployment id: T28). */
export function domainOf(s: Stack, contract: ContractKey, foreign?: { chainTag?: string; deploymentId?: string }): HogeeDomain {
  return hogeeDomain({
    verifyingContract: s.deployment.contracts[contract].address,
    chainTag: toBytes32Tag(foreign?.chainTag ?? s.deployment.chainTag),
    deploymentId: toBytes32Tag(foreign?.deploymentId ?? s.deployment.deploymentId),
  });
}

export async function ecdsa(account: PrivateKeyAccount, digest: Hex): Promise<{ kind: number; data: Hex }> {
  return { kind: 0, data: await account.sign({ hash: digest }) };
}

export interface CommittedPlanCall {
  readonly approval: PlanApprovalMessage;
  readonly lines: OnchainLine[];
  readonly stages: OnchainStage[];
  readonly txHash: Hex;
}

/** The exact PlanApproval, Line[] and Stage[] of the latest mined commitPlan (decoded from its calldata). */
export async function committedPlan(s: Stack): Promise<CommittedPlanCall> {
  const r = await s.db.$client.query<{ tx_hash: string }>(
    // The latest commitPlan the API relayed (forced red-team attempts carry ref_id redteam:* and reverted).
    "select tx_hash from chain_actions where facility_id = $1 and kind = 'PlanRegistry.commitPlan' and state in ('INCLUDED','FINALIZED') and tx_hash is not null and coalesce(ref_id, '') not like 'redteam:%' order by created_at desc limit 1",
    [s.facilityId],
  );
  const hash = r.rows[0]?.tx_hash as Hex | undefined;
  if (!hash) throw new Error("no mined commitPlan for this facility");
  const tx = await s.client.getTransaction({ hash });
  const d = decodeFunctionData({ abi: iPlanRegistryAbi, data: tx.input });
  const [approval, lines, stages] = d.args as unknown as [PlanApprovalMessage, OnchainLine[], OnchainStage[]];
  return { approval: { ...approval }, lines: lines.map((l) => ({ ...l, payeeIds: [...l.payeeIds] })), stages: stages.map((x) => ({ ...x })), txHash: hash };
}

/** A next-version PlanApproval over `lines`/`stages` (same planId, prevPlanHash = the stored planHash). */
export async function nextApproval(s: Stack, base: CommittedPlanCall, over: Partial<PlanApprovalMessage> & { lines?: readonly OnchainLine[]; stages?: readonly OnchainStage[] } = {}): Promise<PlanApprovalMessage> {
  const { hashLines, hashStages } = await import("@hogee/chain");
  const now = await s.clock.now();
  const { lines, stages, ...rest } = over;
  return {
    ...base.approval,
    version: base.approval.version + 1,
    prevPlanHash: base.approval.planHash,
    planHash: rand32(),
    linesHash: hashLines(lines ?? base.lines),
    stagesHash: hashStages(stages ?? base.stages),
    nonce: BigInt(rand32()),
    expiry: now + 3_600n,
    ...rest,
  };
}

export function planDigest(s: Stack, a: PlanApprovalMessage, foreign?: { chainTag?: string; deploymentId?: string }): Hex {
  return hashPlanApproval(domainOf(s, "PlanRegistry", foreign), a);
}

// ---- API paths -----------------------------------------------------------------------------------

export interface E1Result {
  readonly executed: boolean;
  readonly refusalTraceId?: string;
  readonly revertReason?: string;
  readonly lossMinor: string;
}

/**
 * One E1 row through the shipped Reader/planner pipeline: POST /api/eval/case on Anvil (the route is Anvil-only);
 * on Sepolia the same service function in-process (the route's CHAIN=local guard is an eval policy, not a security
 * layer). The scripted model results are queued first.
 */
export async function e1(s: Stack, h: Http, c: E1Case, scripted: readonly unknown[]): Promise<E1Result> {
  s.resetAgent();
  s.agent.queue(...(scripted as never[]));
  if (s.infra.cfg.target === "anvil") return expectOk<E1Result>(await h.post(s.anon, `eval case ${c.caseId}`, "/api/eval/case", { arm: "hogee", case: c }), "eval case");
  const out = await evalCaseService(s.deps, { facilityId: s.facilityId, founderId: s.founderId }, c);
  h.t.entries.push({ label: `evalCase service ${c.caseId}`, method: "POST", path: "(in-process evalCase)", body: { case: c }, status: 200, response: out });
  return out;
}

/** The recordDenied anchor (Denied event) the worker signed for the API denial on `traceId`, after a pump. */
export async function denialAnchor(s: Stack, traceId: string): Promise<{ facts: TxFacts | null; denialId: string | null; actionState: string | null }> {
  await s.pump();
  const d = await s.db.$client.query<{ id: string }>("select id from denials where facility_id = $1 and trace_id = $2", [s.facilityId, traceId]);
  const denialId = d.rows[0]?.id ?? null;
  if (!denialId) return { facts: null, denialId: null, actionState: null };
  const a = await s.db.$client.query<{ tx_hash: string | null; state: string }>(
    "select tx_hash, state from chain_actions where facility_id = $1 and kind = 'Treasury.recordDenied' and ref_id = $2 order by created_at desc limit 1",
    [s.facilityId, denialId],
  );
  const hash = a.rows[0]?.tx_hash as Hex | null | undefined;
  return { facts: hash ? await txFacts(s.client, s.deployment, hash) : null, denialId, actionState: a.rows[0]?.state ?? null };
}

/** POST /api/chat; returns the stream text and the planner's PROPOSAL trace of this turn. */
export async function chatTurn(s: Stack, h: Http, sessionId: string, message: string, scripted: readonly unknown[] = []): Promise<{ status: number; text: string; traceId: string | null; modelCalls: number }> {
  s.resetAgent();
  const before = s.agent.calls();
  const since = new Date(Date.now() - 1000);
  s.agent.queue(...(scripted as never[]));
  const res = await s.founder.post("/api/chat", { sessionId, message });
  const text = await res.text();
  h.t.entries.push({ label: "chat", method: "POST", path: "/api/chat", body: { sessionId, message }, status: res.status, response: text.slice(0, 4000) });
  const t = await latestTrace(s, "actor = 'planner' and kind = 'PROPOSAL' and ts >= $2", [since]);
  return { status: res.status, text, traceId: t?.traceId ?? null, modelCalls: s.agent.calls() - before };
}

const ROUTER_PROBE_SESSION = "01a14202-2800-7000-8000-0000000c4a7e";
const routerCache = new WeakMap<Stack, boolean>();

/**
 * Whether this app routes a founder's free text through the chat-first skill router (v-chat-server): after a plan is
 * committed, every text turn first spends one model call on classifySkill, so a scripted planner result must be
 * preceded by a chooseSkill result ("plan" hands the turn to the planner). Probed once per world with a harmless button
 * press on a session of its own: the pre-merge stub answers 501 NOT_IMPLEMENTED; the integrated tree answers it.
 */
export async function routesChatText(s: Stack): Promise<boolean> {
  const known = routerCache.get(s);
  if (known !== undefined) return known;
  const res = await s.founder.post("/api/chat", { sessionId: ROUTER_PROBE_SESSION, action: { type: "show_cfo", actionId: uuidv7(), view: "overview" } });
  await res.text();
  const routed = res.status !== 501;
  routerCache.set(s, routed);
  return routed;
}

/** The scripted results for a text turn after the plan is committed: the router's skill first when there is a router. */
export async function afterCommit(s: Stack, skill: "plan" | "help" | "out_of_scope", then: readonly unknown[] = []): Promise<unknown[]> {
  return (await routesChatText(s)) ? [toolCall("chooseSkill", { skill, candidateRanks: null, cfoView: null }), ...then] : [...then];
}

export const textOf = (stream: string): string =>
  stream
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)) as { type: string; delta?: string })
    .filter((c) => c.type === "text-delta")
    .map((c) => c.delta ?? "")
    .join("");

export const invoiceHashOf = (label: string): Hex => keccak256(toHex(`hogee:redteam:${label}:${Date.now()}`));
