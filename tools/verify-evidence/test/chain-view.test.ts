/**
 * The chain view no longer follows the rows' labels (run-6 row-labelled-chain-view): every row that names a tx must
 * show it mined, a CANCELLED row must prove the (signer, nonce) consumer, a mined tx must be labelled mined, and every
 * payment kind binds to its calldata and event. Each tamper rewrites hashes.json too.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { receiptPath, verifyBundle, type VerifyResult } from "../src/index";
import { buildFixture, editJson, rehash, type Fixture } from "./fixture";

const failed = (r: VerifyResult): string[] => r.checks.filter((c) => !c.ok).map((c) => c.name);
const detail = (r: VerifyResult, name: string): string => r.checks.find((c) => c.name === name)?.detail ?? "";
const without = (files: Record<string, string>, path: string): Record<string, string> => Object.fromEntries(Object.entries(files).filter(([k]) => k !== path));

function expectFails(files: Record<string, string>, check: string, why: RegExp): void {
  const r = verifyBundle(rehash(files));
  expect(r.ok).toBe(false);
  expect(failed(r)).toContain(check);
  expect(detail(r, check)).toMatch(why);
}

const bind = { orderId: "order-a-001", payee: "sup-a", after: 10, coolingSeconds: 120, schedule: [5_000n, 15_000n] } as const;
let fx: Fixture;
let rich: Fixture;
beforeAll(async () => {
  fx = await buildFixture();
  rich = await buildFixture({
    bind,
    milestones: [{ idx: 0, amount: 5_000n, after: 500 }],
    releases: [{ idx: 0, after: 600 }],
    cancelled: [{ line: "LOGISTICS", amount: 1_000n, ref: 9, after: 700 }],
    ownerSpends: [{ line: "LOGISTICS", amount: 2_000n, ref: 10, after: 800 }],
    reserveWithdrawal: { after: 900, payee: "lhdn-tax", amount: 500n },
    denial: { after: 1_000, line: "LOGISTICS" },
  });
});

describe("chain view: a bundle with every row kind", () => {
  it("passes (CANCELLED proven, owner spend, release, reserve withdrawal, anchored refusal)", () => {
    const r = verifyBundle(rich.files);
    expect(failed(r)).toEqual([]);
    expect(detail(r, "transactions")).toMatch(/1 CANCELLED row\(s\) proven by a mined tx with the same signer and nonce/);
  });
});

describe("chain view: a relabelled mined row", () => {
  for (const [state, check, why] of [
    ["CANCELLED", "transactions", /CANCELLED without the signed tx that consumed its nonce/],
    ["DROPPED", "receipts", /pay-2 is DROPPED and names tx .* its receipt is not in the bundle/],
    ["BROADCAST", "receipts", /pay-2 is BROADCAST and names tx .* its receipt is not in the bundle/],
  ] as const) {
    it(`a mined spend relabelled ${state}, its receipt dropped, fails`, () => {
      const files = editJson(without(fx.files, receiptPath(fx.spendTxs[1] as string)), "payments.json", (p) => {
        p[1].payment.state = state;
        delete p[1].payment.block;
      });
      expectFails(files, check, why);
    });
  }

  it("a mined spend relabelled DROPPED with its receipt kept fails (a mined tx must be labelled mined)", () => {
    const files = editJson(fx.files, "payments.json", (p) => {
      p[1].payment.state = "DROPPED";
    });
    expectFails(files, "receipts", /DROPPED but its tx was mined/);
  });

  it("a chain action relabelled BROADCAST, its receipt dropped, fails", () => {
    const actions = JSON.parse(fx.files["chain-actions.json"] as string) as { actionId: string; txHash: string }[];
    const open = actions.find((a) => a.actionId === "act-open")?.txHash as string;
    const files = editJson(without(fx.files, receiptPath(open)), "chain-actions.json", (a) => {
      const row = a.find((x: { actionId: string }) => x.actionId === "act-open");
      row.state = "BROADCAST";
      row.block = null;
    });
    expectFails(files, "receipts", /act-open is BROADCAST and names tx .* its receipt is not in the bundle/);
  });

  it("a row whose raw bytes no longer hash to its tx fails even without a receipt", () => {
    const files = editJson(without(fx.files, receiptPath(fx.spendTxs[1] as string)), "payments.json", (p) => {
      p[1].payment.state = "BROADCAST";
      delete p[1].payment.block;
      p[1].rawSignedTx = p[0].rawSignedTx;
    });
    expectFails(files, "transactions", /keccak256\(raw tx\)/);
  });
});

describe("chain view: CANCELLED needs a mined tx with the row's signer and nonce", () => {
  const cancelledIdx = (f: Fixture) => (JSON.parse(f.files["payments.json"] as string) as { payment: { state: string } }[]).findIndex((p) => p.payment.state === "CANCELLED");

  it("a consumer with another nonce fails", () => {
    const files = editJson(rich.files, "payments.json", (p) => {
      const other = p.find((x: { payment: { kind: string; state: string } }) => x.payment.kind === "SPEND" && x.payment.state === "FINALIZED");
      p[cancelledIdx(rich)].nonceConsumedBy = { txHash: other.payment.txHash, rawSignedTx: other.rawSignedTx };
    });
    expectFails(files, "transactions", /its nonce consumer has nonce/);
  });

  it("a consumer whose receipt is missing fails", () => {
    expectFails(without(rich.files, receiptPath(rich.txs["consumer-1"] as string)), "receipts", /consumed a CANCELLED row's nonce has no receipt/);
  });

  it("a CANCELLED row without its consumer fails", () => {
    const files = editJson(without(rich.files, receiptPath(rich.txs["consumer-1"] as string)), "payments.json", (p) => {
      p[cancelledIdx(rich)].nonceConsumedBy = null;
    });
    expectFails(files, "transactions", /CANCELLED without the signed tx that consumed its nonce/);
  });
});

describe("chain view: non-agent payment kinds bind to their calldata and events", () => {
  const edit = (f: Fixture, kind: string, change: (row: Record<string, any>) => void) =>
    editJson(f.files, "payments.json", (p) => change(p.find((x: { payment: { kind: string } }) => x.payment.kind === kind)));

  it("a spend relabelled OWNER_SPEND with another amount fails", () => {
    const files = editJson(fx.files, "payments.json", (p) => {
      Object.assign(p[1].payment, { kind: "OWNER_SPEND", decisionId: null, rationaleHash: null, amountMinor: "1" });
    });
    expectFails(files, "transactions", /an OWNER_SPEND row whose tx calls spend/);
    expect(detail(verifyBundle(rehash(files)), "receipts")).toMatch(/emits 0 OwnerSpent events/);
  });

  it("an OWNER_SPEND row with another amount fails", () => {
    expectFails(edit(rich, "OWNER_SPEND", (r) => (r.payment.amountMinor = "1999")), "transactions", /ownerSpend calldata differs/);
  });

  it("a RELEASE_MILESTONE row with another payee fails", () => {
    expectFails(edit(rich, "RELEASE_MILESTONE", (r) => (r.payment.payeeId = "sup-b")), "receipts", /MilestoneReleased event differs/);
  });

  it("a WITHDRAW_RESERVE row with another amount fails", () => {
    expectFails(edit(rich, "WITHDRAW_RESERVE", (r) => (r.payment.amountMinor = "501")), "receipts", /ReserveWithdrawn event differs/);
  });
});

describe("chain view: an anchored refusal names its recordDenied tx", () => {
  it("a refusal row that drops its anchor fails", () => {
    const files = editJson(rich.files, "evidence.json", (rows) => {
      const row = rows.find((x: { function: string }) => x.function === "recordDenied");
      delete row.txHash;
      delete row.block;
      row.artifacts = ["traces.json", "rationales.json"];
    });
    expectFails(files, "evidence rows", /anchored by recordDenied/);
  });

  it("a refusal row anchored by another tx fails", () => {
    const files = editJson(rich.files, "evidence.json", (rows) => {
      const row = rows.find((x: { function: string }) => x.function === "recordDenied");
      row.txHash = rich.commitTx;
      row.artifacts = ["traces.json", "rationales.json", receiptPath(rich.commitTx)];
    });
    expectFails(files, "evidence rows", /not a recordDenied call/);
  });
});

describe("chain view: a refusal whose recordDenied reverted (run-6 re-check M3)", () => {
  let burst: Fixture;
  beforeAll(async () => {
    burst = await buildFixture({ denial: { after: 1_000, line: "LOGISTICS", reverted: true } });
  });

  it("verifies with no anchor on the refusal row (the T26 revert row shows the tx), as the exporter now writes it", () => {
    const r = verifyBundle(burst.files);
    expect(failed(r)).toEqual([]);
  });

  it("the old exporter's row, anchored to the reverted recordDenied, fails", () => {
    const tx = burst.txs["act-denied"] as string;
    const files = editJson(burst.files, "evidence.json", (rows) => {
      const row = rows.find((x: { layer: string; taskId: string }) => x.layer === "agent_refusal" && x.taskId === "T26");
      Object.assign(row, { txHash: tx, contract: "Treasury", function: "recordDenied", artifacts: [...row.artifacts, receiptPath(tx)] });
    });
    expectFails(files, "evidence rows", /has no successful receipt/);
  });
});
