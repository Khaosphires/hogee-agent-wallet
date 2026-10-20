/**
 * The WEB world (Anvil only, after the SG world): Mei's chat-first journey on its own fresh final-1, with the ports the
 * red team controls (ports.ts): the recorded web search (every query recorded), the real offline sanctions screening
 * with a list the cases can extend, and fetch() recorded for the whole world. Its cases are the WEB variants of the
 * frozen ids (catalogue.ts `web`). On Sepolia, or with --no-web, they are written as not run. The fake Tavily key the
 * T30 case feeds into a provider error joins the run's secret scan, so a leak into any bundle file fails the run.
 */
import { uuidv7 } from "./api-internals";
import { testChecks } from "./api-internals";
import type { Bundle } from "./evidence";
import { CATALOGUE } from "./cases/catalogue";
import type { RunState } from "./cases/context";
import { DEMO_COUNTRIES } from "./country";
import { errorReason, errorRecord } from "./redact";
import { runCase, type VariantResult } from "./run";
import { secretsOf } from "./safety";
import { newStack, type Infra, type Stack } from "./stack";
import { loadRecordedFixture } from "./web/fixtures";
import { FAKE_TAVILY_KEY, recordEgress, recordedPort, recording, webChecks } from "./web/ports";

const label = (id: string, variant?: string): string => (variant ? `${id} (${variant})` : id);

export async function runWebWorld(infra: Infra, b: Bundle, main: Stack, worlds: Record<string, unknown>, secrets: string[], stacks: Stack[], progress: (line: string) => void): Promise<VariantResult[]> {
  const out: VariantResult[] = [];
  if (infra.cfg.target !== "anvil" || !infra.cfg.anvilWeb) {
    const reason = infra.cfg.target === "anvil" ? "the Anvil WEB world was skipped (--no-web)" : (CATALOGUE.web[0]?.anvilOnly ?? "Anvil only");
    for (const c of CATALOGUE.web) {
      b.begin(c.id, c.title);
      b.notRun(main.deployment, c.id, `(${c.variant}) ${c.title}`, reason);
      out.push({ taskId: c.id, variant: c.variant ?? "", status: "not_run", reason });
    }
    return out;
  }
  secrets.push(FAKE_TAVILY_KEY);
  const port = recording(recordedPort());
  const { checks, control } = webChecks(testChecks);
  const egress = recordEgress();
  try {
    let web: Stack;
    try {
      web = await newStack(infra, { label: "web", country: "SG", webSearch: port, checks });
    } catch (error: unknown) {
      const reason = `the WEB world could not start: ${errorReason(error, 300)}`;
      for (const c of CATALOGUE.web) {
        b.begin(c.id, c.title);
        const rel = b.write(`errors/${c.id}-WEB-start.json`, errorRecord(error));
        b.row(main.deployment, { taskId: c.id, title: `(${c.variant}) ${c.title}: the WEB world could not start`, expected: "success", ok: false, layer: "offchain", artifacts: [rel] });
        b.fail(c.id, reason);
        out.push({ taskId: c.id, variant: c.variant ?? "", status: "fail", reason });
        progress(`  ${label(c.id, c.variant).padEnd(10)} fail     ${reason}`);
      }
      return out;
    }
    secrets.push(...secretsOf(web));
    stacks.push(web);
    // The main world's T29 raises a worker halt (global to hogee_worker); the WEB journey needs the agent's jobs, as
    // the anvil target's setup does for a fresh run (Anvil only: this world never runs on Sepolia).
    const cleared = await infra.db.$client.query("update hogee_worker.halts set cleared_at = now(), cleared_by = 'redteam-web-setup' where cleared_at is null");
    if ((cleared.rowCount ?? 0) > 0) progress(`WEB world: cleared ${cleared.rowCount} open worker halt(s) left by the main world`);
    worlds.web = { deployment: web.deployment, facilityId: web.facilityId, country: web.country.countryCode, webSearch: port.provider };
    progress(`WEB world (Anvil only, ${DEMO_COUNTRIES.SG.founderName}, recorded web search): final-1 ${web.deployment.deploymentId}, facility ${web.facilityId}`);
    const state: RunState = {
      web: { port, checks: control, fixture: loadRecordedFixture(), egress, rpcHost: new URL(infra.cfg.rpcUrls[0] as string).host, sessionId: uuidv7(), answered: [] },
    };
    for (const c of CATALOGUE.web) {
      const v = await runCase(web, b, state, c, progress);
      if (v) out.push(v);
    }
    return out;
  } finally {
    egress.restore();
  }
}
