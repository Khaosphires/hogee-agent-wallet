# Security audit run-8: Hogee takeover (Singapore main country, PII redaction, supplier and FX checks, chat limits, payout rail, mock hardening, G2 UI)

## 1. Run, scope and limits
- **Profile:** `quick`, scoped. **This is a partial pass.**
- **Scope:** `42d0c96..503cc08`, the 18–19 Oct takeover (256 files, about 19k lines added). It covers:
  - Singapore as the main country: core enums, the country-pack schema, the compiler, landed cost, `SG.json`, API country, payees, persona, and the facility and compile cross-checks;
  - the real `@hogee/privacy` redactor and canary;
  - `@hogee/checks` (USCC/SSM/UEN, UN sanctions, GLEIF, BNM FX);
  - the chat rate limit and model budget;
  - the payout rail chosen by channel;
  - Reader SGD totals and PayNow binding;
  - mock hardening;
  - the G2 UI and the evidence explorer.
- **Source ref:** `503cc08` (p1/dev after every wave-1 and wave-2 merge), read from a clean, detached, read-only worktree.
- **Execution:** source only. **No target code was executed**, because macOS cannot enforce the required sandbox limits. A source-only pass cannot meet the `confirmed` bar.
- **Agents:**
  - 7 hunters in one wave: `h-privacy`, `h-checks`, `h-api-sg`, `h-core-sg`, `h-agent-pay`, `h-mock`, `h-web`;
  - 5 verifiers, one per candidate (Phase 3 and Phase 5 merged, per the quick profile);
  - 1 final coverage critic.
  - No budget was set.
- **Prior runs:** runs 1–7 have no confirmed records. The two run-7 leads were fixed in PR #11 and are not re-reported. Ten prior units whose source changed in this range were reassigned as current work.

## 2. Security posture
As far as the source shows:
- **Persona and payees per country:**
  - The server accepts and mints only its own country's founder.
  - It serves only its own country's payees.
  - It refuses a facility whose country or currency differs from its own before any compile or spend.
- **Pack schema:** country packs refuse another country's registration, tax-id and approval codes. The SG e-invoicing exemption cannot apply to MY or ID. A missing approval agency or MFN rate fails closed, and `EXEMPT` never zeroes import GST.
- **Redaction:**
  - Every model call goes through the redactor and the outbound canary. Tool-result values are redacted with their key as context.
  - Inputs are capped and the regexes are linear. Failures throw, so nothing is sent unredacted.
- **Checks:** fixed hosts only, no redirects, size and time caps, and fail-closed errors. Registry kinds are exhaustive and unknown kinds fail closed.
- **Rate limit and budget:**
  - The chat limiter maps are bounded.
  - Every model call reserves from the budget before it is sent and settles after, so concurrent calls cannot overshoot.
- **Payout rail:** `SG_PAYNOW` never reaches Xendit, and an unknown channel or currency mismatch is refused before any rail call.
- **Reader:** a changed PayNow target is flagged, and a bare `$` is never read as SGD.
- **Mock:**
  - Off-curve, rejected and replaced keys can sign or queue nothing.
  - Officer approval re-checks the recorded passkey signer and the reserve.
  - The evidence loader never follows links and caps depth and size.
- **Web:** explorer links are pinned to `https://sepolia.etherscan.io/{tx,address}`, with formats checked and no opener. The enrolment code is shown once and never persisted.

## 3. Confirmed findings
None.

## 4. Needs validation (1; `NEEDS-VALIDATION.md`)
| Fingerprint | Lead | Status |
|---|---|---|
| `packages/privacy/src/detect.ts:candidatesOf:negative-context-veto-on-every-pattern` | A money word up to 12 characters before a phone or card number vetoed every pattern of its recognizer, including `+65`/`+60` and Luhn-valid cards. Some numbers could reach `chat_messages` and the model provider unredacted. | **Fixed on p1/dev:** `wip/fix-privacy` `a146f48`, with tests that fail on the old code. A veto word never hides a phone with a country code or a 15–16 digit valid card, and elsewhere applies only when directly before the number. A follow-up exempts MY `01X` and ID `08XX` mobiles. |

## 5. Rejected by independent verification (4)
In each case the verifier found the source trace real but crossing no reachable trust boundary. The suggested hardening was applied anyway.

| Fingerprint | Why rejected | Hardening merged |
|---|---|---|
| `api-mock:exceptions:officerApprove:founder-signed-without-recorded-signer` | Seeded FOUNDER_SIGNED rows are an owner-authored status gallery. Only a verified officer approves, and nobody can create or edit such a row. | `wip/fix-mock`: an explicit signer kind (passkey, wallet or seeded-fixture), recorded only by the real signing handlers. |
| `packages/api/src/services/shortlist.ts:candidateOf:sanctions-screens-displayName-not-payout-holder` | Supplier records come only from repo files; no route, tool or upload writes them. | `wip/fix-api`: the payout holder and legal name are screened as well (in progress). |
| `packages/api/src/services/shortlist.ts:candidateOf:server-country-pack-vs-facility-currency-unchecked` | A mismatch needs operator misconfiguration of the tenant ids and `HOGEE_COUNTRY`. | `wip/fix-api`: the compile's server-country check now also guards the shortlist (in progress). |
| `packages/checks/src/sanctions.ts:nameTokens:no-confusable-or-invisible-letter-fold` | The normaliser gap is real, but no lower-trust principal writes supplier names. | `wip/fix-checks` `89c5eef`: NFKC, removal of default-ignorable letters, and a Cyrillic/Greek look-alike fold applied to both list and query. |

## 6. Hardening (33 notes; `hardening.generated.md`)
**Queued for the post-fix batch:**
- WITHDRAW_RESERVE `taxPayeeId` should be bound to the server country's tax payee (h-api-sg; same root as critic gap 6).
- `fileCatalog.loadPack` should check that the pack's `countryCode` matches the one requested (h-core-sg).
- The PayNow capture should normalise with NFKC and strip format characters before matching (h-agent-pay).
- Privacy:
  - nested JSON key context;
  - more SG phone context words (`paynow`, `number`, `mob`);
  - an MY bracketed landline pattern;
  - fail closed on `context_required` with an empty context list (h-privacy).
- Evidence-table artifact links should reject `..` segments (h-web, pre-existing).
- The mock evidence run list needs a cap, a facility check and a contained replay fixture read (h-mock).

**Accepted, documented:**
- exact-match sanctions (no fuzzy matching);
- format-only UEN;
- per-process budget measured in characters, not provider units;
- the founder persona is anonymous by demo design.

## 7. Coverage
- **Ledger:** 129 units: 15 covered, 5 candidate, 6 deferred, 103 out of scope.
- **Final critic:** `stop: false`. It accepted 6 missing units, all deferred, because the quick profile runs no follow-up wave:
  1. Reader `payNowTargets` window cost on `/api/eval/case`;
  2. redactor request-path cost (a RESOURCE-EXHAUSTION companion was not selected for the privacy unit);
  3. mock PlanApproval and SupplierApproval drafts and `previewCountry`;
  4. plan rule source links (`RuleSource`);
  5. SGD budget grounding (marker conflict);
  6. live WITHDRAW_RESERVE destinations with both countries' payees in final-1 (outside the diff; context changed).

  All six go to the post-fix skills re-check.
- **Validators:** both pass (`validate-findings.cjs`: 5 records; `validate-coverage-ledger.cjs`: 129 units).
- **Scope limit:** this run covers only the scoped diff and does not exhaust the target.
