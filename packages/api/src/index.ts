// Real backend (project.md §26.6), mounted by apps/web/app/api/[...route]/route.ts when MOCK_API=0 (task 1.12).
// Evidence (/api/evidence/*, task 1.16): bundles under evidence/, built by evidence/export.ts (also `make evidence`).
import { createApiApp } from "./app";
import { liveProvider } from "./runtime/deps";

// G0-AUDIT (v-2): Host/Origin guard (apps/web mounts it in front of every mode), operator-secret checks and the
// signed persona cookie. P2's api-mock imports these too, so the mock and the live API share one implementation.
export { DEFAULT_ALLOWED_HOSTS, parseAllowedHosts, rejectUntrustedRequest } from "./request-guard";
export { OPERATOR_SECRET_MAX_LENGTH, OPERATOR_SECRET_MIN_LENGTH, isStrongSecret, officerTokenMatches } from "./operator-secrets";
export {
  DEFAULT_PERSONA,
  PERSONA_COOKIE_MAX_TTL_SECONDS,
  PERSONA_COOKIE_OPTIONS,
  parsePersonaCookieSecret,
  signPersonaCookie,
  verifyPersonaCookie,
  type PersonaCookieKeys,
  type SignPersonaCookieOptions,
} from "./persona-cookie";

/**
 * The live API (MOCK_API=0): every api-contract route, central persona / demo / validation rules, deps built from the
 * environment on first use (runtime/deps.ts). Nothing here holds a key: transactions are rows the worker signs.
 */
export const app = createApiApp(liveProvider);

export { createApiApp } from "./app";
// REG-BRIEF (fisco-proof): the mock serves FISCO mirror packs with this exact reader, under its own tenant check.
export { listFiscoPacks, readFiscoAnchor, readFiscoFile, type OwnsSource } from "./evidence/fisco-store";
export type { ApiDeps, DepsProvider } from "./context";
export { hasCompanyDesignator, holderMatchesSeller } from "./services/terms-names";
