# Malaysia research pack — P3 task 3.5

`MY.json` is a **RESEARCHED pack, not VERIFIED**. It carries every fact Rina's plan (project.md §26.2: citizen sole proprietor, insulated stainless-steel tumblers bought from China, sold on Shopee) needs to compile, each from a primary source, plus a clearly marked demo reserve assumption. A person still has to open each page and sign it off (`verifiedBy`, `verifiedOn`) before the tier can change.

The compiler fails closed: a plan that needs a fact this pack does not carry is refused with `PACK_FACT_MISSING:<leaf>`, never filled with zero, "exempt", "approved" or "free". Absent today, on purpose: `entities`, `taxIds`, `incomeTax`, `paymentRails`, `marketplaces`, product approvals other than drinkware, and the company TIN (so a Sdn Bhd plan, including any foreign founder's, fails closed on `registrations.LHDN_TIN[sdn_bhd].cost`).

Single-rate fields are scoped to the demo product. `indirectTax.rate` (10%) and the Form E duty (0%) are the rates for HS 9617.00.10 00 (vacuum-insulated tumblers; 7323.93.90 00 gives the same rates). The schema has one rate per country, so another product category needs its own check before these numbers apply to it.

## Sources

`docs/compliance/MY-source-ledger.json` stores, for every leaf, the exact short excerpt, source URL, page location, capture time, derived value and pack path; extra excerpts that support a reading sit under `corroboration`. The generator computes every snippet hash from these excerpts. Source capture is AI-assisted; `verifiedBy` and `verifiedOn` stay absent until a person signs off. `retrievedAt` is when the research session opened the page, not the document's publication date.

Verbatim source material is kept in compliance documentation rather than product copy. Do not rewrite an official quote to satisfy wording rules; the generated product JSON is scanned separately.

Evidence tiers follow project.md §26.3: tier1 only for an official government page (`.gov.my`), so LHDN, Customs, MITI, MOH, JPDP and the Attorney General's Chambers are tier1. SSM is a statutory body but publishes on `ssm.com.my`, so its leaves are tier2. The demo reserve is tier3 and `sourceType: mock`.

See `docs/compliance/MY-verification-checklist.md` for every project §10.2 topic, the sign-off list and what remains open.

Money is MYR minor units: RM3,000,000 is `"300000000"`, RM500,000 is `"50000000"`, RM60 is `"6000"` and RM1,010 is `"101000"`. Rates are basis points (10% = `1000`), durations are days and the breach deadline is hours. The MyInvois threshold applies to revenue strictly below RM3,000,000; the scalar does not encode group-company or year-of-assessment conditions. The business-name fee is for one year; own-name registration costs less.

## Demo reserve assumption

The 300 basis-point reserve floor is a demo policy assumption, not a Malaysian tax rate. Its leaf cites project.md §26.2 at commit `a8221a4` (a permalink that does not depend on any branch) and is marked `sourceType: mock`, `evidence: tier3`.

## Run from the repository root

Python 3.9+, standard library only:

```sh
python scripts/snippet-hash.py "A source sentence."
python scripts/snippet-hash.py --file sentence.txt
python scripts/snippet-hash.py --stdin
python scripts/snippet-hash.py --raw-file response-body.bin
python -m unittest discover -s scripts -p test_snippet_hash.py -v
python data/country-packs/build_my.py
python data/country-packs/build_my.py --check
python -m unittest discover -s data/country-packs -p test_my.py -v
pnpm --filter @hogee/core validate:data --require "data/country-packs/*.json"
pnpm --filter @hogee/core exec vitest run test/rina-my-pack.test.ts
node scripts/lint-wording/index.mjs
```

Sentence mode trims and collapses all whitespace recognized by Python `str.split()` to ASCII spaces, then hashes UTF-8 with SHA-256 and prefixes `0x`. Case, punctuation and Unicode normalization forms remain unchanged. Whitespace-only input and invalid UTF-8 fail. This is not the JCS/Keccak object hash. P1 should match these normalization semantics if adding a second implementation.

`--raw-file` hashes API response bytes exactly, including whitespace, line endings and any non-UTF-8 bytes. Never run API response bodies through sentence mode. Neither mode fetches a URL, reads credentials or sends data.

Generation is deterministic and offline. `--check` detects stale/missing generated output without overwriting it. After reviewing a source change, update its ledger record and capture timestamp, regenerate, run tests and shared schema validation, and review the diff. Never type digests manually.

## Singapore pack (`SG.json`)

`SG.json` is a **RESEARCHED pack, not VERIFIED**. It carries every fact Mei's plan (citizen sole proprietor, insulated tumblers bought from China, sold on Shopee Singapore) needs to compile. Each fact is copied from the sourced research of 18 October 2026 (`sg-research-a`, `sg-research-b`), plus a labelled demo reserve assumption. A person still has to open each page and sign it off (`verifiedBy`, `verifiedOn`) before the tier can change. The sign-off table is in `docs/decisions/sg-pack.md`.

It carries the three entity types (`sg_sole_prop`, `sg_partnership`, `pte_ltd`), ACRA registration and incorporation, the UEN tax-id rules, an income-tax summary, GST (9%, `900`) with its SGD 1,000,000 threshold (`"100000000"`), the import model (CIF base, no FTA certificate, MFN duty 0 for drinkware), product approvals for five categories, PayNow, Shopee fees and the PDPA breach deadline.

Absent on purpose, so the compiler fails closed on them:
- `eInvoicing`: InvoiceNow follows GST registration, not turnover, and the schema refuses the section for SG.
- The `IRAS_GST` registration: no IRAS page states its fee (the research marks it UNCERTAIN). A GST-registered plan fails closed on `registrations.IRAS_GST.cost`. Mei is below the threshold, so Mei's plan does not need it.
- `productApprovals.other`: a catch-all, so `NONE` would fail open.
- `imports.mfnDutyRateBps` for any category but drinkware: not researched per category.
- Lazada and TikTok Shop fees: no official page was captured.
- Shopee's optional Promo Xtra Programme (PXP) fee: it applies only to sellers who join PXP, and Mei does not.

Read these values with their conditions:
- SFA and CPSO quote "1 working day"; the pack unit is days.
- The SFA step is the free importer registration. Each consignment also needs a TradeNet permit: SFA charges nothing for it, and Singapore Customs about SGD 3.19 (`"319"`) when the importer files it. The schema has no per-consignment field, so this lives in the ledger and the plan copy.
- PayNow `0` bps is the percentage part only. Business accounts pay flat per-payment fees that vary by bank (OCBC: SGD 0.50). Only OCBC was checked, so confidence is low.
- Shopee's commission `1417` is the rate for "All Other Non-Electronics" sellers outside the Promo Xtra Programme (PXP), waived for a new seller's first 120 days.
- The 72-hour PDPA deadline counts from the organisation's determination that a breach is notifiable, not from discovery.
- CPSO's SGD 180 is the registration fee only. Testing and certification charges are extra and unpublished.

Evidence tiers follow project.md §26.3, the convention `MY.json` uses: tier1 for an exact sentence on a `.gov.sg` page (ACRA, IRAS, Singapore Customs, SFA, HSA, CPSO, PDPC, GoBusiness, Singapore Statutes Online), tier2 for official non-government sources (Shopee Seller Education, OCBC, ABS) and tier3 for the demo reserve. The research files also graded statute against guidance; the ledger keeps that grade as `research.evidence`.

`docs/compliance/SG-source-ledger.json` stores, for every leaf, the verbatim snippet, its hash, the URL, locator, capture time, value, pack paths, research id and supporting excerpts (`corroboration`). Its `excluded` list names every fact left out and why. Money is SGD cents: S$115 is `"11500"`, S$315 is `"31500"`, S$13 is `"1300"`, S$180 is `"18000"` and S$1,000,000 is `"100000000"`.

### SG demo reserve assumption

Hogee uses a 300 basis-point reserve floor as a demo policy assumption, not a Singapore tax rate.

The generator hashes the sentence immediately above and marks it `sourceType: mock`, `evidence: tier3`, mirroring MY's reserve leaf (P1's answer Q2 of 18 October). It is not a government fact. The compiler's SG reserve policy (500 bps) is separate and higher, so Mei's plan reserves 500 bps.

### Run from the repository root (SG)

```sh
python data/country-packs/build_sg.py --import-research <research-dir>   # research JSON -> ledger, re-checking every hash
python data/country-packs/build_sg.py --import-research <research-dir> --check
python data/country-packs/build_sg.py            # ledger -> SG.json
python data/country-packs/build_sg.py --check
python -m unittest discover -s data/country-packs -p test_sg.py -v
pnpm validate:data --require "data/country-packs/*.json"
pnpm --filter @hogee/core exec vitest run test/mei-sg-pack.test.ts
```

The research JSON is not in the repository; the ledger is the committed copy of the facts the pack uses. `--import-research` refuses a fact whose snippet does not hash to its recorded `snippetHash`, an UNCERTAIN fact, and a project.md tier that disagrees with the research's own `evidenceProjectMd`.
