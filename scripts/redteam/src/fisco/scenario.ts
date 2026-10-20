/**
 * The replay itself: every catalogue step (tools/verify-evidence/src/fisco/catalogue.ts), in order, with its arguments
 * taken from the final-2 Sepolia bytes (source.ts) wherever final-2 has a matching tx:
 *   calldata  S1 S4 S16 S18a S18b T28a: final-2's calldata byte for byte;
 *   envelope  S3 S5 S15: final-2's signed struct with a fresh nonce and expiry, signed again by the mirror's founder
 *             (passkey) over the FISCO domain (S3 also takes the mirror's agent address, the same FINAL key on FISCO);
 *   order     S6 S10: final-2's orderId, milestone idx and amount (fresh decision id and rationale).
 * The rest (founder key, refusals, denials, sale, stage 2, T28b) follow the catalogue entry's line, payee and amount.
 * Fresh ids are keccak256 of a fixed label, so two runs differ only in nonces, expiries and signatures.
 *
 * Pack v2 adds the regulator (governance.ts): G0 registers the agent's account first; after S15, G1 freezes it, V1
 * proves it frozen, F1 sends SPEND and the chain refuses it; G2/V2 unfreeze, C1 probes SPEND; G3–G5 make the regulator
 * Treasury's admin and ban spend for the agent, M1 sends SPEND and the chain refuses it, C2 probes another method, G6
 * lifts the ban, C3 probes SPEND; then S16/R17 refuse the same SPEND at contract level. SPEND is R17's calldata, built
 * once from the R17 entry and reused byte for byte by F1, C1, M1, C3 and R17.
 */
import {
  buildBindPayee,
  buildCommitPlan,
  buildFundMilestone,
  buildRecordDenied,
  buildRecordSale,
  buildRegisterFounderKey,
  buildReleaseMilestone,
  buildReleaseStage,
  buildSpend,
  buildTighten,
  hashLines,
  hashMilestoneRelease,
  hashPlanApproval,
  hashStageRelease,
  hashSupplierApproval,
  hogeeDomain,
  hogeeDomainSeparator,
  HOGEE_KINDS,
  iMilestoneEscrowAbi,
  iPlanRegistryAbi,
  iTreasuryAbi,
  lineKeyToLineId,
  manifestToLines,
  manifestToStages,
  shortIdToBytes32,
  toBytes32Tag,
  type HogeeDomain,
  type LineKey,
  type MilestoneReleaseMessage,
  type OnchainSig,
  type OnchainLine,
  type OnchainStage,
  type PlanApprovalMessage,
  type SupplierApprovalMessage,
} from "@hogee/chain";
import { hashObject, type PlanManifest } from "@hogee/core";
import { decodeFunctionData, keccak256, stringToHex, zeroAddress, type Abi, type Hex, type LocalAccount } from "viem";
import { CATALOGUE, catalogueEntry, denialLineIdOf, expectedErrorsFor, isChainRefusal, reasonCodeOf, type CatalogueEntry, type HogeeError } from "../../../../tools/verify-evidence/src/fisco/catalogue";
import { FINAL_2, FISCO_CHAIN_TAG, type DeployedName, type PlanFile, type T28File } from "../../../../tools/verify-evidence/src/fisco/pack";
import { chainStepReads, checkChainStep, checkGovResult, govStepCall, ScenarioError, type GovContext } from "./governance";
import type { Reader } from "./reads";
import type { ReadSpec, StepCall, StepRunner } from "./runner";
import { ecdsaSig, type Founder } from "./sign";
import { findSepoliaTx, milestoneReleaseSignature, type SepoliaSource } from "./source";
import { typedDataJson } from "./typed-data";

export { ScenarioError };

export interface ScenarioDeps {
  readonly runner: StepRunner;
  readonly reader: Reader;
  readonly src: SepoliaSource;
  readonly contracts: Readonly<Record<DeployedName, Hex>>;
  readonly signers: { readonly lender: LocalAccount; readonly agent: LocalAccount; readonly regulator: LocalAccount };
  /** Treasury's ContractAuth admin before G3 (the deployer of the mirror's contracts). */
  readonly deployer: Hex;
  readonly founder: Founder;
  /** Wall-clock unix seconds. */
  readonly nowSeconds: () => bigint;
  readonly sleep: (ms: number) => Promise<void>;
  readonly randomNonce: () => bigint;
}

export interface ScenarioResult {
  readonly plan: PlanFile;
  readonly t28: T28File;
  readonly orderId: Hex;
  readonly settlementIds: readonly Hex[];
}

/** Explicit gas per function (no estimation; FISCO has no P256 precompile, ~300k per passkey verify). */
const GAS: Readonly<Record<string, bigint>> = { commitPlan: 20_000_000n, bindPayee: 5_000_000n, releaseMilestone: 5_000_000n, releaseStage: 3_000_000n };
const gasOf = (fn: string): bigint => GAS[fn] ?? 2_000_000n;
/** Fresh signed structs expire one hour after signing (the replay takes minutes). */
const SIGNATURE_TTL = 3_600n;
const COOLING_SLACK_SECONDS = 5n;

const label = (what: string, id: string): Hex => keccak256(stringToHex(`fisco-mirror:${what}:${id}`));

function decode(abi: Abi, data: Hex, fn: string): readonly unknown[] {
  const d = decodeFunctionData({ abi, data });
  if (d.functionName !== fn) throw new ScenarioError(`final-2 calldata calls ${d.functionName}, expected ${fn}`);
  return d.args ?? [];
}

/** JSON pointers of the leaves where two JSON values differ. */
export function jsonDiffPointers(a: unknown, b: unknown, path = ""): string[] {
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return Object.is(a, b) ? [] : [path || "/"];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.flatMap((k) => jsonDiffPointers((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`));
}

class Scenario {
  private readonly data = new Map<string, Hex>();
  private readonly fiscoTag = toBytes32Tag(FISCO_CHAIN_TAG);
  private readonly deploymentId = toBytes32Tag(FINAL_2.deploymentId);
  private manifest: PlanManifest | null = null;
  private plan: PlanFile | null = null;
  private t28b: T28File["t28b"] | null = null;
  private v1: { approval: PlanApprovalMessage; lines: OnchainLine[]; stages: OnchainStage[] } | null = null;
  private release: MilestoneReleaseMessage | null = null;
  private readonly settlementIds: Hex[] = [];
  private readonly blockTime = new Map<string, bigint>();
  /** R17's calldata, built once (F1, C1, M1, C3 and R17 send or probe exactly these bytes). */
  private spendBytes: Hex | null = null;

  constructor(private readonly d: ScenarioDeps) {}

  domain(name: DeployedName): HogeeDomain {
    return hogeeDomain({ verifyingContract: this.d.contracts[name], chainTag: this.fiscoTag, deploymentId: this.deploymentId });
  }

  private fresh(): { nonce: bigint; expiry: bigint } {
    return { nonce: this.d.randomNonce(), expiry: this.d.nowSeconds() + SIGNATURE_TTL };
  }

  private sepolia(e: CatalogueEntry): { hash: Hex; data: Hex } {
    if (!e.sepolia) throw new ScenarioError(`${e.id} has no final-2 mirror spec`);
    return findSepoliaTx(this.d.src, e.sepolia);
  }

  /** The final-2 MilestoneRelease (S15, T28b, R8 reuse its fields with a fresh nonce and expiry). */
  private sepoliaRelease(): MilestoneReleaseMessage {
    if (this.release) return this.release;
    const t = findSepoliaTx(this.d.src, { source: "payment", kind: "RELEASE_MILESTONE", milestoneIdx: 1, compare: "calldata" });
    this.release = decode(iMilestoneEscrowAbi as Abi, t.data, "releaseMilestone")[0] as MilestoneReleaseMessage;
    return this.release;
  }

  private async verifyDomains(): Promise<void> {
    for (const name of ["PlanRegistry", "Treasury", "MilestoneEscrow"] as const) {
      const onChain = await this.d.reader.view<Hex>(name, "domainSeparator");
      if (onChain !== hogeeDomainSeparator(this.domain(name))) throw new ScenarioError(`${name}.domainSeparator() is not the fisco/final-2 domain of its address`);
    }
  }

  private s3(e: CatalogueEntry): StepCall {
    const src = this.d.src;
    const t = this.sepolia(e);
    const [sep, lines, stages] = decode(iPlanRegistryAbi as Abi, t.data, "commitPlan") as [PlanApprovalMessage, OnchainLine[], OnchainStage[]];
    const agent = this.d.signers.agent.address.toLowerCase() as Hex;
    const manifest = { ...src.manifest, agent: { ...src.manifest.agent, address: agent } } as PlanManifest;
    const planHash = hashObject(manifest) as Hex;
    if (hashLines(lines) !== sep.linesHash || hashLines(manifestToLines(manifest)) !== sep.linesHash) throw new ScenarioError("final-2's commitPlan lines do not hash to its linesHash / the manifest");
    if (sep.planHash !== src.planHash) throw new ScenarioError("final-2's commitPlan planHash is not the bundle's planHash");
    const approval: PlanApprovalMessage = { ...sep, agent, planHash, ...this.fresh() };
    const domain = this.domain("PlanRegistry");
    const digest = hashPlanApproval(domain, approval);
    const { sig, assertion } = this.d.founder.sign(digest);
    this.manifest = manifest;
    this.v1 = { approval, lines, stages };
    this.plan = {
      manifest,
      planHash,
      sepoliaPlanHash: src.planHash,
      diffFromSepolia: jsonDiffPointers(src.manifest, manifest),
      approval: { typedData: typedDataJson("PlanApproval", domain, approval), digest, submission: { passkey: assertion } },
    };
    return { entry: e, data: buildCommitPlan({ approval, lines, stages, founder: sig }).data, gas: gasOf(e.function), links: { sepoliaTx: t.hash } };
  }

  private s5(e: CatalogueEntry): StepCall {
    const t = this.sepolia(e);
    const [sep, schedule, autoRelease] = decode(iTreasuryAbi as Abi, t.data, "bindPayee") as [SupplierApprovalMessage, bigint[], boolean[]];
    const approval: SupplierApprovalMessage = { ...sep, ...this.fresh() };
    const { sig } = this.d.founder.sign(hashSupplierApproval(this.domain("Treasury"), approval));
    return { entry: e, data: buildBindPayee({ approval, schedule, autoRelease, founder: sig }).data, gas: gasOf(e.function), links: { sepoliaTx: t.hash } };
  }

  private fundMilestone(e: CatalogueEntry): StepCall {
    const t = this.sepolia(e);
    const [orderId, idx, amountMinor] = decode(iMilestoneEscrowAbi as Abi, t.data, "fundMilestone") as [Hex, number, bigint];
    if (String(amountMinor) !== e.amountMinor) throw new ScenarioError(`${e.id}: final-2 funded ${amountMinor}, the catalogue says ${e.amountMinor}`);
    const data = buildFundMilestone({ orderId, idx, amountMinor, decisionId: label("decision", e.id), rationaleHash: label("rationale", e.id) }).data;
    return { entry: e, data, gas: gasOf(e.function), links: { sepoliaTx: t.hash } };
  }

  /** S6 waits out the payee cooling on the wall clock (FISCO makes no empty blocks): past coolingUntil and the wait. */
  private async waitCooling(e: CatalogueEntry): Promise<void> {
    const orderId = this.sepoliaRelease().orderId;
    const binding = await this.d.reader.view<{ coolingUntil: bigint }>("Treasury", "payeeBinding", [lineKeyToLineId("SUPPLIER"), await this.orderPayee(orderId)]);
    const bound = this.blockTime.get("S5");
    if (bound === undefined) throw new ScenarioError(`${e.id} waits on S5, which has not been mined`);
    const afterWait = bound + BigInt(e.waitBeforeSeconds ?? 0);
    const afterCooling = binding.coolingUntil + COOLING_SLACK_SECONDS;
    const until = afterWait > afterCooling ? afterWait : afterCooling;
    for (let now = this.d.nowSeconds(); now < until; now = this.d.nowSeconds()) await this.d.sleep(Number(until - now) * 1000);
  }

  private async orderPayee(orderId: Hex): Promise<Hex> {
    const o = await this.d.reader.view<{ payeeId: Hex; exists: boolean }>("MilestoneEscrow", "order", [orderId]);
    if (!o.exists) throw new ScenarioError(`order ${orderId} is not open on the mirror`);
    return o.payeeId;
  }

  /** A MilestoneRelease with final-2's fields and a fresh nonce/expiry, signed under `domain` by the founder or the agent. */
  private async releaseCall(e: CatalogueEntry, domain: HogeeDomain, by: "founder" | "agent"): Promise<StepCall> {
    const message: MilestoneReleaseMessage = { ...this.sepoliaRelease(), ...this.fresh() };
    const digest = hashMilestoneRelease(domain, message);
    let sig: OnchainSig;
    if (by === "agent") sig = await ecdsaSig(this.d.signers.agent, digest);
    else {
      const signed = this.d.founder.sign(digest);
      sig = signed.sig;
      if (e.id === "T28b") this.t28b = { typedData: typedDataJson("MilestoneRelease", domain, message), digest, assertion: signed.assertion };
    }
    return { entry: e, data: buildReleaseMilestone({ release: message, founder: sig }).data, gas: gasOf(e.function), reads: this.releaseReads(message.nonce) };
  }

  private releaseReads(nonce: bigint): ReadSpec[] {
    const orderId = this.sepoliaRelease().orderId;
    return [this.d.reader.nonceUsed("MilestoneEscrow", nonce), this.d.reader.milestone(orderId, 1), this.d.reader.balance("escrowedMinor")];
  }

  private spendData(e: CatalogueEntry): Hex {
    if (!e.line || !e.payee || !e.amountMinor) throw new ScenarioError(`${e.id}: a spend needs line, payee and amount`);
    return buildSpend({ lineId: lineKeyToLineId(e.line as LineKey), payeeId: shortIdToBytes32(e.payee), amountMinor: BigInt(e.amountMinor), invoiceHash: label("invoice", e.id), planVersion: 1, decisionId: label("decision", e.id), rationaleHash: label("rationale", e.id) }).data;
  }

  private spend(e: CatalogueEntry, reads: ReadSpec[]): StepCall {
    return { entry: e, data: this.spendData(e), gas: gasOf(e.function), reads };
  }

  /** SPEND: R17's exact calldata, built once from the R17 entry; F1, C1, M1, C3 and R17 itself reuse the bytes. */
  private spendOnce(e: CatalogueEntry, reads: ReadSpec[]): StepCall {
    const r17 = catalogueEntry("R17");
    if (!r17 || (e.sameCalldataAs !== "R17" && e.id !== "R17")) throw new ScenarioError(`${e.id} does not send R17's spend`);
    this.spendBytes ??= this.spendData(r17);
    return { entry: e, data: this.spendBytes, gas: gasOf(e.function), reads };
  }

  private gov(): GovContext {
    return { reader: this.d.reader, agent: this.d.signers.agent.address.toLowerCase() as Hex, regulator: this.d.signers.regulator.address.toLowerCase() as Hex, deployer: this.d.deployer.toLowerCase() as Hex };
  }

  /** The reads R17 records (and F1/M1 with them): the line's spent amount, paused, the treasury's spent total. */
  private spendReads(): ReadSpec[] {
    const r = this.d.reader;
    return [r.pocketField("PLATFORM_FEES", "spentMinor"), r.spec("Treasury.paused()", "Treasury", "paused"), r.balance("spentMinor")];
  }

  /** C2: the agent's recordDenied (another Treasury method), probed only while spend is banned; never sent. */
  private c2(e: CatalogueEntry): StepCall {
    if (!this.spendBytes) throw new ScenarioError("C2 runs after the spend was built");
    const data = buildRecordDenied({ lineId: denialLineIdOf(e) as Hex, decisionId: label("decision", e.id), reasonCode: toBytes32Tag("PermissionDenied"), proposalHash: keccak256(this.spendBytes) }).data;
    return { entry: e, data, gas: gasOf(e.function), reads: chainStepReads(e, [], this.gov()) };
  }

  private denial(e: CatalogueEntry): StepCall {
    const of = e.recordsDenialOf ? CATALOGUE.find((x) => x.id === e.recordsDenialOf) : undefined;
    const refused = of ? this.data.get(of.id) : undefined;
    if (!of?.expectedError || !refused) throw new ScenarioError(`${e.id}: its refusal ${String(e.recordsDenialOf)} has not run`);
    if (isChainRefusal(of.expectedError)) throw new ScenarioError(`${e.id}: a chain refusal has no recorded denial`);
    const data = buildRecordDenied({ lineId: denialLineIdOf(e) as Hex, decisionId: label("decision", e.id), reasonCode: reasonCodeOf(of.expectedError as HogeeError) as Hex, proposalHash: keccak256(refused) }).data;
    return { entry: e, data, gas: gasOf(e.function), links: { recordsDenialOf: of.id } };
  }

  private async r9a(e: CatalogueEntry): Promise<StepCall> {
    if (!this.manifest || !this.v1 || !this.plan) throw new ScenarioError("R9a runs after S3");
    const raised = e.amountMinor ?? CATALOGUE.find((x) => x.id === "R9b")?.amountMinor ?? "30000";
    const v2 = { ...this.manifest, version: 2, prevPlanHash: this.plan.planHash, lines: this.manifest.lines.map((l) => (l.lineKey === "LOGISTICS" ? { ...l, perTxCapMinor: raised } : l)) } as PlanManifest;
    const lines = manifestToLines(v2);
    const approval: PlanApprovalMessage = { ...this.v1.approval, version: 2, prevPlanHash: this.plan.planHash as Hex, planHash: hashObject(v2) as Hex, linesHash: hashLines(lines), ...this.fresh() };
    const sig = await ecdsaSig(this.d.signers.agent, hashPlanApproval(this.domain("PlanRegistry"), approval));
    const reads = [this.d.reader.spec("PlanRegistry.planVersion()", "PlanRegistry", "planVersion"), this.d.reader.nonceUsed("PlanRegistry", approval.nonce), this.d.reader.spec("PlanRegistry.line(LOGISTICS).perTxCapMinor", "PlanRegistry", "line", [lineKeyToLineId("LOGISTICS")], (l: { perTxCapMinor: bigint }) => l.perTxCapMinor)];
    return { entry: e, data: buildCommitPlan({ approval, lines, stages: this.v1.stages, founder: sig }).data, gas: gasOf(e.function), reads };
  }

  private async s12(e: CatalogueEntry): Promise<StepCall> {
    const stage = this.manifest?.stages[1];
    if (!stage || String(stage.releaseMinor) !== e.amountMinor) throw new ScenarioError("S12: the plan's stage 2 is not the catalogue's amount");
    const req = { stageId: toBytes32Tag(stage.stageId), amountMinor: BigInt(stage.releaseMinor), deploymentId: this.deploymentId, ...this.fresh() };
    const sig = await ecdsaSig(this.d.signers.lender, hashStageRelease(this.domain("Treasury"), req));
    return { entry: e, data: buildReleaseStage({ req, lender: sig }).data, gas: gasOf(e.function) };
  }

  /** T28a's error from the signed expiry and the clock (re-checked against the mined block's time afterwards). */
  private t28aError(e: CatalogueEntry, at: bigint): HogeeError {
    const err = expectedErrorsFor(e, { from: at, to: at }, this.sepoliaRelease().expiry)[0];
    if (!err) throw new ScenarioError("T28a: no expected error");
    return err;
  }

  private async callFor(e: CatalogueEntry): Promise<StepCall> {
    const r = this.d.reader;
    if (e.governance) return govStepCall(e, this.gov());
    switch (e.id) {
      case "S2":
        return { entry: e, data: buildRegisterFounderKey({ qx: this.d.founder.qx, qy: this.d.founder.qy, ownerEOA: zeroAddress }).data, gas: gasOf(e.function) };
      case "S3":
        return this.s3(e);
      case "S5":
        return this.s5(e);
      case "S6":
      case "S10":
        return this.fundMilestone(e);
      case "R7":
        return this.spend(e, [r.pocketField("LOGISTICS", "spentMinor"), r.spec("Treasury.rollingSpent(LOGISTICS)", "Treasury", "rollingSpent", [lineKeyToLineId("LOGISTICS")]), r.balance("spentMinor")]);
      case "R17":
        return this.spendOnce(e, this.spendReads());
      case "F1":
      case "M1":
      case "C1":
      case "C3":
        return this.spendOnce(e, chainStepReads(e, this.spendReads(), this.gov()));
      case "C2":
        return this.c2(e);
      case "D7":
      case "D9":
      case "D17":
        return this.denial(e);
      case "R8":
        return this.releaseCall(e, this.domain("MilestoneEscrow"), "agent");
      case "R9a":
        return this.r9a(e);
      case "R9b":
        return { entry: e, data: buildTighten({ kind: HOGEE_KINDS.TIGHTEN_LOWER_PER_TX_CAP, target: lineKeyToLineId("LOGISTICS"), newValue: BigInt(e.amountMinor ?? "0"), decisionId: label("decision", e.id) }).data, gas: gasOf(e.function), reads: [r.pocketField("LOGISTICS", "perTxCapMinor")] };
      case "S11":
        return { entry: e, data: buildRecordSale({ saleIdHash: keccak256(stringToHex("fisco-mirror:sale-1")), amountBucket: BigInt(e.amountMinor ?? "0") }).data, gas: gasOf(e.function) };
      case "S12":
        return this.s12(e);
      case "T28a": {
        const t = this.sepolia(e);
        return { entry: e, data: t.data, gas: gasOf(e.function), reads: this.releaseReads(this.sepoliaRelease().nonce), links: { sepoliaTx: t.hash }, expectedError: this.t28aError(e, this.d.nowSeconds()) };
      }
      case "T28b": {
        const sepoliaEscrow = hogeeDomain({ verifyingContract: this.d.src.contracts.MilestoneEscrow, chainTag: toBytes32Tag(FINAL_2.chainTag), deploymentId: this.deploymentId });
        return this.releaseCall(e, sepoliaEscrow, "founder");
      }
      case "S15": {
        // An expected success records no reads (as in pack v1): the release's reads are only for its refusals.
        const { reads: _unused, ...call } = await this.releaseCall(e, this.domain("MilestoneEscrow"), "founder");
        return { ...call, links: { sepoliaTx: this.sepolia(e).hash } };
      }
      default: {
        if (e.sepolia?.compare !== "calldata") throw new ScenarioError(`no builder for catalogue step ${e.id}`);
        const t = this.sepolia(e);
        if (e.function === "confirmSettlement") this.settlementIds.push(decode(iTreasuryAbi as Abi, t.data, "confirmSettlement")[0] as Hex);
        return { entry: e, data: t.data, gas: gasOf(e.function), links: { sepoliaTx: t.hash } };
      }
    }
  }

  async run(): Promise<ScenarioResult> {
    await this.verifyDomains();
    for (const e of CATALOGUE) {
      if (e.waitBeforeSeconds) await this.waitCooling(e);
      const call = await this.callFor(e);
      const result = await this.d.runner.run(call);
      const { step, tx } = result;
      this.data.set(e.id, call.data);
      if (e.governance) checkGovResult(e, result, this.gov());
      checkChainStep(e, result);
      if (tx?.block) this.blockTime.set(e.id, BigInt(tx.block.timestamp));
      if (e.id === "T28a" && tx?.block && step.expectedError !== this.t28aError(e, BigInt(tx.block.timestamp))) throw new ScenarioError("T28a: the mined block's time derives another error than the one recorded");
    }
    if (!this.plan || !this.t28b) throw new ScenarioError("the scenario ended without S3 / T28b");
    const t28tx = findSepoliaTx(this.d.src, { source: "payment", kind: "RELEASE_MILESTONE", milestoneIdx: 1, compare: "calldata" });
    return {
      plan: this.plan,
      t28: { sepoliaSignature: milestoneReleaseSignature(this.d.src) as T28File["sepoliaSignature"], sepoliaTx: { hash: t28tx.hash, raw: t28tx.raw }, t28b: this.t28b },
      orderId: this.sepoliaRelease().orderId,
      settlementIds: this.settlementIds,
    };
  }
}

export const runScenario = (d: ScenarioDeps): Promise<ScenarioResult> => new Scenario(d).run();
