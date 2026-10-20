/**
 * Route definition helper and path utilities (project.md §26.6).
 * A route is plain data: P1's api (Hono), P2's api-mock (Hono) and the typed client all read the same object.
 */
import type { z } from "zod";
import { API_ERROR_HTTP_STATUS, type ApiErrorCode, type Persona } from "@hogee/core";

export type HttpMethod = "GET" | "POST";

export interface RouteReqSchemas {
  /** Path params, e.g. { id } for /api/payments/:id. */
  readonly params?: z.ZodType;
  /** Query string; every value arrives as a string. Unknown keys are stripped, not rejected. */
  readonly query?: z.ZodType;
  /** JSON body (or the raw string for rawBody routes, or form fields for multipart routes). */
  readonly body?: z.ZodType;
  /** Required request headers (lowercase names). */
  readonly headers?: z.ZodType;
}

export interface RouteDef {
  readonly name: string;
  readonly method: HttpMethod;
  /** Full path including /api. Hono param syntax (`:id`, `:path{.+}`). */
  readonly path: `/api/${string}`;
  readonly summary: string;
  readonly req: RouteReqSchemas;
  /** 2xx response body. For stream routes: the frozen data parts inside the stream. */
  readonly res: z.ZodType;
  /** ApiError codes this route may return (non-2xx bodies are always ApiError). */
  readonly errors: readonly ApiErrorCode[];
  // G0-DECISION: personas allowed to call the route (absent = any). Other personas get 403 FORBIDDEN.
  readonly personas?: readonly Persona[];
  /** 404 NOT_FOUND unless DEMO_MODE=1: /api/demo/*, /api/eval/*, /api/session/persona, /api/proposals/spend. */
  readonly demoOnly?: boolean;
  /** AI SDK UI-message stream response (not JSON). */
  readonly stream?: true;
  /** Body must be read raw (signature verification), not parsed as JSON. */
  readonly rawBody?: true;
  /** multipart/form-data body. */
  readonly multipart?: true;
  /** Response is a raw file, not JSON. */
  readonly fileResponse?: true;
  /** Per-route override of API_ERROR_HTTP_STATUS. */
  readonly errorStatus?: Partial<Record<ApiErrorCode, number>>;
}

/** Identity function that preserves literal types (method, path, schemas, errors). */
export function defineRoute<const R extends RouteDef>(route: R): R {
  return route;
}

type Infer<S> = S extends z.ZodType ? z.input<S> : never;

/** Request parts of a route definition: only the parts it declares. */
export type ReqOf<R extends RouteDef> = { -readonly [K in keyof R["req"]]: Infer<R["req"][K]> };
/** Parsed 2xx response type of a route definition. */
export type ResOf<R extends RouteDef> = z.output<R["res"]>;

/** HTTP status for an ApiError code on a route. */
export function httpStatusFor(route: RouteDef, code: ApiErrorCode): number {
  return route.errorStatus?.[code] ?? API_ERROR_HTTP_STATUS[code];
}

/** Param names in path order, e.g. "/api/evidence/:runId/files/:path{.+}" → ["runId", "path"]. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z][A-Za-z0-9]*)(\{[^}]*\})?/g)].map((m) => m[1] ?? "");
}

/** Path relative to the Hono basePath('/api'): "/api/session" → "/session". */
export function honoPath(route: Pick<RouteDef, "path">): string {
  return route.path.replace(/^\/api(?=\/)/, "");
}

/**
 * Concrete URL path with params substituted and URI-encoded. A regex param such as `:path{.+}` keeps its
 * slashes (each segment encoded separately).
 */
export function buildPath(route: Pick<RouteDef, "path">, params: Readonly<Record<string, string>> = {}): string {
  return route.path.replace(/:([A-Za-z][A-Za-z0-9]*)(\{[^}]*\})?/g, (_m, name: string, regex?: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`buildPath: missing param ${name} for ${route.path}`);
    return regex ? value.split("/").map(encodeURIComponent).join("/") : encodeURIComponent(value);
  });
}
