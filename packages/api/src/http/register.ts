/**
 * Central route rules (api-contract define.ts), applied to every route in one place so no handler can forget one:
 *   1. demoOnly → 404 NOT_FOUND unless DEMO_MODE=1;
 *   2. personas → 403 FORBIDDEN (persona from the HMAC-signed cookie only; anything else reads as founder:rina);
 *   3. params / query / headers / body → 422 VALIDATION (declared code; NOT_FOUND where a route declares no VALIDATION);
 *   4. the handler runs with the tenant scope from server config (never from the request);
 *   5. every 2xx JSON body is validated against `route.res` before it leaves (a mismatch is a server bug: 502);
 *   6. failures are normalised to a code the route declares (an undeclared contract error becomes CONFLICT with the
 *      decoded `contractError`), at the route's status for that code.
 */
import type { Context, Hono } from "hono";
import type { z } from "zod";
import { ROUTE_NAMES, honoPath, httpStatusFor, routes, type RouteDef, type RouteName } from "@hogee/api-contract";
import type { ApiErrorCode, Persona } from "@hogee/core";
import type { ApiDeps, DepsProvider, Scope } from "../context";
import { personaOf } from "./persona";
import { isContractError, toFailure, type ApiFailure } from "./problem";

type Routes = typeof routes;
type ReqSchemas<N extends RouteName> = Routes[N]["req"];
export type ParsedReq<N extends RouteName> = {
  -readonly [K in keyof ReqSchemas<N>]: ReqSchemas<N>[K] extends z.ZodType ? z.output<ReqSchemas<N>[K]> : never;
};
export type ResIn<N extends RouteName> = z.input<Routes[N]["res"]>;

export interface HandlerCtx<N extends RouteName> {
  readonly req: ParsedReq<N>;
  readonly persona: Persona;
  readonly deps: ApiDeps;
  readonly scope: Scope;
  readonly c: Context;
}

/** A JSON body, or a raw Response (streams, Set-Cookie flows that build their own response). Failures are thrown. */
export type Handler<N extends RouteName> = (ctx: HandlerCtx<N>) => ResIn<N> | Response | Promise<ResIn<N> | Response>;
export type Handlers = { readonly [N in RouteName]: Handler<N> };
export type RouteGroup = { readonly [N in RouteName]?: Handler<N> };

/** JSON bodies above this are refused before parsing (passkey ceremonies are a few KB; chat ≤ 4,000 chars). */
const MAX_JSON_BYTES = 256 * 1024;
/** Inspection evidence uploads (multipart). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function normalise(route: RouteDef, f: ApiFailure): ApiFailure {
  const declared = (code: ApiErrorCode) => route.errors.includes(code);
  if (declared(f.code) || f.status !== undefined) return f;
  if (isContractError(f.code) && declared("CONFLICT")) {
    return { ...f, code: "CONFLICT", contractError: f.contractError ?? { name: f.code } };
  }
  if (f.code === "VALIDATION" && declared("NOT_FOUND")) return { ...f, code: "NOT_FOUND" };
  return { code: "UPSTREAM", message: f.message, ...(f.traceId ? { traceId: f.traceId } : {}) };
}

export function apiError(c: Context, route: RouteDef, raw: ApiFailure): Response {
  const f = normalise(route, raw);
  const status = f.status ?? httpStatusFor(route, f.code);
  const error = {
    code: f.code,
    message: f.message.slice(0, 1000),
    ...(f.details ? { details: f.details } : {}),
    ...(f.contractError ? { contractError: f.contractError } : {}),
    ...(f.traceId ? { traceId: f.traceId } : {}),
  };
  return c.json({ error }, status as 400);
}

const tooLarge = (c: Context, max: number): boolean => {
  const length = Number(c.req.header("content-length") ?? "0");
  return Number.isFinite(length) && length > max;
};

/**
 * The body's bytes, refused (RangeError) once more than `max` arrive. Content-Length is only a hint: a chunked body
 * has none, so the stream itself is counted and cancelled at max+1 bytes instead of being buffered whole.
 */
export async function readCappedBody(req: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const stream = req.body;
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new RangeError("body too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

const FORM_TYPES = /^(multipart\/form-data|application\/x-www-form-urlencoded)\b/i;

async function readBody(c: Context, route: RouteDef): Promise<unknown> {
  if (route.multipart) {
    if (tooLarge(c, MAX_UPLOAD_BYTES)) throw new RangeError("upload too large");
    const bytes = await readCappedBody(c.req.raw, MAX_UPLOAD_BYTES);
    const type = c.req.header("content-type") ?? "";
    if (!FORM_TYPES.test(type)) return {};
    const form = await new Response(bytes, { headers: { "content-type": type } }).formData();
    return Object.fromEntries(form.entries());
  }
  if (tooLarge(c, MAX_JSON_BYTES)) throw new RangeError("body too large");
  const text = new TextDecoder().decode(await readCappedBody(c.req.raw, MAX_JSON_BYTES));
  if (route.rawBody) return text;
  return text.trim() === "" ? {} : (JSON.parse(text) as unknown);
}

const issuesOf = (error: z.ZodError) => error.issues.slice(0, 5).map((i) => ({ path: i.path.map(String).join("."), message: i.message }));

async function parseRequest(c: Context, route: RouteDef): Promise<{ req: Record<string, unknown> } | ApiFailure> {
  const req: Record<string, unknown> = {};
  const parts: [keyof RouteDef["req"], () => unknown][] = [
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
    } catch (e) {
      return { code: "VALIDATION", message: e instanceof RangeError ? `The request ${part} is too large` : `The request ${part} is not valid JSON` };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return { code: "VALIDATION", message: `Invalid request ${part}`, details: { issues: issuesOf(parsed.error) } };
    req[part] = parsed.data;
  }
  return { req };
}

function register<N extends RouteName>(app: Hono, name: N, handler: Handler<N>, provider: DepsProvider, fallbackLog: (e: unknown) => void): void {
  const route = routes[name] as RouteDef;
  const method = route.method === "GET" ? "get" : "post";
  app[method](honoPath(route), async (c) => {
    let deps: ApiDeps;
    try {
      deps = await provider();
    } catch (error: unknown) {
      return apiError(c, route, toFailure(error, fallbackLog));
    }
    const logError = (e: unknown) => deps.log.error("handler_failed", { route: name, error: e });
    const flags = deps.flags();
    if (route.demoOnly && !flags.demoMode) return apiError(c, route, { code: "NOT_FOUND", message: "Demo routes are off (DEMO_MODE=1 enables them)" });
    const persona = personaOf(c, flags, deps.clock(), deps.config.countryCode);
    if (route.personas && !route.personas.includes(persona)) {
      return apiError(c, route, { code: "FORBIDDEN", message: `${route.method} ${route.path} is for ${route.personas.join(" or ")} only` });
    }
    const parsed = await parseRequest(c, route);
    if ("code" in parsed) return apiError(c, route, parsed);
    const scope: Scope = { facilityId: deps.config.facilityId, founderId: deps.config.founderId };
    let out: unknown;
    try {
      out = await handler({ req: parsed.req as ParsedReq<N>, persona, deps, scope, c });
    } catch (error: unknown) {
      return apiError(c, route, toFailure(error, logError));
    }
    if (out instanceof Response) return out;
    const checked = route.res.safeParse(out);
    if (!checked.success) {
      deps.log.error("response_invalid", { route: name, issues: issuesOf(checked.error) });
      return apiError(c, route, { code: "UPSTREAM", message: "The server produced an invalid response" });
    }
    return c.json(checked.data as object);
  });
}

export function registerRoutes(app: Hono, handlers: Handlers, provider: DepsProvider, fallbackLog: (e: unknown) => void): void {
  for (const name of ROUTE_NAMES) register(app, name, handlers[name] as Handler<typeof name>, provider, fallbackLog);
}
