/**
 * DEMO_MODE routes (officer only): autonomy start/stop and the crash-next-broadcast flag go to the worker's flag
 * table (they can only stop work); reset returns an Anvil world to step 0 (chain snapshot + this facility's rows).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { iTreasuryAbi } from "../../../chain/src/generated";
import { LIVE, LIVE_TIMEOUT_MS, openLive, type Live } from "../support/live";
import { json, openAndRegister } from "../support/steps";
import { newWorld, type World } from "../support/world";
import { z } from "zod";

describe.skipIf(!LIVE)("demo routes (live)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  const flag = async (name: string) => (await live.db.$client.query("select value from hogee_worker.flags where name = $1", [name])).rows[0]?.value;
  beforeAll(async () => {
    live = await openLive();
    w = await newWorld(live);
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.db.$client.query("delete from hogee_worker.flags").catch(() => undefined);
    await live?.close();
  });

  it("autonomy stop/start writes the worker flag (officer only)", async () => {
    expect((await w.founder.post("/api/demo/autonomy/stop")).status).toBe(403);
    expect(await json(await w.officer.post("/api/demo/autonomy/stop"), z.object({ running: z.boolean() }))).toEqual({ running: false });
    expect(await flag("autonomy")).toEqual({ running: false });
    expect(await json(await w.officer.post("/api/demo/autonomy/start"), z.object({ running: z.boolean() }))).toEqual({ running: true });
    expect(await flag("autonomy")).toEqual({ running: true });
  });

  it("arms the crash-after-next-broadcast flag", async () => {
    expect(await json(await w.officer.post("/api/demo/crash-next-broadcast"), z.object({ armed: z.literal(true) }))).toEqual({ armed: true });
    expect(await flag("crash_next_broadcast")).toEqual({ armed: true });
    await live.db.$client.query("delete from hogee_worker.flags where name = 'crash_next_broadcast'");
  });

  it("reset (Anvil only) reverts the chain to before step 0 and clears this facility's rows; step 0 works again", async () => {
    await openAndRegister(w);
    const opened = async () => (await live.client.readContract({ address: w.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: "facility" })).opened;
    expect(await opened()).toBe(true);
    expect(await json(await w.officer.post("/api/demo/reset"), z.object({ ok: z.literal(true) }))).toEqual({ ok: true });
    expect(await opened()).toBe(false);
    const rows = await live.db.$client.query("select (select count(*)::int from facilities where facility_id = $1) as f, (select count(*)::int from chain_actions where facility_id = $1) as a", [w.facilityId]);
    expect(rows.rows[0]).toEqual({ f: 0, a: 0 });
    await openAndRegister(w);
    expect(await opened()).toBe(true);
  });
});
