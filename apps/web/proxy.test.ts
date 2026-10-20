/**
 * Which requests get the per-request page CSP (re-check review LOW 3): only Next's own router prefetches are skipped
 * (`next-router-prefetch`, never rendered as a document). A browser speculative prefetch (`Purpose: prefetch`,
 * `Sec-Purpose: prefetch`) can become the document the user sees, so it must carry the nonce CSP too.
 */
import { describe, expect, it } from "vitest";
import { config } from "./proxy";

describe("proxy matcher", () => {
  it("skips only next-router-prefetch, never a request marked purpose: prefetch", () => {
    const [m] = config.matcher;
    expect(config.matcher).toHaveLength(1);
    expect(m?.missing).toEqual([{ type: "header", key: "next-router-prefetch" }]);
    expect(JSON.stringify(config)).not.toMatch(/purpose/i);
  });
});
