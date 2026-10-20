/**
 * Check 6 "plan" and check 7 "signatures":
 *   plan — keccak256(JCS(manifest)) = plan.json planHash = its sepoliaPlanHash = the source bundle's committed v1
 *     planHash (plans.json), and the manifest equals the source's (diffFromSepolia recomputed: empty); the approval's
 *     typed data is canonical, on the FISCO PlanRegistry domain (domainSalt("fisco", deploymentId)), carries the
 *     manifest's fields (linesHash, stagesHash, totals, agent) and hashes to its digest; S3's commitPlan calldata
 *     carries that approval, the manifest's lines and stages and that signature; S3's PlanCommitted repeats them; the
 *     agent role is the plan's agent;
 *   signatures — the founder key is the lender-sent registerFounderKey calldata of S2 (= deployment.json); every
 *     passkey step that succeeded verifies (P-256, low-s, UP+UV, challenge = digest) under the FISCO domain of its
 *     verifying contract; S12's StageRelease recovers (ECDSA, low-s) to the lender.
 */
import type { Hex } from "viem";
import { hashObject, type PlanManifest } from "@hogee/core";
import type { SignatureEntry } from "../bundle";
import { passkeyProblem, recoverEcdsa } from "../crypto";
import { digestOf, domainSalt, typesAreCanonical, viemMessage } from "../eip712";
import { approvalFieldsOf, onchainLines, onchainStages, sigDataOf } from "../plans";
import { Problems, sameHex, tagToBytes32, type VerifyCheck } from "../util";
import { assertionOf, fiscoAddress, fiscoDigest, sameJson, signedPartsOf, stepOf, type Ctx } from "./context";
import { FISCO_CHAIN_TAG, stepLabel } from "./pack";

export const PLAN_CHECK = "plan";
export const SIGNATURES_CHECK = "signatures";

/** RFC 6901 pointers where two JSON values differ (leaves only; arrays by index). */
export function jsonDiff(a: unknown, b: unknown, at = ""): string[] {
  const esc = (k: string) => k.replaceAll("~", "~0").replaceAll("/", "~1");
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => jsonDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}/${esc(k)}`));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [at || "/"];
}

function sourcePlan(ctx: Ctx, p: Problems): { planHash: string; manifest: PlanManifest } | null {
  const plans = ctx.bundle?.parsed?.plans;
  if (!plans) {
    p.add("no parsed source bundle: the source planHash is unknown");
    return null;
  }
  const v1 = plans.find((x) => x.version === 1 && (x.status === "COMMITTED" || x.status === "SUPERSEDED"));
  if (!v1) p.add("the source bundle has no committed v1 plan");
  return v1 ?? null;
}

function checkApproval(ctx: Ctx, m: PlanManifest, p: Problems): void {
  const { typedData: td, digest } = ctx.pack.plan.approval;
  const d = ctx.pack.deployment;
  if (td.primaryType !== "PlanApproval" || !typesAreCanonical(td)) p.add("the approval's typed data is not the canonical PlanApproval");
  if (td.domain.salt !== domainSalt(FISCO_CHAIN_TAG, d.deploymentId) || !sameHex(td.domain.verifyingContract, fiscoAddress(ctx, "PlanRegistry"))) p.add("the approval is not on the FISCO PlanRegistry's domain");
  for (const [k, v] of Object.entries(approvalFieldsOf(m))) if (td.message[k] !== v) p.add(`the approval's ${k} is not the manifest's`);
  if (td.message.deploymentId !== tagToBytes32(d.deploymentId)) p.add("the approval's deploymentId is not this deployment");
  if (digestOf(td) !== digest) p.add("the approval's digest is not the EIP-712 digest of its typed data");
}

function checkCommit(ctx: Ctx, m: PlanManifest, planHash: string, p: Problems): void {
  const s3 = stepOf(ctx, "S3");
  const call = s3?.tx?.call;
  if (!s3 || !call || call.name !== "commitPlan") {
    p.add("S3 carries no commitPlan call");
    return;
  }
  const [approval, lines, stages, founder] = call.args;
  const message = viemMessage("PlanApproval", ctx.pack.plan.approval.typedData.message);
  if (typeof message === "string" || !sameJson(approval, message)) p.add("S3's commitPlan carries another PlanApproval than plan.json's");
  if (!sameJson(lines, onchainLines(m)) || !sameJson(stages, onchainStages(m))) p.add("S3's commitPlan carries other lines or stages than the manifest");
  const want = sigDataOf({ submission: ctx.pack.plan.approval.submission } as SignatureEntry);
  const sig = founder as { kind: number; data: string };
  if (!want || sig.kind !== want.kind || !sameHex(sig.data, want.data)) p.add("S3's commitPlan carries another signature than plan.json's");
  const ev = s3.tx?.events.find((e) => e.name === "PlanCommitted");
  const f = approvalFieldsOf(m);
  const a = ev?.args;
  const same = a && sameHex(a.planHash as string, planHash) && sameHex(a.prevPlanHash as string, f.prevPlanHash) && sameHex(a.countryPackHash as string, f.countryPackHash) && sameHex(a.linesHash as string, f.linesHash) &&
    sameHex(a.stagesHash as string, f.stagesHash) && sameHex(a.agent as string, f.agent) && sameHex(a.planId as string, f.planId) && String(a.totalMinor) === f.totalMinor && String(a.agentExpiry) === f.agentExpiry &&
    String(a.reserveBps) === f.reserveBps && Number(a.version) === 1;
  if (!same) p.add("S3's PlanCommitted event does not repeat the manifest");
}

export function checkPlan(ctx: Ctx): VerifyCheck {
  const p = new Problems(PLAN_CHECK);
  const plan = ctx.pack.plan;
  const m = plan.manifest;
  const hash = hashObject(m);
  if (hash !== plan.planHash) p.add("planHash is not keccak256(JCS(manifest))");
  if (plan.sepoliaPlanHash !== plan.planHash) p.add("planHash is not the source planHash plan.json states");
  const src = sourcePlan(ctx, p);
  if (src) {
    if (src.planHash !== plan.sepoliaPlanHash) p.add("plan.json's sepoliaPlanHash is not the source bundle's committed v1 planHash");
    const diff = jsonDiff(src.manifest, m);
    if (diff.length > 0) p.add(`the manifest differs from the source's at ${diff.slice(0, 4).join(", ")}`);
    if (!sameJson(diff, plan.diffFromSepolia)) p.add("diffFromSepolia is not the recomputed difference from the source manifest");
  }
  if (!sameHex(ctx.pack.deployment.roles.agent, m.agent.address)) p.add("the agent role is not the plan's agent");
  checkApproval(ctx, m, p);
  checkCommit(ctx, m, hash, p);
  return p.result(`planHash ${hash.slice(0, 10)}… = the source's; approval, commitPlan calldata and PlanCommitted bind it`);
}

/** The founder key S2 registered (its calldata), when S2 is a successful lender-sent registerFounderKey. */
export function founderKeyOf(ctx: Ctx, p: Problems): { qx: Hex; qy: Hex; ownerEOA: string } | null {
  const s2 = stepOf(ctx, "S2");
  const call = s2?.tx?.call;
  if (!s2 || call?.name !== "registerFounderKey" || s2.step.outcome.kind !== "mined" || !sameHex(s2.tx?.parsed?.from, ctx.pack.deployment.roles.lender)) {
    p.add("no successful lender-sent registerFounderKey (S2)");
    return null;
  }
  const [qx, qy, ownerEOA] = call.args as readonly [Hex, Hex, string];
  const k = ctx.pack.deployment.founderKey;
  if (!sameHex(qx, k.qx) || !sameHex(qy, k.qy) || !sameHex(ownerEOA, k.ownerEOA)) p.add("deployment.json's founderKey is not S2's registerFounderKey calldata");
  return { qx: qx.toLowerCase() as Hex, qy: qy.toLowerCase() as Hex, ownerEOA: ownerEOA.toLowerCase() };
}

export function checkSignatures(ctx: Ctx): VerifyCheck {
  const p = new Problems(SIGNATURES_CHECK);
  const key = founderKeyOf(ctx, p);
  let passkeys = 0;
  let ecdsa = 0;
  for (const s of ctx.view.steps) {
    const { step } = s;
    if (step.outcome.kind !== "mined" || (step.auth !== "passkey" && step.auth !== "ecdsa-lender")) continue;
    const parts = signedPartsOf(s.tx?.call ?? null);
    if (!parts) {
      p.add(`${stepLabel(step)}: no signed struct in its calldata`);
      continue;
    }
    const digest = fiscoDigest(ctx, parts.kind, parts.struct, parts.verifying);
    if (!digest.startsWith("0x")) {
      p.add(`${stepLabel(step)}: ${digest}`);
      continue;
    }
    if (step.auth === "passkey") {
      const a = assertionOf(parts.sig);
      const why = !a ? "not a passkey (kind 1) signature" : !key ? "no founder key" : passkeyProblem(digest as Hex, a, key);
      if (why) p.add(`${stepLabel(step)}: ${why}`);
      else passkeys += 1;
    } else {
      const signer = parts.sig.kind === 0 ? recoverEcdsa(digest as Hex, parts.sig.data) : null;
      if (!signer || !sameHex(signer, ctx.pack.deployment.roles.lender)) p.add(`${stepLabel(step)}: the ${parts.kind} is not signed by the lender (ECDSA, low-s)`);
      else ecdsa += 1;
    }
  }
  return p.result(`${passkeys} passkey signatures verify under the FISCO domain; ${ecdsa} lender ECDSA signature recovers to the lender`);
}
