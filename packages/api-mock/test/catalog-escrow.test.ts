/**
 * Run-10 skills re-check (rcfix-mock), on the default demo's catalog escrow orders:
 *  - W-1: the agent funds a catalog sample or deposit only as MilestoneEscrow.fundMilestone would (nothing paused or
 *    tripped, within the outflow bound); a catalog balance whose funding breaks the bound is refused.
 *  - W-2: a MilestoneRelease submit applies only the struct the founder signed (a second tab, or evidence re-uploaded
 *    after the request, is refused with nothing traced).
 *  - W-3: a submit's tx never repeats across store builds.
 *  - H-4 (mock part): a RELEASE_ESCROW_BALANCE must carry the recorded inspection's hash; no upload, no release.
 * Run: pnpm --filter @hogee/api-mock test
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseMinor, type Exception, type Hex32, type SignatureKind, type SignatureRequestResponse } from "@hogee/core";
import { app } from "../src/index";
import { readEnv } from "../src/env";
import { outflowMinor } from "../src/spend-policy";
import { getState, resetState, updatePocket, type MockState } from "../src/store";
import { recordInspection, supplierOrderFor } from "../src/supplier-order";
import { harness, json, profile, secret } from "./support/harness";
import { enrolFounder, submitWith, type SoftPasskey } from "./support/passkey";

type Err = { error?: { code: string; message: string } };
type Request = SignatureRequestResponse & Err;

beforeAll(() => {
  process.env.DEMO_MODE = "1";
  process.env.PERSONA_COOKIE_SECRET = secret();
  process.env.OFFICER_TOKEN = secret();
});

const { call } = harness(app);
const E1 = `0x${"e1".repeat(32)}` as Hex32;
const E2 = `0x${"e2".repeat(32)}` as Hex32;
/** The default seed's catalog order: its balance (idx 2) waits for the founder's release, not funded yet. */
const SEEDED_ORDER = "order-a-001";
const ORDER_B = (): string => `${profile().orderPrefix}b-001`;

const state = (): MockState => getState(readEnv());
const ask = (kind: SignatureKind, refId: string) => call<Request>("/api/signatures/request", json({ kind, refId, method: "passkey" }));
/** Escrow fundings the mock started (seeded payments never move). */
const fundings = (st: MockState) => st.payments.filter((sp) => sp.script && sp.payment.kind === "FUND_MILESTONE").map((sp) => sp.payment);
const releases = (st: MockState) => st.payments.filter((sp) => sp.script && sp.payment.kind === "RELEASE_MILESTONE").map((sp) => sp.payment);
const signatureTraces = (st: MockState) => st.traces.filter((t) => t.kind === "SIGNATURE").length;
const balanceOf = (st: MockState, orderId: string) => st.escrow.get(orderId)?.find((m) => !m.autoRelease);
/** Room for `extra` more outflow under both bounds (released and funded), and nothing more. */
const boundAt = (st: MockState, extra: bigint): void => {
  const at = (outflowMinor(st) + extra).toString();
  st.balances = { ...st.balances, releasedMinor: at, fundedMinor: at };
};

let key: SoftPasskey;

beforeEach(async () => {
  resetState(readEnv());
  key = await enrolFounder(call);
});

describe("W-1: catalog funding as fundMilestone allows it", () => {
  const signOrderB = async () => {
    const req = await ask("SupplierApproval", "supplier-b");
    expect(req.status).toBe(200);
    expect((await submitWith(call, key, req.body)).body.state).toBe("BROADCAST");
  };

  it("funds the sample and deposit when nothing is paused and the bound holds (unchanged)", async () => {
    await signOrderB();
    const st = state();
    expect(fundings(st).map((p) => p.amountMinor)).toHaveLength(2);
    expect(st.escrow.get(ORDER_B())?.map((m) => m.funded !== "0")).toEqual([true, true, false]);
  });

  it.each([
    ["the treasury is paused", (st: MockState) => void (st.balances = { ...st.balances, paused: true })],
    ["the SUPPLIER pocket is paused", (st: MockState) => updatePocket(st, "SUPPLIER", (p) => ({ ...p, paused: true }))],
    ["the SUPPLIER pocket stopped itself", (st: MockState) => updatePocket(st, "SUPPLIER", (p) => ({ ...p, circuitOpen: true }))],
    ["the officer funded nothing yet", (st: MockState) => void (st.balances = { ...st.balances, fundedMinor: "0" })],
  ])("funds nothing when %s: the order is written, every milestone unfunded", async (_why, hold) => {
    hold(state());
    await signOrderB();
    const st = state();
    expect(fundings(st)).toEqual([]);
    expect(st.escrow.get(ORDER_B())?.map((m) => m.funded)).toEqual(["0", "0", "0"]);
  });

  it("funds only what fits under the outflow bound (the sample, not the deposit)", async () => {
    const st = state();
    const order = supplierOrderFor(st, "supplier-b");
    if ("code" in order) throw new Error(order.message);
    const [sample, deposit] = order.schedule;
    boundAt(st, parseMinor(sample?.amountMinor ?? "0"));
    await signOrderB();
    expect(fundings(st).map((p) => p.amountMinor)).toEqual([sample?.amountMinor]);
    expect(st.escrow.get(ORDER_B())?.map((m) => m.funded)).toEqual([sample?.amountMinor, "0", "0"]);
    expect(deposit?.autoRelease).toBe(true);
  });

  it("refuses a catalog balance whose funding breaks the outflow bound (CapExceeded), at request and at submit", async () => {
    const st = state();
    recordInspection(st, SEEDED_ORDER, E1);
    const balance = parseMinor(balanceOf(st, SEEDED_ORDER)?.amountMinor ?? "0");
    boundAt(st, balance - 1n);
    expect((await ask("MilestoneRelease", SEEDED_ORDER)).body.error?.code).toBe("CapExceeded");
    boundAt(st, balance);
    const req = await ask("MilestoneRelease", SEEDED_ORDER);
    expect(req.status).toBe(200);
    boundAt(st, balance - 1n);
    const traces = st.traces.length;
    const refused = await submitWith(call, key, req.body);
    expect(refused.body.error?.code).toBe("CapExceeded");
    expect(st.traces.length).toBe(traces);
    expect(releases(st)).toEqual([]);
    expect(balanceOf(st, SEEDED_ORDER)?.released).toBe(false);
  });

  it("refuses a catalog balance while payments are paused (its funding would revert Paused)", async () => {
    const st = state();
    recordInspection(st, SEEDED_ORDER, E1);
    st.balances = { ...st.balances, paused: true };
    expect((await ask("MilestoneRelease", SEEDED_ORDER)).body.error?.code).toBe("Paused");
  });
});

describe("W-2: a MilestoneRelease submit is bound to the signed struct", () => {
  it("a second tab's submit of the same release is refused, with nothing traced or counted", async () => {
    const st = state();
    recordInspection(st, SEEDED_ORDER, E1);
    boundAt(st, 10_000_000n);
    const a = (await ask("MilestoneRelease", SEEDED_ORDER)).body;
    const b = (await ask("MilestoneRelease", SEEDED_ORDER)).body;
    expect((await submitWith(call, key, a)).body.state).toBe("BROADCAST");
    const traces = st.traces.length;
    const sigs = signatureTraces(st);
    const second = await submitWith(call, key, b);
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe("CONFLICT");
    expect(second.body.state).toBeUndefined();
    expect(st.traces.length).toBe(traces);
    expect(signatureTraces(st)).toBe(sigs);
    expect(releases(st)).toHaveLength(1);
  });

  it("evidence re-uploaded after the request refuses the submit: the founder signed the old check code", async () => {
    const st = state();
    recordInspection(st, SEEDED_ORDER, E1);
    boundAt(st, 10_000_000n);
    const req = (await ask("MilestoneRelease", SEEDED_ORDER)).body;
    expect(req.typedData.message.evidenceHash).toBe(E1);
    recordInspection(st, SEEDED_ORDER, E2);
    const traces = st.traces.length;
    const refused = await submitWith(call, key, req);
    expect(refused.body.error?.code).toBe("CONFLICT");
    expect(st.traces.length).toBe(traces);
    expect(releases(st)).toEqual([]);
    expect(balanceOf(st, SEEDED_ORDER)?.released).toBe(false);
    // A new request over the evidence recorded now goes through.
    const again = (await ask("MilestoneRelease", SEEDED_ORDER)).body;
    expect(again.typedData.message.evidenceHash).toBe(E2);
    expect((await submitWith(call, key, again)).body.state).toBe("BROADCAST");
  });
});

describe("W-3: a submit's tx is unique across store builds", () => {
  it("the same request and submit on two builds give different txs", async () => {
    const run = async () => {
      resetState(readEnv());
      const k = await enrolFounder(call);
      const req = (await ask("SupplierApproval", "supplier-b")).body;
      const sent = await submitWith(call, k, req);
      expect(sent.body.state).toBe("BROADCAST");
      return { requestId: req.requestId, txHash: sent.body.txHash };
    };
    const first = await run();
    const second = await run();
    expect(second.requestId).toBe(first.requestId);
    expect(first.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(second.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(second.txHash).not.toBe(first.txHash);
  });
});

describe("H-4 (mock): the balance request carries the recorded inspection", () => {
  const create = (orderId: string, idx: number, evidenceHash: string) =>
    call<Exception & Err>("/api/exceptions", json({ kind: "RELEASE_ESCROW_BALANCE", payload: { orderId, idx, evidenceHash }, reason: "Goods checked" }));

  it("refuses a request before any upload, and one whose check code is not the recorded one (CONFLICT)", async () => {
    const st = state();
    const before = st.exceptions.size;
    const noUpload = await create(SEEDED_ORDER, 2, E1);
    expect(noUpload.status).toBe(409);
    expect(noUpload.body.error).toMatchObject({ code: "CONFLICT", message: "Upload the inspection evidence first" });
    recordInspection(st, SEEDED_ORDER, E1);
    const mismatch = await create(SEEDED_ORDER, 2, E2);
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error?.code).toBe("CONFLICT");
    expect(st.exceptions.size).toBe(before);
    const ok = await create(SEEDED_ORDER, 2, E1);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ kind: "RELEASE_ESCROW_BALANCE", status: "OPEN", payload: { evidenceHash: E1 } });
  });

  it("refuses a milestone that does not wait for the founder's release", async () => {
    recordInspection(state(), SEEDED_ORDER, E1);
    expect((await create(SEEDED_ORDER, 7, E1)).body.error?.code).toBe("CONFLICT");
    expect((await create("order-zz-001", 2, E1)).body.error?.code).toBe("CONFLICT");
    expect((await create(SEEDED_ORDER, 1, E1)).body.error?.code).toBe("CONFLICT");
  });

  it("a release with no upload asks for it, even when an open request names a check code (no fallback)", async () => {
    const st = state();
    const seeded = [...st.exceptions.values()].find((s) => s.exception.kind === "RELEASE_ESCROW_BALANCE" && s.exception.payload.orderId === SEEDED_ORDER);
    expect(seeded, "the default seed has a balance request for order-a-001").toBeDefined();
    expect(balanceOf(st, SEEDED_ORDER)?.evidenceHash).toBeUndefined();
    const res = await ask("MilestoneRelease", SEEDED_ORDER);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "CONFLICT", message: "Upload the inspection evidence first" });
  });
});
