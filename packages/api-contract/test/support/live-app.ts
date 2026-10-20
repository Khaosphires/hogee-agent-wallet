/**
 * TEST SUPPORT ONLY: the LIVE @hogee/api app as the contract suite's `app` (HOGEE_API_MOCK=<this file>), on the test
 * Postgres (TEST_DATABASE_URL) and Anvil (TEST_RPC_URL), seeded with the Rina state the route examples refer to
 * (packages/api/test/support/contract-world.ts). POST /api/demo/reset really resets Anvil and the facility; this
 * wrapper then seeds again (same stable ids), so the suite's later negative cases still find their records.
 * Run (from packages/api-contract): HOGEE_API_MOCK=$PWD/test/support/live-app.ts TEST_DATABASE_URL=… TEST_RPC_URL=…
 *   npx vitest run test/contract --testTimeout 300000 --hookTimeout 300000
 */
import { contractWorld } from "../../../api/test/support/contract-world";

const cw = await contractWorld();

export const app = {
  async request(input: string, init?: RequestInit): Promise<Response> {
    const res = await cw.world.app.request(input, init);
    if (input.startsWith("/api/demo/reset") && res.ok) await cw.reseed();
    return res;
  },
};
