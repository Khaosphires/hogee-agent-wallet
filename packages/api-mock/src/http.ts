/**
 * Route registration with the contract's rules applied uniformly (api-contract define.ts):
 * demoOnly → 404 unless DEMO_MODE=1; personas → 403; req.params/query/body/headers → 422 VALIDATION;
 * every 2xx body is checked against route.res (a mismatch is a mock bug and answers 502 UPSTREAM loudly).
 */
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { z } from "zod";
import { verifyPersonaCookie } from "@hogee/api";
import { PERSONA_COOKIE, type ApiErrorCode, type Persona } from "@hogee/core";
import { honoPath, httpStatusFor, routes, type RouteDef, type RouteName } from "@hogee/api-contract";
import { readEnv, type MockEnv } from "./env";
import type { MockState } from "./store";
import { readyState } from "./scenario-lived/index";
import { PROFILES } from "./profile";
import { advance } from "./transitions";
import { advanceWebOrders } from "./features/orders";
import { isFailure, type Failure } from "./result";

type Routes = typeof routes;
type ReqSchemas<N extends RouteName> = Routes[N]["req"];
export type ParsedReq<N extends RouteName> = { -readonly [K in keyof ReqSchemas<N>]: ReqSchemas<N>[K] extends z.ZodType ? z.output<ReqSchemas<N>[K]> : never };
type Res<N extends RouteName> = z.input<Routes[N]["res"]>;

export interface HandlerCtx<N extends RouteName> {
  readonly req: ParsedReq<N>;
  readonly persona: Persona;
  readonly env: MockEnv;
  readonly st: MockState;
  readonly c: Context;
}

/** A body, a Failure, or a raw Response (streams, files, Set-Cookie). */
export type HandlerResult<N extends RouteName> = Res<N> | Failure | Response;
export type Handler<N extends RouteName> = (ctx: HandlerCtx<N>) => HandlerResult<N> | Promise<HandlerResult<N>>;
export type Handlers = { readonly [N in RouteName]: Handler<N> };

export function apiError(c: Context, route: RouteDef, f: Failure): Response {
  const status = httpStatusFor(route, f.code);
  const error = {
    code: f.code,
    message: f.message,
    ...(f.details ? { details: f.details } : {}),
    ...(f.contractError ? { contractError: f.contractError } : {}),
    ...(f.traceId ? { traceId: f.traceId } : {}),
  };
  return c.json({ error }, status as 400);
}

/**
 * The verified persona (SG-DECISIONS Q1), with the live API's own verifier given HOGEE_COUNTRY: the officer only with a
 * valid officer cookie; anything else, a valid cookie for the other founder included, is the founder of HOGEE_COUNTRY.
 * The final guard keeps that true even if the shared verifier changes: no other persona ever comes out of here.
 */
export function personaOf(c: Context, env: MockEnv): Persona {
  const founder = PROFILES[env.country].founderPersona;
  if (!env.cookieSecret) return founder;
  const keys = { secret: env.cookieSecret, officerToken: env.officerToken, now: Date.now(), country: env.country };
  return verifyPersonaCookie(getCookie(c, PERSONA_COOKIE), keys) === "officer" ? "officer" : founder;
}

async function readBody(c: Context, route: RouteDef): Promise<unknown> {
  if (route.rawBody) return c.req.text();
  if (route.multipart) {
    const form = await c.req.parseBody();
    return Object.fromEntries(Object.entries(form));
  }
  const text = await c.req.text();
  if (text.trim() === "") return {};
  return JSON.parse(text);
}

const issuesOf = (error: z.ZodError) =>
  error.issues.slice(0, 5).map((i) => ({ path: i.path.map(String).join("."), message: i.message }));

async function parseRequest(c: Context, route: RouteDef): Promise<{ req: Record<string, unknown> } | Failure> {
  const req: Record<string, unknown> = {};
  const parts: [keyof RouteDef["req"], () => unknown | Promise<unknown>][] = [
    ["params", () => c.req.param()],
    ["query", () => c.req.query()],
    ["headers", () => Object.fromEntries([...c.req.raw.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]))],
    ["body", () => readBody(c, route)],
  ];
  for (const [part, read] of parts) {
    const schema = route.req[part];
    if (!schema) continue;
    let raw: unknown;
    try {
      raw = await read();
    } catch {
      return { code: "VALIDATION", message: `${part} is not valid JSON` };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return { code: "VALIDATION", message: `Invalid ${part}`, details: { issues: issuesOf(parsed.error) } };
    req[part] = parsed.data;
  }
  return { req };
}

/** Use the first allowed code for a generic refusal when a route does not declare the preferred one. */
function allowed(route: RouteDef, preferred: ApiErrorCode, fallback: ApiErrorCode): ApiErrorCode {
  return route.errors.includes(preferred) ? preferred : fallback;
}

export function register<N extends RouteName>(app: Hono, name: N, handler: Handler<N>): void {
  const route = routes[name] as RouteDef;
  const method = route.method === "GET" ? "get" : "post";
  app[method](honoPath(route), async (c) => {
    const env = readEnv();
    if (route.demoOnly && !env.demoMode) return apiError(c, route, { code: "NOT_FOUND", message: "Demo routes are off (DEMO_MODE=1 enables them)" });
    const persona = personaOf(c, env);
    if (route.personas && !route.personas.includes(persona)) {
      return apiError(c, route, { code: "FORBIDDEN", message: `${route.method} ${route.path} is for ${route.personas.join(" or ")} only` });
    }
    const parsed = await parseRequest(c, route);
    if (isFailure(parsed)) return apiError(c, route, { ...parsed, code: allowed(route, parsed.code, "NOT_FOUND") });
    // The sample business is built once per store before anything is served (scenario-lived/; other scenarios: at once).
    const st = await readyState(env);
    advance(st);
    // Web orders past cooling are funded on any request, as the live worker funds them on its next pass.
    advanceWebOrders(st);
    const out = await handler({ req: parsed.req as ParsedReq<N>, persona, env, st, c });
    if (out instanceof Response) return out;
    if (isFailure(out)) return apiError(c, route, out);
    const checked = route.res.safeParse(out);
    if (!checked.success) {
      console.error(`[api-mock] ${route.method} ${route.path} produced a body that breaks route.res`, issuesOf(checked.error));
      return c.json({ error: { code: "UPSTREAM", message: "api-mock produced an invalid response (bug in the mock)", details: { issues: issuesOf(checked.error) } } }, 502);
    }
    return c.json(checked.data as object);
  });
}
