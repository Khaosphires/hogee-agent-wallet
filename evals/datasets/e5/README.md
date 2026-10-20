# E5 privacy dataset

E5 measures PII **redaction** (project.md §15): how many of the ID numbers, phone numbers and bank account numbers in a founder's documents Presidio finds, first with its default recognizers and then with ours (§12.2), and how many look-alike numbers it wrongly removes. The labels here are written before any run, as §15 requires.

All data is synthetic. No row comes from a real document or a real person (see [Synthetic data](#synthetic-data)).

## Files

| File | Rows | Contents |
|---|---|---|
| `docs.jsonl` | 190 | The scored set and the only source of truth. One `E5DocRow` per line (`{docId, text, spans[{start, end, entity}]}`, `data/schemas/e5-doc-row.schema.json`). Rows `e5-0001`–`e5-0150` are Malaysia and Indonesia documents with the six original entity names. Rows `e5-sg-0001`–`e5-sg-0040` are Singapore documents, which also use `SG_NRIC` and `SG_PHONE`. Checked by `pnpm validate:data` |
| `docs.meta.jsonl` | 190 | One sidecar row per `docId`: `template`, `lang` (`en`, `ms`, `id`, `zh`), `docType`, `country` (`MY`, `ID`, `SG`), `spanFormats` (one per span, in span order), `decoys[{start, end, kind}]` and the generator `attempt`. Use it to break results down by country, language, format or decoy kind. It is not part of the frozen row |

## Regenerate and check

From the repository root (Node 24, no dependencies):

```sh
node evals/scripts/gen-e5.mjs           # write docs.jsonl and docs.meta.jsonl and print the counts
node evals/scripts/gen-e5.mjs --check   # regenerate in memory, compare bytes, re-check every row on disk
node evals/scripts/gen-e5.mjs --sample  # print 10 seeded spans with context, for a hand check
pnpm validate:data                       # docs.jsonl against the frozen zod schema
```

The generator uses one fixed seed (`20261018`), no clock and no `Math.random`, so a re-run is byte-identical. `--check` fails if any file differs from a fresh generation or if any row on disk fails a row check.

**Row checks.** The generator runs these on every row before writing it, and `--check` runs them again on the files:
- The row has the `E5DocRow` shape: an `Id`-pattern `docId`, text of 1–20,000 code points, spans sorted, non-overlapping and inside the text, and unique `docId`s.
- Each span's text slice matches its entity's format and passes its validator (offset integrity).
- The reference detector, run over the whole text for **all eight** entities, finds exactly the labelled spans. So there is no unlabelled valid ID anywhere, and no hard negative passes a validator. The Malaysia and Indonesia rows contain no Singapore PII.
- No span is a well-known example number or an obviously patterned one (five equal digits, or five ascending or descending digits).
- The wording lint (`scripts/lint-wording`) finds nothing.

## Offsets

`start` and `end` are **Unicode code-point** indices into `text`, with `end` exclusive (G0 decision in `packages/core/src/schemas/datasets.ts`). This is Python `str` slicing, which is what Presidio returns. In JavaScript, slice `Array.from(text)`, not the string.

35 documents contain emoji (outside the Basic Multilingual Plane) before some of their spans. For 65 spans, a UTF-16 offset differs from the code-point offset, so a scorer or redactor that mixes the two fails visibly.

**`@hogee/privacy` reports UTF-16 offsets.** `redact()` returns JavaScript `string.slice` indices, so a scorer must convert them to code points before comparing them with these labels.

## What counts as PII (the label rule)

A span is labelled when, and only when, it meets all of these:
- It matches one of its entity's formats below.
- It passes the validator.
- It is not part of a longer group. No ASCII letter or digit touches it on either side, and it does not continue a digit group through a single space or dash. So `03-6201 2345` holds one MY phone number and no Singapore `6201 2345`, and `0x…ab900101145678cd…` holds no MyKad.

The span covers the whole number, including any `+60`, `+62` or `+65` prefix and the brackets of `(021)`.

| Entity | Formats in the data | Validator |
|---|---|---|
| `MY_NRIC` | `YYMMDD-PB-####`, 12 digits, `YYMMDD PB ####` | Real date in 19YY or 20YY; place-of-birth code in the JPN ranges (01–16, 21–68, 71–72, 74–79, 82–93, 98–99). Generated births 1965–2004, Malaysian state codes only |
| `ID_NIK` | 16 digits; 4-4-4-4 with spaces (12%) | Province code is a real province (11–82, 91–96); regency and district are not `00`; `DDMMYY` is a real date, with DD + 40 for women; serial is not `0000` |
| `ID_NPWP` | `XX.XXX.XXX.X-XXX.XXX`, 15 digits, or 16 digits as `0` + 15 (the 2024 form for non-individuals, per DJP's NPWP-16 FAQ) | The 9th digit is the Luhn check digit of the first 8. DJP does not publish this rule; two independent implementations agree on it (`evals/docs/evals-e5.md`) |
| `MY_BANK_ACCOUNT` | 10–16 digits by bank (Maybank 12, CIMB 10, Public Bank 10, RHB 14, Hong Leong 11, AmBank 13, Bank Islam 14, BSN 16, as in the banks' published IBG tables); 12 and 16 also grouped in fours with spaces or dashes | No checksum exists, so context decides. The number must not start with 0, and a bank word must appear earlier on the same line, at most 48 characters before it: `bank`, `akaun`, `account`, `acct`, `a/c`, `cimb`, `rhb`, `bsn`, `hong leong`, `户口`, `账户`, `账号`, `银行` |
| `MY_PHONE` | `012-345 6789`, `012-3456789`, `0123456789`, `+60 12-345 6789`, `+6012-345 6789`, `+60123456789`; landlines `03-2123 4567`, `04-261 2345`, `082-123 456` | Mobile `1X` + 7 digits (`11` and `15` + 8); landline `3` + 8, `4–7`/`9` + 7, `82–89` + 6 |
| `ID_PHONE` | `0812-3456-7890`, `0812 3456 7890`, `081234567890`, `+62 812-3456-7890`, `+6281234567890`; landlines `(021) 5123 4567`, `+62 21 5123 4567` | Mobile: a real operator prefix (`811`–`899` set) and 9–12 national digits. Landline: an area code that does not start with 0, 1 or 8, and 8–11 national digits |
| `SG_NRIC` | `S`/`T` NRIC, `F`/`G`/`M` FIN: letter + 7 digits + check letter | Weights 2,7,6,5,4,3,2; offset 4 for T/G and 3 for M; letter tables `JZIHGFEDCBA` (S/T), `XWUTRQPNMLK` (F/G), `XWUTRQPNJLK` (M). Must stay equal to `packages/privacy/src/validators.ts` |
| `SG_PHONE` | `9123 4567`, `91234567`, `+65 9123 4567`, `+65 91234567`, `+6591234567` | 8 digits starting with 3, 6, 8 or 9 (SG-DECISIONS.md) |

The detector is `detect()` in `evals/scripts/e5/ids.mjs`. A recognizer that follows this table and uses word boundaries can reach 100% recall and precision on this set.

## Hard negatives (must not be redacted)

Every document also carries look-alikes. They fail the formats, validators or context rule above, and the row checks prove it. Per-document counts are in the sidecar; the main kinds are:

| Kind | Examples of the shape | Why it looks like PII |
|---|---|---|
| `hex_hash`, `hex_address` | `0x` + 64 or 40 hex digits; half of the hashes hide a MyKad-valid 12-digit run between hex letters | Long digit runs |
| `order_id` | Shopee `261018XN8J0828`, Lazada 15–16 digits, TikTok Shop 18 digits, Tokopedia `INV/20261018/MPL/4880721850` | 15- and 16-digit numbers, like NPWP and NIK |
| `ssm` | `202401012345` (years 2015+), `1234567-H`, `JM0712345-K` | 12 digits, like MyKad |
| `uen` | `53246883S`, `201683791Y`, `T14PF3506W` | Letter + digits, like NRIC |
| `amount`, `date` | `Rp 12.345.000`, `RM1,049.50`, `S$615.85`; `18/10/2026`, `2026年10月18日` | Digit groups |
| `hs_code` | `9617.00.10`, `7323.93.9010`, `9617001000` | 8–10 digits |
| `tracking`, `invoice_no`, `bill_of_lading`, `container`, `permit_no`, `postcode` | `SPXMY…`, `INV-2026-36208`, `MEDURG40273385`, ISO 6346 `GSSU1703340`, `NOT260748750E`, `Singapore 467995` | Mixed letters and digits |
| `masked` | `011-*** 5771`, `xxxx-xxxx-0183` | A phone or account number that is already masked |

## Mix

| | `docs.jsonl` (190 rows) |
|---|---|
| Documents | Malaysia/Indonesia 150, Singapore 40; 19 with no PII |
| Spans | 403: `MY_PHONE` 117, `ID_PHONE` 59, `MY_BANK_ACCOUNT` 59, `SG_PHONE` 55, `MY_NRIC` 38, `ID_NPWP` 31, `ID_NIK` 28, `SG_NRIC` 16 |
| Languages | English 85, Malay 41, Indonesian 33, Chinese 31 |
| Document types | chat 40, invoice 37, quote 36, marketplace notice 26, customs email 17, order summary 12, permit email 12, receipt 10 |
| Hard negatives | 1,016 decoys: amount 353, date 190, order id 106, invoice no. 95, HS code 67, UEN 36, SSM 29, container 29, tracking 23, bill of lading 23, masked 20, hex hash 15, postcode 14, hex address 10, permit no. 6 |

The scenarios are founder paperwork: Chinese supplier quotes, Malaysian printer invoices, Indonesian faktur, forwarder customs emails asking for a MyKad or NIK (K1, PIB), NPRA and Singapore import permit emails, seller-centre payout notices, WhatsApp-style chats, on-chain payment receipts and order summaries. Cross-border documents mix entities: a Malaysian buyer's phone on an Indonesian quote, or a Johor supplier's bank account in a Singapore quote. `E5DocRow` has no language field, so Chinese documents are allowed; their sidecar `lang` is `zh`.

## Scope of the labels

- Only the frozen `PII_ENTITIES` are labelled (P1 confirmed this scope on 2026-10-18). Personal names and street names appear (invented, street-level only, with no house or unit numbers) but are **not** labelled. A scorer should therefore count only predictions of our entity types, or of Presidio types it maps onto them.
- To keep labels unambiguous, the documents carry **no other personal identifiers**: no email addresses, no Chinese phone or ID numbers, no Indonesian or Singapore bank accounts, and no NIK written as an NPWP.
- One Singapore chat names the same PayNow number twice, so it has two spans with the same text.

## Singapore rows

Core gained `SG_NRIC` and `SG_PHONE` on 2026-10-18, so `SG_IN_MAIN` in `evals/scripts/gen-e5.mjs` is `true`. The 40 Singapore rows come after the 150 Malaysia/Indonesia rows, which are byte-identical to the first release. There is no separate Singapore file. Setting the switch to `false` would split the rows into `docs.sg.jsonl` again; the generator refuses `true` while core lacks the names.

## Synthetic data

- Every number is generated from the seed; nothing is copied from a real document.
- Names and businesses are invented. Bank and marketplace names are real brands, used only as context; their account numbers are random.
- Example numbers from specs and library docs are excluded, for instance the MyKad and phone in core's `exampleE5DocRow`, the python-stdnum NPWP example and `S1234567D`.
- A random number in a valid format can still, by chance, equal someone's real number. That is true of any synthetic ID set that passes validators; none here was taken from a real source.
- **Hand check (2026-10-18):** the 10 spans from `--sample` were checked by hand (dates, place codes, Luhn digit, operator prefixes and bank context), and all were correct. Separately, Python code-point slicing re-checked all 403 spans against the formats.
