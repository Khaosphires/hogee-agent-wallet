/**
 * "event replay" mirrors Treasury and MilestoneEscrow (run-6 v-5): each case is a consistent, re-signed bundle that the
 * contracts would have refused, so only the replay can catch it; each has a control that the contracts accept.
 */
import { keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { verifyBundle, type VerifyResult } from "../src/index";
import { buildFixture, pauseLineTx, pauseTx, tag, treasuryCall, treasuryLog, ZERO32, type ExtraTx, type FixtureOptions } from "./fixture";

const REPLAY = "event replay (caps, payees, duplicates)";
const failed = (r: VerifyResult): string[] => r.checks.filter((c) => !c.ok).map((c) => c.name);
const detail = (r: VerifyResult, name: string): string => r.checks.find((c) => c.name === name)?.detail ?? "";

async function verify(opts: FixtureOptions): Promise<VerifyResult> {
  return verifyBundle((await buildFixture(opts)).files);
}

/** Only the replay fails, for `why`. */
function expectReplayFails(r: VerifyResult, why: RegExp): void {
  expect(failed(r)).toEqual([REPLAY]);
  expect(detail(r, REPLAY)).toMatch(why);
}

function expectOk(r: VerifyResult): void {
  expect(failed(r)).toEqual([]);
  expect(r.ok).toBe(true);
}

/** queueLoosen + executeLoosen of one loosening (founder and lender co-signed; the timelock is not replayed). */
function loosen(id: string, after: number, kind: number, target: string, aux: string, newValue: bigint): ExtraTx[] {
  const loosenId = keccak256(toHex(`loosen:${id}`));
  const req = { kind, target, aux, newValue, deploymentId: tag("final-test"), nonce: 5n, expiry: 1_999_999_999n };
  const sig = { kind: 0, data: `0x${"11".repeat(65)}` };
  return [
    { id: `${id}-q`, kind: "Treasury.queueLoosen", after, from: "relayer", to: "Treasury", data: treasuryCall("queueLoosen", [req, sig, sig]), logs: [treasuryLog("LoosenQueued", { loosenId, kind, target, aux, newValue, executableAt: 0n, expiresAt: 1_999_999_999n })] },
    { id: `${id}-x`, kind: "Treasury.executeLoosen", after: after + 1, from: "relayer", to: "Treasury", data: treasuryCall("executeLoosen", [loosenId]), logs: [treasuryLog("LoosenExecuted", { loosenId, kind })] },
  ];
}

describe("replay: payees must be bound AND listed by the current plan version (Treasury spend row 10)", () => {
  it("a listed payee that was never bound (no PayeeBound) fails", async () => {
    expectReplayFails(await verify({ bindPlatformPayees: false }), /not bound/);
  });

  it("a payee a re-commit delisted fails, though its v1 binding remains", async () => {
    const dropLogistics = (m: Parameters<NonNullable<FixtureOptions["recommit"]>>[0]) => ({ ...m, lines: m.lines.map((l) => (l.lineKey === "LOGISTICS" ? { ...l, payeeIds: [] } : l)) });
    expectReplayFails(await verify({ recommit: dropLogistics }), /not listed by plan v2/);
    expectOk(await verify({ recommit: (m) => m }));
  });

  it("a payee added by LoosenExecuted kind 3 (ADD_PAYEE) is payable once it has cooled", async () => {
    const payee = "vendor-y";
    const added = loosen("add", 100, 3, tag(payee), tag("CONTINGENCY"), BigInt(keccak256(toHex("payout:vendor-y"))));
    const bound = treasuryLog("PayeeBound", { payeeId: tag(payee), lineId: tag("CONTINGENCY"), orderId: ZERO32, coolingUntil: 0n, lifetimeCapMinor: 2n ** 128n - 1n, supplierId: ZERO32, scheduleHash: ZERO32, payoutAccountHash: keccak256(toHex("payout:vendor-y")) });
    const execute = { ...(added[1] as ExtraTx), logs: [bound, ...(added[1] as ExtraTx).logs] };
    const spends = [{ line: "CONTINGENCY" as const, amount: 1_000n, ref: 1, after: 500, payee }];
    expectOk(await verify({ extra: [added[0] as ExtraTx, execute], spends }));
    expectReplayFails(await verify({ extra: [added[0] as ExtraTx, { ...execute, after: 600 }], spends }), /not bound/);
  });
});

describe("replay: agent expiry (PlanCommitted.agentExpiry, LoosenExecuted kind 4)", () => {
  it("a spend after the agent expired fails although the line is still valid", async () => {
    expectReplayFails(await verify({ agentExpiresAfter: 5_000 }), /agent expired/);
  });

  it("a kind-4 loosening extends the expiry", async () => {
    const fx0 = await buildFixture({ agentExpiresAfter: 5_000 });
    expectOk(await verify({ agentExpiresAfter: 5_000, extra: loosen("extend", 100, 4, ZERO32, ZERO32, fx0.commitAt + 10_000n) }));
  });
});

describe("replay: MilestoneFunded is checked like MilestoneEscrow.fundMilestone", () => {
  const bind = { orderId: "order-a-001", payee: "sup-a", after: 10, coolingSeconds: 120, schedule: [5_000n, 15_000n] } as const;
  const verifyMs = (opts: FixtureOptions) => verify({ spends: [], bind, ...opts });

  it("a funding after cooling, by the live agent, passes", async () => {
    expectOk(await verifyMs({ milestones: [{ idx: 0, amount: 5_000n, after: 500 }] }));
  });

  it("fails while the treasury is paused", async () => {
    expectReplayFails(await verifyMs({ extra: [pauseTx("act-pause", 300)], milestones: [{ idx: 0, amount: 5_000n, after: 500 }] }), /treasury is paused/);
  });

  it("fails while the supplier line is paused", async () => {
    expectReplayFails(await verifyMs({ extra: [pauseLineTx("act-pause-line", 300, "SUPPLIER")], milestones: [{ idx: 0, amount: 5_000n, after: 500 }] }), /line is paused/);
  });

  it("fails for a zero amount", async () => {
    expectReplayFails(await verifyMs({ milestones: [{ idx: 0, amount: 0n, after: 500 }] }), /zero amount/);
  });

  it("fails while the payee is still cooling", async () => {
    expectReplayFails(await verifyMs({ milestones: [{ idx: 0, amount: 5_000n, after: 60 }] }), /payee still cooling/);
  });

  it("fails after the agent expired", async () => {
    expectReplayFails(await verifyMs({ agentExpiresAfter: 400, milestones: [{ idx: 0, amount: 5_000n, after: 500 }] }), /agent expired/);
  });

  it("fails for an order no PayeeBound opened", async () => {
    const r = await verifyMs({ bind: { ...bind, after: 600 }, milestones: [{ idx: 0, amount: 5_000n, after: 500 }] });
    expectReplayFails(r, /order .* is not bound/);
  });
});

describe("replay: Treasury's 64 live window entries per line", () => {
  const spends = (n: number) => Array.from({ length: n }, (_, i) => ({ line: "LOGISTICS" as const, amount: 1n, ref: i + 1, after: 60 + i * 10 }));

  it("the 65th live entry fails even under the window cap", async () => {
    expectReplayFails(await verify({ spends: spends(65) }), /64 live window entries/);
  }, 60_000);

  it("64 live entries pass", async () => {
    expectOk(await verify({ spends: spends(64) }));
  }, 60_000);
});

describe("replay: a T29 orphan needs the treasury pause (TreasuryPaused with lineId 0)", () => {
  const orphan = [{ line: "LOGISTICS" as const, amount: 1_000n, ref: 1, after: 60, orphan: true }];

  it("a line pause after it is not the treasury pause", async () => {
    expectReplayFails(await verify({ spends: orphan, extra: [pauseLineTx("act-pause-line", 120, "LOGISTICS")] }), /no treasury pause follows/);
  });

  it("a treasury pause after it passes, with a note", async () => {
    const r = await verify({ spends: orphan, extra: [pauseTx("act-pause", 120, "agent")] });
    expectOk(r);
    expect(detail(r, REPLAY)).toMatch(/1 orphan spend\(s\) followed by the treasury pause/);
  });
});

describe("replay: OwnerSpent makes ownerSpend's checks, with no pause or circuit of any kind (§8.8)", () => {
  const owner = [{ line: "LOGISTICS" as const, amount: 2_000n, ref: 10, after: 800 }];
  const tripped = { after: 300, line: "LOGISTICS", tripsCircuit: true } as const;

  it("the circuit trips, then the founder pays through OwnerSpend: the bundle verifies", async () => {
    expectOk(await verify({ spends: [], denial: tripped, ownerSpends: owner }));
  });

  it("control: an agent Spent on the tripped line fails", async () => {
    expectReplayFails(await verify({ spends: [{ line: "LOGISTICS", amount: 1_000n, ref: 1, after: 800 }], denial: tripped }), /circuit is open/);
  });

  it("an OwnerSpent on a paused line, or while the treasury is paused, verifies", async () => {
    expectOk(await verify({ spends: [], extra: [pauseLineTx("act-pause-line", 300, "LOGISTICS")], ownerSpends: owner }));
    expectOk(await verify({ spends: [], extra: [pauseTx("act-pause", 300)], ownerSpends: owner }));
  });

  it("an OwnerSpent on an expired line still fails", async () => {
    const fx0 = await buildFixture();
    const expire = (m: Parameters<NonNullable<FixtureOptions["recommit"]>>[0]) => ({ ...m, lines: m.lines.map((l) => (l.lineKey === "LOGISTICS" ? { ...l, validUntil: String(fx0.commitAt + 500n) } : l)) });
    expectReplayFails(await verify({ spends: [], recommit: expire, ownerSpends: owner }), /line expired/);
  });
});
