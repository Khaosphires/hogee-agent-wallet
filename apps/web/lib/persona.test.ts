import { describe, expect, it } from "vitest";
import { MEI_IDS, PERSONAS, RINA_IDS } from "@hogee/core";
import { PERSONA_LABEL, PERSONA_NAME, founderPersonaOf, isFounderPersona, personaOptions } from "./persona";

describe("isFounderPersona", () => {
  it("treats both demo founders as the founder and the officer as not", () => {
    expect(isFounderPersona("founder:rina")).toBe(true);
    expect(isFounderPersona("founder:mei")).toBe(true);
    expect(isFounderPersona("officer")).toBe(false);
    expect(isFounderPersona(undefined)).toBe(false);
  });
});

describe("PERSONA_LABEL", () => {
  it("names each founder first, then the role (REWRITES B36)", () => {
    expect(PERSONA_LABEL["founder:mei"]).toBe("Mei (founder)");
    expect(PERSONA_LABEL["founder:rina"]).toBe("Rina (founder)");
    expect(PERSONA_LABEL.officer).toBe("Loan officer");
  });

  it("labels and names every persona core defines", () => {
    for (const persona of PERSONAS) {
      expect(PERSONA_LABEL[persona]).toMatch(/\S/);
      expect(PERSONA_NAME[persona]).toMatch(/\S/);
    }
  });

  it("gives the Demo button a short name", () => {
    expect(PERSONA_NAME["founder:mei"]).toBe("Mei");
    expect(PERSONA_NAME.officer).toBe("Loan officer");
  });
});

describe("founderPersonaOf", () => {
  it("is the session's own persona when a founder is signed in", () => {
    expect(founderPersonaOf({ persona: "founder:mei", founderId: MEI_IDS.founderId })).toBe("founder:mei");
    expect(founderPersonaOf({ persona: "founder:rina", founderId: RINA_IDS.founderId })).toBe("founder:rina");
  });

  it("names the deployment's founder from founderId while the officer is signed in", () => {
    expect(founderPersonaOf({ persona: "officer", founderId: MEI_IDS.founderId })).toBe("founder:mei");
    expect(founderPersonaOf({ persona: "officer", founderId: RINA_IDS.founderId })).toBe("founder:rina");
  });

  it("guesses no founder for a founderId that is not a demo founder", () => {
    expect(founderPersonaOf({ persona: "officer", founderId: "founder-x" })).toBeUndefined();
  });
});

describe("personaOptions", () => {
  it("offers this deployment's founder, then the officer", () => {
    expect(personaOptions({ persona: "founder:mei", founderId: MEI_IDS.founderId })).toEqual(["founder:mei", "officer"]);
    expect(personaOptions({ persona: "officer", founderId: RINA_IDS.founderId })).toEqual(["founder:rina", "officer"]);
  });

  it("offers only the officer when the founder is unknown", () => {
    expect(personaOptions({ persona: "officer", founderId: "founder-x" })).toEqual(["officer"]);
  });
});
