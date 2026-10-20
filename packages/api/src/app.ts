/**
 * The live API (project.md §26.6): `new Hono().basePath('/api')` with every api-contract route registered in
 * contract order (static paths before the param paths that could shadow them). Route handlers live in one file per
 * group under routes/ (1.13 eval and 1.16 evidence included).
 */
import { Hono } from "hono";
import { ROUTE_NAMES, type RouteName } from "@hogee/api-contract";
import type { DepsProvider } from "./context";
import { registerRoutes, type Handler, type Handlers, type RouteGroup } from "./http/register";
import { notImplemented } from "./http/problem";
import { defaultGroups } from "./routes/index";

/** Merges route groups; every contract route must have exactly one handler. */
export function buildHandlers(groups: readonly RouteGroup[]): Handlers {
  const out: Partial<Record<RouteName, Handler<RouteName>>> = {};
  for (const group of groups) {
    for (const [name, handler] of Object.entries(group) as [RouteName, Handler<RouteName>][]) {
      if (out[name]) throw new Error(`route ${name} is handled by two groups`);
      out[name] = handler;
    }
  }
  for (const name of ROUTE_NAMES) {
    out[name] ??= () => {
      throw notImplemented("1.12");
    };
  }
  return out as Handlers;
}

export function createApiApp(provider: DepsProvider, overrides: RouteGroup = {}): Hono {
  const app = new Hono().basePath("/api");
  const handlers = { ...buildHandlers(defaultGroups()), ...overrides } as Handlers;
  // Before deps exist (not configured) errors cannot reach the app logger; they are never echoed to the client.
  const fallbackLog = () => undefined;
  registerRoutes(app, handlers, provider, fallbackLog);
  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: `No route ${c.req.method} ${c.req.path}` } }, 404));
  app.onError((_err, c) => c.json({ error: { code: "UPSTREAM", message: "Internal error" } }, 502));
  return app;
}
