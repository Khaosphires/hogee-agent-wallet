import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dateGuard, DateGuardError, expiriesOf } from "../../src/fisco/date-guard";
import { readSepoliaBundle } from "../../src/fisco/source";

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), "../../../../evidence/ev-74756ea61a72ae7c");
const { manifest } = readSepoliaBundle(BUNDLE);
// final-2: stage-2 deadline 1793681976 (2026-11-03T00:59:36Z) is the earliest; lines 1794977976; agent 1796169599.
const STAGE2 = 1_793_681_976n;

describe("dateGuard", () => {
  it("lists every expiry of the final-2 plan, earliest first", () => {
    const all = expiriesOf(manifest);
    expect(all[0]).toEqual({ label: "stages.stage-2.gate.deadline", at: STAGE2 });
    expect(all.at(-1)).toEqual({ label: "agent.expiresAt", at: 1_796_169_599n });
    expect(all).toHaveLength(1 + manifest.lines.length + 1);
  });

  it("passes on 20 Oct 2026 and returns the earliest expiry", () => {
    expect(dateGuard(manifest, 1_792_436_000n).at).toBe(STAGE2);
  });

  it("aborts once the stage-2 deadline has passed", () => {
    expect(() => dateGuard(manifest, STAGE2 + 1n)).toThrow(DateGuardError);
  });

  it("aborts inside the safety margin", () => {
    expect(() => dateGuard(manifest, STAGE2 - 600n)).toThrow(/stages\.stage-2\.gate\.deadline/);
    expect(() => dateGuard(manifest, STAGE2 - 600n, 300n)).not.toThrow();
  });

  it("aborts when the agent expiry has passed even if a line has not", () => {
    const m = { ...manifest, agent: { ...manifest.agent, expiresAt: "1792000000" } };
    expect(() => dateGuard(m, 1_792_436_000n)).toThrow(/agent\.expiresAt/);
  });
});
