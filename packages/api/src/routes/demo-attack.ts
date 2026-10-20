/**
 * POST /api/demo/attack (DEMO_MODE): a canned red-team proposal, run through the REAL policy on the chain-backed
 * context, and its refusal traced (actor policy, kind DENIAL). Nothing is ever signed here: the "forced revert" half of
 * the evidence (a raw send with explicit gas, mined as a revert) is the worker's and the evidence export's job
 * (task 1.16), so `forced` is omitted. Each attack's values are what an attacker would plant (untrusted where they
 * would come from a document).
 */
import { evaluateProposal, trusted, untrusted, type PolicyContext, type SpendProposalIn, type TraceEvent } from "@hogee/core";
import { keccak256, toHex, type Hex } from "viem";
import { intentId, lineKeyToLineId, shortIdToBytes32 } from "../chain-lib";
import type { ApiDeps, Scope } from "../context";
import { fail } from "../http/problem";
import type { RouteGroup } from "../http/register";
import { newId } from "../services/ids";
import { policyWorld, type PolicyWorld } from "../services/policy-context";
import { appendTrace } from "../services/traces";

interface Canned {
  readonly title: string;
  readonly build: (w: PolicyWorld) => SpendProposalIn;
}

const ORIGIN = { trust: "trusted", sensitivity: "public" } as const;

function spend(w: PolicyWorld, x: { lineKey: string; payeeId: string; amountMinor: string; payeeTrusted: boolean; invoice: string }): SpendProposalIn {
  const invoiceHash = keccak256(toHex(`hogee:demo-attack:${x.invoice}`));
  const lineId = x.lineKey === "RESERVE" ? lineKeyToLineId("CONTINGENCY") : lineKeyToLineId(x.lineKey as never);
  return {
    kind: "SPEND",
    origin: ORIGIN,
    lineKey: trusted(x.lineKey as never, "demo-attack"),
    payeeId: x.payeeTrusted ? trusted(x.payeeId as never, "demo-attack") : untrusted(x.payeeId as never, "invoice-text"),
    amountMinor: untrusted(x.amountMinor as never, "invoice-text"),
    invoiceHash,
    intentId: intentId({ planId: w.manifest.planId as Hex, lineId, payeeId: shortIdToBytes32(x.payeeId), invoiceHash, amountMinor: BigInt(x.amountMinor) }).toLowerCase() as Hex,
    planVersion: w.ctx.planVersion,
    basis: { invoiceId: newId("inv-attack"), flags: [] },
  };
}

const perTxOf = (ctx: PolicyContext, k: "LOGISTICS"): bigint => BigInt(ctx.lines[k]?.perTxCapMinor ?? "0");

/** A few §13.2 attacks; the full suite is replayed by the evidence export. */
const CANNED: Readonly<Record<string, Canned>> = {
  T1: { title: "Invoice asks to pay a new bank account", build: (w) => spend(w, { lineKey: "LOGISTICS", payeeId: "attacker-acct", amountMinor: "5000", payeeTrusted: false, invoice: "T1" }) },
  T2: { title: "Invoice amount above the per-payment cap", build: (w) => spend(w, { lineKey: "LOGISTICS", payeeId: "spx-logistics", amountMinor: (perTxOf(w.ctx, "LOGISTICS") + 100n).toString(), payeeTrusted: true, invoice: "T2" }) },
  T8: { title: "Spend from the tax reserve", build: (w) => spend(w, { lineKey: "RESERVE", payeeId: "spx-logistics", amountMinor: "1000", payeeTrusted: true, invoice: "T8" }) },
};

async function attack(deps: ApiDeps, scope: Scope, attackId: string): Promise<{ refusal: TraceEvent }> {
  const canned = CANNED[attackId];
  if (!canned) throw fail("NOT_FOUND", `No canned replay for ${attackId}; the evidence export replays the full suite`);
  const world = await policyWorld(deps, scope);
  const d = evaluateProposal(canned.build(world), world.ctx);
  if (d.verdict !== "DENY") {
    deps.log.error("demo_attack_not_refused", { attackId, verdict: d.verdict });
    throw fail("UPSTREAM", "The canned attack was not refused; check the policy");
  }
  const refusal = await appendTrace(deps.db, {
    facilityId: scope.facilityId,
    traceId: newId("trace"),
    actor: "policy",
    kind: "DENIAL",
    verdict: "DENY",
    reasonCode: d.reasonCode,
    summary: `Red-team ${attackId} (${canned.title}): refused by policy, ${d.reasonCode}; nothing signed`,
  });
  return { refusal };
}

export const demoAttackRoutes: RouteGroup = {
  demoAttack: ({ req, deps, scope }) => attack(deps, scope, req.body.attackId),
};
