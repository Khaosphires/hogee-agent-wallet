/**
 * Mock parity for security audit run-9 lead 1: the mock screens each priced seller name on its own, like the live API.
 * A name the screen refuses as input (CheckInputError) omits only that listing (NO_SELLER); a list that cannot be read
 * (CheckUnavailableError) still fails the whole search (SANCTIONS_UNAVAILABLE). The screen is wrapped by file, the way
 * features/search.ts imports it.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SupplierSearch } from "@hogee/core";
import { app } from "../src/index";
import { readEnv } from "../src/env";
import { resetState } from "../src/store";
import { SEARCH_DELAY_MS } from "../src/features/search";
import { harness, json, secret } from "./support/harness";

const screen = vi.hoisted(() => ({ listUnavailable: false }));

vi.mock("../../checks/src/sanctions", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../checks/src/sanctions")>();
  const { CheckInputError, CheckUnavailableError } = await import("../../checks/src/types");
  return {
    ...real,
    screenSanctions: async (name: string, opts?: Parameters<typeof real.screenSanctions>[1]) => {
      if (name.startsWith("Yongkang Corvane")) throw new CheckInputError("name has no letters or digits to screen");
      if (screen.listUnavailable) throw new CheckUnavailableError("sanctions list is missing");
      return real.screenSanctions(name, opts);
    },
  };
});

const CORVANE = "supplier-wktbk5xmzmfob";

beforeAll(() => {
  process.env.DEMO_MODE = "1";
  process.env.PERSONA_COOKIE_SECRET = secret();
  process.env.OFFICER_TOKEN = secret();
});

afterEach(() => {
  screen.listUnavailable = false;
  vi.restoreAllMocks();
  resetState(readEnv());
});

const h = harness(app);

async function searchNow(): Promise<SupplierSearch> {
  let now = Date.parse("2026-10-19T09:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const res = await h.call<{ searchId: string }>("/api/suppliers/search", json({ quantity: 1000 }));
  expect(res.status).toBe(200);
  now += SEARCH_DELAY_MS;
  return SupplierSearch.parse((await h.call(`/api/suppliers/search/${res.body.searchId}`)).body);
}

describe("mock web search: sanctions per listing (audit run-9 lead 1)", () => {
  it("a name the screen refuses as input omits only that listing (NO_SELLER); the rest are ranked", async () => {
    const s = await searchNow();
    expect(s).toMatchObject({ status: "READY", failure: null });
    expect(s.candidates.map((c) => c.supplierId)).not.toContain(CORVANE);
    expect(s.candidates).toHaveLength(4);
    expect(s.omitted).toEqual([
      { reason: "OFF_LIST", count: 1 },
      { reason: "NO_SELLER", count: 1 },
    ]);
  });

  it("a list that cannot be read still fails the whole search (SANCTIONS_UNAVAILABLE)", async () => {
    screen.listUnavailable = true;
    const s = await searchNow();
    expect(s).toMatchObject({ status: "FAILED", failure: "SANCTIONS_UNAVAILABLE", candidates: [] });
  });
});
