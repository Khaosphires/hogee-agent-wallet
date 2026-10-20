import { describe, expect, it } from "vitest";
import { catalogueEntry } from "@hogee/verify-evidence/fisco";
import { anchorCheckerOf, checkAnchor } from "./fisco-anchor-check";
import {
  THREE_STOPS,
  anchorView,
  errorStringOf,
  fiscoVerdict,
  folderCheck,
  meaningOf,
  nodesOf,
  packIdentityOf,
  safeDetail,
  stepViews,
  threeStops,
  utcLabel,
  verifiedCreatedAt,
  type AnchorCheck,
  type FiscoCheck,
} from "./fisco-model";

const enc = new TextEncoder();
const word = (n: number) => n.toString(16).padStart(64, "0");
/** ABI Error(string), as FISCO puts it in a native receipt's output (REG-FACTS). */
const errorString = (text: string) => {
  const hex = [...enc.encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `0x08c379a0${word(32)}${word(text.length)}${hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")}`;
};
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const SPEND = `0x${"ab".repeat(4)}${"00".repeat(200)}`;
const ok = (name: string): FiscoCheck => ({ name, ok: true });

interface StepSpec {
  readonly seq: number;
  readonly id: string;
  readonly role?: string;
  readonly kind?: string;
  readonly block?: number;
  readonly native?: { status: number; output: string } | null;
  readonly input?: string;
  readonly probeBlock?: number;
}

/** A v2-shaped pack (only what fisco-model reads): steps.json, txs/<hash>.json, chain.json, pack.json. */
function packFiles(specs: readonly StepSpec[]): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const steps = specs.map((s) => {
    const kind = s.kind ?? "mined";
    const txHash = kind === "probe-only" ? undefined : hash(s.seq);
    if (txHash) {
      const tx = {
        hash: txHash,
        tx: { hash: txHash, input: s.input ?? "0x" },
        receipt: { blockNumber: `0x${(s.block ?? s.seq).toString(16)}`, status: kind === "mined" ? "0x1" : "0x0" },
        native: s.native === null ? null : { transactionHash: txHash, blockNumber: s.block ?? s.seq, status: s.native?.status ?? 0, output: s.native?.output ?? "0x" },
      };
      files[`txs/${txHash}.json`] = enc.encode(JSON.stringify(tx));
    }
    return {
      seq: s.seq,
      id: s.id,
      title: "MOCK: text the pack wrote",
      signerRole: s.role ?? "agent",
      expected: kind === "mined" || kind === "probe-only" ? "ok" : "refused",
      outcome: { kind, ...(txHash ? { txHash } : {}) },
      ...(s.probeBlock !== undefined ? { call: { from: "0x", to: "0x", data: "0x", block: s.probeBlock } } : {}),
    };
  });
  files["steps.json"] = enc.encode(JSON.stringify({ format: "hogee.fisco-mirror/2", steps }));
  files["chain.json"] = enc.encode(JSON.stringify({ nodeCount: 5, sealerCount: 4, observerCount: 1 }));
  files["pack.json"] = enc.encode(JSON.stringify({ packId: "fm-0123456789abcdef", createdAt: "2026-10-19T21:03:15.402Z", sourceBundle: { runId: "ev-74756ea61a72ae7c", files: {} } }));
  return files;
}

const THE_RUN: readonly StepSpec[] = [
  { seq: 1, id: "G0", role: "regulator" },
  { seq: 21, id: "G1", role: "regulator", block: 30 },
  { seq: 22, id: "V1", role: "regulator", block: 31 },
  { seq: 23, id: "F1", kind: "mined-reverted", block: 32, native: { status: 22, output: errorString("Account's status is abnormal") }, input: SPEND },
  { seq: 25, id: "C1", kind: "probe-only", probeBlock: 34 },
  { seq: 30, id: "M1", kind: "mined-reverted", block: 39, native: { status: 18, output: errorString("Call permission denied") }, input: SPEND },
  { seq: 36, id: "R17", kind: "mined-reverted", block: 45, native: { status: 16, output: "0x" }, input: SPEND.toUpperCase().replace("0X", "0x") },
];

describe("fiscoVerdict: never a faked pass", () => {
  it("says N of N checks passed in this browser only when every check passed", () => {
    expect(fiscoVerdict("verified", [ok("a"), ok("b")])).toEqual({ tone: "verified", title: "2 of 2 checks passed in this browser", line: null, count: null });
  });

  it("keeps a failure red with its count, even if the state claims a pass", () => {
    const checks = [ok("a"), { name: "b", ok: false, detail: "x" }];
    for (const state of ["verified", "failed"] as const) {
      expect(fiscoVerdict(state, checks)).toMatchObject({ tone: "failed", title: "Not verified", count: "1 of 2 checks passed" });
    }
    expect(fiscoVerdict("verified", [])).toMatchObject({ tone: "failed", title: "Not verified", count: "0 of 0 checks passed" });
  });

  it("an unreadable pack is red without a count; while checking nothing is claimed", () => {
    expect(fiscoVerdict("unreadable", null)).toMatchObject({ tone: "failed", title: "Not verified", count: null });
    expect(fiscoVerdict("failed", null)).toMatchObject({ tone: "failed", count: null });
    const checking = fiscoVerdict("checking", null);
    expect(checking.tone).toBe("checking");
    expect(checking.title).not.toMatch(/passed|verified/i);
  });

  it("the folder must be the packId pack.json commits to", () => {
    expect(folderCheck("fm-0123456789abcdef", "fm-0123456789abcdef").ok).toBe(true);
    expect(folderCheck("fm-0123456789abcdef", "fm-fedcba9876543210").ok).toBe(false);
    expect(folderCheck("fm-0123456789abcdef", null).ok).toBe(false);
  });
});

describe("a check's detail on screen", () => {
  it("never carries control, line-separator or bidi characters from the pack, and is capped", () => {
    expect(safeDetail("steps.json: \u202egnissim\u202c ok\nFAIL")).toBe("steps.json: ?gnissim? ok?FAIL");
    expect(safeDetail("x".repeat(400))).toHaveLength(300);
  });

  it("never carries invisible or bidi characters either: soft hyphen, Arabic letter mark, zero-width, word joiner, BOM", () => {
    const hidden = "\u00ad\u061c\u200b\u200c\u200d\u2060\u2061\u2062\u2063\u2064\ufeff";
    expect(safeDetail(`ok${hidden}FAIL`)).toBe(`ok${"?".repeat(hidden.length)}FAIL`);
    expect(safeDetail("café ✓")).toBe("café ✓");
  });
});

describe("the chain's own words", () => {
  it("decodes a short printable Error(string), nothing else", () => {
    expect(errorStringOf(errorString("Account's status is abnormal"))).toBe("Account's status is abnormal");
    expect(errorStringOf(errorString("Call permission denied").toUpperCase().replace("0X", "0x"))).toBe("Call permission denied");
    expect(errorStringOf("0x")).toBeNull();
    expect(errorStringOf(`0xdeadbeef${word(32)}${word(4)}${"41".repeat(4).padEnd(64, "0")}`)).toBeNull();
    expect(errorStringOf(errorString("bad\u0007bell"))).toBeNull();
    expect(errorStringOf(errorString("x".repeat(121)))).toBeNull();
    // A length past the data is never read.
    expect(errorStringOf(`0x08c379a0${word(32)}${word(40)}${"41".repeat(4).padEnd(64, "0")}`)).toBeNull();
  });
});

describe("the pack's steps and the three stops", () => {
  const files = packFiles(THE_RUN);

  it("names each step from Hogee's catalogue and labels, never from the pack's own text", () => {
    const views = stepViews(files);
    expect(views.map((v) => v.id)).toEqual(["G0", "G1", "V1", "F1", "C1", "M1", "R17"]);
    for (const v of views) expect(v.title).not.toContain("MOCK");
    expect(views.find((v) => v.id === "F1")?.title).toBe(catalogueEntry("F1")?.title);
    expect(views.find((v) => v.id === "G1")?.who).toBe("The regulator");
    expect(views.find((v) => v.id === "C1")).toMatchObject({ outcome: "probe", block: 34, status: null });
  });

  it("shows the three stops of the same spend, each with its block and the refusal that stopped it", () => {
    const { stops, sameCall } = threeStops(stepViews(files));
    expect(stops.map((s) => [s.stepId, s.present, s.block, s.status, s.by])).toEqual([
      ["F1", true, 32, 22, "chain"],
      ["M1", true, 39, 18, "chain"],
      ["R17", true, 45, 16, "contract"],
    ]);
    expect(stops.map((s) => s.reason)).toEqual(["Account's status is abnormal", "Call permission denied", "Paused"]);
    expect(sameCall).toBe(true);
    expect(THREE_STOPS.map((s) => s.title)).toEqual(["The regulator froze the agent's account", "The regulator banned spend() for the agent", "The loan officer paused the wallet"]);
  });

  it("a stop that is missing, or refused another way, is not shown as that stop", () => {
    const wrong = packFiles(THE_RUN.filter((s) => s.id !== "M1").map((s) => (s.id === "F1" ? { ...s, native: { status: 16, output: "0x" } } : s)));
    const { stops } = threeStops(stepViews(wrong));
    expect(stops.map((s) => [s.stepId, s.present, s.reason])).toEqual([
      ["F1", false, null],
      ["M1", false, null],
      ["R17", true, "Paused"],
    ]);
  });

  it("repeats the chain's words only when they are FISCO's own text for that status; anything else is the catalogue's error name", () => {
    const said = (f1: string, m1: string) =>
      threeStops(
        stepViews(
          packFiles(
            THE_RUN.map((s) =>
              s.id === "F1" ? { ...s, native: { status: 22, output: errorString(f1) } } : s.id === "M1" ? { ...s, native: { status: 18, output: errorString(m1) } } : s,
            ),
          ),
        ),
      ).stops.map((s) => s.reason);
    expect(said("Account's status is abnormal", "Call permission denied")).toEqual(["Account's status is abnormal", "Call permission denied", "Paused"]);
    // A pack's own text under a chain status, or the other status's words, is never shown as the chain's.
    expect(said("Frozen by the regulator: call 555-0100", "Call permission denied.")).toEqual(["AccountFrozen", "PermissionDenied", "Paused"]);
    expect(said("Call permission denied", "Account's status is abnormal")).toEqual(["AccountFrozen", "PermissionDenied", "Paused"]);
  });

  it("the same call only when all three carry the same data", () => {
    const other = packFiles(THE_RUN.map((s) => (s.id === "M1" ? { ...s, input: `${SPEND.slice(0, -2)}01` } : s)));
    expect(threeStops(stepViews(other)).sameCall).toBe(false);
    expect(threeStops([]).sameCall).toBe(false);
  });

  it("reads nothing from a pack whose steps don't parse, or aren't strict UTF-8", () => {
    expect(stepViews({ "steps.json": enc.encode("{") })).toEqual([]);
    expect(stepViews({ "steps.json": new Uint8Array([0xff, 0xfe]) })).toEqual([]);
    expect(stepViews({})).toEqual([]);
  });

  it("reads the pack's id and its source run from pack.json", () => {
    expect(packIdentityOf(files)).toEqual({ packId: "fm-0123456789abcdef", sourceRunId: "ev-74756ea61a72ae7c" });
    expect(packIdentityOf({ "pack.json": enc.encode('{"packId":"x","sourceBundle":{"runId":"../x"}}') })).toBeNull();
  });

  it("dates the replay from pack.json only once this browser verified the pack (never from the listing)", () => {
    expect(verifiedCreatedAt(files, true)).toBe("2026-10-19T21:03:15.402Z");
    expect(verifiedCreatedAt(files, false)).toBeNull();
    expect(verifiedCreatedAt({ "pack.json": enc.encode('{"createdAt":"yesterday"}') }, true)).toBeNull();
    expect(verifiedCreatedAt({}, true)).toBeNull();
  });
});

describe("the nodes", () => {
  const files = packFiles(THE_RUN);
  it("says the regulator's ledger matches only when the verifier's ledger check passed", () => {
    expect(nodesOf(files, [ok("regulator ledger")])).toEqual({ validators: 4, observers: 1, ledger: "matches" });
    expect(nodesOf(files, [{ name: "regulator ledger", ok: false }])?.ledger).toBe("differs");
    // A ledger check the verifier skipped (an earlier check failed) compared nothing: never "does not match".
    expect(nodesOf(files, [{ name: "regulator ledger", ok: false, detail: "not run: the pack's files are missing or invalid" }])?.ledger).toBe("unchecked");
    expect(nodesOf(files, [ok("pack files")])?.ledger).toBe("unchecked");
    expect(nodesOf(files, null)?.ledger).toBe("unchecked");
    expect(nodesOf({}, null)).toBeNull();
  });
});

describe("the Sepolia timestamp", () => {
  const TX = `0x${"C0".repeat(32)}`;
  const anchored: AnchorCheck = { available: true, ok: true, anchored: true, anchor: { txHash: TX, blockNumber: 9_412_345, timestamp: 1_792_478_460 }, detail: "" };

  it("is publicly timestamped, with the pinned Sepolia Etherscan link, only when the pack passed and so did its anchor", () => {
    expect(anchorView(anchored, true, true)).toEqual({ state: "anchored", blockNumber: 9_412_345, utc: utcLabel(1_792_478_460), href: `https://sepolia.etherscan.io/tx/${TX.toLowerCase()}`, detail: null });
    for (const check of [{ ...anchored, ok: false }, { ...anchored, anchored: false }, { ...anchored, anchor: null }, { ...anchored, available: false }]) {
      expect(anchorView(check, true, true).href).toBeNull();
    }
  });

  it("an anchor that checks on a pack that doesn't is not counted: no block, no time, no link", () => {
    expect(anchorView(anchored, true, false)).toEqual({ state: "unproven", blockNumber: null, utc: null, href: null, detail: null });
  });

  it("says not timestamped yet, not available here, failed or checking, without a link", () => {
    for (const proven of [true, false]) {
      expect(anchorView(undefined, true, proven).state).toBe("checking");
      expect(anchorView({ available: false, ok: false, anchored: false, anchor: null, detail: "" }, true, proven).state).toBe("unavailable");
      expect(anchorView({ available: false, ok: false, anchored: false, anchor: null, detail: "" }, false, proven).state).toBe("none");
      expect(anchorView({ available: true, ok: true, anchored: false, anchor: null, detail: "not anchored" }, false, proven).state).toBe("none");
      const bad = anchorView({ available: true, ok: false, anchored: false, anchor: null, detail: "signer is not‮ the deployer" }, true, proven);
      expect(bad).toMatchObject({ state: "failed", href: null, detail: "signer is not? the deployer" });
      expect(anchorView({ available: true, ok: false, anchored: false, anchor: null, detail: "é ok" }, true, proven).detail).toBe("é ok");
    }
  });

  it("names the Sepolia timestamp as the public part only once its check passed", () => {
    expect(meaningOf(true)).toMatch(/the Sepolia timestamp is the public part\.$/);
    expect(meaningOf(false)).not.toMatch(/Sepolia|timestamp|public/);
    expect(meaningOf(false)).toMatch(/taken as it served them\.$/);
  });

  it("dates it in UTC", () => {
    expect(utcLabel(0)).toBe("1 Jan 1970, 00:00 UTC");
    expect(utcLabel(1_792_478_460)).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC$/);
    expect(utcLabel(-1)).toBeNull();
    expect(utcLabel(1.5)).toBeNull();
  });
});

describe("the anchor adapter (fisco-anchor's checkSepoliaAnchor, looked up by name)", () => {
  const files = { "pack.json": enc.encode("{}") };

  it("finds the check only when the verifier exports it", () => {
    expect(anchorCheckerOf({})).toBeNull();
    expect(anchorCheckerOf({ checkSepoliaAnchor: "not a function" })).toBeNull();
    const fn = () => ({});
    expect(anchorCheckerOf({ checkSepoliaAnchor: fn })).toBe(fn);
  });

  it("without the check, the anchor is not available, never a pass", () => {
    expect(checkAnchor(files, new Uint8Array([1]), null)).toMatchObject({ available: false, ok: false, anchor: null });
  });

  it("passes the exact sidecar bytes and keeps only well-formed facts", () => {
    const TX = `0x${"c0".repeat(32)}`;
    const sidecar = enc.encode('{"format":"hogee.fisco-anchor/1"}');
    let seen: Uint8Array | null = null;
    const facts = { packId: "fm-0123456789abcdef", txHash: TX, blockNumber: 7, timestamp: 9, etherscanUrl: "https://evil.example/tx" };
    const r = checkAnchor(files, sidecar, (_f, s) => {
      seen = s;
      return { name: "Sepolia timestamp", ok: true, anchored: true, anchor: facts, detail: "block 7" };
    });
    expect(seen).toBe(sidecar);
    expect(r).toEqual({ available: true, ok: true, anchored: true, anchor: { txHash: TX, blockNumber: 7, timestamp: 9 }, detail: "block 7" });
  });

  it("fails closed on a failure, a throw, a malformed result or malformed facts", () => {
    const run = (result: unknown) => checkAnchor(files, null, () => result);
    expect(run({ ok: false, anchored: true, anchor: null, detail: "wrong signer" })).toMatchObject({ ok: false, detail: "wrong signer" });
    expect(checkAnchor(files, null, () => { throw new Error("boom"); })).toMatchObject({ ok: false, anchor: null });
    expect(run(null)).toMatchObject({ ok: false });
    expect(run({ ok: true, anchored: true, anchor: { txHash: "0x12", blockNumber: 7, timestamp: 9 } })).toMatchObject({ ok: false, anchor: null });
    expect(run({ ok: true, anchored: true, anchor: { txHash: `0x${"c0".repeat(32)}`, blockNumber: -1, timestamp: 9 } })).toMatchObject({ ok: false });
    expect(run({ ok: true, anchored: false, anchor: null, detail: "not anchored" })).toMatchObject({ available: true, ok: true, anchored: false, anchor: null });
  });
});
