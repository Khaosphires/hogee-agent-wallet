# Security audit run-9: Hogee chat-first revamp (web supplier search, terms → web orders, chat orchestrator, AI CFO, chat UI, mock parity)

## 1. Run, scope and limits
- **Profile:** `quick`, scoped. **This is a partial pass.**
- **Scope:** `db731b0..04924cd`, the 19 Oct chat-first revamp (420 files, about 40k lines; 281 changed source files). Source only; tests, fixtures, data, docs and generated schemas were context. It covers:
  - the Tavily client and parser (`checks/src/{http,websearch}.ts`) and key handling;
  - web search: service, limits, budget and the candidate pipeline (`services/{web-search,web-candidates}.ts`, `core/src/search/*`);
  - terms and web orders (`services/{supplier-terms,terms-checks,terms-candidate,terms-names}.ts`, `core/src/escrow-terms/*`, `signing/{supplier-approval,web-order}.ts`);
  - the chat orchestrator (`core/src/journey/*`, `api/src/journey/*`, `routes/chat.ts`, `chat-store.ts`, `agent/src/router/*`, the action rate bucket);
  - the AI CFO (`services/{cfo,revenue-ledger}.ts`, `worker/jobs/cfo-guard*.ts`, `core/src/cfo/*`);
  - the chat cards and sign flow;
  - mock parity.
- **Source ref:** `04924cd`, from a clean, detached, read-only worktree.
- **Execution:** source only. **No target code was executed** (macOS cannot enforce the required sandbox limits; no live endpoint, Sepolia or `.env*` file was touched). A source-only pass cannot meet the `confirmed` bar, so every surviving lead is `needs_validation` with **no severity**. §4 gives a parent-side **fix priority** instead, which is a triage order, not a severity.
- **Agents:** 8 hunters in one wave (`h-websearch`, `h-search`, `h-terms`, `h-signing`, `h-chat`, `h-cfo`, `h-web`, `h-mock`; 24 units: 15 new and 9 prior units reassigned because their source or inputs changed). 9 verifiers, one per candidate (Phase 3 and Phase 5 merged). 1 final coverage critic. No budget was set.
- **Prior runs:** runs 1–8 have no confirmed records. Run-8's lead was fixed in a146f48. Run-8 rejected "sanctions screen only the display name" because no lower-trust principal wrote supplier names. **That premise no longer holds for web suppliers**, so sanctions was re-audited (v-6, v-9).

## 2. Security posture
As far as the source shows:
- **Payee:** the account comes only from `submitOrderTerms`. Chat, listing text and model output never reach it. The channel is fixed to `MOCK_ONLY`, and personal payees are refused.
- **Signed = committed:** `planWebOrder` recomputes the schedule, the account hash (JCS + keccak against the stored columns), sanctions and `quoteHash` with the CURRENT limits at prepare and finalize. Finalize re-plans by `req.ref_id`. The USED commit changes exactly one row under the per-facility lock. One order per web supplier. Catalog and web refs cannot cross over.
- **Auto-release:** at most one auto milestone, only `ON_ORDER` and first, ≤ per-tx cap, 2·Σauto ≤ total, Σauto ≤ window. Rounding never grows the upfront part. Held milestones need a founder release with stored evidence.
- **Chat:** no text path reaches `submitOrderTerms`, an account or a signature. Model text is never shown. Seller names never enter text parts. `actionId` is claimed under the session lock before effects run. Ids resolve only to this facility's live rows. Router ranks and views are clamped.
- **Tavily:** fixed host, no redirects, size caps, at most one retry (429/5xx). The key never reaches a log, row, trace or browser, and `tvly-` is masked. The query comes only from two enums of the committed plan. Failure stores `PROVIDER_DOWN`, with no silent recorded fallback.
- **URLs:** `allowedListingUrl` refuses look-alike, punycode, userinfo, port, IP and trailing-dot hosts. Supplier ids derive only from the canonical URL. Cards link https listing hosts with `noopener noreferrer nofollow`. No web string reaches an HTML sink, and the clipboard gets templated text only.
- **cfo-guard:** tighten-only. Proposals are re-checked with `evaluateTighten` on the real context plus `strictlyTightens`. One slot per line per chain day. A read error sends nothing.
- **Declared limits 1–11** are bounded as claimed, with two qualifications:
  - the holder check (1) compares typed strings only, so anyone knowing the seller name passes, and short syllables count as distinctive;
  - a reverted `bindPayee` (3) also keeps the order's unfunded amount subtracted from the free pocket (critic gap 1).

## 3. Confirmed findings
None.

## 4. Needs validation (5; `NEEDS-VALIDATION.md`)
| Priority | Fingerprint | Lead | Smallest fix |
|---|---|---|---|
| 1 (external principal) | `web-candidates/scoreWebAnswer/unscreenable-seller-name-fails-whole-search` | A seller name made only of letters the screener discards (U+02B9–U+02BF, U+02C8, U+0640, Hangul fillers) passes `isSellerName` (`core/src/search/assemble.ts:98-106`). `screenSanctions` then throws `CheckInputError` (`checks/src/sanctions.ts:214`), and the bare catch at `api/src/services/web-candidates.ts:217-218` fails the WHOLE search as `SANCTIONS_UNAVAILABLE` for every founder with the same query (the catalog fallback remains). Blocker: whether the live Reader returns such a name. | Screen each listing separately; map `CheckInputError` to omitting that listing (`NO_SELLER`). Require `nameKeys(name).length > 0` in `isSellerName`. Strip `\p{Cc}`: U+0000 breaks the jsonb write in `storeReady`, the same class. |
| 2 | `packages/api/src/services/chat-store.ts:loadMessages:chat-session-history-unbounded` | Budget-free actions (30/min per session) store 2 messages each with no cap or retention (`chat-store.ts:141`). `loadMessages` has no LIMIT (`:27`). `GET /api/chat/:sessionId` has no limit or paging (`routes/chat.ts:61`; `register.ts:171` re-validates the whole array). Presses re-read the history, quadratically (`core/src/journey/history.ts:88`). Blockers: cost at 10k–86k messages; reachability. | Cap messages per session; read the last N rows; page `getChat`; add the action writer to the founder writer bounds. |
| 3 | `apps/worker/src/jobs/cfo-guard-inputs.ts:readGuardInputs:all-history-block-times-under-job-lock` | Each pass dates all-time records (`:82,:104`) with uncached `getBlock` calls (`:53`) under the single job lock (`runtime/lock.ts:30`), and every sale wakes it (`api/src/services/sales.ts:222`). Reconcile, settle and relay (including the officer's `Treasury.pause`) are skipped meanwhile. Blockers: RPC latency and quota; DEMO_MODE reachability. | Store `block_time` per row or cache it persistently; read a 30-day window plus totals; give the pass a deadline; consider not sharing the lock with relay and reconcile. |
| 4 (pre-existing; deployment-dependent) | `packages/api/src/routes/demo-sale.ts:demoSale:unbounded-oracle-recordSale-spend` | `POST /api/demo/sale` has no persona or limiter (`register.ts:166`). `relay.ts:96` signs every `recordSale` with the oracle key, with no per-pass cap, on the nonce sequence settlement shares. Each sale now also wakes cfo-guard. Both documented topologies are localhost. | Rate-limit `demoSale`; cap `recordSale` rows per pass; keep a settlement gas reserve. |
| 5 (mock) | `api-mock/signing.ts:applySupplierApproval:catalog-order-not-bound-to-signed-struct` | The mock re-derives the catalog order at submit (`api-mock/src/signing.ts:398-405`) and never compares it with the signed `scheduleHash`/`totalMinor` (`:351`). A reallocation in between funds an unsigned schedule. Live refuses. | Keep the planned order on the request, or re-plan and refuse on any field mismatch (as live finalize does). |

## 5. Rejected by independent verification (4)
| Fingerprint | Why rejected | Hardening |
|---|---|---|
| `checks:sanctions:designator-synonyms-not-folded` | The gap is real (`sanctions.ts:62-80`), but screening is exact-match by design: a self-named seller can already dodge with any small change. The range only added hits, and payouts are simulated. | Fold the designator set that `terms-names.ts:13-19` accepts into one canonical token, on both list and query side. |
| `api-mock/supplier-order.ts:supplierOrderFor:existing-order-rank-one-fallback` | Only the founder, with their own passkey over a panel naming that supplier, can do it; no UI path emits it. | Refuse `order-w…` ids; drop the `?? rankOne` fallback. |
| `api-mock/features/orders.ts:mockLimits:fresh-no-pocket-ignores-paid-milestones` | The window claim is refuted. The rest is the founder's own simulated budget; live and the contract enforce the cap. | Track paid milestones, or create pockets in `freshState`. |
| `api-mock/country.ts:baseDraftIdOf:preview-of-preview-signable` | Same lines, caps, payees and totals as the base draft; needs the founder's passkey; mock only. | Record preview provenance. |

## 6. Hardening (49 notes; `hardening.generated.md`)
**Before the PR:**
- **Signing panel:**
  - the web SupplierApproval holder, full account and milestone amounts appear only in the server description; the verified rows show hashes (`apps/web/lib/signed-rows.ts:87-98`);
  - `holderName`/`bankName` free text sits in the same "Pays out to" value as the account digits (`signing/web-order.ts:153`), so a decoy account number is possible;
  - C1 controls, U+2028/2029 and Hangul fillers are accepted (`supplier-terms.ts:45`);
  - fix: plain-name patterns, a separate bank row, and recompute `payoutAccountHash` client-side.
- **Holder check:** require distinctive words of ≥ 4 letters or a syllable stop list (`terms-names.ts:71`).
- **Search state:**
  - `storeReady` can flip a FAILED (stale) search to READY;
  - the `priceFlag` median includes excluded listings;
  - registry ids copied from listings score points.
- **Terms binding:** `webCandidateOf` does not bind to the CURRENT committed plan (7-day window after a replan).
- **Budget accounting:** catalog `planOrder` does not subtract open web orders.
- **Web:** `search-view.ts:117` should return origin + path; add `script-src`/`object-src` to the CSP.
- **Mock:**
  - REPLAY CFO sample data is unlabelled;
  - MY settlement wording appears on MOCK_ONLY payouts;
  - the mock lacks `\p{Cf}` refusal and the terms writer bound.
- **cfo-guard:** the DENY trace repeats every pass.

**Accepted:** exact-match sanctions; declared limits 1, 2, 6 and 8.

## 7. Coverage
- **Ledger:** 147 units: 16 covered, 8 candidate (9 fingerprints), 3 deferred, 120 out of scope.
- **Final critic:** `stop: false`. 3 missing units, all inside the scoped diff, deferred (quick profile):
  1. **Unbound web orders.** When `bindPayee` never lands, the payee stays PENDING forever. Its amount stays subtracted from the free pocket (`terms-checks.ts:119-128`), the supplier stays blocked, and the chat stays at ORDER_PENDING. No writer moves it out (`apps/worker/src/jobs/sync.ts:93-105`).
  2. **Sign-card selection.** `api/src/journey/facts.ts` `termsFacts` picks the newest terms row of the whole facility (`:92-100`), not the session's own `termsId`.
  3. **REPLAY explorer links.** `useLinksToExplorer` is true in replay, so mock-minted hashes for web deposits and signatures render as public-explorer links.

  Parent-flagged fourth gap: the unchanged worker milestone funding and release path, which now receives web schedules of 1–8 milestones. All four go to the post-fix skills re-check.
- **Not covered:** the v-design restyle and CFO web components (beyond link sinks), `core/needs`, the new core schemas (context only), migration 0004, and the red-team, dev-live and eval tooling.
- **Validators:** both pass (9 records; 147 units).
- **Scope limit:** this run covers only the scoped diff and does not exhaust the target.
