import { NextResponse, type NextRequest } from "next/server";
// Relative (not "@/lib/csp") so proxy.test.ts can import this file under plain vitest.
import { newNonce, pageCsp } from "./lib/csp";

/**
 * The page CSP with a fresh nonce per request (lib/csp.ts). Next.js reads the nonce from the request's
 * Content-Security-Policy header and puts it on every script it renders, which is why the root layout renders per
 * request (app/layout.tsx). The response carries the same policy; it replaces next.config.ts's BASE_CSP, which it
 * includes.
 */
export function proxy(request: NextRequest) {
  const policy = pageCsp({ nonce: newNonce(), dev: process.env.NODE_ENV === "development" });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: not the API (route.ts; BASE_CSP from next.config.ts), static files or Next's own router prefetches
      // (never shown as a document). A browser prefetch ("Purpose: prefetch") is NOT skipped: the browser can show that
      // response as the page, so it needs the nonce CSP (re-check review LOW 3).
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
};
