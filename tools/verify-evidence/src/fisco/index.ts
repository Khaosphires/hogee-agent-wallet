/**
 * Offline checker for a FISCO BCOS mirror pack (`hogee.fisco-mirror/2`, evidence/fisco/fm-<16hex>/): the final-2
 * Sepolia run replayed on a local FISCO BCOS chain, plus refusals, and the regulator's chain-level stops (its own
 * ledger on node4, its account freeze and method ban through FISCO governance). Zero network, synchronous, browser-safe (no node:
 * imports; the CLI is ./cli.ts). Nothing the replay wrote is taken as true: every check recomputes from raw signed
 * txs, served receipts, runtime code, the forge artifacts and the source bundle, which itself must pass verifyBundle.
 *
 * What VERIFIED means: the pack is internally consistent and consistent with the pinned Sepolia bundle. The FISCO
 * chain is local and not publicly reachable, so its block headers are taken as served (not recomputed); the mirror's
 * claim is that the SAME code, inputs and signed plan ran there with the recorded outcomes.
 */
import { loadBundle, type BundleFiles } from "../load";
import { verifyBundle } from "../index";
import type { VerifyCheck } from "../util";
import type { Ctx, SourceBundle } from "./context";
import { checkDeploy, CODE_CHECK, DEPLOY_CHECK } from "./deploy";
import { checkLedger, LEDGER_CHECK } from "./ledger";
import { FILES_CHECK, loadPack } from "./load";
import { FINAL_2, type ArtifactEntry, type CodeName, type SourceIdentity } from "./pack";
import { checkParity, PARITY_CHECK } from "./parity";
import { checkPlan, checkSignatures, PLAN_CHECK, SIGNATURES_CHECK } from "./plan";
import { checkDenials, checkRefusals, DENIALS_CHECK, REFUSALS_CHECK } from "./refusals";
import { checkRegulator, REGULATOR_CHECK } from "./regulator";
import { checkFinal, checkT28, FINAL_CHECK, T28_CHECK } from "./t28";
import { buildView, CATALOGUE_CHECK, RECEIPTS_CHECK, TXS_CHECK } from "./view";

export * from "./pack";
export * from "./catalogue";
export * from "./system";
export * from "./anchor";
export * from "./anchor-online";

/** Every check line, in the order reported. */
export const FISCO_CHECKS = {
  files: FILES_CHECK,
  catalogue: CATALOGUE_CHECK,
  txs: TXS_CHECK,
  receipts: RECEIPTS_CHECK,
  deploy: DEPLOY_CHECK,
  code: CODE_CHECK,
  plan: PLAN_CHECK,
  signatures: SIGNATURES_CHECK,
  parity: PARITY_CHECK,
  refusals: REFUSALS_CHECK,
  denials: DENIALS_CHECK,
  t28: T28_CHECK,
  final: FINAL_CHECK,
  ledger: LEDGER_CHECK,
  powers: REGULATOR_CHECK,
} as const;

export interface FiscoOptions {
  /** The source evidence bundle's files (evidence/ev-74756ea61a72ae7c): required for a VERIFIED result. */
  readonly sepoliaBundle?: BundleFiles;
  /** A local forge build (contracts/out), per contract: artifacts.json must equal it. */
  readonly artifacts?: Partial<Record<CodeName, ArtifactEntry>>;
  /** The run the pack must mirror. Default: final-2 on Sepolia. Only the test suite passes another. */
  readonly source?: SourceIdentity;
}

export interface FiscoResult {
  readonly ok: boolean;
  readonly checks: readonly VerifyCheck[];
  readonly packId: string | null;
}

function sourceBundleOf(files: BundleFiles | undefined): SourceBundle | null {
  if (!files) return null;
  const loaded = loadBundle(files);
  return { parsed: loaded.bundle, verified: verifyBundle(files).ok, files };
}

const notRun = (name: string, why: string): VerifyCheck => ({ name, ok: false, detail: `not run: ${why}` });

/** Verifies a FISCO mirror pack offline. `ok` only when every check passes. */
export function verifyFiscoPack(files: BundleFiles, opts: FiscoOptions = {}): FiscoResult {
  const loaded = loadPack(files);
  const names = Object.values(FISCO_CHECKS);
  if (!loaded.pack) return { ok: false, checks: [loaded.check, ...names.slice(1).map((n) => notRun(n, "the pack's files are missing or invalid"))], packId: null };
  const pack = loaded.pack;
  const checks: VerifyCheck[] = [loaded.check];
  try {
    const built = buildView({ pack });
    checks.push(...built.checks);
    const ctx: Ctx = { files, pack, source: opts.source ?? FINAL_2, bundle: sourceBundleOf(opts.sepoliaBundle), view: built.view };
    checks.push(...checkDeploy(ctx, opts.artifacts).checks);
    checks.push(checkPlan(ctx), checkSignatures(ctx), checkParity(ctx), checkRefusals(ctx), checkDenials(ctx), checkT28(ctx), checkFinal(ctx));
    checks.push(checkLedger(ctx), checkRegulator(ctx));
  } catch (error: unknown) {
    // A checker bug must never read as "verified".
    checks.push({ name: "checker error", ok: false, detail: error instanceof Error ? error.message.slice(0, 200) : "unknown error" });
  }
  return { ok: checks.length >= names.length && checks.every((c) => c.ok), checks, packId: pack.pack.packId };
}
