/**
 * `pnpm dev:live -- --seed-sales <days>` (VISION-DECISIONS v-cfo, ANVIL ONLY): a CFO demo history. Once the founder's
 * plan is committed (SalesOracle reverts StalePlan before it), the launcher records demo sales across <days> chain
 * days through the REAL path: a Stripe-shaped test event signed with this run's own webhook secret → the API's
 * POST /api/webhooks/stripe (signature check, one sale per payment, bucketed) → the worker's oracle key records it on
 * SalesOracle. After each day's sales have landed (Treasury.revenueLedger().salesCount), Anvil's clock moves one day
 * (evm_increaseTime + evm_mine), so the sales sit on different chain days.
 *
 * Labelled "local chain, time-shifted demo history". It refuses any chain that is not a local Anvil (chain id 31337
 * AND an `anvil/` client version) before it sends anything: never Sepolia, never time travel on a public chain.
 */
import { createHmac, randomBytes } from "node:crypto";

export const SEED_LABEL = "local chain, time-shifted demo history";
export const ANVIL_CHAIN_ID = 31_337;
/** At most 21 days: the deployment's judging window and stage-2 deadline are 30 days out, so the demo stays inside. */
export const MAX_SEED_DAYS = 21;
const DAY_SECONDS = 86_400;
/** Whole-BU demo sale amounts in minor units (sales are bucketed to whole BU). */
const AMOUNTS = [3_900, 4_500, 4_200, 5_100, 3_600] as const;

export class SeedSalesRefused extends Error {
  override readonly name = "SeedSalesRefused";
}

export type Rpc = (method: string, params?: readonly unknown[]) => Promise<unknown>;

/** A JSON-RPC caller for `url` (throws on an RPC error). */
export function rpcAt(url: string, fetchFn: typeof fetch = fetch): Rpc {
  return async (method, params = []) => {
    const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (!res.ok || body.error) throw new Error(`${method}: ${body.error?.message ?? `HTTP ${res.status}`}`);
    return body.result;
  };
}

/** Refuses (throws SeedSalesRefused) unless the RPC is a local Anvil: chain id 31337 and an anvil/ client version. */
export async function assertAnvil(rpc: Rpc): Promise<void> {
  const chainId = Number(await rpc("eth_chainId"));
  if (chainId !== ANVIL_CHAIN_ID) throw new SeedSalesRefused(`--seed-sales runs only on a local Anvil chain (chain id ${ANVIL_CHAIN_ID}); this chain is ${chainId}. Nothing was sent.`);
  const client = String(await rpc("web3_clientVersion"));
  if (!/^anvil\//i.test(client)) throw new SeedSalesRefused(`--seed-sales runs only on Anvil; this node reports "${client.slice(0, 40)}". Nothing was sent.`);
}

/** The demo sales per day (minor units): 1 a day rising to 4, deterministic. */
export function salesPlan(days: number): number[][] {
  if (!Number.isInteger(days) || days < 1 || days > MAX_SEED_DAYS) throw new RangeError(`days must be 1..${MAX_SEED_DAYS}`);
  return Array.from({ length: days }, (_, k) => Array.from({ length: 1 + Math.min(3, Math.floor((k * 4) / Math.max(days, 4))) }, (_, j) => AMOUNTS[(k * 2 + j) % AMOUNTS.length] as number));
}

/** A Stripe-shaped test-mode payment_intent.succeeded event for this facility (ids random per sale). */
export function demoSaleEvent(o: { facilityId: string; currency: string; amountMinor: number; nowSeconds: number }): string {
  const hex = randomBytes(12).toString("hex");
  return JSON.stringify({
    id: `evt_seed${hex}`,
    object: "event",
    type: "payment_intent.succeeded",
    livemode: false,
    created: o.nowSeconds,
    data: {
      object: {
        id: `pi_seed${hex}`,
        object: "payment_intent",
        amount: o.amountMinor,
        amount_received: o.amountMinor,
        currency: o.currency.toLowerCase(),
        livemode: false,
        status: "succeeded",
        metadata: { facilityId: o.facilityId },
      },
    },
  });
}

/** `Stripe-Signature` for `raw` as Stripe signs it: t=<unix>,v1=<HMAC-SHA256 of "<t>.<raw>">. */
export function stripeSignature(secret: string, raw: string, t: number): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`, "utf8").digest("hex")}`;
}

export interface SeedDeps {
  readonly rpc: Rpc;
  /** POSTs a raw body to the API path with headers; resolves the HTTP status. */
  readonly post: (path: string, raw: string, headers: Record<string, string>) => Promise<number>;
  /** PlanRegistry.planVersion() > 0. */
  readonly planCommitted: () => Promise<boolean>;
  /** Treasury.revenueLedger().salesCount. */
  readonly salesCount: () => Promise<bigint>;
  readonly webhookSecret: string;
  readonly facilityId: string;
  readonly currency: string;
  readonly say: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly nowSeconds?: () => number;
  /** How long to wait for one day's sales to land (default 180 s). */
  readonly landTimeoutMs?: number;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(what: string, check: () => Promise<boolean>, timeoutMs: number, sleep: (ms: number) => Promise<void>): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(1_000);
  }
}

/** Records `days` days of demo sales on the local chain (see the header). Returns how many sales landed. */
export async function seedSales(d: SeedDeps, days: number): Promise<number> {
  const plan = salesPlan(days);
  const sleep = d.sleep ?? wait;
  const now = d.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  await assertAnvil(d.rpc);
  d.say(`seed-sales waiting for the founder's committed plan (sales revert before it); then ${days} days of demo sales (${SEED_LABEL})`);
  await until("a committed plan", d.planCommitted, Number.MAX_SAFE_INTEGER, (ms) => sleep(ms * 5));
  let expected = await d.salesCount();
  for (const [k, amounts] of plan.entries()) {
    for (const amountMinor of amounts) {
      const raw = demoSaleEvent({ facilityId: d.facilityId, currency: d.currency, amountMinor, nowSeconds: now() });
      const status = await d.post("/api/webhooks/stripe", raw, { "content-type": "application/json", "stripe-signature": stripeSignature(d.webhookSecret, raw, now()) });
      if (status !== 200) throw new Error(`the API refused a demo sale (HTTP ${status})`);
      expected += 1n;
    }
    const target = expected;
    await until(`day ${k + 1}'s sales on-chain`, async () => (await d.salesCount()) >= target, d.landTimeoutMs ?? 180_000, sleep);
    if (k < plan.length - 1) {
      // Anvil only (checked above): move the chain clock one day and mine a block on the new day.
      await d.rpc("evm_increaseTime", [DAY_SECONDS]);
      await d.rpc("evm_mine", []);
    }
    d.say(`seed-sales day ${k + 1}/${days}: ${amounts.length} sale(s) recorded`);
  }
  const total = plan.reduce((n, day) => n + day.length, 0);
  d.say(`seed-sales done: ${total} demo sales over ${days} chain days (${SEED_LABEL})`);
  return total;
}
