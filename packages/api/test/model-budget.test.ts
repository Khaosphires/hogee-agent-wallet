/**
 * The per-server model-usage budget shared by chat and eval model calls (G0 §9 "still open"): reserve before the call,
 * settle after, a rolling window and a hard total on both calls and characters, fail closed. The AI SDK wiring (the
 * provider-level reservation behind the guard) is in budgeted-models.test.ts.
 */
import { describe, expect, it } from "vitest";
import { BUDGET_BUCKETS, ModelBudget, ModelBudgetExhaustedError, budgetRefusalIn, type ModelBudgetLimits } from "../src/services/model-budget";

const WINDOW = 24_000; // 24 buckets of 1 s
const limits = (over: Partial<ModelBudgetLimits> = {}): ModelBudgetLimits => ({
  windowMs: WINDOW,
  windowCalls: 5,
  windowChars: 1_000_000,
  totalCalls: 100,
  totalChars: 10_000_000,
  outputReserveChars: 100,
  ...over,
});

function clocked(over: Partial<ModelBudgetLimits> = {}) {
  let now = 0;
  const budget = new ModelBudget(limits(over), () => now);
  return { budget, at: (t: number) => void (now = t) };
}

const refusalOf = (fn: () => unknown): ModelBudgetExhaustedError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ModelBudgetExhaustedError) return e;
    throw e;
  }
  throw new Error("expected a budget refusal");
};

describe("ModelBudget: reserve and settle", () => {
  it("reserves the input plus the output allowance, and settles to the measured size", () => {
    const { budget } = clocked();
    const r = budget.reserve(400);
    expect(budget.status().window).toEqual({ calls: 1, chars: 500 });
    r.settle(430);
    expect(budget.status().window).toEqual({ calls: 1, chars: 430 });
    expect(budget.status().total).toEqual({ calls: 1, chars: 430 });
  });

  it("refuses the call past the window's call cap, before it is sent", () => {
    const { budget } = clocked({ windowCalls: 3 });
    for (let i = 0; i < 3; i += 1) budget.reserve(10).settle(10);
    const e = refusalOf(() => budget.reserve(10));
    expect(e.scope).toBe("window");
    expect(e.retryAfterMs).toBeGreaterThan(0);
    expect(budget.status().window.calls).toBe(3); // a refused call counts nothing
  });

  it("refuses the call whose reservation would pass the window's character cap", () => {
    const { budget } = clocked({ windowChars: 1_000 });
    budget.reserve(700); // 800 reserved
    expect(refusalOf(() => budget.reserve(101)).scope).toBe("window"); // 800 + 201 > 1,000
    expect(() => budget.reserve(100)).not.toThrow(); // 800 + 200 = 1,000
  });

  it("a settle that measures less gives the difference back", () => {
    const { budget } = clocked({ windowChars: 1_000 });
    budget.reserve(700).settle(150);
    expect(() => budget.reserve(700)).not.toThrow(); // 150 + 800 ≤ 1,000
  });

  it("settles once: a second settle of the same reservation is ignored", () => {
    const { budget } = clocked();
    const r = budget.reserve(400);
    r.settle(10);
    r.settle(5_000);
    expect(budget.status().total.chars).toBe(10);
  });
});

describe("ModelBudget: concurrency", () => {
  it("concurrent calls reserve before any settles, so they cannot overshoot the cap together", async () => {
    const { budget } = clocked({ windowCalls: 1_000, windowChars: 10 * 600 });
    const results = await Promise.all(
      Array.from({ length: 50 }, async () => {
        try {
          const r = budget.reserve(500);
          await new Promise((res) => setTimeout(res, 5)); // the call is in flight
          r.settle(600);
          return true;
        } catch (e) {
          if (e instanceof ModelBudgetExhaustedError) return false;
          throw e;
        }
      }),
    );
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(budget.status().window.chars).toBeLessThanOrEqual(6_000);
  });
});

describe("ModelBudget: rolling window and hard total", () => {
  it("frees the window once the oldest bucket has left it, and says when", () => {
    const { budget, at } = clocked({ windowCalls: 2 });
    at(0);
    budget.reserve(1).settle(1);
    at(500);
    budget.reserve(1).settle(1);
    at(10_000);
    const e = refusalOf(() => budget.reserve(1));
    const bucketMs = WINDOW / BUDGET_BUCKETS;
    expect(e.retryAfterMs).toBe(bucketMs + WINDOW - 10_000); // bucket [0, 1 s) leaves at 25 s
    at(WINDOW + bucketMs - 1);
    expect(() => budget.reserve(1)).toThrow(ModelBudgetExhaustedError); // still counted: never under-counts
    at(WINDOW + bucketMs);
    expect(() => budget.reserve(1)).not.toThrow();
    expect(budget.status().window.calls).toBe(1);
    expect(budget.status().total.calls).toBe(3);
  });

  it("the hard total refuses for good, whatever the window says", () => {
    const { budget, at } = clocked({ windowCalls: 10, totalCalls: 3 });
    for (let i = 0; i < 3; i += 1) budget.reserve(1).settle(1);
    const e = refusalOf(() => budget.reserve(1));
    expect(e.scope).toBe("total");
    expect(e.retryAfterMs).toBeNull();
    at(10 * WINDOW);
    expect(refusalOf(() => budget.reserve(1)).scope).toBe("total");
  });

  it("the hard total also bounds characters", () => {
    const { budget } = clocked({ totalChars: 1_000 });
    budget.reserve(800).settle(900);
    expect(refusalOf(() => budget.reserve(1)).scope).toBe("total");
  });

  it("a settle after the call's bucket left the window adjusts only the total", () => {
    const { budget, at } = clocked();
    at(0);
    const r = budget.reserve(400);
    at(3 * WINDOW);
    r.settle(50);
    expect(budget.status().window).toEqual({ calls: 0, chars: 0 });
    expect(budget.status().total).toEqual({ calls: 1, chars: 50 });
  });

  it("holds a fixed number of buckets however many calls it sees", () => {
    const { budget, at } = clocked({ windowCalls: 1_000_000, totalCalls: 1_000_000 });
    for (let t = 0; t < 10 * WINDOW; t += 37) {
      at(t);
      budget.reserve(1).settle(1);
    }
    expect(budget.bucketCount()).toBeLessThanOrEqual(BUDGET_BUCKETS + 1);
  });
});

describe("ModelBudget: fail closed", () => {
  it("a call that never settles (provider error, abort) keeps its whole reservation", () => {
    const { budget } = clocked();
    budget.reserve(400);
    expect(budget.status().total.chars).toBe(500);
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY, 1.5])("a nonsense measured size (%s) keeps the reservation", (bad) => {
    const { budget } = clocked();
    budget.reserve(400).settle(bad);
    expect(budget.status().total.chars).toBe(500);
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])("a nonsense input size (%s) is refused", (bad) => {
    const { budget } = clocked();
    expect(() => budget.reserve(bad)).toThrow(ModelBudgetExhaustedError);
    expect(budget.status().total.calls).toBe(0);
  });

  it("assertOpen refuses once no call fits, and isOpen says so (health)", () => {
    const { budget } = clocked({ windowCalls: 1 });
    expect(budget.isOpen()).toBe(true);
    budget.assertOpen();
    budget.reserve(1);
    expect(budget.isOpen()).toBe(false);
    expect(() => budget.assertOpen()).toThrow(ModelBudgetExhaustedError);
  });

  it("once a real call no longer fits, the up-front gate refuses until a reservation fits again", () => {
    const { budget, at } = clocked({ windowChars: 1_200, totalChars: 100_000 });
    budget.assertOpen(); // an empty request (100) fits in 1,200
    budget.reserve(300).settle(800); // 800 used
    expect(() => budget.reserve(350)).toThrow(ModelBudgetExhaustedError); // 800 + 450 > 1,200
    expect(() => budget.assertOpen()).toThrow(ModelBudgetExhaustedError); // room for 400, the gate asks for 450
    expect(budget.isOpen()).toBe(false);
    at(WINDOW + WINDOW / BUDGET_BUCKETS);
    budget.assertOpen(); // the window freed the 800
    budget.reserve(10);
    expect(budget.isOpen()).toBe(true);
  });

  it("a refused call larger than any window never closes the gate", () => {
    const { budget } = clocked({ windowChars: 1_200, totalChars: 100_000 });
    expect(() => budget.reserve(5_000)).toThrow(ModelBudgetExhaustedError);
    expect(() => budget.assertOpen()).not.toThrow();
  });

  it("refuses a bad configuration", () => {
    expect(() => new ModelBudget(limits({ windowCalls: 0 }))).toThrow(RangeError);
    expect(() => new ModelBudget(limits({ windowMs: BUDGET_BUCKETS - 1 }))).toThrow(RangeError);
    expect(() => new ModelBudget(limits({ totalChars: Number.NaN }))).toThrow(RangeError);
    expect(() => new ModelBudget(limits({ windowChars: 99 }))).toThrow(RangeError); // below one output allowance
  });

  it("traces the first refusal of an hour only", () => {
    const { budget } = clocked();
    expect([budget.traceRefusal(0), budget.traceRefusal(59 * 60_000), budget.traceRefusal(60 * 60_000)]).toEqual([true, false, true]);
  });
});

describe("budgetRefusalIn", () => {
  const refusal = new ModelBudgetExhaustedError("window", 1_000);

  it("finds the refusal however the AI SDK wrapped it", () => {
    expect(budgetRefusalIn(refusal)).toBe(refusal);
    expect(budgetRefusalIn(new Error("outer", { cause: refusal }))).toBe(refusal);
    const retry = Object.assign(new Error("RetryError"), { errors: [new Error("x"), refusal], lastError: refusal });
    expect(budgetRefusalIn(retry)).toBe(refusal);
  });

  it("is null for anything else, and stops on a cause cycle", () => {
    expect(budgetRefusalIn(new Error("x"))).toBeNull();
    expect(budgetRefusalIn("text")).toBeNull();
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(budgetRefusalIn(a)).toBeNull();
  });
});
