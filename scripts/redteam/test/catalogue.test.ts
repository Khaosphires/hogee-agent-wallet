/** The catalogue covers every frozen evidence task id exactly as the README table says. */
import { EVIDENCE_TASK_IDS } from "@hogee/core";
import { describe, expect, it } from "vitest";
import { CATALOGUE, coverage } from "../src/cases/catalogue";

const ids = (list: readonly { id: string; aliases?: readonly { id: string }[] }[]) => list.flatMap((c) => [c.id, ...(c.aliases ?? []).map((a) => a.id)]);

describe("case catalogue", () => {
  it("covers every EvidenceTaskId (S1-S12, T1-T33, D-poison, D-plug)", () => {
    const covered = new Set([...ids(CATALOGUE.main), ...ids(CATALOGUE.extras), ...ids(CATALOGUE.sg), ...ids(CATALOGUE.web)]);
    expect(EVIDENCE_TASK_IDS.filter((id) => !covered.has(id))).toEqual([]);
  });

  it("runs a case id twice only where it is meant to (step 0 filed under S2; T15's AgentExpired variant)", () => {
    const main = CATALOGUE.main.map((c) => c.id);
    const dupes = main.filter((id, i) => main.indexOf(id) !== i);
    expect(dupes).toEqual(["S2"]);
    expect(CATALOGUE.extras.map((c) => c.id)).toEqual(["T22", "T15"]);
    expect(CATALOGUE.extras.every((c) => c.anvilOnly)).toBe(true);
  });

  it("aliases are scripted tasks or attacks, never a case that also runs on its own", () => {
    const own = new Set([...CATALOGUE.main, ...CATALOGUE.extras].map((c) => c.id));
    const aliases = [...CATALOGUE.main, ...CATALOGUE.extras].flatMap((c) => (c.aliases ?? []).map((a) => a.id));
    expect(aliases.filter((a) => own.has(a))).toEqual([]);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("puts the treasury-changing cases last and Poison the planner before the first commit", () => {
    const main = CATALOGUE.main.map((c) => c.id);
    expect(main.indexOf("D-poison")).toBeLessThan(main.lastIndexOf("S2"));
    expect(main.slice(-6)).toEqual(["D-plug", "T29", "T20", "S12", "T10", "T15"]);
  });

  it("runs the Singapore variants of T1 and T4 in their own Anvil-only world, without aliases", () => {
    expect(CATALOGUE.sg.map((c) => [c.id, c.variant])).toEqual([
      ["T1", "SG"],
      ["T4", "SG"],
    ]);
    expect(CATALOGUE.sg.every((c) => c.anvilOnly && !c.aliases)).toBe(true);
    expect([...CATALOGUE.main, ...CATALOGUE.extras].some((c) => c.variant)).toBe(false);
    expect(coverage().filter((c) => c.variant === "SG").map((c) => c.id)).toEqual(["T1", "T4"]);
  });

  it("runs the WEB variants on frozen ids, Anvil-only, without aliases, in journey order", () => {
    const web = CATALOGUE.web;
    expect(web.every((c) => c.variant === "WEB" && c.anvilOnly && !c.aliases)).toBe(true);
    const order = web.map((c) => c.id);
    expect(order.slice(0, 3)).toEqual(["S2", "S1", "S3"]);
    // the limit attacks run before the order holds the pocket; T3 right after the bind (payee cooling)
    expect(order.indexOf("T18")).toBeLessThan(order.lastIndexOf("S3"));
    expect(order[order.lastIndexOf("S3") + 1]).toBe("T3");
    // the searches that fail or supersede come after the order; the time travel of S12 is last
    expect(order.indexOf("T26")).toBeGreaterThan(order.indexOf("T27"));
    expect(order.at(-1)).toBe("S12");
    expect([...new Set(order)].sort()).toEqual(["S1", "S11", "S12", "S2", "S3", "S4", "S5", "T1", "T11", "T16", "T18", "T2", "T25", "T26", "T27", "T3", "T30", "T33", "T7"]);
    expect(coverage().filter((c) => c.variant === "WEB").length).toBe(web.length);
  });

  it("describes the layers of every row in the coverage table", () => {
    for (const c of coverage()) expect(c.layers.length, c.id).toBeGreaterThan(10);
  });
});
