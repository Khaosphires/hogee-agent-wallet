# shellcheck shell=bash
# Config helpers for the generated FISCO node folders (chain-up.sh rewrites, chain-up.sh and chain-check.sh check).
# Sourced after lib.sh. The facts below come from reading build_chain.sh v3.17.1 and P1's smoke test and live test
# (20 Oct 2026): config.ini has listen_ip in [p2p], [rpc] and [web3_rpc] (all 0.0.0.0), [rpc] enable_ssl=true,
# [web3_rpc] enable=false and listen_port=8545 on every node, enable_cors=true; config.genesis lists the sealers as
# indented `node.N=<nodeid>: 1` lines and has no [features] section. With -a <address> it has [executor]
# is_auth_check=true and auth_admin_account=<that address, lower case>.

GENESIS_FEATURES="feature_evm_cancun feature_evm_timestamp feature_evm_address"

# Every value of key in [section] of an ini file (trimmed), one per line.
ini_get() {
  awk -v want="[$2]" -v key="$3" '
    { t = $0; gsub(/^[ \t]+|[ \t]+$/, "", t) }
    t ~ /^\[/ { sec = t; next }
    sec == want && index(t, "=") > 0 {
      k = substr(t, 1, index(t, "=") - 1); gsub(/[ \t]+$/, "", k)
      if (k == key) { v = substr(t, index(t, "=") + 1); gsub(/^[ \t]+/, "", v); print v }
    }' "$1"
}

# "<listen_ip lines> <of which not 127.0.0.1>" for a config.ini.
listen_ip_counts() {
  awk '{ t = $0; gsub(/^[ \t]+|[ \t]+$/, "", t) }
    t ~ /^listen_ip[ \t]*=/ { v = t; sub(/^listen_ip[ \t]*=[ \t]*/, "", v); n++; if (v != "127.0.0.1") b++ }
    END { print n + 0, b + 0 }' "$1"
}

# Web3 RPC per node, as "<enable> <port>": node0 on 8545 (deploy and replay), node4 (the regulator's observer) on 8546
# (the regulator's own copy of the ledger), node1-node3 off.
node_web3() {
  case "$1" in
    node0) echo "true 8545" ;;
    node4) echo "true 8546" ;;
    *) echo "false 8545" ;;
  esac
}

# Loopback everywhere, CORS off, [web3_rpc] enable=<web3> and listen_port=<port>. Rewrites in place; indentation kept.
# [rpc] enable_ssl stays true as generated (the replay reads native receipts over TLS).
rewrite_config_ini() {
  local f="$1" web3="$2" port="$3"
  case "$web3" in true | false) ;; *) die "rewrite_config_ini: web3 must be true or false" ;; esac
  case "$port" in 8545 | 8546) ;; *) die "rewrite_config_ini: the Web3 port must be 8545 or 8546" ;; esac
  safe_target "$f"
  safe_target "$f.new"
  awk -v web3="$web3" -v port="$port" '
    { t = $0; gsub(/^[ \t]+/, "", t) }
    t ~ /^\[/ { sec = t; gsub(/[ \t]+$/, "", sec); print; next }
    t ~ /^listen_ip[ \t]*=/ { sub(/listen_ip[ \t]*=.*/, "listen_ip=127.0.0.1"); print; next }
    t ~ /^enable_cors[ \t]*=/ { sub(/enable_cors[ \t]*=.*/, "enable_cors=false"); print; next }
    sec == "[web3_rpc]" && t ~ /^enable[ \t]*=/ { sub(/enable[ \t]*=.*/, "enable=" web3); print; next }
    sec == "[web3_rpc]" && t ~ /^listen_port[ \t]*=/ { sub(/listen_port[ \t]*=.*/, "listen_port=" port); print; next }
    { print }' "$f" >"$f.new"
  mv -- "$f.new" "$f"
}

# Sealers node.0-node.3 only (node4, if any, joins as an observer later) and the EVM features the mirror relies on:
# Cancun opcodes, block.timestamp in seconds, Ethereum-style CREATE addresses.
rewrite_genesis() {
  local f="$1" feat
  safe_target "$f"
  safe_target "$f.new"
  grep -q '^[[:space:]]*\[features\]' "$f" && die "$f already has a [features] section"
  sed -E '/^[[:space:]]*node\.4=/d' "$f" >"$f.new"
  {
    printf '[features]\n'
    for feat in $GENESIS_FEATURES; do printf '    %s=1\n' "$feat"; done
  } >>"$f.new"
  mv -- "$f.new" "$f"
}

# chain-up.sh's rewrites of every node folder, before the first start: config.ini (node_web3) and config.genesis.
rewrite_node_configs() {
  local d="$1" nd web3 port
  for nd in $(node_dirs "$d"); do
    read -r web3 port <<<"$(node_web3 "$(basename -- "$nd")")"
    rewrite_config_ini "$nd/config.ini" "$web3" "$port"
    rewrite_genesis "$nd/config.genesis"
  done
}

# Problems with the generated chain, one per line (nothing printed = all good). Checked before the first start and by
# chain-check.sh: node folders node0-node3 (and node4), loopback-only listeners, CORS off, Web3 RPC as node_web3 says,
# native RPC on TLS, genesis files byte-identical with the three features, exactly node.0-node.3 as sealers (each
# matching that node's id), Web3 chain id 20200, auth checks on, and the auth admin = facts/regulator.address.
static_config_problems() {
  local d="$1" n i nd name names f sums first sealers want web3 port admin reg
  n=$(node_count "$d")
  case "$n" in 4 | 5) ;; *) printf 'expected 4 or 5 node folders, found %s\n' "$n"; return 0 ;; esac
  names=""
  for nd in $(node_dirs "$d"); do
    name=$(basename -- "$nd")
    names="$names$name "
    f="$nd/config.ini"
    [ -f "$f" ] || { printf '%s: no config.ini\n' "$name"; continue; }
    grep -q '0\.0\.0\.0' "$f" && printf '%s: config.ini still has 0.0.0.0\n' "$name"
    [ "$(listen_ip_counts "$f")" = "3 0" ] || printf '%s: expected 3 listen_ip lines, all 127.0.0.1\n' "$name"
    [ "$(ini_get "$f" web3_rpc enable_cors)" = false ] || printf '%s: [web3_rpc] enable_cors is not false\n' "$name"
    read -r web3 port <<<"$(node_web3 "$name")"
    [ "$(ini_get "$f" web3_rpc enable)" = "$web3" ] || printf '%s: [web3_rpc] enable is not %s\n' "$name" "$web3"
    [ "$(ini_get "$f" web3_rpc listen_port)" = "$port" ] ||
      printf '%s: [web3_rpc] listen_port is not %s\n' "$name" "$port"
    [ "$(ini_get "$f" rpc enable_ssl)" = true ] ||
      printf '%s: [rpc] enable_ssl is not true (the replay reads native receipts over TLS)\n' "$name"
  done
  want="node0 node1 node2 node3 "
  [ "$n" = 4 ] || want="${want}node4 "
  [ "$names" = "$want" ] || printf 'node folders are "%s", expected "%s"\n' "$names" "$want"
  sums=$(for nd in $(node_dirs "$d"); do sha256_of "$nd/config.genesis" 2>/dev/null || echo missing; done | sort -u)
  [ "$(printf '%s\n' "$sums" | awk 'END {print NR}')" = 1 ] || printf 'config.genesis files differ between nodes\n'
  first="$(nodes_root "$d")/node0/config.genesis"
  [ -f "$first" ] || { printf 'node0: no config.genesis\n'; return 0; }
  for f in $GENESIS_FEATURES; do
    [ "$(ini_get "$first" features "$f")" = 1 ] || printf 'genesis: [features] %s is not 1\n' "$f"
  done
  [ "$(ini_get "$first" web3 chain_id)" = "$FISCO_CHAIN_ID" ] || printf 'genesis: [web3] chain_id is not 20200\n'
  sealers=$(grep -oE '^[[:space:]]*node\.[0-9]+=' "$first" | tr -d ' \t=' | tr '\n' ' ')
  [ "$sealers" = "node.0 node.1 node.2 node.3 " ] || printf 'genesis: sealers are "%s", expected node.0-node.3\n' "$sealers"
  for i in 0 1 2 3; do
    want=$(cat -- "$(nodes_root "$d")/node$i/conf/node.nodeid" 2>/dev/null || true)
    [ -n "$want" ] && [ "$(ini_get "$first" consensus "node.$i" | tr -d ' ')" = "$want:1" ] ||
      printf 'genesis: node.%s is not node%s'"'"'s id\n' "$i" "$i"
  done
  # Auth mode (build_chain.sh -a): permission checks on, and the regulator is the genesis committee's governor.
  [ "$(ini_get "$first" executor is_auth_check)" = true ] || printf 'genesis: [executor] is_auth_check is not true\n'
  admin=$(ini_get "$first" executor auth_admin_account | tr 'A-F' 'a-f')
  reg=""
  f="$d/facts/regulator.address"
  if [ -f "$f" ] && [ ! -L "$f" ]; then reg=$(cat -- "$f"); fi
  if [[ ! "$reg" =~ ^0x[0-9a-f]{40}$ ]]; then
    printf 'genesis: no valid facts/regulator.address to compare [executor] auth_admin_account with\n'
  elif [ "$admin" != "$reg" ]; then
    printf 'genesis: [executor] auth_admin_account is not facts/regulator.address\n'
  fi
  return 0
}

# Problems with the facts chain-up.sh leaves for the replay, one per line (nothing printed = all good):
# facts/regulator.address (the genesis auth admin, lower case, mode 444) and facts/sdk/{ca.crt,sdk.crt,sdk.key} (the
# native RPC's TLS files, taken after the CA fix; modes 444, 444 and 400; sdk.crt verifies against ca.crt). None of
# them, nor facts/ or facts/sdk/, may be a link.
regulator_fact_problems() {
  local d="$1" f mode want sdk="$1/facts/sdk"
  if [ -L "$d/facts" ] || [ ! -d "$d/facts" ]; then printf 'facts is missing or not a real folder\n'; return 0; fi
  f="$d/facts/regulator.address"
  if [ -L "$f" ] || [ ! -f "$f" ]; then
    printf 'facts/regulator.address is missing or not a regular file\n'
  else
    [[ "$(cat -- "$f")" =~ ^0x[0-9a-f]{40}$ ]] || printf 'facts/regulator.address is not a lower-case 0x address\n'
    mode=$(/usr/bin/stat -f %Lp -- "$f")
    [ "$mode" = 444 ] || printf 'facts/regulator.address mode is %s, want 444\n' "$mode"
  fi
  if [ -L "$sdk" ] || [ ! -d "$sdk" ]; then printf 'facts/sdk is missing or not a real folder\n'; return 0; fi
  for f in ca.crt sdk.crt sdk.key; do
    want=444
    [ "$f" != sdk.key ] || want=400
    if [ -L "$sdk/$f" ] || [ ! -f "$sdk/$f" ]; then
      printf 'facts/sdk/%s is missing or not a regular file\n' "$f"
      continue
    fi
    mode=$(/usr/bin/stat -f %Lp -- "$sdk/$f")
    [ "$mode" = "$want" ] || printf 'facts/sdk/%s mode is %s, want %s\n' "$f" "$mode" "$want"
  done
  if [ -f "$sdk/ca.crt" ] && [ ! -L "$sdk/ca.crt" ] && [ -f "$sdk/sdk.crt" ] && [ ! -L "$sdk/sdk.crt" ]; then
    "$OPENSSL3" verify -CAfile "$sdk/ca.crt" "$sdk/sdk.crt" >/dev/null 2>&1 ||
      printf 'facts/sdk/sdk.crt does not verify against facts/sdk/ca.crt\n'
  fi
  return 0
}

# build_chain.sh's get_account.sh, replaced by a stub (its absence would make build_chain.sh download it). chain-up.sh
# passes -a <regulator>, so build_chain.sh never runs it; if it ever did, it prints nothing and fails the build.
write_account_stub() {
  local f="$1"
  safe_target "$f"
  rm -f -- "$f" # mode 500 from an earlier run
  (
    set -C
    cat >"$f" <<'EOF'
#!/bin/bash
# Local stub written by scripts/fisco/chain-up.sh in place of build_chain.sh's download of get_account.sh.
# chain-up.sh passes -a with the regulator's account, so build_chain.sh never runs this file. If it ever did, it
# would print nothing and exit 1, and the build would stop.
exit 1
EOF
  ) || die "could not write $f"
  chmod 500 "$f"
}

# The native RPC's TLS files, copied from the generated sdk/ folder (after the CA fix, before any node runs: nodes can
# rewrite their folders, D/facts is beyond their reach) to D/facts/sdk: ca.crt and sdk.crt mode 444, sdk.key 400.
snapshot_sdk() {
  local d="$1" src dst f
  src="$(nodes_root "$d")/sdk"
  dst="$d/facts/sdk"
  safe_dir "$d/facts"
  safe_dir "$dst"
  for f in ca.crt sdk.crt sdk.key; do
    [ -f "$src/$f" ] && [ ! -L "$src/$f" ] || die "$src/$f is not a regular file"
    safe_target "$dst/$f"
    rm -f -- "$dst/$f"
    (umask 077 && set -C && cat -- "$src/$f" >"$dst/$f") || die "could not write $dst/$f"
    cmp -s -- "$src/$f" "$dst/$f" || die "the snapshot of sdk/$f differs"
  done
  chmod 444 "$dst/ca.crt" "$dst/sdk.crt"
  chmod 400 "$dst/sdk.key"
}
