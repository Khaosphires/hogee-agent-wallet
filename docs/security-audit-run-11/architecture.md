# Run-11 architecture (quick, scoped 3420445..7db6058: the FISCO BCOS mirror)

## 1. Product, principals, protected resources
Hogee runs a micro-business loan budget on an on-chain treasury (Sepolia, deployment `final-2`, verified bundle
`evidence/ev-74756ea61a72ae7c`). This range adds a **FISCO BCOS mirror**: the same contracts deployed on a local 5-node
FISCO BCOS 3.17.1 chain on 127.0.0.1 (4 sealers + 1 observer), a scripted replay of final-2 plus refusals, and an
offline-checkable **FISCO mirror pack** (`evidence/fisco/fm-<16hex>/`) with its own checker (`make verify-fisco`).
- **Operator (P1):** runs every script by hand on one Mac; downloads the two FISCO release files; holds the env file with
  the four REAL final-2 role keys (agent, lender, oracle, relayer: Sepolia testnet keys).
- **Verifiers (judges):** run `make verify-fisco` (or import `@hogee/verify-evidence/fisco`, browser-safe) on a pack we publish.
- **Lower-trust principals:** whoever authors a pack given to the checker; whoever controls the downloaded
  `build_chain.sh`/`fisco-bcos` (pinned by digest, unauditable binary); any local process or browser page that can reach
  the unauthenticated loopback Web3 RPC (127.0.0.1:8545) or P2P/RPC ports; an RPC that answers the replay or the Sepolia
  capture (replay: must be loopback + chainId 20200; capture: any http(s) host with chainId 11155111); whoever can write
  the chain dir D (`~/fisco-hogee/chain`) or the env file.
- **Protected:** the four real role keys (must never leave the replay process: argv, logs, pack, files, core dumps, child
  env, non-loopback hosts, other chains); the operator's files outside D (wipe/rm/chmod); the host network (downloaded
  code must stay loopback-only); the integrity of the checker's VERIFIED verdict (code identity with Sepolia, constructor
  inputs, plan hash, signatures, refusals, cross-chain replay, final state).

## 2. Comparable baseline
Foundry `forge script` deploys and Ethereum receipt/EIP-155/EIP-712 semantics; FISCO's own `build_chain.sh` flow, which
by design downloads TASSL from Tencent COS and downloads-and-runs `get_account.sh` from the console repo's unpinned
master (here replaced by local stubs under a no-network sandbox). FISCO 3.17.1 deviates from Ethereum in two
source-visible ways the code handles: `v` served as y-parity, and a bloom whose address term is keccak of the lowercase
hex text.

## 3. Stack and offline limits
Bash 3.2 scripts + macOS SBPL profiles (`scripts/fisco/*`), Solidity/Foundry (solc 0.8.37, Cancun), TypeScript ESM run
via `node --import tsx` (viem 2.57, zod 4, vitest 5). The audit worktree has no `node_modules`, `contracts/dependencies`
or `contracts/out`; installing them needs the network. macOS cannot enforce memory or per-directory disk limits, so **no
target-controlled execution in this run** (source review only; decisive runtime facts → needs_validation).

## 4. Entry surfaces and key paths
- `scripts/fisco/verify-release.sh <dl-dir> [--dir D] [--offline]` → digest/size pins (`SHA256SUMS`, `lib.sh:19-22`),
  tar listing, install `D/bin/fisco-bcos`; `gh api` cross-check unless `--offline`.
- `chain-up.sh` → copies the pinned `build_chain.sh` into D, writes stubs in `D/home/.fisco`, runs it under `build.sb`
  (`env -i`, deny network), reissues the CA, rewrites configs (loopback, CORS off, Web3 on node0), starts nodes under
  `node.sb` (loopback only, writes in D), `addObserver` via a throwaway keystore.
- `chain-check.sh [--selftest]`, `chain-down.sh [--wipe]` (`rm -rf D` after marker check), `deploy.sh` (DeployFinal with
  constructor inputs decoded from the tracked Sepolia broadcast, throwaway deployer keystore).
- `replay.sh` → reads exactly four `*_PRIVATE_KEY_FINAL` lines from `HOGEE_ENV_FILE`, exports them to `pnpm fisco:replay`
  (`scripts/redteam/src/fisco/cli.ts`): `loadSigners(..., {scrub:true})`, `FiscoRpc` (loopback + chainId 20200 before
  every send), local legacy signing, step catalogue, probes, pack writer with a secret scan.
- `fisco:sepolia-code --rpc <url> --out <dir>` → chainId 11155111 check, `eth_getCode` at pinned final-2 addresses.
- `make verify-fisco PACK=…` → `tools/verify-evidence/src/fisco/cli.ts` → `readBundleDir`, schemas, hashes, 14 checks;
  `--artifacts contracts/out` only if that folder exists; FISCO headers taken as served.
- Deploy checks: `DeployLoop.s.sol` `_checkChain`/`_checkConfig` (now `require(fisco || !fiscoMs)`), `_deployedAt`,
  `VerifyFinal` `EXPECTED_FISCO_MS`.

## 5. Trust boundaries and strongest control
| Boundary | Strongest source-visible control |
|---|---|
| Real keys → network | `rpc.ts` loopback + chainId 20200 before every send; EIP-155 chainId 20200 signing; fisco EIP-712 salt |
| Real keys → disk/logs | `replay.sh` 4-name parser, `ulimit -c 0`, no argv; `loadSigners` scrub; writer secret scan |
| Downloaded code → host | digest pins; `build.sb` deny network; `node.sb` loopback-only, writes only in D; stubs for downloads |
| Scripts → user files | `refuse_unsafe_dir`, marker `.hogee-fisco`, `pwd -P` checks, refuse root |
| Pack author → VERIFIED | strict schemas + keccak hash index; recomputation of txs, receipts, code identity, plan, signatures, refusals, T28 against the pinned Sepolia bundle |
| Sandboxed code → D | none beyond D: `node.sb`/`build.sb` let fisco-bcos/build_chain read and write all of D (keys/, deploy/, bin/, pid files) that later steps trust; the binary is not re-hashed after the build |
| Deploy config → chain | `_checkChain`/`_checkConfig` tag/clock/roles; inputs decoded from the tracked Sepolia broadcast |

## 6. Starting paths
`scripts/fisco/`, `scripts/redteam/src/fisco/`, `tools/verify-evidence/src/fisco/`, `contracts/script/{DeployLoop,DeployFinal,VerifyFinal}.s.sol`,
`Makefile`, `scripts/redteam/package.json`, `tools/verify-evidence/package.json`, `.gitignore`, `docs/fisco/README.md`.

## 7. Prior coverage
Runs 1–10 have no confirmed records. Run-10's 6 needs_validation leads were fixed in PR #15 (3420445) and are outside this
range. Seven run-10 units list a starting path this range touches (DeployFinal/DeployLoop run, TreasuryGovernance
observer veto via DeployFinal, CI jobs via Makefile, mock evidence tenant via tools/verify-evidence/src, docker-compose and
tracked files via .gitignore): they are current changed-source work. The other 160 prior units are out of scope (source
unchanged). Recon leads for hunters: the checker's Sepolia trust root is the on-disk bundle dir; the repo-copy broadcast check is skipped when that path is absent; without `--artifacts` all code-identity inputs are pack-supplied. Recon gaps: no automated test of the wipe guards or env scrubbing; sandbox enforcement and FISCO runtime
behaviour are runtime facts.

## 8. Companion selection
- SUPPLY-CHAIN-AND-RELEASE: downloaded release files and their pins (`verify-release.sh`, `chain-up.sh`).
- DESKTOP-MOBILE-AND-LOCAL-IPC: local secret handling (env file, keystores, pw file), local file ownership/TOCTOU (wipe,
  marker), unauthenticated loopback services (8545, P2P).
- PROTOCOLS-RPC-AND-MESSAGING: the pack as an untrusted message (canonicalization, defaults, envelope/payload identity,
  stale/duplicate steps) and RPC answers as untrusted producers.
- RESOURCE-EXHAUSTION-AND-AVAILABILITY: pack size/cardinality in the checker.
Excluded: CLIENT-SIDE, CLOUD-AND-DEPLOYMENT, MEMORY-SAFETY-AND-BINARY, WEB-PROTOCOL-AND-AUTH, AI-AND-LLM,
DATA-ISOLATION-AND-LIFECYCLE (reasons per unit in the ledger).
