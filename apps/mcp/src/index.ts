#!/usr/bin/env -S npx tsx
/**
 * Runs the Hogee MCP server over stdio. HOGEE_API_URL points at the web app (default http://localhost:3000);
 * propose_spend needs DEMO_MODE=1 on that server (it is a demo route).
 *
 *   pnpm --filter @hogee/mcp start
 *   npx @modelcontextprotocol/inspector pnpm --filter @hogee/mcp start
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { hogeeApi } from "./api";
import { createHogeeMcpServer } from "./server";

const api = hogeeApi(process.env.HOGEE_API_URL ?? "http://localhost:3000");
serveStdio(() => createHogeeMcpServer(api));
// stdout carries the protocol; status goes to stderr.
process.stderr.write(`hogee-mcp: serving 5 tools over stdio for ${process.env.HOGEE_API_URL ?? "http://localhost:3000"}\n`);
