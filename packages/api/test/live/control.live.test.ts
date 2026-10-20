/** POST /api/control/pause: tighten-only and instant for any persona; the worker's agent key (lender fallback) sends it. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChainAction } from "@hogee/core";
import { iTreasuryAbi } from "../../../chain/src/generated";
import { LIVE, LIVE_TIMEOUT_MS, openLive, type Live } from "../support/live";
import { json, openAndRegister } from "../support/steps";
import { newWorld, type World } from "../support/world";

describe.skipIf(!LIVE)("control (live)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  beforeAll(async () => {
    live = await openLive();
    w = await newWorld(live);
    await openAndRegister(w);
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  it("pauses the treasury on-chain; a repeat while pending returns the same action; once paused it is a conflict", async () => {
    const a = await json(await w.founder.post("/api/control/pause"), ChainAction);
    const again = await json(await w.officer.post("/api/control/pause"), ChainAction);
    expect(again.actionId).toBe(a.actionId);
    await w.pump();
    expect(await live.client.readContract({ address: w.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: "paused" })).toBe(true);
    expect((await w.founder.post("/api/control/pause")).status).toBe(409);
  });
});
