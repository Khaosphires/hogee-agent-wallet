#!/bin/bash
# deploy.sh: deploy the final-2 contract set to the local FISCO mirror chain with DeployFinal, using the constructor
# values of the tracked Sepolia final-2 broadcast (decoded, never typed), then read it back with VerifyFinal.
# Loopback only: it refuses any chain but 20200 at 127.0.0.1:8545. The deployer is a throwaway keystore in D/keys.
# Every forge and cast call runs through foundry_in: a scrubbed environment whose HTTP proxy variables point at a
# closed loopback port, so a request or redirect to any host but 127.0.0.1 fails (foundry_egress_check proves it
# before the first RPC call); cast runs from the empty D/cwd, never from D.
set -euo pipefail
set +x
# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/lib.sh"

usage() {
  cat <<'EOF'
Usage: deploy.sh --dir D --repo <worktree> [--dry-run]
  --dir D     chain dir made by chain-up.sh (chain-check.sh must pass)
  --repo      repo checkout whose contracts/ is deployed (contracts/dependencies restored)
  --dry-run   only decode and check the Sepolia final-2 inputs (offline) and print them; touches no chain
Writes D/deploy/fisco-final-2.json (DeployFinal's manifest), D/deploy/run-<ts>.json (the forge broadcast),
D/deploy/deploy-info.json (deployer, governance, Sepolia source, constructor inputs) and the forge logs. Refuses if
D/deploy/fisco-final-2.json already exists or the throwaway deployer has sent anything.
EOF
}

D_RAW=""
REPO_RAW=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) D_RAW="${2:?--dir needs a path}"; shift 2 ;;
    --repo) REPO_RAW="${2:?--repo needs a path}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument $1" ;;
  esac
done
[ -n "$D_RAW" ] && [ -n "$REPO_RAW" ] || { usage >&2; exit 2; }
refuse_root
need_exec "$CAST" "$FORGE" "$JQ" "$CURL"
D=$(resolve_chain_dir "$D_RAW")
require_marker "$D"
set_foundry_cwd "$D"
[ -d "$REPO_RAW" ] || die "no such repo folder: $REPO_RAW"
REPO=$(cd -- "$REPO_RAW" && pwd -P)
C="$REPO/contracts"
[ -f "$C/foundry.toml" ] && [ -d "$C/dependencies" ] || die "$C needs foundry.toml and its restored dependencies"
OUT="$D/deploy"
MANIFEST="$OUT/fisco-final-2.json"
safe_dir "$D/logs"
safe_target "$D/logs/forge-inspect.log"

# --- the Sepolia final-2 broadcast: the run file whose four contracts are packages/chain's sepolia-final-2 ---
SEP_MANIFEST="$REPO/packages/chain/deployments/sepolia-final-2.json"
[ -f "$SEP_MANIFEST" ] || die "missing $SEP_MANIFEST"
WANT=$("$JQ" -r '[.contracts.PlanRegistry.address, .contracts.Treasury.address, .contracts.MilestoneEscrow.address,
  .contracts.SalesOracle.address] | map(ascii_downcase) | join(",")' "$SEP_MANIFEST")
SRC=""
for f in "$C/broadcast/DeployFinal.s.sol/11155111"/run-[0-9]*.json; do
  [ -f "$f" ] || continue
  got=$("$JQ" -r '[.transactions[].contractAddress | ascii_downcase] | join(",")' "$f")
  if [ "$got" = "$WANT" ]; then
    [ -z "$SRC" ] || die "two Sepolia broadcast files match final-2"
    SRC="$f"
  fi
done
[ -n "$SRC" ] || die "no Sepolia DeployFinal broadcast matches $SEP_MANIFEST"
[ "$("$JQ" -r '[.transactions[].contractName] | join(",")' "$SRC")" = "PlanRegistry,Treasury,MilestoneEscrow,SalesOracle" ] ||
  die "unexpected transactions in $SRC"
info "PASS Sepolia final-2 broadcast: ${SRC#"$REPO"/}"

# --- same bytecode: the Sepolia creation inputs start with today's artifacts; the rest is the constructor input ---
# (forge inspect, not forge build: forge build trips over a symlinked contracts/dependencies in a worktree.)
ctor_args() {
  local i="$1" name input code
  name=$("$JQ" -r ".transactions[$i].contractName" "$SRC")
  input=$("$JQ" -r ".transactions[$i].transaction.input" "$SRC")
  code=$(foundry_in "$C" "$FORGE" inspect "$name" bytecode --offline 2>>"$D/logs/forge-inspect.log") ||
    die "forge inspect $name failed; see $D/logs/forge-inspect.log"
  [[ "$code" =~ ^0x[0-9a-f]+$ ]] || die "forge inspect $name gave no bytecode"
  [ "${input:0:${#code}}" = "$code" ] || die "$name: Sepolia creation code differs from today's build (not the same contracts)"
  printf '0x%s\n' "${input:${#code}}"
}
decode() {
  foundry_in "$FOUNDRY_CWD" "$CAST" abi-decode --input "$1" "$2"
}
for i in 2 3; do ctor_args "$i" >/dev/null; done
REG_ARGS=$(ctor_args 0)
TRE_ARGS=$(ctor_args 1)
info "PASS the four Sepolia creation codes equal today's build"

# PlanRegistry(lender, treasury, deploymentId, chainTag, fiscoMs, judgingWindowEnd)
REG=()
while IFS= read -r line; do REG+=("$line"); done < <(decode "f(address,address,bytes32,bytes32,bool,uint64)" "$REG_ARGS")
[ "${#REG[@]}" = 6 ] || die "could not decode the PlanRegistry constructor input"
LENDER="${REG[0]}"
[ "$(foundry_in "$FOUNDRY_CWD" "$CAST" parse-bytes32-string "${REG[2]}")" = final-2 ] || die "Sepolia deploymentId is not final-2"
[ "$(foundry_in "$FOUNDRY_CWD" "$CAST" parse-bytes32-string "${REG[3]}")" = sepolia ] || die "Sepolia chainTag is not sepolia"
[ "${REG[4]}" = false ] || die "Sepolia fiscoMs is not false"
JUDGING_END="${REG[5]%% *}"

# Treasury(registry, oracle, coolingSeconds, (escrow, salesOracle, observer, loosenTimelockSeconds), ids[], hashes[])
TRE=()
while IFS= read -r line; do TRE+=("$line"); done < <(decode \
  "f(address,address,uint64,(address,address,address,uint64),bytes32[],bytes32[])" "$TRE_ARGS")
[ "${#TRE[@]}" = 6 ] || die "could not decode the Treasury constructor input"
ORACLE="${TRE[1]}"
COOLING="${TRE[2]%% *}"
# "(escrow, salesOracle, observer, 120)"; cast may append " [8.64e4]" to large numbers.
LINKS=$(printf '%s' "${TRE[3]}" | sed -E 's/ \[[^]]*\]//g' | tr -d '() ')
OBSERVER=$(printf '%s' "$LINKS" | cut -d, -f3)
TIMELOCK=$(printf '%s' "$LINKS" | cut -d, -f4)
PAYEE_IDS=""
for id in $(printf '%s' "${TRE[4]}" | tr -d '[] ' | tr ',' ' '); do
  PAYEE_IDS="${PAYEE_IDS:+$PAYEE_IDS,}$(foundry_in "$FOUNDRY_CWD" "$CAST" parse-bytes32-string "$id")"
done
PAYOUT_HASHES=$(printf '%s' "${TRE[5]}" | tr -d '[] ')
for v in "$LENDER" "$ORACLE" "$OBSERVER"; do [[ "$v" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "bad address decoded: $v"; done
for v in "$JUDGING_END" "$COOLING" "$TIMELOCK"; do [[ "$v" =~ ^[0-9]+$ ]] || die "bad number decoded: $v"; done
[ -n "$PAYEE_IDS" ] && [ -n "$PAYOUT_HASHES" ] || die "no platform payees decoded"
info "inputs from Sepolia final-2: lender $LENDER oracle $ORACLE observer $OBSERVER cooling $COOLING s"
info "  timelock $TIMELOCK s judging end $JUDGING_END payees $PAYEE_IDS"

if [ "$DRY_RUN" = 1 ]; then
  info "dry run: DEPLOYMENT_ID=final-2 CHAIN_TAG=fisco FISCO_MS=false LENDER_ADDRESS=$LENDER ORACLE_ADDRESS=$ORACLE"
  info "  OBSERVER_ADDRESS=$OBSERVER COOLING_SECONDS=$COOLING LOOSEN_TIMELOCK_SECONDS=$TIMELOCK JUDGING_WINDOW_END=$JUDGING_END"
  info "  PLATFORM_PAYEE_IDS=$PAYEE_IDS"
  info "  PLATFORM_PAYOUT_HASHES=$PAYOUT_HASHES"
  exit 0
fi
[ ! -e "$MANIFEST" ] || die "$MANIFEST exists: this chain already has a deployment"

# --- the chain: healthy, confined, 20200 on loopback, and a seconds clock in the EVM ---
"$FISCO_SCRIPT_DIR/chain-check.sh" --dir "$D" || die "chain-check.sh failed"
case "$FISCO_RPC" in http://127.0.0.1:8545) ;; *) die "RPC must be http://127.0.0.1:8545" ;; esac
foundry_egress_check "$D"
[ "$(foundry_in "$FOUNDRY_CWD" "$CAST" chain-id --rpc-url "$FISCO_RPC")" = "$FISCO_CHAIN_ID" ] || die "cast chain-id is not 20200"
# eth_call of init code TIMESTAMP PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN: block.timestamp as the EVM sees it.
if CLOCK=$(foundry_in "$FOUNDRY_CWD" "$CAST" call --create 0x4260005260206000f3 --rpc-url "$FISCO_RPC" 2>/dev/null); then
  CLOCK=$(foundry_in "$FOUNDRY_CWD" "$CAST" to-dec "$CLOCK")
  [[ "$CLOCK" =~ ^[0-9]+$ ]] || die "the EVM clock probe gave no number"
  [ "${#CLOCK}" -lt 13 ] || die "the EVM clock reads $CLOCK (milliseconds?): check feature_evm_timestamp in the genesis"
  info "PASS EVM block.timestamp $CLOCK (seconds)"
else
  info "NOTE the EVM clock probe (eth_call without to) is not served; relying on the genesis feature_evm_timestamp=1 check"
fi

# --- the throwaway deployer: fresh keystore, nothing sent yet ---
ensure_keystore "$D" deployer.json
DEPLOYER=$(keystore_address "$D" deployer.json)
[ "$(foundry_in "$FOUNDRY_CWD" "$CAST" nonce --rpc-url "$FISCO_RPC" "$DEPLOYER")" = 0 ] || die "deployer $DEPLOYER has sent before"
safe_dir "$OUT"
for f in forge-deploy.log fisco-final-2.json.tmp fisco-final-2.json forge-verify.log deploy-info.json; do
  safe_target "$OUT/$f"
done

# DeployFinal's inputs (public values from the tracked Sepolia broadcast), passed to forge through env(1).
DEPLOY_ENV=(DEPLOYMENT_ID=final-2 CHAIN_TAG=fisco FISCO_MS=false "LENDER_ADDRESS=$LENDER" "ORACLE_ADDRESS=$ORACLE"
  "OBSERVER_ADDRESS=$OBSERVER" "COOLING_SECONDS=$COOLING" "LOOSEN_TIMELOCK_SECONDS=$TIMELOCK"
  "JUDGING_WINDOW_END=$JUDGING_END" "PLATFORM_PAYEE_IDS=$PAYEE_IDS" "PLATFORM_PAYOUT_HASHES=$PAYOUT_HASHES")

info "deploying with DeployFinal (log: $OUT/forge-deploy.log)"
# --chain 20200 explicitly (as for the observer proposal): the deployer signs for this chain only.
foundry_in "$C" /usr/bin/env "${DEPLOY_ENV[@]}" "$FORGE" script script/DeployFinal.s.sol:DeployFinal \
  --rpc-url "$FISCO_RPC" --chain "$FISCO_CHAIN_ID" --broadcast --legacy --slow --gas-estimate-multiplier 200 \
  --keystore "$D/keys/deployer.json" --password-file "$D/keys/pw" --sender "$DEPLOYER" </dev/null \
  >"$OUT/forge-deploy.log" 2>&1 || die "forge script DeployFinal failed; see $OUT/forge-deploy.log"

awk '/END DEPLOYMENT JSON/ {f = 0} f {sub(/^[ \t]+/, ""); print} /BEGIN DEPLOYMENT JSON/ {f = 1}' \
  "$OUT/forge-deploy.log" >"$MANIFEST.tmp"
"$JQ" -e '.chainId == 20200 and .deploymentId == "final-2" and .chainTag == "fisco"
  and ([.contracts | keys[]] | sort) == ["MilestoneEscrow", "PlanRegistry", "SalesOracle", "Treasury"]' \
  "$MANIFEST.tmp" >/dev/null || die "the printed manifest is missing or wrong; see $OUT/forge-deploy.log"
mv -- "$MANIFEST.tmp" "$MANIFEST"

# The CREATE addresses are the deployer's nonces 0-3 and every one has code.
i=0
for name in PlanRegistry Treasury MilestoneEscrow SalesOracle; do
  addr=$("$JQ" -r ".contracts.$name.address" "$MANIFEST")
  [[ "$addr" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "$name: no address in $MANIFEST"
  want=$(foundry_in "$FOUNDRY_CWD" "$CAST" compute-address "$DEPLOYER" --nonce "$i" | awk '{print $NF}')
  [ "$(printf '%s' "$addr" | tr 'A-F' 'a-f')" = "$(printf '%s' "$want" | tr 'A-F' 'a-f')" ] ||
    die "$name at $addr, expected deployer nonce $i address $want"
  [ "$(foundry_in "$FOUNDRY_CWD" "$CAST" code --rpc-url "$FISCO_RPC" "$addr")" != 0x ] || die "no code at $name $addr"
  i=$((i + 1))
done

RUN=$(ls -1t "$C/broadcast/DeployFinal.s.sol/$FISCO_CHAIN_ID"/run-[0-9]*.json 2>/dev/null | head -1 || true)
[ -n "$RUN" ] || die "no forge broadcast file for chain 20200"
"$JQ" -e '[.receipts[].status] | length == 4 and all(. == "0x1")' "$RUN" >/dev/null ||
  die "the broadcast does not hold four successful receipts: $RUN"
safe_target "$OUT/$(basename -- "$RUN")"
cp -- "$RUN" "$OUT/"
info "PASS deployed: $MANIFEST and $OUT/$(basename -- "$RUN")"

# --- read it back with VerifyFinal (read-only) ---
TREASURY=$("$JQ" -r .contracts.Treasury.address "$MANIFEST")
GOVERNANCE=$(foundry_in "$FOUNDRY_CWD" "$CAST" call --rpc-url "$FISCO_RPC" "$TREASURY" "governance()(address)")
[[ "$GOVERNANCE" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "Treasury.governance() gave no address"
VERIFY_ENV=("CHAIN_ID=$FISCO_CHAIN_ID" EXPECTED_DEPLOYMENT_ID=final-2 EXPECTED_CHAIN_TAG=fisco EXPECTED_FISCO_MS=false
  "REGISTRY_ADDRESS=$("$JQ" -r .contracts.PlanRegistry.address "$MANIFEST")" "TREASURY_ADDRESS=$TREASURY"
  "GOVERNANCE_ADDRESS=$GOVERNANCE" "ESCROW_ADDRESS=$("$JQ" -r .contracts.MilestoneEscrow.address "$MANIFEST")"
  "SALES_ORACLE_ADDRESS=$("$JQ" -r .contracts.SalesOracle.address "$MANIFEST")" "LENDER_ADDRESS=$LENDER"
  "ORACLE_ADDRESS=$ORACLE" "OBSERVER_ADDRESS=$OBSERVER" "COOLING_SECONDS=$COOLING" "LOOSEN_TIMELOCK_SECONDS=$TIMELOCK")
foundry_in "$C" /usr/bin/env "${VERIFY_ENV[@]}" "$FORGE" script script/VerifyFinal.s.sol:VerifyFinal \
  --rpc-url "$FISCO_RPC" --chain "$FISCO_CHAIN_ID" </dev/null >"$OUT/forge-verify.log" 2>&1 || die "VerifyFinal failed; see $OUT/forge-verify.log"
grep -q 'VerifyFinal: OK' "$OUT/forge-verify.log" || die "VerifyFinal did not report OK; see $OUT/forge-verify.log"
info "PASS VerifyFinal on chain 20200 (links, roles, domain tags, clock scale, cooling and timelock)"

"$JQ" -n --arg deployer "$DEPLOYER" --arg governance "$GOVERNANCE" --arg run "$(basename -- "$RUN")" \
  --arg sepoliaBroadcast "${SRC#"$REPO"/}" --arg sepoliaBroadcastSha256 "$(sha256_of "$SRC")" \
  --arg lender "$LENDER" --arg oracle "$ORACLE" --arg observer "$OBSERVER" --arg cooling "$COOLING" \
  --arg timelock "$TIMELOCK" --arg judging "$JUDGING_END" --arg ids "$PAYEE_IDS" --arg hashes "$PAYOUT_HASHES" \
  '{deployer: $deployer, governance: $governance, broadcastFile: $run, sepoliaBroadcast: $sepoliaBroadcast,
    sepoliaBroadcastSha256: $sepoliaBroadcastSha256, deploymentId: "final-2", chainTag: "fisco", fiscoMs: false,
    inputs: {lender: $lender, oracle: $oracle, observer: $observer, coolingSeconds: ($cooling | tonumber),
      loosenTimelockSeconds: ($timelock | tonumber), judgingWindowEnd: ($judging | tonumber),
      platformPayeeIds: ($ids | split(",")), platformPayoutHashes: ($hashes | split(","))}}' >"$OUT/deploy-info.json"
info "deploy done; next: replay.sh --dir $D --repo $REPO --sepolia-code <dir>"
