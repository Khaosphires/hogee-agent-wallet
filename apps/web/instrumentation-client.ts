import { z } from "zod";

// Runs in the browser before the app's own modules (Next.js instrumentation-client). The page CSP allows no eval
// (lib/csp.ts), so zod must not probe for it: each z.object() built with JIT on runs a caught `new Function("")`,
// which still reports a CSP violation. Set before any schema exists; the server keeps zod's compiled parsers.
z.config({ jitless: true });
