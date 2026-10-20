/** Session, health and facility (project.md §12.1, §26.6). */
import { z } from "zod";
import { ApiMode, HealthStatus, Persona } from "./enums";
import { Address, Bps, ChainId, CurrencyCode, DeploymentId, Hex32, Id, Minor } from "./primitives";

// G0-DECISION: the demo persona cookie is named `hogee_persona` (values: founder:rina | officer).
// G0-REVIEW (M14): it is an HMAC-signed, httpOnly cookie set only by POST /api/session/persona (DEMO_MODE=1);
// an unsigned or tampered value is ignored (implementation: task 1.12). Clients never write it themselves.
// G0-AUDIT (v-2): the HMAC proves issuance, not identity, so minting the officer persona (which selects server-held
// lender-key actions) requires `officerToken` equal to the operator secret OFFICER_TOKEN (32..256 chars, strength-
// checked, compared in constant time; otherwise 403). One implementation for the live API and the mock: @hogee/api
// signPersonaCookie / verifyPersonaCookie. Value `<persona>.<exp>.<mac>`: exp = unix seconds, ttl ≤ 8 h (default
// 8 h); mac = base64url HMAC-SHA256 over "<persona>|<exp>" with a key derived from PERSONA_COOKIE_SECRET (env,
// required when DEMO_MODE=1, no default) plus sha256(OFFICER_TOKEN) for the officer, so rotating either secret
// revokes cookies. Missing, malformed, forged or expired → founder:rina (the default persona). Attributes: HttpOnly;
// SameSite=Strict; Path=/api; no Domain. A Host/Origin/Sec-Fetch-Site guard (HOGEE_ALLOWED_HOSTS) sits in front of
// /api (apps/web route handler, every mode).
export const PERSONA_COOKIE = "hogee_persona" as const;

export const Session = z.strictObject({
  persona: Persona,
  founderId: Id,
  facilityId: Id,
  mode: ApiMode,
  chainId: ChainId,
  deploymentId: DeploymentId,
});
export type Session = z.infer<typeof Session>;

export const Health = z.strictObject({
  db: HealthStatus,
  chain: HealthStatus,
  presidio: HealthStatus,
  llm: HealthStatus,
  payoutRail: HealthStatus,
});
export type Health = z.infer<typeof Health>;

// G0-DECISION: Facility (fixtures/scenario-rina/facility.json) mirrors the `facilities` table (§12.1)
// plus reserveFloorBps, founderId and chainId. No route returns it directly; mocks seed from it.
export const Facility = z.strictObject({
  facilityId: Id,
  founderId: Id,
  capMinor: Minor,
  currency: CurrencyCode,
  reserveFloorBps: Bps,
  lenderAddress: Address,
  chainId: ChainId,
  deploymentId: DeploymentId,
  openedTx: Hex32.optional(),
});
export type Facility = z.infer<typeof Facility>;
