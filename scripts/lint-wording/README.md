# P3 wording checker

Run from the repository root with Node 22 or newer; no dependencies required:

```sh
node scripts/lint-wording/index.mjs
node --test scripts/lint-wording/index.test.mjs
```

P1 can wire the first command into CI. No root configuration is changed here.

Scans text source files under `apps/web`, `contracts/src`, `docs/submission`, and JSON under `data`. It skips generated build directories, dependencies, symlinks, `.env*`, `project.md`, and roles. Compliance wording documents are outside the scan roots. Binary documents, PDFs and spreadsheets need a separate human wording review before submission.

English matches are case-insensitive whole words, including words separated by punctuation; Chinese terms match within sentences. The list combines project.md D5 and section 14.4. The illustrative numeric confidence claim needs human review; it is not a fixed banned phrase.

The allow-list exempts exact phrase spans, not entire lines. For example, `GitHub issue` is allowed, but `GitHub issue about a coin` still fails. `issuer` and the plural `tokens` do not match the singular whole words in the first place.

Exit codes: 0 = no findings, 1 = wording findings, 2 = execution/read error. Missing folders are allowed before G0; the scanned-file count is printed to prevent mistaking an empty scan for a checked application.

For another checkout: `node scripts/lint-wording/index.mjs --root PATH`.
