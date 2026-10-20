/** --fresh and --seed-sales (v-cfo): the flags, the Anvil-only guard, the demo sales plan and the seeding loop. */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadLaunchConfig, USAGE } from "../src/config";
import { assertAnvil, demoSaleEvent, MAX_SEED_DAYS, rpcAt, salesPlan, SeedSalesRefused, seedSales, stripeSignature, type Rpc, type SeedDeps } from "../src/seed-sales";

const anvilRpc = (calls: string[] = [], chainId = "0x7a69", client = "anvil/v1.4.0"): Rpc => async (method) => {
  calls.push(method);
  if (method === "eth_chainId") return chainId;
  if (method === "web3_clientVersion") return client;
  return null;
};

describe("flags", () => {
  it("--fresh and --seed-sales <days> are optional; the defaults are unchanged", () => {
    expect(loadLaunchConfig([])).not.toHaveProperty("fresh");
    expect(loadLaunchConfig([])).not.toHaveProperty("seedSalesDays");
    expect(loadLaunchConfig(["--fresh"]).fresh).toBe(true);
    expect(loadLaunchConfig(["--", "--seed-sales", "14"]).seedSalesDays).toBe(14);
    expect(loadLaunchConfig(["--seed-sales=7", "--fresh"])).toMatchObject({ seedSalesDays: 7, fresh: true });
    expect(USAGE).toMatch(/--seed-sales <days>/);
  });

  it("refuses a bad day count, and seeding sales without the facility opened", () => {
    for (const bad of ["0", "22", "-1", "1.5", "two", "014"]) expect(() => loadLaunchConfig(["--seed-sales", bad]), bad).toThrow(/--seed-sales must be/);
    expect(() => loadLaunchConfig(["--seed-sales", "3", "--no-seed"])).toThrow(/drop --no-seed/);
  });
});

describe("assertAnvil: never Sepolia, never a public chain", () => {
  it("passes a local Anvil (chain 31337 and an anvil/ client)", async () => {
    await expect(assertAnvil(anvilRpc())).resolves.toBeUndefined();
  });
  it("refuses Sepolia, mainnet, and a 31337 node that is not Anvil", async () => {
    await expect(assertAnvil(anvilRpc([], "0xaa36a7"))).rejects.toThrow(SeedSalesRefused);
    await expect(assertAnvil(anvilRpc([], "0x1"))).rejects.toThrow(/only on a local Anvil/);
    await expect(assertAnvil(anvilRpc([], "0x7a69", "Geth/v1.14.0"))).rejects.toThrow(/only on Anvil/);
    await expect(assertAnvil(anvilRpc([], "0x7a69", "HardhatNetwork/2.0"))).rejects.toThrow(SeedSalesRefused);
  });
});

describe("the demo sales", () => {
  it("rise from 1 to 4 a day, whole BU, deterministic", () => {
    const plan = salesPlan(14);
    expect(plan).toHaveLength(14);
    expect(plan[0]).toHaveLength(1);
    expect(plan.at(-1)).toHaveLength(4);
    expect(plan.flat().every((a) => a % 100 === 0 && a > 0)).toBe(true);
    expect(salesPlan(14)).toEqual(plan);
    expect(() => salesPlan(0)).toThrow(RangeError);
    expect(() => salesPlan(MAX_SEED_DAYS + 1)).toThrow(RangeError);
  });

  it("are test-mode Stripe events for this facility, signed as Stripe signs them", () => {
    const raw = demoSaleEvent({ facilityId: "fac-mei", currency: "SGD", amountMinor: 3900, nowSeconds: 1_800_000_000 });
    const e = JSON.parse(raw) as { id: string; livemode: boolean; type: string; data: { object: { id: string; currency: string; amount_received: number; metadata: { facilityId: string } } } };
    expect(e).toMatchObject({ type: "payment_intent.succeeded", livemode: false });
    expect(e.id).toMatch(/^evt_[A-Za-z0-9_]+$/);
    expect(e.data.object).toMatchObject({ currency: "sgd", amount_received: 3900, metadata: { facilityId: "fac-mei" } });
    expect(e.data.object.id).toMatch(/^pi_[A-Za-z0-9_]+$/);
    const sig = stripeSignature("whsec_test_secret_value", raw, 1_800_000_000);
    expect(sig).toBe(`t=1800000000,v1=${createHmac("sha256", "whsec_test_secret_value").update(`1800000000.${raw}`).digest("hex")}`);
  });
});

function fakeDeps(over: Partial<SeedDeps> = {}) {
  const calls: string[] = [];
  const posts: { path: string; raw: string; sig: string }[] = [];
  let count = 0n;
  let committed = false;
  let polls = 0;
  const d: SeedDeps = {
    rpc: anvilRpc(calls),
    post: async (path, raw, headers) => {
      posts.push({ path, raw, sig: headers["stripe-signature"] ?? "" });
      count += 1n; // the worker records each sale (instantly here)
      return 200;
    },
    planCommitted: async () => {
      polls += 1;
      committed ||= polls >= 3;
      return committed;
    },
    salesCount: async () => count,
    webhookSecret: "whsec_test_secret_value",
    facilityId: "fac-mei",
    currency: "SGD",
    say: () => undefined,
    sleep: async () => undefined,
    nowSeconds: () => 1_800_000_000,
    ...over,
  };
  return { d, calls, posts };
}

describe("seedSales", () => {
  it("waits for the plan, posts every sale to the webhook, and moves the chain clock one day between days only", async () => {
    const { d, calls, posts } = fakeDeps();
    const total = await seedSales(d, 3);
    expect(total).toBe(salesPlan(3).flat().length);
    expect(posts).toHaveLength(total);
    expect(posts.every((p) => p.path === "/api/webhooks/stripe" && p.sig.startsWith("t=1800000000,v1="))).toBe(true);
    expect(calls.filter((c) => c === "evm_increaseTime")).toHaveLength(2);
    expect(calls.filter((c) => c === "evm_mine")).toHaveLength(2);
    expect(calls.slice(0, 2)).toEqual(["eth_chainId", "web3_clientVersion"]);
  });

  it("refuses a non-Anvil chain before it posts anything or touches the clock", async () => {
    const { d, calls, posts } = fakeDeps({ rpc: anvilRpc([], "0xaa36a7") });
    await expect(seedSales(d, 2)).rejects.toThrow(SeedSalesRefused);
    expect(posts).toEqual([]);
    expect(calls).not.toContain("evm_increaseTime");
  });

  it("stops (never time-travels past) a day whose sales the API refused", async () => {
    const { d, calls } = fakeDeps({ post: async () => 400 });
    await expect(seedSales(d, 2)).rejects.toThrow(/refused a demo sale/);
    expect(calls).not.toContain("evm_increaseTime");
  });
});

describe.skipIf(!process.env.TEST_RPC_URL)("against a real Anvil (TEST_RPC_URL)", () => {
  it("assertAnvil passes and evm_increaseTime moves the next block a day ahead", async () => {
    const rpc = rpcAt(process.env.TEST_RPC_URL as string);
    await assertAnvil(rpc);
    const before = BigInt(((await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string }).timestamp);
    await rpc("evm_increaseTime", [86_400]);
    await rpc("evm_mine", []);
    const after = BigInt(((await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string }).timestamp);
    expect(after - before).toBeGreaterThanOrEqual(86_400n);
  });
});
