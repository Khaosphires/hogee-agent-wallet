# shellcheck shell=bash
# Shared helpers for scripts/fisco/*.sh. Sourced, never run. macOS /bin/bash 3.2 compatible (no associative arrays,
# no mapfile, no empty-array expansion under `set -u`). Nothing here downloads anything or runs fisco-bcos.

export LC_ALL=C # deterministic sort, awk, sed and grep

# The real path of an existing folder. /bin/pwd -P (getcwd) gives the stored letter case; bash's own `pwd -P` keeps
# the case as typed, which on a case-insensitive volume would let ~/desktop pass a ~/Desktop guard.
real_dir() {
  (cd -- "$1" && /bin/pwd -P)
}

FISCO_SCRIPT_DIR="$(real_dir "$(dirname "${BASH_SOURCE[0]}")")"
FISCO_REPO_DIR="$(real_dir "$FISCO_SCRIPT_DIR/../..")"
FISCO_HOME_P="$(real_dir "$HOME")"

# The chain: loopback only, fixed ports. Web3 RPC on node0 (8545: deploy and replay) and on node4, the regulator's
# observer (8546: the regulator's own copy of the ledger, which the replay reads and compares with node0's).
FISCO_RPC="http://127.0.0.1:8545"
FISCO_LEDGER_RPC="http://127.0.0.1:8546"
FISCO_CHAIN_ID=20200
FISCO_CHAIN_ID_HEX="0x4ee8"
FISCO_PORTS="30300 30301 30302 30303 30304 20200 20201 20202 20203 20204 8545 8546"

# FISCO's governance (system contracts; P1's live test, 20 Oct 2026). The regulator is the genesis committee's only
# governor (build_chain.sh -a <regulator>); a proposal it creates passes and runs inside the creating transaction.
FISCO_COMMITTEE_MANAGER="0x0000000000000000000000000000000000010001"
FISCO_SIG_OBSERVER_PROPOSAL="createSetConsensusWeightProposal(string,uint32,bool,uint256)"
FISCO_SEL_IS_GOVERNOR="0xe43581b8" # keccak256("isGovernor(address)")[0:4] (cast sig and viem agree)
FISCO_MARKER=".hogee-fisco"
FISCO_VERSION="v3.17.1"

# Release files (sizes here, SHA-256 digests in SHA256SUMS).
FISCO_SIZE_BUILD_CHAIN=98331
FISCO_SIZE_TARBALL=17141889
FISCO_SIZE_BINARY=47908248
FISCO_TARBALL="fisco-bcos-macOS-arm.tar.gz"

# Tools, by absolute path (the scripts never depend on PATH order for these).
JQ=/usr/bin/jq
CURL=/usr/bin/curl
SANDBOX_EXEC=/usr/bin/sandbox-exec
OPENSSL_CELLAR=/opt/homebrew/Cellar/openssl@3
OPENSSL3=/opt/homebrew/opt/openssl@3/bin/openssl
FOUNDRY_BIN="$HOME/.foundry/bin"
CAST="$FOUNDRY_BIN/cast"
FORGE="$FOUNDRY_BIN/forge"

die() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '%s\n' "$*"
}

need_exec() {
  local p
  for p in "$@"; do
    [ -x "$p" ] || die "missing tool: $p"
  done
}

refuse_root() {
  [ "$(id -u)" -ne 0 ] || die "do not run as root (no sudo anywhere in the FISCO mirror)"
}

sha256_of() {
  /usr/bin/shasum -a 256 -- "$1" | awk '{print $1}'
}

size_of() {
  /usr/bin/stat -f %z -- "$1"
}

# The pinned digest for a file name in SHA256SUMS; fails closed while a digest is still a placeholder.
pinned_sha256() {
  local name="$1" sums="$FISCO_SCRIPT_DIR/SHA256SUMS" d
  [ -f "$sums" ] || die "missing $sums"
  d=$(awk -v n="$name" '$0 !~ /^#/ && NF == 2 && $2 == n {print $1}' "$sums")
  [ -n "$d" ] || die "no digest for $name in SHA256SUMS"
  [[ "$d" =~ ^[0-9a-f]{64}$ ]] || die "digest for $name is not pinned yet ($d)"
  printf '%s\n' "$d"
}

# An absolute, symlink-free path for --dir (the directory itself may not exist yet; its parent must). No "." or ".."
# component, and an existing D must already be its canonical path (letter case included: APFS ignores case), so every
# guard below compares the real path.
resolve_chain_dir() {
  local raw="$1" parent base
  [ -n "$raw" ] || die "empty --dir"
  case "$raw" in /*) ;; *) raw="$PWD/$raw" ;; esac
  case "$raw/" in */./* | */../*) die "--dir must not contain . or .. components: $raw" ;; esac
  raw="${raw%/}"
  parent=$(dirname -- "$raw")
  base=$(basename -- "$raw")
  [ -d "$parent" ] || die "the parent of --dir does not exist: $parent"
  parent=$(real_dir "$parent")
  [ ! -L "$parent/$base" ] || die "--dir must not be a symlink"
  raw="${parent%/}/$base"
  if [ -d "$raw" ]; then
    [ "$(real_dir "$raw")" = "$raw" ] || die "--dir resolves to another path (letter case?): $raw"
  fi
  printf '%s\n' "$raw"
}

# The nearest existing ancestor of a path (the path itself when it exists).
existing_ancestor() {
  local p="$1"
  while [ ! -d "$p" ]; do p=$(dirname -- "$p"); done
  printf '%s\n' "$p"
}

# D must be a plain path outside the repo (any git work tree), outside synced or user-document folders, and never
# home or one of its ancestors. Nor may D contain one of those folders (be it or one of its ancestors): chain-up.sh
# makes D mode 700 and chain-down.sh --wipe removes all of it.
FISCO_PROTECTED_DIRS=("$FISCO_REPO_DIR" "$FISCO_HOME_P/hogee-wt" "$FISCO_HOME_P/Desktop" "$FISCO_HOME_P/Documents"
  "$FISCO_HOME_P/Library/Mobile Documents" "$FISCO_HOME_P/Library/CloudStorage")
refuse_unsafe_dir() {
  local d="$1" anc p
  [[ "$d" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--dir must match ^/[A-Za-z0-9._/-]+\$ (no spaces): $d"
  case "$FISCO_HOME_P/" in "$d/"*) die "--dir must not be home or one of its parents: $d" ;; esac
  for p in "${FISCO_PROTECTED_DIRS[@]}"; do
    case "$d/" in "$p/"*) die "--dir must be outside $p: $d" ;; esac
    case "$p/" in "$d/"*) die "--dir must not be or contain $p: $d" ;; esac
  done
  anc=$(existing_ancestor "$d")
  if git -C "$anc" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    die "--dir must not be inside a git work tree: $d"
  fi
}

# Create (mode 700) or adopt D and write the marker that chain-down --wipe requires. Prints nothing. An existing D is
# adopted only when it is empty or already carries a marker (checked below to name D): a folder with other contents
# would otherwise get the marker and so become wipeable. The canonical-path and content checks come before any chmod
# or write.
prepare_chain_dir() {
  local d="$1" entries
  refuse_unsafe_dir "$d"
  if [ -e "$d" ] || [ -L "$d" ]; then
    [ -d "$d" ] && [ ! -L "$d" ] || die "--dir exists and is not a directory: $d"
    [ -O "$d" ] || die "--dir is not owned by $(id -un): $d"
    [ "$(real_dir "$d")" = "$d" ] || die "--dir resolves elsewhere: $d"
    if [ ! -e "$d/$FISCO_MARKER" ] && [ ! -L "$d/$FISCO_MARKER" ]; then
      entries=$(ls -A -- "$d") || die "cannot list --dir: $d"
      [ -z "$entries" ] || die "--dir exists, is not empty and has no $FISCO_MARKER (not made by these scripts): $d"
    fi
  else
    mkdir -m 700 -- "$d"
    [ "$(real_dir "$d")" = "$d" ] || die "--dir resolves elsewhere: $d"
  fi
  chmod 700 "$d"
  safe_target "$d/$FISCO_MARKER"
  if [ -f "$d/$FISCO_MARKER" ]; then
    [ "$(cat -- "$d/$FISCO_MARKER")" = "$d" ] || die "$d/$FISCO_MARKER names another directory"
  else
    printf '%s\n' "$d" >"$d/$FISCO_MARKER"
  fi
}

# Every unsandboxed write into D goes through these two checks. Sandboxed code can write only D/nodes (node.sb) or
# D/build, D/nodes, D/home and D/tmp (build.sb), but the scripts still never follow a link they did not make.
# A folder the scripts write into: an existing real directory owned by the user, or created now (mode 700).
safe_dir() {
  local p="$1"
  if [ -e "$p" ] || [ -L "$p" ]; then
    [ -d "$p" ] && [ ! -L "$p" ] && [ -O "$p" ] || die "$p must be a real directory owned by $(id -un)"
  else
    mkdir -m 700 -- "$p"
  fi
}

# The number of hard links to a file (1 for a file no one has linked elsewhere).
link_count() {
  /usr/bin/stat -f %l -- "$1"
}

# A file the scripts are about to write, append to, copy over or chmod: never a symlink, and when it exists a regular
# file owned by the user with link count 1 (a hard link would carry the write to the file's other name).
safe_target() {
  local f="$1"
  [ ! -L "$f" ] || die "refusing to write through a symlink: $f"
  if [ -e "$f" ]; then
    [ -f "$f" ] && [ -O "$f" ] || die "refusing to write $f: not a regular file owned by $(id -un)"
    [ "$(link_count "$f")" = 1 ] || die "refusing to write $f: it has more than one hard link"
  fi
}

# A small file the replay reads (D/facts/<name>): written fresh, never through a link and never appended, then
# made read-only (444).
write_fact() {
  local f="$1" v="$2"
  safe_target "$f"
  rm -f -- "$f"
  (umask 077 && set -C && printf '%s\n' "$v" >"$f") || die "could not write $f"
  chmod 444 "$f"
}

# A regular file (not a symlink) owned by the user, with link count 1.
owned_file() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] && [ "$(link_count "$1")" = 1 ]
}

# Symlinks anywhere under D, one per line (non-printing characters shown as ?), except the TASSL stub chain-up.sh
# makes. find does not follow links; a folder it cannot read is reported too.
unexpected_links() {
  local d="$1"
  { /usr/bin/find "$d" -type l ! -path "$d/home/.fisco/tassl-1.1.1b" -print 2>/dev/null ||
    printf 'find could not list all of %s\n' "$d"; } | tr -c '[:print:]\n' '?'
}

# D must already carry its own marker (scripts that only read or stop the chain).
require_marker() {
  local d="$1"
  refuse_unsafe_dir "$d"
  [ -f "$d/$FISCO_MARKER" ] || die "no $FISCO_MARKER in $d (not a chain dir made by these scripts)"
  [ "$(cat -- "$d/$FISCO_MARKER")" = "$d" ] || die "$d/$FISCO_MARKER names another directory"
}

nodes_root() {
  printf '%s/nodes/127.0.0.1\n' "$1"
}

# Node directories node0..node4, in order, one per line.
node_dirs() {
  local root i
  root=$(nodes_root "$1")
  for i in 0 1 2 3 4; do
    [ -d "$root/node$i" ] && printf '%s\n' "$root/node$i"
  done
  return 0
}

node_count() {
  node_dirs "$1" | awk 'END {print NR}'
}

# True when pid is alive and is a fisco-bcos process (a reused pid is never signalled).
pid_is_node() {
  local pid="$1" comm
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  comm=$(ps -o comm= -p "$pid" 2>/dev/null) || return 1
  case "$comm" in */fisco-bcos | fisco-bcos) return 0 ;; esac
  return 1
}

# Any of the chain's ports already listening (lsof for our own processes, a loopback connect for anyone's).
port_in_use() {
  local p="$1"
  if /usr/sbin/lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then return 0; fi
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then return 0; fi
  return 1
}

# The pids of our own processes listening on TCP port $1 (lsof), sorted, comma-separated; empty when none.
listen_pids() {
  /usr/sbin/lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -un | tr '\n' ',' | sed 's/,$//' || true
}

# JSON-RPC to a node's Web3 RPC: plain http to 127.0.0.1 only (no proxy; curl follows no redirect). Any other URL is
# refused before a request is made. Prints .result; fails on an error or no answer.
rpc_at() {
  local url="$1" method="$2" params="${3:-[]}" out
  if [[ ! "$url" =~ ^http://127\.0\.0\.1:([0-9]{1,5})$ ]] || [ "${BASH_REMATCH[1]}" -gt 65535 ]; then
    die "rpc_at: only http://127.0.0.1:<port> is allowed, not $(printable "$url")"
  fi
  [[ "$method" =~ ^[A-Za-z0-9_]+$ ]] || die "rpc_at: bad method name"
  out=$("$CURL" -sS --noproxy '*' --proto '=http' --max-time 10 -H 'Content-Type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}" "$url") ||
    return 1
  printf '%s' "$out" | "$JQ" -e -r 'if .error then error("rpc error") else .result end' 2>/dev/null
}

# node0's Web3 RPC.
rpc() {
  rpc_at "$FISCO_RPC" "$@"
}

# The hash of block number $2 as the Web3 RPC at $1 serves it (lower case); fails on anything but 0x + 64 hex.
block_hash() {
  local h
  h=$(rpc_at "$1" eth_getBlockByNumber "[\"$(printf '0x%x' "$2")\",false]" | "$JQ" -r '.hash' 2>/dev/null) || return 1
  [[ "$h" =~ ^0x[0-9a-fA-F]{64}$ ]] || return 1
  printf '%s\n' "$h" | tr 'A-F' 'a-f'
}

# Calldata of CommitteeManager.isGovernor(address).
is_governor_calldata() {
  [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "is_governor_calldata: not an address"
  printf '%s000000000000000000000000%s\n' "$FISCO_SEL_IS_GOVERNOR" "$(printf '%s' "${1#0x}" | tr 'A-F' 'a-f')"
}

# True only when node0 answers CommitteeManager.isGovernor(addr) with exactly the ABI word for true (eth_call).
is_governor() {
  local data out
  data=$(is_governor_calldata "$1") || return 1
  out=$(rpc eth_call "[{\"to\":\"$FISCO_COMMITTEE_MANAGER\",\"data\":\"$data\"},\"latest\"]") || return 1
  [ "$out" = "0x0000000000000000000000000000000000000000000000000000000000000001" ]
}

# A node-served hex quantity as a decimal; fails on anything else.
hex_to_dec() {
  [[ "$1" =~ ^0x[0-9a-fA-F]{1,15}$ ]] || return 1
  printf '%d\n' "$1"
}

# Node-served text made safe to print: printable ASCII only, so no terminal escape sequence gets through.
printable() {
  printf '%s' "$1" | LC_ALL=C tr -cd '[:print:]'
}

# Unset every exported variable except the names given (for subshells that run foundry or pnpm). Values that must
# stay out of argv (keystore passwords, role keys) are exported after this, never passed on a command line.
scrub_env() {
  local v keep=" $* "
  for v in $(compgen -e); do
    case "$keep" in *" $v "*) ;; *) unset "$v" 2>/dev/null || true ;; esac
  done
}

# The environment of every foundry run: scrubbed (HOME kept: foundry finds its solc builds there), and every HTTP proxy
# variable (upper and lower case) pointing at a closed loopback port (discard, 9) with only 127.0.0.1 exempt (not
# localhost: reqwest also exempts *.localhost names). forge and cast follow HTTP redirects (P1, Foundry 1.8.5, 20 Oct):
# a redirect or request to any host but 127.0.0.1 goes to that dead proxy and fails; a redirect to another port on
# 127.0.0.1 is still followed. foundry_egress_check proves the block holds before any RPC call; every foundry run
# (foundry_in, the keystore subshells) checks here again that nothing listens on the proxy port, since a listener
# there would receive every request that is meant to fail. Subshells only.
FISCO_NO_EGRESS_PROXY="http://127.0.0.1:9"
FISCO_NO_EGRESS_PORT=9
foundry_env() {
  ! port_in_use "$FISCO_NO_EGRESS_PORT" ||
    die "127.0.0.1:$FISCO_NO_EGRESS_PORT (the dead proxy) is listening; it must stay closed for foundry"
  scrub_env HOME
  export PATH="$FOUNDRY_BIN:/usr/bin:/bin" LC_ALL=C
  export HTTP_PROXY="$FISCO_NO_EGRESS_PROXY" HTTPS_PROXY="$FISCO_NO_EGRESS_PROXY" ALL_PROXY="$FISCO_NO_EGRESS_PROXY" \
    http_proxy="$FISCO_NO_EGRESS_PROXY" https_proxy="$FISCO_NO_EGRESS_PROXY" all_proxy="$FISCO_NO_EGRESS_PROXY" \
    NO_PROXY=127.0.0.1 no_proxy=127.0.0.1
}

# FOUNDRY_CWD = D/cwd: an empty folder that only these scripts write. cast runs there, never in D, because foundry
# reads foundry.toml and .env files from its working directory.
set_foundry_cwd() {
  safe_dir "$1/cwd"
  [ -z "$(ls -A -- "$1/cwd")" ] || die "$1/cwd must stay empty (foundry reads config and .env files from its working dir)"
  FOUNDRY_CWD="$1/cwd"
}

# Run a foundry tool from dir $1 (FOUNDRY_CWD, or the repo's contracts/ for forge) in foundry_env.
foundry_in() {
  local dir="$1"
  shift
  [ -n "$dir" ] && [ -d "$dir" ] || die "foundry_in: no working folder"
  (
    cd -- "$dir" || exit 1 # explicit: callers use `|| die`, which turns set -e off in here
    foundry_env
    exec "$@"
  )
}

# Run "$@" (stdin /dev/null, stdout and stderr to file $2) as its own process group, so every process it leaves behind
# can be found (pgrep -g) or killed together. $1 = wall-clock deadline in seconds, 0 for none (macOS has no
# timeout(1)): at the deadline the whole group is killed and the status is 124. Ctrl-C or TERM to this script also
# kills the group (it is not the terminal's foreground group any more). Sets RUN_GROUP_PGID; returns the command's
# exit status.
RUN_GROUP_PGID=""
run_group() {
  local secs="$1" out="$2" pid waited=0 rc=0
  shift 2
  set -m
  "$@" </dev/null >"$out" 2>&1 &
  pid=$!
  set +m
  RUN_GROUP_PGID="$pid"
  trap 'kill -9 -- "-$RUN_GROUP_PGID" 2>/dev/null; exit 130' INT TERM
  if [ "$secs" -gt 0 ]; then
    while kill -0 "$pid" 2>/dev/null; do
      if [ "$waited" -ge "$secs" ]; then
        { kill -9 -- "-$pid" || true; wait "$pid" || true; } 2>/dev/null
        trap - INT TERM
        return 124
      fi
      sleep 1
      waited=$((waited + 1))
    done
  fi
  wait "$pid" || rc=$?
  trap - INT TERM
  return "$rc"
}

# Pids still alive in process group $1, comma-separated (empty when none).
group_members() {
  /usr/bin/pgrep -g "$1" 2>/dev/null | tr '\n' ',' | sed 's/,$//' || true
}

# What the sandboxed build left running, as BUILD_LEFT (pids, comma-separated; empty when none): any process in its
# process group $2, or with D/tools/build_chain.sh or D/build in its arguments (a child can leave the group with
# setsid). For the argument match this shell and its direct children (the subshell running ps) are not counted. Set
# as a global, not printed: a command substitution would add a subshell whose arguments are this script's. Dots in D
# are matched literally.
BUILD_LEFT=""
build_leftovers() {
  local re
  re=$(printf '%s' "$1" | sed 's/[.]/[.]/g')
  BUILD_LEFT=$(/bin/ps -ax -o pid=,ppid=,pgid=,command= | awk -v me="$$" -v pg="$2" \
    -v re="$re/tools/build_chain[.]sh|$re/build(/|[[:space:]]|\$)" \
    '$1 != me && ($3 == pg || ($2 != me && $0 ~ re)) {print $1}' | sort -un | tr '\n' ',' | sed 's/,$//')
}

# The egress block must hold before any foundry RPC call: cast asked for the chain id of a TEST-NET-1 address
# (192.0.2.1, RFC 5737) through foundry_in must fail fast with "Connection refused" (the dead proxy). A success, a
# hang to the deadline, any other error, or something listening on the proxy port means foundry would not stay on
# 127.0.0.1. Output goes to D/logs/foundry-egress.log; needs set_foundry_cwd first.
FISCO_EGRESS_PROBE_URL="http://192.0.2.1:8545"
FISCO_EGRESS_SECONDS=20
foundry_egress_check() {
  local d="$1" log="$1/logs/foundry-egress.log" rc=0
  [ -n "${FOUNDRY_CWD:-}" ] || die "foundry_egress_check: set_foundry_cwd first"
  ! port_in_use "$FISCO_NO_EGRESS_PORT" ||
    die "foundry does not honour the egress block: 127.0.0.1:$FISCO_NO_EGRESS_PORT is listening (it must stay closed)"
  safe_dir "$d/logs"
  safe_target "$log"
  run_group "$FISCO_EGRESS_SECONDS" "$log" foundry_in "$FOUNDRY_CWD" "$CAST" chain-id --rpc-timeout 3 \
    --rpc-url "$FISCO_EGRESS_PROBE_URL" || rc=$?
  case "$rc" in
    0) die "foundry does not honour the egress block: cast reached $FISCO_EGRESS_PROBE_URL (see $log)" ;;
    124) die "foundry does not honour the egress block: cast still running after ${FISCO_EGRESS_SECONDS}s (see $log)" ;;
  esac
  grep -q 'Connection refused' "$log" ||
    die "foundry does not honour the egress block: cast failed without the dead proxy's 'Connection refused' (see $log)"
  [ -z "$(group_members "$RUN_GROUP_PGID")" ] || die "foundry_egress_check: processes left in group $RUN_GROUP_PGID"
  info "PASS foundry egress: a request to $FISCO_EGRESS_PROBE_URL fails at the dead proxy $FISCO_NO_EGRESS_PROXY"
}

# One random password file and one keystore per local role, under D/keys (mode 700/600): the throwaway deployer, and
# the regulator (the genesis committee's governor, local to this chain). The password reaches cast through
# CAST_PASSWORD in its environment; the private key is never printed.
ensure_keys_dir() {
  local d="$1"
  safe_dir "$d/keys"
  chmod 700 "$d/keys"
  safe_target "$d/keys/pw"
  if [ ! -f "$d/keys/pw" ]; then
    (umask 077 && set -C && /usr/bin/openssl rand -hex 32 >"$d/keys/pw")
  fi
  chmod 600 "$d/keys/pw"
}

ensure_keystore() {
  local d="$1" name="$2"
  ensure_keys_dir "$d"
  [ -n "${FOUNDRY_CWD:-}" ] || die "ensure_keystore: set_foundry_cwd first"
  safe_target "$d/keys/$name"
  if [ ! -f "$d/keys/$name" ]; then
    (
      cd -- "$FOUNDRY_CWD" || exit 1
      foundry_env
      CAST_PASSWORD="$(cat -- "$d/keys/pw")"
      export CAST_PASSWORD
      exec "$CAST" wallet new "$d/keys" "$name" </dev/null >/dev/null
    )
  fi
  [ -f "$d/keys/$name" ] && [ ! -L "$d/keys/$name" ] || die "could not create keystore $name"
  chmod 600 "$d/keys/$name"
}

keystore_address() {
  local d="$1" name="$2"
  foundry_in "${FOUNDRY_CWD:-}" "$CAST" wallet address --keystore "$d/keys/$name" --password-file "$d/keys/pw"
}

# How every node starts (chain-up.sh runs it from the node's folder and records it in D/run/<node>.cmd; chain-check.sh
# compares the record with this line). NODES_DIR=D/nodes is node.sb's only readable and writable part of D.
node_start_line() {
  local d="$1"
  printf '%s -D NODES_DIR=%s -D BIN=%s -f %s %s -c config.ini -g config.genesis\n' \
    "$SANDBOX_EXEC" "$d/nodes" "$d/bin/fisco-bcos" "$FISCO_SCRIPT_DIR/node.sb" "$d/bin/fisco-bcos"
}

# Node pid files live in D/run (no sandbox can write there), one per node folder name.
node_pid_file() {
  printf '%s/run/%s.pid\n' "$1" "$(basename -- "$2")"
}

# For the sandbox self-tests (chain-check.sh --selftest, test/profiles.sh): a perl program, run as
# `perl -e "$FISCO_PROC_READER" <pid>`, that asks the kernel by number, as ps does, for that process's arguments
# (sysctl {CTL_KERN, KERN_PROCARGS2, pid}) and its process table entry ({CTL_KERN, KERN_PROC, KERN_PROC_PID, pid}). It
# prints "ARGS <arguments>" or "ARGS ERR <error>", then "PROC <n> bytes" or "PROC ERR <error>". 202 is SYS_sysctl.
FISCO_PROC_READER='my ($p) = @ARGV; die "usage: <pid>\n" unless defined $p && $p =~ /^[0-9]+$/;
my $b = "\0" x 262144; my $l = pack("Q", length $b); my $m = pack("i3", 1, 49, $p);
if (syscall(202, $m, 3, $b, $l, 0, 0) == -1) { print "ARGS ERR $!\n" }
else { my $s = substr($b, 4, unpack("Q", $l) - 4); $s =~ tr/\0/ /s; print "ARGS $s\n" }
$b = "\0" x 4096; $l = pack("Q", length $b); $m = pack("i4", 1, 14, 1, $p);
if (syscall(202, $m, 4, $b, $l, 0, 0) == -1) { print "PROC ERR $!\n" } else { print "PROC ", unpack("Q", $l), " bytes\n" }'
