# Post-fix security re-check of the task 1.13 eval routes (HEAD d43bb01)

I found no HIGH issues. There is one MEDIUM, which is latent: it is a known run-2 weakness that one of the fixes switches back on. There are also three LOW issues and one residual spend gap. I checked the source only: I ran no builds or tests and edited no files. The working tree matches `d43bb01` for `packages/` and `apps/`.

## Findings

### MEDIUM (latent): registry trust now counts, but "validated" only means the id is well-formed
- **Where:** `packages/api/src/services/shortlist.ts:39-43` feeds `packages/core/src/scorer/criteria.ts:122-134`. The validators in `packages/checks/src/index.ts:35-45` are offline format and checksum checks.
- **Binding:** it is gated as run-2 required: `valid === true`, the exact id, and the same `supplierId`. But `check()` builds that binding from the same supplier record in the same function, so it only stops results being mixed up between suppliers. It cannot catch a forged id.
- **Failure scenario:** once P3 ships `validateUSCC`, a fake CN supplier copies a real factory's public USCC (or computes a valid check digit). It has 4 years on the platform and a 4.5 rating. Its trust is 3,000 + 3,200 + 1,800 = 8,000 bps (up to 9,000), against 7,500 for an honest supplier with tier-2 verification evidence.
- That is run-2's v-1 inversion again, with a well-formed id instead of `NOT-A-USCC`. Run-2 itself warned that a checksum-only validator doesn't tie an id to a supplier.
- Before `d8d0518` these points were never awarded. The core test `scorer-trust.test.ts:35` deliberately accepts 8,200 with valid checks, so this is accepted design that is now live in the product and in E3.
- **Limits:** injected suppliers are still excluded by the hard gates. Today the validator stubs throw, so shortlists fail closed. The impact is on ranking only; the founder still signs, and escrow and cooling still apply.
- **Smallest fix:** cap the result of `listingTrustBps` at `TIER_SCORE_BPS.tier2 - 1` until registry points come from a lookup that matches the supplier's legal name. Extend the property test to cover "validator-valid ids plus any metrics still score below tier-2".

### LOW 1: a failed listing read is still cached until restart
- **Where:** `files.ts:53-55,68`, `catalog.ts:46,49`, `eval-data.ts:88`.
- `readListingText` returns null instead of throwing, so the load succeeds and is cached with a null-text fixture.
- **Failure scenario:** P3 adds or fixes `data/suppliers/demo/raw/c.txt` after the first shortlist, or there is a brief EACCES or EMFILE error. From then on every product shortlist is FAILED, and that eval set returns NOT_FOUND, until restart, even though the file is now fine.
- The same happens with a null country pack (`catalog.ts:36-41`) and an oversized jsonl (`eval-data.ts:32`).
- This is what run-5 item 2 described, minus the rejected-promise case. It fails closed, so it costs availability only.
- **Fix:** add a `keep(value)` predicate to `cachedLoad`, and drop results with any null `listingText` or a null pack.

### LOW 2: the other dataset files are still read without containment, and with the cap a hang becomes a permanent lockout
- **Where:**
  - supplier JSON: `files.ts:63`
  - jsonl: `eval-data.ts:32-36`. `stat` follows symlinks, and a character device reports size 0, so it passes the size check.
  - `spec.json`: `eval-data.ts:82`
  - country pack: `catalog.ts:37`
- **Failure scenario:** git can store symlinks, so a dataset PR can commit `data/suppliers/eval/set-01/spec.json -> /dev/tty`. That blocks forever while the server has a terminal; a link to `/dev/zero` reads about 2 GB before Node gives up.
- `cachedLoad` caches the pending promise, so every request for that set waits on it. Two such E3 requests hold both eval slots for good, and every `/api/eval/*` call returns 503 `EVAL_BUSY` until restart. A link under `demo/*.json` stalls the product shortlist the same way.
- This is the same dataset-author threat that drove fix 2.
- **Fix:** read every dataset file through one shared helper with the checks `readListingText` already does (realpath containment, regular file, size cap).

### LOW 3: the in-flight cap has no deadline
- **Where:** `routes/eval.ts:84-96`. There is no `abortSignal` on `generateText` (`planner.ts:190`, `reader.ts:121`, `rank-listings.ts:65`), and the API pg pool sets no connect or statement timeout (`packages/db/src/index.ts:31`).
- The `finally` releases the slot on every path that finishes, but nothing makes a request finish.
- **Failure scenario:** the model provider stalls. Each call can wait under undici's 300 s defaults, with up to 2 SDK retries, across up to 24 E2 calls in a row; waiting for a pool connection can hang indefinitely. Two such requests block all eval routes.
- **Fix:** give every eval model call an `AbortSignal.timeout(...)` deadline and set `connectionTimeoutMillis` on the pool. Keep the slot held until the aborted work has actually stopped, so the spend cap stays honest.

### Residual (not a regression): the cap limits concurrency, not total spend
- Back-to-back requests are unbounded. Each E3 `llm_rank` request sends up to 12 × 20,000 chars; each E2 request can make 24 planner calls.
- `POST /api/chat` has no cap (the founder persona is open to anyone in DEMO_MODE), and the E1 chat vector is a subset of it, so the eval cap doesn't bound total spend.
- This stays latent while the redaction stub throws. The deferred spend item is only partly closed.

## Verified correct
1. **Eval traces are measurements, not decisions:**
   - `appendEvalTrace` (`traces.ts:83-96`) strips the policy verdict both in the type and at runtime, and requires the `[eval ` prefix. All eval writers use it.
   - E1 now writes `TOOL_CALL` with no verdict.
   - The autonomy stats (`dashboard.ts:159`) and the timeline (`payments-view.ts:142,151`) exclude by that prefix. Older eval rows already started with `[eval E1`, so they are excluded too.
   - No product or worker trace summary can start with `[eval `: all are templates with fixed or enum prefixes, including the chat reply summary. Real decisions are counted as before.
   - Lookup by trace id still returns eval runs. Hash chains are per trace id, so hiding whole eval traces breaks no chain.
2. **Listing-text containment:**
   - Absolute paths and `..` are refused, then the path must be inside `data/suppliers` both before and after realpath of the target and the root. Symlinks, including a symlinked data dir, are handled safely.
   - Only regular files under 256 KiB are read. A missing file (ENOENT) or any other error reads as null.
   - Product and eval `rawTextRef` values still resolve under the default `findDataDir`. A `HOGEE_DATA_DIR` not named `data` now fails closed instead of reading "".
   - The `setId` cache is bounded by the contract regex `^set-[0-9]{2}$`.
3. **Shortlist fails closed when listing text is unreadable:** the check runs after the buyFrom filter and before scoring (`shortlist.ts:91-95`), on the product path and in both E3 modes. `candidateOf` also throws on null as a second guard. The 20,000-char cut matches what every consumer sees, so no text beyond the scanned prefix is used anywhere.
4. **Registry checks bound to the supplier:** the hard gates still apply before scoring, so registry trust cannot rescue an injected supplier. LEI ids are never checked, so they never earn points.
5. **E3 filters by `spec.buyFrom`:** `forSpec` is shared with the product. Both E3 modes use the filtered list, and an empty result is NOT_FOUND.
6. **Payout hash:**
   - The check runs in both `prepare` and `finalize`.
   - It uses core `payoutAccountHash`, which is `@noble` `keccak_256` over the JCS of exactly `{channel, accountNumber, holderName}`. The shortlist candidate hash comes from the same function.
   - The commit stores `jcs(o.account)` together with the candidate hash. The worker's `parsePayoutAccountRef` requires canonical JCS, and `verifyDestination` recomputes the same hash.
   - No NIST `sha3-256` is used in core, api or worker.
7. **Concurrency cap:**
   - There is one app instance per process (the module-level app in `apps/web/app/api/[...route]/route.ts`).
   - Check and increment happen synchronously, so there is no race. A rejected request is turned away before the increment, and `finally` decrements on every path that finishes.
   - The rejection is 503 `UPSTREAM` with `EVAL_BUSY`. `UPSTREAM` is declared for all three routes (`routes.ts:248-258`), and `register.ts:46,56` honours the status override.
8. **Shortlist checks before the transaction:** `computeShortlist` holds no database client. The transaction only stores the same fixtures that were ranked. Currency comes from `requireFacility`, the same source as before. `startShortlist` is the only caller.
9. **Eval invariants:** the eval services and everything they call write only to traces and `llm_calls`. There is no `storeDraft`, `storeSuppliers`, `insertAction` or queue send, and no signing. The planner gets no ports, so its only tool is the read-only country pack. "Would execute" is an `eth_call` from the agent address. `CHAIN !== local` returns NOT_FOUND before the cap, and the demo-only gate and the Host/Origin guard both run before the handler.
10. **Model calls per request:**

| Route | Model calls per request |
|---|---|
| E2 | up to 24 planner calls, on dataset text only |
| E1 invoice/email | up to 2 reader calls, payload up to 20,000 chars |
| E1 chat | up to 6 planner calls, input up to 4,000 chars |
| E1 webhook, listing, JSON memory | none |
| E3 `llm_rank` | 1 reader call, up to 12 × 20,000 chars |
| E3 `hogee` | none |

All of these come on top of the SDK's 2 default retries.
