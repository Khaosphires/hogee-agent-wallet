# @hogee/mcp (P2, task 2.16, stretch)

An MCP server (official TypeScript SDK v2, spec 2026-07-28) that gives any external agent the same powers as the
Hogee agent and no more. It calls the HTTP API only: it never holds a key or touches the chain. Every call carries
`x-hogee-requester: agent`, so the officer sees its requests as the agent's, not the founder's.

| Tool | Route | Notes |
|---|---|---|
| `get_plan` | `GET /api/plans/current` | Pockets, caps, payees, stages (read-only) |
| `propose_spend` | `POST /api/proposals/spend` | A bound invoice or a pacing slot; **no payee or amount input**, the server derives both (D6). Demo route: needs `DEMO_MODE=1` |
| `request_loosen` | `POST /api/exceptions` | Opens a request; the founder and the loan officer must sign, then the timelock runs |
| `get_evidence` | `GET /api/evidence/runs`, `/api/evidence/:runId` | Rows with tx hash, decision id, trace (read-only) |
| `pause` | `POST /api/control/pause` | Tighten-only, instant |

```bash
pnpm --filter @hogee/web dev:mock          # the API it talks to (mock + demo routes)
pnpm --filter @hogee/mcp start             # stdio server; HOGEE_API_URL defaults to http://localhost:3000
npx @modelcontextprotocol/inspector pnpm --filter @hogee/mcp start   # interactive check
pnpm --filter @hogee/mcp test              # in-process against api-mock, incl. "a second client overspends and is blocked"
```
