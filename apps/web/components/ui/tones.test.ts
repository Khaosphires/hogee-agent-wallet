import { describe, expect, it } from "vitest";
import { LINE_SLOT } from "../ledger/line-slots";
import { TONE, TONES, isTone, slotTone } from "./tones";

describe("tones", () => {
  it("gives every tone all four forms", () => {
    for (const tone of TONES) {
      const t = TONE[tone];
      expect(t.solid).toMatch(/^bg-/);
      expect(t.tint).toMatch(/^bg-tint-/);
      expect(t.ink).toMatch(/^text-/);
      expect(t.stroke).toMatch(/^stroke-/);
    }
  });

  it("maps every budget line's slot to a tone", () => {
    for (const slot of Object.values(LINE_SLOT)) expect(isTone(slotTone(slot))).toBe(true);
    expect(slotTone(LINE_SLOT.SUPPLIER)).toBe("slot-1");
    expect(slotTone(LINE_SLOT.CONTINGENCY)).toBe("slot-neutral");
  });

  it("keeps cinnabar to the seal tone alone", () => {
    const sealed = TONES.filter((tone) => Object.values(TONE[tone]).some((cls) => /seal/.test(cls)));
    expect(sealed).toEqual(["seal"]);
  });

  it("recognises only known tone names", () => {
    expect(isTone("paid")).toBe(true);
    expect(isTone("slot-6")).toBe(false);
    expect(isTone(3)).toBe(false);
  });
});
