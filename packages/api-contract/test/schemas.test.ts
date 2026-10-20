// G0-AUDIT (v-2): the officer persona selects server-held lender-key actions, so minting it needs proof
// (officerToken), and approveFounderKey names the exact credential the officer reviewed.
import { describe, expect, it } from "vitest";
import { PERSONAS, examplePasskeyRegistrationResult, RINA_IDS } from "@hogee/core";
import { ApproveFounderKeyBody, OfficerToken, ROUTE_EXAMPLES, SetPersonaBody, routes } from "../src/index";

const token = "t".repeat(32);
const { credentialId, qx, qy } = examplePasskeyRegistrationResult;
const founderKey = { founderId: RINA_IDS.founderId, credentialId, qx, qy };

describe("OfficerToken", () => {
  it("accepts 32..256 chars only", () => {
    expect(OfficerToken.safeParse("t".repeat(31)).success).toBe(false);
    expect(OfficerToken.safeParse(token).success).toBe(true);
    expect(OfficerToken.safeParse("t".repeat(256)).success).toBe(true);
    expect(OfficerToken.safeParse("t".repeat(257)).success).toBe(false);
  });
});

describe("SetPersonaBody", () => {
  it("founder needs no token", () => {
    expect(SetPersonaBody.safeParse({ persona: "founder:rina" }).success).toBe(true);
  });

  it("officer needs an officerToken", () => {
    expect(SetPersonaBody.safeParse({ persona: "officer" }).success).toBe(false);
    expect(SetPersonaBody.safeParse({ persona: "officer", officerToken: token }).success).toBe(true);
  });

  it("rejects an officer token shorter than 32 chars", () => {
    expect(SetPersonaBody.safeParse({ persona: "officer", officerToken: "t".repeat(31) }).success).toBe(false);
  });

  it("is strict: founder with an extra officerToken, or unknown keys, are rejected", () => {
    expect(SetPersonaBody.safeParse({ persona: "founder:rina", officerToken: token }).success).toBe(false);
    expect(SetPersonaBody.safeParse({ persona: "officer", officerToken: token, admin: true }).success).toBe(false);
  });

  it("covers every core persona and nothing else", () => {
    const ok = (persona: string) =>
      SetPersonaBody.safeParse({ persona }).success || SetPersonaBody.safeParse({ persona, officerToken: token }).success;
    for (const persona of PERSONAS) expect(ok(persona), persona).toBe(true);
    expect(ok("lender")).toBe(false);
  });
});

describe("ApproveFounderKeyBody", () => {
  it("binds the reviewed credential: founderId + credentialId + qx + qy", () => {
    expect(ApproveFounderKeyBody.safeParse(founderKey).success).toBe(true);
    expect(ApproveFounderKeyBody.safeParse({ founderId: RINA_IDS.founderId }).success).toBe(false);
  });

  it("rejects a missing qx, a bad key coordinate and unknown keys", () => {
    const { qx: _qx, ...withoutQx } = founderKey;
    expect(ApproveFounderKeyBody.safeParse(withoutQx).success).toBe(false);
    expect(ApproveFounderKeyBody.safeParse({ ...founderKey, qy: "0x1234" }).success).toBe(false);
    expect(ApproveFounderKeyBody.safeParse({ ...founderKey, onchain: "PENDING_LENDER" }).success).toBe(false);
  });
});

describe("examples and route metadata", () => {
  it("the setPersona and approveFounderKey examples parse", () => {
    expect(SetPersonaBody.safeParse(ROUTE_EXAMPLES.setPersona.req.body).success).toBe(true);
    expect(ApproveFounderKeyBody.safeParse(ROUTE_EXAMPLES.approveFounderKey.req.body).success).toBe(true);
  });

  it("the approveFounderKey example names the core example passkey", () => {
    expect(ROUTE_EXAMPLES.approveFounderKey.req.body).toMatchObject({ credentialId, qx, qy });
  });

  it("setPersona may return FORBIDDEN (wrong officerToken); approveFounderKey may return CONFLICT (credential mismatch)", () => {
    expect(routes.setPersona.errors).toContain("FORBIDDEN");
    expect(routes.approveFounderKey.errors).toContain("CONFLICT");
  });
});
