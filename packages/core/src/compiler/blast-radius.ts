/**
 * Blast radius = the most a FULLY compromised agent (its key and its LLM) could move out of the treasury
 * with no human signature, if nobody intervened. Every term is an on-chain limit (§8.4), so it is a bound,
 * not an estimate:
 *
 *   per line (what the agent alone can reach):
 *     - no payee on the line                    → 0      (the agent cannot add payees: PayeeNotBound)
 *     - escrowOnly line                          → min(line, Σ autoRelease milestones of its scheduled payees)
 *                                                  (non-auto milestones need the founder's MilestoneRelease;
 *                                                   funded-but-locked escrow is not lost)
 *     - other lines                              → min(line, windowCap × windows, Σ payee lifetime caps if all capped)
 *                                                  windows = ⌊active / windowSeconds⌋ + 1, active = min(validUntil,
 *                                                  agentExpiry) − now (a rolling window admits windowCap per
 *                                                  windowSeconds, plus one more at the closed edge)
 *   total = min(stage-1 release, Σ lines)       (later stages need the lender's signature; the reserve is ReserveLocked)
 *
 * `perWindowMinor` is the same bound restricted to ONE rolling window (what can go before a weekly review).
 */
import type { LineKey } from "../schemas/enums";
import type { PlanManifest } from "../schemas/plan";
import type { Minor } from "../schemas/primitives";
import { maxBig, minBig, parseMinor, sumBig, toMinor } from "../money/index";
import { lifetimeCapOf, registryEntryFor } from "../constitution/check";
import type { RegistryPayee } from "../constitution/types";

export interface BlastRadiusLine {
  readonly lineKey: LineKey;
  readonly reachableMinor: Minor;
  readonly perWindowMinor: Minor;
}

export interface BlastRadius {
  readonly totalMinor: Minor;
  readonly perWindowMinor: Minor;
  readonly stageCapMinor: Minor;
  readonly lines: readonly BlastRadiusLine[];
}

function escrowReach(line: PlanManifest["lines"][number], registry: readonly RegistryPayee[]): bigint {
  const auto = line.payeeIds.map((id) => {
    const entry = registryEntryFor(registry, id, line.lineKey);
    const milestones = entry?.schedule ?? [];
    return sumBig(milestones.filter((m) => m.autoRelease).map((m) => parseMinor(m.amountMinor)));
  });
  return minBig(parseMinor(line.amountMinor), sumBig(auto));
}

function payeeCapTotal(line: PlanManifest["lines"][number], registry: readonly RegistryPayee[]): bigint | null {
  const caps = line.payeeIds.map((id) => {
    const entry = registryEntryFor(registry, id, line.lineKey);
    const cap = entry ? lifetimeCapOf(entry) : null;
    return typeof cap === "bigint" ? cap : null; // unreadable = unbounded: a worst-case figure is never understated
  });
  return caps.every((c): c is bigint => c !== null) ? sumBig(caps) : null;
}

function lineReach(line: PlanManifest["lines"][number], agentExpiry: bigint, now: bigint, registry: readonly RegistryPayee[]) {
  if (line.payeeIds.length === 0 || agentExpiry <= now) return { reach: 0n, perWindow: 0n };
  if (line.escrowOnly) {
    const reach = escrowReach(line, registry);
    return { reach, perWindow: reach };
  }
  const amount = parseMinor(line.amountMinor);
  const windowCap = parseMinor(line.windowCapMinor);
  const windowSeconds = parseMinor(line.windowSeconds);
  const active = maxBig(0n, minBig(parseMinor(line.validUntil), agentExpiry) - now);
  const windows = active === 0n ? 0n : active / windowSeconds + 1n;
  const caps = payeeCapTotal(line, registry);
  const limits = [amount, windowCap * windows, ...(caps === null ? [] : [caps])];
  return { reach: minBig(...limits), perWindow: minBig(amount, windowCap, ...(caps === null ? [] : [caps])) };
}

/** Blast radius of a manifest given the payee registry at `now` (see module doc for the exact definition). */
export function blastRadius(manifest: PlanManifest, registry: readonly RegistryPayee[], now: bigint): BlastRadius {
  const agentExpiry = parseMinor(manifest.agent.expiresAt);
  const stageCap = parseMinor(manifest.stages[0]?.releaseMinor ?? "0");
  const lines = manifest.lines.map((l) => ({ lineKey: l.lineKey, ...lineReach(l, agentExpiry, now, registry) }));
  return {
    totalMinor: toMinor(minBig(stageCap, sumBig(lines.map((l) => l.reach)))),
    perWindowMinor: toMinor(minBig(stageCap, sumBig(lines.map((l) => l.perWindow)))),
    stageCapMinor: toMinor(stageCap),
    lines: lines.map((l) => ({ lineKey: l.lineKey, reachableMinor: toMinor(l.reach), perWindowMinor: toMinor(l.perWindow) })),
  };
}
