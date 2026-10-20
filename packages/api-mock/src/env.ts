/**
 * Environment the mock reads on every request (so a restart is never needed to flip DEMO_MODE in tests).
 * Secrets (OFFICER_TOKEN, PERSONA_COOKIE_SECRET, STRIPE_WEBHOOK_SECRET) are read here and never logged.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAddress, isAddress, isAddressEqual, type Address } from "viem";
import { parsePersonaCookieSecret } from "@hogee/api";
import { parseMockCountry, type MockCountry } from "./profile";

// Same pattern as P1's route.ts: no "..", and it starts with a letter or digit.
const RUN_ID = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_TIMELOCK_SECONDS = 120;

/**
 * MOCK_SCENARIO (VISION-DECISIONS §7): `default` serves today's seeded demo (plan committed, orders, payments, the
 * status gallery); `fresh` serves a founder at the start of the chat journey: no plan, no escrow, no payments,
 * revenue 0, founder key active; `lived` serves the "Sample business" (UX round 2, docs/decisions/ux2-demo-data.md):
 * Mei about three weeks in, built from `fresh` by the mock's own transitions (scenario-lived/). Unset means `default`
 * here; apps/web scripts/dev-mock.mjs starts `lived` when it is unset. Anything else throws (fail closed).
 */
export const MOCK_SCENARIOS = ["default", "fresh", "lived"] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

export function parseMockScenario(raw: string | undefined): MockScenario {
  const value = raw?.trim() || "default";
  if (!(MOCK_SCENARIOS as readonly string[]).includes(value)) throw new Error(`MOCK_SCENARIO must be default, fresh or lived, got "${value}"`);
  return value as MockScenario;
}

export interface MockEnv {
  /** HOGEE_COUNTRY (the API's variable): SG serves Mei (the default), MY serves Rina; anything else throws. */
  readonly country: MockCountry;
  /** MOCK_SCENARIO: default (today's seeded demo), fresh (the start of the chat journey) or lived (the sample business). */
  readonly scenario: MockScenario;
  readonly demoMode: boolean;
  /** REPLAY=<runId>: serve evidence/<runId>/ as the offline demo. */
  readonly replayRunId: string | undefined;
  readonly officerToken: string | undefined;
  /** undefined when unset (outside DEMO_MODE), or when it is invalid (see cookieSecretError). */
  readonly cookieSecret: string | undefined;
  readonly cookieSecretError: string | undefined;
  readonly stripeWebhookSecret: string | undefined;
  readonly timelockSeconds: number;
  readonly repoRoot: string;
  /** Folder holding scenario-rina/, scenario-mei/ (optional) and evidence-sample/ (HOGEE_FIXTURES_DIR; default <repo>/fixtures). */
  readonly fixturesDir: string;
  /**
   * The founder's wallet for MetaMask (ECDSA) signatures (HOGEE_MOCK_OWNER_EOA). Unset by default: Mei and Rina are
   * passkey-only owners (ownerEOA = 0, as in core's MEI_ and RINA_CONSTITUTION_FACILITY), so the chain refuses every
   * ECDSA signature from them and so does the mock.
   */
  readonly ownerEoa: Address | undefined;
  /**
   * Set when HOGEE_MOCK_OWNER_EOA is not an address: wallet signatures are refused with this reason, nothing else
   * fails. A role address is refused the same way, per request (ownerEoaRoleError: the roles live in the store).
   */
  readonly ownerEoaError: string | undefined;
}

/**
 * Why HOGEE_MOCK_OWNER_EOA cannot be the founder's wallet, given the role addresses the mock knows (the lender's and
 * the plans' agent keys; it has no oracle or observer address): PlanRegistry.registerFounderKey refuses an owner that
 * is the lender, the oracle or the observer (InvalidSignature), and the plan constitution an agent key that is the
 * owner's (code 13). As for a malformed value, wallet signatures are then refused with this reason; nothing else fails.
 */
export function ownerEoaRoleError(ownerEoa: Address, roles: readonly string[]): string | undefined {
  const clash = roles.some((role) => isAddress(role, { strict: false }) && isAddressEqual(role, ownerEoa));
  return clash ? "HOGEE_MOCK_OWNER_EOA is the loan officer's or the agent's address, never the founder's wallet, so no wallet can sign" : undefined;
}

let cachedRoot: string | undefined;

/**
 * Walks up from the working directory to the folder holding pnpm-workspace.yaml (the repo root). The fixtures and
 * evidence folders are read at runtime from the local checkout, so Next must not trace them into the build.
 */
export function findRepoRoot(start = process.cwd()): string {
  if (cachedRoot) return cachedRoot;
  let dir = resolve(/*turbopackIgnore: true*/ start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return (cachedRoot = dir);
    const parent = dirname(dir);
    if (parent === dir) return (cachedRoot = resolve(/*turbopackIgnore: true*/ start));
    dir = parent;
  }
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): MockEnv {
  const replay = env.REPLAY?.trim() || undefined;
  if (replay !== undefined && !RUN_ID.test(replay)) throw new Error(`REPLAY must be an evidence run id, got "${replay}"`);
  let cookieSecret: string | undefined;
  let cookieSecretError: string | undefined;
  try {
    cookieSecret = parsePersonaCookieSecret(env);
  } catch (e) {
    cookieSecretError = e instanceof Error ? e.message : String(e);
  }
  const ownerEoaRaw = env.HOGEE_MOCK_OWNER_EOA?.trim() || undefined;
  const ownerEoaValid = ownerEoaRaw !== undefined && isAddress(ownerEoaRaw, { strict: false });
  const timelock = Number(env.DEMO_TIMELOCK_SECONDS ?? DEFAULT_TIMELOCK_SECONDS);
  const repoRoot = findRepoRoot();
  return {
    country: parseMockCountry(env.HOGEE_COUNTRY),
    scenario: parseMockScenario(env.MOCK_SCENARIO),
    demoMode: env.DEMO_MODE?.trim() === "1",
    replayRunId: replay,
    officerToken: env.OFFICER_TOKEN,
    cookieSecret,
    cookieSecretError,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || undefined,
    timelockSeconds: Number.isInteger(timelock) && timelock > 0 ? timelock : DEFAULT_TIMELOCK_SECONDS,
    repoRoot,
    fixturesDir: env.HOGEE_FIXTURES_DIR?.trim() ? resolve(env.HOGEE_FIXTURES_DIR.trim()) : join(repoRoot, "fixtures"),
    ownerEoa: ownerEoaValid ? getAddress(ownerEoaRaw) : undefined,
    ownerEoaError: ownerEoaRaw !== undefined && !ownerEoaValid ? "HOGEE_MOCK_OWNER_EOA is not an address, so no wallet can sign" : undefined,
  };
}
