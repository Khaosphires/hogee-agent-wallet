// The ONLY API file in apps/web (owned by P1; project.md §6.1, §26.7).
// Mode is chosen on the server: REPLAY=<runId> → replay, MOCK_API=1 → mock, MOCK_API=0 → live.
// The client learns the mode from GET /api/session, never from a frontend env flag.
import { handle } from "hono/vercel";
import { app as liveApp, parseAllowedHosts, rejectUntrustedRequest } from "@hogee/api";
import { app as mockApp } from "@hogee/api-mock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Mode = "live" | "mock" | "replay";

// Starts with a letter or digit and never contains "..": REPLAY names a folder under evidence/ (run-1 hardening).
const RUN_ID = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// Fail loudly on anything ambiguous: a typo must never fall through to live mode (G0 review M12).
function resolveMode(env: NodeJS.ProcessEnv): Mode {
  const replay = env.REPLAY?.trim();
  if (replay) {
    if (!RUN_ID.test(replay)) throw new Error(`REPLAY must be an evidence run id, got "${replay}"`);
    // REPLAY serves the mock app; an explicit MOCK_API=0 asks for live: ambiguous, so refuse (run-7 hardening).
    if (env.MOCK_API?.trim() === "0") throw new Error("REPLAY is set together with MOCK_API=0: unset one of them");
    return "replay";
  }
  const mock = (env.MOCK_API ?? "0").trim();
  if (mock === "1") return "mock";
  if (mock === "0") return "live";
  throw new Error(`MOCK_API must be "0" or "1", got "${mock}"`);
}

const mode = resolveMode(process.env);
// G0-AUDIT (v-2): Host allow-list + same-origin check for POSTs in front of /api (DNS rebinding, cross-site POSTs to
// localhost:3000; @hogee/api rejectUntrustedRequest). HOGEE_ALLOWED_HOSTS is comma-separated host[:port]; default
// localhost:3000,127.0.0.1:3000. An invalid entry throws here (fail closed).
const ALLOWED_HOSTS = parseAllowedHosts(process.env.HOGEE_ALLOWED_HOSTS);

// packages/api-mock (P2, task 2.12) serves both mock (MOCK_API=1) and replay (REPLAY=<runId>).
const app = mode === "live" ? liveApp : mockApp;

// G0-AUDIT (v-2): every mode (live, mock, replay) goes through the guard before Hono sees the request.
const handler = handle(app);
const guarded = (req: Request): Response | Promise<Response> => rejectUntrustedRequest(req, ALLOWED_HOSTS) ?? handler(req);

export const GET = guarded;
export const POST = guarded;
