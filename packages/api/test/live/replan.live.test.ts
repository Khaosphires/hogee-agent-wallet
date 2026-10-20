/**
 * A founder-only replan through the API (red-team 1.15, T20 finding): v1 committed, supplier A bound since by a
 * signed SupplierApproval, then a day later Rina drafts the same intent again (chat → POST /api/plans/draft), signs
 * the PlanApproval with a passkey and the worker relays commitPlan: v2 is mined with no revert. The compiler keeps
 * the on-chain expiries, stage gate and caps, and lists supplier A on SUPPLIER because the chain counts its signed
 * binding (Treasury.isSignedPayee). A draft that asks for a longer horizon still fails REPLAN_LOOSENS only: it can't be
 * signed alone (409) and routeReplan turns it into EXTEND_EXPIRY requests. Only the model is scripted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlanDraft, PlanRecord, Shortlist, SignatureRequestResponse, constitutionOk, constitutionViolations, examplePlanIntent, exampleShortlistSpec, replanLoosenings, routeReplan } from "@hogee/core";
import { HOGEE_KINDS, buildTighten } from "@hogee/chain";
import { createWalletClient, http, keccak256, parseAbi, toHex, type Hex } from "viem";
import { anvil } from "viem/chains";
import { z } from "zod";
import { iPlanRegistryAbi } from "../../../chain/src/generated";
import { compileEnv, stillCurrent } from "../../src/services/compile";
import { toBytes32 } from "../../src/services/tags";
import { scriptedAgent, type ScriptedAgent } from "../support/agent";
import type { SoftAuthenticator } from "../support/authenticator";
import { DAY, LIVE, LIVE_TIMEOUT_MS, openLive, RPC_URL, warp, type Live } from "../support/live";
import { b64uToBytes, chatToDraft, json, openAndRegister, signPlan } from "../support/steps";
import { newWorld, type World } from "../support/world";

const V1_SESSION = "01a14202-2800-7000-8000-00000000e101";
const V2_SESSION = "01a14202-2800-7000-8000-00000000e102";
const LONGER_SESSION = "01a14202-2800-7000-8000-00000000e103";
const STALE_SESSION = "01a14202-2800-7000-8000-00000000e104";
const signedAbi = parseAbi(["function isSignedPayee(bytes32 lineId, bytes32 payeeId) view returns (bool)"]);

describe.skipIf(!LIVE)("replan through chat → draft → PlanApproval (live)", { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let w: World;
  let agent: ScriptedAgent;
  let auth: SoftAuthenticator;
  let v1: PlanDraft;
  let v2: PlanDraft;
  const scope = () => ({ facilityId: w.facilityId, founderId: w.founderId });
  const registry = () => w.deployment.contracts.PlanRegistry.address;
  const draftOf = async (sessionId: string) => json(await w.founder.post("/api/plans/draft", { sessionId }), PlanDraft);
  const supplierLineId = (d: PlanDraft) => d.manifest.lines.find((l) => l.lineKey === "SUPPLIER")?.lineId as Hex;
  const listedOnChain = async (lineId: Hex) => (await live.client.readContract({ address: registry(), abi: iPlanRegistryAbi, functionName: "line", args: [lineId] })).payeeIds;

  beforeAll(async () => {
    live = await openLive();
    agent = scriptedAgent();
    w = await newWorld(live, { agent, coolingSeconds: 120 });
    auth = await openAndRegister(w);
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  it("v1: chat → draft → passkey → commitPlan", async () => {
    await chatToDraft(w, agent, V1_SESSION);
    v1 = await draftOf(V1_SESSION);
    await signPlan(w, auth, v1.draftId);
    const current = await json(await w.founder.get("/api/plans/current"), PlanRecord);
    expect([current.manifest.version, current.status]).toEqual([1, "COMMITTED"]);
    expect(v1.manifest.lines.find((l) => l.lineKey === "SUPPLIER")?.payeeIds).toEqual([]);
  });

  it("supplier A is bound after v1 by a signed SupplierApproval; v1's SUPPLIER line does not list it", async () => {
    await json(await w.officer.post("/api/facility/fund", { amountMinor: "1000000" }), z.unknown());
    await w.pump();
    const { requestId } = await json(await w.founder.post("/api/suppliers/shortlist", { spec: exampleShortlistSpec }), z.object({ requestId: z.string() }));
    expect((await json(await w.founder.get(`/api/suppliers/shortlist/${requestId}`), Shortlist)).candidates[0]?.supplierId).toBe("supplier-a");
    const req = await json(await w.founder.post("/api/signatures/request", { kind: "SupplierApproval", refId: "order-a-001", method: "passkey" }), SignatureRequestResponse);
    await json(await w.founder.post(`/api/signatures/${req.requestId}/submit`, { passkey: auth.assert(b64uToBytes(req.challengeB64url)) }), z.unknown());
    await w.pump();
    await warp(live, 200n);
    await w.pump();
    const lineId = supplierLineId(v1);
    expect(await live.client.readContract({ address: w.deployment.contracts.Treasury.address, abi: signedAbi, functionName: "isSignedPayee", args: [lineId, toBytes32("supplier-a")] })).toBe(true);
    expect(await listedOnChain(lineId)).toEqual([]);
    const env = await compileEnv(w.deps, scope());
    expect(env.current?.lines.find((l) => l.lineKey === "SUPPLIER")?.payeeIds).toEqual(["supplier-a"]); // the chain's view
    expect(env.currentIntent).toEqual(v1.intent);
  });

  it("the same intent a day later compiles tighten-only: v1's expiries, gate and caps, supplier A listed, every code passes", async () => {
    await warp(live, DAY);
    await chatToDraft(w, agent, V2_SESSION);
    v2 = await draftOf(V2_SESSION);
    expect([v2.manifest.version, v2.manifest.prevPlanHash, v2.manifest.planId]).toEqual([2, (await json(await w.founder.get("/api/plans/current"), PlanRecord)).planHash, v1.manifest.planId]);
    expect(constitutionOk(v2.constitutionReport)).toBe(true);
    const keep = (d: PlanDraft) => ({ agent: d.manifest.agent, stages: d.manifest.stages, lines: d.manifest.lines.map(({ payeeIds: _p, ...l }) => l) });
    expect(keep(v2)).toEqual(keep(v1));
    expect(v2.manifest.lines.find((l) => l.lineKey === "SUPPLIER")?.payeeIds).toEqual(["supplier-a"]);
    const env = await compileEnv(w.deps, scope());
    expect(routeReplan(v2.manifest, env.current as NonNullable<typeof env.current>)).toEqual({ tightenOnly: true, loosens: [], unsupported: [] });
  });

  it("PlanApproval → passkey → relayed commitPlan: v2 is mined with no revert and lists supplier A on-chain", async () => {
    await signPlan(w, auth, v2.draftId);
    const current = await json(await w.founder.get("/api/plans/current"), PlanRecord);
    expect([current.manifest.version, current.status]).toEqual([2, "COMMITTED"]);
    expect(await live.client.readContract({ address: registry(), abi: iPlanRegistryAbi, functionName: "planVersion" })).toBe(2);
    const commits = await live.db.$client.query<{ state: string; tx_hash: Hex | null }>(
      "select state, tx_hash from chain_actions where facility_id = $1 and kind = 'PlanRegistry.commitPlan' order by created_at",
      [w.facilityId],
    );
    expect(commits.rows.map((r) => r.state)).not.toContain("REVERTED");
    const last = commits.rows.at(-1);
    expect(last?.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await live.client.getTransactionReceipt({ hash: last?.tx_hash as Hex })).status).toBe("success");
    expect(await listedOnChain(supplierLineId(v2))).toEqual([toBytes32("supplier-a")]);
  });

  it("a longer horizon still loosens: only REPLAN_LOOSENS, PlanApproval 409, routed to EXTEND_EXPIRY", async () => {
    await chatToDraft(w, agent, LONGER_SESSION, { ...examplePlanIntent, horizonDays: 90 });
    const d = await draftOf(LONGER_SESSION);
    expect(constitutionViolations(d.constitutionReport)).toEqual(["REPLAN_LOOSENS"]);
    expect((await w.founder.post("/api/signatures/request", { kind: "PlanApproval", refId: d.draftId, method: "passkey" })).status).toBe(409);
    const env = await compileEnv(w.deps, scope());
    const route = routeReplan(d.manifest, env.current as NonNullable<typeof env.current>);
    expect(route.unsupported).toEqual([]);
    expect(route.loosens.length).toBeGreaterThan(0);
    expect(route.loosens.every((r) => r.kind === "EXTEND_EXPIRY")).toBe(true);
    expect(d.manifest.lines.every((l) => BigInt(l.validUntil) === BigInt(v1.manifest.lines[0]?.validUntil ?? 0) + 30n * DAY)).toBe(true);
    // A draft that already loosened when compiled is handed out again (it is routed, never signed as is).
    expect((await draftOf(LONGER_SESSION)).draftId).toBe(d.draftId);
  });

  it("a tighten-only draft that a later Treasury-only tighten makes loosening is never offered or signed (audit run-7)", async () => {
    await chatToDraft(w, agent, STALE_SESSION);
    const before = await draftOf(STALE_SESSION);
    expect(constitutionOk(before.constitutionReport)).toBe(true);
    expect((await draftOf(STALE_SESSION)).draftId).toBe(before.draftId); // reused while it is still current
    // The owner lowers ADS's per-payment cap on-chain: an instant tighten that moves no plan version.
    const ads = (await compileEnv(w.deps, scope())).current?.lines.find((l) => l.lineKey === "ADS");
    const lowered = BigInt(ads?.perTxCapMinor ?? "0") - 1n;
    expect(lowered).toBeGreaterThan(0n);
    await live.test.setBalance({ address: w.founderWallet.address, value: 10n ** 19n });
    const owner = createWalletClient({ account: w.founderWallet, chain: anvil, transport: http(RPC_URL) });
    const call = buildTighten({ kind: HOGEE_KINDS.TIGHTEN_LOWER_PER_TX_CAP, target: toHex("ADS", { size: 32 }), newValue: lowered, decisionId: keccak256(toHex("run7-stale-draft")) });
    await live.client.waitForTransactionReceipt({ hash: await owner.sendTransaction({ to: w.deployment.contracts.Treasury.address, data: call.data }) });

    const env = await compileEnv(w.deps, scope());
    expect(BigInt(env.current?.lines.find((l) => l.lineKey === "ADS")?.perTxCapMinor ?? "0")).toBe(lowered);
    expect(replanLoosenings(before.manifest, env.current).length).toBeGreaterThan(0);
    expect(stillCurrent(before, env)).toBe(false);
    expect((await w.founder.post("/api/signatures/request", { kind: "PlanApproval", refId: before.draftId, method: "passkey" })).status).toBe(409);
    expect((await w.founder.post("/api/exceptions", { kind: "REPLAN", payload: { draftId: before.draftId }, reason: "stale" })).status).toBe(409);
    // Drafting again compiles against the tightened state instead of handing out the stale draft.
    const after = await draftOf(STALE_SESSION);
    expect(after.draftId).not.toBe(before.draftId);
    expect(BigInt(after.manifest.lines.find((l) => l.lineKey === "ADS")?.perTxCapMinor ?? "0")).toBeLessThanOrEqual(lowered);
  });
});
