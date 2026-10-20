# @hogee/worker

The only process that signs (D19). It runs the autonomous loop on `loop-1` (gate G1) and, later, the `final-1` jobs.
The web app and the API never sign: they write rows the worker picks up.

| Job (pg-boss queue) | Default schedule | What it does |
|---|---|---|
| `autonomous-tick` | `*/20 * * * *` | Mirrors the chain at one block, projects in-flight spends, asks `core.planPacingSlot` for each pacing line, and sends **only** a PROPOSE (payment row → `signAndStore` → broadcast). A SKIP is logged, never proposed and never `recordDenied`. Skipped when fees are above `MAX_FEE_GWEI`. Alerts on low hot-key balance. Writes a heartbeat. |
| `reconcile` | every minute | Per facility, with that facility's deployment: `recoverOpenIntents` (re-sends stored bytes, never signs) and `advanceFinality` (terminal states from `finalized`). Per hot key: nonce holes get a no-op cancel. Watches finalized `Spent` logs (and, on final-1, MilestoneEscrow `MilestoneFunded` logs, on their own cursor) for orphans, and drives the orphan safety pause until `Treasury.paused()` reads true. Applies the halt rules. Each step is guarded on its own. |
| `settle-spend` | every minute | For each finalized spend: payout through the `PayoutRail` (MockRail, or Xendit test mode with `PAYOUT_RAIL=xendit`), then the ORACLE calls `confirmSettlement`, or `failSettlement` once the failure is final. |

The worker also runs `reconcile` and one tick at boot, so a restart always starts with crash recovery.

## Commands

```bash
pnpm --filter @hogee/worker start         # the worker (env below); SIGINT/SIGTERM shut it down gracefully
pnpm --filter @hogee/worker ops status    # active halt, its unacknowledged reasons (#id), open safety pauses, heartbeats
pnpm --filter @hogee/worker ops halt --reason "why"      # manual kill switch
pnpm --filter @hogee/worker ops resume --note "checked" --ack-through <id>  # clear a halt after checking each reason
pnpm --filter @hogee/worker ops resume --note "paused by hand" --ack-through <id> --abandon-pause
pnpm --filter @hogee/worker loop:anvil    # local acceptance run (Anvil + throwaway Postgres, 21 simulated days)
pnpm --filter @hogee/worker loop:anvil --wall-minutes 60  # real-time soak, one tick every 2 s
pnpm --filter @hogee/worker test          # unit tests; db/live tests run when their env is set
```

`ops` needs only `DATABASE_URL`. It reads no key and signs nothing. `ops resume` exits 1 (and changes nothing) when it
refuses:
- `--ack-through <id>` names the last reason you checked (the highest `#id` `ops status` printed). It is required
  whenever the halt has unacknowledged reasons, and the resume is refused if a reason newer than it exists (raised
  after you looked): run `ops status` again.
- While a safety pause of the halt is still open (`Treasury.pause()` not yet confirmed by reconcile), the resume is
  refused, so an orphan's pause is never dropped by a resume. Wait for reconcile to confirm it, or pause the treasury
  yourself and pass `--abandon-pause`, which closes those requests (`ABANDONED`).

## Environment

Set these in the worker host's environment. Never commit values; keys are read once at startup and then deleted
from the process environment, and they are never logged or written anywhere.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres with the packages/db migrations applied |
| `DEPLOYMENT_ID` | yes | | `loop-1` or `final-1`; selects the key set |
| `MAX_FEE_GWEI` | yes | | Fee cap: ticks above it are skipped; nothing routine is signed above it |
| `MAX_SAFETY_FEE_GWEI` | | 10 × `MAX_FEE_GWEI` | Fee cap of the orphan safety pause only (never below `MAX_FEE_GWEI`); see Halts |
| `CHAIN` | | `local` | `local` or `sepolia` |
| `LOCAL_RPC_URL` | | `http://127.0.0.1:8545` | Anvil URL when `CHAIN=local` |
| `SEPOLIA_RPC_URL`, `SEPOLIA_RPC_URL_FALLBACK` | with `sepolia` | | Two providers (viem `fallback`); `https:` only (plain `http:` only for localhost, 127.0.0.1 or [::1]) |
| `RPC_POLLING_MS` | | 1000 local, 12000 Sepolia | Polling interval (≥ 12 s on Sepolia) |
| `CHAIN_TAG` | | `anvil` / `sepolia` | Manifest name: `packages/chain/deployments/<CHAIN_TAG>-<DEPLOYMENT_ID>.json` |
| `DEPLOYMENT_FILE` | | | Explicit manifest path instead |
| `LOW_BALANCE_ETH` | | `0.05` | Alert when the agent or oracle balance is below it |
| `TICK_CRON`, `RECONCILE_CRON`, `SETTLE_CRON` | | see above | 5-field crons, UTC |
| `STUCK_PENDING_PASSES` | | `5` | Reconcile passes a non-canonical `pending` may persist before the worker halts |
| `PAYOUT_MAX_ATTEMPTS` | | `3` | Payout attempts (attempt + 1 per retryable failure) before `failSettlement` |
| `PAYOUT_RAIL` | | `mock` | `mock` or `xendit` (Xendit test mode) |
| `XENDIT_SECRET_KEY` | with `xendit` | | Xendit TEST key (`xnd_development_…` only; production keys are refused); read once, then removed from the env |
| `DB_STATEMENT_TIMEOUT_MS`, `DB_LOCK_TIMEOUT_MS` | | `30000`, `5000` | `statement_timeout` / `lock_timeout` of every worker pg connection: a stuck statement fails instead of holding the job lock. A connection on which they cannot be set is closed, never used. The startup schema migration waits up to 120 s for its lock |
| `AGENT_PRIVATE_KEY_LOOP`, `ORACLE_PRIVATE_KEY_LOOP`, `LENDER_PRIVATE_KEY_LOOP`, `RELAYER_PRIVATE_KEY_LOOP` | for `loop-*` | | The `loop-1` key set |
| `AGENT_PRIVATE_KEY_FINAL`, `ORACLE_PRIVATE_KEY_FINAL`, `LENDER_PRIVATE_KEY_FINAL`, `RELAYER_PRIVATE_KEY_FINAL` | for `final-*` | | The `final-1` key set |

The four keys of a set must be distinct, and no key may appear in both sets. At startup the worker refuses to run
unless the RPC serves the manifest's chain and the lender/oracle keys are the deployment's roles.

## Halts

The worker halts (stops new signing and payouts; recovery and finality keep running) on:
- any recovery or finality outcome `error`;
- a nonce hole-fill reported `occupied`;
- a finality `pending` from a non-canonical receipt that persists for `STUCK_PENDING_PASSES` passes;
- an orphan `Spent`, or on final-1 an orphan `MilestoneFunded` (the agent key moved money outside the backend: no
  payment row the worker signed has that intent and rationaleHash with stored bytes that hash to the event's tx and
  recover to the agent key), which also queues the safety pause below;
- an agent-key nonce the worker's allocator never handed out (`EXTERNAL_AGENT_KEY_USE`), found by the nonce check of
  every reconcile pass, halted or not, without waiting for finality. It also queues the safety pause (id
  `agent-key:<address>:<nonce>`): the pause only tightens, so a false positive costs one founder + lender unpause. The
  allocator stores each nonce with its signed bytes before broadcasting, so the worker's own sends or a crash never
  trip it. The same check on the oracle, lender and relayer keys only alerts (`EXTERNAL_KEY_USE`). The worker
  seeds a `nonces` row for every key at start-up, so the check sees an outside use from the first pass;
- a settlement the chain reads CONFIRMED that no payout backs (`SETTLEMENT_CONTRADICTION`: the rail reports no
  SUCCEEDED attempt for it), so an oracle attestation made outside the worker never closes an unpaid payment as
  SETTLED. It halts once per payment: after `ops resume` the row stays blocked without halting again. A paid row whose
  attestation is not the worker's own confirm (none, reverted, or another payoutRefHash) closes SETTLED with one
  `SETTLEMENT_CONFIRMED_ELSEWHERE` ALERT instead;
- a payout destination that does not match the on-chain payee binding, or a payee with no registered payout account;
- a DB plan or role that does not match the chain.

The safety pause (`jobs/safety-pause.ts`): every orphan log and every agent-key finding queues its own request
(`hogee_worker.safety_pauses`, id `orphan:<txHash>:<logIndex>` or `agent-key:<address>:<nonce>`) in the transaction
that records the halt reason, so a second orphan after a resume gets a fresh pause. Each reconcile pass, whatever else failed in it, drives the live
requests (those of the active halt) while `Treasury.paused()` reads false at the latest block, and closes them only
once it reads true at the `safe` block (a pause a reorg drops is sent again):
- the LENDER key signs first, the AGENT key only as a fallback (it is the key presumed leaked); before signing, that
  signer's stored next nonce is raised to the chain's pending count (a DB-only step, allowed while halted);
- a pause that reverts, is mined while the treasury stays unpaused, loses its nonce to another tx (replaced or
  front-run) or is not executable at the node counts as failed and is retried with a fresh nonce, never as done;
- fees: capped by `MAX_SAFETY_FEE_GWEI`; a pause still pending on the next pass is re-signed at its nonce ≥ 10 % higher,
  up to the cap; an estimate above the cap signs nothing and logs `treasury_pause_failed` every pass until fees drop;
- a stored attempt is re-signed or re-sent only if its bytes are exactly this Treasury's `pause()` for this chain,
  signed by the row's signer; anything else (a DB writer's swap) is a failed attempt and a fresh one follows. A node
  that refuses a re-send or a bump (insufficient funds, replacement underpriced, txpool full) fails that attempt only:
  the fresh lender attempt, then the agent fallback, still run in the same pass;
- `ops resume` refuses while a request of the halt is open (see Commands); once the halt is cleared, nothing more is
  sent for its requests, so a founder + lender `LOOSEN_UNPAUSE` is not undone afterwards. A reason raised while a
  resume is in progress waits for it and then starts a new halt (with its own pause request), never the one cleared.

A halt is a row in `hogee_worker.halts` plus an `error` log line `halt_raised`. A further reason raised while it is
active (an orphan spend during a manual halt, say) is not dropped: every distinct reason is kept in
`hogee_worker.halt_events` and logged as `halt_reason_added`. `ops status` lists the reasons no resume has acknowledged
yet, each with its event id; check each, then run `ops resume --note "…" --ack-through <last id>`, which acknowledges
them and prints them. Heartbeats are in
`hogee_worker.heartbeats`.

The worker keeps its operational tables in its own schema, `hogee_worker` (created at startup), and pg-boss in
`pgboss`. The product tables stay in packages/db. Connect `DATABASE_URL` directly to Postgres, not through a
transaction-pooling proxy (pgbouncer): the job lock is a session advisory lock.

## macOS loop host

The loop must run unattended for days. On a spare Mac on power:

```bash
# keep the Mac awake while the worker runs (display, idle, disk and system sleep; -u marks the user active)
caffeinate -dimsu pnpm --filter @hogee/worker start
```

Turn automatic macOS updates off for the run, keep the Mac on power, and keep Postgres running (Homebrew service or
docker compose). Restarts are safe: every job is resumable, and the worker reconciles at boot. To upgrade the
worker, stop it with Ctrl-C (graceful), pull, and start it again; never redeploy `loop-1`.

## Tests

```bash
anvil --port 18547 --silent &
# a throwaway Postgres 16 on 127.0.0.1:55434 (initdb + pg_ctl), then:
TEST_DATABASE_URL=postgres://<user>@127.0.0.1:55434/<db> TEST_RPC_URL=http://127.0.0.1:18547 \
  pnpm --filter @hogee/worker test
```

- `test/unit`: pure logic with fakes (no env).
- `test/db`: Postgres only (`TEST_DATABASE_URL`).
- `test/live`: Anvil + Postgres; each test deploys a fresh loop-1 set with `DeployLoop.s.sol` (the escrow-orphan tests a
  final-1 set with `DeployFinal.s.sol`; needs `forge` and the contracts' Soldeer dependencies). Covers the crash/restart rule (kill -9 at every tick checkpoint → exactly one
  payment), the headroom skip, the halt rules, settlement idempotency, the fee-cap skip and the `start` process.
