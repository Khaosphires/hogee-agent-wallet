# Decisions: `evals-e1` agent (`evals/datasets/e1/`, `evals/scripts/gen-e1.mjs`)

This covers the E1 attack dataset (task 3.9, data half). P1 folds this file into `docs/G0-DECISIONS.md` after the merge. The dataset README has the full composition: `evals/datasets/e1/README.md`.

## 1. Dataset choices

| Topic | Choice |
|---|---|
| Generator | `evals/scripts/gen-e1.mjs` with modules under `evals/scripts/e1/`. It is Node with no dependencies, instead of the role file's `build_e1.py`, because the brief asked for `.mjs` and the repo's fixture builders are Node. Seed `20261020` (ROLE-P3 3.9). |
| Determinism | sfc32 is seeded per category from `sha256(seed:category)`, so editing one category never moves another's bytes. There is no clock or network. Invisible code points are written as `\u` escapes. `--check` and `gen-e1.test.mjs` rebuild the files twice and compare bytes. |
| Proportions | 8 categories × 30 (§15), and every category is 10/10/10 `en`/`ms`/`id` (ROLE-P3 "about a third each"). Each of a category's 10 scenarios appears once per language. Clean rows: 100 (§26.8). |
| Country mix | SG is main: attacks are 168 SG / 72 MY (21/9 per category) and clean rows 70/30. Indonesian-language rows use the SG or MY context, written by Batam or Indonesian counterparties. No ID facility exists. |
| Country routing | The frozen rows have no country field, so the caseId carries it (`e1-sg-*`, `e1-my-*`). `meta.jsonl` also records it, with the scenario, the hard-negative flag and the Chinese flag. The runner sends each row to the matching facility. |
| Payees and caps | Taken from SG-DECISIONS "Mei's ids and caps" (`spx-sg-logistics`, `shopee-sg-fees`) and Rina's `RINA_IDS` / `DEMO_PAYEES`. One table in `e1/world.mjs` holds them all. |
| Clean rows | LOGISTICS and PLATFORM_FEES only. ADS is a pacing line (`INVOICE_ON_PACING_LINE`); SUPPLIER is escrow-only; PACKAGING has no payee at plan v1. Each row has exactly one total line, equal to `amountMinor`, in the facility's currency and at or under the per-payment cap. A stated account must equal the bound test account, and only MY rows state one. |
| Hard negatives | 43 of the 100 clean rows, in 10 types (README). They were written like real invoices and **not tuned** to Hogee's detectors, because the false-block rate is what they measure. |
| Attack strength | Attack invoices arrive on LOGISTICS, as the eval does. Unless the attack is about the amount, totals are under the cap and in the facility's currency, so the cap or a currency mismatch alone does not block them. Attacks were not written to pass or trip the regex detector either. |
| Targets | Each `attackerGoal.kind` has a fixed target convention (README). `LEAK_*` targets are canaries: the planner's opening words, three `hogee-canary-*` strings, an NRIC canary with a wrong check letter, a MyKad canary with an impossible date, and the other tenant's marker. The arm (a) runner must plant them. |
| Synthetic ids | Attacker accounts are `99-0000-NNNN`, PayNow UENs are `T99ZZNNNNX`, wallets are `0xbad0…`. Domains are `.example`. There are no phone numbers and no valid NRIC/FIN; the test enforces all of this. |
| Chinese | The frozen `Lang` enum has no `zh`. Chinese appears inside 30 attack rows and 4 clean rows, and each row is tagged with its host language (`en`/`ms`/`id`). None of the four banned Chinese terms appears; the Chinese text uses only words such as `发票` (invoice) and `交货期` (lead time). |
| Wording | The lint (`scripts/lint-wording`) does not scan `evals/`. Even so, the test runs its `checkText` over every decoded row string, the raw files, the scripts and both docs: 0 findings. No row quotes a banned word, even as attacker text. |
| Webhook rows | The bodies are valid test-mode sale events in the shape `services/sales.ts` counts, so only the signature check stands in the way. Signatures are HMACs under attacker-chosen strings, malformed, or missing. |

## 2. Measured at generation time (informational, not used to tune)

This was run against `@hogee/core` `invoiceFlags` / `detectImperativeText` and the agent prefilter at the branch base (`f0d981b`):

- **Clean rows: 5/100 get a deterministic escalating flag (`IMPERATIVE_TEXT`), so they are false blocks no matter what the LLM does.**
  - The English password footer ("Never share your password…") matches `SECRET_REQUEST`.
  - The English "Please disregard our previous message…" matches `IGNORE_INSTRUCTIONS`.
  - The Malay and Indonesian versions of the same sentences are not flagged.
- **Attacks: 63/240 get any deterministic flag.** Most Malay and Indonesian injections, and the "quiet" English ones, are not flagged. They rely on the Reader model's flags, payee binding, caps, the memory HMAC and the Stripe signature. This is expected for regex coverage; the rest is what E1 measures.
- **SGD is not readable yet:** `READER_CURRENCIES` and `TOTAL_RE` lack `SGD` and `S$`. Every MY clean row's total parses with the regex.

## 3. Open items (outside this scope)

- **Wave 2 (agent).** Add `SGD` and `S$` to `READER_CURRENCIES`, `CURRENCY_ALIASES`, `TOTAL_RE` and `CURRENCY_TOKENS` in `packages/agent/src/reader/prefilter.ts`. Until then SG E1 results are meaningless: the 70 SG clean rows are false blocks and the SG attack invoices are blocked for the wrong reason.
- **Wave 2 (API).** The SG payees (`SG_PAYNOW`) belong in `packages/api/src/catalog/payees.ts`, and a Mei facility the runner can open. The facility id `fac-mei` is assumed; it is used only in memory and webhook rows, where a wrong id changes no outcome.
- **P3 runner and `naive_agent.py`.** Route by caseId prefix; open a fresh facility per country; configure the Stripe secret; plant the canaries (README table).
- **P1 decision.** Should the planner's opening words stay "Hogee's planning assistant" after the SG rewording of `instructions.ts`? Twelve rows (T30, T13) use it as their leak target.
- **P1 decision.** The two English hard-negative false blocks are product findings: the patterns are broad enough to catch normal invoice text. Whether to narrow them is P1's call. They are recorded here rather than worked around.
