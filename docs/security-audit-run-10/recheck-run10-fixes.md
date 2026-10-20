# Run-10 post-fix skills re-check (19 Oct 2026)

**Scope:** `6dc22f0..8b90cc9`, source only. This is the UX revamp, the Sample business and the chat quick replies, after
the six run-10 leads were fixed (fix10-worker, fix10-seal, fix10-proof, fix10-mock) and the officer request rows were
given their detail (fix10-officer). Three independent reviewers each loaded one skill and read a detached, read-only
snapshot. Nothing was executed against live endpoints, Sepolia or `.env*`.

## Results
| Skill | Critical | High | Medium | Low |
|---|---|---|---|---|
| `security-review` (web + mock) | 0 | 0 | 1 | 4 |
| `nodejs-keccak256` (hashes, digests, hex) | 0 | 0 | 0 | 4 |
| `llm-trading-agent-security` (worker, chat, kill switch) | 0 | 0 | 2 | 5 |

One LOW item was found twice (mock submit txs repeat across store builds: W-3 = H-3). Verdicts on the five run-10 fixes:
four closed their lead; fix10-seal closed the sample path but relied on unique mock txs (W-3, now fixed); fix10-worker
had one regression (A-1, now fixed). The reviewers found no path from chat, listing or web text to an amount, payee or
limit: every money change still needs the founder's passkey over rows the server built.

## Fixed
**MEDIUM W-1: mock catalog funding ignored the pause, the pocket state and the outflow bound.** (rcfix-mock)
- A catalog sample or deposit is funded only when nothing is paused or tripped and the released stages and the
  officer's funding cover it; otherwise it stays unfunded, as the chain's fundMilestone would refuse it.
- A catalog balance whose funding breaks a rule is refused (Paused, CircuitOpen or CapExceeded).

**MEDIUM A-1: reconcile gave way to the safety pause's own rows** (a regression of fix10-worker). (rcfix-worker)
- Only rows the relay delivers count as a pending tighten; the relay no longer takes safety-pause attempts at all, so
  reconcile alone signs them (lender key first, at the safety fee cap).

**MEDIUM A-2: agent spends were still signed while a pause was on its way.** (rcfix-worker)
- Before the agent key signs a payment, the worker refuses while a Treasury.pause of the deployment is PENDING,
  BROADCAST or INCLUDED without a revert; the spend waits for the next pass (PAUSE_PENDING), as while halted.

**LOW items**
- **W-2** (rcfix-mock): a mock MilestoneRelease submit is rebuilt and refused with CONFLICT when any signed field
  changed (a second tab, or evidence re-uploaded); nothing is traced or paid.
- **W-3 = H-3** (rcfix-mock): each mock store build has a random nonce that salts its submit txs.
- **W-4** (rcfix-autonomy, P1): founder-signed payments (RELEASE_MILESTONE, OWNER_SPEND) are her signature, never also
  an AI payment, in the live and mock counters and the officer feed. The `final-2` figure in the submission docs is now
  2 agent transactions for 6 human signatures (the counter read 3 at export).
- **W-5** (rcfix-seal): a tab whose mock store was rebuilt says "The demo data changed since you signed. Reload to see
  it." instead of promising an update; its stub stops polling.
- **H-1** (rcfix-proof): the verifier fails a manifest contract that contracts.json does not name.
- **H-2** (rcfix-proof): the Proof page hashes the served bytes, as `make verify` does.
- **H-4** (rcfix-officer, rcfix-mock, P1): a balance-release request must name the inspection recorded on its
  milestone (live and mock; re-checked when the founder approves it), and the officer sees the full 66-character code.
- **A-3** (rcfix-worker): the officer's or founder's pause is signed with the lender key first.
- **A-4** (rcfix-seal): the order card says "Pausing…" until the chain is paused.
- **A-5** (rcfix-worker): cfo-guard waits up to 20 s for the job lock and gives way to a pending pause.
- **A-6** (rcfix-journey): "Signed. The balance is paid once it's saved." needs the server's release row.
- **A-7** (rcfix-journey): "What do I do now?" reads the treasury's pause.

## Not fixed (accepted or left for later)
- The relay signs the officer's pause and cancelLoosen at the routine fee cap, not the safety pause's higher cap.
  Raising it lets any requester spend more on fees: left as a product decision.
- The COOLING and OPERATING status replies (e.g. "status of my order") still say the deposit is paid automatically
  during a pause; only the next-step answer reads it.
- On orders with two held milestones, a late release hint after the first release reads "not seen" in live and
  "Signed" in the mock; both have a server fact behind them.
- A rebuilt mock store that reuses an unused terms id still leaves that tab saying it updates by itself.
- In the fresh and default mock scenarios the "signed by a person" counter does not move (seeded stats).
- With cfo-guard waiting, the worker pool fits exactly (4 waiters + 1 holder + 3 free = 8): another waiter needs a
  bigger pool.
