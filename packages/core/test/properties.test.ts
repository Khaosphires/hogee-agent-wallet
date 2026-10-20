/**
 * Property tests (fast-check):
 *   1. any valid intent compiles to a manifest that passes the constitution (or a documented refusal);
 *   2. untrusted values can never select a payee or raise a cap;
 *   3. the compiler is deterministic (same input → same planHash, whatever the key order);
 *   4. money never becomes a float;
 *   5. ownerSpend never counts toward the rolling window (Treasury adds no window entry for it).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CompileError,
  PackFactMissingError,
  TaintError,
  UNTRUSTED_PUBLIC,
  blastRadius,
  capRaiseSink,
  checkConstitution,
  compilePlan,
  computeLandedCost,
  constitutionOk,
  evaluateOwnerSpend,
  evaluateProposal,
  fakeHex32,
  jcs,
  lineCapsWithinConstitution,
  payeeSink,
  planHash,
  projectInFlight,
  trusted,
  untrusted,
  withinBps,
  type CompileInput,
  type LineKey,
  type PlanDraft,
  type PolicyProposal,
  type Trusted,
} from "../src/index";
import { compileInputArb, reverseKeys } from "./fixtures/arbitraries";
import { ctxDay1, ctxWithSupplier, RINA_MANIFEST, withLineState } from "./fixtures/policy-ctx";

const RUNS = { numRuns: 300 };
const ALLOWED_REFUSALS = new Set(["BUDGET_TOO_SMALL", "LICENSING_EXCEEDS_CONTINGENCY"]);

/**
 * The one pack gap the generators reach: TEST_PACK_ID has no electrical approval (LABELING §3.6), so an ID electrical
 * intent fails closed. Any other missing fact would be a compiler bug on these packs.
 */
const isKnownPackGap = (input: CompileInput, e: unknown): boolean =>
  e instanceof PackFactMissingError && input.countryPack.countryCode === "ID" && e.leaves.join(",") === "productApprovals.electrical";

/** Compile, or return the CompileError code for a documented refusal (anything else fails the property). */
function tryCompile(input: CompileInput): PlanDraft | string {
  try {
    return compilePlan(input);
  } catch (e) {
    if (e instanceof CompileError && ALLOWED_REFUSALS.has(e.code)) return e.code;
    if (isKnownPackGap(input, e)) return "PACK_FACT_MISSING";
    throw e;
  }
}

describe("property: every compiled plan satisfies the constitution", () => {
  it("random intents × facilities × registries × commit times", () => {
    let compiled = 0;
    fc.assert(
      fc.property(compileInputArb, (input) => {
        const out = tryCompile(input);
        if (typeof out === "string") return;
        compiled += 1;
        const now = BigInt(input.now as string);
        expect(constitutionOk(out.constitutionReport)).toBe(true);
        expect(checkConstitution(out.manifest, input.facility, now)).toEqual(out.constitutionReport);
        expect(constitutionOk(checkConstitution(out.baseline, input.facility, now))).toBe(true);
        const br = blastRadius(out.manifest, input.facility.payees, now);
        expect(BigInt(br.totalMinor) <= BigInt(out.manifest.stages[0]!.releaseMinor)).toBe(true);
        expect(BigInt(out.blastRadiusMinor)).toBe(BigInt(br.totalMinor));
        const ads = out.manifest.lines.find((l) => l.lineKey === "ADS");
        const pacing = BigInt(ads?.pacing?.amountMinor ?? "0");
        expect((pacing * BigInt(ads!.windowSeconds)) / 86_400n <= BigInt(ads!.windowCapMinor)).toBe(true);
      }),
      RUNS,
    );
    expect(compiled).toBeGreaterThan(RUNS.numRuns / 2);
  });

  it("the percentage test agrees with a divide-first Solidity check", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 128n - 1n }), fc.bigInt({ min: 0n, max: 2n ** 128n - 1n }), fc.constantFrom(2500n, 4000n, 5000n), (part, whole, bps) => {
        expect(withinBps(part, whole, bps)).toBe(part <= (whole * bps) / 10_000n);
      }),
      RUNS,
    );
  });

  it("lowering caps never breaks a plan; one minor above 25% always does", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), fc.bigInt({ min: 0n, max: 10n ** 15n }), (amount, cut) => {
        const perTx = amount / 4n;
        const window = amount / 2n;
        expect(lineCapsWithinConstitution(amount, perTx > cut ? perTx - cut : 0n, window > cut ? window - cut : 0n)).toBe(true);
        expect(lineCapsWithinConstitution(amount, perTx + 1n, window)).toBe(false);
      }),
      RUNS,
    );
  });
});

describe("property: the compiler is deterministic", () => {
  it("same input → same planHash and draft, whatever the key order", () => {
    fc.assert(
      fc.property(compileInputArb, (input) => {
        const a = tryCompile(input);
        const b = tryCompile(reverseKeys(structuredClone(input)));
        if (typeof a === "string") return void expect(b).toBe(a);
        expect(typeof b).toBe("object");
        expect(planHash((b as PlanDraft).manifest)).toBe(planHash(a.manifest));
        expect(jcs(b)).toBe(jcs(a));
      }),
      { numRuns: 150 },
    );
  });
});

describe("property: money never becomes a float", () => {
  const MONEY_KEY = /Minor$|^target$/;
  function walk(v: unknown, key: string, out: string[]): void {
    if (typeof v === "number" && !Number.isInteger(v)) out.push(`${key}: non-integer number ${v}`);
    if (MONEY_KEY.test(key) && !(typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v))) out.push(`${key}: ${JSON.stringify(v)} is not a digit string`);
    if (Array.isArray(v)) v.forEach((x) => walk(x, key, out));
    else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k, out);
  }

  it("compiled drafts: every *Minor is a digit string and no number is fractional", () => {
    fc.assert(
      fc.property(compileInputArb, (input) => {
        const out = tryCompile(input);
        if (typeof out === "string") return;
        const problems: string[] = [];
        walk(out, "", problems);
        expect(problems).toEqual([]);
        expect(() => jcs(out)).not.toThrow();
      }),
      RUNS,
    );
  });

  it("landed cost: digit strings that add up exactly, for any quote and any positive FX rate", () => {
    const fx = (value: number) => ({ value, sourceUrl: "https://example.invalid/fx", retrievedAt: "2026-10-16T02:00:00Z", snippetHash: fakeHex32("prop:fx"), evidence: "tier1" as const, sourceType: "mock" as const });
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        fc.bigInt({ min: 0n, max: 10n ** 6n }),
        fc.double({ min: 1e-6, max: 1e6, noNaN: true }),
        fc.constantFrom("MFN" as const, "FORM_E" as const, "EXEMPT" as const),
        fc.integer({ min: 0, max: 10_000 }),
        (quantity, fob, freight, rate, dutyRoute, bps) => {
          const lc = computeLandedCost({ quantity, fobUnitMinor: String(fob), freightPerUnitMinor: String(freight), fx: fx(rate), dutyRoute, dutyRateBps: bps, dutyBase: "CIF", importTaxRateBps: bps });
          const parts = [lc.cifMinor, lc.dutyMinor, lc.sstMinor, lc.feesMinor];
          for (const p of [...parts, lc.totalMinor]) expect(p).toMatch(/^(0|[1-9][0-9]*)$/);
          expect(BigInt(lc.totalMinor)).toBe(parts.reduce((s, p) => s + BigInt(p), 0n));
        },
      ),
      RUNS,
    );
  });
});

describe("property: untrusted values never select a payee or raise a cap", () => {
  const lineKeyArb = fc.constantFrom<LineKey>(...RINA_MANIFEST.lines.map((l) => l.lineKey));
  const payeeIdArb = fc.oneof(fc.constantFrom("shopee-ads", "spx-logistics", "shopee-fees", "supplier-a", "printer-kl"), fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/));
  const amountArb = fc.bigInt({ min: 0n, max: 10n ** 7n }).map(String);
  const taintArb = fc.constantFrom({ trust: "trusted", sensitivity: "public" } as const, UNTRUSTED_PUBLIC);

  it("a SPEND whose payee value is untrusted is always DENY", () => {
    fc.assert(
      fc.property(lineKeyArb, payeeIdArb, amountArb, taintArb, fc.subarray(["IMPERATIVE_TEXT", "AMOUNT_MISMATCH"]), fc.nat(5), (lineKey, payeeId, amount, origin, flags, slot) => {
        const p: PolicyProposal = {
          kind: "SPEND",
          origin,
          lineKey: trusted(lineKey, "plan"),
          payeeId: untrusted(payeeId, "reader:email"),
          amountMinor: untrusted(amount, "reader:invoice"),
          invoiceHash: fakeHex32("prop:invoice"),
          intentId: fakeHex32("prop:intent"),
          planVersion: 1,
          basis: slot % 2 === 0 ? { invoiceId: "inv-p", flags } : { pacingSlot: 0 },
        };
        expect(evaluateProposal(p, ctxWithSupplier()).verdict).toBe("DENY");
      }),
      RUNS,
    );
  });

  it("a loosening that carries an untrusted cap, expiry, amount or payee is always DENY", () => {
    const reqArb = fc.oneof(
      fc.record({ kind: fc.constant("RAISE_CAP" as const), lineKey: lineKeyArb, cap: fc.constantFrom("perTx" as const, "window" as const), newCapMinor: amountArb.map((v) => untrusted(v, "web")) }),
      fc.record({ kind: fc.constant("EXTEND_EXPIRY" as const), target: fc.constant("agent" as const), newExpiresAt: amountArb.map((v) => untrusted(v, "web")) }),
      fc.record({ kind: fc.constant("MOVE_POCKETS" as const), fromLineKey: lineKeyArb, toLineKey: lineKeyArb, amountMinor: amountArb.map((v) => untrusted(v, "web")) }),
      fc.record({ kind: fc.constant("ADD_PAYEE" as const), lineKey: lineKeyArb, payeeId: payeeIdArb.map((v) => untrusted(v, "email")) }),
      fc.record({ kind: fc.constant("WITHDRAW_RESERVE" as const), amountMinor: amountArb.map((v) => untrusted(v, "web")), taxPayeeId: payeeIdArb.map((v) => trusted(v, "registry")) }),
    );
    fc.assert(
      fc.property(reqArb, taintArb, (request, origin) => {
        expect(evaluateProposal({ kind: "LOOSEN", origin, request } as PolicyProposal, ctxWithSupplier()).verdict).toBe("DENY");
      }),
      RUNS,
    );
  });

  it("an untrusted value may only ever tighten a cap or raise the reserve, never loosen", () => {
    fc.assert(
      fc.property(fc.constantFrom("LOWER_PER_TX_CAP" as const, "LOWER_WINDOW_CAP" as const, "RAISE_RESERVE_BPS" as const), lineKeyArb, amountArb, (action, lineKey, value) => {
        const ctx = ctxWithSupplier();
        const d = evaluateProposal({ kind: "TIGHTEN", origin: { trust: "trusted", sensitivity: "public" }, action, lineKey: trusted(lineKey, "plan"), newValue: untrusted(value, "reader:invoice") }, ctx);
        if (d.verdict !== "AUTO") return;
        const line = ctx.lines[lineKey]!;
        if (action === "RAISE_RESERVE_BPS") expect(BigInt(value) >= BigInt(ctx.reserveBps)).toBe(true);
        else expect(BigInt(value) <= BigInt(action === "LOWER_PER_TX_CAP" ? line.perTxCapMinor : line.windowCapMinor)).toBe(true);
      }),
      RUNS,
    );
  });

  it("a proposal triggered by untrusted content is never AUTO", () => {
    fc.assert(
      fc.property(lineKeyArb, amountArb, (lineKey, amount) => {
        const ctx = ctxWithSupplier();
        const proposals: PolicyProposal[] = [
          { kind: "SPEND", origin: UNTRUSTED_PUBLIC, lineKey: trusted(lineKey, "plan"), payeeId: trusted("spx-logistics", "db"), amountMinor: trusted(amount, "db"), invoiceHash: fakeHex32("prop:i2"), intentId: fakeHex32("prop:n2"), planVersion: 1, basis: { invoiceId: "i", flags: [] } },
          { kind: "TIGHTEN", origin: UNTRUSTED_PUBLIC, action: "PAUSE" },
          { kind: "FUND_MILESTONE", origin: UNTRUSTED_PUBLIC, orderId: trusted("order-a-001", "db"), idx: 0, amountMinor: trusted(amount, "db"), planVersion: 1 },
        ];
        for (const p of proposals) expect(evaluateProposal(p, ctx).verdict).not.toBe("AUTO");
      }),
      RUNS,
    );
  });

  it("the sinks throw for every untrusted value at run time, whatever a cast claims", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const forged = untrusted(value, "listing") as unknown as Trusted<unknown>;
        expect(() => payeeSink(forged)).toThrow(TaintError);
        expect(() => capRaiseSink(forged)).toThrow(TaintError);
      }),
      RUNS,
    );
  });
});

describe("property: ownerSpend never counts toward the window (TreasuryGovernance.ownerSpend adds no window entry)", () => {
  const minor = (max: bigint) => fc.bigInt({ min: 0n, max });

  it("projectInFlight: owner spends in flight move the line balance, the payee, the totals and the pacing slot, never the window", () => {
    fc.assert(
      fc.property(fc.nat(5), minor(50_000n), fc.nat(5), minor(50_000n), minor(50_000n), (agentSlots, agentMinor, ownerSlots, ownerMinor, other) => {
        const ctx = withLineState(ctxDay1(), "ADS", { windowSpentMinor: "1000", windowLiveSpends: 3, spentMinor: "2000", nextSequence: 4 });
        const agent = { slots: agentSlots, lineMinor: String(agentMinor) };
        const base = projectInFlight(ctx, "ADS", { ...agent, totalMinor: String(agentMinor + other) }, "shopee-ads");
        const owner = { slots: ownerSlots, lineMinor: String(ownerMinor) };
        const both = projectInFlight(ctx, "ADS", { ...agent, owner, totalMinor: String(agentMinor + ownerMinor + other) }, "shopee-ads");
        const [b, o] = [base.lines.ADS!, both.lines.ADS!];
        expect([o.windowSpentMinor, o.windowLiveSpends]).toEqual([b.windowSpentMinor, b.windowLiveSpends]);
        expect(BigInt(o.spentMinor)).toBe(BigInt(b.spentMinor) + ownerMinor);
        expect(o.nextSequence).toBe(b.nextSequence + ownerSlots);
        const paid = (c: typeof ctx) => BigInt(c.payees.find((p) => p.payeeId === "shopee-ads")!.paidMinor);
        expect(paid(both)).toBe(paid(base) + ownerMinor);
        expect(BigInt(both.totalSpentMinor)).toBe(BigInt(base.totalSpentMinor) + ownerMinor);
      }),
      RUNS,
    );
  });

  it("projectInFlight refuses owner spends that the in-flight total does not include", () => {
    expect(() => projectInFlight(ctxDay1(), "ADS", { slots: 0, lineMinor: "0", owner: { slots: 1, lineMinor: "7500" }, totalMinor: "7499" })).toThrow(/inFlight/);
    expect(() => projectInFlight(ctxDay1(), "ADS", { slots: 0, lineMinor: "0", owner: { slots: -1, lineMinor: "0" }, totalMinor: "0" })).toThrow(/inFlight/);
  });

  it("evaluateOwnerSpend: a full window, the live-spend bound and the per-tx cap never change the decision", () => {
    fc.assert(
      fc.property(minor(90_000n), minor(100_000n), fc.integer({ min: 0, max: 64 }), minor(40_000n), (amount, windowSpent, live, perTx) => {
        const p = { lineKey: "LOGISTICS", payeeId: "spx-logistics", amountMinor: String(amount), invoiceHash: fakeHex32("prop:owner:inv"), intentId: fakeHex32("prop:owner:id") } as const;
        const busy = withLineState(ctxDay1(), "LOGISTICS", { windowSpentMinor: String(windowSpent), windowLiveSpends: live, perTxCapMinor: String(perTx) });
        expect(evaluateOwnerSpend(p, busy)).toEqual(evaluateOwnerSpend(p, ctxDay1()));
      }),
      RUNS,
    );
  });
});
