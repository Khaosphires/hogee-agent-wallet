import type { NextConfig } from "next";
import { BASE_CSP } from "./lib/csp";

// G0-AUDIT (v-2): no framing (clickjacking the officer console or the persona switch), no MIME sniffing, and only
// the origin in cross-origin Referers. Applied to every route, /api included. Pages replace BASE_CSP with the nonce
// policy that includes it (proxy.ts, lib/csp.ts: script-src with a per-request nonce, run-9 hardening).
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: BASE_CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  // Workspace packages are consumed as TypeScript source.
  // api-mock serves mock/replay through app/api; verify-evidence runs in the browser (evidence explorer).
  transpilePackages: ["@hogee/core", "@hogee/api-contract", "@hogee/api", "@hogee/api-mock", "@hogee/verify-evidence"],
  // Stop `next dev` from writing apps/web/AGENTS.md: each teammate's AI gets exactly two
  // instruction files, project.md and their role file (project.md §25).
  agentRules: false,
  // No Next.js dev badge in the corner, ever: it would show in the demo video and the judges' screenshots (K16).
  devIndicators: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
