# Hogee documentation index

Start with the [root README](../README.md): what Hogee is, how to run it, how to test it and how to check the
evidence. The documents below go deeper. Each one names its own sources.

## Submission documents

| Document | What it covers |
|---|---|
| [Technical document](submission/TECH-DOC.md) | The product, the architecture, the AI agent and its limits, the contracts, the FISCO BCOS mirror, deployment and testing |
| [Security self-assessment](submission/SECURITY-SELF-ASSESSMENT.md) | Threat model, controls, AI-agent boundaries, key handling, privacy, the audit history and the residual risks |
| [Execution evidence](submission/EXECUTION-EVIDENCE.md) | Every Sepolia deployment and the key transactions (each bundle's `SUMMARY.md` lists all), the red-team cases with their Etherscan links, and how to reproduce or re-check each one |
| [Sepolia runbook](submission/SEPOLIA-RUNBOOK.md) | The order in which the Sepolia deployments and runs were made, with every command |
| [Submission folder note](submission/README.md) | Which file answers which deliverable |

## Evidence and how to check it

| Item | Where |
|---|---|
| Mei's chat run on Sepolia `final-2` | [`evidence/ev-74756ea61a72ae7c`](../evidence/ev-74756ea61a72ae7c/SUMMARY.md) |
| The red team on Sepolia `final-1` | [`evidence/rt-20261018t202130z-sepolia/export/main/ev-0f8e91d9eb2b2027`](../evidence/rt-20261018t202130z-sepolia/export/main/ev-0f8e91d9eb2b2027/SUMMARY.md) |
| Mei's run on a local Anvil chain (offline replay demo) | [`evidence/ev-cdc4cc7916471c1e`](../evidence/ev-cdc4cc7916471c1e/SUMMARY.md) |
| The FISCO BCOS mirror pack and its Sepolia timestamp | `evidence/fisco/fm-6abe83e663a2471b` and `evidence/fisco/anchors/fm-6abe83e663a2471b.sepolia.json` |

`make verify BUNDLE=<bundle folder>` and `make verify-fisco PACK=<pack folder>` check them offline. The root README's
section 5 lists the exact commands and what "VERIFIED" does and does not mean.

## FISCO BCOS mirror

| Document | What it covers |
|---|---|
| [FISCO BCOS mirror](fisco/README.md) | The local five-node chain, the regulator (committee governor, account freeze, method ban, node4's ledger), the ports, the safety model and how to run it |
| [Sepolia timestamp of a mirror pack](fisco/ANCHOR.md) | The anchor transaction, its text, its fee limits, how it is checked and what it does not prove |

## Security

| Run | Scope | Report | Re-check |
|---|---|---|---|
| 1 | The repository at the interface freeze (G0) | Kept outside the repository; leads and fixes in [G0 decisions](G0-DECISIONS.md) §6 | in run 2 |
| 2 | Three early build tasks | Kept outside the repository; leads and fixes in [G0 decisions](G0-DECISIONS.md) §7 | skills re-check, same section |
| 3 | The `final-1` contracts, the worker, the agent library | [REPORT](security-audit-run-3/REPORT.md) | fixes in [G0 decisions](G0-DECISIONS.md) §7; confirmed by run 4 |
| 4 | The live API and the worker jobs | [REPORT](security-audit-run-4/REPORT.md) | [API](security-audit-run-4/recheck-api.md), [worker](security-audit-run-4/recheck-worker.md) |
| 5 | The eval endpoints | [REPORT](security-audit-run-5/REPORT.md) | [re-check](security-audit-run-5/recheck-eval.md) |
| 6 | Evidence export, the offline verifier, the passkey encoder | [REPORT](security-audit-run-6/REPORT.md) | [re-check](security-audit-run-6/recheck-run6-fixes.md) |
| 7 | Schema batch, replan fix, red-team harness, local live stack, mock mount | [REPORT](security-audit-run-7/REPORT.md) | [re-check](security-audit-run-7/recheck-run7-fixes.md) |
| 8 | Singapore as main country, PII redaction, supplier and FX checks, chat limits, payout rail | [REPORT](security-audit-run-8/REPORT.md) | [re-check](security-audit-run-8/recheck-run8-fixes.md) |
| 9 | The chat-first product: web supplier search, terms, chat orchestrator, AI CFO | [REPORT](security-audit-run-9/REPORT.md) | [re-check](security-audit-run-9/recheck-run9-fixes.md) |
| 10 | UX rounds, the Sample business, the mock evidence tenant | [REPORT](security-audit-run-10/REPORT.md) | [re-check](security-audit-run-10/recheck-run10-fixes.md) |
| 11 | The FISCO BCOS mirror: ops scripts, sandbox profiles, replay, pack checker | [REPORT](security-audit-run-11/REPORT.md) | [re-check](security-audit-run-11/recheck-run11-fixes.md) |
| 12 | The FISCO regulator, node4's ledger, the Sepolia anchor, the Proof page's FISCO view | [REPORT](security-audit-run-12/REPORT.md) | [re-check](security-audit-run-12/recheck-run12-fixes.md) |

All twelve runs were internal, quick and source-only; runs 2 to 12 each covered one commit range of new work. There
was no external audit. Each folder also holds
the findings detail, the leads that needed validation and the hardening notes. Contract assurance:
[static analysis (Slither, Aderyn)](assurance/static-analysis-2026-10-18.md),
[require table for `final-1`](assurance/require-table-final1.md) and
[for `loop-1`](assurance/require-table-loop1.md).

## Evals and country facts

| Document | What it covers |
|---|---|
| [Journey evals](evals/journey.md) | The chat router, the terms hint and injected listings: datasets, method and measured results |
| [Singapore source ledger](compliance/SG-source-ledger.json), [Malaysia source ledger](compliance/MY-source-ledger.json) | The source excerpts behind the country-pack facts |
| [Malaysia verification checklist](compliance/MY-verification-checklist.md) | How the Malaysian facts were researched and what still needs a person's sign-off |
| [Country packs](../data/country-packs/README.md), [sanctions list](../data/sanctions/README.md), [golden hash vectors](../data/golden/README.md) | The data the app reads and how each file is built |

## Engineering

| Document | What it covers |
|---|---|
| [G0 decisions](G0-DECISIONS.md) | Frozen interfaces and every numbered design decision since |
| [Engineering notes](ENGINEERING_NOTES.md) | What broke, why, and the fix; the AI-assisted development disclosure |
| [Pinned versions](VERSIONS.md) | Toolchain, packages, Solidity dependencies and models |
| [Red-team runner](../scripts/redteam/README.md) | The attack runner: cases, worlds, output |
| [Wording check](../scripts/lint-wording/README.md) | The banned-wording lint behind `node scripts/lint-wording/index.mjs` |
