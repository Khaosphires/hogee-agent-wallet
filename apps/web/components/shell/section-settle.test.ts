/** The section jump's landing rules (UX round 3): when a jump has arrived, when to scroll again, when to highlight. */
import { describe, expect, it } from "vitest";
import { SECTION_FLASH_MS } from "../../lib/sections";
import { FLASH_HOLD_MS, FLASH_OUT_MS, FLASH_TOTAL_MS, SETTLE_CAP_MS, isInPlace, settleStart, settleStep, type SettleSample } from "./section-settle";

const at = (top: number, over: Partial<SettleSample> = {}): SettleSample => ({
  now: 0,
  scrollY: 500,
  maxScrollY: 3000,
  top,
  marginTop: 72,
  scrollEnded: false,
  ...over,
});

describe("the highlight's timing", () => {
  it("holds about 900 ms and fades over about 400 ms, and lib/sections.ts says the same", () => {
    expect(FLASH_HOLD_MS).toBe(900);
    expect(FLASH_OUT_MS).toBe(400);
    expect(SECTION_FLASH_MS).toBe(FLASH_TOTAL_MS);
  });
});

describe("isInPlace", () => {
  it("is in place when its top sits at the scroll margin, within 4 px", () => {
    expect(isInPlace(at(72))).toBe(true);
    expect(isInPlace(at(75))).toBe(true);
    expect(isInPlace(at(80))).toBe(false);
    expect(isInPlace(at(40))).toBe(false);
  });

  it("counts as in place when the page can't scroll any closer (the end below it, the top above it)", () => {
    expect(isInPlace(at(400, { scrollY: 3000 }))).toBe(true);
    expect(isInPlace(at(400, { scrollY: 2990 }))).toBe(false);
    expect(isInPlace(at(10, { scrollY: 0 }))).toBe(true);
  });
});

describe("settleStep", () => {
  const quietMs = 100;

  it("waits while the page is still scrolling", () => {
    let state = settleStart(0, at(900));
    for (let t = 16; t < 400; t += 16) {
      const step = settleStep(state, at(900 - t, { now: t, scrollY: 500 + t }), quietMs);
      expect(step.action).toBe("wait");
      state = step.state;
    }
  });

  it("highlights once the section has landed and the page has been still for the quiet time", () => {
    let state = settleStart(0, at(72));
    let action = "wait";
    let t = 0;
    while (action === "wait" && t < 1000) {
      t += 16;
      const step = settleStep(state, at(72, { now: t }), quietMs);
      state = step.state;
      action = step.action;
    }
    expect(action).toBe("flash");
    expect(t).toBeGreaterThanOrEqual(quietMs);
    expect(t).toBeLessThan(quietMs + 32);
  });

  it("scrolls again when the scroll ended short of the section (the page grew under it, or the scroll was cut off)", () => {
    const state = settleStart(0, at(900));
    const moved = settleStep(state, at(600, { now: 16, scrollY: 800 }), quietMs).state;
    // Stopped 528 px short and still: the scroll has ended (scrollend), so it goes again.
    const step = settleStep(moved, at(600, { now: 200, scrollY: 800, scrollEnded: true }), quietMs);
    expect(step.action).toBe("rescroll");
  });

  it("when the page grows under a scroll on its way, it turns toward the section's new place at once", () => {
    const state = settleStart(0, at(900));
    const moving = settleStep(state, at(800, { now: 100, scrollY: 600 }), quietMs).state;
    // 600 px of data land above the section mid-scroll: no waiting for the scroll to end first.
    expect(settleStep(moving, at(1400, { now: 200, scrollY: 700 }), quietMs).action).toBe("rescroll");
    // A small shift (rounding, a line of text) is not a reason to turn.
    expect(settleStep(moving, at(705, { now: 200, scrollY: 700 }), quietMs).action).toBe("wait");
  });

  it("without scrollend, the 700 ms fallback decides the scroll is over", () => {
    let state = settleStart(0, at(600));
    const actions: string[] = [];
    for (let t = 16; t <= 800; t += 16) {
      const step = settleStep(state, at(600, { now: t }), quietMs);
      state = step.state;
      actions.push(step.action);
      if (step.action !== "wait") break;
    }
    expect(actions.at(-1)).toBe("rescroll");
    expect(actions.length * 16).toBeGreaterThanOrEqual(700);
  });

  it("gives up scrolling at the cap and highlights where it is", () => {
    const state = { ...settleStart(0, at(600)), retries: 1 };
    const step = settleStep(state, at(600, { now: SETTLE_CAP_MS, scrollEnded: true }), quietMs);
    expect(step.action).toBe("flash");
  });

  it("after the highlight, keeps the section in place until the cap, then is done", () => {
    const flashed = { ...settleStart(0, at(72)), flashedAt: 200, stillSince: 200 };
    expect(settleStep(flashed, at(72, { now: 400 }), quietMs).action).toBe("wait");
    // The page grew above it while it glowed: back into place, no second highlight.
    expect(settleStep(flashed, at(300, { now: 600, scrollEnded: true }), quietMs).action).toBe("wait");
    const grown = settleStep(flashed, at(300, { now: 600, scrollEnded: true }), quietMs).state;
    expect(settleStep(grown, at(300, { now: 800, scrollEnded: true }), quietMs).action).toBe("rescroll");
    expect(settleStep(flashed, at(72, { now: SETTLE_CAP_MS + FLASH_TOTAL_MS }), quietMs).action).toBe("done");
  });
});
