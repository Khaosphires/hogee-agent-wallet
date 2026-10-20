#!/bin/bash
# chain-check.sh: is the local FISCO mirror chain healthy and confined? Read-only (it sends no transaction).
# --selftest instead proves the two sandbox profiles deny what they must, with /usr/bin/nc and /usr/bin/touch.
set -euo pipefail
set +x
# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/lib.sh"
# shellcheck source=chain-lib.sh
. "$FISCO_SCRIPT_DIR/chain-lib.sh"

usage() {
  cat <<'EOF'
Usage: chain-check.sh [--dir D] [--selftest]
  --dir D     chain dir made by chain-up.sh (default ~/fisco-hogee)
  --selftest  sandbox self-tests only (system tools stand in for the node): both profiles deny outbound TCP; under
              node.sb loopback p2p connects are allowed, other loopback and LAN connects and a listen on an unlisted
              loopback port (30399, 8547) are denied and on a chain port (20204, 8546) allowed, reads of a file
              outside D (directly or through a symlink in its NODES_DIR)
              and of D's marker are denied, a hard link to that file cannot be created, writes are allowed only in
              its NODES_DIR; under build.sb writes are allowed in D/tmp and denied in D itself and in every other
              existing D folder, and a hard link in D/tmp to a file outside D or in D/logs cannot be created; under
              both, another process's arguments and table entry cannot be read (a canary in a sleeping process's
              argv, which ps shows outside) and security verify-cert of an Apple root fails (trustd denied)
Checks: node pids alive (and fisco-bcos at D/bin), each started with the command chain-up.sh recorded in D/run
(node.sb with NODES_DIR=D/nodes, same node.sb digest), no symlink under D but the TASSL stub, lsof shows only
127.0.0.1 sockets and the full p2p mesh, the listeners on 8545 and 20200 are node0's pid and on 8546 node4's (lsof),
no sandbox network denial for fisco-bcos in the last 15 min, configs as
chain-up.sh left them (auth checks on, the regulator as genesis admin, Web3 on node0 and node4 only), the regulator's
facts in D/facts (regulator.address, sdk/ca.crt, sdk/sdk.crt, sdk/sdk.key: regular files, not links), eth_chainId
0x4ee8 on 127.0.0.1:8545, client version and head, CommitteeManager.isGovernor(regulator) true; with 5 nodes, node4
is an observer at the chain head (D/facts/observer.proposal names the proposal) and its Web3 on 127.0.0.1:8546 serves
chain id 0x4ee8 and the same head number and hash as node0. Exit 0 = PASS.
EOF
}

D_RAW="$HOME/fisco-hogee"
SELFTEST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) D_RAW="${2:?--dir needs a path}"; shift 2 ;;
    --selftest) SELFTEST=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument $1" ;;
  esac
done
refuse_root
D=$(resolve_chain_dir "$D_RAW")
require_marker "$D"
ROOT=$(nodes_root "$D")
FAILS=0
pass() { info "PASS $*"; }
fail() { info "FAIL $*"; FAILS=$((FAILS + 1)); }
note() { info "NOTE $*"; }

finish() {
  if [ "$FAILS" = 0 ]; then info "chain-check: PASS"; exit 0; fi
  info "chain-check: FAIL ($FAILS)"
  exit 1
}

# ------------------------------------------------------------------------------------------------- self-tests
# Scratch for the self-tests: NODES_DIR stand-in under D/tmp, and a dummy file outside D (removed at exit).
SB_NODES=""
OUTSIDE=""
LOGS_DUMMY=""
selftest_cleanup() {
  [ -z "$SB_NODES" ] || rm -rf -- "$SB_NODES"
  [ -z "$OUTSIDE" ] || rm -rf -- "$OUTSIDE"
  [ -z "$LOGS_DUMMY" ] || rm -f -- "$LOGS_DUMMY"
}

sb_build() {
  /usr/bin/env -i PATH=/usr/bin:/bin HOME="$D/home" TMPDIR="$D/tmp" LC_ALL=C "$SANDBOX_EXEC" -D CHAIN_DIR="$D" \
    -D BIN="$D/bin/fisco-bcos" -D OPENSSL_CELLAR="$OPENSSL_CELLAR" -f "$FISCO_SCRIPT_DIR/build.sb" "$@"
}

sb_node() {
  /usr/bin/env -i PATH=/usr/bin:/bin HOME="$SB_NODES" TMPDIR="$SB_NODES" LC_ALL=C "$SANDBOX_EXEC" \
    -D NODES_DIR="$SB_NODES" -D BIN="$D/bin/fisco-bcos" -D SELFTEST=1 -f "$FISCO_SCRIPT_DIR/node.sb" "$@"
}

# The command must fail with the sandbox's EPERM (a timeout or a refused connection proves nothing).
expect_denied() {
  local label="$1" out
  shift
  if out=$("$@" 2>&1); then fail "$label: allowed"; return 0; fi
  case "$out" in
    *"Operation not permitted"*) pass "$label: denied by the sandbox" ;;
    *) fail "$label: failed, not by the sandbox: $(printable "$out")" ;;
  esac
}

expect_ok() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then pass "$label: allowed"; else fail "$label: denied"; fi
}

# Writes: outside the chain dir denied (and nothing left behind), inside the writable folder allowed, and denied in D
# itself and in every other existing folder of D (keys/, deploy/, logs/, run/, ...).
selftest_files() {
  local label="$1" runner="$2" inside="$3" allowed="$4" outside sub
  outside="$FISCO_HOME_P/Desktop/.hogee-fisco-selftest-$$"
  expect_denied "$label touch ~/Desktop" "$runner" /usr/bin/touch "$outside"
  if [ -e "$outside" ]; then rm -f -- "$outside"; fail "$label: a file appeared on the Desktop"; fi
  expect_ok "$label touch ${inside#"$D"/}" "$runner" /usr/bin/touch "$inside/.hogee-fisco-selftest-$$"
  rm -f -- "$inside/.hogee-fisco-selftest-$$"
  expect_denied "$label touch D/" "$runner" /usr/bin/touch "$D/.hogee-fisco-selftest-$$"
  rm -f -- "$D/.hogee-fisco-selftest-$$"
  for sub in bin build cwd deploy facts home keys logs nodes run tmp tools; do
    case " $allowed " in *" $sub "*) continue ;; esac
    [ -d "$D/$sub" ] && [ ! -L "$D/$sub" ] || continue
    expect_denied "$label touch D/$sub/" "$runner" /usr/bin/touch "$D/$sub/.hogee-fisco-selftest-$$"
    rm -f -- "$D/$sub/.hogee-fisco-selftest-$$"
  done
}

# A listen must be denied (nc exits with EPERM at once) or, for a chain port, allowed (nc still waits after 2 s).
# The probe runs as its own process group (set -m), so the kill reaches nc itself and not only the subshell that runs
# sb_node; an nc left listening would hold a chain port and make chain-up.sh refuse to start.
selftest_listen() {
  local label="$1" port="$2" want="$3" log="$OUTSIDE/nc-$2.log" pid
  if port_in_use "$port"; then note "$label: port $port is in use, skipped"; return 0; fi
  set -m
  sb_node /usr/bin/nc -l 127.0.0.1 "$port" </dev/null >"$log" 2>&1 &
  pid=$!
  set +m
  sleep 2
  if kill -0 "$pid" 2>/dev/null; then
    kill -- "-$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    sleep 0.5
    if [ -n "$(group_members "$pid")" ] || port_in_use "$port"; then
      fail "$label: the probe's nc still listens on $port after the kill"
    fi
    if [ "$want" = allowed ]; then pass "$label: allowed"; else fail "$label: allowed"; fi
    return 0
  fi
  wait "$pid" 2>/dev/null || true
  if [ "$want" = allowed ]; then fail "$label: denied: $(printable "$(cat -- "$log")")"; return 0; fi
  case "$(cat -- "$log")" in
    *"Operation not permitted"*) pass "$label: denied by the sandbox" ;;
    *) fail "$label: failed, not by the sandbox: $(printable "$(cat -- "$log")")" ;;
  esac
}

# A sandboxed process must not read another process's arguments, environment or table entry. A sleeping perl carries
# a canary in its arguments and environment; ps shows the arguments outside the sandbox. Inside, FISCO_PROC_READER
# asks the kernel by number, as ps does, for that process's arguments (kern.procargs2.<pid>) and table entry
# (kern.proc.pid.<pid>): both must fail with the sandbox's EPERM. On macOS 27 these numeric reads get past the
# profiles' kern.proc*/kern.procargs* sysctl-read deny (fix12-chain, 20 Oct); the process-info deny stops them. /bin/ps
# itself is setuid and cannot run in a sandbox at all, so it cannot be the probe.
selftest_procargs() {
  local label="$1" runner="$2" canary pid seen ref out
  canary="HOGEE_SELFTEST_CANARY_$(/usr/bin/openssl rand -hex 16)"
  /usr/bin/env -i "$canary=1" /usr/bin/perl -e 'sleep 30' "$canary" </dev/null >/dev/null 2>&1 &
  pid=$!
  sleep 0.5
  seen=$(/bin/ps -ww -o command= -p "$pid" 2>&1 || true)
  ref=$(/usr/bin/perl -e "$FISCO_PROC_READER" "$pid" 2>&1 || true)
  out=$("$runner" /usr/bin/perl -e "$FISCO_PROC_READER" "$pid" 2>&1 || true)
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  case "$out" in *"$canary"*) fail "$label: another process's arguments are readable"; return 0 ;; esac
  case "$seen|$ref" in
    *"$canary"*"|"*"$canary"*) ;;
    *) note "$label: other processes' arguments: not testable (no canary in ps or the reader outside the sandbox)"
      return 0 ;;
  esac
  case "$out" in
    *"ARGS ERR Operation not permitted"*"PROC ERR Operation not permitted"*)
      pass "$label: another process's arguments and table entry: denied by the sandbox" ;;
    *) fail "$label: other processes' arguments: the probe failed, not by the sandbox: $(printable "$out")" ;;
  esac
}

# trustd is one of the Mach services both profiles deny because they act for their caller outside the sandbox (trustd
# may fetch CRLs, OCSP answers and missing CA certificates). security verify-cert checks an Apple root certificate
# through it (local only, no keychain search): outside the sandbox that succeeds; inside it must fail, while the
# certificate itself is readable there.
selftest_trustd() {
  local label="$1" runner="$2" pem="$3" out
  if ! out=$(/usr/bin/security verify-cert -c "$pem" -l -L -N -p basic 2>&1) ||
    [[ "$out" != *"verification successful"* ]]; then
    note "$label: trustd lookup: not testable (security verify-cert fails outside the sandbox)"
    return 0
  fi
  if ! "$runner" /bin/cat "$pem" >/dev/null 2>&1; then
    fail "$label: trustd lookup: the probe's certificate is not readable in the sandbox"
    return 0
  fi
  if "$runner" /usr/bin/security verify-cert -c "$pem" -l -L -N -p basic >/dev/null 2>&1; then
    fail "$label: trustd lookup: allowed (security verify-cert succeeded in the sandbox)"
  else pass "$label: trustd lookup: denied (security verify-cert fails in the sandbox, succeeds outside)"; fi
}

# An Apple root certificate (a system trust anchor), as PEM, into file $1 for selftest_trustd; fails if there is none.
apple_root_pem() {
  safe_target "$1"
  /usr/bin/security find-certificate -c "Apple Root CA" -p /System/Library/Keychains/SystemRootCertificates.keychain \
    >"$1" 2>/dev/null && grep -q 'BEGIN CERTIFICATE' "$1"
}

# A hard link made in a sandbox would carry a path the profile allows to the linked file, so making one to a file the
# profile may not write (outside D, or in D/logs) must be denied by the sandbox. One that gets made fails (and is
# removed).
selftest_hardlink() {
  local label="$1" runner="$2" src="$3" dst="$4" out
  safe_target "$dst"
  out=$("$runner" /bin/ln "$src" "$dst" 2>&1) || true
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    rm -f -- "$dst"
    fail "$label: created"
    return 0
  fi
  case "$out" in
    *"Operation not permitted"*) pass "$label: creation denied by the sandbox" ;;
    *"Cross-device"*) note "$label: not testable (the two files are on different volumes)" ;;
    *) fail "$label: failed, not by the sandbox: $(printable "$out")" ;;
  esac
}

# Reads through links made inside NODES_DIR to the dummy file outside D. A symlink (the sandboxed ln -s may create
# one: it is only a name) must not give the contents, since the sandbox checks the resolved path. A hard link would
# carry an allowed path, so creating one to a file outside D must be denied; if it is not, the read through it is
# reported too.
selftest_links() {
  local sym="$SB_NODES/link-sym" hard="$SB_NODES/link-hard" out
  if sb_node /bin/ln -s "$OUTSIDE/dummy" "$sym" >/dev/null 2>&1; then
    note "node.sb ln -s in its NODES_DIR to a file outside D: created (a symlink is only a name; reads are checked below)"
  else
    note "node.sb ln -s in its NODES_DIR to a file outside D: denied; the probe uses a link made by this script"
    safe_target "$sym"
    ln -s -- "$OUTSIDE/dummy" "$sym"
  fi
  expect_denied "node.sb read a file outside D through a symlink in its NODES_DIR" sb_node /bin/cat "$sym"
  safe_target "$hard"
  out=$(sb_node /bin/ln "$OUTSIDE/dummy" "$hard" 2>&1) || true
  if [ -e "$hard" ]; then
    fail "node.sb hard link in its NODES_DIR to a file outside D: created"
    if out=$(sb_node /bin/cat "$hard" 2>&1); then fail "node.sb read through that hard link: allowed (the outside file is readable)"
    else note "node.sb read through that hard link: denied: $(printable "$out")"; fi
  else
    case "$out" in
      *"Operation not permitted"*) pass "node.sb hard link in its NODES_DIR to a file outside D: creation denied by the sandbox" ;;
      *"Cross-device"*) note "node.sb hard link probe: not testable (D and /private/tmp are on different volumes)" ;;
      *) fail "node.sb hard link in its NODES_DIR to a file outside D: failed, not by the sandbox: $(printable "$out")" ;;
    esac
  fi
  rm -f -- "$sym" "$hard"
}

selftest() {
  local listener=""
  trap selftest_cleanup EXIT
  # D/tmp is build.sb-writable: the scripts' one write there is into a fresh mktemp folder of a checked D/tmp, and
  # goes through safe_dir/safe_target like every other unsandboxed write into D.
  safe_dir "$D/tmp"
  SB_NODES=$(/usr/bin/mktemp -d "$D/tmp/selftest-nodes.XXXXXX")
  safe_dir "$SB_NODES"
  OUTSIDE=$(/usr/bin/mktemp -d /private/tmp/hogee-fisco-selftest.XXXXXX)
  printf 'hogee selftest\n' >"$OUTSIDE/dummy"
  safe_target "$SB_NODES/dummy"
  printf 'hogee selftest\n' >"$SB_NODES/dummy"
  [ -x "$D/bin/fisco-bcos" ] || note "D/bin/fisco-bcos missing; node.sb is still tested with nc, touch, cat and ps"
  # 192.0.2.1 is TEST-NET-1 (RFC 5737): no real host answers even if a profile were broken.
  expect_denied "build.sb nc 192.0.2.1:443" sb_build /usr/bin/nc -v -z -G 3 192.0.2.1 443
  if sb_build /usr/bin/curl -sS --max-time 5 http://192.0.2.1/ >/dev/null 2>&1; then
    fail "build.sb curl by IP: allowed"
  else pass "build.sb curl by IP: failed"; fi
  if sb_build /usr/bin/curl -sS --max-time 5 https://example.com/ >/dev/null 2>&1; then
    fail "build.sb curl by name: allowed"
  else pass "build.sb curl by name: failed"; fi
  selftest_files build.sb sb_build "$D/tmp" "build home nodes tmp"
  expect_denied "node.sb nc 192.0.2.1:443" sb_node /usr/bin/nc -v -z -G 3 192.0.2.1 443
  expect_denied "node.sb nc 192.168.1.1:80" sb_node /usr/bin/nc -v -z -G 3 192.168.1.1 80
  expect_denied "node.sb nc localhost:22" sb_node /usr/bin/nc -v -z -G 3 127.0.0.1 22
  if ! port_in_use 30304; then
    /usr/bin/nc -l 127.0.0.1 30304 >/dev/null 2>&1 &
    listener=$!
    sleep 1
  fi
  expect_ok "node.sb nc localhost:30304 (p2p)" sb_node /usr/bin/nc -z -G 3 127.0.0.1 30304
  if [ -n "$listener" ]; then kill "$listener" 2>/dev/null || true; fi
  selftest_listen "node.sb listen 127.0.0.1:30399 (not a chain port)" 30399 denied
  selftest_listen "node.sb listen 127.0.0.1:20204 (chain rpc port)" 20204 allowed
  selftest_listen "node.sb listen 127.0.0.1:8546 (node4 Web3, the regulator's ledger)" 8546 allowed
  selftest_listen "node.sb listen 127.0.0.1:8547 (not a chain port)" 8547 denied
  expect_denied "node.sb read a file outside D" sb_node /bin/cat "$OUTSIDE/dummy"
  expect_denied "node.sb read D/$FISCO_MARKER" sb_node /bin/cat "$D/$FISCO_MARKER"
  expect_ok "node.sb read inside its NODES_DIR" sb_node /bin/cat "$SB_NODES/dummy"
  selftest_files node.sb sb_node "$SB_NODES" ""
  selftest_links
  safe_dir "$D/logs"
  LOGS_DUMMY="$D/logs/.hogee-fisco-selftest-$$"
  safe_target "$LOGS_DUMMY"
  printf 'hogee selftest\n' >"$LOGS_DUMMY"
  selftest_hardlink "build.sb hard link in D/tmp to a file outside D" sb_build "$OUTSIDE/dummy" "$SB_NODES/build-link"
  selftest_hardlink "build.sb hard link in D/tmp to a file in D/logs" sb_build "$LOGS_DUMMY" "$SB_NODES/build-link"
  selftest_procargs node.sb sb_node
  selftest_procargs build.sb sb_build
  if apple_root_pem "$SB_NODES/apple-root.pem"; then
    selftest_trustd node.sb sb_node "$SB_NODES/apple-root.pem"
    selftest_trustd build.sb sb_build "$SB_NODES/apple-root.pem"
  else note "trustd lookup: not testable (no Apple root certificate in the system keychain)"; fi
  finish
}

[ "$SELFTEST" = 0 ] || selftest

# ------------------------------------------------------------------------------------------------- chain checks
N=$(node_count "$D")
PROBLEMS=$(static_config_problems "$D")
if [ -z "$PROBLEMS" ]; then
  pass "configs: loopback only, CORS off, Web3 RPC on node0 (8545) and node4 (8546) only, native RPC on TLS, identical"
  info "     genesis with the EVM features, sealers node.0-node.3, auth checks on, auth admin = facts/regulator.address"
else
  while IFS= read -r line; do fail "config: $line"; done <<<"$PROBLEMS"
fi
FACTS=$(regulator_fact_problems "$D")
if [ -z "$FACTS" ]; then
  pass "facts: regulator.address, sdk/ca.crt, sdk/sdk.crt (444) and sdk/sdk.key (400), regular files; sdk.crt verifies"
else
  while IFS= read -r line; do fail "facts: $line"; done <<<"$FACTS"
fi

# Start records and pid files: D/run, which only these scripts write (no sandbox can).
if [ -d "$D/run" ] && [ ! -L "$D/run" ] && [ -O "$D/run" ]; then :; else fail "$D/run is not a real folder owned by $(id -un)"; fi
WANT_START=$(node_start_line "$D")
START_BAD=0
PIDS=""
NODE0_PID=""
NODE4_PID=""
for nd in $(node_dirs "$D"); do
  name=$(basename -- "$nd")
  rec="$D/run/$name.cmd"
  line=""
  [ -L "$rec" ] || line=$(cat -- "$rec" 2>/dev/null || true)
  nodes_arg=$(printf '%s\n' "$line" | tr ' ' '\n' | grep '^NODES_DIR=' || true)
  if [ "$nodes_arg" != "NODES_DIR=$D/nodes" ]; then
    fail "$name: started with node.sb ${nodes_arg:-and no NODES_DIR record}, want NODES_DIR=$D/nodes"
    START_BAD=1
  elif [ "$line" != "$WANT_START" ]; then
    fail "$name: start record differs from chain-up.sh's command: $(printable "$line")"
    START_BAD=1
  fi
  pf=$(node_pid_file "$D" "$nd")
  pid=""
  [ -L "$pf" ] || pid=$(cat -- "$pf" 2>/dev/null || true)
  if pid_is_node "$pid" &&
    [ "$(ps -o command= -p "$pid" 2>/dev/null)" = "$D/bin/fisco-bcos -c config.ini -g config.genesis" ]; then
    PIDS="${PIDS:+$PIDS,}$pid"
    case "$name" in node0) NODE0_PID="$pid" ;; node4) NODE4_PID="$pid" ;; esac
  else fail "$name: not running from $D/bin/fisco-bcos (pid '$(printable "$pid")')"; fi
done
SB_SUM=$(cat -- "$D/run/node.sb.sha256" 2>/dev/null || true)
if [ "$SB_SUM" != "$(sha256_of "$FISCO_SCRIPT_DIR/node.sb")" ]; then
  fail "node.sb changed since the nodes started (or no D/run/node.sb.sha256)"
elif [ "$START_BAD" = 0 ]; then
  pass "start records: every node under node.sb (same digest) with NODES_DIR=$D/nodes, as chain-up.sh starts them"
fi
[ -z "$PIDS" ] || pass "node pids alive: $PIDS"

LINKS=$(unexpected_links "$D")
if [ -z "$LINKS" ]; then pass "no symlink under D except home/.fisco/tassl-1.1.1b"; else
  fail "symlinks under D:"
  printf '%s\n' "$LINKS" | sed 's/^/  /'
fi
TASSL="$D/home/.fisco/tassl-1.1.1b"
if [ -L "$TASSL" ] && [ "$(readlink -- "$TASSL")" != "$OPENSSL3" ]; then fail "$TASSL does not point to $OPENSSL3"; fi

if [ -n "$PIDS" ]; then
  SOCKS=$(/usr/sbin/lsof -nP -iTCP -iUDP -a -p "$PIDS" 2>/dev/null || true)
  read -r EST BAD <<<"$(printf '%s\n' "$SOCKS" | awk 'NR > 1 {
      n = split($9, ep, "->"); for (i = 1; i <= n; i++) if (ep[i] !~ /^127\.0\.0\.1:[0-9]+$/) bad++
      if ($10 == "(ESTABLISHED)") est++ }
    END { print est + 0, bad + 0 }')"
  if [ "$BAD" = 0 ]; then pass "lsof: every node socket is on 127.0.0.1"; else
    fail "lsof: $BAD socket(s) not on 127.0.0.1:"
    printf '%s\n' "$SOCKS" | awk 'NR > 1 && $9 !~ /^127\.0\.0\.1:[0-9]+(->127\.0\.0\.1:[0-9]+)?$/ {print "  " $0}' |
      tr -c '[:print:]\n' '?'
  fi
  WANT=$((N * (N - 1)))
  if [ "$EST" -ge "$WANT" ]; then pass "p2p mesh: $EST established loopback sockets (want >= $WANT)"; else
    fail "p2p mesh: $EST established loopback sockets, want >= $WANT"
  fi
fi

# The RPC ports the scripts and the replay talk to belong to the right node: Web3 8545 and the native RPC 20200 to
# node0, Web3 8546 (5 nodes) to node4, each the pid from its pid file checked above. Exactly that pid listens (lsof
# lists our own processes); a port that answers a connect with none of ours listening fails too.
listener_check() {
  local spec port node want got
  for spec in "8545 node0 ${NODE0_PID:--}" "20200 node0 ${NODE0_PID:--}" "8546 node4 ${NODE4_PID:--}"; do
    read -r port node want <<<"$spec"
    [ "$node" != node4 ] || [ "$N" = 5 ] || continue
    if [ "$want" = - ]; then fail "listener $port: $node is not running"; continue; fi
    got=$(listen_pids "$port")
    if [ "$got" = "$want" ]; then pass "listener $port: $node's pid $want only"
    elif [ -z "$got" ] && port_in_use "$port"; then fail "listener $port: answers, but none of our processes listens"
    else fail "listener $port: pids '${got:-none}', want $node's pid $want only"; fi
  done
}
listener_check

DENIALS=$(/usr/bin/log show --last 15m --style compact --predicate 'sender=="Sandbox"' 2>/dev/null |
  grep -i 'fisco-bcos' || true)
NET=$(printf '%s\n' "$DENIALS" | grep -ci 'network' || true)
ALL=$(printf '%s\n' "$DENIALS" | grep -c . || true)
if [ "$NET" = 0 ]; then pass "sandbox log (15 min): 0 network denials for fisco-bcos ($ALL other denials)"; else
  fail "sandbox log (15 min): $NET network denials for fisco-bcos"
fi

# Everything the node serves is printed through printable (no terminal escape sequences).
CHAIN_ID=$(rpc eth_chainId || true)
if [ "$CHAIN_ID" = "$FISCO_CHAIN_ID_HEX" ]; then pass "eth_chainId $CHAIN_ID on $FISCO_RPC"; else
  fail "eth_chainId '$(printable "$CHAIN_ID")' on $FISCO_RPC, want $FISCO_CHAIN_ID_HEX"
fi
info "INFO web3_clientVersion: $(printable "$(rpc web3_clientVersion || echo unavailable)")"
HEAD_HEX=$(rpc eth_blockNumber || true)
HEAD=$(hex_to_dec "$HEAD_HEX" || true)
info "INFO head block: ${HEAD:-unavailable}"

# The regulator governs the chain: CommitteeManager (0x...10001) answers isGovernor(regulator) = true.
governor_check() {
  local reg="" f="$D/facts/regulator.address"
  if [ -f "$f" ] && [ ! -L "$f" ]; then reg=$(cat -- "$f"); fi
  [[ "$reg" =~ ^0x[0-9a-f]{40}$ ]] || { fail "governor: no valid facts/regulator.address"; return 0; }
  if is_governor "$reg"; then pass "governor: CommitteeManager.isGovernor($reg) is true"; else
    fail "governor: CommitteeManager.isGovernor($reg) is not true (or no answer)"
  fi
}
governor_check

# node4: the latest resetConfig says OBSERVER_NODE and its latest committed block is the head. No empty blocks on
# FISCO: right after the observer proposal (no block since) it cannot have synced yet, which is reported, not failed.
node4_log() {
  local f
  for f in $(ls -1 "$ROOT/node4/log/" 2>/dev/null | grep '\.log$' | sort); do cat -- "$ROOT/node4/log/$f"; done
}
observer_check() {
  local reg type commit prop
  reg=$(cat -- "$D/observer.block" 2>/dev/null || true)
  [[ "$reg" =~ ^[0-9]+$ ]] || { fail "observer: no $D/observer.block (chain-up.sh registers node4)"; return 0; }
  [ -n "$HEAD" ] || { fail "observer: no head block"; return 0; }
  prop="$D/facts/observer.proposal"
  if [ -f "$prop" ] && [ ! -L "$prop" ] && [[ "$(cat -- "$prop")" =~ ^0x[0-9a-f]{64}$ ]]; then
    pass "observer: proposal $(cat -- "$prop") in block $reg"
  else fail "observer: D/facts/observer.proposal is missing, a link, or not a transaction hash"; fi
  if [ "$HEAD" -le "$reg" ]; then
    note "observer: no block since the observer proposal (block $reg, head $HEAD): not yet synced," \
      "checked after the next block"
    return 0
  fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    type=$(node4_log | grep -oE 'resetConfig,[^|]*type=[A-Z_]+' | tail -1 | sed -E 's/.*type=//' || true)
    commit=$(node4_log | grep -oE 'commitBlockState success,number=[0-9]+' | tail -1 | sed -E 's/.*=//' || true)
    if [ "$type" = OBSERVER_NODE ] && [ "$commit" = "$HEAD" ]; then
      pass "observer: node4 resetConfig type=OBSERVER_NODE, committed block $commit = head"
      return 0
    fi
    sleep 1
  done
  fail "observer: node4 type='${type}', committed '${commit}', head $HEAD"
}
# node4's Web3 on 127.0.0.1:8546 serves the regulator's own copy of the ledger (read only, from our side): the same
# chain id, and the same head number and hash as node0. As above, with no block since the observer proposal node4
# may not have the head yet, which is reported, not failed. node0's head is read again on every try.
FISCO_LEDGER_WAIT=10
ledger_check() {
  local cid n0="" n4="" h0 h4 reg tries=0
  cid=$(rpc_at "$FISCO_LEDGER_RPC" eth_chainId || true)
  if [ "$cid" = "$FISCO_CHAIN_ID_HEX" ]; then pass "node4 ledger: eth_chainId $cid on $FISCO_LEDGER_RPC"; else
    fail "node4 ledger: eth_chainId '$(printable "$cid")' on $FISCO_LEDGER_RPC, want $FISCO_CHAIN_ID_HEX"
    return 0
  fi
  while :; do
    n0=$(hex_to_dec "$(rpc eth_blockNumber || true)" || true)
    n4=$(hex_to_dec "$(rpc_at "$FISCO_LEDGER_RPC" eth_blockNumber || true)" || true)
    if [ -n "$n0" ] && [ "$n0" = "$n4" ]; then
      h0=$(block_hash "$FISCO_RPC" "$n0" || true)
      h4=$(block_hash "$FISCO_LEDGER_RPC" "$n4" || true)
      if [ -n "$h0" ] && [ "$h0" = "$h4" ]; then
        pass "node4 ledger: head $n4 and its hash equal node0's ($h4)"
        return 0
      fi
      if [ -n "$h0" ] && [ -n "$h4" ]; then fail "node4 ledger: block $n4 hash $h4, node0 has $h0"; return 0; fi
    fi
    tries=$((tries + 1))
    [ "$tries" -lt "$FISCO_LEDGER_WAIT" ] || break
    sleep 1
  done
  reg=$(cat -- "$D/observer.block" 2>/dev/null || true)
  if [[ "$reg" =~ ^[0-9]+$ ]] && [ -n "$n0" ] && [ "$n0" -le "$reg" ]; then
    note "node4 ledger: head '${n4}', node0 '${n0}', no block since the observer proposal (block $reg):" \
      "checked after the next block"
  else
    fail "node4 ledger: head '${n4}', node0 '${n0}' after ${FISCO_LEDGER_WAIT} s"
  fi
}
[ "$N" != 5 ] || observer_check
[ "$N" != 5 ] || ledger_check
finish
