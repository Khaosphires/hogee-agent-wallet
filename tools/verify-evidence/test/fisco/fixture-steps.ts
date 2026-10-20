/**
 * The FISCO fixture's replay (v2): the regulator's observer proposal at chain-up, deploy, G0, the catalogue steps with
 * their calldata, events and reads, the regulator's stops (freeze, method ban, the probes), then the pack files.
 */
import { decodeFunctionData, encodeFunctionData, keccak256, toHex, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { hashObject, type PlanManifest } from "@hogee/core";
import { hashHogeeTypedData, iMilestoneEscrowAbi, iPlanRegistryAbi, iSalesOracleAbi, iTreasuryAbi, manifestToLines, manifestToStages } from "@hogee/chain";
import { hashesFileOf } from "../../src/index";
import { ACCOUNT_MANAGER_ABI, COMMITTEE_MANAGER_ABI, CONTRACT_AUTH_ABI, PROPOSAL_LOG, SPEND_SELECTOR, SYSTEM } from "../../src/fisco/system";
import { passkeyAssert, type Log } from "../fixture";
import {
  artifactOf, callOf, CODE_NAMES, creationInput, dataOf, domainOf, eLog, errorString, EXPIRY, F_GOV, F_P256, FADDR, FiscoChain, FKEYS, fLog, FQX, FQY, FSIDE, json, lower, PARAMS,
  planApprovalOf, runtimeOf, slotValues, sourceRows, SSIDE, tag, tLog, typedData, word, ZERO32, ZERO_ADDR, type PackFixture, type SendOptions, type StepJson,
} from "./fixture";
import { buildSource, ORDER_ID, SOURCE, SUPPLIER, settlementIdOf, webAuthnData } from "./source";

type RoleKey = "deployer" | "lender" | "oracle" | "agent" | "relayer" | "regulator";
const DEPLOYED = ["PlanRegistry", "Treasury", "MilestoneEscrow", "SalesOracle"] as const;
type Target = (typeof DEPLOYED)[number] | keyof typeof SYSTEM;
const addressOf = (t: Target): Hex => (t in SYSTEM ? SYSTEM[t as keyof typeof SYSTEM] : FADDR[t as (typeof DEPLOYED)[number]]) as Hex;
const keccakOf = (s: string): Hex => keccak256(toHex(s));
const NOT_RELEASED = [{ label: "milestone 1 released", before: "false", after: "false" }];

interface Spec {
  readonly id: string;
  readonly title: string;
  readonly contract: Target;
  readonly fn: string;
  readonly role: RoleKey;
  readonly auth?: string;
  readonly amountMinor?: string;
  readonly data: Hex;
  readonly logs?: readonly Log[];
  readonly refused?: { readonly error: string; readonly reads: StepJson["reads"] };
  readonly links?: StepJson["links"];
  /** Reads around a step expected to succeed (the regulator's G/V steps, the probes). */
  readonly reads?: StepJson["reads"];
  readonly native?: SendOptions["native"];
}

class Replay {
  readonly chain = new FiscoChain();
  readonly steps: StepJson[] = [];
  readonly stepTx: Record<string, Hex> = {};
  readonly deployTx: Record<string, Hex> = {};

  async deploy(): Promise<void> {
    for (const name of DEPLOYED) this.deployTx[name] = (await this.chain.send(FKEYS.deployer, null, creationInput(name, FSIDE), [], { rawSource: "rebuilt" })).hash;
  }

  async run(s: Spec): Promise<Hex> {
    const from = FKEYS[s.role] as PrivateKeyAccount;
    const before = this.chain.nonceOf(from);
    const t = await this.chain.send(from, addressOf(s.contract), s.data, s.logs ?? [], { status: s.refused ? "0x0" : "0x1", ...(s.native ? { native: s.native } : {}) });
    this.steps.push({
      seq: this.steps.length + 1, id: s.id, title: s.title, contract: s.contract, function: s.fn, signerRole: s.role, auth: s.auth ?? "none",
      ...(s.amountMinor ? { amountMinor: s.amountMinor } : {}), expected: s.refused ? "refused" : "ok", ...(s.refused ? { expectedError: s.refused.error } : {}),
      probe: s.refused ? { ok: false, error: s.refused.error } : { ok: true }, outcome: { kind: s.refused ? "mined-reverted" : "mined", txHash: t.hash },
      reads: s.refused?.reads ?? s.reads ?? [], nonce: { before, after: this.chain.nonceOf(from) }, links: s.links ?? {},
    });
    this.stepTx[s.id] = t.hash;
    return s.data;
  }

  /** A probe-only step: the eth_call at the current head, nothing sent. */
  probe(s: Spec): void {
    const from = FKEYS[s.role] as PrivateKeyAccount;
    const nonce = this.chain.nonceOf(from);
    this.steps.push({
      seq: this.steps.length + 1, id: s.id, title: s.title, contract: s.contract, function: s.fn, signerRole: s.role, auth: s.auth ?? "none",
      ...(s.amountMinor ? { amountMinor: s.amountMinor } : {}), expected: "ok", probe: { ok: true }, call: { from: lower(from.address), to: addressOf(s.contract), data: s.data, block: this.chain.block },
      outcome: { kind: "probe-only" }, reads: s.reads ?? [], nonce: { before: nonce, after: nonce }, links: {},
    });
  }
}

/** SPEND: R17's exact calldata, built once (F1, M1, R17 send it; C1, C3 probe it). */
const SPEND = callOf(iTreasuryAbi, "spend", [tag("PLATFORM_FEES"), tag("shopee-fees"), 10_000n, keccakOf("inv-r17"), 1, keccakOf("d17"), keccakOf("r17")]);
const AGENT = lower(FKEYS.agent.address);
const REGULATOR = lower(FKEYS.regulator.address);
const read = (label: string, before: string, after: string) => [{ label, before, after }];
const sys = (abi: unknown, fn: string, args: readonly unknown[]): Hex => (encodeFunctionData as (p: unknown) => Hex)({ abi, functionName: fn, args });
const status = (n: number) => sys(ACCOUNT_MANAGER_ABI, "setAccountStatus", [AGENT, n]);
const confirm = () => sys(ACCOUNT_MANAGER_ABI, "getAccountStatus", [AGENT]);
const ZERO_WORD = { status: 0, output: word(0n) };
const proposalLog = { address: PROPOSAL_LOG.address, topics: [PROPOSAL_LOG.topic0 as Hex], data: PROPOSAL_LOG.data as Hex };

/** Chain-up (not a step): the regulator makes node4 an observer through a committee proposal (its nonce 0). */
async function observerProposal(r: Replay): Promise<{ hash: Hex; block: number }> {
  const data = sys(COMMITTEE_MANAGER_ABI, "createSetConsensusWeightProposal", ["node4-fixture-id", 0, true, 1000n]);
  const t = await r.chain.send(FKEYS.regulator, SYSTEM.CommitteeManager, data, [proposalLog], { native: { status: 0, output: word(1n) } });
  r.chain.txs.delete(t.hash);
  return { hash: t.hash, block: r.chain.block };
}

/** G0: the regulator registers the agent's account before its first tx. */
const registerAgent = (r: Replay) => r.run({ id: "G0", title: "Register the agent", contract: "AccountManager", fn: "setAccountStatus", role: "regulator", data: status(0), native: ZERO_WORD });

/** G1-C3: freeze, confirm, refused by the chain, unfreeze, confirm, probe; admin, ban, refused, probes, lift. */
async function regulator(r: Replay): Promise<void> {
  await r.run({ id: "G1", title: "Freeze", contract: "AccountManager", fn: "setAccountStatus", role: "regulator", data: status(1), native: ZERO_WORD });
  await r.run({ id: "V1", title: "Confirm frozen", contract: "AccountManager", fn: "getAccountStatus", role: "regulator", data: confirm(), native: { status: 0, output: word(1n) }, reads: read("accountStatus", "0", "1") });
  await r.run({ id: "F1", title: "Spend while frozen", contract: "Treasury", fn: "spend", role: "agent", amountMinor: "10000", data: SPEND, native: { status: 22, output: errorString("Account's status is abnormal") }, refused: { error: "AccountFrozen", reads: read("accountStatus", "1", "1") } });
  await r.run({ id: "G2", title: "Unfreeze", contract: "AccountManager", fn: "setAccountStatus", role: "regulator", data: status(0), native: ZERO_WORD });
  await r.run({ id: "V2", title: "Confirm normal", contract: "AccountManager", fn: "getAccountStatus", role: "regulator", data: confirm(), native: ZERO_WORD, reads: read("accountStatus", "1", "0") });
  r.probe({ id: "C1", title: "Probe the spend", contract: "Treasury", fn: "spend", role: "agent", amountMinor: "10000", data: SPEND, reads: read("accountStatus", "0", "0") });
  await r.run({ id: "G3", title: "Admin reset", contract: "CommitteeManager", fn: "createResetAdminProposal", role: "regulator", data: sys(COMMITTEE_MANAGER_ABI, "createResetAdminProposal", [REGULATOR, FADDR.Treasury, 1000n]), logs: [proposalLog], native: { status: 0, output: word(2n) }, reads: read("treasuryAdmin", lower(FKEYS.deployer.address), REGULATOR) });
  await r.run({ id: "G4", title: "Blacklist mode", contract: "ContractAuth", fn: "setMethodAuthType", role: "regulator", data: sys(CONTRACT_AUTH_ABI, "setMethodAuthType", [FADDR.Treasury, SPEND_SELECTOR, 2]), native: ZERO_WORD, reads: read("spendAllowed", "true", "true") });
  await r.run({ id: "G5", title: "Ban spend", contract: "ContractAuth", fn: "closeMethodAuth", role: "regulator", data: sys(CONTRACT_AUTH_ABI, "closeMethodAuth", [FADDR.Treasury, SPEND_SELECTOR, AGENT]), native: ZERO_WORD, reads: read("spendAllowed", "true", "false") });
  await r.run({ id: "M1", title: "Spend while banned", contract: "Treasury", fn: "spend", role: "agent", amountMinor: "10000", data: SPEND, native: { status: 18, output: errorString("Call permission denied") }, refused: { error: "PermissionDenied", reads: read("spendAllowed", "false", "false") } });
  r.probe({ id: "C2", title: "Probe recordDenied", contract: "Treasury", fn: "recordDenied", role: "agent", data: callOf(iTreasuryAbi, "recordDenied", [tag("PLATFORM_FEES"), keccakOf("dd17"), tag("Paused"), keccak256(SPEND)]), reads: read("spendAllowed", "false", "false") });
  await r.run({ id: "G6", title: "Lift the ban", contract: "ContractAuth", fn: "openMethodAuth", role: "regulator", data: sys(CONTRACT_AUTH_ABI, "openMethodAuth", [FADDR.Treasury, SPEND_SELECTOR, AGENT]), native: ZERO_WORD, reads: read("spendAllowed", "false", "true") });
  r.probe({ id: "C3", title: "Probe the spend again", contract: "Treasury", fn: "spend", role: "agent", amountMinor: "10000", data: SPEND, reads: read("spendAllowed", "true", "true") });
}

const sign = (account: PrivateKeyAccount, hash: Hex): Promise<Hex> => account.sign({ hash });
const passkeySig = (digest: Hex) => {
  const assertion = passkeyAssert(digest, F_P256);
  return { assertion, sig: { kind: 1, data: webAuthnData(assertion) } };
};

/** S1-S6: facility, founder key, plan v1, funding, the supplier, milestone 0. */
async function setup(r: Replay, src: ReturnType<typeof sourceRows>, m: PlanManifest) {
  await r.run({ id: "S1", title: "Open the facility", contract: "Treasury", fn: "openFacility", role: "lender", amountMinor: "1000000", data: dataOf(src.action("Treasury.openFacility").rawSignedTx), logs: [tLog("FacilityOpened", { lender: FKEYS.lender.address, capMinor: 1_000_000n, reserveFloorBps: 300 })], links: { sepoliaTx: src.action("Treasury.openFacility").txHash } });
  await r.run({ id: "S2", title: "Register the founder key", contract: "PlanRegistry", fn: "registerFounderKey", role: "lender", data: callOf(iPlanRegistryAbi, "registerFounderKey", [FQX, FQY, ZERO_ADDR]), logs: [fLog(iPlanRegistryAbi, FADDR.PlanRegistry, "FounderKeyRegistered", { ownerEOA: ZERO_ADDR, qx: FQX, qy: FQY })] });
  const approval = planApprovalOf(m, 5001n);
  const planDigest = hashHogeeTypedData("PlanApproval", domainOf("PlanRegistry"), approval);
  const plan = passkeySig(planDigest);
  await r.run({
    id: "S3", title: "Commit plan v1", contract: "PlanRegistry", fn: "commitPlan", role: "relayer", auth: "passkey", amountMinor: "1000000",
    data: callOf(iPlanRegistryAbi, "commitPlan", [approval, manifestToLines(m), manifestToStages(m), plan.sig]),
    logs: [fLog(iPlanRegistryAbi, FADDR.PlanRegistry, "PlanCommitted", { planId: m.planId, version: 1, planHash: approval.planHash, prevPlanHash: m.prevPlanHash, countryPackHash: m.countryPackHash, totalMinor: approval.totalMinor, agent: m.agent.address, agentExpiry: approval.agentExpiry, releasedMinor: 400_000n, linesHash: approval.linesHash, stagesHash: approval.stagesHash, reserveBps: m.reserveBps })],
    links: { sepoliaTx: src.action("PlanRegistry.commitPlan").txHash },
  });
  await r.run({ id: "S4", title: "Fund", contract: "Treasury", fn: "fund", role: "lender", amountMinor: "1000000", data: dataOf(src.action("Treasury.fund").rawSignedTx), logs: [tLog("Funded", { amountMinor: 1_000_000n, fundedTotalMinor: 1_000_000n })], links: { sepoliaTx: src.action("Treasury.fund").txHash } });
  const bind = decodeFunctionData({ abi: iTreasuryAbi, data: dataOf(src.action("Treasury.bindPayee").rawSignedTx) }).args as unknown as [Record<string, Hex>, readonly bigint[], readonly boolean[]];
  const supplier: Record<string, unknown> & Record<"payee" | "lineId" | "orderId" | "supplierId" | "scheduleHash" | "payoutAccountHash", Hex> = { ...bind[0], nonce: 5002n, expiry: EXPIRY } as never;
  const bound = passkeySig(hashHogeeTypedData("SupplierApproval", domainOf("Treasury"), supplier as never));
  await r.run({
    id: "S5", title: "Bind the supplier", contract: "Treasury", fn: "bindPayee", role: "relayer", auth: "passkey", amountMinor: "250000",
    data: callOf(iTreasuryAbi, "bindPayee", [supplier, bind[1], bind[2], bound.sig]),
    logs: [tLog("PayeeBound", { payeeId: supplier.payee, lineId: supplier.lineId, orderId: supplier.orderId, coolingUntil: r.chain.time + 127n, lifetimeCapMinor: 250_000n, supplierId: supplier.supplierId, scheduleHash: supplier.scheduleHash, payoutAccountHash: supplier.payoutAccountHash })],
    links: { sepoliaTx: src.action("Treasury.bindPayee").txHash },
  });
  r.chain.time += 125n;
  const [d6, r6] = [keccakOf("d6"), keccakOf("r6")];
  await r.run({
    id: "S6", title: "Fund milestone 0", contract: "MilestoneEscrow", fn: "fundMilestone", role: "agent", amountMinor: "75000", data: callOf(iMilestoneEscrowAbi, "fundMilestone", [tag(ORDER_ID), 0, 75_000n, d6, r6]),
    logs: [eLog("MilestoneFunded", { orderId: tag(ORDER_ID), idx: 0, amountMinor: 75_000n, fundedTotalMinor: 75_000n, decisionId: d6, rationaleHash: r6 }), eLog("MilestoneReleased", { orderId: tag(ORDER_ID), idx: 0, payeeId: tag(SUPPLIER), amountMinor: 75_000n, evidenceHash: ZERO32, settlementId: settlementIdOf(0) })],
    links: { sepoliaTx: src.payment("FUND_MILESTONE", 0).txHash },
  });
  return { approval, planDigest, assertion: plan.assertion };
}

const denied = (decisionId: Hex, line: Hex, reason: string, proposal: Hex) => tLog("Denied", { decisionId, lineId: line, reasonCode: tag(reason), proposalHash: proposal, lineDenials: 1 });

/** R7-D9: the refusals before stage 2. */
async function refusals(r: Replay, m: PlanManifest) {
  const r7 = await r.run({ id: "R7", title: "Spend over the per-tx cap", contract: "Treasury", fn: "spend", role: "agent", amountMinor: "30000", data: callOf(iTreasuryAbi, "spend", [tag("LOGISTICS"), tag("spx-logistics"), 30_000n, keccakOf("inv-r7"), 1, keccakOf("d7"), keccakOf("r7")]), refused: { error: "CapExceeded", reads: [{ label: "LOGISTICS spentMinor", before: "0", after: "0" }] } });
  await r.run({ id: "D7", title: "Record the R7 denial", contract: "Treasury", fn: "recordDenied", role: "agent", data: callOf(iTreasuryAbi, "recordDenied", [tag("LOGISTICS"), keccakOf("dd7"), tag("CapExceeded"), keccak256(r7)]), logs: [denied(keccakOf("dd7"), tag("LOGISTICS"), "CapExceeded", keccak256(r7))], links: { recordsDenialOf: "R7" } });
  const req8 = { orderId: tag(ORDER_ID), idx: 1, amountMinor: 175_000n, evidenceHash: keccakOf("ev8"), deploymentId: tag(SOURCE.deploymentId), nonce: 5003n, expiry: EXPIRY };
  await r.run({ id: "R8", title: "The agent releases milestone 1", contract: "MilestoneEscrow", fn: "releaseMilestone", role: "agent", amountMinor: "175000", data: callOf(iMilestoneEscrowAbi, "releaseMilestone", [req8, { kind: 0, data: `0x${"00".repeat(65)}` }]), refused: { error: "MilestoneLocked", reads: NOT_RELEASED } });
  const m2: PlanManifest = { ...m, version: 2, prevPlanHash: hashObject(m), lines: m.lines.map((l) => (l.lineKey === "LOGISTICS" ? { ...l, perTxCapMinor: "30000" } : l)) };
  const a2 = planApprovalOf(m2, 5004n);
  const agentSig = await sign(FKEYS.agent, hashHogeeTypedData("PlanApproval", domainOf("PlanRegistry"), a2));
  const r9a = await r.run({ id: "R9a", title: "The agent signs plan v2", contract: "PlanRegistry", fn: "commitPlan", role: "agent", auth: "ecdsa-agent", data: callOf(iPlanRegistryAbi, "commitPlan", [a2, manifestToLines(m2), manifestToStages(m2), { kind: 0, data: agentSig }]), refused: { error: "NotOwner", reads: [{ label: "plan version", before: "1", after: "1" }] } });
  await r.run({ id: "R9b", title: "The agent raises a cap", contract: "Treasury", fn: "tighten", role: "agent", amountMinor: "30000", data: callOf(iTreasuryAbi, "tighten", [1, tag("LOGISTICS"), 30_000n, keccakOf("d9b")]), refused: { error: "NotOwner", reads: [{ label: "LOGISTICS perTxCapMinor", before: "20000", after: "20000" }] } });
  await r.run({ id: "D9", title: "Record the R9a denial", contract: "Treasury", fn: "recordDenied", role: "agent", data: callOf(iTreasuryAbi, "recordDenied", [ZERO32, keccakOf("dd9"), tag("NotOwner"), keccak256(r9a)]), logs: [denied(keccakOf("dd9"), ZERO32, "NotOwner", keccak256(r9a))], links: { recordsDenialOf: "R9a" } });
}

/** S10-S18b: milestone 1, sales, stage 2, T28, the control release, pause, the paused spend, settlements. */
async function rest(r: Replay, src: ReturnType<typeof sourceRows>, source: Awaited<ReturnType<typeof buildSource>>) {
  await r.run({ id: "S10", title: "Fund milestone 1", contract: "MilestoneEscrow", fn: "fundMilestone", role: "agent", amountMinor: "175000", data: callOf(iMilestoneEscrowAbi, "fundMilestone", [tag(ORDER_ID), 1, 175_000n, keccakOf("d10"), keccakOf("r10")]), logs: [eLog("MilestoneFunded", { orderId: tag(ORDER_ID), idx: 1, amountMinor: 175_000n, fundedTotalMinor: 175_000n, decisionId: keccakOf("d10"), rationaleHash: keccakOf("r10") })], links: { sepoliaTx: src.payment("FUND_MILESTONE", 1).txHash } });
  const sale = keccakOf("fisco-mirror:sale-1");
  await r.run({ id: "S11", title: "Record sales", contract: "SalesOracle", fn: "recordSale", role: "oracle", amountMinor: "200000", data: callOf(iSalesOracleAbi, "recordSale", [sale, 200_000n]), logs: [fLog(iSalesOracleAbi, FADDR.SalesOracle, "SaleRecorded", { saleIdHash: sale, amountBucket: 200_000n }), tLog("RevenueRecorded", { saleIdHash: sale, amountMinor: 200_000n, revenueTotalMinor: 200_000n }), tLog("ReserveSkimmed", { saleIdHash: sale, amountMinor: 10_000n, reserveTotalMinor: 10_000n })] });
  const stage = { stageId: tag("stage-2"), amountMinor: 600_000n, deploymentId: tag(SOURCE.deploymentId), nonce: 5005n, expiry: EXPIRY };
  const lenderSig = await sign(FKEYS.lender, hashHogeeTypedData("StageRelease", domainOf("Treasury"), stage));
  await r.run({ id: "S12", title: "Release stage 2", contract: "Treasury", fn: "releaseStage", role: "relayer", auth: "ecdsa-lender", amountMinor: "600000", data: callOf(iTreasuryAbi, "releaseStage", [stage, { kind: 0, data: lenderSig }]), logs: [tLog("StageReleased", { stageId: stage.stageId, amountMinor: 600_000n, releasedTotalMinor: 1_000_000n })] });
  await r.run({ id: "T28a", title: "Replay the source release", contract: "MilestoneEscrow", fn: "releaseMilestone", role: "relayer", auth: "passkey", amountMinor: "175000", data: source.release.data, refused: { error: "InvalidSignature", reads: NOT_RELEASED }, links: { sepoliaTx: source.release.hash } });
  const srcReq = (decodeFunctionData({ abi: iMilestoneEscrowAbi, data: source.release.data }).args as unknown as [Record<string, unknown>])[0];
  const t28bReq = { ...srcReq, nonce: 5006n, expiry: EXPIRY };
  const t28bDigest = hashHogeeTypedData("MilestoneRelease", domainOf("MilestoneEscrow", "source"), t28bReq as never);
  const t28b = passkeySig(t28bDigest);
  await r.run({ id: "T28b", title: "A release over the source domain", contract: "MilestoneEscrow", fn: "releaseMilestone", role: "relayer", auth: "passkey", amountMinor: "175000", data: callOf(iMilestoneEscrowAbi, "releaseMilestone", [t28bReq, t28b.sig]), refused: { error: "InvalidSignature", reads: NOT_RELEASED } });
  const s15Req = { ...srcReq, nonce: 5007n, expiry: EXPIRY };
  const s15 = passkeySig(hashHogeeTypedData("MilestoneRelease", domainOf("MilestoneEscrow"), s15Req as never));
  await r.run({ id: "S15", title: "Release milestone 1 (control)", contract: "MilestoneEscrow", fn: "releaseMilestone", role: "relayer", auth: "passkey", amountMinor: "175000", data: callOf(iMilestoneEscrowAbi, "releaseMilestone", [s15Req, s15.sig]), logs: [eLog("MilestoneReleased", { orderId: tag(ORDER_ID), idx: 1, payeeId: tag(SUPPLIER), amountMinor: 175_000n, evidenceHash: srcReq.evidenceHash, settlementId: settlementIdOf(1) })], links: { sepoliaTx: src.payment("RELEASE_MILESTONE", 1).txHash } });
  await regulator(r);
  await r.run({ id: "S16", title: "Pause", contract: "Treasury", fn: "pause", role: "lender", data: callOf(iTreasuryAbi, "pause", []), logs: [tLog("TreasuryPaused", { lineId: ZERO32, by: FKEYS.lender.address })], links: { sepoliaTx: src.action("Treasury.pause").txHash } });
  const r17 = await r.run({ id: "R17", title: "Spend while paused", contract: "Treasury", fn: "spend", role: "agent", amountMinor: "10000", data: SPEND, refused: { error: "Paused", reads: [{ label: "paused", before: "true", after: "true" }] } });
  await r.run({ id: "D17", title: "Record the R17 denial", contract: "Treasury", fn: "recordDenied", role: "agent", data: callOf(iTreasuryAbi, "recordDenied", [tag("PLATFORM_FEES"), keccakOf("dd17"), tag("Paused"), keccak256(r17)]), logs: [denied(keccakOf("dd17"), tag("PLATFORM_FEES"), "Paused", keccak256(r17))], links: { recordsDenialOf: "R17" } });
  for (const [id, nth] of [["S18a", 0], ["S18b", 1]] as const) {
    const row = src.action("Treasury.confirmSettlement", nth);
    const args = decodeFunctionData({ abi: iTreasuryAbi, data: dataOf(row.rawSignedTx) }).args as unknown as [Hex, Hex];
    await r.run({ id, title: "Confirm a settlement", contract: "Treasury", fn: "confirmSettlement", role: "oracle", data: dataOf(row.rawSignedTx), logs: [tLog("SettlementConfirmed", { settlementId: args[0], payoutRefHash: args[1] })], links: { sepoliaTx: row.txHash } });
  }
  return { t28b: { typedData: typedData("MilestoneRelease", domainOf("MilestoneEscrow", "source"), t28bReq), digest: t28bDigest, assertion: t28b.assertion } };
}

/** The fixture's tracked source broadcast (a CLI test writes it under a scratch repo root). */
export const SOURCE_BROADCAST_FILE = `contracts/broadcast/DeployFinal.s.sol/${SOURCE.chainId}/run-1.json`;

const sourceBroadcast = () => ({
  transactions: DEPLOYED.map((name, i) => ({
    hash: keccakOf(`source-deploy-${name}`), transactionType: "CREATE", contractName: name, contractAddress: SSIDE.addr[name], function: null, arguments: [],
    transaction: { from: lower(FKEYS.deployer.address), gas: "0x1", value: "0x0", input: creationInput(name, SSIDE), nonce: toHex(i), chainId: toHex(SOURCE.chainId) },
    additionalContracts: name === "Treasury" ? [{ transactionType: "CREATE", contractName: "TreasuryGovernance", address: SSIDE.addr.TreasuryGovernance, initCode: "0x6080" }] : [],
    isFixedGasLimit: false,
  })),
  receipts: [], libraries: [], pending: [], returns: {}, timestamp: 1, chain: SOURCE.chainId, commit: "f93d112",
});

export async function buildPack(): Promise<PackFixture> {
  const source = await buildSource();
  const src = sourceRows(source);
  const sourcePlans = JSON.parse(source.files["plans.json"] as string) as { planHash: Hex; manifest: PlanManifest }[];
  const m = (sourcePlans[0] as { manifest: PlanManifest }).manifest;
  const r = new Replay();
  const observer = await observerProposal(r);
  await r.deploy();
  const headAtStart = r.chain.block;
  await registerAgent(r);
  const plan = await setup(r, src, m);
  await refusals(r, m);
  const { t28b } = await rest(r, src, source);
  const files: Record<string, string> = {};
  const sourceFiles = Object.fromEntries(Object.entries(source.files).map(([p, b]) => [p, keccak256(toHex(b))]));
  const core = { format: "hogee.fisco-mirror/2", createdAt: "2026-10-20T00:00:00.000Z", gitCommit: "3420445", sourceBundle: { runId: SOURCE.runId, files: sourceFiles } };
  const packId = `fm-${hashObject(core).slice(2, 18)}`;
  files["pack.json"] = json({ format: core.format, packId, createdAt: core.createdAt, gitCommit: core.gitCommit, sourceBundle: core.sourceBundle });
  files["chain.json"] = json({ clientVersion: "FISCO-BCOS/3.17.1", chainId: 20_200, nodeCount: 5, sealerCount: 4, observerCount: 1, consensus: "pbft", genesis: { features: { feature_evm_cancun: 1, feature_evm_timestamp: 1, feature_evm_address: 1 } }, evm: { timestampUnit: "seconds", p256At0x100: false }, txType: "legacy", gasPrice: "0x0", headAtStart, headAtEnd: r.chain.block,
    headHashAtEnd: (r.chain.ledger.at(-1) as { hash: Hex }).hash, auth: { check: true, admin: REGULATOR },
    observerNode: { index: 4, proposalTx: observer.hash, proposalBlock: observer.block, weight: 0, nodeIdKeccak: keccakOf("node4-fixture-id") },
  });
  const broadcast = json(sourceBroadcast());
  files["sepolia-broadcast.json"] = broadcast;
  files["deployment.json"] = json({
    chainTag: "fisco", deploymentId: SOURCE.deploymentId, fiscoMs: false,
    contracts: { ...Object.fromEntries(DEPLOYED.map((n) => [n, { address: FADDR[n], deployTx: r.deployTx[n] }])), TreasuryGovernance: { address: F_GOV, deployTx: null } },
    roles: { deployer: lower(FKEYS.deployer.address), lender: lower(FKEYS.lender.address), oracle: lower(FKEYS.oracle.address), agent: lower(FKEYS.agent.address), relayer: lower(FKEYS.relayer.address), observer: ZERO_ADDR, regulator: REGULATOR },
    founderKey: { qx: FQX, qy: FQY, ownerEOA: ZERO_ADDR },
    params: { coolingSeconds: String(PARAMS.cooling), loosenTimelockSeconds: String(PARAMS.loosen), judgingWindowEnd: String(PARAMS.judging), platformPayeeIds: PARAMS.payees, platformPayoutHashes: PARAMS.payouts },
    sepolia: { contracts: SSIDE.addr, broadcastFile: SOURCE_BROADCAST_FILE, broadcastKeccak: keccak256(toHex(broadcast)) },
    manifestJson: { chainId: 20_200, deploymentId: SOURCE.deploymentId, chainTag: "fisco", contracts: Object.fromEntries(DEPLOYED.map((n) => [n, { address: FADDR[n] }])), blockNumber: 1, deployedAt: "2026-10-20T00:00:00Z" },
  });
  const finalReads = [["releasedMinor", "1000000"], ["revenueTotalMinor", "200000"], ["paused", "true"], ["agentAccountStatus", "0"], ["spendAllowedForAgent", "true"]].map(([label, value]) => ({ label, value }));
  files["steps.json"] = json({ format: "hogee.fisco-mirror/2", preflight: { block: headAtStart, reads: [{ label: "chainId", value: "20200" }] }, steps: r.steps, final: { block: r.chain.block, reads: finalReads } });
  const blocks = r.chain.ledger;
  files["ledger.json"] = json({ node: "node4-observer", head: { number: r.chain.block, hash: (blocks.at(-1) as { hash: Hex }).hash }, blocks, node0Keccak: hashObject(blocks) });
  files["artifacts.json"] = json({ solc: "0.8.37", evmVersion: "cancun", optimizer: { enabled: true, runs: 200 }, contracts: Object.fromEntries(CODE_NAMES.map((n) => [n, artifactOf(n)])) });
  files["plan.json"] = json({ manifest: m, planHash: hashObject(m), sepoliaPlanHash: (sourcePlans[0] as { planHash: Hex }).planHash, diffFromSepolia: [], approval: { typedData: typedData("PlanApproval", domainOf("PlanRegistry"), plan.approval), digest: plan.planDigest, submission: { passkey: plan.assertion } } });
  const sigs = JSON.parse(source.files["signatures.json"] as string) as { requestId: string }[];
  files["t28.json"] = json({ sepoliaSignature: sigs.find((s) => s.requestId === source.release.requestId), sepoliaTx: { hash: source.release.hash, raw: source.release.raw }, t28b });
  for (const [name, side, dir, chainId] of [["fisco", FSIDE, "code", 20_200], ["source", SSIDE, "code-sepolia", SOURCE.chainId]] as const) {
    for (const n of CODE_NAMES) files[`${dir}/${n}.hex`] = `${runtimeOf(n, slotValues(side, n))}\n`;
    files[`${dir}/meta.json`] = json({ chainId, blockNumber: name === "fisco" ? r.chain.block : 100, blockHash: keccakOf(`${name}-code-block`), capturedAt: "2026-10-20T00:00:00.000Z", addresses: side.addr });
  }
  for (const [hash, t] of r.chain.txs) files[`txs/${hash.toLowerCase()}.json`] = json(t);
  files["hashes.json"] = hashesFileOf(files);
  const identity = { ...SOURCE, broadcastFile: SOURCE_BROADCAST_FILE, broadcastKeccak: keccak256(toHex(broadcast)) };
  return { files, source, identity, dir: packId, stepTx: r.stepTx };
}
