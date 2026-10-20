/**
 * The regulator's steps (G and V) read back from the pack, shared by "refusals" (the chain refusals AccountFrozen and
 * PermissionDenied are derived OFFLINE from them) and "regulator powers": each step's decoded system call, its
 * symbolic catalogue arguments resolved against deployment.json, its return word (the native receipt's output), and
 * whether it took effect. Nothing the replay wrote is trusted: values come from the signed calldata and the served
 * native receipts.
 */
import { decodeFunctionData, type Hex } from "viem";
import { hogeeCallsAbi } from "../abi";
import { sameHex } from "../util";
import type { GovArg, RefusalError } from "./catalogue";
import type { Ctx, MirrorStep } from "./context";
import { targetAddressOf } from "./pack";
import { NATIVE_STATUS, outputOf, SPEND_SELECTOR } from "./system";

type HasCtx = Pick<Ctx, "pack" | "view">;

/** A role name, "Treasury" or "spend.selector" as the lowercase value it stands for; anything else as given. */
export function resolveName(ctx: HasCtx, name: string): string {
  if (name === "Treasury") return targetAddressOf(ctx.pack.deployment, "Treasury").toLowerCase();
  if (name === "spend.selector") return SPEND_SELECTOR.toLowerCase();
  const roles = ctx.pack.deployment.roles as Readonly<Record<string, string>>;
  return roles[name]?.toLowerCase() ?? name;
}

const argValue = (ctx: HasCtx, a: GovArg): string => (typeof a === "number" ? String(a) : resolveName(ctx, a));
const callValue = (v: unknown): string => (typeof v === "string" ? v.toLowerCase() : typeof v === "bigint" || typeof v === "number" ? String(v) : JSON.stringify(v));

/** The decoded system call's arguments equal the catalogue's (resolved) arguments, in order. */
export function govArgsMatch(ctx: HasCtx, s: MirrorStep): boolean {
  const want = s.entry?.governance?.args;
  const got = s.tx?.call?.args;
  if (!want || !got || s.tx?.call?.name !== s.entry?.function || got.length !== want.length) return false;
  return want.every((a, i) => callValue(got[i]) === argValue(ctx, a));
}

/** The return word of a mined system call (native status 0), or null. */
export function nativeOutput(s: MirrorStep): bigint | null {
  const n = s.tx?.file?.native;
  return n && n.status === NATIVE_STATUS.ok && s.step.outcome.kind === "mined" ? outputOf(n.output) : null;
}

/** The output a G/V step's entry requires: an exact value, or (proposal-id) any id above 0. */
export function outputIsExpected(s: MirrorStep): boolean {
  const want = s.entry?.governance?.output;
  const got = nativeOutput(s);
  if (want === undefined || got === null) return false;
  return want === "proposal-id" ? got > 0n : got === BigInt(want);
}

export const isRegulatorSigned = (ctx: HasCtx, s: MirrorStep): boolean => sameHex(s.tx?.parsed?.from, ctx.pack.deployment.roles.regulator);

/** A regulator step that took effect: signed by the regulator, mined, its arguments and return word as catalogued. */
export const tookEffect = (ctx: HasCtx, s: MirrorStep | undefined): s is MirrorStep =>
  !!s && s.tx?.blockNumber !== null && s.tx?.blockNumber !== undefined && isRegulatorSigned(ctx, s) && govArgsMatch(ctx, s) && outputIsExpected(s);

/** The block a step ran at: its mined block, or the eth_call block of a probe-only step. */
export function blockOf(s: MirrorStep | undefined): bigint | null {
  if (!s) return null;
  if (s.step.outcome.kind === "probe-only") return s.step.call ? BigInt(s.step.call.block) : null;
  return s.tx?.blockNumber ?? null;
}

const isAgent = (ctx: HasCtx, s: MirrorStep): boolean => sameHex(s.tx?.parsed?.from, ctx.pack.deployment.roles.agent);
const before = (ctx: HasCtx, s: MirrorStep, fn: (x: MirrorStep) => boolean): MirrorStep[] => ctx.view.steps.filter((x) => x.step.seq < s.step.seq && fn(x));
const isFn = (name: string) => (x: MirrorStep): boolean => x.entry?.function === name && !!x.entry.governance;

/** The block of the agent's first tx in the pack (any step), or null. */
export function firstAgentBlock(ctx: HasCtx): bigint | null {
  const blocks = ctx.view.steps.filter((s) => isAgent(ctx, s) && s.tx?.blockNumber !== null && s.tx?.blockNumber !== undefined).map((s) => s.tx?.blockNumber as bigint);
  return blocks.length > 0 ? blocks.reduce((a, b) => (b < a ? b : a)) : null;
}

/** G0: the agent's account registered (status 0 from the regulator) in a block before the agent's first tx. */
export function registeredFirst(ctx: HasCtx): string | null {
  const g0 = ctx.view.steps.find((x) => isFn("setAccountStatus")(x));
  const first = firstAgentBlock(ctx);
  if (!g0 || g0.entry?.id !== "G0" || !tookEffect(ctx, g0) || g0.tx?.call?.args[1] !== 0) return "G0 (the agent's registration) did not take effect";
  if (first === null || (g0.tx?.blockNumber as bigint) >= first) return "G0 is not in a block before the agent's first transaction";
  return null;
}

type Derived = { readonly errors: readonly RefusalError[] } | { readonly why: string };

/**
 * account-frozen: the last account-status step before the refusal froze the agent (status 1, took effect) in a
 * strictly earlier block, a V step after it read 1 on chain in a block before the refusal, and G0 registered the
 * agent first (trap 1: a freeze of an unregistered account freezes nothing).
 */
function frozen(ctx: HasCtx, s: MirrorStep): Derived {
  const at = s.tx?.blockNumber;
  if (!isAgent(ctx, s) || at === null || at === undefined) return { why: "not a mined tx of the agent" };
  const reg = registeredFirst(ctx);
  if (reg) return { why: reg };
  const last = before(ctx, s, isFn("setAccountStatus")).at(-1);
  if (!tookEffect(ctx, last) || last.tx?.call?.args[1] !== 1 || !sameHex(String(last.tx?.call?.args[0]), ctx.pack.deployment.roles.agent)) return { why: "the last account-status step before it did not freeze the agent" };
  if ((last.tx?.blockNumber as bigint) >= at) return { why: "the freeze is not in an earlier block" };
  const confirmed = before(ctx, s, isFn("getAccountStatus")).filter((v) => v.step.seq > last.step.seq && tookEffect(ctx, v) && nativeOutput(v) === 1n && (v.tx?.blockNumber as bigint) < at);
  return confirmed.length > 0 ? { errors: ["AccountFrozen"] } : { why: "no V step read the frozen status on chain before it" };
}

const isSpend = (ctx: HasCtx, s: MirrorStep): boolean =>
  sameHex(s.tx?.parsed?.to, targetAddressOf(ctx.pack.deployment, "Treasury")) && (s.tx?.parsed?.data ?? "").toLowerCase().startsWith(SPEND_SELECTOR.toLowerCase());

/** The read value a G step recorded after its receipt, or null. */
export const readAfter = (s: MirrorStep | undefined, label: string): string | null => s?.step.reads.find((r) => r.label === label)?.after ?? null;

/**
 * method-banned: G3 made the regulator Treasury's admin (its read after) before G4 and G5; the last method-auth-type
 * step set blacklist mode, and the last open/close of spend for the agent closed it, each took effect in a strictly
 * earlier block than the refusal.
 */
function banned(ctx: HasCtx, s: MirrorStep): Derived {
  const at = s.tx?.blockNumber;
  if (!isAgent(ctx, s) || at === null || at === undefined || !isSpend(ctx, s)) return { why: "not a mined Treasury.spend of the agent" };
  const admin = before(ctx, s, isFn("createResetAdminProposal")).at(-1);
  if (!tookEffect(ctx, admin) || readAfter(admin, "treasuryAdmin") !== ctx.pack.deployment.roles.regulator.toLowerCase()) return { why: "the regulator did not become Treasury's admin first" };
  const type = before(ctx, s, isFn("setMethodAuthType")).at(-1);
  const toggles = before(ctx, s, (x) => isFn("closeMethodAuth")(x) || isFn("openMethodAuth")(x));
  const close = toggles.at(-1);
  const steps = [type, close];
  if (!tookEffect(ctx, type) || !tookEffect(ctx, close) || close.entry?.function !== "closeMethodAuth") return { why: "spend was not closed for the agent (blacklist type, then close) by steps that took effect" };
  if (steps.some((x) => (x?.step.seq ?? 0) < admin.step.seq || (x?.tx?.blockNumber as bigint) <= (admin.tx?.blockNumber as bigint) || (x?.tx?.blockNumber as bigint) >= at)) return { why: "the ban is not between the admin reset and the refusal" };
  return { errors: ["PermissionDenied"] };
}

/** The chain refusal a step's rule derives, offline. */
export function deriveChainRefusal(ctx: HasCtx, s: MirrorStep): Derived {
  if (s.entry?.rule === "account-frozen") return frozen(ctx, s);
  if (s.entry?.rule === "method-banned") return banned(ctx, s);
  return { why: "not a chain refusal rule" };
}

/** The recordDenied call a probe-only step's eth_call makes, or null. */
export function probeCallName(data: string): string | null {
  try {
    return decodeFunctionData({ abi: hogeeCallsAbi, data: data as Hex }).functionName;
  } catch {
    return null;
  }
}

/**
 * The regulator's last word on the agent, from the steps that took effect: its account status (the last
 * setAccountStatus) and whether Treasury.spend is allowed for it (the last open/close; allowed when never closed).
 * "unknown" when the last such step did not take effect.
 */
export function regulatorFinal(ctx: HasCtx): { readonly agentAccountStatus: string; readonly spendAllowedForAgent: string } {
  const account = ctx.view.steps.filter(isFn("setAccountStatus")).at(-1);
  const toggle = ctx.view.steps.filter((x) => isFn("closeMethodAuth")(x) || isFn("openMethodAuth")(x)).at(-1);
  const agentAccountStatus = tookEffect(ctx, account) ? String(account.tx?.call?.args[1]) : "unknown";
  const spendAllowedForAgent = !toggle ? "true" : tookEffect(ctx, toggle) ? String(toggle.entry?.function === "openMethodAuth") : "unknown";
  return { agentAccountStatus, spendAllowedForAgent };
}
