/**
 * Singapore on the shared final-1 deployment (SG-DECISIONS): Mei's platform payout hashes are deployed alongside
 * Rina's, so an SG server opens its facility with SGD, an SG founder row and Mei's PayNow payees only, and compiles
 * against it; an MY server is refused on the same facility (fail-opens 2 and 3), and the session reads founder:mei.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError, ChainAction, MEI_IDS, Session } from "@hogee/core";
import { createApiApp } from "../../src/app";
import { DEMO_PAYEES_BY_COUNTRY, payoutHashOf } from "../../src/catalog/payees";
import type { ApiDeps } from "../../src/context";
import { iTreasuryAbi, shortIdToBytes32 } from "../../src/chain-lib";
import { ApiProblem } from "../../src/http/problem";
import { platformPayoutHash } from "../../src/services/chain";
import { compileEnv } from "../../src/services/compile";
import { LIVE, LIVE_TIMEOUT_MS, openLive, type Live } from "../support/live";
import { newWorld, type World } from "../support/world";

describe.skipIf(!LIVE)("an SG facility on the shared deployment (live)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  let sg: ApiDeps;
  const scope = () => ({ facilityId: w.facilityId, founderId: w.founderId });
  const post = (deps: ApiDeps, path: string, body: unknown) =>
    createApiApp(async () => deps, {}).request(path, { method: "POST", headers: { "content-type": "application/json", cookie: w.cookie("officer") }, body: JSON.stringify(body) });

  beforeAll(async () => {
    live = await openLive();
    w = await newWorld(live);
    sg = { ...w.deps, config: { ...w.deps.config, countryCode: "SG", currency: "SGD" }, catalog: { ...w.deps.catalog, payees: async () => DEMO_PAYEES_BY_COUNTRY.SG } };
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  it("deploys Mei's platform payout hashes into the same Treasury as Rina's", async () => {
    for (const p of [...DEMO_PAYEES_BY_COUNTRY.MY, ...DEMO_PAYEES_BY_COUNTRY.SG].filter((x) => x.source === "platform")) {
      expect((await platformPayoutHash(w.deps, shortIdToBytes32(p.payeeId))).toLowerCase(), p.payeeId).toBe(payoutHashOf(p));
    }
  });

  it("an MY server with Mei's payees in its catalog is refused, and writes nothing", async () => {
    const my = { ...w.deps, catalog: { ...w.deps.catalog, payees: async () => DEMO_PAYEES_BY_COUNTRY.SG } };
    const res = await post(my, "/api/facility/open", { capMinor: "1000000", reserveFloorBps: 300 });
    expect(res.status).toBe(502);
    expect(ApiError.parse(await res.json()).error.message).toMatch(/shopee-sg-ads pays out on SG_PAYNOW/);
    expect((await live.db.$client.query("select 1 from facilities where facility_id = $1", [w.facilityId])).rowCount).toBe(0);
  });

  it("the SG server opens with SGD, an SG founder and Mei's PayNow platform payees only", async () => {
    const res = await post(sg, "/api/facility/open", { capMinor: "1000000", reserveFloorBps: 300 });
    expect(res.status).toBe(200);
    ChainAction.parse(await res.json());
    const f = await live.db.$client.query("select currency from facilities where facility_id = $1", [w.facilityId]);
    expect(f.rows[0]).toEqual({ currency: "SGD" });
    const founder = await live.db.$client.query("select country from founders where facility_id = $1 and id = $2", [w.facilityId, w.founderId]);
    expect(founder.rows[0]).toEqual({ country: "SG" });
    const payees = await live.db.$client.query("select id, xendit_account_ref, payout_account_hash from payees where facility_id = $1 order by id", [w.facilityId]);
    expect(payees.rows.map((r) => r.id)).toEqual([MEI_IDS.taxPayeeId, MEI_IDS.adsPayeeId, MEI_IDS.platformFeesPayeeId, MEI_IDS.logisticsPayeeId]);
    for (const r of payees.rows) expect(JSON.parse(r.xendit_account_ref as string).channel, r.id as string).toBe("SG_PAYNOW");
    await w.pump();
    const onChain = await live.client.readContract({ address: w.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: "facility" });
    expect(onChain).toMatchObject({ opened: true, capMinor: 1_000_000n });
  });

  it("compiles for SG against Mei's platform payees, and refuses an MY server on the same facility", async () => {
    const env = await compileEnv(sg, scope(), { firstPlan: true });
    expect(env.facility).toMatchObject({ countryCode: "SG", currency: "SGD" });
    expect(env.facility.payees.map((p) => p.payeeId)).toEqual([MEI_IDS.adsPayeeId, MEI_IDS.platformFeesPayeeId, MEI_IDS.logisticsPayeeId]);
    const refused = await compileEnv(w.deps, scope(), { firstPlan: true }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiProblem);
    expect((refused as ApiProblem).failure).toMatchObject({ code: "CONFLICT" });
    expect((refused as ApiProblem).failure.message).toMatch(/MY \(MYR\), but the facility is SG \(SGD\)/);
  });

  it("reads founder:mei as the SG session's persona, and a Rina cookie as Mei", async () => {
    const app = createApiApp(async () => sg, {});
    expect(Session.parse(await (await app.request("/api/session")).json()).persona).toBe("founder:mei");
    const res = await app.request("/api/session", { headers: { cookie: w.cookie("founder:rina") } });
    expect(Session.parse(await res.json()).persona).toBe("founder:mei");
  });
});
