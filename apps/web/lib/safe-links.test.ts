/**
 * Links built from data the page did not write (audit run-8): an evidence bundle's artifact paths and a plan rule's
 * source URL. A value that could leave the bundle's files or run script gets no link.
 */
import { describe, expect, it } from "vitest";
import { apiUrl } from "./api/client";
import { artifactPath, sourceLink } from "./safe-links";

describe("artifactPath (evidence-table artifact links)", () => {
  it("keeps a plain relative path inside the bundle", () => {
    for (const p of ["receipts/T1.json", "evidence.json", "a/b/c.md", "traces/2026-10-18_run.v2.jsonl"]) expect(artifactPath(p), p).toBe(p);
  });

  it("refuses dot, dot-dot, empty and absolute segments", () => {
    for (const p of ["..", ".", "../manifest.json", "receipts/../../api/session", "./evidence.json", "a/./b.json", "a/..", "/etc/passwd", "a//b.json", "a/b/", ""]) {
      expect(artifactPath(p), JSON.stringify(p)).toBeNull();
    }
  });

  it("refuses what the file route would refuse anyway (the contract's EvidenceFileParams)", () => {
    for (const p of ["a..b.json", "a\\..\\b", "%2e%2e/x", "a b.json", "x?y=1", "x#y", "C:/x", "https://evil.example/x", "a".repeat(301)]) {
      expect(artifactPath(p), p).toBeNull();
    }
  });

  it("a kept path becomes a link under the run's files route and nowhere else", () => {
    const runId = "run-example-001";
    const href = apiUrl("getEvidenceFile", { params: { runId, path: "receipts/T1.json" } });
    expect(href).toBe(`/api/evidence/${runId}/files/receipts/T1.json`);
    expect(new URL(href, "http://localhost").pathname.startsWith(`/api/evidence/${runId}/files/`)).toBe(true);
  });
});

describe("sourceLink (plan rule source links)", () => {
  it("links an https source", () => {
    expect(sourceLink("https://www.sfa.gov.sg/food-import-export")).toEqual({ kind: "link", href: "https://www.sfa.gov.sg/food-import-export" });
  });

  it("gives no link for javascript:, data:, http: and other schemes, only the text", () => {
    for (const url of ["javascript:alert(1)", "JavaScript:alert(document.cookie)", " javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "http://www.sfa.gov.sg/", "ftp://files.example/x", "vbscript:msgbox(1)", "file:///etc/passwd"]) {
      const link = sourceLink(url);
      expect(link.kind, url).toBe("text");
      expect(link).not.toHaveProperty("href");
    }
  });

  it("shows text, not a link, for a value that is not a URL", () => {
    expect(sourceLink("not a url")).toEqual({ kind: "text", text: "not a url" });
    expect(sourceLink("//evil.example/x").kind).toBe("text");
  });

  it("shows nothing for a placeholder (example.invalid) source", () => {
    expect(sourceLink("https://example.invalid/sg/fees")).toEqual({ kind: "placeholder" });
    expect(sourceLink("http://mock.example.invalid")).toEqual({ kind: "placeholder" });
  });

  it("caps the text it shows", () => {
    const long = `data:text/plain,${"x".repeat(5000)}`;
    const link = sourceLink(long);
    expect(link.kind === "text" && link.text.length).toBeLessThanOrEqual(200);
  });
});
