import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getFx, screenSanctions, validateUSCC } from "../src/index";
import { fakeFetch, fixture, noSleep, respond, REPO } from "./helpers";

// The three task 3.11 cases from G0 (formerly it.todo), end to end on the public API. Detailed cases live in
// registry.test.ts, sanctions.test.ts, fx.test.ts and gleif.test.ts.
describe("checks (task 3.11)", () => {
  it("validateUSCC accepts a valid 18-character code and rejects a bad checksum", () => {
    expect(validateUSCC("91350100M000100Y43")).toEqual({ valid: true });
    expect(validateUSCC("91350100M000100Y44")).toEqual({ valid: false, reason: "check character does not match" });
    // Demo supplier G's code is wrong on purpose (data/suppliers on wip/suppliers).
    expect(validateUSCC("91445200QAN055YL7B").valid).toBe(false);
  });

  it("screenSanctions matches aliases case-insensitively from data/sanctions/un_sc.csv", async () => {
    const csvPath = join(REPO, "data", "sanctions", "un_sc.csv");
    await expect(screenSanctions("nam chon gang corporation", { csvPath })).resolves.toEqual({ hit: true, list: "UN_SC", matchedName: "NAM CHON GANG CORPORATION" });
    // Names the demo and eval supplier data rely on (UN SC KPe.001, KPe.004, KPe.006, KPe.008).
    for (const name of [
      "KOREA MINING DEVELOPMENT TRADING CORPORATION",
      "NAMCHONGANG TRADING CORPORATION",
      "KOREA HYOKSIN TRADING CORPORATION",
      "KOREAN TANGUN TRADING CORPORATION",
    ]) {
      await expect(screenSanctions(name, { csvPath })).resolves.toEqual({ hit: true, list: "UN_SC", matchedName: name });
    }
  });

  it("getFx returns a Sourced value whose snippetHash is the sha256 of the BNM response body", async () => {
    const body = fixture("bnm/CNY-2026-10-15.json");
    const { fetch } = fakeFetch(() => respond(body));
    const fx = await getFx("CNY/MYR", "2026-10-15", { fetch, sleep: noSleep });
    expect(fx.snippetHash).toBe(`0x${createHash("sha256").update(body).digest("hex")}`);
    expect(fx).toMatchObject({ value: 0.6099, evidence: "tier1", sourceType: "live" });
  });
});
