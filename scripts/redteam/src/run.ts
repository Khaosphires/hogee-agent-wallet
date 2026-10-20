/**
 * The suite: one main world on final-1 (the same ordered sequence on Anvil and on Sepolia), then, on Anvil only, an
 * extras world for the cases that need time travel. Every case is isolated: an exception becomes a failed row with
 * the error in errors/<taskId>.json, and the run goes on. Cases that cannot run on the target get an honest
 * "not run" row. The bundle is written at the end (and on a crash, with whatever rows exist).
 *
 * Every world names its country (country.ts): main and extras are MY (Rina), whatever the API's default
 * HOGEE_COUNTRY is; the SG world (Anvil only, after extras) runs the Singapore variants with Mei; the WEB world
 * (Anvil only, last; run-web.ts) runs Mei's chat-first journey and the web attacks as WEB variants.
 * After the cases, each world's task 1.16 bundle is exported into export/<world>/ (export.ts).
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE_TASK_IDS, type EvidenceTaskId } from "@hogee/core";
import { Bundle, type CaseReport } from "./evidence";
import { caseContext, type CaseDef, type RunState } from "./cases/context";
import { CATALOGUE } from "./cases/catalogue";
import type { RunConfig } from "./config";
import { REPO_ROOT } from "./config";
import { DEMO_COUNTRIES } from "./country";
import { exportWorlds, type WorldExport } from "./export";
import { errorReason, errorRecord } from "./redact";
import { runWebWorld } from "./run-web";
import { configSecrets, scanForSecrets, secretsOf } from "./safety";
import { jsonLogger, newStack, openInfra, type Infra, type Stack } from "./stack";

/** A country variant's own result (its rows also count in its task id's report). */
export interface VariantResult {
  readonly taskId: EvidenceTaskId;
  readonly variant: string;
  readonly status: "pass" | "fail" | "not_run";
  readonly reason?: string;
}

export interface SuiteResult {
  readonly dir: string;
  readonly reports: readonly CaseReport[];
  readonly rows: number;
  readonly variants: readonly VariantResult[];
  /** Each world's task 1.16 bundle, in world order (main, extras, sg, web). */
  readonly exports: readonly WorldExport[];
}

const caseName = (c: CaseDef): string => (c.variant ? `${c.id} (${c.variant})` : c.id);
const fileName = (c: CaseDef): string => (c.variant ? `${c.id}-${c.variant}` : c.id);

function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function forgeVersion(): string {
  try {
    return execFileSync(join(process.env.HOME ?? "", ".foundry/bin/forge"), ["--version"], { encoding: "utf8" }).split("\n")[0]?.trim() ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Runs one case; for a country variant, returns its own result (its rows only). */
export async function runCase(s: Stack, b: Bundle, state: RunState, c: CaseDef, progress: (line: string) => void): Promise<VariantResult | null> {
  const from = b.begin(c.id, c.title).rows.length;
  if (c.anvilOnly && s.infra.cfg.target !== "anvil") {
    // never reached for extras and SG (skipped below on Sepolia); kept for anvil-only cases placed in main
    b.notRun(s.deployment, c.id, c.title, c.anvilOnly);
    progress(`  ${caseName(c).padEnd(8)} not run  ${c.anvilOnly}`);
    return c.variant ? { taskId: c.id, variant: c.variant, status: "not_run", reason: c.anvilOnly } : null;
  }
  const started = Date.now();
  const ctx = caseContext(s, b, state, c.id, fileName(c));
  let errored: string | undefined;
  try {
    await c.run(ctx);
  } catch (error: unknown) {
    // Redacted: an RPC error's message and stack carry the provider URL (which can hold its key); stack lines are
    // cut to repo-relative paths.
    // A case id + variant can run twice (the WEB world's late T11 and T25): the second record gets its own file.
    const base = `errors/${fileName(c)}`;
    const rel = b.write(existsSync(join(b.dir, `${base}.json`)) ? `${base}-${b.reports.get(c.id)?.rows.length ?? 0}.json` : `${base}.json`, errorRecord(error));
    const http = ctx.h.t.save(b, fileName(c));
    b.row(s.deployment, { taskId: c.id, title: `${c.variant ? `(${c.variant}) ` : ""}${c.title}: the runner errored (see ${rel})`, expected: "success", ok: false, layer: "offchain", artifacts: [rel, ...(http ? [http] : [])] });
    errored = errorReason(error, 300);
    b.fail(c.id, errored);
  }
  for (const a of c.aliases ?? []) b.alias(c.id, a.id, a.title);
  const rep = b.reports.get(c.id);
  const own = (rep?.rows ?? []).slice(from).map((i) => b.rows[i]);
  const variant: VariantResult | null = c.variant
    ? { taskId: c.id, variant: c.variant, status: !errored && own.length > 0 && own.every((r) => r?.outcome === "pass") ? "pass" : "fail", ...(errored ? { reason: errored } : {}) }
    : null;
  // A task the main world could not run (T33 has no query path there) takes its variant's result when the variant ran.
  if (variant && rep && rep.status === "not_run" && variant.status !== "not_run") {
    rep.notes.push(`main world not run (${rep.reason ?? "?"}); variant ${c.variant} ran: ${variant.status}`);
    rep.status = variant.status;
    delete rep.reason;
  }
  const status = variant?.status ?? rep?.status ?? "?";
  const reason = variant ? variant.reason : rep?.reason;
  progress(`  ${caseName(c).padEnd(8)} ${status.padEnd(8)} ${((Date.now() - started) / 1000).toFixed(1).padStart(6)} s  ${c.title}${reason ? `  [${reason}]` : ""}`);
  return variant;
}

/** The SG world (Anvil only): Mei's facility on its own deployment; on Sepolia, or with --no-sg, its variants are not run. */
async function runSgWorld(infra: Infra, b: Bundle, main: Stack, worlds: Record<string, unknown>, secrets: string[], stacks: Stack[], progress: (line: string) => void): Promise<VariantResult[]> {
  const out: VariantResult[] = [];
  if (infra.cfg.target !== "anvil" || !infra.cfg.anvilSg) {
    const reason = infra.cfg.target === "anvil" ? "the Anvil SG world was skipped (--no-sg)" : (CATALOGUE.sg[0]?.anvilOnly ?? "Anvil only");
    for (const c of CATALOGUE.sg) {
      b.begin(c.id, c.title);
      b.notRun(main.deployment, c.id, `(${c.variant}) ${c.title}`, reason);
      out.push({ taskId: c.id, variant: c.variant ?? "", status: "not_run", reason });
    }
    return out;
  }
  let sg: Stack;
  try {
    sg = await newStack(infra, { label: "sg", country: "SG" });
  } catch (error: unknown) {
    // A world that cannot start fails its variants (with the error on file); the run and its other worlds stand.
    const reason = `the SG world could not start: ${errorReason(error, 300)}`;
    for (const c of CATALOGUE.sg) {
      b.begin(c.id, c.title);
      const rel = b.write(`errors/${fileName(c)}.json`, errorRecord(error));
      b.row(main.deployment, { taskId: c.id, title: `(${c.variant}) ${c.title}: the SG world could not start (see errors/${fileName(c)}.json)`, expected: "success", ok: false, layer: "offchain", artifacts: [rel] });
      b.fail(c.id, reason);
      out.push({ taskId: c.id, variant: c.variant ?? "", status: "fail", reason });
      progress(`  ${caseName(c).padEnd(8)} fail     ${reason}`);
    }
    return out;
  }
  secrets.push(...secretsOf(sg));
  stacks.push(sg);
  worlds.sg = { deployment: sg.deployment, facilityId: sg.facilityId, country: sg.country.countryCode };
  progress(`SG world (Anvil only, ${DEMO_COUNTRIES.SG.founderName}): final-1 ${sg.deployment.deploymentId}, facility ${sg.facilityId}`);
  const state: RunState = {};
  for (const c of CATALOGUE.sg) {
    const v = await runCase(sg, b, state, c, progress);
    if (v) out.push(v);
  }
  return out;
}

export async function runSuite(cfg: RunConfig, progress: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Promise<SuiteResult> {
  const dir = join(cfg.outDir, cfg.runId);
  mkdirSync(join(dir, "logs"), { recursive: true });
  const logFile = join(dir, "logs", "run.jsonl");
  const log = jsonLogger((line) => appendFileSync(logFile, `${line}\n`));
  let infra: Infra | null = null;
  let b: Bundle | null = null;
  const worlds: Record<string, unknown> = {};
  const stacks: Stack[] = [];
  let exports: WorldExport[] = [];
  // The loaded URLs from the start: the scan also covers a run that fails before its first world exists.
  const secrets: string[] = [...configSecrets(cfg)];
  const commit = gitCommit();
  const meta = () => ({ runId: cfg.runId, target: cfg.target, gitCommit: commit, worlds, exports, toolVersions: { forge: forgeVersion(), node: process.version } });
  try {
    try {
      infra = await openInfra(cfg, log);
      const my = DEMO_COUNTRIES.MY;
      const main = await newStack(infra, {
        label: "main",
        country: my.countryCode,
        ...(cfg.target === "sepolia" ? { facilityId: process.env.HOGEE_FACILITY_ID?.trim() || my.facilityId, founderId: process.env.HOGEE_FOUNDER_ID?.trim() || my.founderId } : {}),
      });
      // The preflight ran before any write: openInfra (chain, database, halts) and newStack (gas, before the roles).
      secrets.push(...secretsOf(main));
      stacks.push(main);
      b = new Bundle(dir, { chainId: main.deployment.chainId, target: cfg.target });
      worlds.main = { deployment: main.deployment, facilityId: main.facilityId, signers: { agent: main.signers.agent.address, oracle: main.signers.oracle.address, lender: main.signers.lender.address, relayer: main.signers.relayer.address } };
      progress(`red-team run ${cfg.runId} on ${cfg.target}: final-1 ${main.deployment.deploymentId} (chain ${main.deployment.chainId}), facility ${main.facilityId}`);
      const state: RunState = {};
      for (const c of CATALOGUE.main) await runCase(main, b, state, c, progress);
      if (cfg.target === "anvil" && cfg.anvilExtras) {
        const extras = await newStack(infra, { label: "extras", country: "MY" });
        secrets.push(...secretsOf(extras));
        stacks.push(extras);
        worlds.extras = { deployment: extras.deployment, facilityId: extras.facilityId };
        progress(`extras world (Anvil only): final-1 ${extras.deployment.deploymentId}, facility ${extras.facilityId}`);
        const xs: RunState = {};
        for (const c of CATALOGUE.extras) await runCase(extras, b, xs, c, progress);
      } else {
        for (const c of CATALOGUE.extras) {
          b.begin(c.id, c.title);
          b.notRun(main.deployment, c.id, c.title, cfg.target === "anvil" ? "the Anvil extras world was skipped (--no-extras)" : (c.anvilOnly ?? "Anvil only"));
        }
      }
      const variants = [...(await runSgWorld(infra, b, main, worlds, secrets, stacks, progress)), ...(await runWebWorld(infra, b, main, worlds, secrets, stacks, progress))];
      const missing = (EVIDENCE_TASK_IDS as readonly EvidenceTaskId[]).filter((id) => !b?.reports.has(id));
      for (const id of missing) {
        b.begin(id, id);
        b.notRun(main.deployment, id, id, "no case in the catalogue covers this id");
      }
      exports = await exportWorlds(infra, stacks, dir, commit);
      for (const e of exports) progress(`evidence ${e.world.padEnd(7)} ${e.status.padEnd(12)} ${e.path ?? ""}${e.reason ? `  [${e.reason}]` : ""}`);
      return { dir, reports: [...b.reports.values()], rows: b.rows.length, variants, exports };
    } finally {
      try {
        if (b) {
          b.finish(meta());
          b.write("run.json", { ...meta(), rows: b.rows.length });
        }
      } finally {
        await infra?.close();
      }
    }
  } finally {
    // Its own finally: a failure in finish, write or close still scans whatever is on disk.
    const hits = scanForSecrets(dir, secrets);
    if (hits.length > 0) throw new Error(`SECRET MATERIAL IN THE BUNDLE (${hits.join(", ")}): delete ${dir} and report it`);
  }
}
