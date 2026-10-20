/**
 * The regulator's part of the replay (pack v2): its governance steps (G: account status, reset admin, method auth; V:
 * getAccountStatus sent as a tx to prove the new status is in force, since a status change applies from the NEXT block)
 * and the checks around the chain's own refusals (F1 frozen, M1 banned) and the probe-only steps (C1–C3).
 *
 * Every G/V call is built from the catalogue's symbolic arguments (catalogue.ts `governance.args`), never typed. Fail
 * closed, all as ScenarioError:
 *   - before a G step is signed, its eth_call must return the catalogue's output (0; G3 a proposal id above 0): a
 *     non-governor (-50000) or an unregistered account (-51900, trap 1) is caught there, with nothing sent. A V step's
 *     eth_call runs at the head, i.e. the G1/G2 block, which still shows the OLD status: only the probe's success is
 *     required there;
 *   - after it is mined: native status 0 and the native `output` equal to the catalogue's output (V1 1, V2 0);
 *   - its state read (if any) shows the catalogue's before/after (G3: Treasury's admin goes from the deployer to the
 *     regulator);
 *   - F1 / M1: native status 22 / 18 (the chain refused it, not Hogee's contract), the probe named that refusal, and the
 *     agent's account stays frozen / spend stays banned around it; C1–C3: the state the catalogue implies.
 */
import { encodeFunctionData, type Abi, type AbiFunction, type Hex } from "viem";
import { GOV_READS, type CatalogueEntry, type GovArg, type GovRead } from "../../../../tools/verify-evidence/src/fisco/catalogue";
import { isSystemName, NATIVE_STATUS, outputOf, SPEND_SELECTOR, SYSTEM_ABI } from "../../../../tools/verify-evidence/src/fisco/system";
import type { Reader } from "./reads";
import type { ReadSpec, StepCall, StepResult } from "./runner";

export class ScenarioError extends Error {
  override readonly name = "ScenarioError";
}

/** Explicit gas for a system call (P1's live test sent the observer proposal with 3,000,000). */
export const SYSTEM_GAS = 3_000_000n;

export interface GovContext {
  readonly reader: Reader;
  readonly agent: Hex;
  readonly regulator: Hex;
  /** Treasury's default ContractAuth admin before G3 (the deployer). */
  readonly deployer: Hex;
}

/** What F1/M1/C1–C3 must read around them (before = after): the regulator's state at that point of the story. */
export const CHAIN_STEP_READS: Readonly<Record<string, { readonly label: GovRead; readonly value: string }>> = {
  F1: { label: GOV_READS.accountStatus, value: "1" },
  M1: { label: GOV_READS.spendAllowed, value: "false" },
  C1: { label: GOV_READS.accountStatus, value: "0" },
  C2: { label: GOV_READS.spendAllowed, value: "false" },
  C3: { label: GOV_READS.spendAllowed, value: "true" },
};

/** The native status that proves the chain itself refused F1 / M1. */
const CHAIN_REFUSAL_STATUS: Readonly<Record<string, number>> = { AccountFrozen: NATIVE_STATUS.accountFrozen, PermissionDenied: NATIVE_STATUS.permissionDenied };

const lower = (a: string): Hex => a.toLowerCase() as Hex;

function argValue(arg: GovArg, abiType: string, x: GovContext, treasury: Hex): unknown {
  if (typeof arg === "number") return /^u?int(256|128|64)$/.test(abiType) ? BigInt(arg) : arg;
  switch (arg) {
    case "agent":
      return x.agent;
    case "regulator":
      return x.regulator;
    case "Treasury":
      return treasury;
    case "spend.selector":
      return SPEND_SELECTOR;
  }
}

/** A role name in a catalogue read ("deployer", "regulator", "agent") as its lowercase address; anything else literal. */
function readValue(v: string, x: GovContext): string {
  if (v === "deployer") return lower(x.deployer);
  if (v === "regulator") return lower(x.regulator);
  if (v === "agent") return lower(x.agent);
  return v;
}

/** The G/V step's calldata from the catalogue's symbolic arguments. */
export function govData(e: CatalogueEntry, x: GovContext): Hex {
  const g = e.governance;
  if (!g || !isSystemName(e.contract)) throw new ScenarioError(`${e.id} is not a governance step`);
  const abi = SYSTEM_ABI[e.contract] as Abi;
  const fn = abi.find((f): f is AbiFunction => f.type === "function" && f.name === e.function);
  if (!fn || fn.inputs.length !== g.args.length) throw new ScenarioError(`${e.id}: ${e.contract}.${e.function} does not take ${g.args.length} arguments`);
  const treasury = x.reader.contracts.Treasury;
  const args = g.args.map((a, i) => argValue(a, (fn.inputs[i] as { type: string }).type, x, treasury));
  return encodeFunctionData({ abi, functionName: e.function, args } as never);
}

/** Throws unless `word` is the catalogue's output (an exact value, or any proposal id above 0). */
function expectOutput(e: CatalogueEntry, word: bigint | null, where: string): void {
  const want = e.governance?.output;
  const ok = want === "proposal-id" ? word !== null && word > 0n : want !== undefined && word === BigInt(want);
  if (!ok) throw new ScenarioError(`${e.id}: the ${where} returned ${word === null ? "no single word" : String(word)}, expected ${String(want)}`);
}

/** The StepCall of a G or V step: calldata, explicit gas, its state read, and the pre-send output check. */
export function govStepCall(e: CatalogueEntry, x: GovContext): StepCall {
  const g = e.governance;
  if (!g) throw new ScenarioError(`${e.id} is not a governance step`);
  const confirm = e.function === "getAccountStatus";
  return {
    entry: e,
    data: govData(e, x),
    gas: SYSTEM_GAS,
    reads: g.read ? [x.reader.gov(g.read.label, x.agent)] : [],
    // A V step's eth_call sees the head (the G1/G2 block, old status); only its mined output counts.
    checkProbe: (ret) => (confirm ? undefined : expectOutput(e, outputOf(ret), "eth_call before sending")),
  };
}

function readOf(e: CatalogueEntry, r: StepResult, label: string): { before: string; after: string } {
  const read = r.step.reads.find((x) => x.label === label);
  if (!read) throw new ScenarioError(`${e.id}: no ${label} read was recorded`);
  return read;
}

/** After a G/V step: native status 0, the catalogue's output in the native receipt, and its read's before/after. */
export function checkGovResult(e: CatalogueEntry, r: StepResult, x: GovContext): void {
  const g = e.governance;
  if (!g) throw new ScenarioError(`${e.id} is not a governance step`);
  const native = r.tx?.native;
  if (!native || native.status !== NATIVE_STATUS.ok) throw new ScenarioError(`${e.id}: native status ${native ? native.status : "missing"}, not ${NATIVE_STATUS.ok}`);
  expectOutput(e, outputOf(native.output), "native receipt output");
  if (!g.read) return;
  const read = readOf(e, r, g.read.label);
  if (g.read.before !== undefined && read.before !== readValue(g.read.before, x)) throw new ScenarioError(`${e.id}: ${g.read.label} before was ${read.before}, expected ${readValue(g.read.before, x)}`);
  if (read.after !== readValue(g.read.after, x)) throw new ScenarioError(`${e.id}: ${g.read.label} after was ${read.after}, expected ${readValue(g.read.after, x)}`);
}

/** After F1/M1/C1–C3: the chain's refusal (native 22/18, named by the probe) and the regulator's state around it. */
export function checkChainStep(e: CatalogueEntry, r: StepResult): void {
  const want = CHAIN_STEP_READS[e.id];
  if (want) {
    const read = readOf(e, r, want.label);
    if (read.before !== want.value || read.after !== want.value) throw new ScenarioError(`${e.id}: ${want.label} read ${read.before} → ${read.after}, expected ${want.value}`);
  }
  if (e.expected !== "refused" || !e.expectedError || CHAIN_REFUSAL_STATUS[e.expectedError] === undefined) return;
  const status = r.tx?.native?.status;
  if (status !== CHAIN_REFUSAL_STATUS[e.expectedError]) throw new ScenarioError(`${e.id}: native status ${String(status)}, not ${CHAIN_REFUSAL_STATUS[e.expectedError]} (${e.expectedError}): the chain did not refuse it`);
  if (r.step.probe.error !== e.expectedError) throw new ScenarioError(`${e.id}: the probe failed with ${r.step.probe.error ?? "nothing"}, not ${e.expectedError}`);
}

/** F1/M1: R17's three reads plus the regulator's read; C1–C3: the regulator's read. */
export function chainStepReads(e: CatalogueEntry, spendReads: readonly ReadSpec[], x: GovContext): ReadSpec[] {
  const want = CHAIN_STEP_READS[e.id];
  if (!want) throw new ScenarioError(`${e.id} is not a chain-refusal or probe-only step`);
  return [...(e.probeOnly ? [] : spendReads), x.reader.gov(want.label, x.agent)];
}
