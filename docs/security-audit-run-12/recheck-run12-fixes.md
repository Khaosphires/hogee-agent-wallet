# Run-12 fixes and post-fix skills re-check (20 Oct 2026)

Security audit run-12 (quick, scoped `2590ae0..6b0913e`, source-only) reviewed the FISCO regulator governance, node4
ledger, Sepolia anchor and Proof page FISCO view. It left 4 `needs_validation` leads and 1 deferred critic gap (see
`REPORT.md` and `NEEDS-VALIDATION.md`), plus 45 hardening notes.

The fixes ran in two rounds: fix12-anchor, fix12-check, fix12-web and fix12-chain, then fix12b. They were re-checked
twice: once for the leads and the brief items, and once with the `security-review`, `nodejs-keccak256` and
`llm-trading-agent-security` skills. The result was then exercised on freshly built chains.

## Leads and gap

| Item | Fix | Re-check | Live check |
|---|---|---|---|
| v-1: the Proof page showed a passing "Timestamped on Sepolia" for a pack with no anchor | The row appears only when a sidecar was served or the check failed; otherwise a neutral, uncounted "Not timestamped yet". A result that claims an anchor without a sidecar fails. The "public part" sentence needs a passed anchor (fix12-web) | closed | The browser verified the v2 dry-run pack as "16 of 16" with "Not timestamped yet" |
| v-2: the anchor tx's nonce, gas and fees were filled by the RPC | `anchor.sh` sets them itself: nonce (latest = pending); gas = 21,000 + 40 × calldata bytes + 2,000 (EIP-7623 floor), with `cast estimate` ≤ limit; base fee ≤ 20 gwei; tip 1 gwei; max fee ≤ 50 gwei. Both decoders (jq and `check-raw`) enforce type 2, gas ≤ 60,000, the fee caps and the nonce. The prompt shows nonce, gas, both caps and the maximum cost (≤ 0.003 ETH). Stdin is drained before the prompt; an empty `foundry.toml` is written; cast's stderr is scrubbed of URLs (fix12-anchor). Password and `y` are read from the terminal (fix12b) | closed | `anchor-sh.live.test.ts` against Anvil (chain id 11155111): 8 passed |
| v-3: `build.sb` inherited trustd and XPC-service lookups | `build.sb` gets node.sb's mach-lookup deny list. Both profiles deny `(xpc-service-name-prefix "")`. Both deny `process-info*` except for the process itself, which closes a second gap found during the fix: numeric `kern.procargs2.<pid>` reads were allowed (checked by macOS as `process-info-pidinfo`, not as a sysctl read) (fix12-chain) | closed | `chain-check --selftest` on a fresh chain: other processes' arguments denied under both profiles; trustd lookup denied under both (`security verify-cert` fails inside, succeeds outside); hard links out of D denied under both. `build_chain.sh` and five nodes ran normally under the new rules |
| v-4: `fisco:sepolia-code` printed RPC text raw | Shape checks on the block number and the `eth_call` answer; the failure line goes through `nodeText`; JSON-RPC bodies capped at 4 MiB (fix12-anchor) | closed | unit tests with ESC bytes in node answers |
| Critic gap: passing rows and the timestamp card claimed more than the browser proved | Every row shows the checker's own detail, so caveats travel with the pass. Labels reworded (code identity "outside per-deployment values, artifacts from the pack"; ledger "node4's served copy"). The timestamp card says "Publicly timestamped" only when both the pack and the anchor pass, with block and time "as recorded with the pack; confirm on Etherscan". `parseSignedTx` accepts only canonical low-s bytes, so a malleated twin of an anchor cannot pass under another hash (fix12-web, fix12-anchor, fix12b) | closed | unit and e2e tests (26/26 evidence specs) |

Severity of what the two post-fix re-checks found: the leads re-check reported no critical, high or medium issue (four new lows); the skills re-check (`security-review`, `nodejs-keccak256`, `llm-trading-agent-security`) reported no critical or high issue (four lows). Every low was fixed in fix12b except the accepted residuals listed below.

## Other fixes from the hardening notes
- **Ledger:** `ledger.json` holds node4's own blocks and tx objects (fix12-check, fix12b); `node0Keccak` is node0's
  separately read copy.
- **Observer proposal:** must be the regulator's nonce 0, mined before the first deploy; G0 is its nonce 1.
- **Regulator key:** the regulator must be a key of its own.
- **Ordering:** steps in one block must follow seq order.
- **Hash index:** `Object.hasOwn` in the hash-index checks.
- **Escaping:** more invisible characters are escaped in the CLI output and on the page.
- **Node counts:** chain.json must say 5 nodes, 4 sealers and 1 observer.
- **Creation code:** each creation code must carry its runtime code, even without `--artifacts`.
- **Regulator key errors:** they name only the variable.
- **Refusal steps:** sent only when their probe failed with the expected error (fix12b).
- **FISCO API:** serves only allow-listed pack paths. It applies tenancy before the listing cap and reads `pack.json` with a
  64 KiB cap (fix12b). `readInside` reads exactly the checked size.
- **Stop cards:** show the chain's words only when they equal FISCO's known texts for status 22 and 18.
- **Chain dir:** an existing folder is adopted only if it is empty or carries its own marker. A chain dir may not be,
  contain or sit inside the repo, `~/hogee-wt`, `~/Desktop`, `~/Documents` or cloud folders.
- **Links:** unsandboxed writes and key files require link count 1.
- **Foundry:** `--chain 20200` is passed to every Foundry send. The dead-proxy check runs before every Foundry run.
- **Listeners:** chain-check ties 8545 and 20200 to node0's pid and 8546 to node4's.
- **CODEOWNERS:** P1 lines for the browser and API FISCO code.

## nodejs-keccak256 re-check
Every Ethereum hash in scope is Keccak-256 (viem, @noble/hashes or `cast keccak`); nothing uses Node's sha3-256.

An independent recomputation (pycryptodome) over the v2 dry-run pack `fm-38d95c6fe2de777d` matched everything:
- 59/59 `hashes.json` entries;
- 38/38 transaction hashes (file name = keccak(raw) = served hash = receipt hash = native receipt hash);
- the packId;
- 25/25 source-bundle pins and the broadcast pin;
- the ledger digest and 38/38 input hashes;
- all 11 function selectors.

## Accepted residuals
- The regulator keystore password is in `cast`'s environment during the decrypt in `replay.sh`. It is visible to the
  user's own unsandboxed processes for a moment; sandboxed nodes can no longer read other processes' details. The key is
  local to the throwaway chain.
- Each FISCO file request re-runs the tenancy check and the pack walk (bounded by the caps; the existing L10 note).
- The anchor's nonce, base fee and gas estimate come from the one RPC. All are bounded by the caps, and the nonce is
  shown at the prompt.
- A signed but declined anchor tx stays valid until its nonce is used. It is a genuine anchor of the same text, at a cost
  of at most 0.003 ETH.
- The anchor's block and time are as stated by the sidecar until confirmed online or on Etherscan.
- The published packs carry the FINAL keys' raw txs for chain 20200, FISCO's default chain id. They carry zero value and a
  zero gas price, and Sepolia is unaffected.
- The other `system.sb` services (opendirectoryd, cfprefsd, logd) stay reachable. `system-network` is not applied.
- Carried from run-11: forge and cast follow a redirect to another 127.0.0.1 port (throwaway keys only); `bsd.sb`
  metadata reads and `*.CFUserTextEncoding` writes; the binary is unauditable; FISCO headers are taken as served.

## Final run
The chain was rebuilt from scratch with the final scripts (commit `1556707`, chain dir `~/fisco-hogee/chain4`):
`verify-release`, `chain-up` (5 nodes, auth on, regulator as genesis admin, node4 by proposal), `chain-check --selftest`
(all probes passed, including the new process-info, trustd and hard-link probes), `deploy` (DeployFinal and VerifyFinal),
and `replay`. The replay ran 37 steps and 38 transactions, with F1 and M1 refused by the chain and node4's ledger equal to
node0's. The pack is `evidence/fisco/fm-6abe83e663a2471b`: `make verify-fisco` reports VERIFIED 18/18 with and without
`contracts/out`, and a one-byte edit makes it NOT VERIFIED. The chain is stopped and its data kept.

The pack was then anchored on Sepolia by the user typing the hogee-deployer password into `scripts/fisco/anchor.sh`
(nonce 12, gas limit 31,680, max fee 1 gwei, maximum cost 0.0000317 ETH): tx `0xd38cd129ee4082117436f1f9fbef93bd72862eb5f26b7f6a15dee0c0d2d36d5a`, block 11951818.
`make verify-fisco` now passes `--require-anchor`; offline and online (`HOGEE_ANCHOR_RPC`, publicnode) both report
VERIFIED.
