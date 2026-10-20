/** The officer's request labels (REWRITES B29–B30) and who may cancel a waiting change (UX-PLAN D21). */
import { describe, expect, it } from "vitest";
import { EXCEPTION_KINDS, EXCEPTION_STATUSES } from "@hogee/core";
import { KIND_LABEL, REQUESTER_LABEL, STATUS_GROUP, STATUS_LABEL, WAIT_NOTE } from "./exception-copy";

describe("WAIT_NOTE", () => {
  it("names who can cancel (the officer and the founder), never anyone", () => {
    expect(WAIT_NOTE).toContain("You or the founder can cancel them during the wait.");
    expect(WAIT_NOTE).not.toMatch(/\banyone\b/i);
    expect(WAIT_NOTE).not.toMatch(/timelock|veto/i);
  });
});

describe("labels", () => {
  it("label every kind and status in plain words", () => {
    for (const k of EXCEPTION_KINDS) expect(KIND_LABEL[k]).toMatch(/\S/);
    for (const s of EXCEPTION_STATUSES) {
      expect(STATUS_LABEL[s]).toMatch(/\S/);
      expect(STATUS_GROUP[s]).toBeDefined();
    }
    const all = [...Object.values(KIND_LABEL), ...Object.values(STATUS_LABEL), ...Object.values(REQUESTER_LABEL)].join(" ");
    expect(all).not.toMatch(/timelock|escalat|payee|\bthe agent\b|veto/i);
  });
});
