/** The FISCO mirror pack schemas and the step catalogue: shape, cross-references, and the final-2 rows they mirror. */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CALL_CONTRACT, hogeeCallsAbi } from "../../src/abi";
import { encodeAbiParameters, encodeFunctionData, toFunctionSelector, type Hex } from "viem";
import { CATALOGUE, catalogueEntry, expectedErrorsFor, FINAL_READS, GOV_STEP_IDS, reasonCodeOf, STEP_IDS } from "../../src/fisco/catalogue";
import { ChainFile, isPackPath, LedgerFile, NativeReceipt, packIdOf, PACK_FILES, ROLES, Step, StepsFile, TARGETS, TxFile } from "../../src/fisco/pack";
import { CONTRACT_AUTH_ABI, decodeSystemCall, isSystemName, outputOf, PROPOSAL_LOG, SPEND_SELECTOR, SYSTEM, SYSTEM_CALLS } from "../../src/fisco/system";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const BUNDLE = join(REPO, "evidence/ev-74756ea61a72ae7c");
const readJson = <T>(name: string): T => JSON.parse(readFileSync(join(BUNDLE, name), "utf8")) as T;

const step = {
  seq: 1,
  id: "S1",
  title: "Open the facility",
  contract: "Treasury",
  function: "openFacility",
  signerRole: "lender",
  auth: "none",
  amountMinor: "1000000",
  expected: "ok",
  probe: { ok: true },
  outcome: { kind: "mined", txHash: `0x${"ab".repeat(32)}` },
  reads: [],
  nonce: { before: 0, after: 1 },
  links: {},
};

describe("FISCO pack schemas", () => {
  it("accepts a step and refuses unknown keys, bad kinds and ms-free shapes strictly", () => {
    expect(Step.safeParse(step).success).toBe(true);
    expect(Step.safeParse({ ...step, extra: 1 }).success).toBe(false);
    expect(Step.safeParse({ ...step, outcome: { kind: "pending" } }).success).toBe(false);
    expect(Step.safeParse({ ...step, signerRole: "founder" }).success).toBe(false);
    expect(Step.safeParse({ ...step, amountMinor: "1.5" }).success).toBe(false);
    const snapshot = { block: 1, reads: [] };
    expect(StepsFile.safeParse({ format: "hogee.fisco-mirror/2", preflight: snapshot, steps: [step], final: snapshot }).success).toBe(true);
    expect(StepsFile.safeParse({ format: "hogee.evidence/1", preflight: snapshot, steps: [step], final: snapshot }).success).toBe(false);
  });

  it("keeps the served receipt loose but its core fields typed; logsBloom may be absent", () => {
    const h = `0x${"cd".repeat(32)}`;
    const receipt = { transactionHash: h, transactionIndex: "0x0", blockHash: h, blockNumber: "0x5", from: `0x${"11".repeat(20)}`, to: null, status: "0x1", logs: [], gasUsed: "0x1", served: "extra" };
    const native = { transactionHash: h, blockNumber: 5, status: 22, output: "0x", logEntries: [], gasUsed: "21000" };
    const tx = { hash: h, rawSignedTx: "0xf86c", rawSource: "sent", tx: { hash: h }, receipt, block: { number: "0x5", hash: h, parentHash: h, timestamp: "0x6a0", transactions: [h] }, native };
    expect(TxFile.safeParse(tx).success).toBe(true);
    expect(TxFile.safeParse({ ...tx, native: null }).success).toBe(true);
    const { native: _n, ...noNative } = tx;
    expect(TxFile.safeParse(noNative).success).toBe(false);
    expect(NativeReceipt.safeParse({ ...native, status: 256 }).success).toBe(false);
    expect(NativeReceipt.safeParse({ ...native, blockNumber: "0x5" }).success).toBe(false);
    expect(TxFile.safeParse({ ...tx, receipt: { ...receipt, status: "0x2" } }).success).toBe(false);
    expect(TxFile.safeParse({ ...tx, rawSource: "guessed" }).success).toBe(false);
  });

  it("allows exactly the listed paths", () => {
    for (const p of Object.values(PACK_FILES)) expect(isPackPath(p)).toBe(true);
    expect(isPackPath(`txs/0x${"ab".repeat(32)}.json`)).toBe(true);
    expect(isPackPath("code/TreasuryGovernance.hex")).toBe(true);
    expect(isPackPath("code-sepolia/SalesOracle.hex")).toBe(true);
    for (const bad of [`txs/0x${"AB".repeat(32)}.json`, "code/Other.hex", "notes.txt", "../pack.json", "code/meta.json.bak", "SUMMARY.md"]) expect(isPackPath(bad)).toBe(false);
  });

  it("derives a stable pack id from the pack.json core", () => {
    const core = { format: "hogee.fisco-mirror/2" as const, createdAt: "2026-10-20T00:00:00.000Z", gitCommit: "3420445", sourceBundle: { runId: "ev-74756ea61a72ae7c" as const, files: {} } };
    expect(packIdOf(core)).toMatch(/^fm-[0-9a-f]{16}$/);
    expect(packIdOf(core)).toBe(packIdOf({ ...core }));
    expect(packIdOf({ ...core, gitCommit: "3420446" })).not.toBe(packIdOf(core));
  });
});

describe("FISCO v2 schema: regulator, system targets, ledger", () => {
  const h = (b: string) => `0x${b.repeat(32)}`;
  const a = (b: string) => `0x${b.repeat(20)}` as Hex;

  it("adds the regulator role and the system targets", () => {
    expect(ROLES).toContain("regulator");
    expect(ROLES).toContain("observer");
    expect(TARGETS).toEqual(["PlanRegistry", "Treasury", "MilestoneEscrow", "SalesOracle", "AccountManager", "CommitteeManager", "ContractAuth"]);
    expect(Step.safeParse({ ...step, contract: "AccountManager", function: "setAccountStatus", signerRole: "regulator" }).success).toBe(true);
    expect(Step.safeParse({ ...step, contract: "Precompiled" }).success).toBe(false);
  });

  it("takes a probe-only step with its eth_call", () => {
    const probe = { ...step, id: "C1", outcome: { kind: "probe-only" }, call: { from: a("11"), to: a("22"), data: "0xabcdef01", block: 40 }, nonce: { before: 3, after: 3 } };
    expect(Step.safeParse(probe).success).toBe(true);
    expect(Step.safeParse({ ...probe, call: { ...probe.call, to: a("AB") } }).success).toBe(false);
    expect(Step.safeParse({ ...probe, call: { ...probe.call, extra: 1 } }).success).toBe(false);
  });

  it("requires the auth facts, the observer node and the head hash on chain.json", () => {
    const chain = {
      clientVersion: "FISCO-BCOS/3.17.1", chainId: 20_200, nodeCount: 5, sealerCount: 4, observerCount: 1, consensus: "pbft", genesis: { features: {} }, evm: { timestampUnit: "seconds", p256At0x100: false },
      txType: "legacy", gasPrice: "0x0", headAtStart: 5, headAtEnd: 50, headHashAtEnd: h("aa"), auth: { check: true, admin: a("88") },
      observerNode: { index: 4, proposalTx: h("bb"), proposalBlock: 1, weight: 0, nodeIdKeccak: h("cc") },
    };
    expect(ChainFile.safeParse(chain).success).toBe(true);
    expect(ChainFile.safeParse({ ...chain, auth: { check: false, admin: a("88") } }).success).toBe(false);
    expect(ChainFile.safeParse({ ...chain, observerNode: { ...chain.observerNode, nodeId: "abc" } }).success).toBe(false);
    expect(ChainFile.safeParse({ ...chain, observerNode: { ...chain.observerNode, weight: 1 } }).success).toBe(false);
    const { headHashAtEnd: _hh, ...noHead } = chain;
    expect(ChainFile.safeParse(noHead).success).toBe(false);
  });

  it("types ledger.json strictly", () => {
    const tx = { hash: h("01"), from: a("88"), to: SYSTEM.CommitteeManager, nonce: 0, inputKeccak: h("02"), receipt: { transactionIndex: 0, status: 1, gasUsed: "21000", logs: [{ address: SYSTEM.CommitteeManager, topics: [PROPOSAL_LOG.topic0], data: PROPOSAL_LOG.data }] } };
    const ledger = { node: "node4-observer", head: { number: 1, hash: h("12") }, blocks: [{ number: 0, hash: h("11"), parentHash: h("00"), timestamp: 1, txs: [] }, { number: 1, hash: h("12"), parentHash: h("11"), timestamp: 2, txs: [tx] }], node0Keccak: h("99") };
    expect(LedgerFile.safeParse(ledger).success).toBe(true);
    expect(LedgerFile.safeParse({ ...ledger, node: "node0" }).success).toBe(false);
    expect(LedgerFile.safeParse({ ...ledger, blocks: [{ ...ledger.blocks[0], number: "0x0" }] }).success).toBe(false);
    expect(LedgerFile.safeParse({ ...ledger, blocks: [{ ...ledger.blocks[1], txs: [{ ...tx, receipt: { ...tx.receipt, status: 2 } }] }] }).success).toBe(false);
    expect(LedgerFile.safeParse({ ...ledger, blocks: [{ ...ledger.blocks[1], txs: [{ ...tx, input: "0x" }] }] }).success).toBe(false);
    expect(isPackPath("ledger.json")).toBe(true);
  });

  it("decodes only allow-listed system calls and reads one-word returns", () => {
    const agent = a("44");
    const close = encodeFunctionData({ abi: CONTRACT_AUTH_ABI, functionName: "closeMethodAuth", args: [a("55"), SPEND_SELECTOR, agent] });
    expect(decodeSystemCall("ContractAuth", close)).toMatchObject({ name: "closeMethodAuth" });
    expect(decodeSystemCall("AccountManager", close)).toBeNull();
    const view = encodeFunctionData({ abi: CONTRACT_AUTH_ABI, functionName: "checkMethodAuth", args: [a("55"), SPEND_SELECTOR, agent] });
    expect(decodeSystemCall("ContractAuth", view)).toBeNull();
    expect(SPEND_SELECTOR).toBe(toFunctionSelector("function spend(bytes32 lineId, bytes32 payeeId, uint128 amountMinor, bytes32 invoiceHash, uint32 planVersion, bytes32 decisionId, bytes32 rationaleHash)"));
    expect(outputOf(`0x${"0".repeat(64)}`)).toBe(0n);
    expect(outputOf(`0x${"0".repeat(63)}1`)).toBe(1n);
    expect(outputOf(encodeAbiParameters([{ type: "int32" }], [-51_900]))).toBe(-51_900n);
    expect(outputOf("0x")).toBeNull();
    expect(outputOf(`0x08c379a0${"0".repeat(64)}`)).toBeNull();
  });
});

describe("the step catalogue", () => {
  it("has unique ids that fit the steps.json schema", () => {
    expect(new Set(STEP_IDS).size).toBe(STEP_IDS.length);
    for (const id of STEP_IDS) expect(Step.shape.id.safeParse(id).success, id).toBe(true);
    expect(catalogueEntry("S1")?.function).toBe("openFacility");
    expect(catalogueEntry("X99")).toBeNull();
  });

  // v2: a step may also call an allow-listed FISCO system contract (was: Hogee calls only).
  it("names only Hogee calls of the right contract, or allow-listed system calls", () => {
    const names = new Set(hogeeCallsAbi.filter((x) => x.type === "function").map((x) => x.name));
    for (const e of CATALOGUE) {
      if (isSystemName(e.contract)) {
        expect(SYSTEM_CALLS[e.contract], e.id).toContain(e.function);
        expect(e.signerRole, e.id).toBe("regulator");
        expect(e.governance, e.id).toBeDefined();
        continue;
      }
      expect(names.has(e.function as never), e.id).toBe(true);
      expect(CALL_CONTRACT[e.function], e.id).toBe(e.contract);
      expect(e.governance, e.id).toBeUndefined();
    }
  });

  it("is the 37-step v2 run: G0 first, the regulator's stops between S15 and S16, getAccountStatus only on V steps", () => {
    expect(STEP_IDS).toHaveLength(37);
    expect(STEP_IDS[0]).toBe("G0");
    const s15 = STEP_IDS.indexOf("S15");
    expect(STEP_IDS.slice(s15 + 1, s15 + 15)).toEqual(["G1", "V1", "F1", "G2", "V2", "C1", "G3", "G4", "G5", "M1", "C2", "G6", "C3", "S16"]);
    expect(GOV_STEP_IDS).toEqual(["G0", "G1", "V1", "G2", "V2", "G3", "G4", "G5", "G6"]);
    for (const e of CATALOGUE) if (e.function === "getAccountStatus") expect(e.id, e.id).toMatch(/^V[0-9]$/);
    for (const id of ["F1", "M1", "C1", "C3"]) expect(catalogueEntry(id), id).toMatchObject({ contract: "Treasury", function: "spend", signerRole: "agent", amountMinor: "10000", line: "PLATFORM_FEES", payee: "shopee-sg-fees", sameCalldataAs: "R17" });
    for (const e of CATALOGUE) {
      if (e.probeOnly) expect(e.expected, e.id).toBe("ok");
      if (/^[GVFMC][0-9]$/.test(e.id)) expect(e.sepolia, e.id).toBeUndefined();
    }
    expect(catalogueEntry("F1")).toMatchObject({ expectedError: "AccountFrozen", rule: "account-frozen" });
    expect(catalogueEntry("M1")).toMatchObject({ expectedError: "PermissionDenied", rule: "method-banned" });
    expect(catalogueEntry("C2")).toMatchObject({ function: "recordDenied", probeOnly: true });
    expect(catalogueEntry("C2")?.recordsDenialOf).toBeUndefined();
    expect(FINAL_READS).toMatchObject({ agentAccountStatus: "0", spendAllowedForAgent: "true" });
    expect(expectedErrorsFor(catalogueEntry("F1") as never, null, null)).toEqual([]);
  });

  it("gives every refusal a rule and an error, and links every denial to an earlier refusal", () => {
    const seen = new Set<string>();
    for (const e of CATALOGUE) {
      if (e.expected === "refused") expect(e.rule && e.expectedError, e.id).toBeTruthy();
      else expect(e.rule ?? e.expectedError, e.id).toBeUndefined();
      if (e.recordsDenialOf) {
        expect(e.function).toBe("recordDenied");
        expect(seen.has(e.recordsDenialOf), e.id).toBe(true);
        expect(catalogueEntry(e.recordsDenialOf)?.expected).toBe("refused");
      }
      seen.add(e.id);
    }
    expect(reasonCodeOf("CapExceeded")).toBe(`0x${Buffer.from("CapExceeded").toString("hex").padEnd(64, "0")}`);
  });

  it("keeps fewer than 3 denials per line (the circuit breaker)", () => {
    const perLine = new Map<string, number>();
    for (const e of CATALOGUE.filter((x) => x.function === "recordDenied")) perLine.set(String(e.line), (perLine.get(String(e.line)) ?? 0) + 1);
    for (const n of perLine.values()) expect(n).toBeLessThan(3);
  });

  it("derives T28's error from the time and the signed expiry", () => {
    const t28a = catalogueEntry("T28a");
    if (!t28a) throw new Error("T28a missing");
    expect(expectedErrorsFor(t28a, { from: 100n, to: 100n }, 99n)).toEqual(["SignatureExpired"]);
    expect(expectedErrorsFor(t28a, { from: 90n, to: 90n }, 99n)).toEqual(["InvalidSignature"]);
    expect(expectedErrorsFor(t28a, { from: 90n, to: 120n }, 99n)).toEqual(["SignatureExpired", "InvalidSignature"]);
    expect(expectedErrorsFor(catalogueEntry("R7") as never, { from: 1n, to: 1n }, 0n)).toEqual(["CapExceeded"]);
  });

  it("mirrors rows that exist in the final-2 bundle", () => {
    const actions = readJson<{ kind: string; txHash: string | null }[]>("chain-actions.json");
    const payments = readJson<{ payment: { kind: string; txHash?: string }; milestoneIdx: number | null }[]>("payments.json");
    for (const e of CATALOGUE) {
      const m = e.sepolia;
      if (!m) continue;
      const rows = m.source === "action" ? actions.filter((a) => a.kind === m.kind).map((a) => a.txHash) : payments.filter((p) => p.payment.kind === m.kind && p.milestoneIdx === m.milestoneIdx).map((p) => p.payment.txHash);
      expect(rows[m.nth ?? 0], e.id).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
});
