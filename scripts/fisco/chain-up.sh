#!/bin/bash
# chain-up.sh: build and start the local FISCO BCOS 3.17.1 mirror chain on 127.0.0.1: four sealers, plus node4 as the
# regulator's observer with --nodes 5. Auth mode is on: the regulator (a keystore made here, in D/keys) is the genesis
# committee's governor (build_chain.sh -a). build_chain.sh runs under build.sb (no network; writes only D/build,
# D/nodes, D/home and D/tmp) with local stubs in place of its two download paths; every node runs under node.sb
# (loopback only; reads and writes only D/nodes). Nothing is downloaded or installed; no sudo.
set -euo pipefail
set +x
# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/lib.sh"
# shellcheck source=chain-lib.sh
. "$FISCO_SCRIPT_DIR/chain-lib.sh"

usage() {
  cat <<'EOF'
Usage: chain-up.sh --build-chain <path> --binary <path> [--dir D] [--nodes 4|5]
  --build-chain  build_chain.sh v3.17.1 (size and SHA-256 checked against SHA256SUMS; copied to D/tools and run there)
  --binary       the node binary installed by verify-release.sh: exactly D/bin/fisco-bcos (size and SHA-256 checked
                 before the build and again right before the nodes start; D/bin is then made read-only)
  --dir D        chain dir (default ~/fisco-hogee): outside the repo, ~/Desktop, ~/Documents and iCloud Drive
  --nodes        5 (default: node0-node3 sealers, node4 observer) or 4 (sealers only)
Refuses as root, if D/nodes exists (wipe with chain-down.sh --wipe first), if any of 30300-30304, 20200-20204, 8545
or 8546 is listening, or if ~/.fisco exists. Web3 RPC: http://127.0.0.1:8545 (node0) and http://127.0.0.1:8546
(node4, the regulator's observer). Native RPC (TLS): 127.0.0.1:20200. Then run chain-check.sh.
Writes D/keys/regulator.json (made once, kept), D/run/<node>.pid and .cmd (start records), D/logs/<node>.out,
D/observer.block, and for the replay (mode 444; sdk.key 400): D/facts/regulator.address, D/facts/sdk/{ca.crt,sdk.crt,
sdk.key}, D/facts/config.genesis and D/facts/observer.proposal; no sandbox can write any of them.
EOF
}

BUILD_CHAIN=""
BINARY=""
D_RAW="$HOME/fisco-hogee"
NODES=5
while [ $# -gt 0 ]; do
  case "$1" in
    --build-chain) BUILD_CHAIN="${2:?--build-chain needs a path}"; shift 2 ;;
    --binary) BINARY="${2:?--binary needs a path}"; shift 2 ;;
    --dir) D_RAW="${2:?--dir needs a path}"; shift 2 ;;
    --nodes) NODES="${2:?--nodes needs 4 or 5}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument $1" ;;
  esac
done
[ -n "$BUILD_CHAIN" ] && [ -n "$BINARY" ] || { usage >&2; exit 2; }
case "$NODES" in 4 | 5) ;; *) die "--nodes must be 4 or 5" ;; esac
refuse_root
need_exec "$SANDBOX_EXEC" "$OPENSSL3" "$JQ" "$CURL" "$CAST" /usr/bin/openssl
[ -d "$OPENSSL_CELLAR" ] || die "missing $OPENSSL_CELLAR (Homebrew openssl@3 stands in for TASSL)"

D=$(resolve_chain_dir "$D_RAW")
prepare_chain_dir "$D"
set_foundry_cwd "$D"
ROOT=$(nodes_root "$D")
[ ! -e "$D/nodes" ] || die "$D/nodes exists (build_chain.sh refuses it): chain-down.sh --dir $D --wipe, or move it"
for p in $FISCO_PORTS; do
  ! port_in_use "$p" || die "port $p is already listening"
done
[ ! -e "$FISCO_HOME_P/.fisco" ] || die "~/.fisco exists; inspect and remove it first (the build uses HOME=D/home)"

# --- inputs: the pinned build_chain.sh (copied where the build sandbox can read it) and the pinned binary in D ---
[ -f "$BUILD_CHAIN" ] && [ ! -L "$BUILD_CHAIN" ] || die "--build-chain is not a regular file"
[ "$(size_of "$BUILD_CHAIN")" = "$FISCO_SIZE_BUILD_CHAIN" ] || die "build_chain.sh size differs from $FISCO_SIZE_BUILD_CHAIN"
[ "$(sha256_of "$BUILD_CHAIN")" = "$(pinned_sha256 build_chain.sh)" ] || die "build_chain.sh digest differs from SHA256SUMS"
for sub in tools home home/.fisco tmp logs run facts; do safe_dir "$D/$sub"; done
# The observer proposal (with 5 nodes) is cast's one RPC call here: prove the egress block now, before anything is
# built.
[ "$NODES" != 5 ] || foundry_egress_check "$D"

# --- the regulator: a keystore in D/keys (kept across rebuilds of D/nodes), made before the build. Its address, lower
# case, goes to build_chain.sh -a (genesis [executor] auth_admin_account, with is_auth_check=true) and to
# D/facts/regulator.address for the checks and the replay. ---
ensure_keystore "$D" regulator.json
REG_ADDR=$(keystore_address "$D" regulator.json | tr 'A-F' 'a-f') || die "could not read the regulator's address"
[[ "$REG_ADDR" =~ ^0x[0-9a-f]{40}$ ]] || die "the regulator keystore gave no address"
write_fact "$D/facts/regulator.address" "$REG_ADDR"
info "PASS regulator $REG_ADDR (D/keys/regulator.json): the genesis auth admin"
# A fresh, empty working folder for the build (build_chain.sh writes public.pem and accounts* in its cwd).
if [ -e "$D/build" ] || [ -L "$D/build" ]; then
  safe_dir "$D/build"
  rm -rf -- "$D/build"
fi
safe_dir "$D/build"
BC="$D/tools/build_chain.sh"
rm -f -- "$BC"
cp -- "$BUILD_CHAIN" "$BC"
chmod 444 "$BC"
[ "$(sha256_of "$BC")" = "$(pinned_sha256 build_chain.sh)" ] || die "the copied build_chain.sh differs"

[ -f "$BINARY" ] && [ ! -L "$BINARY" ] || die "--binary is not a regular file"
BIN="$(real_dir "$(dirname -- "$BINARY")")/$(basename -- "$BINARY")"
[ "$BIN" = "$D/bin/fisco-bcos" ] || die "--binary must be $D/bin/fisco-bcos (run verify-release.sh --dir $D)"
safe_dir "$D/bin"
# The pinned binary: right size and digest, a regular file that is not a link. Checked now and right before the start.
check_binary() {
  [ -f "$BIN" ] && [ ! -L "$BIN" ] || die "$BIN is not a regular file"
  [ "$(size_of "$BIN")" = "$FISCO_SIZE_BINARY" ] || die "fisco-bcos size differs from $FISCO_SIZE_BINARY"
  [ "$(sha256_of "$BIN")" = "$(pinned_sha256 fisco-bcos)" ] || die "fisco-bcos digest differs from SHA256SUMS"
}
check_binary

# --- stubs for build_chain.sh's two download paths (check_and_install_tassl, generate_auth_account). With -a the
# second is never taken; the stub (exit 1) stays so that a missing file can never lead to a download. ---
TASSL="$D/home/.fisco/tassl-1.1.1b"
[ ! -e "$TASSL" ] || [ -L "$TASSL" ] || die "$TASSL exists and is not a symlink; remove it first"
ln -sfn -- "$OPENSSL3" "$TASSL"
write_account_stub "$D/home/.fisco/get_account.sh"

# build_chain.sh reuses /tmp/secp256k1.param when present: never accept one we did not just make.
PARAM=/private/tmp/secp256k1.param
if [ -e "$PARAM" ] || [ -L "$PARAM" ]; then
  [ -O "$PARAM" ] && [ ! -L "$PARAM" ] || die "$PARAM exists and is not ours; remove it first"
  rm -f -- "$PARAM"
fi

# --- build, sandboxed: cwd D/build; writes only D/build, D/nodes, D/home, D/tmp (+ /tmp/secp256k1.param). It runs as
# its own process group, and nothing it started may outlive it: every check-then-write into D/nodes below assumes
# no build process can still change D/nodes. ---
info "building $NODES nodes in $D/nodes (log: $D/logs/build.log)"
safe_target "$D/logs/build.log"
sandboxed_build() {
  cd -- "$D/build" || exit 1
  exec /usr/bin/env -i PATH=/usr/bin:/bin HOME="$D/home" TMPDIR="$D/tmp" LC_ALL=C \
    "$SANDBOX_EXEC" -D CHAIN_DIR="$D" -D BIN="$BIN" -D OPENSSL_CELLAR="$OPENSSL_CELLAR" \
    -f "$FISCO_SCRIPT_DIR/build.sb" /bin/bash "$BC" -l "127.0.0.1:$NODES" -p 30300,20200 \
    -o "$D/nodes" -e "$BIN" -a "$REG_ADDR"
}
BUILD_RC=0
run_group 0 "$D/logs/build.log" sandboxed_build || BUILD_RC=$?
build_leftovers "$D" "$RUN_GROUP_PGID"
[ -z "$BUILD_LEFT" ] ||
  die "build processes still running after build_chain.sh exited (pids $BUILD_LEFT); stop them, then wipe D"
[ "$BUILD_RC" = 0 ] || die "build_chain.sh failed (exit $BUILD_RC); see $D/logs/build.log"
[ ! -e "$FISCO_HOME_P/.fisco" ] || die "the build created ~/.fisco"
if [ -e "$PARAM" ]; then
  [ "$(cat -- "$PARAM")" = "$("$OPENSSL3" ecparam -name secp256k1)" ] || die "$PARAM is not the named secp256k1 curve"
fi
# Nothing the build sandbox left may redirect the writes below: no symlink anywhere in D but the TASSL stub.
LINKS=$(unexpected_links "$D")
[ -z "$LINKS" ] || die "symlinks under $D after the build: $(printf '%s' "$LINKS" | tr '\n' ' ')"
safe_dir "$D/nodes"

# --- check what was generated ---
[ "$(node_count "$D")" = "$NODES" ] || die "expected $NODES node folders under $ROOT"
for nd in $(node_dirs "$D"); do
  id=$(cat -- "$nd/conf/node.nodeid")
  [[ "$id" =~ ^[0-9a-f]{128}$ ]] || die "$nd/conf/node.nodeid is not 128 hex digits"
  key_text=$("$OPENSSL3" ec -in "$nd/conf/node.pem" -noout -text 2>/dev/null) || die "cannot read $nd/conf/node.pem"
  [[ "$key_text" == *"ASN1 OID: secp256k1"* ]] || die "$nd/conf/node.pem is not a secp256k1 key"
done
# node4's id, read and checked now: once the nodes run, their folders are theirs to rewrite.
NODE4_ID=""
[ "$NODES" != 5 ] || NODE4_ID=$(cat -- "$ROOT/node4/conf/node.nodeid")

# --- CA fix (P1, 20 Oct): OpenSSL 3 as the TASSL stand-in issues the chain CA without basicConstraints, so node TLS
# fails ("unknown ca"). Reissue only the CA certificate, same key and subject, and copy it everywhere it was copied.
CA="$D/nodes/ca"
SUBJ=$("$OPENSSL3" x509 -in "$CA/ca.crt" -noout -subject -nameopt compat | sed 's/^subject=//') ||
  die "could not read the CA subject"
[ -n "$SUBJ" ] || die "empty CA subject"
safe_target "$CA/ca.crt.new"
safe_target "$D/logs/ca-reissue.log"
"$OPENSSL3" req -new -x509 -days 36500 -subj "$SUBJ" -key "$CA/ca.key" -out "$CA/ca.crt.new" \
  -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign \
  -addext subjectKeyIdentifier=hash 2>"$D/logs/ca-reissue.log" || die "CA reissue failed; see $D/logs/ca-reissue.log"
mv -- "$CA/ca.crt.new" "$CA/ca.crt"
if [ -f "$ROOT/ca/ca.crt" ]; then # build_chain's spare copy; no node reads it
  safe_target "$ROOT/ca/ca.crt"
  cp -- "$CA/ca.crt" "$ROOT/ca/ca.crt"
fi
for t in "$ROOT/sdk/ca.crt" $(for nd in $(node_dirs "$D"); do echo "$nd/conf/ca.crt"; done); do
  [ -f "$t" ] || die "expected a CA copy at $t"
  safe_target "$t"
  cp -- "$CA/ca.crt" "$t"
done
for c in "$ROOT/sdk/sdk.crt" $(for nd in $(node_dirs "$D"); do echo "$nd/conf/ssl.crt"; done); do
  "$OPENSSL3" verify -CAfile "$ROOT/node0/conf/ca.crt" "$c" >/dev/null 2>&1 || die "openssl verify failed for $c"
done
info "PASS CA reissued with basicConstraints; every node and sdk certificate verifies"
# The replay's TLS files for the native RPC (node0, 127.0.0.1:20200), taken now: once the nodes run, their folders
# are theirs to rewrite; D/facts is not.
snapshot_sdk "$D"

# --- configs before the first start ---
rewrite_node_configs "$D"
PROBLEMS=$(static_config_problems "$D"; regulator_fact_problems "$D")
[ -z "$PROBLEMS" ] || die "config check: $(printf '%s' "$PROBLEMS" | tr '\n' ';')"
info "PASS configs: loopback only, CORS off, Web3 RPC on node0 (8545) and node4 (8546), native RPC on TLS, identical"
info "     genesis, sealers node.0-node.3, auth checks on with the regulator as admin; D/facts/sdk snapshot"

# --- the replay's genesis input: a read-only snapshot taken before any node runs (nodes can rewrite their own copy) ---
safe_target "$D/facts/config.genesis"
rm -f -- "$D/facts/config.genesis"
cp -- "$ROOT/node0/config.genesis" "$D/facts/config.genesis"
chmod 444 "$D/facts/config.genesis"
cmp -s -- "$ROOT/node0/config.genesis" "$D/facts/config.genesis" || die "the genesis snapshot differs"

# --- right before the start: the binary is still the pinned one, bin/ read-only, no symlink in D but the stub ---
check_binary
chmod 555 "$BIN" "$D/bin"
LINKS=$(unexpected_links "$D")
[ -z "$LINKS" ] || die "symlinks under $D: $(printf '%s' "$LINKS" | tr '\n' ' ')"
safe_dir "$D/nodes/.home"
safe_dir "$D/nodes/.tmp"
PROFILE_SUM="$D/run/node.sb.sha256"
safe_target "$PROFILE_SUM"
sha256_of "$FISCO_SCRIPT_DIR/node.sb" >"$PROFILE_SUM"

# --- start every node under node.sb (never the generated start.sh). Output, pid and start record go to D/logs and
# D/run, which no sandbox can write; the start command is recorded exactly as run, for chain-check.sh. ---
NODE_ARGV=("$SANDBOX_EXEC" -D "NODES_DIR=$D/nodes" -D "BIN=$BIN" -f "$FISCO_SCRIPT_DIR/node.sb" "$BIN" -c config.ini
  -g config.genesis)
[ "${NODE_ARGV[*]}" = "$(node_start_line "$D")" ] || die "the node start command differs from node_start_line"
for nd in $(node_dirs "$D"); do
  name=$(basename -- "$nd")
  for f in "$D/logs/$name.out" "$(node_pid_file "$D" "$nd")" "$D/run/$name.cmd"; do safe_target "$f"; done
  printf '%s\n' "${NODE_ARGV[*]}" >"$D/run/$name.cmd"
  (
    cd -- "$nd"
    /usr/bin/env -i PATH=/usr/bin:/bin HOME="$D/nodes/.home" TMPDIR="$D/nodes/.tmp" LC_ALL=C \
      AWS_EC2_METADATA_DISABLED=true /usr/bin/nohup "${NODE_ARGV[@]}" </dev/null >>"$D/logs/$name.out" 2>&1 &
    echo $! >"$(node_pid_file "$D" "$nd")"
  )
done
sleep 2
for nd in $(node_dirs "$D"); do
  pid_is_node "$(cat -- "$(node_pid_file "$D" "$nd")")" ||
    die "$(basename -- "$nd") exited; see $D/logs/$(basename -- "$nd").out and $nd/log"
done

ok=0
for _ in $(seq 1 60); do
  if [ "$(rpc eth_chainId 2>/dev/null || true)" = "$FISCO_CHAIN_ID_HEX" ]; then ok=1; break; fi
  sleep 1
done
[ "$ok" = 1 ] || die "no eth_chainId $FISCO_CHAIN_ID_HEX on $FISCO_RPC within 60 s (nodes may be running: chain-down.sh)"
info "PASS eth_chainId $FISCO_CHAIN_ID_HEX on $FISCO_RPC"

# --- node4 joins as the regulator's observer through FISCO's governance. With auth checks on, a direct addObserver
# on 0x...1003 is refused; instead the regulator (the only governor) sends CommitteeManager
# createSetConsensusWeightProposal(node4 id, weight 0, add, 1000 blocks), which passes and runs inside that
# transaction (P1's live test, 20 Oct: block 1, status 0x1). This is the regulator's only transaction before the
# replay; the replay's ledger check expects exactly it. ---
if [ "$NODES" = 5 ]; then
  foundry_egress_check "$D" # again right before the send: nothing may listen on the dead proxy's port now either
  [[ "$NODE4_ID" =~ ^[0-9a-f]{128}$ ]] || die "node4 id not read before the start"
  is_governor "$REG_ADDR" || die "CommitteeManager.isGovernor($REG_ADDR) is not true: auth mode or the admin is wrong"
  # --chain: the signature names chain 20200 whatever the RPC reports (EIP-155), so it is valid on no other chain.
  OUT=$(foundry_in "$FOUNDRY_CWD" "$CAST" send --json --legacy --gas-limit 3000000 --gas-price 0 --rpc-url "$FISCO_RPC" \
    --chain "$FISCO_CHAIN_ID" --keystore "$D/keys/regulator.json" --password-file "$D/keys/pw" \
    "$FISCO_COMMITTEE_MANAGER" "$FISCO_SIG_OBSERVER_PROPOSAL" "$NODE4_ID" 0 true 1000) ||
    die "the observer proposal failed"
  STATUS=$(printf '%s' "$OUT" | "$JQ" -r '.status')
  case "$STATUS" in 0x1 | 1) ;; *) die "the observer proposal mined with status $(printable "$STATUS")" ;; esac
  [ "$(printf '%s' "$OUT" | "$JQ" -r '.from' | tr 'A-F' 'a-f')" = "$REG_ADDR" ] ||
    die "the observer proposal was not sent by the regulator"
  [ "$(printf '%s' "$OUT" | "$JQ" -r '.to' | tr 'A-F' 'a-f')" = "$FISCO_COMMITTEE_MANAGER" ] ||
    die "the observer proposal did not go to CommitteeManager"
  OBS_TX=$(printf '%s' "$OUT" | "$JQ" -r '.transactionHash' | tr 'A-F' 'a-f')
  [[ "$OBS_TX" =~ ^0x[0-9a-f]{64}$ ]] || die "the observer proposal: no transaction hash"
  OBS_BLOCK=$(hex_to_dec "$(printf '%s' "$OUT" | "$JQ" -r '.blockNumber')") ||
    die "the observer proposal: no block number"
  safe_target "$D/observer.block"
  printf '%s\n' "$OBS_BLOCK" >"$D/observer.block"
  write_fact "$D/facts/observer.proposal" "$OBS_TX"
  info "PASS node4 added as observer by the regulator's proposal $OBS_TX in block $OBS_BLOCK (from the next block on)"
fi
info "chain up: $NODES nodes in $D/nodes; next: chain-check.sh --dir $D"
