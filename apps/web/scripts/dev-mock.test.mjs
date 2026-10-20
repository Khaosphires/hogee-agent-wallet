// dev:mock's demo data (UX round 2): unset, MOCK_SCENARIO is the sample business, so a fresh start is demo-ready.
import { describe, expect, it } from "vitest";
import { defaultScenario, devMockEnv } from "./dev-mock.mjs";

describe("dev:mock demo data", () => {
  it("serves the sample business when MOCK_SCENARIO is unset or blank", () => {
    expect(defaultScenario({})).toBe("lived");
    expect(defaultScenario({ MOCK_SCENARIO: "  " })).toBe("lived");
    expect(devMockEnv({}, () => "x").env.MOCK_SCENARIO).toBe("lived");
  });

  it("keeps an explicit MOCK_SCENARIO (the smoke e2e pins default, the journey fresh)", () => {
    for (const s of ["default", "fresh", "lived"]) expect(devMockEnv({ MOCK_SCENARIO: s }, () => "x").env.MOCK_SCENARIO).toBe(s);
  });

  it("chooses no sample business for the recorded demo or for Malaysia", () => {
    expect(defaultScenario({ REPLAY: "final-1" })).toBeUndefined();
    expect(defaultScenario({ HOGEE_COUNTRY: "MY" })).toBeUndefined();
    expect(devMockEnv({ REPLAY: "final-1" }, () => "x").env.MOCK_SCENARIO).toBeUndefined();
  });

  it("still forces mock mode and the demo routes, and mints secrets only when missing", () => {
    const { env, printToken } = devMockEnv({ OFFICER_TOKEN: "kept" }, () => "minted");
    expect(env).toMatchObject({ MOCK_API: "1", DEMO_MODE: "1", NEXT_TELEMETRY_DISABLED: "1", OFFICER_TOKEN: "kept", PERSONA_COOKIE_SECRET: "minted" });
    expect(printToken).toBe(false);
    expect(devMockEnv({}, () => "minted").printToken).toBe(true);
  });
});
