# Evidence bundle ev-74756ea61a72ae7c

Generated from this bundle's own files (tools/verify-evidence summary.ts). Do not edit: `make verify` regenerates this
file and fails on any difference, and `hashes.json` lists the keccak256 of every file.

## What VERIFIED means

`make verify` (no network) recomputes every file hash, EIP-712 digest, founder signature and rationale commitment, binds
every row to its signed transaction and every event to the calldata that produced it, and replays the event log
against the signed plan. VERIFIED means the bundle is internally consistent. It does not by itself prove that the
chain holds these transactions: `hashes.json` is an unkeyed index that anyone can regenerate. Chain truth comes from
comparing the anchor below with the block explorer (Sepolia Etherscan), or from `HOGEE_VERIFY_RPC=<url> make verify`.

- Facility: `fac-mei`
- Deployment: `final-2` on chain 11155111 (`sepolia`)
- Code: `684a5789607cd7cbd10c09f7a69b47bfbef76b02`
- Exported: 2026-10-19T07:08:32.806Z

## Anchor: compare with the chain

| Contract | Address | Verification |
|---|---|---|
| PlanRegistry | `0x07289c8852f9780f5b5b7010be7fb68fce159450` | not verified (https://sepolia.etherscan.io/address/0x07289c8852f9780f5b5b7010be7fb68fce159450#code) |
| Treasury | `0xe08872f9496d21053b52b1127ac30e87300564fa` | not verified (https://sepolia.etherscan.io/address/0xe08872f9496d21053b52b1127ac30e87300564fa#code) |
| MilestoneEscrow | `0xa5222ebe0be5ce769491f2f3396d14244d5d5761` | not verified (https://sepolia.etherscan.io/address/0xa5222ebe0be5ce769491f2f3396d14244d5d5761#code) |
| SalesOracle | `0x49fcfc043244a861da24dc16d19d3065732278e2` | not verified (https://sepolia.etherscan.io/address/0x49fcfc043244a861da24dc16d19d3065732278e2#code) |

Each of these 11 transactions must exist on chain 11155111 with the status shown (the newest block's number and hash are printed by `make verify`):

| Tx | Row | Status |
|---|---|---|
| [`0x1a2be483785e32b0601a2996518b80e55df5a738b42cfe2a5b346bfb40a6de31`](https://sepolia.etherscan.io/tx/0x1a2be483785e32b0601a2996518b80e55df5a738b42cfe2a5b346bfb40a6de31) | settle-confirm:fund:order-wavk4gkewt3zc-001:0 | success |
| [`0x289731777ee8807f45751803de8d68a82df7831e858ed63fb2f24b2d434f40bc`](https://sepolia.etherscan.io/tx/0x289731777ee8807f45751803de8d68a82df7831e858ed63fb2f24b2d434f40bc) | act-01a15286-64c2-7a3e-b4a7-a923a5919b1b | success |
| [`0x3b395fe9f54d2a3a6b2950863c0d599bcc959f5b67d6c00886e71d686af4d88d`](https://sepolia.etherscan.io/tx/0x3b395fe9f54d2a3a6b2950863c0d599bcc959f5b67d6c00886e71d686af4d88d) | release:sig-01a15294-bf54-7315-84e6-dfb11e8361df | success |
| [`0x5712892441da31eea153b3d15c3a6022d09d9e5e3b1d5c3848eb0b715b025e17`](https://sepolia.etherscan.io/tx/0x5712892441da31eea153b3d15c3a6022d09d9e5e3b1d5c3848eb0b715b025e17) | fund:order-wavk4gkewt3zc-001:0 | success |
| [`0x797b49a182d1acb728dcc071850c0050767bbba2c55c49da7b511891a999b245`](https://sepolia.etherscan.io/tx/0x797b49a182d1acb728dcc071850c0050767bbba2c55c49da7b511891a999b245) | act-01a1528b-2864-75e8-9b3a-a948c5ebe748 | success |
| [`0x97b5c75de22ac02230b8b6823741aa6ee651073cabed4ba194ca047a706b233c`](https://sepolia.etherscan.io/tx/0x97b5c75de22ac02230b8b6823741aa6ee651073cabed4ba194ca047a706b233c) | act-01a15290-096e-750f-8f49-56e65b2d3960 | success |
| [`0xb00e0ac40e66cb9504ebddc60233da0def5b1e9c874fa2732511d1d525478117`](https://sepolia.etherscan.io/tx/0xb00e0ac40e66cb9504ebddc60233da0def5b1e9c874fa2732511d1d525478117) | settle-confirm:release:sig-01a15294-bf54-7315-84e6-dfb11e8361df | success |
| [`0xc56f57f202154872359f298c12bd088c9748b1ab408de76bdec31047b20dcd16`](https://sepolia.etherscan.io/tx/0xc56f57f202154872359f298c12bd088c9748b1ab408de76bdec31047b20dcd16) | act-01a15299-f0b7-7bc2-9125-f8a6d43a70f7 | success |
| [`0xe0590ad09c6dcd96a93e4f6ab48ce21a3c23bcb01553ae51a3440ac494ea530c`](https://sepolia.etherscan.io/tx/0xe0590ad09c6dcd96a93e4f6ab48ce21a3c23bcb01553ae51a3440ac494ea530c) | act-01a1528b-d5e7-7116-ac22-66bfca00902a | success |
| [`0xe0d564cbca3155cc3d2512a474d6d735fc7e7e887dc4de697b10f1e40eb05ff8`](https://sepolia.etherscan.io/tx/0xe0d564cbca3155cc3d2512a474d6d735fc7e7e887dc4de697b10f1e40eb05ff8) | act-01a15289-547f-71e2-be2f-508cc70e73e1 | success |
| [`0xf0e5ad2995dbbac4678b184428625afd13ba235bc2e16ba4f89ac55b4f6c2cb5`](https://sepolia.etherscan.io/tx/0xf0e5ad2995dbbac4678b184428625afd13ba235bc2e16ba4f89ac55b4f6c2cb5) | fund:order-wavk4gkewt3zc-001:1 | success |

## Evidence rows

Rows come only from database facts: an attack is recognised by its on-chain revert or its recorded policy refusal, so an
attack that succeeded on chain produces no row here (the red-team runner's report is the place for those).

| Task | Layer | Outcome | Title | Tx |
|---|---|---|---|---|
| S2 | onchain_success | pass | Founder signs the plan; the relayer submits commitPlan | `0x797b49a182d1acb728dcc071850c0050767bbba2c55c49da7b511891a999b245` |
| S1 | onchain_success | pass | Lender funds the facility (capped at the plan total) | `0xe0590ad09c6dcd96a93e4f6ab48ce21a3c23bcb01553ae51a3440ac494ea530c` |
| S3 | onchain_success | pass | Founder approves the supplier; bindPayee starts its cooling | `0x97b5c75de22ac02230b8b6823741aa6ee651073cabed4ba194ca047a706b233c` |
| S4 | onchain_success | pass | Agent pays the web supplier's deposit by itself, exactly as pre-signed (payout references the tx) | `0x5712892441da31eea153b3d15c3a6022d09d9e5e3b1d5c3848eb0b715b025e17` |

## Contents

- 1 plan versions, 3 signature requests, 3 payments, 8 chain actions
- 11 raw receipts (`receipts/`), 57 trace events, 8 LLM calls (hashes only)
- 3 rationale preimages (every decision ships its own)
- Country pack: included with its hash
- Eval traces left out (measurements, not decisions): 0

Revert reasons are the worker's decoding of each failed tx; a receipt carries no revert data, so the verifier checks the
status, and replays each reverted agent call to confirm the plan rules refuse it.
