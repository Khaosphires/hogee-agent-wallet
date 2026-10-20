# Run-12 architecture (quick, scoped 2590ae0..<run-12 head>: the FISCO regulator + Sepolia anchor + Proof page FISCO view)

## 1. Product, principals, protected resources
Hogee runs a micro-business loan budget on an on-chain treasury (Sepolia `final-2`). Run-11 audited the **FISCO BCOS mirror**
(local 5-node FISCO 3.17.1 chain on 127.0.0.1, sandboxed, digest-pinned; replay of final-2 into an offline pack checked by
`make verify-fisco`). This range adds:
- **Regulator governance:** chain-up now builds the chain with FISCO auth mode (`build_chain.sh -a <regulator>`; genesis
  `[executor] is_auth_check=true`, `auth_admin_account`), a throwaway regulator keystore `D/keys/regulator.json` as the
  single committee governor, node4 joined as observer by a committee proposal, node4 Web3 on 127.0.0.1:8546, and a
  snapshot of the native-RPC TLS client files (`D/facts/sdk/{ca.crt,sdk.crt,sdk.key}`). The replay gets a fifth key
  (`REGULATOR_PRIVATE_KEY_FISCO`, decrypted by `replay.sh` in a subshell) and runs regulator steps: G0 register the
  agent's account, G1 freeze / V1 confirm / F1 agent spend refused by the chain (native status 22) / G2 unfreeze / V2 /
  C1 probe; G3 committee makes the regulator Treasury's chain admin, G4/G5 blacklist `Treasury.spend` for the agent /
  M1 refused (native 18) / C2 probe of another method / G6 lift / C3 probe; then the existing officer pause (R17).
  Native receipts are read over TLS (`NativeRpc`, 127.0.0.1:20200, CA-verified, no hostname check); node4's copy of the
  ledger is captured (`LedgerRpc`, read allow-list) into `ledger.json`.
- **v2 pack checker** (`hogee.fisco-mirror/2`): new checks "regulator ledger" and "regulator powers"; existing checks
  extended for system-contract targets (AccountManager 0x10003, CommitteeManager 0x10001, ContractAuth 0x1005),
  probe-only steps, native receipt statuses, and offline derivation of AccountFrozen/PermissionDenied.
- **Sepolia anchor:** `scripts/fisco/anchor.sh` (run by the user, who types the `hogee-deployer` keystore password) signs
  ONE Sepolia tx: a value-0 self-send whose input is the ASCII text
  `hogee-fisco-anchor v1 pack=<id> hashes=<keccak256(hashes.json)> chain=20200 head=<n> head-hash=<hash>`; a sidecar
  `evidence/fisco/anchors/<packId>.sepolia.json` is checked offline (`checkSepoliaAnchor`) and optionally online.
- **Proof page:** three new API routes (real + mock) serving FISCO pack files and the sidecar, and a "FISCO BCOS mirror"
  section on Proof → Checks that runs `verifyFiscoPack` + `checkSepoliaAnchor` in the browser.

Principals:
- **Operator (P1/user):** runs every script by hand on one Mac; holds the env file with the four REAL final-2 Sepolia
  testnet role keys and the `hogee-deployer` keystore (Sepolia, 4 ETH test funds) whose password they type into anchor.sh.
- **Verifiers (judges):** run `make verify-fisco` or view the Proof page on a pack + sidecar we publish.
- **App users:** the Proof page is part of the Hogee web app (persona sessions, tenant = facility/deployment/chain).
- **Lower-trust:** whoever authors a pack or sidecar; any RPC answering the replay (must be loopback), the native RPC
  and node4 (loopback, sandboxed FISCO binary), the Sepolia RPC used by anchor.sh/capture (https, any host); any local
  process or page reaching the loopback ports; any request to the API's evidence routes; whoever can write the chain
  dir D.

Protected: the four real role keys and the deployer keystore password (never argv, logs, files, env of children, non-loopback hosts, other chains); the single outward Sepolia transaction (must be exactly the confirmed self-send of this pack's text); the regulator/sdk keys (throwaway but must not leak into the pack); the integrity of VERIFIED (code identity, plan, signatures, refusals, T28, regulator powers/ledger, anchor); the API's file-serving boundary and tenancy; the Proof page's "never fake a pass" rule.

## 2. Comparable baseline
FISCO 3.x auth/committee semantics (source-traced and live-tested): governor-only `setAccountStatus` returning int32 (−50000 non-governor, −51900 unregistered); status takes effect from the next block; a frozen sender's tx is mined with Web3 status 0x0 and native 22; ContractAuth method blacklist immediate, native 18; FISCO Web3 serves block 0 under a different hash than block 1's parentHash; getAccountStatus in a registration's own block answers 0x30. Ethereum EIP-155/1559 tx semantics for the anchor.

## 3. Stack and offline limits
Bash 3.2 + macOS SBPL, TypeScript ESM (`node --import tsx`, viem, zod 4, vitest), Next 16/React 19 for the Proof page, Hono API. macOS cannot enforce the required sandbox limits for target execution: **source review only** in this run; decisive runtime facts → needs_validation.

## 4. Entry surfaces and key paths
- `scripts/fisco/chain-up.sh` (+`chain-lib.sh` `rewrite_config_ini`, `static_config_problems`, `regulator_fact_problems`; `lib.sh` ports/helpers; `node.sb` bind 8546), `chain-check.sh` (governor, node4 ledger, facts), `replay.sh` (`read_role_keys`, `read_regulator_key`, `key_lines` → fd 3).
- `scripts/redteam/src/fisco/`: `cli.ts` (flags `--native-tls`, `--ledger-rpc`, regulator = genesis admin check), `role-keys.ts` (5 lines), `native-rpc.ts`, `rpc.ts` (`LedgerRpc`), `ledger.ts` (`captureLedger`), `governance.ts`, `scenario.ts`, `runner.ts` (probe-only path, native receipts), `reads.ts`, `capture.ts`, `anchor.ts` (`text`/`check-raw`/`capture`).
- `scripts/fisco/anchor.sh`: temp dir, scrubbed env, chain-id 11155111, `read -rsp` password → 600 file, `cast mktx` → decode twice → `[y/N]` → `cast publish --async` → capture.
- `tools/verify-evidence/src/fisco/`: `pack.ts` (v2 schemas, ledger, native), `catalogue.ts` (37 entries), `system.ts`, `view.ts`, `govern.ts`, `refusals.ts`, `regulator.ts`, `ledger.ts`, `anchor*.ts`, `cli.ts` (`--require-anchor`, `--anchor-rpc`), `load.ts`.
- API: `packages/api/src/evidence/fisco-store.ts` (shared reader), `packages/api/src/routes/evidence.ts`, `packages/api-mock/src/fisco.ts` + `evidence.ts` + `handlers-ops.ts`, `packages/api-contract/src/{routes,schemas,examples}.ts`.
- Web: `apps/web/components/evidence/{fisco-section,fisco-cards,fisco-model,fisco-labels,served-fisco,fisco-anchor-check}.ts(x)`, `apps/web/lib/explorer.ts` (chain 20200 name only), `app/evidence/page.tsx`.

## 5. Trust boundaries and strongest control
| Boundary | Strongest source-visible control |
|---|---|
| Regulator/sdk keys → disk/logs/pack | `read_regulator_key` subshell + regex, fd 3; writer secret scan incl. regulator key and PEM body |
| Replay → nodes | loopback-only clients; native allow-list `getTransactionReceipt`; LedgerRpc read allow-list; chainId 20200 before sends |
| Pack author → VERIFIED (regulator) | catalogue args/outputs, native statuses, block order, same-calldata, offline refusal derivation, ledger digest + per-tx consensus |
| User password → anchor tx | scrubbed env, 600 temp file removed after signing, decode twice, explicit [y/N], chain-id guard |
| Sidecar author → anchor pass | strict schema 64 KiB, keccak(raw)=hash, signer pinned, to=self, value 0, text recomputed from this pack |
| HTTP request → FISCO files | path regex, realpath inside root, O_NOFOLLOW + inode match, caps, tenant = source bundle readable |
| Pack text → Proof page | React text rendering, catalogue titles, explorer link only from pinned base after a browser pass |

## 6. Starting paths
`scripts/fisco/`, `scripts/redteam/src/fisco/`, `tools/verify-evidence/src/fisco/`, `packages/api/src/evidence/fisco-store.ts`, `packages/api/src/routes/evidence.ts`, `packages/api-mock/src/{fisco,evidence,handlers-ops}.ts`, `packages/api-contract/src/{routes,schemas,examples}.ts`, `apps/web/components/evidence/fisco-*`, `apps/web/lib/explorer.ts`.

## 7. Prior coverage
Runs 1–11 have no confirmed records. Run-11 (quick, scoped 3420445..7db6058) left 4 needs_validation leads and 3 critic gaps, all fixed before PR #16 (2590ae0) and re-checked. Twenty prior units list a starting path whose relevant source this range changes; they are current changed-source work. The rest are carried out_of_scope (relevant source unchanged; shared files such as api-contract routes.ts changed only by adding the FISCO routes).

## 8. Companion selection
- DESKTOP-MOBILE-AND-LOCAL-IPC: local secrets (regulator keystore/pw, sdk.key, the deployer keystore password), loopback services (8546, 20200), file ownership of facts, user-presence for the anchor publish.
- PROTOCOLS-RPC-AND-MESSAGING: pack/sidecar/ledger as untrusted messages; node and Sepolia RPC answers as untrusted producers.
- SUPPLY-CHAIN-AND-RELEASE: build_chain.sh's download paths with `-a`.
- RESOURCE-EXHAUSTION-AND-AVAILABILITY: ledger.json/sidecar/pack sizes in checker and API.
- DATA-ISOLATION-AND-LIFECYCLE: tenancy of the FISCO routes.
- CLIENT-SIDE: the Proof page section rendering pack text and an external link.
Excluded: CLOUD-AND-DEPLOYMENT, MEMORY-SAFETY-AND-BINARY, AI-AND-LLM, WEB-PROTOCOL-AND-AUTH (no session/cookie/auth decision changed).
