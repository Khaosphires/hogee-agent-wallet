/**
 * verifyBundle on a valid synthetic bundle (built with independent code, test/fixture.ts) and on tampered copies: one
 * changed byte in a receipt, a digest, a planHash, a signature or a rationale preimage, a reordered or duplicated
 * event. Each tamper is checked twice: as is (the file-hash index catches it) and with hashes.json rewritten by the
 * attacker (the semantic check must still catch it).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { receiptPath, verifyBundle, type VerifyResult } from "../src/index";
import { buildFixture, editJson, rehash, type Fixture } from "./fixture";

let fx: Fixture;
beforeAll(async () => {
  fx = await buildFixture();
});

const failed = (r: VerifyResult): string[] => r.checks.filter((c) => !c.ok).map((c) => c.name);
const detail = (r: VerifyResult, name: string): string => r.checks.find((c) => c.name === name)?.detail ?? "";

/** The tamper fails `check` with hashes.json left alone (and "file hashes" fails), and again after a rehash. */
function expectCaught(files: Record<string, string>, check: string, why?: RegExp): void {
  const raw = verifyBundle(files);
  expect(raw.ok).toBe(false);
  expect(failed(raw)).toContain("file hashes");
  const rehashed = verifyBundle(rehash(files));
  expect(rehashed.ok).toBe(false);
  expect(failed(rehashed)).toContain(check);
  expect(failed(rehashed)).not.toContain("file hashes");
  if (why) expect(detail(rehashed, check)).toMatch(why);
}

describe("verifyBundle: a valid bundle", () => {
  it("passes every check", () => {
    const r = verifyBundle(fx.files);
    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual([
      "bundle files",
      "file hashes",
      "transactions",
      "receipts",
      "plan hashes",
      "country pack",
      "plan approvals",
      "event sources (calldata ↔ events)",
      "EIP-712 digests",
      "founder signatures (ECDSA, P-256)",
      "event replay (caps, payees, duplicates)",
      "rationale commitments",
      "trace hash chains",
      "LLM call log (hashed)",
      "evidence rows",
      "SUMMARY.md (regenerated)",
    ]);
    expect(detail(r, "founder signatures (ECDSA, P-256)")).toMatch(/1 P-256 passkey and 1 ECDSA/);
  });

  it("accepts text (explorer) and bytes (CLI) alike", () => {
    const bytes = Object.fromEntries(Object.entries(fx.files).map(([k, v]) => [k, new TextEncoder().encode(v)]));
    expect(verifyBundle(bytes).ok).toBe(true);
  });

  it("check names are unique (the explorer keys its list by name)", () => {
    const names = verifyBundle(fx.files).checks.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("verifyBundle: structure", () => {
  it("fails a bundle with a missing or extra file", () => {
    const { "plans.json": _gone, ...rest } = fx.files;
    expect(failed(verifyBundle(rehash(rest)))).toContain("bundle files");
    expect(failed(verifyBundle(rehash({ ...fx.files, "notes.txt": "hi" })))).toContain("bundle files");
  });

  it("fails an empty bundle and never reports it verified", () => {
    const r = verifyBundle({});
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain("cryptographic verification");
  });

  it("fails a file that is not listed in, or not equal to, hashes.json", () => {
    const r = verifyBundle({ ...fx.files, "SUMMARY.md": "# edited\n" });
    expect(detail(r, "file hashes")).toMatch(/SUMMARY.md does not match/);
  });
});

describe("verifyBundle: tampered bundles", () => {
  it("one byte changed in a receipt's Spent log", () => {
    const path = receiptPath(fx.spendTxs[0] as string);
    const files = editJson(fx.files, path, (r) => {
      const d: string = r.logs[0].data;
      r.logs[0].data = `${d.slice(0, 65)}${d[65] === "f" ? "e" : "f"}${d.slice(66)}`; // first byte of amountMinor's word
    });
    expectCaught(files, "event replay (caps, payees, duplicates)");
  });

  it("one byte changed in a receipt's status", () => {
    const files = editJson(fx.files, receiptPath(fx.spendTxs[0] as string), (r) => {
      r.status = "0x0";
    });
    expectCaught(files, "receipts", /receipt reverted/);
  });

  it("one byte changed in a log topic (caught by the logs bloom)", () => {
    const files = editJson(fx.files, receiptPath(fx.spendTxs[1] as string), (r) => {
      const t: string = r.logs[0].topics[3];
      r.logs[0].topics[3] = `${t.slice(0, -1)}${t.endsWith("0") ? "1" : "0"}`;
    });
    expectCaught(files, "receipts", /logsBloom/);
  });

  it("one byte changed in a stored digest", () => {
    const files = editJson(fx.files, "signatures.json", (s) => {
      const d: string = s[0].digest;
      s[0].digest = `${d.slice(0, -1)}${d.endsWith("0") ? "1" : "0"}`;
    });
    expectCaught(files, "EIP-712 digests", /stored digest/);
  });

  it("one byte changed in a signed message field (the digest no longer matches)", () => {
    const files = editJson(fx.files, "signatures.json", (s) => {
      s[0].typedData.message.totalMinor = "1000001";
    });
    expectCaught(files, "EIP-712 digests");
  });

  it("one byte changed in a planHash", () => {
    const files = editJson(fx.files, "plans.json", (p) => {
      const h: string = p[0].planHash;
      p[0].planHash = `${h.slice(0, -1)}${h.endsWith("0") ? "1" : "0"}`;
    });
    expectCaught(files, "plan hashes", /planHash is not keccak256/);
  });

  it("one byte changed in the manifest (plan B shown, plan A signed: T27)", () => {
    const files = editJson(fx.files, "plans.json", (p) => {
      p[0].manifest.lines[3].perTxCapMinor = "30001";
    });
    expectCaught(files, "plan hashes");
    expect(failed(verifyBundle(rehash(files)))).toContain("plan approvals");
  });

  it("one byte changed in the passkey signature (P-256)", () => {
    const files = editJson(fx.files, "signatures.json", (s) => {
      const r: string = s[0].submission.passkey.r;
      s[0].submission.passkey.r = `${r.slice(0, -1)}${r.endsWith("0") ? "1" : "0"}`;
    });
    expectCaught(files, "founder signatures (ECDSA, P-256)", /P-256 signature does not verify/);
  });

  it("one byte changed in an ECDSA signature", () => {
    const files = editJson(fx.files, "signatures.json", (s) => {
      const sig: string = s[1].submission.ecdsa.signature;
      s[1].submission.ecdsa.signature = `${sig.slice(0, 10)}${sig[10] === "0" ? "1" : "0"}${sig.slice(11)}`;
    });
    expectCaught(files, "founder signatures (ECDSA, P-256)");
  });

  it("one byte changed in a rationale preimage", () => {
    const files = editJson(fx.files, "rationales.json", (r) => {
      r[0].rationale.amountMinor = "7501";
    });
    expectCaught(files, "rationale commitments", /preimage hashes to/);
  });

  it("a removed rationale preimage fails, and so does one marked unavailable (no deployment predates task 1.16)", () => {
    const removed = editJson(fx.files, "rationales.json", (r) => {
      r.splice(0, 1);
    });
    expect(detail(verifyBundle(rehash(removed)), "rationale commitments")).toMatch(/no preimage entry/);
    const withheld = rehash(
      editJson(fx.files, "rationales.json", (r) => {
        r[0] = { status: "unavailable", rationaleHash: r[0].rationaleHash, decisionId: r[0].decisionId, reason: "pre-1.16 row" };
      }),
    );
    const res = verifyBundle(withheld);
    expect(res.ok).toBe(false);
    expect(failed(res)).toEqual(["rationale commitments"]);
    expect(detail(res, "rationale commitments")).toMatch(/preimage is withheld/);
  });

  it("reordered logs inside a receipt", () => {
    const files = editJson(fx.files, receiptPath(fx.commitTx), (r) => {
      r.logs = [r.logs[0], { ...r.logs[0] }];
    });
    expectCaught(files, "receipts", /out of order or repeated/);
  });

  it("a duplicated event (the same Spent replayed in a second receipt)", () => {
    const [first] = fx.spendTxs as string[];
    const files = editJson(fx.files, receiptPath(fx.spendTxs[1] as string), (r) => {
      const src = JSON.parse(fx.files[receiptPath(first as string)] as string);
      r.logs.push({ ...src.logs[0], transactionHash: r.transactionHash, blockHash: r.blockHash, blockNumber: r.blockNumber, logIndex: "0x1" });
    });
    const res = verifyBundle(rehash(files));
    expect(failed(res)).toContain("event replay (caps, payees, duplicates)");
    expect(detail(res, "event replay (caps, payees, duplicates)")).toMatch(/intent spent twice|not the next slot/);
  });

  it("reordered trace events break the hash chain", () => {
    const files = editJson(fx.files, "traces.json", (t) => {
      [t[0], t[1]] = [t[1], t[0]];
    });
    expectCaught(files, "trace hash chains", /expected seq 0/);
  });

  it("an eval trace is not decision evidence", () => {
    const files = editJson(fx.files, "traces.json", (t) => {
      t[t.length - 1].summary = "[eval E1 x] refused";
    });
    expect(detail(verifyBundle(rehash(files)), "trace hash chains")).toMatch(/hash is not keccak256|eval trace/);
  });

  it("an evidence row whose receipt says otherwise", () => {
    const files = editJson(fx.files, "evidence.json", (rows) => {
      rows[0].layer = "onchain_revert";
      rows[0].expected = "revert";
    });
    expectCaught(files, "evidence rows", /receipt succeeded/);
  });
});

describe("verifyBundle: plan rules (consistent, re-signed bundles)", () => {
  it("a spend over the per-tx cap", async () => {
    const bad = await buildFixture({ spends: [{ line: "LOGISTICS", amount: 20_001n, ref: 1, after: 60 }] });
    expect(detail(verifyBundle(bad.files), "event replay (caps, payees, duplicates)")).toMatch(/over the per-tx cap/);
  });

  it("spends over the rolling-window cap, and inside it again once the window has passed", async () => {
    const day = 86_400;
    const over = await buildFixture({ spends: [1, 2, 3].map((ref) => ({ line: "LOGISTICS" as const, amount: 20_000n, ref, after: ref * 60 })) });
    expect(detail(verifyBundle(over.files), "event replay (caps, payees, duplicates)")).toMatch(/over the rolling-window cap/);
    const later = await buildFixture({ spends: [{ line: "LOGISTICS", amount: 20_000n, ref: 1, after: 60 }, { line: "LOGISTICS", amount: 20_000n, ref: 2, after: 120 }, { line: "LOGISTICS", amount: 20_000n, ref: 3, after: 7 * day + 61 }] });
    expect(verifyBundle(later.files).ok).toBe(true);
  });

  it("the same invoice paid twice, and a pacing slot skipped", async () => {
    const dup = await buildFixture({ spends: [{ line: "LOGISTICS", amount: 1_000n, ref: 1, after: 60 }, { line: "LOGISTICS", amount: 2_000n, ref: 1, after: 120 }] });
    expect(detail(verifyBundle(dup.files), "event replay (caps, payees, duplicates)")).toMatch(/paid twice/);
    const skip = await buildFixture({ spends: [{ line: "ADS", amount: 7_500n, ref: 2, after: 60 }] });
    expect(detail(verifyBundle(skip.files), "event replay (caps, payees, duplicates)")).toMatch(/not the next slot/);
  });
});
