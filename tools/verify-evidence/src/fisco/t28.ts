/**
 * Check 11 "T28 cross-chain replay" and check 12 "final state":
 *   T28 — the source bundle verifies (verifyBundle) and is the pinned run, file for file (pack.json sourceBundle);
 *     t28.json's copies equal the bundle's MilestoneRelease signature entry and release tx; that tx carries exactly
 *     that struct and passkey; T28a's calldata is byte-identical to it; the source digest differs from the FISCO
 *     digest of the same struct, and the signature verifies under the source digest and the source founder key but
 *     under neither key on the FISCO digest; T28b is the mirror founder's signature over the SOURCE domain — valid there,
 *     invalid under FISCO's — and is what T28b sent; the milestone stays unreleased until S15 releases it;
 *   final state — recomputed from the events: released = stage 1 at the commit + every StageReleased (10,000 BU),
 *     revenue = the last RevenueRecorded total (2,000 BU), paused (TreasuryPaused, no Unpaused after), and the
 *     regulator's last word on the agent from its G steps (account normal, spend allowed); steps.json's final reads
 *     and catalogue FINAL_READS agree.
 */
import { keccak256, type Hex } from "viem";
import { hashObject } from "@hogee/core";
import { decodeCall } from "../calls";
import { parseSignedTx, passkeyProblem } from "../crypto";
import { digestOf, domainSalt, typesAreCanonical, viemMessage } from "../eip712";
import { sigDataOf } from "../plans";
import { fileBytes, Problems, sameHex, type VerifyCheck } from "../util";
import { catalogueEntry, FINAL_READS } from "./catalogue";
import { fiscoAddress, messageOf, sameJson, signedPartsOf, stepOf, typedDataOf, type Ctx } from "./context";
import { regulatorFinal } from "./govern";
import { founderKeyOf } from "./plan";
import { sourceTxOf } from "./parity";
import { FISCO_CHAIN_TAG } from "./pack";

export const T28_CHECK = "T28 cross-chain replay";
export const FINAL_CHECK = "final state";

function checkSource(ctx: Ctx, p: Problems): boolean {
  const b = ctx.bundle;
  if (!b?.parsed) {
    p.add("no source bundle (--sepolia-bundle) or it does not parse");
    return false;
  }
  if (!b.verified) p.add("the source bundle does not verify (verifyBundle)");
  const c = b.parsed.contracts;
  const s = ctx.source;
  if (c.runId !== s.runId || c.chainId !== s.chainId || c.chainTag !== s.chainTag || c.deploymentId !== s.deploymentId) p.add(`the source bundle is ${c.runId} (${c.chainTag}/${c.deploymentId}), not the pinned ${s.runId}`);
  const pinned = ctx.pack.pack.sourceBundle;
  if (pinned.runId !== s.runId) p.add(`pack.json mirrors ${pinned.runId}, not ${s.runId}`);
  for (const [path, body] of Object.entries(b.files)) if (!Object.hasOwn(pinned.files, path) || pinned.files[path] !== keccak256(fileBytes(body))) p.add(`source bundle file ${path} is not the one pack.json pins`);
  // Own keys only: `in` would count an inherited name (toString, constructor) as a file the bundle holds.
  for (const path of Object.keys(pinned.files)) if (!Object.hasOwn(b.files, path)) p.add(`pack.json pins ${path}, which the source bundle lacks`);
  return true;
}

function checkCopies(ctx: Ctx, p: Problems): { struct: Record<string, unknown> | null } {
  const t = ctx.pack.t28;
  const b = ctx.bundle?.parsed;
  const entry = b?.signatures.find((x) => x.requestId === t.sepoliaSignature.requestId);
  if (!entry || entry.kind !== "MilestoneRelease" || hashObject(entry) !== hashObject(t.sepoliaSignature)) p.add("t28.json's sepoliaSignature is not the source bundle's MilestoneRelease entry");
  const spec = catalogueEntry("T28a")?.sepolia;
  const src = spec ? sourceTxOf(ctx, spec) : null;
  if (!src || !sameHex(src.hash, t.sepoliaTx.hash) || src.raw.toLowerCase() !== t.sepoliaTx.raw.toLowerCase()) p.add("t28.json's sepoliaTx is not the source bundle's milestone release tx");
  const tx = parseSignedTx(t.sepoliaTx.raw as Hex);
  const call = typeof tx === "string" ? null : decodeCall(tx, "MilestoneEscrow");
  const parts = signedPartsOf(call);
  if (!parts || parts.kind !== "MilestoneRelease") {
    p.add("the source release tx is not a releaseMilestone");
    return { struct: null };
  }
  const message = viemMessage("MilestoneRelease", t.sepoliaSignature.typedData.message);
  const want = sigDataOf(t.sepoliaSignature);
  if (typeof message === "string" || !sameJson(parts.struct, message)) p.add("the source release tx carries another struct than the signature entry");
  if (!want || parts.sig.kind !== want.kind || !sameHex(parts.sig.data, want.data)) p.add("the source release tx carries another signature than the entry's passkey assertion");
  const t28a = stepOf(ctx, "T28a");
  if (typeof tx === "string" || !t28a?.tx?.parsed || t28a.tx.parsed.data.toLowerCase() !== tx.data.toLowerCase()) p.add("T28a's calldata is not byte-identical to the source release tx's");
  return { struct: parts.struct as Record<string, unknown> };
}

function sourceFounderKey(ctx: Ctx): { qx: Hex; qy: Hex } | null {
  const reg = ctx.bundle?.parsed?.chainActions.find((a) => a.kind === "PlanRegistry.registerFounderKey" && a.rawSignedTx);
  const tx = reg?.rawSignedTx ? parseSignedTx(reg.rawSignedTx as Hex) : null;
  const call = tx && typeof tx !== "string" ? decodeCall(tx, "PlanRegistry") : null;
  if (call?.name !== "registerFounderKey") return null;
  const [qx, qy] = call.args as readonly [Hex, Hex];
  return { qx: qx.toLowerCase() as Hex, qy: qy.toLowerCase() as Hex };
}

function checkDomains(ctx: Ctx, p: Problems): void {
  const t = ctx.pack.t28;
  const d = ctx.pack.deployment;
  const fiscoKey = founderKeyOf(ctx, new Problems("unused"));
  const srcKey = sourceFounderKey(ctx);
  const escrow = d.sepolia.contracts.MilestoneEscrow;
  const sub = t.sepoliaSignature.submission;
  const a = sub && Object.hasOwn(sub, "passkey") ? (sub as Extract<typeof sub, { passkey: unknown }>).passkey : null;
  const srcDigest = digestOf(t.sepoliaSignature.typedData);
  const onFisco = digestOf(typedDataOf("MilestoneRelease", t.sepoliaSignature.typedData.message, fiscoAddress(ctx, "MilestoneEscrow"), FISCO_CHAIN_TAG, d.deploymentId));
  const sourceDomain = (td: typeof t.t28b.typedData) => td.domain.salt === domainSalt(ctx.source.chainTag, ctx.source.deploymentId) && sameHex(td.domain.verifyingContract, escrow);
  if (!sourceDomain(t.sepoliaSignature.typedData) || srcDigest !== t.sepoliaSignature.digest) p.add("the source signature's digest is not its source-domain EIP-712 digest");
  if (srcDigest === onFisco) p.add("the source and FISCO digests are equal (no domain separation)");
  if (!a || !srcKey || passkeyProblem(srcDigest as Hex, a, srcKey) !== null) p.add("the source signature does not verify under the source digest and founder key");
  for (const k of [srcKey, fiscoKey]) if (a && k && passkeyProblem(onFisco as Hex, a, k) === null) p.add("the source signature VERIFIES under the FISCO digest");
  const td = t.t28b.typedData;
  const fiscoB = digestOf(typedDataOf("MilestoneRelease", td.message, fiscoAddress(ctx, "MilestoneEscrow"), FISCO_CHAIN_TAG, d.deploymentId));
  if (td.primaryType !== "MilestoneRelease" || !typesAreCanonical(td) || !sourceDomain(td) || digestOf(td) !== t.t28b.digest) p.add("T28b's typed data is not a MilestoneRelease on the source domain with its digest");
  if (!fiscoKey || passkeyProblem(t.t28b.digest as Hex, t.t28b.assertion, fiscoKey) !== null) p.add("T28b is not the mirror founder's valid signature over the source domain");
  if (fiscoKey && passkeyProblem(fiscoB as Hex, t.t28b.assertion, fiscoKey) === null) p.add("T28b VERIFIES under the FISCO domain");
  const sent = signedPartsOf(stepOf(ctx, "T28b")?.tx?.call ?? null);
  const want = sigDataOf({ submission: { passkey: t.t28b.assertion } } as never);
  if (!sent || !sameJson(messageOf("MilestoneRelease", sent.struct), td.message) || !want || sent.sig.kind !== 1 || !sameHex(sent.sig.data, want.data)) p.add("T28b's calldata is not t28.json's struct and assertion");
}

function checkUnreleased(ctx: Ctx, struct: Record<string, unknown> | null, p: Problems): void {
  if (!struct) return;
  const s15 = stepOf(ctx, "S15");
  const hit = (e: { name: string; args: Readonly<Record<string, unknown>> }) => e.name === "MilestoneReleased" && sameHex(String(e.args.orderId), String(struct.orderId)) && Number(e.args.idx) === Number(struct.idx);
  const early = ctx.view.events.filter((e) => hit(e) && (!s15 || e.seq < s15.step.seq));
  if (early.length > 0) p.add(`milestone ${String(struct.idx)} was released before S15 (by ${early[0]?.stepId})`);
  if (!s15?.tx?.events.some(hit) || s15.step.outcome.kind !== "mined") p.add("S15 does not release the milestone T28 targeted");
  for (const id of ["T28a", "T28b"]) if (stepOf(ctx, id)?.step.outcome.kind === "mined") p.add(`${id} was accepted`);
}

export function checkT28(ctx: Ctx): VerifyCheck {
  const p = new Problems(T28_CHECK);
  if (!checkSource(ctx, p)) return p.result("");
  const { struct } = checkCopies(ctx, p);
  checkDomains(ctx, p);
  checkUnreleased(ctx, struct, p);
  return p.result("the source bundle verifies; its release signature is valid only under the source domain, T28a/T28b refused, S15 releases");
}

export function checkFinal(ctx: Ctx): VerifyCheck {
  const p = new Problems(FINAL_CHECK);
  const ev = ctx.view.events;
  const committed = ev.filter((e) => e.name === "PlanCommitted" && Number(e.args.version) === 1);
  const stages = ev.filter((e) => e.name === "StageReleased");
  const released = (committed.length === 1 ? BigInt(committed[0]?.args.releasedMinor as bigint) : 0n) + stages.reduce((n, e) => n + BigInt(e.args.amountMinor as bigint), 0n);
  if (committed.length !== 1) p.add(`${committed.length} v1 PlanCommitted events`);
  const lastTotal = stages.at(-1)?.args.releasedTotalMinor;
  if (lastTotal !== undefined && BigInt(lastTotal as bigint) !== released) p.add("the last StageReleased total is not stage 1 + the stage releases");
  const revenues = ev.filter((e) => e.name === "RevenueRecorded");
  const revenue = revenues.reduce((n, e) => n + BigInt(e.args.amountMinor as bigint), 0n);
  if (revenues.length > 0 && BigInt(revenues.at(-1)?.args.revenueTotalMinor as bigint) !== revenue) p.add("the RevenueRecorded total is not the sum of the sales");
  const pause = ev.filter((e) => (e.name === "TreasuryPaused" || e.name === "Unpaused") && /^0x0{64}$/.test(String(e.args.lineId)));
  const paused = pause.at(-1)?.name === "TreasuryPaused";
  const got = { releasedMinor: released.toString(), revenueTotalMinor: revenue.toString(), paused: String(paused), ...regulatorFinal(ctx) };
  const reads = new Map(ctx.pack.steps.final.reads.map((r) => [r.label, r.value]));
  for (const [label, want] of Object.entries(FINAL_READS)) {
    const value = got[label as keyof typeof got];
    if (value !== want) p.add(`${label}: the pack gives ${value}, the catalogue implies ${want}`);
    if (reads.get(label) !== value) p.add(`final read ${label} is ${reads.get(label) ?? "(missing)"}, the pack gives ${value}`);
  }
  if (released.toString() !== ctx.pack.plan.manifest.totalMinor) p.add("not every stage of the plan was released");
  return p.result(`released ${released} minor (all stages), revenue ${revenue} minor, treasury paused; the agent's account normal and spend allowed again`);
}
