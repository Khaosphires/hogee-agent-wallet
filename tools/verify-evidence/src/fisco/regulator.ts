/**
 * Check "regulator powers": the regulator stopped the agent's spend twice through FISCO's own governance, and the
 * officer's pause stopped it a third time, on byte-identical calldata.
 *   - the chain's genesis auth admin (chain.json auth) is the regulator, whose address is none of the other roles'
 *     (deployer, lender, oracle, agent, relayer, observer): its powers are a key of its own;
 *   - every G and V step is the regulator's tx, decodes to the catalogue's system call with the catalogue's arguments
 *     (roles, Treasury and spend's selector resolved from deployment.json), and returned what the catalogue says (its
 *     native output: 0; V1 1, V2 0; G3 a proposal id) — a non-zero return rides inside a SUCCESS receipt, so it is
 *     the only proof a step took effect; G3's getAdmin read is the regulator afterwards; each catalogued read holds;
 *   - the order: G0 before S1, G1 < V1 < F1 < G2 < V2 ≤ C1 < G3 < G4 < G5 < M1 ≤ C2 < G6 ≤ C3 < S16 (blocks; a C
 *     step's block is its eth_call's);
 *   - F1, M1 and R17 sent the same calldata, and C1/C3 probed it; C2 probed a recordDenied by the agent; all three
 *     probes passed;
 *   - the final reads show the agent's account normal and spend allowed, as its last G steps left them.
 */
import { Problems, sameHex, type VerifyCheck } from "../util";
import { FINAL_READS, GOV_STEP_IDS } from "./catalogue";
import type { Ctx, MirrorStep } from "./context";
import { blockOf, govArgsMatch, isRegulatorSigned, nativeOutput, outputIsExpected, readAfter, registeredFirst, resolveName } from "./govern";
import { ROLES, stepLabel } from "./pack";

export const REGULATOR_CHECK = "regulator powers";

/** One G or V step: signer, call, arguments, return word and its catalogued read. */
function checkGovStep(ctx: Ctx, s: MirrorStep, p: Problems): void {
  const label = stepLabel(s.step);
  const gov = s.entry?.governance;
  if (!gov) return;
  if (s.step.outcome.kind !== "mined" || s.tx?.blockNumber === null || s.tx?.blockNumber === undefined) return p.add(`${label}: the regulator's call was not mined`);
  if (!isRegulatorSigned(ctx, s)) p.add(`${label}: not signed by the regulator`);
  if (!govArgsMatch(ctx, s)) p.add(`${label}: its call is not ${s.entry?.function}(${gov.args.join(", ")})`);
  if (!outputIsExpected(s)) p.add(`${label}: returned ${String(nativeOutput(s) ?? "no readable output")}, the catalogue expects ${gov.output}`);
  if (!s.step.probe.ok) p.add(`${label}: its eth_call before sending failed`);
  const read = gov.read;
  if (!read) return;
  const got = s.step.reads.find((r) => r.label === read.label);
  if (!got) return p.add(`${label}: no ${read.label} read`);
  if (read.before !== undefined && got.before !== resolveName(ctx, read.before)) p.add(`${label}: ${read.label} before is ${got.before}, the catalogue says ${read.before}`);
  if (got.after !== resolveName(ctx, read.after)) p.add(`${label}: ${read.label} after is ${got.after}, the catalogue says ${read.after}`);
}

/** Block (or eth_call block) order of the run; `strict` false allows the same block (a probe right after a tx). */
const ORDER: readonly (readonly [string, string, boolean])[] = [
  ["G0", "S1", true], ["G1", "V1", true], ["V1", "F1", true], ["F1", "G2", true], ["G2", "V2", true], ["V2", "C1", false], ["C1", "G3", true],
  ["G3", "G4", true], ["G4", "G5", true], ["G5", "M1", true], ["M1", "C2", false], ["C2", "G6", true], ["G6", "C3", false], ["C3", "S16", true],
];

function checkOrder(ctx: Ctx, p: Problems): void {
  for (const [a, b, strict] of ORDER) {
    const [x, y] = [blockOf(ctx.view.byId.get(a)), blockOf(ctx.view.byId.get(b))];
    if (x === null || y === null) p.add(`${x === null ? a : b} has no block to order`);
    else if (strict ? x >= y : x > y) p.add(`${a} (block ${x}) is not ${strict ? "before" : "at or before"} ${b} (block ${y})`);
  }
}

/** The same SPEND everywhere: F1, M1, R17 sent it; C1, C3 probed it; C2 probed a recordDenied by the agent. */
function checkSameSpend(ctx: Ctx, p: Problems): void {
  const get = (id: string) => ctx.view.byId.get(id);
  const spend = get("R17")?.tx?.parsed?.data?.toLowerCase();
  if (!spend) return p.add("R17 has no calldata to compare");
  for (const id of ["F1", "M1"]) if (get(id)?.tx?.parsed?.data?.toLowerCase() !== spend) p.add(`${id}: its calldata is not R17's`);
  for (const id of ["C1", "C2", "C3"]) {
    const s = get(id);
    const call = s?.step.call;
    if (!s || !call) {
      p.add(`${id}: no probe-only eth_call`);
      continue;
    }
    if (!s.step.probe.ok) p.add(`${id}: its probe failed`);
    if (!sameHex(call.from, ctx.pack.deployment.roles.agent)) p.add(`${id}: not probed as the agent`);
    if (id !== "C2" && call.data.toLowerCase() !== spend) p.add(`${id}: the probed calldata is not R17's`);
  }
}

/** The roles the regulator's key must not double as. */
const OTHER_ROLES = ROLES.filter((r) => r !== "regulator");

export function checkRegulator(ctx: Ctx): VerifyCheck {
  const p = new Problems(REGULATOR_CHECK);
  const { auth } = ctx.pack.chain;
  const roles = ctx.pack.deployment.roles;
  const regulator = roles.regulator;
  if (!sameHex(auth.admin, regulator)) p.add("the chain's genesis auth admin is not the regulator");
  for (const role of OTHER_ROLES) if (sameHex(roles[role], regulator)) p.add(`the regulator's address is also the ${role}'s (the regulator must hold a key of its own)`);
  const missing = GOV_STEP_IDS.filter((id) => !ctx.view.byId.has(id));
  for (const id of missing) p.add(`${id}: the regulator's step is missing`);
  for (const s of ctx.view.steps) if (s.entry?.governance) checkGovStep(ctx, s, p);
  const reg = registeredFirst(ctx);
  if (reg) p.add(reg);
  if (readAfter(ctx.view.byId.get("G3"), "treasuryAdmin") !== regulator.toLowerCase()) p.add("G3: Treasury's admin is not the regulator afterwards");
  checkOrder(ctx, p);
  checkSameSpend(ctx, p);
  const final = new Map(ctx.pack.steps.final.reads.map((r) => [r.label, r.value]));
  if (final.get("agentAccountStatus") !== FINAL_READS.agentAccountStatus || final.get("spendAllowedForAgent") !== FINAL_READS.spendAllowedForAgent) p.add("the final reads do not show the agent's account normal and spend allowed");
  return p.result(`the regulator (genesis auth admin) froze and unfroze the agent (confirmed on chain by V1/V2) and banned and lifted spend for it; ${GOV_STEP_IDS.length} calls each returned what the catalogue says; F1, M1 and R17 refused the same calldata`);
}
