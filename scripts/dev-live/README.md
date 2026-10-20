# Local live stack (`pnpm dev:live`)

One command for the live API (`MOCK_API=0`) on your machine, for wiring the pages against the real backend (P2 task
2.14). Nothing here touches Sepolia, a real key or a paid model API.

```bash
pnpm install                 # once; plus `forge soldeer install` in contracts/ (DeployFinal needs the dependencies)
pnpm dev:live                # or: pnpm dev:live -- --anvil-port 8546 --pg-port 55433 --web-port 3001
pnpm dev:live -- --country SG   # Mei (Singapore); --country MY for Rina; default: the API's DEFAULT_COUNTRY
pnpm dev:live -- --prod         # next build, then next start: the production page CSP (use this for a recorded demo)
```

**CSP under `next dev`:** the default web child is `next dev`, and its page CSP (`apps/web/lib/csp.ts`, `dev: true`)
must send `'unsafe-eval'` in `script-src`, because React's development tooling evaluates code. That is weaker than
production. `--prod` runs `next build` once (a few minutes; output in `.data/web-build.log` if it fails) and then
`next start`, which serves the production CSP (nonce and `'strict-dynamic'`, no `'unsafe-eval'`). Use `--prod` for
anything that should show the real headers.

It starts, in order, and stops all of it on Ctrl-C (removing `scripts/dev-live/.data` unless `--keep-data`):

| What | Where | Notes |
|---|---|---|
| Anvil | `127.0.0.1:8545` (`--anvil-port`) | a fresh chain each start; `--no-cors` (no web page can send cheat calls to it); a block every second with 1-slot epochs, so `finalized` trails `latest` by ~2 blocks and evidence export works a few seconds after the last tx, even when idle |
| Postgres 16 | `127.0.0.1:55432` (`--pg-port`) | throwaway cluster in `scripts/dev-live/.data/pg` (gitignored, `.data` is 0700), migrated like the live tests; TCP on loopback only, `scram-sha-256` with a per-run password that the children read from `.data/pgpass` (0600, via `PGPASSFILE`; pg prints a one-time pgpass deprecation warning) |
| `final-1` | Anvil | `contracts/script/DeployFinal.s.sol`; roles on Anvil's **public** default accounts: agent #1, lender #2, oracle #3, relayer #5 (deployer #0 with `--unlocked`); 120 s cooling and loosening timelock; the platform payout hashes of **both** countries (Rina's DuitNow and Mei's PayNow payees), as on the real final-1 |
| Worker | process | `apps/worker` `src/main.ts`: reconcile + one tick at boot, then its pg-boss cron jobs; the API wakes it on every action; `PAYOUT_RAIL=mock` (Mei's PayNow payouts are always simulated on MockRail) |
| Web + API | `http://localhost:3000` (`--web-port`) | `next dev` (or `next build` + `next start` with `--prod`) with `MOCK_API=0`, `DEMO_MODE=1`, `CHAIN=local` and an explicit `HOGEE_COUNTRY`: SG is facility `fac-mei`, founder `founder-mei`; MY is `fac-rina`, `founder-rina` |

Then it opens the facility the way the live tests do (officer persona → `POST /api/facility/open` → the worker relays
`openFacility`; cap 10,000 BU, reserve floor 300 bps) and prints the URLs and the **officer access code** (random per
run; the officer persona needs it). Skip that with `--no-seed`. The founder's flow starts at the passkey registration
(the browser's own passkey; the launcher registers none, since a founder key can be set only once per deployment), then
the officer approves it. The founder's backup wallet is Anvil account #4 (a public test key you can import in MetaMask
for the `eip712` signing path).

Configuration: every setting reaches the children through their environment, built from scratch (never your shell's
env). The worker and the API both get `HOGEE_DATA_DIR` set to the repo's `data/` (country packs, suppliers, the UN
sanctions list `data/sanctions/un_sc.csv` that `@hogee/checks` reads), so nothing depends on a child's working
directory. Without `--country` the stack runs the API's `DEFAULT_COUNTRY` (`packages/api/src/runtime/env.ts`: MY until
P1 flips that line to SG). `PERSONA_COOKIE_SECRET`, `OFFICER_TOKEN`, `MEMORY_HMAC_KEY` and the Postgres password are generated per run. No
`.env` file is read or written by the launcher. Next.js still loads an `apps/web/.env*` file you created yourself (for
`pnpm dev`), but only for variables the launcher leaves undefined: the launcher's values win, and it sets `REPLAY`, the
model provider and its keys (`MODEL_PROVIDER`, `*_MODEL`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY`,
`OLLAMA_*`), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PRESIDIO_ANALYZER_URL`, `XENDIT_SECRET_KEY` and the Sepolia
RPC URLs to empty strings (the API reads empty as unset; `WEB_ENV_BLANKS` in `src/config.ts`). So your `.env.local`
can stay in place, and it cannot switch this stack to replay, a paid model API, Stripe, Xendit or Presidio. Other
variables in it (for example `NEXT_PUBLIC_*`) still apply. Logs: `scripts/dev-live/.data/{web,worker,anvil,postgres}.log`
(worker warnings and errors are also echoed).

What does not work yet:

- **Chat answers 502** (`redaction_unavailable`): `@hogee/privacy`'s redactor is a P3 stub, and the API never sends text
  to a model unredacted. No model provider is configured either (`/api/health` shows `llm: down`), on purpose.
- Plan drafts and supplier shortlists need P3's `data/country-packs/` and `data/suppliers/` (not in the repo yet); the
  supplier checks (`@hogee/checks`) are stubs too.
- `next dev` rewrites `apps/web/next-env.d.ts` (`.next/dev/types`), as plain `pnpm dev` does; do not commit that change.
- A different `--anvil-port` needs the API's `LOCAL_RPC_URL` support (commit "feat(api): read LOCAL_RPC_URL on
  CHAIN=local"); the worker has always read it.
