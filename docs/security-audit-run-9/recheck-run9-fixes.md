# Run-9 post-fix skills re-check (19 Oct 2026)

**Scope:** `db731b0..a778729`, source only. This is the chat-first revamp after the run-9 fixes (fix9-search, fix9-chat, fix9-worker, fix9-terms, fix9-web). Three independent reviewers each loaded one skill and read a detached, read-only snapshot. Nothing was executed against live endpoints, Sepolia or `.env*`.

## Results
| Skill | Critical | High | Medium | Low | Info |
|---|---|---|---|---|---|
| `security-review` | 0 | 0 | 0 | 5 | – |
| `nodejs-keccak256` | 0 | 0 | 0 | 4 | 3 |
| `llm-trading-agent-security` | 0 | 0 | 1 | 5 | – |

Two of the LOW items overlap across reviewers: the cancel timing in sync-binds, and the auto-release limits applying after a cap tightens.

## Fixed (merged into p1/dev by `6446024`)
**MEDIUM: automatic deposits bypassed the SUPPLIER window cap across orders.** (fixr-escrow)
- A new order's automatic milestones now get only the window that is left: the cap, minus what open orders' automatic milestones still have to pay, minus automatic payments landed within `windowSeconds`.
- Catalog schedules get the same per-tx and window rules.
- At funding time, the worker holds an automatic milestone back (with an ALERT; it retries and never sends) when it is over the line's current per-tx cap or the window. This also covers a cap tightened after signing.

**LOW: sync-binds could cancel a payee while its signed approval could still land.** (fixr-escrow)
- A failed bind is cancelled only once the approval expired more than 120 s ago in chain time.
- The binding and `now` are read at the same block.
- `syncPayees` re-opens a cancelled payee the chain shows bound, with an ALERT.
- The worker never funds an order whose payee is cancelled.

**LOW: the CFO guard could ratchet on spending it does not control.** (fixr-cfo)
- Burn counts the agent's own spending only.
- A lowered cap never goes below half the committed cap, the pacing slot, or the line's largest recent agent payment.
- At most one tightening per line per window.
- A prefilled raise-cap change request is linked.

**LOW: `GET /api/cfo` could exhaust the RPC.** (fixr-cfo) Fixed with a 30-day exact dating window, an evicting LRU, single-flight, a 15 s cache per block, and a 30-per-minute per-client limit.

**LOW: an officer pause could wait behind the CFO guard.** (fixr-cfo) Sends now count against the guard's deadline, and a pending pause or cancelLoosen waits for the job lock instead of being skipped.

**LOWs fixed by fixr-misc:**
- A canonical listing URL, so one listing gets one supplier id.
- Lone surrogates are refused in names (422, not 500); the browser's signing check refuses instead of crashing.
- One core `webQuoteHash` for the live API and the mock (the mock now signs the real shortlist hash).
- `bodySha256` docs corrected.
- `WEB_PAYOUT_CHANNEL` from core.
- The red-team attacker hash uses JCS.
- A strict seal-code regex.
- The browser checks the catalog `scheduleHash` and that the milestones sum to `totalMinor`.
- The CSP proxy skips only `next-router-prefetch`; `dev:live --prod` runs build and start.
- Record-sale takes the least recently tried rows first.
- Web search re-prices a cached answer for a new quantity, so no Tavily or Reader call is needed.

## Accepted residuals (named in the security self-assessment)
- **Holder-name check:** a listing that names the attacker's own company as seller passes it. The loss is bounded by at most one automatic deposit within the per-tx cap and the shared window, plus cooling with an officer stop, and a founder release with evidence for the balance.
- **Exact-match sanctions screening** by design. Designator folding adds hits only.
- **No re-ordering** of the same web supplier after a failed bind; that would need a schema change.
- **A re-opened payee's order** holds budget again. The ALERT flags it, and the chain's line balance still bounds funding.
- **The worker and the API** each keep their own block-time cache.
- **The mock's** scripted deposit and the journey preset hints don't apply the window rule. The hints are display only; submit checks.
- **`next dev`** sends `'unsafe-eval'`. Use `dev:live --prod` for a production-like CSP.

## Verification after the fixes
| Check | Result |
|---|---|
| `pnpm -r test` | 4,410 passed, 0 failed |
| Typecheck | clean |
| `gen:schemas:check` | current |
| `test:contract` | 127 |
| Wording lint | 0 |
| Red team on Anvil (fixr-escrow, fixr-cfo) | 47 pass / 0 fail / 0 not run; all four bundles VERIFIED |

The full live suite and e2e are re-run on `6446024` before the PR (see `docs/decisions/int-final3.md`).
