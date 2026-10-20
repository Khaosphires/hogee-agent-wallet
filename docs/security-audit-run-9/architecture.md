# Hogee run-9 architecture (scoped: the chat-first revamp, db731b0..04924cd)

## 1. Product, principals, resources
- **What it does.** Hogee compiles a founder's signed business plan into an on-chain spending policy (Sepolia/Anvil; budget units, 1 BU = 100 minor, integer minor units). An AI agent then proposes spends inside that policy. The revamp makes one chat the home: it drafts the needs checklist, searches the web for suppliers, records the founder's chosen supplier and payment terms, pays them through milestone escrow, and runs an "AI CFO" that reports and tightens limits on its own.
- **The worker** (`apps/worker`) holds the agent, oracle, lender and relayer keys and is the only signer. New: the `cfo-guard` job (agent key, tighten-only).
- **The HTTP API** (`packages/api`, Hono, mounted in Next at `apps/web/app/api/[...route]/route.ts`) holds no chain key. It now holds the optional Tavily key (`TAVILY_API_KEY`, read only in `runtime/env.ts` into `ApiEnv.tavilyKey`, never into `ApiConfig`) and the model provider keys.
- **Principals:**
  - Anonymous callers read as the founder persona (demo design, accepted). Routes marked `personas: FOUNDER` refuse the officer; routes with no persona list (`getSupplierSearch`, `getOrderTerms`, `getCfoReport`, `getChat`) answer any caller.
  - A signed persona cookie plus an officer access code gives the officer persona.
  - The founder signs with a passkey (PlanApproval, SupplierApproval, MilestoneRelease, …). The officer can pause (tighten-only) and approve loosenings.
  - **Web listing authors** (new, untrusted): anyone who can publish a page on alibaba.com, made-in-china.com, globalsources.com or 1688.com (including subdomains such as `<seller>.en.made-in-china.com`). Their title, snippet and page text arrive through Tavily.
  - **Tavily** (the search provider) is a third party whose answer is untrusted data.
- **One facility per deployment** (`context.facilityId`); every table is keyed by facility. Chat sessions are per persona cookie.
- **Mock mode.** `MOCK_API=1` (`packages/api-mock`) is the in-process demo server that judges may run. It mirrors the contract. New: `MOCK_SCENARIO=fresh`, mock search/terms/CFO/journey.
- **Prior coverage.** Runs 1–8 audited contracts, the worker, the API, evals, evidence, G2, the SG takeover, the PII redactor and the checks client. Contracts are unchanged in this range.

## 2. New in this range (what to hunt)
1. **Web supplier search** (`packages/checks/src/{http,websearch}.ts`; `packages/api/src/services/{web-search,web-candidates}.ts`, `routes/search.ts`; `packages/core/src/search/*`):
   - `httpPostJson`: fixed host `api.tavily.com`, bearer key, no cookies, `redirect: "manual"`, 3xx refused, request and answer size caps, one retry on 429/5xx only.
   - `allowedListingUrl` (https, no port/userinfo/IP, host equals or ends with `.<listing domain>`, origin + path only), `parseTavilyBody` (one parser for live and recorded), `listingTextOf` (NFKC, strips `data:` URIs and markdown images, caps), `recordedSearch` (labelled "recorded sample", used only when no key is set), `webSupplierId`.
   - The query is built server-side from the COMMITTED plan's `productCategory` + `buyFrom` (`supplierQuery`), never founder text.
   - Limits: 1 in flight per process, 1/min per persona+client, 20/day per facility, identical READY search reused for 24h, model-budget headroom checked for results×2 Reader calls before Tavily (checked, not held: a declared deviation).
   - Per listing: text gates (core detector: AI_INJECTION, then OFF_PLATFORM_DISCOUNT for payment-redirect phrases) → quarantined Reader (recorded readings in recorded mode) → NO_SELLER / NO_PRICE / WORDING / CURRENCY → sanctions + registry checks → scorer. Sanctions unavailable fails the whole search. Web candidates are always `unverified`; price < 30% of the median gets `priceFlag`; MISSING_CERT is a hard gate for drinkware.
   - The row: `shortlists` with `source='web'`, `search_json`, `result_json`, `shortlist_hash`; supplier rows are insert-only.
2. **Terms → orders** (`packages/api/src/services/{supplier-terms,terms-checks,terms-candidate,terms-names}.ts`, `routes/orders.ts`, `signing/{supplier-approval,web-order}.ts`; `packages/core/src/escrow-terms/*`):
   - The payout account arrives ONLY via `submitOrderTerms` (REST form), channel fixed `MOCK_ONLY`; `payeeType: personal` refused; the holder needs a company designator plus a distinctive word shared with the Reader's seller name (`TERMS_HOLDER_MISMATCH`); holder + seller screened for sanctions at confirm, prepare and finalize (503 if screening cannot run).
   - `termsToSchedule` (pure): 1–8 milestones summing to 10000 bps, non-decreasing triggers ending `ON_DELIVERY_INSPECTED`, total whole BU ≤ free SUPPLIER pocket (minus open orders), floor rounding with remainder last, auto-release only `ON_ORDER` and first, web ≤ 1 auto milestone, each auto ≤ per-tx cap, 2·Σauto ≤ total, Σauto ≤ window. Re-run with CURRENT limits at confirm, prepare and finalize.
   - `planFor(refId)`: `terms-…` → `planWebOrder` (recomputes schedule, account hash, sanctions and `quoteHash` `{kind:"WEB_TERMS", …}` from the row), else `planOrder` (refuses web ids). Finalize re-plans by `req.ref_id`. Commit: `update … set status='USED' where status='CONFIRMED'` must change exactly one row, under a per-facility advisory lock. One order per web supplier (`order-w<12>-001`).
   - Rows are immutable apart from CONFIRMED → SUPERSEDED (correction) and CONFIRMED → USED.
3. **Chat orchestrator** (`packages/core/src/journey/*`, `packages/api/src/journey/*`, `routes/chat.ts`, `services/chat-store.ts`, `packages/agent/src/router/*`, `http/rate-limit.ts`):
   - `ChatBody` = `{sessionId, message}` | `{sessionId, action: ChatAction}`. Actions skip the LLM and redaction, have their own rate bucket (30/60/120 per minute per session/client/server), and each `actionId` (UUIDv7) is single-use per session (claimed under a session advisory lock before effects run).
   - Free text goes to `classifySkill` (one terminal tool, fixed `SKILLS` enum, redacted text ≤ 4000 chars). Text yields only read-only effects; no text path may reach `submitOrderTerms` or a signature; the `plan` skill after commit hands the message to the planner (a replan that still needs the founder's passkey).
   - Model text is never shown to the founder. Seller names and titles only travel in data parts or REST, never in text parts (because `turnOf` feeds text parts back to the model). Every part is `ChatDataPart.parse`d before it is written; history reads drop and trace a bad part.
   - `deriveJourney(facts)` gives the stage; effects are allowed only on the state BEFORE.
4. **AI CFO** (`packages/api/src/services/{cfo,revenue-ledger}.ts`, `routes/cfo.ts`; `apps/worker/src/jobs/{cfo-guard,cfo-guard-inputs}.ts`; `packages/core/src/cfo/*`; `services/sales.ts` wakes cfo-guard after each sale):
   - The report reads one snapshot block; any read error or `CfoInputError` → 502, never a partial report.
   - cfo-guard: proposals from core `proposeTightenings`, re-checked on the REAL mirrored context with `evaluateTighten` = AUTO and `strictlyTightens`; action id `cfo-guard:<chainDay>:<slot>` (one per line per chain day, any state uses it up); sent through the chain_actions outbox with the agent key.
5. **Web UI** (`apps/web/components/chat/**`, `components/cfo/**`, restyled `components/{ui,shell,ledger,sign,plan,suppliers,timeline,evidence,officer}/*`, `lib/journey-client.ts`, `lib/api/queries.ts`): candidate cards link listing URLs (https, listing hosts only, `rel="noopener noreferrer nofollow"`), the enquiry card copies templated text to the clipboard, one `SignHost` owns the SignDialog, the terms card posts the payout form, the order card shows the schedule, cooling countdown and release.
6. **Mock parity** (`packages/api-mock/src/{journey/*,features/{search,orders,cfo}.ts,chat.ts,signing.ts,store.ts,env.ts}`): the same core pipeline, recorded search, terms held in a `WeakMap`, no sanctions list in the mock, scripted deposit after cooling, a CFO "sample" sales series.
7. **Operator tooling** (`scripts/redteam/src/**` WEB world on Anvil only; `scripts/dev-live/src/seed-sales.ts` refuses non-Anvil; `evals/scripts/journey/*`).

## 3. Trust boundaries in scope
| From | To |
|---|---|
| Web listing authors (title, snippet, page text, URL) via Tavily | the Reader model, the classifier/planner, chat text parts, stored rows, browser links and markup |
| Tavily answer (third party) | the parser, size caps, the API process |
| The API process | Tavily (`api.tavily.com` only; the key; no founder text or PII in the query) |
| Founder chat text | the router model; never `submitOrderTerms`, a payout account or a signature |
| Founder REST form (payout account) | the terms row, `quoteHash`, the signed SupplierApproval, the escrow payee |
| A listing's seller name | the holder-name check (which the founder's account must match) |
| Anonymous or founder persona | another chat session, another facility's rows, officer-only actions |
| Chat action replay / concurrent presses | single-use actionId, stage guards, the USED commit |
| Confirmed terms row | prepare → finalize (no change in between: schedule, account, quote) |
| DB mirror rows (sales, payments) | cfo-guard's tightenings (never loosen) |
| Process-wide limits and budgets | any caller (denial of wallet on Tavily and the model) |
| Mock state | anything a judge could mistake for a live payout or a live check |

## 4. Accepted and known (not findings unless this range makes them worse than stated)
- The founder persona is anonymous by demo design; there is one facility per deployment.
- SG payouts are simulated (`MOCK_ONLY` channel, "simulated payout").
- Budgets and limiters are per process and reset on restart; behind the Next mount the per-client limit acts as a second server-wide limit.
- The red-team runner, dev-live and the eval scripts are operator tooling on the operator's machine. A finding there needs a concrete effect on real keys, real funds or a shared deployment.
- **Builder-declared limits (VISION-WAVE1-NOTES; known, but verify each is bounded as claimed):**
  1. A listing that names the attacker's own company as seller passes the holder-name check by construction. Claimed bound: the account only comes from the founder's form; sanctions screening; the full account number is shown in the signed panel; at most 1 auto milestone ≤ the per-tx cap; cooling with an officer stop; balance only on founder release plus evidence.
  2. The worker does not re-screen sanctions at payout (screened at confirm, prepare and finalize; static list).
  3. A reverted `bindPayee` leaves that web supplier blocked (one order per web supplier).
  4. Insert-only supplier rows: a renamed listing gives `TERMS_CANDIDATE` (fails closed).
  5. Bank name and quantity are shown at signing but are not in `quoteHash`.
  6. The model budget is CHECKED (headroom for 20 Reader calls) before Tavily, not held.
  7. Wording failures omit the listing rather than show "(name hidden)".
  8. With no Tavily key, the deploy serves the labelled recorded sample.
  9. Someone with DB write access can forge spend rows and make cfo-guard tighten (claimed bound: at most one lower limit per line per chain day, never a loosening, traced, with a tx).
  10. `parseTermsHint` can read a stray "30 70" as a split (prefill only; the form re-checks).
  11. Injection detection (heuristic layer) excludes ~40% of blind attacks; the defence relies on the layers above, not the detector.

## 5. Execution policy
Source only. macOS cannot enforce the required sandbox limits, so no target code runs, and every check is `method: source`. Never probe live endpoints, never touch Sepolia, never open `.env*` files.
