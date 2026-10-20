/** Bundle rows are always the frozen EvidenceRow shape; not-run rows are honest; aliases keep the same hashes. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceRows } from "@hogee/core";
import { afterEach, describe, expect, it } from "vitest";
import type { Deployment } from "../src/api-internals";
import { Bundle, eventSummary, revertSummary, type TxFacts } from "../src/evidence";

const deployment = { chainId: 31337, deploymentId: "final-test", chainTag: "anvil", contracts: {} } as unknown as Deployment;
const hash = `0x${"a".repeat(64)}` as const;
const reverted: TxFacts = {
  txHash: hash,
  status: "reverted",
  block: 12,
  contract: "Treasury",
  function: "spend",
  from: "0x0000000000000000000000000000000000000001",
  events: [],
  revert: { name: "PayeeNotBound", args: [] },
  gasUsed: "40000",
};
const mined: TxFacts = { ...reverted, status: "success", revert: null, events: [{ name: "Denied", args: { n: 1n, lineId: `0x${"1".repeat(64)}` } }] };

let dir = "";
const bundle = (target: "anvil" | "sepolia" = "anvil") => {
  dir = mkdtempSync(join(tmpdir(), "rt-bundle-"));
  return new Bundle(dir, { chainId: 31337, target });
};
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("Bundle rows", () => {
  it("a mined revert is an onchain_revert row with its hash, block, call and decoded error", () => {
    const b = bundle();
    b.begin("T1", "t1");
    const row = b.row(deployment, { taskId: "T1", title: "forced", expected: "revert", expectedError: "PayeeNotBound", ok: true, facts: reverted, artifacts: ["receipts/x.json"] });
    expect(row).toMatchObject({ layer: "onchain_revert", outcome: "pass", txHash: hash, block: 12, contract: "Treasury", function: "spend", revertReason: "PayeeNotBound" });
    expect(row.explorerUrl).toBeUndefined();
  });

  it("a refusal row carries its trace and, when anchored, the recordDenied tx; Sepolia rows link the explorer", () => {
    const b = bundle("sepolia");
    b.begin("T4", "t4");
    const row = b.row(deployment, { taskId: "T4", title: "refused", expected: "refused", ok: true, layer: "agent_refusal", traceId: "trace-1", anchor: mined });
    expect(row).toMatchObject({ layer: "agent_refusal", traceId: "trace-1", txHash: hash, explorerUrl: `https://sepolia.etherscan.io/tx/${hash}` });
    expect(row.decodedEvent).toContain("Denied(");
  });

  it("refuses a row the frozen schema would reject (an agent_refusal without a trace)", () => {
    const b = bundle();
    b.begin("T2", "t2");
    expect(() => b.row(deployment, { taskId: "T2", title: "x", expected: "refused", ok: true, layer: "agent_refusal" })).toThrow();
  });

  it("a not-run row is offchain, fails, says why, and marks the case not_run", () => {
    const b = bundle();
    b.begin("T33", "t33");
    b.notRun(deployment, "T33", "research", "no research path yet");
    const rep = b.reports.get("T33");
    expect(rep).toMatchObject({ status: "not_run", reason: "no research path yet" });
    expect(b.rows[0]).toMatchObject({ layer: "offchain", outcome: "fail", title: "NOT RUN: research" });
    expect(JSON.parse(readFileSync(join(dir, "not-run/T33.json"), "utf8"))).toMatchObject({ reason: "no research path yet" });
  });

  it("a variant that cannot run keeps the case's own status (T15 on Sepolia)", () => {
    const b = bundle();
    b.begin("T15", "t15");
    b.row(deployment, { taskId: "T15", title: "revoked", expected: "revert", expectedError: "NotAgent", ok: true, facts: { ...reverted, revert: { name: "NotAgent", args: [] } } });
    b.begin("T15", "t15 expiry");
    b.notRun(deployment, "T15", "expiry", "Anvil only");
    expect(b.reports.get("T15")?.status).toBe("pass");
    expect(b.reports.get("T15")?.notes.join()).toContain("variant not run");
  });

  it("aliases copy rows with the same hash under the scripted task id", () => {
    const b = bundle();
    b.begin("T1", "t1");
    b.row(deployment, { taskId: "T1", title: "forced", expected: "revert", expectedError: "PayeeNotBound", ok: true, facts: reverted });
    b.alias("T1", "S6", "Bank changed");
    expect(b.rows.map((r) => [r.taskId, r.txHash])).toEqual([
      ["T1", hash],
      ["S6", hash],
    ]);
    expect(b.reports.get("S6")?.status).toBe("pass");
  });

  it("writes evidence.json as EvidenceRow[] and report.json", () => {
    const b = bundle();
    b.begin("T1", "t1");
    b.row(deployment, { taskId: "T1", title: "forced", expected: "revert", ok: false, facts: reverted });
    b.finish({ runId: "rt-test" });
    expect(EvidenceRows.parse(JSON.parse(readFileSync(join(dir, "evidence.json"), "utf8")))).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "report.json"), "utf8")).cases[0]).toMatchObject({ taskId: "T1", status: "fail" });
  });
});

describe("summaries", () => {
  it("formats events and reverts within the frozen field lengths", () => {
    expect(eventSummary(mined)).toMatch(/^Denied\(n=1, lineId=0x1+/);
    expect(revertSummary(reverted)).toBe("PayeeNotBound");
    expect(revertSummary({ ...reverted, revert: { name: "PlanInvariantViolated", args: [4] } })).toBe("PlanInvariantViolated(4)");
    expect(revertSummary({ ...reverted, revert: null })).toBe("UNDECODED_REVERT");
    const many = { ...mined, events: Array.from({ length: 20 }, () => mined.events[0] as TxFacts["events"][number]) };
    expect(eventSummary(many)?.length).toBeLessThanOrEqual(500);
  });
});
