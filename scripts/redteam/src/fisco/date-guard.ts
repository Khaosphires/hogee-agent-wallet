/**
 * Date guard (fail closed): the mirror commits final-2's manifest unchanged, so the replay is only meaningful while
 * every time in it is still ahead: the agent's expiry, each line's validUntil and each stage gate's deadline. The run
 * aborts unless all of them lie at least `marginSeconds` (default one hour, more than a replay takes) past now.
 */
import type { PlanManifest } from "@hogee/core";

export class DateGuardError extends Error {
  override readonly name = "DateGuardError";
}

export const DEFAULT_DATE_MARGIN_SECONDS = 3_600n;

export interface Expiry {
  readonly label: string;
  readonly at: bigint;
}

/** Every expiry the manifest carries, earliest first. */
export function expiriesOf(m: Pick<PlanManifest, "agent" | "lines" | "stages">): Expiry[] {
  const out: Expiry[] = [{ label: "agent.expiresAt", at: BigInt(m.agent.expiresAt) }];
  for (const l of m.lines) out.push({ label: `lines.${l.lineKey}.validUntil`, at: BigInt(l.validUntil) });
  for (const s of m.stages) if (s.gate) out.push({ label: `stages.${s.stageId}.gate.deadline`, at: BigInt(s.gate.deadline) });
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

const iso = (s: bigint): string => new Date(Number(s) * 1000).toISOString();

/** Throws unless every expiry is later than now + margin; returns the earliest (for the preflight snapshot). */
export function dateGuard(m: Pick<PlanManifest, "agent" | "lines" | "stages">, nowSeconds: bigint, marginSeconds = DEFAULT_DATE_MARGIN_SECONDS): Expiry {
  const all = expiriesOf(m);
  const limit = nowSeconds + marginSeconds;
  const passed = all.filter((e) => e.at <= limit);
  if (passed.length > 0) {
    throw new DateGuardError(`the final-2 plan has expired or expires within ${marginSeconds} s: ${passed.map((e) => `${e.label} ${iso(e.at)}`).join(", ")}`);
  }
  return all[0] as Expiry;
}

export const describeExpiry = (e: Expiry): string => `${e.label} ${iso(e.at)}`;
