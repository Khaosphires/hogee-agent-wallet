/** One group per area; each later task replaces only its own group. */
import type { RouteGroup } from "../http/register";
import { cfoRoutes } from "./cfo";
import { chatRoutes } from "./chat";
import { controlRoutes } from "./control";
import { dashboardRoutes } from "./dashboard";
import { demoRoutes } from "./demo";
import { demoAttackRoutes } from "./demo-attack";
import { demoSaleRoutes } from "./demo-sale";
import { evalRoutes } from "./eval";
import { exceptionRoutes } from "./exceptions";
import { orderRoutes } from "./orders";
import { facilityRoutes } from "./facility";
import { founderKeyRoutes } from "./founder-key";
import { passkeyRoutes } from "./passkey";
import { planRoutes } from "./plans";
import { proposalRoutes } from "./proposals";
import { searchRoutes } from "./search";
import { sessionRoutes } from "./session";
import { signatureRoutes } from "./signatures";
import { supplierRoutes } from "./suppliers";
import { evidenceRoutes } from "./evidence";
import { webhookRoutes } from "./webhooks";

/** A fresh set of groups per app (the officer-attempt limiter, the chat rate limiter and the eval cap are per app instance). */
export function defaultGroups(): RouteGroup[] {
  return [
    sessionRoutes(), chatRoutes(), planRoutes, signatureRoutes, exceptionRoutes, proposalRoutes, controlRoutes, supplierRoutes, dashboardRoutes,
    webhookRoutes, demoSaleRoutes(), demoRoutes, demoAttackRoutes, facilityRoutes, passkeyRoutes, founderKeyRoutes, evalRoutes(), evidenceRoutes,
    // VISION-DECISIONS §7: chat-first groups (v-search, v-terms, v-cfo fill them in).
    searchRoutes(), orderRoutes, cfoRoutes(),
  ];
}
