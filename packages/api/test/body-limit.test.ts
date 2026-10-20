/**
 * Body size caps (audit run-4 `register.ts:readBody:size-cap-trusts-content-length`): a body with no Content-Length
 * (chunked) is counted as it streams and refused at cap+1 bytes, before it is buffered or reaches the handler.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "@hogee/core";
import { createApiApp } from "../src/app";
import { MAX_UPLOAD_BYTES } from "../src/http/register";
import { fakeDeps } from "./support/fake-deps";

const MAX_JSON_BYTES = 256 * 1024;
const CHUNK = 64 * 1024;

/** A stream of `total` bytes with no declared length; `pulled` counts what the server actually read. */
function chunked(total: number, byte = 0x61) {
  const pulled = { bytes: 0 };
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (sent >= total) return ctrl.close();
      const n = Math.min(CHUNK, total - sent);
      sent += n;
      pulled.bytes += n;
      ctrl.enqueue(new Uint8Array(n).fill(byte));
    },
  });
  return { stream, pulled };
}

const post = (path: string, headers: Record<string, string>, body: ReadableStream<Uint8Array>) =>
  new Request(`http://localhost${path}`, { method: "POST", headers, body, duplex: "half" } as RequestInit);

async function errorOf(res: Response) {
  return ApiError.parse(await res.json()).error;
}

describe("body size caps without Content-Length", () => {
  it("refuses a chunked JSON body over the cap after reading at most cap + one chunk", async () => {
    const f = fakeDeps();
    const { stream, pulled } = chunked(4 * MAX_JSON_BYTES);
    const req = post("/api/facility/open", { "content-type": "application/json", cookie: f.cookie("officer") }, stream);
    expect(req.headers.get("content-length")).toBeNull();
    const res = await createApiApp(async () => f.deps).request(req);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).message).toMatch(/too large/);
    expect(pulled.bytes).toBeLessThanOrEqual(MAX_JSON_BYTES + 2 * CHUNK); // the stream may pull one chunk ahead
  });

  it("still parses a small chunked JSON body (the schema, not the cap, refuses it)", async () => {
    const f = fakeDeps();
    const bytes = new TextEncoder().encode(JSON.stringify({ capMinor: "10.5", reserveFloorBps: 300 }));
    const stream = new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(bytes), c.close()) });
    const res = await createApiApp(async () => f.deps).request(post("/api/facility/open", { "content-type": "application/json", cookie: f.cookie("officer") }, stream));
    expect(res.status).toBe(422);
    expect((await errorOf(res)).message).toBe("Invalid request body");
  });

  it("refuses a chunked multipart upload over the cap before the handler runs", async () => {
    const f = fakeDeps();
    let reached = false;
    const app = createApiApp(async () => f.deps, {
      uploadInspection: () => {
        reached = true;
        return { evidenceHash: `0x${"00".repeat(32)}` };
      },
    });
    const { stream, pulled } = chunked(MAX_UPLOAD_BYTES + 4 * CHUNK);
    const res = await app.request(post("/api/escrow/order-a-001/inspection", { "content-type": "multipart/form-data; boundary=hogeeb" }, stream));
    expect(res.status).toBe(422);
    expect((await errorOf(res)).message).toMatch(/too large/);
    expect(reached).toBe(false);
    expect(pulled.bytes).toBeLessThanOrEqual(MAX_UPLOAD_BYTES + 2 * CHUNK); // the stream may pull one chunk ahead
  });

  it("still parses a small multipart upload sent without a declared length", async () => {
    const f = fakeDeps();
    let size = -1;
    const app = createApiApp(async () => f.deps, {
      uploadInspection: ({ req }) => {
        size = (req.body.file as Blob).size;
        return { evidenceHash: `0x${"00".repeat(32)}` };
      },
    });
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(1234)], { type: "application/pdf" }), "report.pdf");
    const encoded = new Response(form);
    const type = encoded.headers.get("content-type") ?? "";
    const res = await app.request(post("/api/escrow/order-a-001/inspection", { "content-type": type }, encoded.body as ReadableStream<Uint8Array>));
    expect(res.status).toBe(200);
    expect(size).toBe(1234);
  });
});
