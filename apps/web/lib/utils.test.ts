/** cn() must know the DESIGN.md type and shadow names, or tailwind-merge drops them as "conflicting colours". */
import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn with the Ledger and Seal theme names", () => {
  it("keeps a theme font size next to a text colour", () => {
    expect(cn("text-ui", "text-primary-foreground")).toBe("text-ui text-primary-foreground");
    expect(cn("text-meta font-medium", "text-ink-3")).toBe("text-meta font-medium text-ink-3");
    for (const size of ["meta", "ui", "chat", "title", "page", "amount", "hero"]) {
      expect(cn(`text-${size}`, "text-ink")).toBe(`text-${size} text-ink`);
    }
  });

  it("keeps the Apple type scale sizes next to a text colour", () => {
    for (const size of ["large-title", "title-1", "title-2", "title-3", "headline", "body", "callout", "subhead", "footnote", "caption", "caption-2"]) {
      expect(cn(`text-${size}`, "text-ink-2")).toBe(`text-${size} text-ink-2`);
    }
    expect(cn("text-headline", "text-footnote")).toBe("text-footnote");
    expect(cn("text-title", "text-title-2")).toBe("text-title-2");
  });

  it("still lets a later font size win over an earlier one", () => {
    expect(cn("text-ui", "text-[13px]")).toBe("text-[13px]");
    expect(cn("text-ui", "text-hero")).toBe("text-hero");
  });

  it("treats shadow-card / -lift / -pop as shadows, not colours", () => {
    expect(cn("shadow-card", "shadow-lift")).toBe("shadow-lift");
    expect(cn("shadow-card", "shadow-ink")).toBe("shadow-card shadow-ink");
  });
});
