/**
 * @hogee/api-mock (P2, task 2.12): the same routes as packages/api, served from fixtures (MOCK_API=1) or from a
 * recorded evidence bundle (REPLAY=<runId>, the offline demo). apps/web/app/api/[...route]/route.ts mounts it.
 * Routes are registered in api-contract `routes` order, so static paths come before the param paths that would
 * shadow them (G0-DECISIONS §4).
 */
import { Hono } from "hono";
import { ROUTE_NAMES, type RouteName } from "@hogee/api-contract";
import { register, type Handler, type Handlers } from "./http";
import { coreHandlers } from "./handlers-core";
import { enrolmentHandlers } from "./founder-enrolment";
import { opsHandlers } from "./handlers-ops";
import { cfoHandlers } from "./features/cfo";
import { orderHandlers } from "./features/orders";
import { searchHandlers } from "./features/search";
import { registerDemoData } from "./demo-data";

// G2: the enrolment wrappers replace handlers-core's passkey entries (and call them).
// VISION-DECISIONS §7: one feature file per chat-first route family (v-search, v-terms, v-cfo fill them in).
const handlers: Handlers = { ...coreHandlers, ...opsHandlers, ...enrolmentHandlers, ...searchHandlers, ...orderHandlers, ...cfoHandlers };

export const app = new Hono().basePath("/api");

// Every evidence response, files and JSON, errors included, is never MIME-sniffed (#6 LOW 6): bundle files are bytes
// from disk. Registered before the routes, so it wraps them.
app.use("/evidence/*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
});

for (const name of ROUTE_NAMES) register(app, name, handlers[name] as Handler<RouteName>);
// UX round 2: the "Sample business" switch, mock-only (not in the contract; the live API has no such path).
registerDemoData(app);

app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: `No route ${c.req.method} ${c.req.path}` } }, 404));
app.onError((err, c) => {
  console.error("[api-mock] unhandled error", err);
  return c.json({ error: { code: "UPSTREAM", message: "api-mock failed to handle the request" } }, 502);
});

export { readEnv } from "./env";
export { seedSources } from "./store";
