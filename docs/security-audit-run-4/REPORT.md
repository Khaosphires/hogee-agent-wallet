# Security audit run-4: Hogee task 1.12 live API and worker jobs

## 1. Run, scope and limits
- **Profile:** `quick`, scoped. **This is a partial pass.**
  - Scope: the diff `3e05b82..dd824df`, which covers the live HTTP API (`packages/api`, mounted by `apps/web/app/api/[...route]/route.ts`), the worker jobs it wakes (relay, record-sale, agent-actions, timelock-executor, stage-gate, sync), and the settle rework.
  - Code audited in runs 1–3 was read only to interpret this diff.
  - Source ref: `dd824df` (branch `p1/dev`), reviewed in a clean, detached, read-only worktree.
- **Execution:**
  - Sandboxed source-and-local-only policy.
  - **No target code was executed.** macOS cannot enforce the required memory, disk and file-size limits, and no reviewed promotion code exists.
  - Every check is source-only, so no record can reach `confirmed`.
- **Budget:** none set. Agents spent:
  - 2 reconnaissance;
  - 7 hunters, one wave (one re-emitted its result to add a missing schema field);
  - 8 verifiers, each doing Phase 3 and Phase 5 merged;
  - 1 final coverage critic.
- **Prior runs:** runs 1–3 had no confirmed records.
  - Run-3's leads v-1..v-4 were re-checked by reused units. The final critic marks all four **resolved in current source**:
    - orphan funding watch;
    - pause done once signed;
    - payout bound to the on-chain spend;
    - rail destination bound to the committed hash.
  - Run-3's deferred gaps now in scope were assigned and covered: DB write principals, `DEPLOYMENT_FILE` provenance, hot oracle/lender keys. The hot-keys unit produced lead 1 below.
  - Contract-only units (observer veto separation, escrow cooling v-5) are unchanged and `out_of_scope`. The rejected run-3 v-6 was not re-raised.
- **Deferred:** the critic accepted 2 in-scope gaps. Quick profile runs no second wave, so both stay open:
  - (a) the worker's chain-to-DB status mirror (`apps/worker/src/jobs/sync.ts`) as a surface in its own right;
  - (b) liveness of the safety jobs under the single global job lock with 8 queues on one-minute crons, plus oracle-key load from the any-persona `POST /api/demo/sale`.
- **Out of scope:** 60 earlier units whose source is unchanged in this range.

## 2. Security posture
- **The core design holds in source.** The API holds no key. Every row the worker signs is re-derived and re-checked against the committed plan and the chain before signing. Founder authority rests on an EIP-712 signature verified against the on-chain key. The webhook, persona cookie, officer token and typed-data binding are all built carefully.
- **The six leads are all edge paths:**
  - races between the DB status and the chain (veto);
  - executions the worker did not submit (a copied founder call, an oracle confirm from outside the worker);
  - a bootstrap ordering gap (first-come passkey enrolment);
  - a missing streamed body limit;
  - a cadence rule enforced only on the tick path.
- No source path lets a lower-trust caller redirect funds to a payee the founder did not approve.

## 3. Confirmed findings
None. A source-only pass cannot meet the `confirmed` evidence bar.

## 4. Needs validation (leads, no severity)
| # | Lead | Trace (entry → sink) | Decisive blocker | Bounded local next step | Owner check |
|---|---|---|---|---|---|
| 1 | An oracle-key confirm sent outside the worker closes a payment SETTLED with no payout; nothing halts (`settle-decide.ts:decideSettlement:onchain-confirmed-without-rail-payout-closes-settled`) | `Treasury.sol:246` → `settle-decide.ts:105` → `settle.ts:199` | Execution; whether hot oracle-key compromise is in the threat model | Unit: `decideSettlement(facts({chainState:'CONFIRMED'}))`. Live: outside `confirmSettlement`, then reconcile + settle on Anvil + Postgres | Where the oracle key lives; whether outside oracle/lender use must halt |
| 2 | A copied founder-signed OwnerSpend or MilestoneRelease opens a settlement the worker never pays or fails (`settle.ts:loadRows:third-party-executed-founder-signed-settlement-never-adopted`) | `Treasury.sol:325` → `settle.ts:72` | Execution; whether the relayer's pending tx is visible to third parties | Anvil, no automine: front-run the relayer's tx from a second EOA, then settle | Public mempool visibility on Sepolia, read-only |
| 3 | Body-size caps trust Content-Length, so a chunked body is buffered in full (`register.ts:readBody:size-cap-trusts-content-length`) | `route.ts:46` → `register.ts:67/75/78` → `suppliers.ts:90` | Execution; whether Next 16.4 or undici limit chunked bodies | Stream an over-cap body with no Content-Length into `createApiApp` and count the bytes read | Bind address, `HOGEE_ALLOWED_HOSTS`, any proxy limits |
| 4 | A veto marks a loosening CANCELLED before the on-chain cancel; a cancel simulated before the in-flight queueLoosen lands is refused for good and never reconciled (`exceptions.ts:veto:cancelled-before-onchain-cancel-never-reconciled`) | `exceptions.ts:143` → `relay.ts:78/90` → `sync.ts:104` → `TreasuryGovernance.sol:129` | Execution (two-tx ordering); `eth_estimateGas` default block; revert-data decoding | Anvil `--no-mining`: approve, relay, veto, relay, mine, sync, execute from an unrelated EOA | Read-only: CANCELLED rows whose `queuedLoosen(loosen_id)` is QUEUED or EXECUTED |
| 5 | Any client that reaches the API can take the founder passkey slot with a synthetic attestation-none registration (`passkey.ts:verify:first-registration-not-bound-to-founder-session`) | `routes.ts:92` → `persona.ts:17` → `passkey.ts:73` | Execution; who else can reach the API between `facility/open` and the founder's registration; product intent | Anonymous options + synthetic verify, then a founder verify refused with `FounderKeyAlreadySet` | Tunnels or hosts in `HOGEE_ALLOWED_HOSTS`; other local users |
| 6 | proposeSpend pays consecutive pacing slots back to back; only the tick enforces one slot per line per day (`spend-proposal.ts:evaluatePacingSpend:no-pacing-period-check`) | `proposals.ts:76` → `spend-proposal.ts:79` → `TreasuryState.sol:287` | Execution; whether `pacing.period: 'day'` binds every agent spend | DEMO_MODE on Anvil: propose slots s..s+8 in one chain day, then one agent-actions pass | Whether `DEMO_MODE=1` runs while agent-actions signs on Sepolia |

Full traces, evidence and plans: `NEEDS-VALIDATION.md`.

**Rejected** (kept so they are not re-raised without new evidence):
- `proposals.ts:propose:recordDenied-for-state-and-duplicate-denials`. The only effect is a tighten-only line circuit that the same caller can already trip through intended paths. It is a robustness bug, not a boundary violation.
- `suppliers.ts:uploadInspection:evidence-hash-overwritable-while-release-pending`. Unreachable at `dd824df`: no escrow milestone can exist while `@hogee/checks` are stubs. **Re-audit when P3's checks land.**

## 5. Hardening and positive patterns
52 hunter hardening notes are in `hardening.generated.md`. The most material:
- the demo reset deletes worker halts and nonces without `clearHalt`'s checks;
- `POST /api/demo/sale` is open to any persona and feeds oracle-recorded revenue;
- officer-token lockout DoS and unbounded ALERT traces;
- a stateless officer cookie shared across localhost ports;
- chat LLM spend with no rate limit (latent until P3's `redact` lands);
- currency taken from `facilities.currency`, which is a DB value;
- the mock rail's history is a DB table;
- lender-key outside use is not alerted while halted;
- `recordDenied`'s lineId and reasonCode are not bound to the denial row.

Positive source patterns:
- **Signing gate:** one per-kind signing gate (`signAndStore`: binding, simulation, fee cap, allocator nonce inside the row lock).
- **Re-derivation:** every founder struct is re-derived from stored rows and compared at submit.
- **Webhook:** constant-time, deduplicated Stripe webhook.
- **Settlement:** payouts bound to the finalized on-chain event and the committed destination.
- **Halts and pause:** acknowledged halts; a safety pause driven from chain state.

## 6. Coverage
- **Ledger:** 84 units:
  - 14 covered;
  - 8 candidate (6 needs_validation and 2 rejected final records, after consolidating 2 duplicate root causes);
  - 2 deferred (critic gaps);
  - 60 out of scope;
  - 0 blocked.
- **Final critic:** `stop: false` with 2 accepted missing units, no reassignments, and 4 prior leads resolved.
- **Validators:** both pass (`validate-findings.cjs`: 8 records; `validate-coverage-ledger.cjs`: 84 units).
- This run does not exhaust the target. The deferred units and a deep or executed pass remain.
