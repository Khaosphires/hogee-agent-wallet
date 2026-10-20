/**
 * §26.1 step 0 on Anvil + Postgres: the officer opens and funds the facility; the founder registers a passkey; the
 * officer approves exactly that key; the worker (lender key) puts it on-chain. Hard rule 4: a registration never
 * overwrites a credential, and the approval binds the reviewed {credentialId, qx, qy}.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError, ChainAction, PasskeyRegistrationOptions, PasskeyRegistrationResult, exampleEnrolmentCode } from "@hogee/core";
import { iPlanRegistryAbi, iTreasuryAbi } from "../../src/chain-lib";
import { SoftAuthenticator } from "../support/authenticator";
import { LIVE, LIVE_TIMEOUT_MS, openLive, type Live } from "../support/live";
import { issueEnrolmentCode } from "../support/steps";
import { newWorld, type World } from "../support/world";

const errorOf = async (res: Response) => ApiError.parse(await res.json()).error;

describe.skipIf(!LIVE)("facility and founder key (live)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  beforeAll(async () => {
    live = await openLive();
    w = await newWorld(live);
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  const facilityOnChain = () => live.client.readContract({ address: w.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: "facility" });

  it("passkey registration waits for the facility (409), and so does an enrolment code", async () => {
    const res = await w.founder.post("/api/passkey/register/options", { enrolmentCode: exampleEnrolmentCode });
    expect(res.status).toBe(409);
    expect((await w.officer.post("/api/officer/founder-key/enrolment-code")).status).toBe(409);
  });

  it("the officer opens the facility: rows + an unsigned action for the lender key, nothing signed by the API", async () => {
    const res = await w.officer.post("/api/facility/open", { capMinor: "1000000", reserveFloorBps: 300 });
    expect(res.status).toBe(200);
    const action = ChainAction.parse(await res.json());
    expect(action.state).toBe("PENDING");
    const row = await live.db.$client.query("select kind, raw_signed_tx, request_json from chain_actions where facility_id = $1 and id = $2", [w.facilityId, action.actionId]);
    expect(row.rows[0]).toMatchObject({ kind: "Treasury.openFacility", raw_signed_tx: null });
    expect(w.jobs.map((j) => j.job)).toContain("relay");
    const payees = await live.db.$client.query("select id, status from payees where facility_id = $1 order by id", [w.facilityId]);
    expect(payees.rows.map((r) => r.id)).toEqual(["lhdn-tax", "shopee-ads", "shopee-fees", "spx-logistics"]);
    // A retry of the same request returns the same action; other terms are refused.
    expect(ChainAction.parse(await (await w.officer.post("/api/facility/open", { capMinor: "1000000", reserveFloorBps: 300 })).json()).actionId).toBe(action.actionId);
    expect((await w.officer.post("/api/facility/open", { capMinor: "2000000", reserveFloorBps: 300 })).status).toBe(409);
    await w.pump();
    const f = await facilityOnChain();
    expect(f).toMatchObject({ opened: true, capMinor: 1_000_000n, reserveFloorBps: 300 });
    const opened = await live.db.$client.query("select opened_tx from facilities where facility_id = $1", [w.facilityId]);
    expect(opened.rows[0].opened_tx).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("refuses funding before a plan is committed (Treasury caps funding at the plan total) and queues nothing", async () => {
    const before = await live.db.$client.query(`select count(*)::int as n from chain_actions where facility_id = $1 and kind = 'Treasury.fund'`, [w.facilityId]);
    const res = await w.officer.post("/api/facility/fund", { amountMinor: "400000" });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("CapExceeded");
    const after = await live.db.$client.query(`select count(*)::int as n from chain_actions where facility_id = $1 and kind = 'Treasury.fund'`, [w.facilityId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  let auth: SoftAuthenticator;
  let registered: PasskeyRegistrationResult;

  it("registers the founder's passkey after real WebAuthn checks (PENDING_LENDER)", async () => {
    auth = new SoftAuthenticator();
    const opts = PasskeyRegistrationOptions.parse(await (await w.founder.post("/api/passkey/register/options", { enrolmentCode: await issueEnrolmentCode(w) })).json());
    const res = await w.founder.post("/api/passkey/register/verify", auth.register(opts.challenge));
    expect(res.status).toBe(200);
    registered = PasskeyRegistrationResult.parse(await res.json());
    expect(registered).toEqual({ credentialId: auth.credentialIdB64, qx: auth.qx, qy: auth.qy, onchain: "PENDING_LENDER" });
  });

  it("never overwrites the registered credential (FounderKeyAlreadySet), even with a fresh enrolment code", async () => {
    const attacker = new SoftAuthenticator();
    const opts = PasskeyRegistrationOptions.parse(await (await w.founder.post("/api/passkey/register/options", { enrolmentCode: await issueEnrolmentCode(w) })).json());
    const res = await w.founder.post("/api/passkey/register/verify", attacker.register(opts.challenge));
    expect(res.status).toBe(409);
    // G2: the code is declared on the route now (it used to be rewritten to CONFLICT).
    const err = await errorOf(res);
    expect(err.code).toBe("FounderKeyAlreadySet");
    expect(err.contractError?.name).toBe("FounderKeyAlreadySet");
    const row = await live.db.$client.query("select passkey_credential_id, qx from founders where facility_id = $1 and id = $2", [w.facilityId, w.founderId]);
    expect(row.rows[0]).toEqual({ passkey_credential_id: auth.credentialIdB64, qx: auth.qx });
  });

  it("refuses an approval of any key but the reviewed one (CONFLICT), and of another founder (404)", async () => {
    const other = new SoftAuthenticator();
    const base = { founderId: w.founderId, credentialId: registered.credentialId, qx: registered.qx, qy: registered.qy };
    expect((await w.officer.post("/api/officer/founder-key/approve", { ...base, qx: other.qx, qy: other.qy })).status).toBe(409);
    expect((await w.officer.post("/api/officer/founder-key/approve", { ...base, credentialId: other.credentialIdB64 })).status).toBe(409);
    expect((await w.officer.post("/api/officer/founder-key/approve", { ...base, founderId: "founder-someone-else" })).status).toBe(404);
    expect((await w.founder.post("/api/officer/founder-key/approve", base)).status).toBe(403);
    const n = await live.db.$client.query(`select count(*)::int as n from chain_actions where facility_id = $1 and kind = 'PlanRegistry.registerFounderKey'`, [w.facilityId]);
    expect(n.rows[0].n).toBe(0);
  });

  it("the officer approves exactly the reviewed key; the worker registers it on-chain with the backup EOA", async () => {
    const body = { founderId: w.founderId, credentialId: registered.credentialId, qx: registered.qx, qy: registered.qy };
    const res = await w.officer.post("/api/officer/founder-key/approve", body);
    expect(res.status).toBe(200);
    const first = ChainAction.parse(await res.json());
    expect(ChainAction.parse(await (await w.officer.post("/api/officer/founder-key/approve", body)).json()).actionId).toBe(first.actionId);
    await w.pump();
    const [qx, qy, owner] = await live.client.readContract({ address: w.deployment.contracts.PlanRegistry.address, abi: iPlanRegistryAbi, functionName: "founderKey" });
    expect([qx, qy, owner.toLowerCase()]).toEqual([auth.qx, auth.qy, w.founderWallet.address.toLowerCase()]);
    const row = await live.db.$client.query("select key_status from founders where facility_id = $1 and id = $2", [w.facilityId, w.founderId]);
    expect(row.rows[0].key_status).toBe("REGISTERED");
    const opts = PasskeyRegistrationOptions.parse(await (await w.founder.post("/api/passkey/register/options", { enrolmentCode: await issueEnrolmentCode(w) })).json());
    const again = await w.founder.post("/api/passkey/register/verify", new SoftAuthenticator().register(opts.challenge));
    expect(again.status).toBe(409);
  });
});
