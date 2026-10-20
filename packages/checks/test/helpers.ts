// Offline test helpers: recorded fixtures (test/fixtures, captured from the live services on 2026-10-18 UTC) and a
// fetch double that records each call. No test reaches the network.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, "..", "..", "..");

export function fixture(path: string): Buffer {
  return readFileSync(join(HERE, "fixtures", path));
}

export interface Call {
  readonly url: URL;
  readonly init: RequestInit;
}

export type Route = (url: URL, init: RequestInit, n: number) => Response | Promise<Response>;

/** A fetch double: `route` answers each call; `calls` records them in order. */
export function fakeFetch(route: Route): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    return route(url, init ?? {}, calls.length);
  };
  return { fetch: f as typeof fetch, calls };
}

export function respond(body: string | Uint8Array, status = 200, contentType = "application/json"): Response {
  return new Response(typeof body === "string" ? body : new Uint8Array(body), { status, headers: { "content-type": contentType } });
}

/** A response that never arrives (until the request's signal aborts). */
export function hang(init: RequestInit): Promise<Response> {
  return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
}

/** Headers sent with a call, as a plain lower-case record. */
export function headersOf(call: Call | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(call?.init.headers).entries());
}

export const noSleep = async (): Promise<void> => undefined;
