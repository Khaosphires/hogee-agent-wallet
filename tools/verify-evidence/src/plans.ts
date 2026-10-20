/**
 * Plans, recomputed from JSON:
 *   "plan hashes": planHash = keccak256(utf8(JCS(manifest))) for every plan; committed versions are sequential and
 *     each prevPlanHash is the previous version's planHash;
 *   "country pack": keccak256(utf8(JCS(pack))) is the stored hash and the hash every plan commits to;
 *   "plan approvals": each signed PlanApproval commits to its manifest (planHash, linesHash = keccak256(abi.encode
 *     (Line[])), stagesHash, totals, agent); the commitPlan calldata carries that approval, those lines and stages
 *     and the stored signature (never skipped for a COMMITTED or SUPERSEDED plan); the PlanCommitted event in THAT
 *     commit tx's receipt repeats them (run-6 v-6: not one from any receipt).
 */
import { decodeFunctionData, encodeAbiParameters, keccak256, type Hex } from "viem";
import { hashObject, ZERO_HEX32, type PasskeyAssertion, type PlanManifest } from "@hogee/core";
import { hogeeCallsAbi, webAuthnAuthParams } from "./abi";
import type { ParsedBundle, PlanEntry, SignatureEntry } from "./bundle";
import type { ChainEvent } from "./chain";
import { parseSignedTx } from "./crypto";
import { viemMessage } from "./eip712";
import { Problems, sameHex, tagToBytes32, type VerifyCheck } from "./util";

const METRIC = { salesMinor: 1, orders: 2 } as const;

export const lineComponents = [
  { name: "lineId", type: "bytes32" },
  { name: "amountMinor", type: "uint128" },
  { name: "perTxCapMinor", type: "uint128" },
  { name: "windowCapMinor", type: "uint128" },
  { name: "windowSeconds", type: "uint32" },
  { name: "validUntil", type: "uint64" },
  { name: "pacingMinor", type: "uint128" },
  { name: "escrowOnly", type: "bool" },
  { name: "payeeIds", type: "bytes32[]" },
] as const;

export const stageComponents = [
  { name: "stageId", type: "bytes32" },
  { name: "releaseMinor", type: "uint128" },
  { name: "metric", type: "uint8" },
  { name: "target", type: "uint128" },
  { name: "deadline", type: "uint64" },
] as const;

/** The ABI Line[] of a manifest (array order kept), as commitPlan receives and linesHash commits to. */
export function onchainLines(m: PlanManifest) {
  return m.lines.map((l) => ({
    lineId: tagToBytes32(l.lineKey),
    amountMinor: BigInt(l.amountMinor),
    perTxCapMinor: BigInt(l.perTxCapMinor),
    windowCapMinor: BigInt(l.windowCapMinor),
    windowSeconds: Number(l.windowSeconds),
    validUntil: BigInt(l.validUntil),
    pacingMinor: l.pacing ? BigInt(l.pacing.amountMinor) : 0n,
    escrowOnly: l.escrowOnly,
    payeeIds: l.payeeIds.map(tagToBytes32),
  }));
}

export function onchainStages(m: PlanManifest) {
  return m.stages.map((s) => ({
    stageId: tagToBytes32(s.stageId),
    releaseMinor: BigInt(s.releaseMinor),
    metric: s.gate ? METRIC[s.gate.metric] : 0,
    target: s.gate ? BigInt(s.gate.target) : 0n,
    deadline: s.gate ? BigInt(s.gate.deadline) : 0n,
  }));
}

export const linesHash = (m: PlanManifest): Hex => keccak256(encodeAbiParameters([{ type: "tuple[]", components: lineComponents }], [onchainLines(m)]));
export const stagesHash = (m: PlanManifest): Hex => keccak256(encodeAbiParameters([{ type: "tuple[]", components: stageComponents }], [onchainStages(m)]));

/** The PlanApproval fields a manifest determines (everything but deploymentId, nonce and expiry). */
export function approvalFieldsOf(m: PlanManifest): Record<string, string> {
  return {
    planId: m.planId,
    version: String(m.version),
    prevPlanHash: m.prevPlanHash,
    planHash: hashObject(m),
    countryPackHash: m.countryPackHash,
    linesHash: linesHash(m),
    stagesHash: stagesHash(m),
    totalMinor: m.totalMinor,
    reserveBps: String(m.reserveBps),
    agent: m.agent.address,
    agentExpiry: m.agent.expiresAt,
  };
}

const COMMITTED = new Set(["COMMITTED", "SUPERSEDED"]);

function checkHashes(b: ParsedBundle, p: Problems): void {
  for (const plan of b.plans) {
    const m = plan.manifest;
    if (hashObject(m) !== plan.planHash) p.add(`v${plan.version} (${plan.planRowId}): planHash is not keccak256(JCS(manifest))`);
    if (m.version !== plan.version || m.prevPlanHash !== plan.prevPlanHash || m.countryPackHash !== plan.countryPackHash) p.add(`v${plan.version}: the row disagrees with its manifest`);
  }
  const committed = b.plans.filter((x) => COMMITTED.has(x.status)).sort((x, y) => x.version - y.version);
  committed.forEach((plan, i) => {
    const prev = committed[i - 1];
    if (plan.version !== i + 1) p.add(`committed versions are not 1..n (found v${plan.version} at position ${i + 1})`);
    if (plan.prevPlanHash !== (prev ? prev.planHash : ZERO_HEX32)) p.add(`v${plan.version}: prevPlanHash does not chain to v${prev?.version ?? 0}`);
    if (prev && prev.manifest.planId !== plan.manifest.planId) p.add(`v${plan.version}: another planId than v${prev.version}`);
  });
}

function checkCountryPack(b: ParsedBundle, p: Problems): string {
  const hashes = new Set(b.plans.map((x) => x.countryPackHash));
  const pack = b.countryPack;
  if (!pack) {
    if (hashes.size > 0) p.add("the country pack the plans commit to is not in the bundle");
    return "no plans";
  }
  if (hashObject(pack.pack) !== pack.countryPackHash) p.add("country-pack.json: countryPackHash is not keccak256(JCS(pack))");
  for (const h of hashes) if (h !== pack.countryPackHash) p.add(`a plan commits to country pack ${h}, not the bundled one`);
  return `${pack.countryCode} pack ${pack.countryPackHash.slice(0, 10)}…`;
}

/** Sig.data the founder's stored submission encodes to (what commitPlan must carry). */
export function sigDataOf(s: SignatureEntry): { kind: number; data: Hex } | null {
  const sub = s.submission;
  if (!sub) return null;
  if ("ecdsa" in sub) return { kind: 0, data: sub.ecdsa.signature as Hex };
  const a: PasskeyAssertion = sub.passkey;
  const data = encodeAbiParameters(webAuthnAuthParams, [
    { r: a.r as Hex, s: a.s as Hex, challengeIndex: BigInt(a.challengeIndex), typeIndex: BigInt(a.typeIndex), authenticatorData: a.authenticatorData as Hex, clientDataJSON: a.clientDataJSON },
  ]);
  return { kind: 1, data };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : typeof v === "string" ? v.toLowerCase() : v)) ===
    JSON.stringify(b, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : typeof v === "string" ? v.toLowerCase() : v));
}

function checkCalldata(plan: PlanEntry, sig: SignatureEntry, raw: Hex | null, p: Problems): void {
  if (!raw) {
    if (COMMITTED.has(plan.status)) p.add(`v${plan.version} is ${plan.status} but its commit action carries no signed commitPlan tx`);
    return;
  }
  const tx = parseSignedTx(raw);
  if (typeof tx === "string") return; // reported by "transactions"
  let call: ReturnType<typeof decodeFunctionData<typeof hogeeCallsAbi>>;
  try {
    call = decodeFunctionData({ abi: hogeeCallsAbi, data: tx.data });
  } catch {
    p.add(`v${plan.version}: the commit tx is not commitPlan`);
    return;
  }
  if (call.functionName !== "commitPlan") {
    p.add(`v${plan.version}: the commit tx calls ${call.functionName}`);
    return;
  }
  const [approval, lines, stages, founder] = call.args;
  const message = viemMessage("PlanApproval", sig.typedData.message);
  if (typeof message === "string" || !sameJson(approval, message)) p.add(`v${plan.version}: commitPlan carries another PlanApproval than the signed one`);
  if (!sameJson(lines, onchainLines(plan.manifest)) || !sameJson(stages, onchainStages(plan.manifest))) p.add(`v${plan.version}: commitPlan carries other lines or stages than the manifest`);
  const want = sigDataOf(sig);
  if (!want || founder.kind !== want.kind || !sameHex(founder.data, want.data)) p.add(`v${plan.version}: commitPlan carries another signature than the stored one`);
}

function checkEvent(plan: PlanEntry, ev: ChainEvent | undefined, p: Problems): void {
  if (!ev) {
    if (COMMITTED.has(plan.status)) p.add(`v${plan.version} is ${plan.status} but its commit tx's receipt has no PlanCommitted event for it`);
    return;
  }
  const a = ev.args;
  const f = approvalFieldsOf(plan.manifest);
  const same =
    sameHex(a.planHash as string, plan.planHash) && sameHex(a.prevPlanHash as string, f.prevPlanHash) && sameHex(a.countryPackHash as string, f.countryPackHash) &&
    sameHex(a.linesHash as string, f.linesHash) && sameHex(a.stagesHash as string, f.stagesHash) && sameHex(a.agent as string, f.agent) && sameHex(a.planId as string, f.planId) &&
    String(a.totalMinor) === f.totalMinor && String(a.agentExpiry) === f.agentExpiry && String(a.reserveBps) === f.reserveBps;
  if (!same) p.add(`v${plan.version}: the PlanCommitted event differs from the manifest`);
}

function checkApprovals(b: ParsedBundle, events: readonly ChainEvent[], p: Problems): number {
  let checked = 0;
  for (const plan of b.plans) {
    // A plan can have more than one commit action (a resent or reverted attempt): use the one the plan row names.
    const attempts = b.chainActions.filter((a) => a.kind === "PlanRegistry.commitPlan" && a.refId === plan.planRowId);
    const action = attempts.find((a) => plan.txHash !== null && sameHex(a.txHash, plan.txHash)) ?? attempts[0];
    const ev = events.find((e) => e.name === "PlanCommitted" && Number(e.args.version) === plan.version && sameHex(e.args.planHash as string, plan.planHash) && sameHex(e.txHash, action?.txHash));
    checkEvent(plan, ev, p);
    if (COMMITTED.has(plan.status) && !sameHex(plan.txHash, action?.txHash)) p.add(`v${plan.version}: the plan row's tx ${plan.txHash ?? "(none)"} is not its commit action's tx ${action?.txHash ?? "(none)"} (${attempts.length} commit action(s))`);
    const sig = action ? b.signatures.find((s) => s.kind === "PlanApproval" && s.chainActionId === action.actionId) : undefined;
    if (!action || !sig) {
      if (plan.status !== "PENDING_SIGNATURE") p.add(`v${plan.version} (${plan.planRowId}): no signed PlanApproval and commit action in the bundle`);
      continue;
    }
    const want = approvalFieldsOf(plan.manifest);
    for (const [k, v] of Object.entries(want)) if (sig.typedData.message[k] !== v) p.add(`v${plan.version}: the signed PlanApproval.${k} is not the manifest's`);
    checkCalldata(plan, sig, (action.rawSignedTx as Hex | null) ?? null, p);
    checked += 1;
  }
  return checked;
}

export function checkPlans(b: ParsedBundle, events: readonly ChainEvent[]): VerifyCheck[] {
  const hashes = new Problems("plan hashes");
  checkHashes(b, hashes);
  const pack = new Problems("country pack");
  const packDetail = checkCountryPack(b, pack);
  const approvals = new Problems("plan approvals");
  const n = checkApprovals(b, events, approvals);
  return [hashes.result(`${b.plans.length} plan versions recomputed`), pack.result(packDetail), approvals.result(`${n} PlanApprovals bind manifest, calldata and PlanCommitted`)];
}
