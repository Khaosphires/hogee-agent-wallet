/** evidence.json rows come from facts only: scripted successes, attack reverts by their decoded error, anchored refusals. */
import { describe, expect, it } from "vitest";
import { type ContractsFile, type RawReceipt } from "@hogee/verify-evidence";
import { examplePayment } from "@hogee/core";
import type { z } from "zod";
import type { Collected } from "../src/evidence/collect";
import { evidenceRows } from "../src/evidence/rows";
import { contractsFile } from "../src/evidence/export";
import { explorerProblems } from "@hogee/verify-evidence";

const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const contracts = {
  format: "hogee.evidence/1", runId: "ev-1", facilityId: "fac-1", exportedAt: "2026-10-18T00:00:00.000Z", deploymentId: "final-1", chainId: 11155111, chainTag: "sepolia",
  explorer: "https://sepolia.etherscan.io", excludedEvalTraces: 0,
  contracts: { PlanRegistry: { address: `0x${"a".repeat(40)}`, verifiedUrl: "https://sepolia.etherscan.io/address/x", verified: true }, Treasury: { address: `0x${"b".repeat(40)}`, verifiedUrl: "https://sepolia.etherscan.io/address/y", verified: true } },
} as ContractsFile;
const receipt = (n: number, status: "0x1" | "0x0"): z.infer<typeof RawReceipt> =>
  ({ transactionHash: h(n), transactionIndex: "0x0", blockHash: h(1000 + n), blockNumber: `0x${(100 + n).toString(16)}`, from: `0x${"1".repeat(40)}`, to: `0x${"b".repeat(40)}`, status, logs: [], logsBloom: `0x${"0".repeat(512)}`, gasUsed: "0x1", cumulativeGasUsed: "0x1" }) as z.infer<typeof RawReceipt>;
const action = (id: string, kind: string, n: number, state: "FINALIZED" | "INCLUDED" | "REVERTED", revertReason: string | null = null) =>
  ({ actionId: id, kind, refId: null, state, txHash: h(n), block: 100 + n, revertReason, createdAt: "2026-10-18T00:00:00.000Z", signerAddress: null, nonce: null, rawSignedTx: null });
const empty: Collected = { payments: [], chainActions: [], signatures: [], plans: [], traces: [], llmCalls: [], rationales: [], denials: [], excludedEvalTraces: 0, omittedTraces: { traces: 0, events: 0 }, omittedSignatures: 0, omittedLlmCalls: 0 };

describe("evidenceRows", () => {
  it("maps scripted successes and attack reverts, with explorer links, and nothing else", () => {
    const c: Collected = {
      ...empty,
      chainActions: [
        action("a1", "Treasury.fund", 1, "FINALIZED"),
        action("a2", "PlanRegistry.commitPlan", 2, "REVERTED", "PlanInvariantViolated(9)"),
        action("a3", "Treasury.pause", 3, "FINALIZED"),
        action("a4", "Treasury.tighten", 4, "REVERTED", "SomethingElse"),
      ] as Collected["chainActions"],
      payments: [{ payment: { ...examplePayment, paymentId: "p1", state: "REVERTED", txHash: h(5), block: 105, revertReason: "PayeeNotBound" }, orderId: null, milestoneIdx: null, nonceConsumedBy: null, signerAddress: null, nonce: null, rawSignedTx: null }],
    };
    const receipts = new Map([1, 2, 3, 4, 5].map((n) => [h(n), receipt(n, n === 1 || n === 3 ? "0x1" : "0x0")]));
    const rows = evidenceRows({ contracts, receipts }, c);
    expect(rows.map((r) => [r.taskId, r.layer, r.outcome, r.expectedError ?? null])).toEqual([
      ["S1", "onchain_success", "pass", null],
      ["T21", "onchain_revert", "pass", "PlanInvariantViolated"],
      ["T1", "onchain_revert", "pass", "PayeeNotBound"],
    ]);
    expect(rows[0]?.explorerUrl).toBe(`https://sepolia.etherscan.io/tx/${h(1)}`);
    expect(rows[0]?.artifacts).toContain(`receipts/${h(1)}.json`);
  });

  it("a scripted success that reverted for a non-attack reason is that task's FAIL row (outcome from the task, not the receipt)", () => {
    const c: Collected = {
      ...empty,
      chainActions: [action("a1", "Treasury.fund", 1, "REVERTED", "OutOfGas"), action("a2", "Treasury.bindPayee", 2, "FINALIZED")] as Collected["chainActions"],
      payments: [
        { payment: { ...examplePayment, paymentId: "p1", kind: "FUND_MILESTONE", state: "REVERTED", txHash: h(3), block: 103, revertReason: "Weird" }, orderId: "order-a", milestoneIdx: 0, nonceConsumedBy: null, signerAddress: null, nonce: null, rawSignedTx: null },
      ] as Collected["payments"],
    };
    const receipts = new Map([[h(1), receipt(1, "0x0")], [h(2), receipt(2, "0x1")], [h(3), receipt(3, "0x0")]]);
    const rows = evidenceRows({ contracts, receipts }, c);
    expect(rows.map((r) => [r.taskId, r.expected, r.layer, r.outcome, r.revertReason ?? null])).toEqual([
      ["S1", "success", "onchain_revert", "fail", "OutOfGas"],
      ["S3", "success", "onchain_success", "pass", null],
      ["S4", "success", "onchain_revert", "fail", "Weird"],
    ]);
  });

  it("a web order's auto-released deposit (idx 0) is S4, labelled as the deposit; its balance funding and a catalog idx 1 keep their mapping", () => {
    const fund = (n: number, orderId: string, milestoneIdx: number, rationaleHash: string) =>
      ({ payment: { ...examplePayment, paymentId: `p${n}`, kind: "FUND_MILESTONE", state: "FINALIZED", txHash: h(n), block: 100 + n, rationaleHash }, orderId, milestoneIdx, nonceConsumedBy: null, signerAddress: null, nonce: null, rawSignedTx: null }) as Collected["payments"][number];
    const rationale = (n: number, autoRelease: boolean) => ({ status: "available" as const, rationaleHash: h(500 + n), decisionId: null, rationale: { kind: "MILESTONE_FUNDING", autoRelease }, salt: null });
    const c: Collected = {
      ...empty,
      payments: [fund(1, "order-wcorvanetest2-001", 0, h(501)), fund(2, "order-wcorvanetest2-001", 1, h(502)), fund(3, "order-a-001", 1, h(503)), fund(4, "order-wglintoratest-001", 0, h(504))],
      rationales: [rationale(1, true), rationale(2, false), rationale(3, true), rationale(4, false)],
    };
    const receipts = new Map([1, 2, 3, 4].map((n) => [h(n), receipt(n, "0x1")]));
    const rows = evidenceRows({ contracts, receipts }, c);
    expect(rows.map((r) => [r.taskId, r.txHash])).toEqual([
      ["S4", h(1)],
      ["S5", h(3)],
    ]);
    expect(rows[0]?.title).toMatch(/deposit by itself/);
    expect(rows[0]?.title).not.toMatch(/sample/i);
  });

  it("an anchored denial with its trace becomes an agent_refusal row", () => {
    const trace = { traceId: "tr-1", seq: 0, ts: "2026-10-18T00:00:00.000Z", actor: "policy", kind: "POLICY_VERDICT", summary: "x", verdict: "DENY", reasonCode: "CapExceeded", refs: {}, prevHash: h(0), hash: h(9) } as Collected["traces"][number];
    const c: Collected = { ...empty, traces: [trace], denials: [{ id: "d1", decisionId: "01a14495-5600-7000-8000-000000000001", reasonCode: "CapExceeded", traceId: "tr-1", recordedTx: h(7) }] };
    const [row] = evidenceRows({ contracts, receipts: new Map([[h(7), receipt(7, "0x1")]]) }, c);
    expect(row).toMatchObject({ taskId: "T4", layer: "agent_refusal", expected: "refused", function: "recordDenied", txHash: h(7), traceId: "tr-1" });
    expect(evidenceRows({ contracts, receipts: new Map() }, { ...c, traces: [] })).toEqual([]);
  });

  it("re-check M3: a reverted recordDenied never anchors a refusal; a landed one does, else the synced tx, else none", () => {
    const trace = { traceId: "tr-1", seq: 0, ts: "2026-10-18T00:00:00.000Z", actor: "policy", kind: "POLICY_VERDICT", summary: "x", verdict: "DENY", reasonCode: "CircuitOpen", refs: {}, prevHash: h(0), hash: h(9) } as Collected["traces"][number];
    const denial = { id: "d1", decisionId: "01a14495-5600-7000-8000-000000000001", reasonCode: "CircuitOpen", traceId: "tr-1", recordedTx: null };
    const recordDenied = (n: number, state: "FINALIZED" | "REVERTED" | "INCLUDED") => ({ ...action(`a${n}`, "Treasury.recordDenied", n, state, state === "REVERTED" ? "CircuitOpen" : null), refId: "d1" });
    const receipts = new Map([[h(3), receipt(3, "0x0")], [h(4), receipt(4, "0x1")], [h(7), receipt(7, "0x1")]]);
    const refusal = (c: Partial<Collected>) => evidenceRows({ contracts, receipts }, { ...empty, traces: [trace], ...c }).find((r) => r.layer === "agent_refusal");
    // The burst case: the extra recordDenied reverted CircuitOpen. No anchor (the T26 revert row still shows it).
    const reverted = refusal({ chainActions: [recordDenied(3, "REVERTED")] as Collected["chainActions"], denials: [denial] });
    expect(reverted).toMatchObject({ taskId: "T26", layer: "agent_refusal", contract: "", function: "" });
    expect(reverted?.txHash).toBeUndefined();
    // A retry that landed anchors it, ahead of the reverted attempt.
    expect(refusal({ chainActions: [recordDenied(3, "REVERTED"), recordDenied(4, "INCLUDED")] as Collected["chainActions"], denials: [denial] })?.txHash).toBe(h(4));
    // No landed action: the tx sync copied (only ever a landed one).
    expect(refusal({ chainActions: [recordDenied(3, "REVERTED")] as Collected["chainActions"], denials: [{ ...denial, recordedTx: h(7) }] })?.txHash).toBe(h(7));
  });
});

describe("contracts.json (run-6 re-check M5)", () => {
  const deployment = (chainId: number, verifiedUrl?: string) => {
    const c = (a: string) => ({ address: `0x${a.repeat(40)}`, ...(verifiedUrl ? { verifiedUrl } : {}) });
    return { deployment: { chainId, chainTag: chainId === 11155111 ? "sepolia" : "anvil", deploymentId: "final-1", contracts: { PlanRegistry: c("a"), Treasury: c("b"), MilestoneEscrow: c("c"), SalesOracle: c("d") } } } as unknown as Parameters<typeof contractsFile>[0];
  };
  const scope = { facilityId: "fac-1", founderId: "founder-1" };
  const manifestOf = (cf: ContractsFile) => ({ deployments: { [cf.deploymentId]: { chainId: cf.chainId, contracts: Object.fromEntries(Object.entries(cf.contracts).map(([k, v]) => [k, { address: v.address, verifiedUrl: v.verifiedUrl ?? `http://localhost/${cf.chainTag}/address/${v.address}` }])) } } });

  it("links only on the pinned explorer: a Sourcify verifiedUrl becomes the Etherscan code page; a local chain links nowhere", () => {
    const sepolia = contractsFile(deployment(11155111, "https://sourcify.dev/#/lookup/0xb"), scope, "ev-1", "2026-10-18T00:00:00.000Z", 0);
    expect(sepolia.explorer).toBe("https://sepolia.etherscan.io");
    expect(sepolia.contracts.Treasury).toEqual({ address: `0x${"b".repeat(40)}`, verifiedUrl: `https://sepolia.etherscan.io/address/0x${"b".repeat(40)}#code`, verified: true });
    // Run-7 re-check L2: even an Etherscan link the deployment names is replaced by the contract's own code page.
    const other = contractsFile(deployment(11155111, `https://sepolia.etherscan.io/address/0x${"e".repeat(40)}#code`), scope, "ev-1", "2026-10-18T00:00:00.000Z", 0);
    expect(other.contracts.Treasury.verifiedUrl).toBe(`https://sepolia.etherscan.io/address/0x${"b".repeat(40)}#code`);
    const rows = evidenceRows({ contracts: other, receipts: new Map([[h(1), receipt(1, "0x1")]]) }, { ...empty, chainActions: [action("a1", "Treasury.fund", 1, "FINALIZED")] as Collected["chainActions"] });
    expect(rows).toHaveLength(1);
    expect(explorerProblems({ contracts: other, manifest: manifestOf(other), rows } as unknown as Parameters<typeof explorerProblems>[0])).toEqual([]);
    const local = contractsFile(deployment(31337), scope, "ev-1", "2026-10-18T00:00:00.000Z", 0);
    expect(local.explorer).toBeNull();
    expect(local.contracts.Treasury.verifiedUrl).toBeNull();
    for (const cf of [sepolia, local]) expect(explorerProblems({ contracts: cf, manifest: manifestOf(cf), rows: [] } as unknown as Parameters<typeof explorerProblems>[0])).toEqual([]);
  });
});
