# Post-fix security re-check of the run-4 API fixes (HEAD 8c6db2b)

I found two MEDIUM and five LOW issues, none HIGH. Six of the seven fixes do what the leads asked; the inspection-evidence freeze checks expiry against the wrong clock, so it can fail open. The pacing fix closes the API path, but the worker's autonomous tick (its scheduled pacing payment) is a parallel path it leaves open.

I read everything and edited nothing. To check the webhook's text decoding I ran one `node -e` snippet that uses only the standard library, no project code, on Node 24.14.1.

## Findings

**MEDIUM 1: the tick ignores pacing slots paid through the API, so a line can still be paid twice per chain day** (`apps/worker/src/jobs/tick.ts:109-110`, `decide.ts:52`)
- The API now refuses a second slot in a day (`pacedToday`), and the worker's re-check of API rows (`lineSlotToday`) does the same. The tick, though, only looks for its own `pacing:<LINE>:<day>` row and for signed rows still in flight.
- Scenario (DEMO_MODE, tick runs every 20 minutes): at chain day D 00:05 an anonymous caller proposes ADS slot s. It is AUTO, gets signed and is mined. At 00:20 the tick finds no `pacing:ADS:D` row and nothing in flight, so it pays slot s+1. That is two slots in day D, repeatable every day. It also happens whenever the tick is skipping (payee cooling, fee cap) and the API pays first.
- Spending stays within every signed cap, so this is spending ahead of schedule, not diversion. Before the fix the burst was unbounded; now it is at most 2× the schedule.
- Smallest fix: in `tickLine`, treat the line as done for the day when any non-released SPEND row on it is signed or mined in the snapshot's chain day (the same check as `lineSlotToday`). Also limit `unsigned` to `pacing:` ids, so the tick never resumes an API row.

**MEDIUM 2: the evidence freeze compares a chain-time expiry with the database's wall clock** (`packages/api/src/routes/suppliers.ts:107`)
- `expires_at` is chain time: the latest block's timestamp plus 900 s (`typed.ts:63`). Submit checks it against chain time too (`signatures.ts:157`). The freeze uses Postgres `now()` instead.
- Fails open: on an Anvil chain that has been idle, the latest block can be 20 minutes old. A request made then gets an `expires_at` that is already past by wall clock, so the freeze never applies. Anyone can then upload a new file, and the founder's submit returns CONFLICT (the release is re-derived from the changed row). This is repeatable, so it can block the founder's release.
- Over-freezes: once the chain has been moved ahead (the worker harness calls `increaseTime`), a PENDING request locks evidence for days, although submit has treated it as expired after 15 chain-minutes.
- There is also a one-second gap: submit accepts while `expires_at >= now`, but the freeze uses `>`.
- Smallest fix: pass `await chainNow(deps)` as `$4` and use `s.expires_at >= $4`.
- The path is still unreachable today because the checks package is still all stubs. It goes live when P3 lands, two days out.

**LOW 3: anyone can now trigger the freeze.** `requestSignature` is open to the founder persona, which any anonymous caller gets. So an attacker can upload their own file's hash, then request a MilestoneRelease signature to lock that hash for 900 s, and repeat. The founder's own corrective upload is refused with NOT_FOUND meanwhile. Planting a hash was already possible before the fix; what's new is holding it. The real fix is founder authentication.

**LOW 4: duplicate denials are still anchored on-chain** (`proposals.ts:28-31`). The lead's second half (idempotency) was not addressed. Re-sending an AUTO invoice proposal gives DuplicateIntent (a contract error), which still writes `recordDenied`. Three retries open the line's circuit. Fix: add DuplicateIntent and DuplicateInvoice to the exclusion set, or skip `recordDenied` when a live payments row already holds the intent.

**LOW 5: the webhook HMAC input is not byte-identical to before in one case** (`register.ts:113`, `webhooks.ts:57`). On Node 24.14.1, `Request.text()` and `new TextDecoder().decode()` give the same string for no BOM, one BOM, and invalid or truncated UTF-8. They differ only when the body starts with two or more BOMs: the old path stripped two, the new strips one. Stripe never sends a BOM and either way the secret is still required, so there is no security impact. Cleanest fix: compute the HMAC over the raw bytes, `update(`${t}.`).update(bytes)`.

**LOW 6: upload denial-of-service is bounded per request, not overall** (`register.ts:80-110`, `suppliers.ts:96`). Each upload can hold roughly 4 × 10 MiB at peak: the chunks, the joined copy, the parsed File, and `arrayBuffer()`. It also runs a JS keccak over the whole file before any database check, and there is no limit on concurrent requests or rate. Fix: check that the target milestone exists and is not frozen before hashing.

**LOW 7: the API pacing path can stay blocked for good** (`policy-context.ts:28,73`)
- An unsigned POLICY_OK row counts as "today's slot" forever. Nothing ever releases a stale `pacing:` row (the tick's STALE_PROPOSAL_TODAY case), so every API pacing proposal on that line would answer ALREADY_PROPOSED_TODAY. The tick skips unsigned rows, so the two paths disagree.
- On an idle Anvil, "today" is the latest block's day and does not move until something is mined. The tick behaves the same way.

## Verified correct
- **Streamed body cap:**
  - Covers both multipart and JSON/raw bodies.
  - No other body readers: no middleware, and no handler touches `c.req` or `raw`.
  - Next 16.4 hands undici the incoming request as a pull-based stream, and cancelling it destroys the request, so reading stops at the cap plus one chunk. Next only buffers bodies when there is a proxy or middleware, and there is none.
  - Errors map to the declared VALIDATION (422, or 400 for the webhook).
  - Side effect: an oversize client usually sees a connection reset rather than the 422/400 body. Harmless.
- **Veto lock-then-decide:**
  - The officer approval's conditional UPDATE waits on the lock and fails CONFLICT after a veto.
  - Sync's updates are conditional, so they cannot overwrite CANCELLED.
  - The relay race is covered by the worker deferring the cancel and `syncVetoedLoosens` re-queuing it or halting.
  - CONFLICT is declared.
- **recordDenied exclusions:** the API is the only place that creates `recordDenied`. Pacing proposals are never anchored.
- **Freeze SQL (apart from the clock):**
  - It is one statement with correlated checks, and every column and enum value exists.
  - Comparing bigint with numeric is valid.
  - There is no gap with finalize: the request stays PENDING until the same transaction that inserts the payment.
- **Pacing:**
  - Day bucketing uses chain time on both sides and is correct at day boundaries.
  - Denied, reverted and cancelled rows never count.
  - The new reason code matches the ReasonCode format and is never anchored with `recordDenied`.
- **Nonce seeding:**
  - It never moves an existing row and is safe under concurrent starts.
  - All four worker keys are seeded.
  - A failure stops worker start-up.
- **Hashing:** keccak256 throughout via viem; no `sha3-256` anywhere in packages or apps.
