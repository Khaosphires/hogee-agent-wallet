/** The side nav's section helpers (ux2-nav): hashes, links, and which section the scroll-spy marks. */
import { describe, expect, it } from "vitest";
import {
  PAGE_SECTIONS,
  applyIntersections,
  pickCurrentSection,
  sectionForHash,
  sectionHref,
  sectionIdFromHash,
  sectionsFor,
} from "./sections";

const PLAN = sectionsFor("/plan").map((s) => s.id);
const none = new Set<string>();

describe("PAGE_SECTIONS", () => {
  it("keeps every id unique across pages, in the form the hash parser accepts", () => {
    const ids = Object.values(PAGE_SECTIONS).flatMap((list) => list.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(sectionIdFromHash(`#${id}`)).toBe(id);
  });

  it("has no section list for pages it doesn't name", () => {
    expect(sectionsFor("/chat")).toEqual([]);
    expect(sectionsFor("/plan/")).toEqual([]);
  });
});

describe("sectionIdFromHash", () => {
  it("reads the id after the #", () => {
    expect(sectionIdFromHash("#plan-rules")).toBe("plan-rules");
    expect(sectionIdFromHash("plan-rules")).toBe("plan-rules");
  });

  it("decodes a percent-encoded hash", () => {
    expect(sectionIdFromHash("#plan%2Drules")).toBe("plan-rules");
  });

  it("refuses an empty, malformed or odd hash instead of guessing", () => {
    for (const hash of ["", "#", "# plan", "#plan rules", "#%E0%A4%A", "#1abc", "#-x", "#a<b>", "#a\"b",`#${"a".repeat(81)}`]) {
      expect(sectionIdFromHash(hash)).toBeUndefined();
    }
  });
});

describe("sectionForHash", () => {
  it("finds the page's own section", () => {
    expect(sectionForHash("/plan", "#plan-rules")).toEqual({ id: "plan-rules", label: "Rules" });
    expect(sectionForHash("/dashboard", "#wallet-tax")).toEqual({ id: "wallet-tax", label: "Tax money" });
  });

  it("ignores another page's section, an unknown id, and pages without sections", () => {
    expect(sectionForHash("/dashboard", "#plan-rules")).toBeUndefined();
    expect(sectionForHash("/plan", "#nope")).toBeUndefined();
    expect(sectionForHash("/chat", "#msg-1")).toBeUndefined();
    expect(sectionForHash("/plan", "")).toBeUndefined();
  });
});

describe("sectionHref", () => {
  it("links to the section on its page", () => {
    expect(sectionHref("/plan", "plan-rules")).toBe("/plan#plan-rules");
  });
});

describe("applyIntersections", () => {
  it("adds what came into the band and drops what left it, without touching the old set", () => {
    const before = new Set(["plan-summary"]);
    const after = applyIntersections(before, [
      { id: "plan-summary", isIntersecting: false },
      { id: "plan-pockets", isIntersecting: true },
    ]);
    expect([...after]).toEqual(["plan-pockets"]);
    expect([...before]).toEqual(["plan-summary"]);
  });

  it("returns the same set when nothing changed", () => {
    const before = new Set(["plan-summary"]);
    expect(applyIntersections(before, [{ id: "plan-summary", isIntersecting: true }])).toBe(before);
    expect(applyIntersections(before, [{ id: "plan-rules", isIntersecting: false }])).toBe(before);
  });
});

describe("pickCurrentSection", () => {
  it("marks nothing when no section is on screen", () => {
    expect(pickCurrentSection(PLAN, { inBand: none, inView: none, atEnd: false })).toBeUndefined();
  });

  it("marks the first section, in page order, that crosses the reading band", () => {
    const inView = new Set(["plan-pockets", "plan-safety", "plan-releases"]);
    const inBand = new Set(["plan-pockets", "plan-safety"]);
    expect(pickCurrentSection(PLAN, { inBand, inView, atEnd: false })).toBe("plan-safety");
  });

  it("falls back to the first section on screen while the band is between sections", () => {
    const inView = new Set(["plan-safety", "plan-releases"]);
    expect(pickCurrentSection(PLAN, { inBand: none, inView, atEnd: false })).toBe("plan-safety");
  });

  it("marks the last section on screen at the end of the page (a short last section never reaches the band)", () => {
    const inView = new Set(["plan-rules", "plan-signature"]);
    expect(pickCurrentSection(PLAN, { inBand: new Set(["plan-rules"]), inView, atEnd: true })).toBe("plan-signature");
  });

  it("marks the section just jumped to, even while the page is still scrolling to it", () => {
    const inView = new Set(["plan-releases", "plan-rules", "plan-signature"]);
    const state = { inBand: new Set(["plan-releases"]), inView, atEnd: true, pinned: "plan-rules" };
    expect(pickCurrentSection(PLAN, state)).toBe("plan-rules");
    expect(pickCurrentSection(PLAN, { ...state, inView: new Set(["plan-summary"]) })).toBe("plan-rules");
    expect(pickCurrentSection(PLAN, { ...state, pinned: undefined })).toBe("plan-signature");
  });

  it("ignores ids that aren't this page's sections", () => {
    const inView = new Set(["wallet-sales", "plan-rules"]);
    expect(pickCurrentSection(PLAN, { inBand: new Set(["wallet-sales"]), inView, atEnd: false, pinned: "wallet-sales" })).toBe("plan-rules");
  });
});
