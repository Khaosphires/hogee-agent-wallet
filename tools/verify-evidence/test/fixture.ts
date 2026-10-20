/**
 * A complete, valid synthetic bundle built with INDEPENDENT code (@hogee/chain's EIP-712, hashes and generated ABI;
 * viem accounts; @noble/curves P-256), so a verifier bug cannot hide behind the fixture using the verifier itself.
 * Test keys are fixed and only ever sign this fixture.
 */
import { p256 } from "@noble/curves/p256";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, sha256, toHex, type Abi, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { exampleCountryPack, examplePlanManifest, hashObject, type PlanManifest } from "@hogee/core";
import {
  decisionIdToBytes32,
  hashHogeeTypedData,
  hashLines,
  hashStages,
  hogeeDomain,
  iMilestoneEscrowAbi,
  iPlanRegistryAbi,
  iTreasuryAbi,
  intentId,
  manifestToLines,
  manifestToStages,
  sequenceInvoiceHash,
  toBytes32Tag,
} from "@hogee/chain";
import { hashesFileOf, logsBloom, receiptPath, summaryMarkdown, type SummarySource } from "../src/index";

export const CHAIN_ID = 31337;
export const DEPLOYMENT_ID = "final-test";
export const CHAIN_TAG = "anvil";
export const ADDR = {
  PlanRegistry: "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
  Treasury: "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
  MilestoneEscrow: "0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
  SalesOracle: "0xd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4",
} as const;

const key = (byte: string): PrivateKeyAccount => privateKeyToAccount(`0x${byte.repeat(32)}` as Hex);
export const KEYS = { founder: key("11"), agent: key("22"), lender: key("33"), relayer: key("44") };
const P256_PRIV = "55".repeat(32);
const P256_PUB = p256.getPublicKey(P256_PRIV, false);
export const QX = toHex(P256_PUB.slice(1, 33));
export const QY = toHex(P256_PUB.slice(33, 65));

const lower = (a: string): Hex => a.toLowerCase() as Hex;
const DOMAIN = (c: keyof typeof ADDR) => hogeeDomain({ verifyingContract: ADDR[c], chainTag: toBytes32Tag(CHAIN_TAG), deploymentId: toBytes32Tag(DEPLOYMENT_ID) });

export interface SpendSpec {
  readonly line: "ADS" | "LOGISTICS" | "PLATFORM_FEES" | "CONTINGENCY";
  readonly amount: bigint;
  /** ADS: pacing slot; other lines: invoice number. */
  readonly ref: number;
  /** Seconds after the plan commit. */
  readonly after: number;
  /** Default: the line's first listed payee. */
  readonly payee?: string;
  /** Sent outside the backend (T29): owned by a chain action, no payment row. */
  readonly orphan?: boolean;
}

/** A founder-approved supplier: bindPayee on SUPPLIER (PayeeBound with the orderId), then cooling. */
export interface BindSpec {
  readonly orderId: string;
  readonly payee: string;
  readonly after: number;
  readonly coolingSeconds: number;
  readonly schedule: readonly bigint[];
}

/** An agent fundMilestone of the bound order (a FUND_MILESTONE payment row and its MilestoneFunded log). */
export interface MilestoneSpec {
  readonly idx: number;
  readonly amount: bigint;
  readonly after: number;
}

/** Any other tx, owned by a chain action (pause, tighten, loosen, …). */
export interface ExtraTx {
  readonly id: string;
  readonly kind: string;
  readonly after: number;
  readonly from: keyof typeof KEYS;
  readonly to: keyof typeof ADDR;
  readonly data: Hex;
  readonly logs: readonly Log[];
}

export interface FixtureOptions {
  readonly spends?: readonly SpendSpec[];
  /** Treasury._syncLine binds every listed platform payee in the commit tx (default true). */
  readonly bindPlatformPayees?: boolean;
  /** agent.expiresAt = commit time + this (default: the example plan's day 60). */
  readonly agentExpiresAfter?: number;
  /** A founder-signed v2 right after v1 (spends then use planVersion 2). */
  readonly recommit?: (m: PlanManifest) => PlanManifest;
  readonly bind?: BindSpec;
  readonly milestones?: readonly MilestoneSpec[];
  readonly extra?: readonly ExtraTx[];
  /** Agent spends signed but never mined: a no-op self-transfer with the same nonce consumed each (CANCELLED rows). */
  readonly cancelled?: readonly SpendSpec[];
  /** Founder-signed ownerSpend, relayed (OWNER_SPEND rows, OwnerSpent). */
  readonly ownerSpends?: readonly SpendSpec[];
  /** Founder-signed releaseMilestone of a fully funded milestone of the bound order (RELEASE_MILESTONE rows). */
  readonly releases?: readonly { readonly idx: number; readonly after: number }[];
  /** LOOSEN_WITHDRAW_RESERVE queued and executed; the executing tx is adopted as a WITHDRAW_RESERVE row. */
  readonly reserveWithdrawal?: { readonly after: number; readonly payee: string; readonly amount: bigint };
  /** A policy denial anchored with recordDenied, and its agent_refusal evidence row naming that tx. `tripsCircuit`: the
   *  denial is the line's third, so the same receipt carries CircuitTripped. `reverted`: the recordDenied reverted
   *  CircuitOpen (a burst), so the refusal row names no anchor and a T26 revert row shows the tx, as the exporter writes. */
  readonly denial?: { readonly after: number; readonly line: string; readonly tripsCircuit?: boolean; readonly reverted?: boolean };
}

export interface Fixture {
  readonly files: Record<string, string>;
  readonly spendTxs: readonly Hex[];
  readonly commitTx: Hex;
  /** Tx hash of every chain action and payment by id. */
  readonly txs: Readonly<Record<string, Hex>>;
  readonly commitAt: bigint;
}

export type Log = { address: string; topics: Hex[]; data: Hex };

export const ZERO32 = `0x${"0".repeat(64)}` as Hex;
export const UINT128_MAX = 2n ** 128n - 1n;
export const tag = (s: string): Hex => toBytes32Tag(s);

export function logOf(abi: Abi, address: string, eventName: string, args: Record<string, unknown>): Log {
  const item = abi.find((x) => x.type === "event" && x.name === eventName) as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
  const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
  const plain = item.inputs.filter((i) => !i.indexed);
  return { address, topics, data: encodeAbiParameters(plain, plain.map((i) => args[i.name])) };
}

export const treasuryLog = (eventName: string, args: Record<string, unknown>): Log => logOf(iTreasuryAbi as Abi, ADDR.Treasury, eventName, args);
export const escrowLog = (eventName: string, args: Record<string, unknown>): Log => logOf(iMilestoneEscrowAbi as Abi, ADDR.MilestoneEscrow, eventName, args);
export const treasuryCall = (functionName: string, args: readonly unknown[]): Hex => encodeFunctionData({ abi: iTreasuryAbi as Abi, functionName, args } as never);

/** pause() by `from` (TreasuryPaused(0)). */
export const pauseTx = (id: string, after: number, from: keyof typeof KEYS = "lender"): ExtraTx => ({
  id, kind: "Treasury.pause", after, from, to: "Treasury", data: treasuryCall("pause", []), logs: [treasuryLog("TreasuryPaused", { lineId: ZERO32, by: KEYS[from].address })],
});

/** tighten(TIGHTEN_PAUSE_LINE, line) by the lender (Tightened + TreasuryPaused(line)). */
export const pauseLineTx = (id: string, after: number, line: string): ExtraTx => ({
  id, kind: "Treasury.tighten", after, from: "lender", to: "Treasury", data: treasuryCall("tighten", [5, tag(line), 0n, ZERO32]),
  logs: [treasuryLog("TreasuryPaused", { lineId: tag(line), by: KEYS.lender.address }), treasuryLog("Tightened", { kind: 5, target: tag(line), by: KEYS.lender.address, oldValue: 0n, newValue: 1n, decisionId: ZERO32 })],
});

class Chain {
  block = 100;
  time: bigint;
  readonly receipts: Record<string, unknown> = {};
  readonly blocks: unknown[] = [];
  private readonly nonces = new Map<string, number>();
  constructor(start: bigint) {
    this.time = start;
  }

  /** Allocates the signer's next nonce. */
  nextNonce(from: PrivateKeyAccount): number {
    const nonce = this.nonces.get(from.address) ?? 0;
    this.nonces.set(from.address, nonce + 1);
    return nonce;
  }

  /** Signs without mining. */
  async sign(from: PrivateKeyAccount, to: string, data: Hex, nonce: number): Promise<{ hash: Hex; raw: Hex; nonce: number }> {
    const raw = await from.signTransaction({ chainId: CHAIN_ID, type: "eip1559", nonce, to: to as Hex, data, gas: 900_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, value: 0n });
    return { hash: keccak256(raw), raw, nonce };
  }

  async send(from: PrivateKeyAccount, to: string, data: Hex, logs: Log[], status: "0x1" | "0x0" = "0x1", fixedNonce?: number): Promise<{ hash: Hex; raw: Hex; block: number; nonce: number }> {
    const nonce = fixedNonce ?? this.nextNonce(from);
    const { raw, hash } = await this.sign(from, to, data, nonce);
    this.block += 1;
    const blockHash = keccak256(toHex(`block-${this.block}`));
    const n = toHex(this.block);
    this.blocks.push({ number: n, hash: blockHash, parentHash: keccak256(toHex(`block-${this.block - 1}`)), timestamp: toHex(this.time) });
    const rawLogs = logs.map((l, i) => ({ ...l, blockNumber: n, blockHash, transactionHash: hash, transactionIndex: "0x0", logIndex: toHex(i), removed: false }));
    this.receipts[receiptPath(hash)] = {
      type: "0x2", status, cumulativeGasUsed: "0x5208", logs: rawLogs, logsBloom: logsBloom(rawLogs), transactionHash: hash, transactionIndex: "0x0", blockHash, blockNumber: n,
      gasUsed: "0x5208", effectiveGasPrice: "0x1", from: lower(from.address), to, contractAddress: null,
    };
    return { hash, raw, block: this.block, nonce };
  }
}

const trace = (traceId: string, events: { kind: string; actor: string; summary: string; verdict?: string; reasonCode?: string; refs: Record<string, unknown> }[], ts: string) => {
  let prevHash = `0x${"0".repeat(64)}`;
  return events.map((e, seq) => {
    const body = { traceId, seq, ts, actor: e.actor, kind: e.kind, summary: e.summary, ...(e.verdict ? { verdict: e.verdict } : {}), ...(e.reasonCode ? { reasonCode: e.reasonCode } : {}), refs: e.refs, prevHash };
    prevHash = hashObject(body);
    return { ...body, hash: prevHash };
  });
};

function planApproval(m: PlanManifest, nonce = 777n) {
  return {
    planId: m.planId as Hex, version: m.version, prevPlanHash: m.prevPlanHash as Hex, planHash: hashObject(m) as Hex, countryPackHash: m.countryPackHash as Hex,
    linesHash: hashLines(manifestToLines(m)), stagesHash: hashStages(manifestToStages(m)), totalMinor: BigInt(m.totalMinor), reserveBps: m.reserveBps,
    agent: m.agent.address as Hex, agentExpiry: BigInt(m.agent.expiresAt), deploymentId: toBytes32Tag(DEPLOYMENT_ID), nonce, expiry: 1_999_999_999n,
  };
}

const jsonMessage = (m: Record<string, unknown>): Record<string, string | boolean> =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === "boolean" ? v : typeof v === "string" ? v.toLowerCase() : String(v)]));

/** A WebAuthn assertion over `digest`, signed with the fixture's P-256 key or `priv` (hex, 32 bytes). */
export function passkeyAssert(digest: Hex, priv: string = P256_PRIV) {
  const challenge = Buffer.from(digest.slice(2), "hex").toString("base64url");
  const clientDataJSON = `{"type":"webauthn.get","challenge":"${challenge}","origin":"http://localhost:3000","crossOrigin":false}`;
  const authenticatorData = `${sha256(toHex("localhost"))}0500000001` as Hex;
  const message = sha256(`${authenticatorData}${sha256(toHex(clientDataJSON)).slice(2)}` as Hex);
  const sig = p256.sign(message.slice(2), priv, { prehash: false, lowS: true });
  return {
    credentialId: "Y3JlZC0x",
    r: toHex(sig.r, { size: 32 }),
    s: toHex(sig.s, { size: 32 }),
    challengeIndex: clientDataJSON.indexOf('"challenge"'),
    typeIndex: clientDataJSON.indexOf('"type"'),
    authenticatorData,
    clientDataJSON,
  };
}

const webAuthnData = (a: ReturnType<typeof passkeyAssert>): Hex =>
  encodeAbiParameters(
    [{ type: "tuple", components: [{ name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }, { name: "challengeIndex", type: "uint256" }, { name: "typeIndex", type: "uint256" }, { name: "authenticatorData", type: "bytes" }, { name: "clientDataJSON", type: "string" }] }],
    [{ r: a.r, s: a.s, challengeIndex: BigInt(a.challengeIndex), typeIndex: BigInt(a.typeIndex), authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON }],
  );

export const DEFAULT_SPENDS: readonly SpendSpec[] = [
  { line: "ADS", amount: 7_500n, ref: 1, after: 3_600 },
  { line: "LOGISTICS", amount: 15_000n, ref: 1, after: 7_200 },
];

export async function buildFixture(opts: FixtureOptions = {}): Promise<Fixture> {
  const pack = exampleCountryPack;
  const commitAt = BigInt(examplePlanManifest.lines[0]?.validUntil ?? "0") - 50n * 86_400n;
  const expiresAt = opts.agentExpiresAfter === undefined ? examplePlanManifest.agent.expiresAt : String(commitAt + BigInt(opts.agentExpiresAfter));
  const m: PlanManifest = { ...examplePlanManifest, countryPackHash: hashObject(pack), agent: { address: lower(KEYS.agent.address), expiresAt } };
  const planHash = hashObject(m);
  const chain = new Chain(commitAt);
  const actions: unknown[] = [];
  const txs: Record<string, Hex> = {};
  const action = async (id: string, kind: string, from: PrivateKeyAccount, to: string, data: Hex, logs: readonly Log[], refId: string | null = null) => {
    const tx = await chain.send(from, to, data, [...logs]);
    actions.push({ actionId: id, kind, refId, state: "FINALIZED", txHash: tx.hash, block: tx.block, revertReason: null, createdAt: "2026-10-16T00:00:00.000Z", signerAddress: lower(from.address), nonce: String(tx.nonce), rawSignedTx: tx.raw });
    txs[id] = tx.hash;
    return tx;
  };
  const lender = lower(KEYS.lender.address);
  await action("act-key", "PlanRegistry.registerFounderKey", KEYS.lender, ADDR.PlanRegistry, encodeFunctionData({ abi: iPlanRegistryAbi, functionName: "registerFounderKey", args: [QX, QY, KEYS.founder.address] }),
    [logOf(iPlanRegistryAbi as Abi, ADDR.PlanRegistry, "FounderKeyRegistered", { ownerEOA: KEYS.founder.address, qx: QX, qy: QY })]);
  await action("act-open", "Treasury.openFacility", KEYS.lender, ADDR.Treasury, encodeFunctionData({ abi: iTreasuryAbi, functionName: "openFacility", args: [1_000_000n, 300] }),
    [logOf(iTreasuryAbi as Abi, ADDR.Treasury, "FacilityOpened", { lender, capMinor: 1_000_000n, reserveFloorBps: 300 })]);
  await action("act-fund", "Treasury.fund", KEYS.lender, ADDR.Treasury, encodeFunctionData({ abi: iTreasuryAbi, functionName: "fund", args: [1_000_000n] }),
    [logOf(iTreasuryAbi as Abi, ADDR.Treasury, "Funded", { amountMinor: 1_000_000n, fundedTotalMinor: 1_000_000n })]);

  const td = (kind: "PlanApproval" | "OwnerSpend", contract: keyof typeof ADDR, message: Record<string, unknown>, types: readonly { name: string; type: string }[]) => {
    const d = DOMAIN(contract);
    return { domain: { name: "Hogee", version: "1", verifyingContract: lower(d.verifyingContract), salt: d.salt }, types: { [kind]: types.map((t) => ({ ...t })) }, primaryType: kind, message: jsonMessage(message) };
  };
  const { hogeeTypes } = await import("@hogee/chain");
  const signatures: unknown[] = [];
  const plans: unknown[] = [];
  /** Treasury._syncLine: every listed platform payee not yet bound to its line is bound in the commit tx. */
  const bound = new Set<string>();
  const platformBindings = (plan: PlanManifest): Log[] =>
    opts.bindPlatformPayees === false
      ? []
      : plan.lines.flatMap((l) =>
          l.escrowOnly
            ? []
            : l.payeeIds.flatMap((p) => {
                if (bound.has(`${l.lineKey}|${p}`)) return [];
                bound.add(`${l.lineKey}|${p}`);
                return [treasuryLog("PayeeBound", { payeeId: tag(p), lineId: tag(l.lineKey), orderId: ZERO32, coolingUntil: chain.time, lifetimeCapMinor: UINT128_MAX, supplierId: ZERO32, scheduleHash: ZERO32, payoutAccountHash: keccak256(toHex(`payout:${p}`)) })];
              }),
        );
  const commitVersion = async (plan: PlanManifest, released: bigint, nonce: bigint) => {
    const approval = planApproval(plan, nonce);
    const digest = hashHogeeTypedData("PlanApproval", DOMAIN("PlanRegistry"), approval);
    const assertion = passkeyAssert(digest);
    const commitData = encodeFunctionData({ abi: iPlanRegistryAbi, functionName: "commitPlan", args: [approval, manifestToLines(plan), manifestToStages(plan), { kind: 1, data: webAuthnData(assertion) }] });
    const id = plan.version === 1 ? "act-commit" : `act-commit-${plan.version}`;
    const row = `plan-row-${plan.version}`;
    const hash = hashObject(plan);
    const tx = await action(id, "PlanRegistry.commitPlan", KEYS.relayer, ADDR.PlanRegistry, commitData, [
      ...platformBindings(plan),
      logOf(iPlanRegistryAbi as Abi, ADDR.PlanRegistry, "PlanCommitted", {
        planId: plan.planId, version: plan.version, planHash: hash, prevPlanHash: plan.prevPlanHash, countryPackHash: plan.countryPackHash, totalMinor: approval.totalMinor, agent: plan.agent.address,
        agentExpiry: approval.agentExpiry, releasedMinor: released, linesHash: approval.linesHash, stagesHash: approval.stagesHash, reserveBps: plan.reserveBps,
      }),
    ], row);
    signatures.push({ requestId: `sig-plan-${plan.version}`, kind: "PlanApproval", refId: `draft-${plan.version}`, method: "passkey", typedData: td("PlanApproval", "PlanRegistry", approval, hogeeTypes.PlanApproval), digest, status: "SUBMITTED", submission: { passkey: assertion }, chainActionId: id });
    plans.push({ planRowId: row, version: plan.version, status: "COMMITTED", planHash: hash, prevPlanHash: plan.prevPlanHash, countryPackHash: plan.countryPackHash, txHash: tx.hash, manifest: plan });
    return tx;
  };
  const commit = await commitVersion(m, 400_000n, 777n);
  let version = 1;
  if (opts.recommit) {
    chain.time = commitAt + 1n;
    const m2: PlanManifest = { ...opts.recommit(m), version: 2, prevPlanHash: planHash };
    (plans[0] as { status: string }).status = "SUPERSEDED";
    await commitVersion(m2, 400_000n, 778n);
    version = 2;
  }

  const ownerSpendMsg = { lineId: toBytes32Tag("CONTINGENCY"), payeeId: toBytes32Tag("vendor-x"), amountMinor: 1_000n, invoiceHash: keccak256(toHex("inv-x")), deploymentId: toBytes32Tag(DEPLOYMENT_ID), nonce: 9n, expiry: 1_999_999_999n };
  const ownerDigest = hashHogeeTypedData("OwnerSpend", DOMAIN("Treasury"), ownerSpendMsg);
  const ownerSig = await KEYS.founder.sign({ hash: ownerDigest });
  signatures.splice(1, 0, { requestId: "sig-owner-1", kind: "OwnerSpend", refId: "pay-owner", method: "eip712", typedData: td("OwnerSpend", "Treasury", ownerSpendMsg, hogeeTypes.OwnerSpend), digest: ownerDigest, status: "SUBMITTED", submission: { ecdsa: { signature: ownerSig } }, chainActionId: null });

  const payments: unknown[] = [];
  const rationales: unknown[] = [];
  const traces: unknown[] = [];
  const spendTxs: Hex[] = [];
  const iso = (t: bigint) => new Date(Number(t) * 1000).toISOString();
  let decisions = 0;
  /** A decision's id, rationale (stored) and commitment. */
  const decide = (what: Record<string, unknown>) => {
    decisions += 1;
    const decisionId = `01a14495-5600-7000-8000-${String(decisions).padStart(12, "0")}`;
    const rationale = { ...what, decisionId, verdict: "AUTO" };
    const rationaleHash = hashObject(rationale) as Hex;
    rationales.push({ status: "available", rationaleHash, decisionId, rationale, salt: null });
    return { decisionId, rationaleHash };
  };
  type RowOpts = { orderId?: string | null; milestoneIdx?: number | null; state?: string; signer?: PrivateKeyAccount; nonceConsumedBy?: { txHash: Hex; rawSignedTx: Hex } | null };
  const paymentRow = (paymentId: string, tx: { hash: Hex; raw: Hex; block?: number; nonce: number }, p: Record<string, unknown>, o: RowOpts, decisionId: string | null) => {
    payments.push({
      payment: { paymentId, ...p, state: o.state ?? "FINALIZED", txHash: tx.hash, ...(tx.block === undefined ? {} : { block: tx.block }), payout: { attempt: 0, status: "NONE" }, traceId: `trace:${paymentId}`, updatedAt: iso(chain.time) },
      orderId: o.orderId ?? null, milestoneIdx: o.milestoneIdx ?? null, nonceConsumedBy: o.nonceConsumedBy ?? null,
      signerAddress: lower((o.signer ?? KEYS.agent).address), nonce: String(tx.nonce), rawSignedTx: tx.raw,
    });
    txs[paymentId] = tx.hash;
    traces.push(...trace(`trace:${paymentId}`, [
      { kind: "PROPOSAL", actor: "policy", verdict: "AUTO", reasonCode: "WITHIN_PLAN", summary: `${String(p.lineKey)} ${String(p.amountMinor)}`, refs: { paymentId, ...(decisionId ? { decisionId } : {}), planVersion: version } },
      { kind: "TX", actor: "executor", summary: "sent", refs: { paymentId, txHash: tx.hash } },
    ], iso(chain.time)));
  };

  /** A payment out of a line pocket: its invoice, intent, row fields and (agent spends) decision. */
  const outflow = (s: SpendSpec, agent: boolean) => {
    const line = m.lines.find((l) => l.lineKey === s.line);
    const payeeId = s.payee ?? (line?.payeeIds[0] as string);
    const invoiceHash = s.line === "ADS" ? sequenceInvoiceHash(BigInt(s.ref)) : keccak256(toHex(`invoice-${s.line}-${s.ref}`));
    const d = agent ? decide({ kind: "SPEND_PROPOSAL", lineKey: s.line, amountMinor: s.amount.toString() }) : { decisionId: null, rationaleHash: null };
    const spendId = intentId({ planId: m.planId as Hex, lineId: toBytes32Tag(s.line), payeeId: toBytes32Tag(payeeId), invoiceHash, amountMinor: s.amount });
    const fields = { kind: agent ? "SPEND" : "OWNER_SPEND", intentId: spendId, lineKey: s.line, payeeId, amountMinor: s.amount.toString(), invoiceHash, planVersion: version, decisionId: d.decisionId, rationaleHash: d.rationaleHash };
    return { payeeId, invoiceHash, spendId, fields, ...d };
  };
  const spendCall = (s: SpendSpec) => {
    const o = outflow(s, true);
    const args = [toBytes32Tag(s.line), toBytes32Tag(o.payeeId), s.amount, o.invoiceHash, version, decisionIdToBytes32(o.decisionId as string), o.rationaleHash as Hex] as const;
    const data = encodeFunctionData({ abi: iTreasuryAbi, functionName: "spend", args });
    const logs = [treasuryLog("Spent", { spendId: o.spendId, lineId: args[0], payeeId: args[1], amountMinor: s.amount, invoiceHash: o.invoiceHash, decisionId: args[5], rationaleHash: o.rationaleHash, planVersion: version })];
    return { ...o, data, logs };
  };
  const spend = async (i: number, s: SpendSpec) => {
    const c = spendCall(s);
    if (s.orphan) return void (await action(`act-orphan-${i + 1}`, "Treasury.spend", KEYS.agent, ADDR.Treasury, c.data, c.logs));
    const tx = await chain.send(KEYS.agent, ADDR.Treasury, c.data, c.logs);
    spendTxs.push(tx.hash);
    paymentRow(`pay-${i + 1}`, tx, c.fields, {}, c.decisionId);
  };
  const cancelledSpend = async (i: number, s: SpendSpec) => {
    const c = spendCall(s);
    const nonce = chain.nextNonce(KEYS.agent);
    const signed = await chain.sign(KEYS.agent, ADDR.Treasury, c.data, nonce);
    const consumer = await chain.send(KEYS.agent, KEYS.agent.address, "0x", [], "0x1", nonce);
    txs[`consumer-${i + 1}`] = consumer.hash;
    paymentRow(`pay-cancelled-${i + 1}`, signed, c.fields, { state: "CANCELLED", nonceConsumedBy: { txHash: consumer.hash, rawSignedTx: consumer.raw } }, c.decisionId);
  };
  const ownerSpend = async (i: number, s: SpendSpec) => {
    const o = outflow(s, false);
    const req = { lineId: tag(s.line), payeeId: tag(o.payeeId), amountMinor: s.amount, invoiceHash: o.invoiceHash, deploymentId: tag(DEPLOYMENT_ID), nonce: 100n + BigInt(i), expiry: 1_999_999_999n };
    const data = treasuryCall("ownerSpend", [req, { kind: 0, data: `0x${"22".repeat(65)}` }]);
    const tx = await chain.send(KEYS.relayer, ADDR.Treasury, data, [treasuryLog("OwnerSpent", { spendId: o.spendId, lineId: req.lineId, payeeId: req.payeeId, amountMinor: s.amount, invoiceHash: o.invoiceHash, planVersion: version })]);
    paymentRow(`pay-owner-${i + 1}`, tx, o.fields, { signer: KEYS.relayer }, null);
  };

  const bindSupplier = async (b: BindSpec) => {
    const total = b.schedule.reduce((a, x) => a + x, 0n);
    const scheduleHash = keccak256(toHex(`schedule:${b.orderId}`));
    const approval = {
      orderId: tag(b.orderId), supplierId: tag(`sup:${b.payee}`), payee: tag(b.payee), payoutAccountHash: keccak256(toHex(`payout:${b.payee}`)), lineId: tag("SUPPLIER"), scheduleHash,
      totalMinor: total, quoteHash: keccak256(toHex("quote")), shortlistHash: keccak256(toHex("shortlist")), chosenIndex: 0, inspectionRequired: false, deploymentId: tag(DEPLOYMENT_ID), nonce: 31n, expiry: 1_999_999_999n,
    };
    const data = treasuryCall("bindPayee", [approval, b.schedule, b.schedule.map(() => false), { kind: 0, data: `0x${"11".repeat(65)}` }]);
    await action("act-bind", "Treasury.bindPayee", KEYS.relayer, ADDR.Treasury, data, [
      treasuryLog("PayeeBound", { payeeId: approval.payee, lineId: approval.lineId, orderId: approval.orderId, coolingUntil: chain.time + BigInt(b.coolingSeconds), lifetimeCapMinor: total, supplierId: approval.supplierId, scheduleHash, payoutAccountHash: approval.payoutAccountHash }),
    ], b.orderId);
  };

  const funded = new Map<number, bigint>();
  const fundMilestone = async (i: number, f: MilestoneSpec) => {
    const b = opts.bind as BindSpec;
    const { decisionId, rationaleHash } = decide({ kind: "FUND_MILESTONE", orderId: b.orderId, idx: f.idx, amountMinor: f.amount.toString() });
    const total = (funded.get(f.idx) ?? 0n) + f.amount;
    funded.set(f.idx, total);
    const args = [tag(b.orderId), f.idx, f.amount, decisionIdToBytes32(decisionId), rationaleHash] as const;
    const data = encodeFunctionData({ abi: iMilestoneEscrowAbi, functionName: "fundMilestone", args });
    const tx = await chain.send(KEYS.agent, ADDR.MilestoneEscrow, data, [escrowLog("MilestoneFunded", { orderId: args[0], idx: f.idx, amountMinor: f.amount, fundedTotalMinor: total, decisionId: args[3], rationaleHash })]);
    paymentRow(`pay-ms-${i + 1}`, tx, { kind: "FUND_MILESTONE", intentId: keccak256(toHex(`ms:${b.orderId}:${f.idx}:${i}`)), lineKey: "SUPPLIER", payeeId: b.payee, amountMinor: f.amount.toString(), invoiceHash: ZERO32, planVersion: version, decisionId, rationaleHash }, { orderId: b.orderId, milestoneIdx: f.idx }, decisionId);
  };
  const release = async (i: number, r: { idx: number }) => {
    const b = opts.bind as BindSpec;
    const amount = b.schedule[r.idx] as bigint;
    const { decisionId, rationaleHash } = decide({ kind: "RELEASE_MILESTONE", orderId: b.orderId, idx: r.idx });
    const evidenceHash = keccak256(toHex(`inspection:${b.orderId}:${r.idx}`));
    const settlementId = keccak256(toHex(`settlement:${b.orderId}:${r.idx}`));
    const req = { orderId: tag(b.orderId), idx: r.idx, amountMinor: amount, evidenceHash, deploymentId: tag(DEPLOYMENT_ID), nonce: 200n + BigInt(i), expiry: 1_999_999_999n };
    const data = encodeFunctionData({ abi: iMilestoneEscrowAbi, functionName: "releaseMilestone", args: [req, { kind: 0, data: `0x${"33".repeat(65)}` }] });
    const tx = await chain.send(KEYS.relayer, ADDR.MilestoneEscrow, data, [escrowLog("MilestoneReleased", { orderId: req.orderId, idx: r.idx, payeeId: tag(b.payee), amountMinor: amount, evidenceHash, settlementId })]);
    paymentRow(`pay-release-${i + 1}`, tx, { kind: "RELEASE_MILESTONE", intentId: settlementId, lineKey: "SUPPLIER", payeeId: b.payee, amountMinor: amount.toString(), invoiceHash: ZERO32, planVersion: version, decisionId, rationaleHash }, { orderId: b.orderId, milestoneIdx: r.idx, signer: KEYS.relayer }, decisionId);
  };
  const withdrawReserve = async (w: NonNullable<FixtureOptions["reserveWithdrawal"]>) => {
    const loosenId = keccak256(toHex("loosen:reserve"));
    const req = { kind: 8, target: tag(w.payee), aux: ZERO32, newValue: w.amount, deploymentId: tag(DEPLOYMENT_ID), nonce: 300n, expiry: 1_999_999_999n };
    const sig = { kind: 0, data: `0x${"44".repeat(65)}` };
    await action("act-reserve-q", "Treasury.queueLoosen", KEYS.relayer, ADDR.Treasury, treasuryCall("queueLoosen", [req, sig, sig]), [treasuryLog("LoosenQueued", { loosenId, kind: 8, target: req.target, aux: ZERO32, newValue: w.amount, executableAt: 0n, expiresAt: 1_999_999_999n })]);
    chain.time += 1n;
    const exec = await action("act-reserve-x", "Treasury.executeLoosen", KEYS.relayer, ADDR.Treasury, treasuryCall("executeLoosen", [loosenId]), [
      treasuryLog("ReserveWithdrawn", { settlementId: loosenId, taxPayeeId: req.target, amountMinor: w.amount }),
      treasuryLog("LoosenExecuted", { loosenId, kind: 8 }),
    ]);
    paymentRow("reserve:loosen", exec, { kind: "WITHDRAW_RESERVE", intentId: loosenId, lineKey: null, payeeId: w.payee, amountMinor: w.amount.toString(), invoiceHash: ZERO32, planVersion: version, decisionId: null, rationaleHash: null }, { signer: KEYS.relayer }, null);
  };
  const denialRows: unknown[] = [];
  const deny = async (d: NonNullable<FixtureOptions["denial"]>) => {
    const { decisionId, rationaleHash } = decide({ kind: "SPEND_PROPOSAL", lineKey: d.line, amountMinor: "25000", verdictWanted: "DENY" });
    const reasonCode = toHex("CapExceeded", { size: 32 });
    const data = treasuryCall("recordDenied", [tag(d.line), decisionIdToBytes32(decisionId), reasonCode, rationaleHash]);
    const denied = treasuryLog("Denied", { decisionId: decisionIdToBytes32(decisionId), lineId: tag(d.line), reasonCode, proposalHash: rationaleHash, lineDenials: d.tripsCircuit ? 3 : 1 });
    const tripped = d.tripsCircuit ? [treasuryLog("CircuitTripped", { lineId: tag(d.line), denials: 3 })] : [];
    traces.push(...trace("trace:den-1", [{ kind: "DENIAL", actor: "policy", verdict: "DENY", reasonCode: "CapExceeded", summary: "over the cap", refs: { decisionId } }], iso(chain.time)));
    if (d.reverted) {
      const tx = await chain.send(KEYS.agent, ADDR.Treasury, data, [], "0x0");
      actions.push({ actionId: "act-denied", kind: "Treasury.recordDenied", refId: "den-1", state: "REVERTED", txHash: tx.hash, block: tx.block, revertReason: "CircuitOpen", createdAt: "2026-10-16T00:00:00.000Z", signerAddress: lower(KEYS.agent.address), nonce: String(tx.nonce), rawSignedTx: tx.raw });
      txs["act-denied"] = tx.hash;
      denialRows.push(
        { taskId: "T26", title: "Off-plan spends trip the circuit breaker", expected: "revert", expectedError: "CircuitOpen", layer: "onchain_revert", outcome: "pass", revertReason: "CircuitOpen", txHash: tx.hash, chainId: CHAIN_ID, deploymentId: DEPLOYMENT_ID, block: tx.block, contract: "Treasury", function: "recordDenied", artifacts: [receiptPath(tx.hash), "chain-actions.json"] },
        { taskId: "T26", title: "Off-plan spends trip the circuit breaker: refused by policy (CircuitOpen)", expected: "refused", layer: "agent_refusal", outcome: "pass", chainId: CHAIN_ID, deploymentId: DEPLOYMENT_ID, contract: "", function: "", decisionId, traceId: "trace:den-1", artifacts: ["traces.json", "rationales.json"] },
      );
      return;
    }
    const tx = await action("act-denied", "Treasury.recordDenied", KEYS.agent, ADDR.Treasury, data, [denied, ...tripped], "den-1");
    denialRows.push({ taskId: "T4", title: "Spend over the cap: refused by policy (CapExceeded)", expected: "refused", layer: "agent_refusal", outcome: "pass", chainId: CHAIN_ID, deploymentId: DEPLOYMENT_ID, contract: "Treasury", function: "recordDenied", txHash: tx.hash, block: tx.block, decisionId, traceId: "trace:den-1", artifacts: ["traces.json", "rationales.json", receiptPath(tx.hash)] });
  };

  const steps: { after: number; run: () => Promise<void> }[] = [
    ...(opts.bind ? [{ after: opts.bind.after, run: () => bindSupplier(opts.bind as BindSpec) }] : []),
    ...(opts.extra ?? []).map((x) => ({ after: x.after, run: async () => void (await action(x.id, x.kind, KEYS[x.from], ADDR[x.to], x.data, x.logs)) })),
    ...(opts.spends ?? DEFAULT_SPENDS).map((s, i) => ({ after: s.after, run: () => spend(i, s) })),
    ...(opts.milestones ?? []).map((f, i) => ({ after: f.after, run: () => fundMilestone(i, f) })),
    ...(opts.cancelled ?? []).map((c, i) => ({ after: c.after, run: () => cancelledSpend(i, c) })),
    ...(opts.ownerSpends ?? []).map((o, i) => ({ after: o.after, run: () => ownerSpend(i, o) })),
    ...(opts.releases ?? []).map((r, i) => ({ after: r.after, run: () => release(i, r) })),
    ...(opts.reserveWithdrawal ? [{ after: opts.reserveWithdrawal.after, run: () => withdrawReserve(opts.reserveWithdrawal as NonNullable<FixtureOptions["reserveWithdrawal"]>) }] : []),
    ...(opts.denial ? [{ after: opts.denial.after, run: () => deny(opts.denial as NonNullable<FixtureOptions["denial"]>) }] : []),
  ];
  for (const st of [...steps].sort((a, b) => a.after - b.after)) {
    chain.time = commitAt + BigInt(st.after);
    await st.run();
  }
  traces.push(...trace("trace-refusal", [{ kind: "POLICY_VERDICT", actor: "policy", verdict: "DENY", reasonCode: "PayeeNotBound", summary: "pay 0xEvil refused", refs: {} }], iso(commitAt)));

  // A local chain: no explorer is pinned, so contracts.json links nowhere and the manifest holds the local placeholder.
  const contract = (name: keyof typeof ADDR) => ({ address: ADDR[name], verifiedUrl: null, verified: false });
  const contracts = {
    format: "hogee.evidence/1", runId: "run-test-1", facilityId: "fac-test", exportedAt: "2026-10-18T00:00:00.000Z", deploymentId: DEPLOYMENT_ID, chainId: CHAIN_ID, chainTag: CHAIN_TAG, explorer: null,
    contracts: { PlanRegistry: contract("PlanRegistry"), Treasury: contract("Treasury"), MilestoneEscrow: contract("MilestoneEscrow"), SalesOracle: contract("SalesOracle") }, excludedEvalTraces: 0,
  };
  const manifest = {
    runId: "run-test-1", gitCommit: "7ca38ca", toolVersions: { exporter: "hogee-evidence/1" },
    deployments: { [DEPLOYMENT_ID]: { chainId: CHAIN_ID, contracts: Object.fromEntries(Object.entries(contracts.contracts).map(([k, v]) => [k, { address: v.address, verifiedUrl: `http://localhost/${CHAIN_TAG}/address/${v.address}` }])) } },
  };
  const rows = [
    { taskId: "S2", title: "Founder signs plan v1; relayer submits commitPlan", expected: "success", layer: "onchain_success", outcome: "pass", txHash: commit.hash, chainId: CHAIN_ID, deploymentId: DEPLOYMENT_ID, block: commit.block, contract: "PlanRegistry", function: "commitPlan", artifacts: ["plans.json", "signatures.json", receiptPath(commit.hash)] },
    { taskId: "T1", title: "Pay 0xEvil is refused", expected: "refused", layer: "agent_refusal", outcome: "pass", chainId: CHAIN_ID, deploymentId: DEPLOYMENT_ID, contract: "", function: "", traceId: "trace-refusal", artifacts: ["traces.json"] },
    ...denialRows,
  ];
  const llm = [{ llmCallId: "llm-1", traceId: null, role: "planner", provider: "anthropic", modelId: "claude-sonnet-5-5", params: { thinking: "between_tools" }, promptHash: keccak256(toHex("p")), responseHash: keccak256(toHex("r")), redactionReport: { entities: [], count: 0 }, latencyMs: 10, tokens: { input: 1, output: 1 }, createdAt: "2026-10-16T00:00:00.000Z" }];
  const j = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  const files: Record<string, string> = {
    "manifest.json": j(manifest), "evidence.json": j(rows), "contracts.json": j(contracts), "plans.json": j(plans), "signatures.json": j(signatures), "payments.json": j(payments),
    "chain-actions.json": j(actions), "rationales.json": j(rationales), "traces.json": j(traces), "llm-calls.json": j(llm), "blocks.json": j(chain.blocks),
    "country-pack.json": j({ countryCode: "MY", countryPackHash: hashObject(pack), pack }),
    ...Object.fromEntries(Object.entries(chain.receipts).map(([k, v]) => [k, j(v)])),
  };
  // SUMMARY.md is a human index, not a commitment: the shared generator writes it, as the exporter does.
  files["SUMMARY.md"] = summaryMarkdown({
    manifest, contracts, rows, payments, chainActions: actions,
    counts: { plans: plans.length, signatures: signatures.length, traces: traces.length, llmCalls: llm.length, rationales: rationales.length, receipts: Object.keys(chain.receipts).length },
    countryPackIncluded: true,
  } as unknown as SummarySource);
  files["hashes.json"] = hashesFileOf(files);
  return { files, spendTxs, commitTx: commit.hash, txs, commitAt };
}

/** Re-computes hashes.json (an attacker who also rewrites the hash index). */
export function rehash(files: Record<string, string>): Record<string, string> {
  const { "hashes.json": _old, ...rest } = files;
  return { ...rest, "hashes.json": hashesFileOf(rest) };
}

/** Edits one JSON file of the bundle. */
export function editJson(files: Record<string, string>, path: string, edit: (v: any) => void): Record<string, string> {
  const v = JSON.parse(files[path] as string) as unknown;
  edit(v);
  return { ...files, [path]: `${JSON.stringify(v, null, 2)}\n` };
}
