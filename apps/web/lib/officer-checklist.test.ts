/** The officer's "Set up Mei" checklist (UX-PLAN D10): each step's state from what the console can read. */
import { describe, expect, it } from "vitest";
import { allDone, currentStep, officerChecklist, setupComplete, stepStateLabel, type ChecklistInput, type StepState } from "./officer-checklist";

const NOW = Date.parse("2026-10-19T06:00:00Z");
const KEY = { credentialId: "WgO2RMabcq1Y8", qx: `0x${"2b".repeat(32)}`, qy: `0x${"e2".repeat(32)}`, createdAt: "2026-10-19T05:58:00Z" } as const;
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const officer = (summary: string, minutes = 1) => ({ actor: "officer", summary, ts: minutesAgo(minutes) });

const FRESH: ChecklistInput = {
  mode: "mock",
  founder: "Mei",
  pendingKey: null,
  plan: null,
  fundedMinor: "0",
  traces: [],
  seen: {},
  nowMs: NOW,
};

const states = (input: Partial<ChecklistInput>): StepState[] => officerChecklist({ ...FRESH, ...input }).map((s) => s.state);
const yours = (input: Partial<ChecklistInput>) => officerChecklist({ ...FRESH, ...input }).filter((s) => s.state === "yours").length;

describe("officerChecklist: the fresh scenario, step by step", () => {
  it("starts with the loan open and the set-up code as the officer's one turn", () => {
    const steps = officerChecklist(FRESH);
    expect(steps.map((s) => [s.n, s.key, s.state])).toEqual([
      [1, "open", "done"],
      [2, "code", "yours"],
      [3, "passkey", "later"],
      [4, "fund", "later"],
    ]);
    expect(steps.map((s) => s.title)).toEqual(["Open the loan", "Give Mei a set-up code", "Approve Mei's passkey", "Add money"]);
    expect(currentStep(steps)?.key).toBe("code");
  });

  it("waits for Mei while the code made here is still valid, then hands the turn back once it runs out", () => {
    expect(states({ seen: { codeExpiresAtMs: NOW + 60_000 } })).toEqual(["done", "waiting", "waiting", "later"]);
    expect(states({ seen: { codeExpiresAtMs: NOW - 1 } })).toEqual(["done", "yours", "later", "later"]);
  });

  it("makes approving the founder's passkey the one turn once it arrives", () => {
    expect(states({ pendingKey: KEY })).toEqual(["done", "done", "yours", "later"]);
    expect(states({ pendingKey: KEY, plan: { status: "PENDING_SIGNATURE", totalMinor: "1000000" } })).toEqual(["done", "done", "yours", "waiting"]);
  });

  it("waits for Mei to sign once Mei's passkey is approved", () => {
    const plan = { status: "PENDING_SIGNATURE", totalMinor: "1000000" } as const;
    expect(states({ seen: { approved: true }, plan })).toEqual(["done", "done", "done", "waiting"]);
    expect(states({ seen: { approved: true }, plan: null })).toEqual(["done", "done", "done", "later"]);
  });

  it("says Saving while Mei's signed plan is on its way, then makes adding money the officer's turn", () => {
    const approved = { seen: { approved: true } };
    expect(states({ ...approved, plan: { status: "SUBMITTED", totalMinor: "1000000" } })[3]).toBe("saving");
    const steps = officerChecklist({ ...FRESH, ...approved, plan: { status: "COMMITTED", totalMinor: "1000000" } });
    expect(steps[3]?.state).toBe("yours");
    expect(steps[3]?.note).toBe("Mei's plan is signed. Add the money, up to 10,000 BU.");
  });

  it("keeps adding money as the turn until the plan total is in, then everything is done", () => {
    const base = { seen: { approved: true }, plan: { status: "COMMITTED", totalMinor: "1000000" } } as const;
    const partly = officerChecklist({ ...FRESH, ...base, fundedMinor: "400000" });
    expect(partly[3]?.state).toBe("yours");
    expect(partly[3]?.note).toBe("Added so far: 4,000 BU of 10,000 BU. Add the rest.");
    const full = officerChecklist({ ...FRESH, ...base, fundedMinor: "1000000" });
    expect(full[3]).toMatchObject({ state: "done", note: "Added 10,000 BU of 10,000 BU." });
    expect(allDone(full)).toBe(true);
    expect(currentStep(full)).toBeUndefined();
  });

  it("never shows more than one 'Your turn' along Mei's journey", () => {
    const plan = (status: "PENDING_SIGNATURE" | "SUBMITTED" | "COMMITTED") => ({ status, totalMinor: "1000000" });
    const journey: Partial<ChecklistInput>[] = [
      {},
      { seen: { codeExpiresAtMs: NOW + 60_000 } },
      { pendingKey: KEY },
      { seen: { approved: true } },
      { seen: { approved: true }, plan: plan("PENDING_SIGNATURE") },
      { seen: { approved: true }, plan: plan("SUBMITTED") },
      { seen: { approved: true }, plan: plan("COMMITTED") },
      { seen: { approved: true }, plan: plan("COMMITTED"), fundedMinor: "1000000" },
    ];
    for (const moment of journey) expect(yours(moment)).toBeLessThanOrEqual(1);
  });
});

describe("officerChecklist: reading the activity record (live and mock wordings)", () => {
  it("counts the passkey as approved from either wording", () => {
    expect(states({ traces: [officer("Loan officer approved the founder's reviewed passkey; registerFounderKey is signed by the demo lender key in the worker")] })[2]).toBe("done");
    expect(states({ traces: [officer("Loan officer registered the founder's passkey on-chain (demo lender key)")] })[2]).toBe("done");
  });

  it("ignores the same words from anyone but the officer", () => {
    expect(states({ traces: [{ actor: "founder", summary: "registered the founder's passkey", ts: minutesAgo(1) }] })[2]).toBe("later");
  });

  it("waits for Mei for 15 minutes after a code, unless a passkey was rejected after it", () => {
    const issued = officer("Loan officer issued a one-time passkey enrolment code for the founder", 5);
    expect(states({ traces: [issued] }).slice(1, 3)).toEqual(["waiting", "waiting"]);
    expect(states({ traces: [officer("Loan officer issued a one-time passkey enrolment code", 16)] })[1]).toBe("yours");
    const rejected = officer("Loan officer rejected the founder's pending passkey; a new enrolment needs a new code", 2);
    expect(states({ traces: [issued, rejected] })[1]).toBe("yours");
  });
});

describe("officerChecklist: opening the loan", () => {
  const LIVE = { mode: "live" } as const;

  it("treats the mock and a replay as open (the seed opens the loan)", () => {
    expect(states({ mode: "mock" })[0]).toBe("done");
    expect(states({ mode: "replay" })[0]).toBe("done");
  });

  it("on the live network, asks the officer to open it until there is evidence, and holds the code step back", () => {
    const steps = officerChecklist({ ...FRESH, ...LIVE });
    expect(steps.map((s) => s.state)).toEqual(["yours", "later", "later", "later"]);
    expect(steps[1]?.note).toBe("After you open the loan.");
  });

  it("on the live network, counts the loan as open from the record, a refused second open, or anything later", () => {
    expect(states({ ...LIVE, traces: [officer("Loan officer opened the facility: cap 1000000 minor, reserve floor 500 bps")] })[0]).toBe("done");
    expect(states({ ...LIVE, seen: { alreadyOpen: true } })[0]).toBe("done");
    expect(states({ ...LIVE, seen: { opened: true } })[0]).toBe("done");
    expect(states({ ...LIVE, pendingKey: KEY })[0]).toBe("done");
    expect(states({ ...LIVE, plan: { status: "COMMITTED", totalMinor: "1" } })[0]).toBe("done");
    expect(states({ ...LIVE, fundedMinor: "1" })[0]).toBe("done");
  });
});

describe("officerChecklist: while loading", () => {
  it("never claims the money step is done before the plan has loaded", () => {
    const steps = officerChecklist({ ...FRESH, plan: undefined, fundedMinor: undefined });
    expect(steps[3]).toMatchObject({ state: "later", note: "Checking the plan…" });
  });

  it("labels each state for the pill, naming who we wait for", () => {
    expect((["done", "yours", "waiting", "saving", "later"] as const).map((s) => stepStateLabel(s, "Mei"))).toEqual([
      "Done",
      "Your turn",
      "Waiting for Mei",
      "Saving",
      "Not yet",
    ]);
  });

  it("names the founder it is given", () => {
    expect(officerChecklist({ ...FRESH, founder: "Rina" })[1]?.title).toBe("Give Rina a set-up code");
  });
});

describe("officerChecklist: the Sample business (mock only; P1, ux3)", () => {
  const LIVED: Partial<ChecklistInput> = { sampleBusiness: true, plan: { status: "COMMITTED", totalMinor: "1000000" }, fundedMinor: "1000000" };

  it("reads the passkey steps as skipped, never done, and the setup as complete", () => {
    const steps = officerChecklist({ ...FRESH, ...LIVED });
    expect(steps.map((s) => s.state)).toEqual(["done", "skipped", "skipped", "done"]);
    expect(steps[1]?.note).toMatch(/^Skipped in the sample business/);
    expect(stepStateLabel("skipped", "Mei")).toBe("Skipped");
    expect(allDone(steps)).toBe(false);
    expect(setupComplete(steps)).toBe(true);
    expect(currentStep(steps)).toBeUndefined();
  });

  it("keeps the real flow when a passkey arrives or a code is out, and outside practice mode", () => {
    expect(states({ ...LIVED, pendingKey: KEY })).toEqual(["done", "done", "yours", "done"]);
    expect(states({ ...LIVED, seen: { codeExpiresAtMs: NOW + 60_000 } })).toEqual(["done", "waiting", "waiting", "done"]);
    expect(states({ ...LIVED, seen: { approved: true } })).toEqual(["done", "done", "done", "done"]);
    for (const mode of ["live", "replay"] as const) {
      expect(states({ ...LIVED, mode, traces: [officer("Loan officer opened the facility")] })).toEqual(["done", "yours", "later", "done"]);
    }
  });

  it("is off unless the sample business is known to be on", () => {
    expect(states({ ...LIVED, sampleBusiness: false })).toEqual(["done", "yours", "later", "done"]);
    expect(states({ ...LIVED, sampleBusiness: undefined })).toEqual(["done", "yours", "later", "done"]);
    expect(setupComplete(officerChecklist({ ...FRESH, ...LIVED, sampleBusiness: false }))).toBe(false);
  });
});
