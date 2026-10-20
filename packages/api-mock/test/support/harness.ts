/** Shared test helpers: the mock app called with signed persona cookies, as the web app calls it. */
import { randomBytes } from "node:crypto";
import { PERSONA_COOKIE } from "@hogee/core";
import { readEnv } from "../../src/env";
import { PROFILES, type DemoProfile } from "../../src/profile";

interface App {
  request(input: string, init?: RequestInit): Response | Promise<Response>;
}

export const secret = (): string => randomBytes(32).toString("base64url");

export const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The demo the mock serves now (HOGEE_COUNTRY; SG unless a test stubs it). */
export const profile = (): DemoProfile => PROFILES[readEnv().country];

/** "founder" is the served demo's founder persona (founder:mei for SG, founder:rina for MY). */
export type As = "founder" | "officer";

export function harness(app: App) {
  async function cookie(as: As): Promise<string> {
    const persona = as === "officer" ? "officer" : profile().founderPersona;
    const body = persona === "officer" ? { persona, officerToken: process.env.OFFICER_TOKEN } : { persona };
    const res = await app.request("/api/session/persona", json(body));
    const line = res.headers.getSetCookie().find((c) => c.startsWith(`${PERSONA_COOKIE}=`));
    if (!line) throw new Error(`no cookie for ${persona} (${res.status})`);
    return line.split(";")[0] ?? "";
  }

  async function call<T>(path: string, init: RequestInit = {}, as: As = "founder"): Promise<{ status: number; body: T }> {
    const res = await app.request(path, { ...init, headers: { ...(init.headers ?? {}), cookie: await cookie(as) } });
    return { status: res.status, body: (await res.json()) as T };
  }

  return { cookie, call };
}
