/**
 * Check 9 "refusals" and check 10 "recorded denials":
 *   refusals — every step expected to succeed was mined with status 1 (a probe-only step: its eth_call succeeded and
 *     nothing was sent), and every expected refusal was refused in one of the two ways FISCO can refuse (mined with
 *     status 0, or refused at the RPC with no receipt and no nonce consumed); its eth_call probe failed; its state
 *     reads did not change; and its error is derived OFFLINE from the catalogue rule and the pack (plan caps, the
 *     agent, recovered signers, the pause, the FISCO domain, and for the chain's own refusals the regulator's G and V
 *     steps: govern.ts) — a probe's error text is only compared when it names a Hogee error; a chain refusal is
 *     always mined (status 0, the nonce consumed) and its probe must report that refusal (the RPC error code decides). A refusal at the RPC leaves no receipt to show it was
 *     the contract that refused (FISCO 3.17.1 mines reverts), so the node's error must name the derived error and no
 *     other Hogee error;
 *   recorded denials — each recordDenied names its refusal: proposalHash = keccak256(the refused calldata), reasonCode
 *     = the refusal's error, the catalogue's line; its Denied event repeats them, with lineDenials recomputed from the
 *     earlier denials of that line inside the line's window (1 day without a line), and no circuit trip.
 */
import { keccak256, type Hex } from "viem";
import { passkeyProblem, recoverEcdsa } from "../crypto";
import { bytes32ToTag, Problems, sameHex, tagToBytes32, type VerifyCheck } from "../util";
import { denialLineIdOf, expectedErrorsFor, isChainRefusal, reasonCodeOf, type HogeeError, type RefusalError } from "./catalogue";
import { assertionOf, deploymentTag, fiscoDigest, signedPartsOf, stepOf, timeWindow, type Ctx, type MirrorStep } from "./context";
import { deriveChainRefusal } from "./govern";
import { founderKeyOf } from "./plan";
import { stepLabel } from "./pack";

export const REFUSALS_CHECK = "refusals";
export const DENIALS_CHECK = "recorded denials";

/** IHogeeErrors names a probe may report (only these are compared). */
const HOGEE_ERRORS = new Set(["PlanInvariantViolated", "StalePlan", "PayeeNotBound", "PayeeCooling", "CapExceeded", "LineExpired", "DuplicateIntent", "DuplicateInvoice", "DuplicateSale", "NotOwner", "NotLender", "NotAgent", "NotOracle", "AgentExpired", "ReserveLocked", "TimelockActive", "Paused", "MilestoneLocked", "EvidenceMissing", "AmountExceedsSchedule", "SignatureExpired", "InvalidSignature", "CircuitOpen", "FounderKeyAlreadySet", "MissingDecision", "SettlementClosed", "EscrowOnly"]);
const DEFAULT_DENIAL_WINDOW = 86_400n;

/** The Hogee error names a node's message mentions, as whole words ("execution reverted: NotOwner()" → NotOwner). */
const errorsNamedIn = (message: string): Set<string> => new Set((message.match(/[A-Za-z]+/g) ?? []).filter((w) => HOGEE_ERRORS.has(w)));

const lineOf = (ctx: Ctx, lineId: unknown) => ctx.pack.plan.manifest.lines.find((l) => sameHex(tagToBytes32(l.lineKey), String(lineId)));
const isAgent = (ctx: Ctx, s: MirrorStep): boolean => sameHex(s.tx?.parsed?.from, ctx.pack.plan.manifest.agent.address);
const pausedBefore = (ctx: Ctx, seq: number): boolean => {
  const ev = ctx.view.events.filter((e) => e.seq < seq && (e.name === "TreasuryPaused" || e.name === "Unpaused") && /^0x0{64}$/.test(String(e.args.lineId)));
  return ev.at(-1)?.name === "TreasuryPaused";
};

type Derived = { readonly errors: readonly RefusalError[] } | { readonly why: string };

function spendRule(ctx: Ctx, s: MirrorStep, paused: boolean): Derived {
  const a = s.tx?.call?.args ?? [];
  if (!isAgent(ctx, s)) return { why: "not sent by the plan's agent" };
  if (paused) return pausedBefore(ctx, s.step.seq) ? { errors: ["Paused"] } : { why: "no treasury pause precedes it" };
  if (pausedBefore(ctx, s.step.seq)) return { why: "the treasury is paused, so the cap is never reached" };
  const line = lineOf(ctx, a[0]);
  if (!line || line.escrowOnly) return { why: "not an open, non-escrow line of the plan" };
  if (!line.payeeIds.some((x) => sameHex(tagToBytes32(x), String(a[1])))) return { why: "the payee is not listed on the line" };
  if (/^0x0{64}$/.test(String(a[5])) || /^0x0{64}$/.test(String(a[6])) || Number(a[4]) !== ctx.pack.plan.manifest.version) return { why: "decision, rationale or plan version would fail first" };
  return BigInt(a[2] as bigint) > BigInt(line.perTxCapMinor) ? { errors: ["CapExceeded"] } : { why: `the amount is within the per-tx cap ${line.perTxCapMinor}` };
}

function ownerRule(ctx: Ctx, s: MirrorStep): Derived {
  const parts = signedPartsOf(s.tx?.call ?? null);
  if (!parts || parts.kind !== "PlanApproval" || parts.sig.kind !== 0) return { why: "not a commitPlan with an ECDSA signature" };
  const st = parts.struct as Record<string, unknown>;
  const t = timeWindow(ctx, s.step.seq);
  if (!sameHex(String(st.deploymentId), deploymentTag(ctx)) || !t || t.to > BigInt(st.expiry as bigint)) return { why: "the envelope (deployment id, expiry) would refuse it first" };
  const digest = fiscoDigest(ctx, "PlanApproval", st, "PlanRegistry");
  const signer = digest.startsWith("0x") ? recoverEcdsa(digest as Hex, parts.sig.data) : null;
  return signer && sameHex(signer, ctx.pack.plan.manifest.agent.address) ? { errors: ["NotOwner"] } : { why: "the signature does not recover to the plan's agent" };
}

function raiseRule(ctx: Ctx, s: MirrorStep): Derived {
  const [kind, target, value] = (s.tx?.call?.args ?? []) as readonly [number, string, bigint];
  const line = lineOf(ctx, target);
  if (!isAgent(ctx, s) || (kind !== 1 && kind !== 2) || !line) return { why: "not the agent lowering a cap of a plan line" };
  const cap = BigInt(kind === 1 ? line.perTxCapMinor : line.windowCapMinor);
  return value > cap ? { errors: ["NotOwner"] } : { why: "the new value does not raise the cap" };
}

function foreignRule(ctx: Ctx, s: MirrorStep, p: Problems): Derived {
  const parts = signedPartsOf(s.tx?.call ?? null);
  if (!parts || parts.kind !== "MilestoneRelease" || isAgent(ctx, s)) return { why: "not a relayed releaseMilestone" };
  const st = parts.struct as Record<string, unknown>;
  if (!sameHex(String(st.deploymentId), deploymentTag(ctx))) return { why: "the deployment id would refuse it" };
  const a = assertionOf(parts.sig);
  const key = founderKeyOf(ctx, new Problems("unused"));
  const digest = fiscoDigest(ctx, "MilestoneRelease", st, "MilestoneEscrow");
  if (!a || !key || !digest.startsWith("0x")) return { why: "no passkey signature or founder key to test" };
  if (passkeyProblem(digest as Hex, a, key) === null) return { why: "the signature VERIFIES under the FISCO domain" };
  void p;
  return { errors: expectedErrorsFor(s.entry as NonNullable<MirrorStep["entry"]>, timeWindow(ctx, s.step.seq), BigInt(st.expiry as bigint)) };
}

function derive(ctx: Ctx, s: MirrorStep, p: Problems): Derived {
  switch (s.entry?.rule) {
    case "per-tx-cap":
      return spendRule(ctx, s, false);
    case "paused":
      return spendRule(ctx, s, true);
    case "agent-releases":
      return isAgent(ctx, s) ? { errors: ["MilestoneLocked"] } : { why: "not sent by the plan's agent" };
    case "agent-signs-owner":
      return ownerRule(ctx, s);
    case "raise-needs-owner":
      return raiseRule(ctx, s);
    case "foreign-domain":
      return foreignRule(ctx, s, p);
    case "account-frozen":
    case "method-banned":
      return deriveChainRefusal(ctx, s);
    default:
      return { why: "no catalogue rule" };
  }
}

function checkRefusal(ctx: Ctx, s: MirrorStep, p: Problems): boolean {
  const { step } = s;
  const label = stepLabel(step);
  const before = p.count;
  if (step.outcome.kind === "mined") p.add(`${label}: an expected refusal SUCCEEDED`);
  if (step.probe.ok) p.add(`${label}: its eth_call probe succeeded`);
  if (step.reads.length === 0) p.add(`${label}: no state reads around the refusal`);
  for (const r of step.reads) if (r.before !== r.after) p.add(`${label}: ${r.label} changed (${r.before} → ${r.after})`);
  if (step.outcome.kind === "rpc-refused" && step.nonce.after !== step.nonce.before) p.add(`${label}: refused at the RPC, yet the sender's nonce moved`);
  if (step.outcome.kind === "mined-reverted" && step.nonce.after !== step.nonce.before + 1) p.add(`${label}: mined, yet the nonce did not move by one`);
  if (isChainRefusal(s.entry?.expectedError)) {
    if (step.outcome.kind !== "mined-reverted") p.add(`${label}: the chain refuses by mining with status 0, not ${step.outcome.kind}`);
    if (step.probe.error !== s.entry?.expectedError) p.add(`${label}: the probe reported ${step.probe.error ?? "nothing"}, not ${s.entry?.expectedError}`);
  }
  const d = derive(ctx, s, p);
  if ("why" in d) p.add(`${label}: the rule ${s.entry?.rule ?? "(none)"} does not explain this refusal: ${d.why}`);
  else {
    if (!step.expectedError || !d.errors.includes(step.expectedError as RefusalError)) p.add(`${label}: expectedError ${step.expectedError ?? "(none)"} is not what the rule derives (${d.errors.join(" or ")})`);
    const said = step.probe.error;
    if (said && HOGEE_ERRORS.has(said) && !d.errors.includes(said as RefusalError)) p.add(`${label}: the probe reported ${said}, the rule derives ${d.errors.join(" or ")}`);
    if (step.outcome.kind === "rpc-refused") {
      const named = errorsNamedIn(step.outcome.rpcError?.message ?? "");
      if (!step.expectedError || named.size !== 1 || !named.has(step.expectedError)) p.add(`${label}: refused at the RPC, but the node's error does not name ${step.expectedError ?? "the derived error"} alone`);
    }
  }
  return p.count === before;
}

export function checkRefusals(ctx: Ctx): VerifyCheck {
  const p = new Problems(REFUSALS_CHECK);
  let refused = 0;
  let explained = 0;
  let probes = 0;
  for (const s of ctx.view.steps) {
    if (s.step.expected === "ok") {
      const want = s.entry?.probeOnly ? "probe-only" : "mined";
      if (s.step.outcome.kind !== want) p.add(`${stepLabel(s.step)}: expected to succeed (${want}), but ${s.step.outcome.kind}`);
      if (want === "probe-only" && !s.step.probe.ok) p.add(`${stepLabel(s.step)}: a probe-only call whose eth_call failed`);
      if (want === "probe-only") probes += 1;
      continue;
    }
    refused += 1;
    if (checkRefusal(ctx, s, p)) explained += 1;
  }
  return p.result(`${refused} refusals refused, reads unchanged, errors derived offline (${explained} explained); every expected success mined, ${probes} probe-only calls passed and were not sent`);
}

// ---- recorded denials -------------------------------------------------------------------------------------------

function windowOf(ctx: Ctx, lineId: string): bigint {
  const line = lineOf(ctx, lineId);
  return line && !/^0x0{64}$/.test(lineId) ? BigInt(line.windowSeconds) : DEFAULT_DENIAL_WINDOW;
}

export function checkDenials(ctx: Ctx): VerifyCheck {
  const p = new Problems(DENIALS_CHECK);
  const history = new Map<string, bigint[]>();
  let n = 0;
  for (const s of ctx.view.steps) {
    const linked = s.entry?.recordsDenialOf;
    if (!linked) continue;
    const label = stepLabel(s.step);
    const ref = stepOf(ctx, linked);
    const call = s.tx?.call;
    const refData = ref?.tx?.parsed?.data;
    if (!ref || ref.step.seq >= s.step.seq || !refData || call?.name !== "recordDenied") {
      p.add(`${label}: no earlier refusal ${linked} with calldata, or not a recordDenied`);
      continue;
    }
    const [lineId, decisionId, reasonCode, proposalHash] = call.args as readonly [string, string, string, string];
    const wantLine = denialLineIdOf(s.entry as NonNullable<MirrorStep["entry"]>);
    const reason = ref.step.expectedError ? reasonCodeOf(ref.step.expectedError as HogeeError) : null;
    if (!sameHex(lineId, wantLine)) p.add(`${label}: line ${bytes32ToTag(lineId) ?? lineId}, the catalogue says ${s.entry?.line ?? "(none)"}`);
    if (!reason || !sameHex(reasonCode, reason)) p.add(`${label}: reasonCode is not ${linked}'s error`);
    if (!sameHex(proposalHash, keccak256(refData))) p.add(`${label}: proposalHash is not keccak256(${linked}'s calldata)`);
    if (/^0x0{64}$/.test(decisionId)) p.add(`${label}: no decision id`);
    const time = s.tx?.blockTime ?? null;
    const key = lineId.toLowerCase();
    const prev = (history.get(key) ?? []).slice(-2);
    const count = time === null ? 0 : 1 + prev.filter((t) => time < t + windowOf(ctx, key)).length;
    history.set(key, [...(history.get(key) ?? []), ...(time === null ? [] : [time])]);
    const ev = s.tx?.events.filter((e) => e.name === "Denied") ?? [];
    const a = ev[0]?.args;
    if (ev.length !== 1 || !a || !sameHex(a.lineId as string, lineId) || !sameHex(a.decisionId as string, decisionId) || !sameHex(a.reasonCode as string, reasonCode) || !sameHex(a.proposalHash as string, proposalHash)) p.add(`${label}: its Denied event does not repeat the call`);
    else if (Number(a.lineDenials) !== count) p.add(`${label}: lineDenials ${String(a.lineDenials)}, recomputed ${count}`);
    if (s.tx?.events.some((e) => e.name === "CircuitTripped")) p.add(`${label}: tripped the circuit breaker`);
    n += 1;
  }
  return p.result(`${n} denials bind their refusals' calldata, error and line; lineDenials recomputed`);
}
