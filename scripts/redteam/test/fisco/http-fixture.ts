/**
 * A real HTTP server on 127.0.0.1 (ephemeral port, nothing else) that records every request it gets and answers with
 * the test's `answer`. Used to show what the replay's fetch transport does with a node's redirect answers.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface Hit {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

export interface Answer {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface HttpFixture {
  /** `http://127.0.0.1:<port>/` */
  readonly url: string;
  readonly hits: Hit[];
  close(): Promise<void>;
}

export async function httpFixture(answer: (hit: Hit) => Answer): Promise<HttpFixture> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const hit: Hit = { method: req.method ?? "", path: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") };
      hits.push(hit);
      const a = answer(hit);
      res.writeHead(a.status, { "content-type": "application/json", ...a.headers });
      res.end(a.body ?? "");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A JSON-RPC 2.0 answer to `hit` (same id) carrying `result`, or `error` when given. */
export function rpcAnswer(hit: Hit, result: unknown, error?: { code: number; message: string; data?: unknown }): Answer {
  const id = (JSON.parse(hit.body) as { id?: unknown }).id ?? null;
  return { status: 200, body: JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }) };
}

/** The JSON-RPC method of a recorded POST ("" for anything else). */
export function methodOf(hit: Hit): string {
  try {
    return String((JSON.parse(hit.body) as { method?: unknown }).method ?? "");
  } catch {
    return "";
  }
}
