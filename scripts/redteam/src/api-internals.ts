/**
 * Every deep import into @hogee/api lives here (the package exports only the app), so the coupling is in one place:
 *   - src: the policy world the API decides on, the trace writer, id helpers, the deployment parser, the platform
 *     payee deploy arguments and the evidence exporter (task 1.16), used exactly as the routes use them;
 *   - test/support: the same building blocks the API's live tests use (scripted model behind the REAL guard, a
 *     software WebAuthn authenticator, Stripe-signed test events, the mock country pack and supplier fixtures until
 *     P3 ships data/country-packs and data/suppliers).
 * Nothing here holds a key: role keys are generated at runtime (Anvil) or loaded by the worker's loader (Sepolia).
 */
export { createApiApp } from "../../../packages/api/src/app";
export type { AgentPort, ApiDeps, ApiJob, ChecksPort, OnboardedPayee, RuntimeFlags, Scope, WebSearchPort } from "../../../packages/api/src/context";
export { parseDeploymentJson, type Deployment } from "../../../packages/api/src/deployment";
export { DEFAULT_COUNTRY as API_DEFAULT_COUNTRY } from "../../../packages/api/src/runtime/env";
export { platformPayeeDeployArgs, ALL_DEMO_PAYEES, DEMO_PAYEES, DEMO_PAYEES_BY_COUNTRY, type DemoPayeeCountry } from "../../../packages/api/src/catalog/payees";
export { policyWorld, type PolicyWorld } from "../../../packages/api/src/services/policy-context";
export { appendTrace } from "../../../packages/api/src/services/traces";
export { PROCESS_SEARCH_LIMITS } from "../../../packages/api/src/services/web-search";
export { storeDraft } from "../../../packages/api/src/services/compile";
export { newId, uuidv7 } from "../../../packages/api/src/services/ids";
export { signPersonaCookie } from "../../../packages/api/src/persona-cookie";
export { exportEvidence } from "../../../packages/api/src/evidence/export";

export { scriptedAgent, toolCall, text, regexRedactor, type ScriptedAgent } from "../../../packages/api/test/support/agent";
export { SoftAuthenticator } from "../../../packages/api/test/support/authenticator";
export { testCatalog, testChecks } from "../../../packages/api/test/support/catalog";
export { paymentIntentSucceeded, postStripe, signStripe, stripeEvent } from "../../../packages/api/test/support/stripe";
