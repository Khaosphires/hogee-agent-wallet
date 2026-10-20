/**
 * The demo-data switch ("Sample business", components/settings/demo-data-toggle.tsx; docs/decisions/ux2-demo-data.md):
 * two mock-only routes, outside the api-contract on purpose. The live API (packages/api) has no such path, so in live
 * mode they do not exist (404): the switch can never reset a real facility.
 *   GET  /api/demo/sample-business → { available, on, scenario, used }
 *   POST /api/demo/sample-business, body exactly { "on": boolean } → rebuilds the store as the sample business (on:
 *        MOCK_SCENARIO=lived) or a fresh start (off: fresh), discarding everything done since it was built.
 * Rules (fail closed): DEMO_MODE=1 or 404, as the contract's demo routes; REPLAY refuses (409: the offline demo plays its
 * recording) and so does any demo but Mei's (the sample business is hers); a body that is not exactly {on: boolean}, or
 * over 256 bytes, is 422 and changes nothing. The POST is the loan officer's only, as POST /api/demo/reset (G0-REVIEW
 * M14; run-10 v-5, P1's decision): it rebuilds the same shared store for every viewer, and without a valid officer
 * cookie every caller is the founder (http.ts personaOf), so "either persona" meant anyone who reaches the process.
 * Anyone else gets 403 before the body is read, as register() refuses a persona first. GET stays open: the toggle shows
 * Mei the state, locked. The web's guard (apps/web route.ts rejectUntrustedRequest: Host allow-list, same-origin POST)
 * is in front of it as of every route.
 */
import type { Context, Hono } from "hono";
import { z } from "zod";
import { readEnv } from "./env";
import { personaOf } from "./http";
import { resetState, usedSinceBuilt } from "./store";
import { readyState } from "./scenario-lived/index";

export const DEMO_DATA_PATH = "/demo/sample-business";
const MAX_BODY_BYTES = 256;
const SwitchBody = z.strictObject({ on: z.boolean() });

const refuse = (c: Context, status: 403 | 404 | 409 | 422, code: string, message: string): Response => c.json({ error: { code, message } }, status);

/** Why the switch is not offered here (undefined: it is). */
function unavailable(env: ReturnType<typeof readEnv>): string | undefined {
  if (env.replayRunId !== undefined) return "The recorded demo (REPLAY) plays its recording; the sample business is for practice mode";
  if (env.country !== "SG") return "The sample business is Mei's (HOGEE_COUNTRY=SG)";
  return undefined;
}

async function readSwitch(c: Context): Promise<z.infer<typeof SwitchBody> | undefined> {
  try {
    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return undefined;
    const parsed = SwitchBody.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function registerDemoData(app: Hono): void {
  app.get(DEMO_DATA_PATH, async (c) => {
    const env = readEnv();
    if (!env.demoMode) return refuse(c, 404, "NOT_FOUND", "Demo routes are off (DEMO_MODE=1 enables them)");
    if (unavailable(env)) return c.json({ available: false, on: false, scenario: null, used: false });
    const st = await readyState(env);
    return c.json({ available: true, on: st.scenario === "lived", scenario: st.scenario, used: usedSinceBuilt(st) });
  });

  app.post(DEMO_DATA_PATH, async (c) => {
    const env = readEnv();
    if (!env.demoMode) return refuse(c, 404, "NOT_FOUND", "Demo routes are off (DEMO_MODE=1 enables them)");
    // The verified persona, resolved exactly as every contract route resolves it (register()).
    if (personaOf(c, env) !== "officer") return refuse(c, 403, "FORBIDDEN", "Only the loan officer can switch the demo data");
    const why = unavailable(env);
    if (why) return refuse(c, 409, "CONFLICT", why);
    const body = await readSwitch(c);
    if (!body) return refuse(c, 422, "VALIDATION", 'The body must be exactly {"on": true} or {"on": false}');
    resetState(env, body.on ? "lived" : "fresh");
    const st = await readyState(env);
    return c.json({ ok: true, on: st.scenario === "lived", scenario: st.scenario });
  });
}
