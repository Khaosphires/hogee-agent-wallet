/**
 * The MCP server against the api-mock in-process (no HTTP server, no chain). Acceptance (ROLE-P2 2.16): a second
 * client that tries to overspend is blocked.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { HogeeApiError, hogeeApi, type Fetch, type HogeeApi } from "../src/api";
import { createHogeeMcpServer, spendSummary } from "../src/server";

beforeAll(() => {
  process.env.DEMO_MODE = "1";
});

const { app } = await import("@hogee/api-mock");

/** fetch → the mock's Hono app, with the Host the request guard expects. */
const mockFetch: Fetch = async (url, init) => app.request(new URL(url).pathname + new URL(url).search, { ...init, headers: { ...(init?.headers ?? {}), host: "localhost:3000" } });

async function connect(): Promise<Client> {
  const server = createHogeeMcpServer(hogeeApi("http://localhost:3000", mockFetch));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}

type ToolOut = { structuredContent?: Record<string, unknown>; isError?: boolean; content: unknown[] };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolOut;

describe("hogee MCP server", () => {
  it("exposes exactly the five tools, and propose_spend takes no payee or amount", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_evidence", "get_plan", "pause", "propose_spend", "request_loosen"]);
    const spend = tools.find((t) => t.name === "propose_spend");
    const props = Object.keys((spend?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    expect(props).not.toContain("payeeId");
    expect(props).not.toContain("amountMinor");
  });

  it("get_plan returns the signed pockets", async () => {
    const out = await call(await connect(), "get_plan");
    expect(out.isError).toBeFalsy();
    expect((out.structuredContent?.lines as unknown[]).length).toBeGreaterThan(0);
  });

  it("a second client that tries to overspend ADS is blocked at the cap", async () => {
    const first = await connect();
    const second = await connect();
    await call(first, "get_plan");
    const verdicts: string[] = [];
    for (let slot = 100; slot < 120; slot += 1) {
      const out = await call(second, "propose_spend", { lineKey: "ADS", pacingSlot: slot, reason: "More ads, please" });
      expect(out.isError).toBeFalsy();
      verdicts.push(`${out.structuredContent?.verdict}:${out.structuredContent?.reasonCode}`);
    }
    expect(verdicts).toContain("DENY:CapExceeded");
    // Once the window is full, every further attempt is refused.
    expect(verdicts.slice(verdicts.indexOf("DENY:CapExceeded")).every((v) => v.startsWith("DENY"))).toBe(true);
  });

  it("request_loosen only opens a request that needs both humans", async () => {
    const out = await call(await connect(), "request_loosen", {
      kind: "RAISE_CAP",
      payload: { lineKey: "ADS", cap: "perTx", newCapMinor: "60000" },
      reason: "Agent wants a bigger ads budget",
    });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toMatchObject({ status: "OPEN", requires: { founder: true, lender: true } });
    // The officer sees it as the agent's request, not the founder's.
    const listed = (await (await mockFetch("http://localhost:3000/api/exceptions")).json()) as { exceptionId: string; requestedBy: string }[];
    expect(listed.find((e) => e.exceptionId === out.structuredContent?.exceptionId)?.requestedBy).toBe("agent");
  });

  it("get_evidence lists runs and pause tightens", async () => {
    const client = await connect();
    expect(((await call(client, "get_evidence")).structuredContent?.runs as unknown[]).length).toBeGreaterThan(0);
    expect((await call(client, "pause")).isError).toBeFalsy();
  });
});

describe("propose_spend against the live API's rules", () => {
  async function connectTo(api: HogeeApi): Promise<Client> {
    const server = createHogeeMcpServer(api);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test-agent", version: "1.0.0" });
    await client.connect(clientSide);
    return client;
  }
  const textOf = (out: ToolOut) => JSON.stringify(out.content);

  it("explains ALREADY_PROPOSED_TODAY (one paid pacing slot per line per chain day)", async () => {
    const live: Fetch = async () => new Response(JSON.stringify({ verdict: "DENY", reasonCode: "ALREADY_PROPOSED_TODAY", traceId: "trace-1" }), { status: 200 });
    const out = await call(await connectTo(hogeeApi("http://localhost:3000", live)), "propose_spend", { lineKey: "ADS", pacingSlot: 2, reason: "Second slot today" });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toMatchObject({ verdict: "DENY", reasonCode: "ALREADY_PROPOSED_TODAY" });
    expect(textOf(out)).toContain("pacing slot for today is already paid or being paid");
  });

  it("says an AUTO verdict is re-checked before it is paid, not paid already (P1 review of #10)", () => {
    expect(spendSummary("AUTO", "WITHIN_PLAN")).toBe("Allowed inside the signed plan; the worker re-checks it before paying.");
  });

  it("never resends a proposal that timed out, and says its outcome is unknown", async () => {
    let calls = 0;
    const api: HogeeApi = {
      call: async () => {
        calls += 1;
        throw new HogeeApiError("TIMEOUT", "no answer", 0);
      },
    };
    const out = await call(await connectTo(api), "propose_spend", { lineKey: "LOGISTICS", invoiceId: "inv-0003", reason: "Pay the courier" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("Outcome unknown");
    expect(calls).toBe(1);
  });

  /** What Node's fetch (undici) throws when the socket fails: a TypeError with the socket error as `cause`. */
  const socketFailure = (code: string): Fetch => async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
  };

  it("a connection reset after sending is an unknown outcome, not 'can't reach'", async () => {
    const out = await call(await connectTo(hogeeApi("http://localhost:3000", socketFailure("UND_ERR_SOCKET"))), "propose_spend", {
      lineKey: "LOGISTICS",
      invoiceId: "inv-0003",
      reason: "Pay the courier",
    });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("Outcome unknown");
    expect(textOf(out)).toContain("payments list and the timeline");
    expect(textOf(out)).not.toContain("get_evidence");
  });

  it("a refused connection says nothing was sent", async () => {
    const out = await call(await connectTo(hogeeApi("http://localhost:3000", socketFailure("ECONNREFUSED"))), "propose_spend", { lineKey: "ADS", pacingSlot: 3, reason: "x" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("nothing was sent");
    expect(textOf(out)).not.toContain("Outcome unknown");
  });

  it("a timeout while reading the answer is still a timeout", async () => {
    const slowBody: Fetch = async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const api = hogeeApi("http://localhost:3000", slowBody);
    await expect(api.call("proposeSpend", { body: { lineKey: "ADS", pacingSlot: 1, reason: "x" } }, { timeoutMs: 50 })).rejects.toMatchObject({ code: "TIMEOUT", status: 0 });
  });

  it("gives up after the timeout with a single request", async () => {
    let calls = 0;
    const hanging: Fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        calls += 1;
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const api = hogeeApi("http://localhost:3000", hanging);
    await expect(api.call("proposeSpend", { body: { lineKey: "ADS", pacingSlot: 1, reason: "x" } }, { timeoutMs: 50 })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(calls).toBe(1);
  });
});
