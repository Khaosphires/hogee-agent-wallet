#!/bin/bash
# fake-dir.sh: offline tests for scripts/fisco on throwaway folders. No chain, no network, no FISCO software; no
# sandbox either (profiles.sh covers the two profiles). Dummy keys are random hex. Usage: bash fake-dir.sh
set -uo pipefail
R="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TOP=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/hogee-fisco-test.XXXXXX")
trap 'rm -rf -- "$TOP"' EXIT
TOTAL_F=0

# ---------------------------------------------------------------------------------------------- lib.sh, chain-lib.sh
lib_tests() (
  T="$TOP/lib"
  . "$R/lib.sh"; . "$R/chain-lib.sh"
  P=0; F=0
  ok() { P=$((P+1)); echo "ok   $*"; }
  bad() { F=$((F+1)); echo "FAIL $*"; }
  dies() { local label="$1"; shift; if ( "$@" ) >/dev/null 2>&1; then bad "$label (did not die)"; else ok "$label"; fi; }
  lives() { local label="$1"; shift; if ( "$@" ) >/dev/null 2>&1; then ok "$label"; else bad "$label (died)"; fi; }
  rm -rf "$T"; mkdir -p "$T"; T=$(cd "$T" && pwd -P)
  # --- resolve_chain_dir / refuse_unsafe_dir / prepare_chain_dir (H-ops)
  mkdir -m 755 "$T/Chain"
  dies "resolve: .. component" resolve_chain_dir "$T/x/../Chain"
  dies "resolve: . component" resolve_chain_dir "$T/./Chain"
  dies "resolve: trailing /." resolve_chain_dir "$T/Chain/."
  dies "resolve: other letter case of an existing dir" resolve_chain_dir "$T/chain"
  [ "$(resolve_chain_dir "$T/Chain")" = "$T/Chain" ] && ok "resolve: canonical path accepted" || bad "resolve canonical"
  ln -s "$T/Chain" "$T/link"; dies "resolve: symlink D" resolve_chain_dir "$T/link"
  dies "refuse: ~/Library/CloudStorage" refuse_unsafe_dir "$FISCO_HOME_P/Library/CloudStorage/x"
  dies "refuse: ~/Desktop" refuse_unsafe_dir "$FISCO_HOME_P/Desktop/x"
  dies "prepare: other letter case dies" prepare_chain_dir "$T/chain"
  [ "$(stat -f %Lp "$T/Chain")" = 755 ] && ok "prepare: no chmod before the canonical check" || bad "prepare chmod'ed"
  lives "prepare: new D" prepare_chain_dir "$T/D"
  [ "$(stat -f %Lp "$T/D")" = 700 ] && [ "$(cat "$T/D/.hogee-fisco")" = "$T/D" ] && ok "prepare: mode 700 + marker" || bad "prepare new"
  mkdir -m 700 "$T/E"; ln -s "$T/outside-marker" "$T/E/.hogee-fisco"; dies "prepare: marker symlink refused" prepare_chain_dir "$T/E"
  [ ! -e "$T/outside-marker" ] && ok "prepare: nothing written through the marker link" || bad "marker link followed"
  # --- run-12: D must not be or contain the repo, ~/hogee-wt or a user-document or synced folder (all would be made
  # mode 700 and become wipeable); an existing D is adopted only when empty or carrying its own marker.
  for p in "$FISCO_REPO_DIR" "$(dirname -- "$FISCO_REPO_DIR")" "$FISCO_HOME_P/hogee-wt" "$FISCO_HOME_P/hogee-wt/x" \
    "$FISCO_HOME_P/Library" "$FISCO_HOME_P/Library/CloudStorage" "$FISCO_HOME_P/Desktop" "$FISCO_HOME_P/Documents"; do
    dies "refuse: $p" refuse_unsafe_dir "$p"
  done
  lives "refuse: a plain folder is fine" refuse_unsafe_dir "$T/plain"
  mkdir -m 755 "$T/Full"; echo keep >"$T/Full/precious"
  dies "prepare: a non-empty D without a marker is refused" prepare_chain_dir "$T/Full"
  [ ! -e "$T/Full/.hogee-fisco" ] && [ "$(stat -f %Lp "$T/Full")" = 755 ] && ok "prepare: no marker and no chmod in a refused D" ||
    bad "prepare changed a refused D"
  mkdir -m 755 "$T/Empty"; lives "prepare: an empty D is adopted" prepare_chain_dir "$T/Empty"
  [ "$(cat "$T/Empty/.hogee-fisco")" = "$T/Empty" ] && [ "$(stat -f %Lp "$T/Empty")" = 700 ] && ok "prepare: adopted D gets mode 700 + marker" ||
    bad "prepare empty"
  echo more >"$T/Empty/file"; lives "prepare: a D carrying its own marker is adopted again" prepare_chain_dir "$T/Empty"
  printf '%s\n' "$T/Other" >"$T/Full/.hogee-fisco"; dies "prepare: a marker naming another dir is refused" prepare_chain_dir "$T/Full"
  # --- safe_dir / safe_target (C1)
  D="$T/D"; mkdir "$T/outside"; echo original >"$T/outside/target"
  ln -s "$T/outside" "$D/deploy"; dies "safe_dir: symlinked folder" safe_dir "$D/deploy"
  echo x >"$D/afile"; dies "safe_dir: a file" safe_dir "$D/afile"
  lives "safe_dir: creates" safe_dir "$D/logs"; [ "$(stat -f %Lp "$D/logs")" = 700 ] && ok "safe_dir: mode 700" || bad "safe_dir mode"
  ln -s "$T/outside/target" "$D/logs/forge-deploy.log"; dies "safe_target: symlink" safe_target "$D/logs/forge-deploy.log"
  ln -s "$T/outside/nope" "$D/logs/dangling"; dies "safe_target: dangling symlink" safe_target "$D/logs/dangling"
  mkdir "$D/logs/adir"; dies "safe_target: a folder" safe_target "$D/logs/adir"
  lives "safe_target: missing file" safe_target "$D/logs/new.log"
  echo y >"$D/logs/old.log"; lives "safe_target: own regular file" safe_target "$D/logs/old.log"
  mkdir -p "$D/keys"; chmod 700 "$D/keys"; ln -s "$T/outside/target" "$D/keys/pw"
  dies "ensure_keys_dir: pw symlink" ensure_keys_dir "$D"
  [ "$(cat "$T/outside/target")" = original ] && [ "$(stat -f %Lp "$T/outside/target")" = 644 ] && ok "outside target unchanged (content, mode)" || bad "outside target changed"
  rm "$D/keys/pw"; lives "ensure_keys_dir: fresh pw" ensure_keys_dir "$D"; [ "$(stat -f %Lp "$D/keys/pw")" = 600 ] && ok "pw mode 600" || bad "pw mode"
  # --- run-12: link count 1 for every file the scripts write or trust (a hard link carries the write elsewhere)
  echo one >"$D/logs/one"; ln "$D/logs/one" "$T/outside/two"
  dies "safe_target: a file with a second hard link" safe_target "$D/logs/one"
  dies "write_fact: a file with a second hard link" write_fact "$D/logs/one" x
  ( owned_file "$D/logs/one" ) && bad "owned_file: accepted a hard-linked file" || ok "owned_file: refuses a file with a second hard link"
  [ "$(cat "$T/outside/two")" = one ] && ok "the other name of the hard link is unchanged" || bad "a write went through a hard link"
  rm "$T/outside/two"; lives "safe_target: link count 1 again" safe_target "$D/logs/one"
  owned_file "$D/logs/one" && ok "owned_file: a plain file of the user" || bad "owned_file: plain file refused"
  # --- chain-lib rewrites refuse links (writes before the first node start)
  mkdir -p "$D/n"; ln -s "$T/outside/target" "$D/n/config.ini"; dies "rewrite_config_ini: symlinked config" rewrite_config_ini "$D/n/config.ini" true 8545
  printf '[p2p]\n listen_ip=0.0.0.0\n' >"$D/n/c2.ini"; ln -s "$T/outside/target" "$D/n/c2.ini.new"; dies "rewrite_config_ini: symlinked .new" rewrite_config_ini "$D/n/c2.ini" true 8545
  [ "$(cat "$T/outside/target")" = original ] && ok "outside target unchanged after rewrites" || bad "rewrite followed a link"
  # --- unexpected_links
  L="$T/L"; mkdir -p "$L/home/.fisco" "$L/nodes"; ln -s /opt/homebrew/opt/openssl@3/bin/openssl "$L/home/.fisco/tassl-1.1.1b"
  [ -z "$(unexpected_links "$L")" ] && ok "links: TASSL stub alone is fine" || bad "links: stub reported"
  ln -s /etc "$L/nodes/evil"; ln -s /etc "$L/nodes/$(printf 'esc\033[2J')"
  out=$(unexpected_links "$L")
  [ "$(printf '%s\n' "$out" | grep -c .)" = 2 ] && ok "links: both planted links reported" || bad "links: got '$out'"
  case "$out" in *$'\033'*) bad "links: escape byte printed" ;; *) ok "links: control bytes shown as ?" ;; esac
  # --- foundry cwd and env (egress block)
  mkdir -p "$D/cwd"; touch "$D/cwd/foundry.toml"; dies "set_foundry_cwd: non-empty" set_foundry_cwd "$D"
  rm "$D/cwd/foundry.toml"; set_foundry_cwd "$D"; [ "$FOUNDRY_CWD" = "$D/cwd" ] && ok "set_foundry_cwd: D/cwd" || bad "foundry cwd"
  ENVOUT=$(SOME_SECRET=x foundry_in "$FOUNDRY_CWD" /usr/bin/env)
  for v in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; do
    printf '%s\n' "$ENVOUT" | grep -qx "$v=http://127.0.0.1:9" || bad "env: $v missing"
  done
  printf '%s\n' "$ENVOUT" | grep -qx 'NO_PROXY=127.0.0.1' && printf '%s\n' "$ENVOUT" | grep -qx 'no_proxy=127.0.0.1' &&
    ok "env: proxies to 127.0.0.1:9, NO_PROXY/no_proxy 127.0.0.1 only (no localhost)" || bad "env NO_PROXY"
  printf '%s\n' "$ENVOUT" | grep -q SOME_SECRET && bad "env: not scrubbed" || ok "env: scrubbed"
  [ "$(foundry_in "$FOUNDRY_CWD" /bin/pwd)" = "$D/cwd" ] && ok "foundry_in: runs in D/cwd" || bad "foundry_in cwd"
  dies "foundry_in: empty dir refused" foundry_in "" /usr/bin/true
  # --- run-12: the dead proxy port is checked again before every foundry run (stand-in port_in_use: no real listener)
  ( port_in_use() { echo "$1" >>"$T/ports-asked"; return 1; }; foundry_in "$FOUNDRY_CWD" /usr/bin/true ) &&
    [ "$(cat "$T/ports-asked" 2>/dev/null)" = 9 ] && ok "foundry_in: asks whether port 9 listens, then runs" || bad "foundry_in: port 9 not checked"
  ( port_in_use() { [ "$1" = 9 ]; }; foundry_in "$FOUNDRY_CWD" /usr/bin/touch "$T/foundry-ran" ) >/dev/null 2>&1 &&
    bad "foundry_in: ran while port 9 listens" || { [ ! -e "$T/foundry-ran" ] && ok "foundry_in: refuses to run while port 9 listens" || bad "foundry_in ran the command"; }
  ( port_in_use() { [ "$1" = 9 ]; }; foundry_env; echo ran ) 2>/dev/null | grep -q ran &&
    bad "foundry_env: went on while port 9 listens" || ok "foundry_env (keystore subshells too): dies while port 9 listens"
  # --- foundry_egress_check with stand-in cast scripts (no network: the real probe is P1's runtime test)
  S="$T/stubs"; mkdir -p "$S"
  stub() { printf '#!/bin/bash\n%s\n' "$2" >"$S/$1"; chmod 755 "$S/$1"; }
  # Refuses only when it sees the dead proxy for a 192.0.2.1 request; "succeeds" otherwise (an egress leak).
  stub refused 'if [ "$HTTP_PROXY$https_proxy$ALL_PROXY" = "http://127.0.0.1:9http://127.0.0.1:9http://127.0.0.1:9" ] && [ "$no_proxy" = 127.0.0.1 ] && [[ " $* " == *" http://192.0.2.1:8545 "* ]]; then echo "Error: tcp connect error: Connection refused (os error 61)" >&2; exit 1; fi; echo 20200'
  stub reached 'echo 20200'
  stub hangs 'exec /bin/sleep 37.25'
  stub other 'echo "Error: No route to host (os error 65)" >&2; exit 1'
  REAL_CAST="$CAST"
  CAST="$S/refused"; t0=$(date +%s)
  lives "egress check: fails fast at the dead proxy -> pass" foundry_egress_check "$D"
  [ $(($(date +%s) - t0)) -le 4 ] && ok "egress check: returns as soon as cast exits" || bad "egress check waited for the deadline"
  grep -q 'Connection refused' "$D/logs/foundry-egress.log" && ok "egress check: cast output in D/logs/foundry-egress.log" || bad "egress log"
  CAST="$S/reached"; dies "egress check: cast reaches the address -> dies" foundry_egress_check "$D"
  CAST="$S/other"; dies "egress check: another error -> dies" foundry_egress_check "$D"
  CAST="$S/hangs"; FISCO_EGRESS_SECONDS=2
  dies "egress check: still running at the deadline -> dies" foundry_egress_check "$D"
  sleep 1
  /usr/bin/pgrep -f 'sleep 37\.25' >/dev/null && bad "egress check: the hung cast was left running" || ok "egress check: the hung cast's group was killed"
  CAST="$REAL_CAST"; FISCO_EGRESS_SECONDS=20
  ln -sf "$T/outside/target" "$D/logs/foundry-egress.log"; CAST="$S/refused"
  dies "egress check: log symlink refused" foundry_egress_check "$D"
  rm -f "$D/logs/foundry-egress.log"; CAST="$REAL_CAST"
  # --- run_group: own process group; members found while alive
  run_group 0 "$T/group.log" /bin/sh -c 'echo "$$ $(ps -o pgid= -p $$)"' && read -r gp gg <"$T/group.log" && [ "$gp" = "$gg" ] &&
    [ "$RUN_GROUP_PGID" = "$gp" ] && ok "run_group: the command leads its own process group" || bad "run_group pgid"
  run_group 0 "$T/group.log" /bin/sh -c 'exit 3'; [ $? = 3 ] && ok "run_group: exit status passed through" || bad "run_group status"
  run_group 0 "$T/group.log" /bin/sh -c '/bin/sleep 38.25 >/dev/null 2>&1 & exit 0'
  [ -n "$(group_members "$RUN_GROUP_PGID")" ] && ok "group_members: a child left behind is found" || bad "group_members missed a child"
  /usr/bin/pkill -g "$RUN_GROUP_PGID" 2>/dev/null; sleep 0.3
  [ -z "$(group_members "$RUN_GROUP_PGID")" ] && ok "group_members: empty once the group is gone" || bad "group_members not empty"
  ( run_group 0 "$T/term.log" /bin/sleep 42.25 ) &
  SP=$!; sleep 1; kill -TERM "$SP"; wait "$SP"; TRC=$?; sleep 0.3
  [ "$TRC" = 130 ] && ! /usr/bin/pgrep -f 'sleep 42\.25' >/dev/null && ok "run_group: TERM to the script kills the group" ||
    { bad "run_group TERM: exit $TRC"; /usr/bin/pkill -f 'sleep 42\.25'; }
  # --- build_leftovers (chain-up.sh after build_chain.sh): its group, or D/tools/build_chain.sh / D/build in args
  case "$D" in *.*) ok "build_leftovers: D has a dot (matched literally)" ;; *) bad "test D has no dot: $D" ;; esac
  run_group 0 "$T/group.log" /bin/sh -c '/bin/sleep 39.25 >/dev/null 2>&1 & exit 0'; PG="$RUN_GROUP_PGID"
  build_leftovers "$D" "$PG"; [ -n "$BUILD_LEFT" ] && ok "build_leftovers: a child left in the build's group" || bad "group child missed"
  /usr/bin/pkill -g "$PG" 2>/dev/null; sleep 0.3
  run_group 0 "$T/group.log" /usr/bin/perl -MPOSIX -e 'exit 0 if fork; POSIX::setsid(); sleep 40' "$D/build/x"; PG="$RUN_GROUP_PGID"
  sleep 0.3; [ -z "$(group_members "$PG")" ] && ok "build_leftovers: (setsid child left the group)" || bad "setsid child still in group"
  build_leftovers "$D" "$PG"; [ -n "$BUILD_LEFT" ] && ok "build_leftovers: a setsid child with D/build in its args" || bad "setsid child missed"
  /usr/bin/pkill -f "$D/build/x" 2>/dev/null
  /usr/bin/perl -e 'sleep 41' "$D/buildx" "${D}x/build/y" >/dev/null 2>&1 &
  OTHER=$!; sleep 0.3
  build_leftovers "$D" "$PG"; [ -z "$BUILD_LEFT" ] && ok "build_leftovers: none left; D/buildx and Dx/build not matched" || bad "build_leftovers: '$BUILD_LEFT'"
  kill "$OTHER" 2>/dev/null; wait "$OTHER" 2>/dev/null
  grep -q 'run_group 0 "$D/logs/build.log" sandboxed_build' "$R/chain-up.sh" &&
    grep -q 'build_leftovers "$D" "$RUN_GROUP_PGID"' "$R/chain-up.sh" && ok "chain-up.sh: build in its own group, leftovers checked" || bad "chain-up build wiring"
  # --- start line, pid file, hex, printable
  [ "$(node_start_line /x/D)" = "$SANDBOX_EXEC -D NODES_DIR=/x/D/nodes -D BIN=/x/D/bin/fisco-bcos -f $FISCO_SCRIPT_DIR/node.sb /x/D/bin/fisco-bcos -c config.ini -g config.genesis" ] && ok "node_start_line" || bad "node_start_line: $(node_start_line /x/D)"
  [ "$(node_pid_file /x/D /x/D/nodes/127.0.0.1/node3)" = /x/D/run/node3.pid ] && ok "node_pid_file in D/run" || bad "pid file"
  [ "$(hex_to_dec 0x1f)" = 31 ] && ok "hex_to_dec" || bad "hex_to_dec"
  dies "hex_to_dec: junk" hex_to_dec "0x1f; rm"
  [ "$(printable "$(printf 'FISCO\033]0;x\007/3.17.1')")" = "FISCO]0;x/3.17.1" ] && ok "printable strips control bytes" || bad "printable"
  echo "lib tests: $P passed, $F failed"
  [ "$F" = 0 ]
)

# ---------------------------------------------------------------------------- chain-check.sh start records and links
check_tests() (
  set -e
  T="$TOP/check"
  . "$R/lib.sh"
  rm -rf "$T"; mkdir -p "$T"; T=$(real_dir "$T"); D="$T/D"
  mkdir -p "$D/nodes/127.0.0.1/node0" "$D/nodes/127.0.0.1/node1" "$D/run" "$D/home/.fisco" "$D/bin"
  ln -s "$OPENSSL3" "$D/home/.fisco/tassl-1.1.1b"
  node_start_line "$D" >"$D/run/node0.cmd"
  node_start_line "$D" | sed "s|NODES_DIR=$D/nodes|NODES_DIR=$D|" >"$D/run/node1.cmd"
  sha256_of "$R/node.sb" >"$D/run/node.sb.sha256"
  FAILS=0; OUT=""
  pass() { echo "PASS $*"; }
  fail() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }
  BLOCK=$(sed -n '/^# Start records and pid files/,/^if \[ -L "\$TASSL" \]/p' "$R/chain-check.sh")
  run_block() { eval "$BLOCK"; }
  echo "== case 1: node1 started with NODES_DIR=D"; run_block | sed "s|$D|D|g"
  echo "== case 2: both records right, a planted link, the profile changed"
  node_start_line "$D" >"$D/run/node1.cmd"; echo 0000 >"$D/run/node.sb.sha256"; ln -s /etc "$D/nodes/127.0.0.1/node0/evil"
  FAILS=0; run_block | sed "s|$D|D|g"
  echo "== case 3: all good but no processes"
  sha256_of "$R/node.sb" >"$D/run/node.sb.sha256"; rm "$D/nodes/127.0.0.1/node0/evil"
  FAILS=0; run_block | sed "s|$D|D|g"
)

# ------------------------------------------------------- regulator: auth genesis, per-node Web3, facts, stub, chain-check
# A synthetic chain shaped like build_chain.sh v3.17.1's output (generate_config_ini, generate_genesis_config, -a).
fake_ini() {
  cat <<'X'
[p2p]
    listen_ip=0.0.0.0
    listen_port=30300
    sm_ssl=false
    enable_ssl_verify = true

[rpc]
    listen_ip=0.0.0.0
    listen_port=20200
    thread_count=4
    sm_ssl=false
    ; ssl connection switch, if you wan to disable the ssl connection, turn it to false, default: true
    enable_ssl=true

[web3_rpc]
    enable=false
    listen_ip=0.0.0.0
    listen_port=8545
    thread_count=8
    ; cors config for web3 rpc
    enable_cors=true
    cors_allowed_origins=*

[cert]
    ca_path=./conf
X
}
# make_chain D n admin: n node folders, one genesis copied to all, sdk/ certificates from $CERTS.
make_chain() {
  local d="$1" n="$2" admin="$3" root="$1/nodes/127.0.0.1" i
  mkdir -p "$root/sdk" "$d/facts"
  for i in $(seq 0 $((n - 1))); do
    mkdir -p "$root/node$i/conf"
    /usr/bin/openssl rand -hex 64 >"$root/node$i/conf/node.nodeid"
    fake_ini >"$root/node$i/config.ini"
  done
  {
    printf '[chain]\n    sm_crypto=false\n    group_id=group0\n    chain_id=chain0\n\n[web3]\n    chain_id=20200\n\n'
    printf '[consensus]\n    consensus_type=pbft\n    leader_period=1\n    ; the node id of consensusers\n'
    for i in $(seq 0 $((n - 1))); do printf '        node.%s=%s: 1\n' "$i" "$(cat "$root/node$i/conf/node.nodeid")"; done
    printf '\n[version]\n    compatibility_version=3.17.1\n[tx]\n    gas_limit=3000000000\n[executor]\n'
    printf '    is_wasm=false\n    is_auth_check=true\n    auth_admin_account=%s\n    is_serial_execute=true\n' "$admin"
  } >"$root/node0/config.genesis"
  for i in $(seq 1 $((n - 1))); do cp "$root/node0/config.genesis" "$root/node$i/config.genesis"; done
  cp "$CERTS/ca.crt" "$CERTS/sdk.crt" "$CERTS/sdk.key" "$root/sdk/"
}
# A CA and an sdk certificate it signed (RSA, as the real sdk pair), plus a certificate from another CA.
make_certs() {
  local c="$1"
  mkdir -p "$c/other"
  (
    cd "$c" || exit 1
    "$OPENSSL3" req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -subj /CN=test-ca -days 2 \
      -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign
    "$OPENSSL3" req -newkey rsa:2048 -nodes -keyout sdk.key -out sdk.csr -subj /CN=sdk
    "$OPENSSL3" x509 -req -in sdk.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out sdk.crt -days 2
    cd other || exit 1
    "$OPENSSL3" req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -subj /CN=other-ca -days 2 \
      -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign
    "$OPENSSL3" req -newkey rsa:2048 -nodes -keyout sdk.key -out sdk.csr -subj /CN=sdk
    "$OPENSSL3" x509 -req -in sdk.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out sdk.crt -days 2
  ) >/dev/null 2>&1
}

reg_tests() (
  T="$TOP/reg"
  . "$R/lib.sh"; . "$R/chain-lib.sh"
  P=0; F=0
  ok() { P=$((P+1)); echo "ok   $*"; }
  bad() { F=$((F+1)); echo "FAIL $*"; }
  dies() { local label="$1"; shift; if ( "$@" ) >/dev/null 2>&1; then bad "$label (did not die)"; else ok "$label"; fi; }
  lives() { local label="$1"; shift; if ( "$@" ) >/dev/null 2>&1; then ok "$label"; else bad "$label (died)"; fi; }
  has() { case "$3" in *"$2"*) ok "$1" ;; *) bad "$1: no '$2' in: $(printf '%s' "$3" | tr '\n' ';')" ;; esac; }
  line_of() { grep -nF -- "$2" "$1" | head -1 | cut -d: -f1; }
  before() { local a b; a=$(line_of "$2" "$3"); b=$(line_of "$2" "$4")
    [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ] && ok "$1" || bad "$1 (lines '$a' '$b')"; }
  rm -rf "$T"; mkdir -p "$T"; T=$(real_dir "$T")
  # --- lib.sh constants: node4's Web3 joins the chain ports; the ledger RPC is node4's.
  [ "$FISCO_LEDGER_RPC" = http://127.0.0.1:8546 ] && ok "lib: FISCO_LEDGER_RPC = http://127.0.0.1:8546" || bad "FISCO_LEDGER_RPC '${FISCO_LEDGER_RPC:-}'"
  case " $FISCO_PORTS " in *" 8545 8546 "*) ok "lib: FISCO_PORTS has 8545 and 8546" ;; *) bad "FISCO_PORTS: $FISCO_PORTS" ;; esac
  [ "$(printf '%s\n' $FISCO_PORTS | grep -c .)" = 12 ] && ok "lib: 12 chain ports" || bad "port count"
  [ "${FISCO_COMMITTEE_MANAGER:-}" = 0x0000000000000000000000000000000000010001 ] && ok "lib: CommitteeManager 0x...10001" || bad "committee address"
  [ "${FISCO_SIG_OBSERVER_PROPOSAL:-}" = "createSetConsensusWeightProposal(string,uint32,bool,uint256)" ] &&
    ok "lib: the observer proposal signature" || bad "proposal signature"
  # --- rpc_at: plain http to 127.0.0.1 only, refused before any request is made.
  for u in http://192.0.2.1:8546 http://localhost:8546 https://127.0.0.1:8546 http://127.0.0.1:8546/x \
    "http://127.0.0.1:8546 -o x" http://127.0.0.1 http://127.0.0.1:99999; do
    dies "rpc_at refuses '$u'" rpc_at "$u" eth_chainId
  done
  # --- isGovernor(address) calldata: keccak256 selector 0xe43581b8 (cast sig and viem agree), then the address word.
  A=0x$(/usr/bin/openssl rand -hex 20)
  [ "$(is_governor_calldata "$A")" = "0xe43581b8000000000000000000000000${A#0x}" ] && ok "is_governor_calldata" ||
    bad "is_governor_calldata: $(is_governor_calldata "$A" 2>&1)"
  dies "is_governor_calldata: not an address" is_governor_calldata 0x1234
  mkdir -p "$T/cwd"
  [ "$(foundry_in "$T/cwd" "$CAST" sig 'isGovernor(address)' 2>/dev/null)" = 0xe43581b8 ] &&
    ok "cast sig 'isGovernor(address)' = 0xe43581b8" || bad "isGovernor selector"
  # is_governor with a stand-in rpc_at: eth_call to CommitteeManager on node0, true only for exactly ...01.
  ONE=0x$(printf '%063d' 0)1
  rpc_at() { printf '%s|%s|%s\n' "$1" "$2" "${3:-}" >>"$T/rpc.log"; [ "$GOV" != err ] || return 1; printf '%s' "$GOV"; }
  GOV="$ONE"; lives "is_governor: true for ...01" is_governor "$A"
  grep -qxF "http://127.0.0.1:8545|eth_call|[{\"to\":\"0x0000000000000000000000000000000000010001\",\"data\":\"$(is_governor_calldata "$A")\"},\"latest\"]" \
    "$T/rpc.log" && ok "is_governor: eth_call to 0x...10001 on node0's Web3" || bad "is_governor request: $(cat "$T/rpc.log")"
  for GOV in "0x$(printf '%064d' 0)" 0x1 "${ONE}00" err; do dies "is_governor: false for '$GOV'" is_governor "$A"; done
  unset -f rpc_at; . "$R/lib.sh"
  # --- get_account.sh stub: chain-up passes -a, so build_chain.sh never runs it; if it ran, no address and exit 1.
  mkdir -p "$T/home"; echo original >"$T/target"
  write_account_stub "$T/home/get_account.sh"
  OUT=$(/bin/bash "$T/home/get_account.sh" 2>&1); RC=$?
  [ "$RC" = 1 ] && [ -z "$OUT" ] && ok "stub: exits 1, prints nothing" || bad "stub: exit $RC, '$OUT'"
  [ "$(stat -f %Lp "$T/home/get_account.sh")" = 500 ] && ok "stub: mode 500" || bad "stub mode"
  grep -qiE 'curl|wget|http|address' "$T/home/get_account.sh" && bad "stub mentions a download or an address" || ok "stub: no download, no address"
  lives "stub: rewritten over its own mode-500 file" write_account_stub "$T/home/get_account.sh"
  ln -s "$T/target" "$T/home/link.sh"; dies "stub: refuses a symlink" write_account_stub "$T/home/link.sh"
  [ "$(cat "$T/target")" = original ] && ok "stub: nothing written through the link" || bad "stub followed a link"
  # --- write_fact: mode 444, replaced in place, never through a link.
  write_fact "$T/fact" 0xabc
  [ "$(cat "$T/fact")" = 0xabc ] && [ "$(stat -f %Lp "$T/fact")" = 444 ] && ok "write_fact: content and mode 444" || bad "write_fact"
  lives "write_fact: replaces its own 444 file" write_fact "$T/fact" 0xdef
  ln -s "$T/target" "$T/fact-link"; dies "write_fact: refuses a symlink" write_fact "$T/fact-link" x
  [ "$(cat "$T/target")" = original ] && ok "write_fact: nothing written through the link" || bad "write_fact followed a link"
  # --- a 5-node chain as build_chain.sh -a leaves it, then chain-up's rewrites and snapshot.
  CERTS="$T/certs"; mkdir -p "$CERTS"; make_certs "$CERTS"
  [ -f "$CERTS/sdk.crt" ] && [ -f "$CERTS/other/sdk.crt" ] || bad "could not make test certificates"
  REG=0x$(/usr/bin/openssl rand -hex 20)
  C="$T/C5"; ROOT5="$C/nodes/127.0.0.1"; make_chain "$C" 5 "$REG"
  write_fact "$C/facts/regulator.address" "$REG"
  [ -n "$(static_config_problems "$C")" ] && ok "5 nodes before the rewrites: problems reported" || bad "unrewritten chain passed"
  snapshot_sdk "$C"
  rewrite_node_configs "$C"
  PR=$(static_config_problems "$C"); [ -z "$PR" ] && ok "5 nodes: no config problem after the rewrites" || bad "5 nodes: $PR"
  PR=$(regulator_fact_problems "$C"); [ -z "$PR" ] && ok "facts: none after write_fact and snapshot_sdk" || bad "facts: $PR"
  for i in 0 1 2 3 4; do
    want="false 8545"; [ "$i" = 0 ] && want="true 8545"; [ "$i" = 4 ] && want="true 8546"
    got="$(ini_get "$ROOT5/node$i/config.ini" web3_rpc enable) $(ini_get "$ROOT5/node$i/config.ini" web3_rpc listen_port)"
    [ "$got" = "$want" ] && ok "node$i: [web3_rpc] enable/listen_port $want" || bad "node$i web3: $got, want $want"
  done
  [ "$(ini_get "$ROOT5/node0/config.ini" rpc enable_ssl)" = true ] && ok "node0: [rpc] enable_ssl=true kept (native TLS)" || bad "node0 enable_ssl"
  [ "$(ini_get "$ROOT5/node4/config.genesis" executor auth_admin_account)" = "$REG" ] && ok "genesis: auth_admin_account kept" || bad "admin lost"
  # snapshot_sdk: three regular files, same bytes, modes 444/444/400; refuses links on either side.
  for f in ca.crt sdk.crt sdk.key; do cmp -s "$ROOT5/sdk/$f" "$C/facts/sdk/$f" && [ ! -L "$C/facts/sdk/$f" ] || bad "snapshot $f"; done
  [ "$(cd "$C/facts/sdk" && stat -f %Lp ca.crt sdk.crt sdk.key | tr '\n' ' ')" = "444 444 400 " ] &&
    ok "snapshot_sdk: same bytes, modes 444 444 400, no links" || bad "snapshot modes"
  lives "snapshot_sdk: again over its own read-only snapshot" snapshot_sdk "$C"
  X="$T/X"; fresh() { rm -rf "$X"; cp -Rp "$C" "$X"; }
  fresh; rm "$X/nodes/127.0.0.1/sdk/sdk.key"; ln -s "$CERTS/sdk.key" "$X/nodes/127.0.0.1/sdk/sdk.key"
  dies "snapshot_sdk: refuses a linked source" snapshot_sdk "$X"
  fresh; rm "$X/nodes/127.0.0.1/sdk/sdk.crt"; dies "snapshot_sdk: refuses a missing source" snapshot_sdk "$X"
  fresh; rm -f "$X/facts/sdk/sdk.crt"; ln -s "$T/target" "$X/facts/sdk/sdk.crt"; dies "snapshot_sdk: refuses a linked target" snapshot_sdk "$X"
  [ "$(cat "$T/target")" = original ] && ok "snapshot_sdk: nothing written through the link" || bad "snapshot followed a link"
  # Each tampered copy must give its problem line (static_config_problems + regulator_fact_problems).
  gen_all() { local g; for g in "$X"/nodes/127.0.0.1/node*/config.genesis; do sed -i '' "$1" "$g"; done; }
  ini() { sed -i '' "$2" "$X/nodes/127.0.0.1/$1/config.ini"; }
  probs() { static_config_problems "$X"; regulator_fact_problems "$X"; }
  fresh; gen_all 's/is_auth_check=true/is_auth_check=false/'; has "auth off" "is_auth_check is not true" "$(probs)"
  fresh; gen_all '/is_auth_check=/d'; has "auth key missing" "is_auth_check is not true" "$(probs)"
  fresh; gen_all "s/auth_admin_account=.*/auth_admin_account=0x$(/usr/bin/openssl rand -hex 20)/"
  has "wrong admin" "auth_admin_account is not facts/regulator.address" "$(probs)"
  fresh; gen_all "s/auth_admin_account=.*/auth_admin_account=0x$(printf '%s' "${REG#0x}" | tr a-f A-F)/"
  [ -z "$(probs)" ] && ok "admin in upper-case hex: the same account, accepted" || bad "upper-case admin: $(probs)"
  fresh; gen_all '/auth_admin_account=/d'; has "admin missing" "auth_admin_account is not facts/regulator.address" "$(probs)"
  fresh; sed -i '' 's/auth_admin_account=.*/auth_admin_account=0x0000000000000000000000000000000000000001/' \
    "$X/nodes/127.0.0.1/node3/config.genesis"; has "one node's genesis differs" "config.genesis files differ" "$(probs)"
  fresh; ini node4 's/^\( *\)enable=true/\1enable=false/'; has "node4 Web3 off" "node4: [web3_rpc] enable is not true" "$(probs)"
  fresh; ini node4 's/listen_port=8546/listen_port=8545/'; has "node4 Web3 on 8545" "node4: [web3_rpc] listen_port is not 8546" "$(probs)"
  fresh; ini node4 's/listen_port=8546/listen_port=8547/'; has "node4 Web3 on 8547" "node4: [web3_rpc] listen_port is not 8546" "$(probs)"
  fresh; ini node1 's/^\( *\)enable=false/\1enable=true/'; has "node1 Web3 on" "node1: [web3_rpc] enable is not false" "$(probs)"
  fresh; ini node0 's/listen_port=8545/listen_port=8546/'; has "node0 Web3 on 8546" "node0: [web3_rpc] listen_port is not 8545" "$(probs)"
  fresh; ini node0 's/enable_ssl=true/enable_ssl=false/'; has "node0 native TLS off" "node0: [rpc] enable_ssl is not true" "$(probs)"
  fresh; rm -f "$X/facts/regulator.address"; PR=$(probs)
  has "regulator.address missing (facts)" "facts/regulator.address is missing or not a regular file" "$PR"
  has "regulator.address missing (genesis check)" "no valid facts/regulator.address" "$PR"
  fresh; rm -f "$X/facts/regulator.address"; printf '%s\n' "$REG" >"$T/reg-elsewhere"; ln -s "$T/reg-elsewhere" "$X/facts/regulator.address"
  PR=$(probs); has "regulator.address a link (right content)" "facts/regulator.address is missing or not a regular file" "$PR"
  has "regulator.address a link: no admin comparison" "no valid facts/regulator.address" "$PR"
  fresh; chmod 644 "$X/facts/regulator.address"; has "regulator.address mode 644" "facts/regulator.address mode is 644, want 444" "$(probs)"
  fresh; chmod 644 "$X/facts/regulator.address"; printf '0x%s\n' "$(printf '%s' "${REG#0x}" | tr a-f A-F)" >"$X/facts/regulator.address"
  chmod 444 "$X/facts/regulator.address"; has "regulator.address not lower case" "not a lower-case 0x address" "$(probs)"
  fresh; rm -f "$X/facts/sdk/sdk.key"; ln -s "$CERTS/sdk.key" "$X/facts/sdk/sdk.key"; has "sdk.key a link" "facts/sdk/sdk.key is missing or not a regular file" "$(probs)"
  fresh; chmod 644 "$X/facts/sdk/sdk.key"; has "sdk.key mode 644" "facts/sdk/sdk.key mode is 644, want 400" "$(probs)"
  fresh; rm -f "$X/facts/sdk/sdk.crt"; has "sdk.crt missing" "facts/sdk/sdk.crt is missing or not a regular file" "$(probs)"
  fresh; chmod 644 "$X/facts/sdk/sdk.crt"; cp "$CERTS/other/sdk.crt" "$X/facts/sdk/sdk.crt"; chmod 444 "$X/facts/sdk/sdk.crt"
  has "sdk.crt from another CA" "facts/sdk/sdk.crt does not verify against facts/sdk/ca.crt" "$(probs)"
  fresh; chmod -R u+w "$X/facts/sdk"; rm -rf "$X/facts/sdk"; mkdir "$T/sdk-elsewhere"; ln -s "$T/sdk-elsewhere" "$X/facts/sdk"
  has "facts/sdk a link" "facts/sdk is missing or not a real folder" "$(probs)"
  # A 4-node chain (--nodes 4): Web3 on node0 only, no node4.
  C4="$T/C4"; make_chain "$C4" 4 "$REG"; write_fact "$C4/facts/regulator.address" "$REG"; snapshot_sdk "$C4"; rewrite_node_configs "$C4"
  PR=$(static_config_problems "$C4"); [ -z "$PR" ] && ok "4 nodes: no config problem" || bad "4 nodes: $PR"
  [ "$(ini_get "$C4/nodes/127.0.0.1/node3/config.ini" web3_rpc enable)" = false ] && ok "4 nodes: node3 Web3 off" || bad "4 nodes node3"
  dies "rewrite_config_ini: refuses web3=yes" rewrite_config_ini "$ROOT5/node1/config.ini" yes 8545
  dies "rewrite_config_ini: refuses port 8547" rewrite_config_ini "$ROOT5/node1/config.ini" false 8547
  # --- chain-up.sh wiring (it is not run here: it builds a chain).
  CU="$R/chain-up.sh"
  grep -qF -- '-o "$D/nodes" -e "$BIN" -a "$REG_ADDR"' "$CU" && ok "chain-up: build_chain.sh gets -a <regulator address>" || bad "no -a"
  before "chain-up: regulator keystore made before the build" "$CU" 'ensure_keystore "$D" regulator.json' 'run_group 0 "$D/logs/build.log" sandboxed_build'
  before "chain-up: facts/regulator.address written before the build" "$CU" 'write_fact "$D/facts/regulator.address" "$REG_ADDR"' 'run_group 0 "$D/logs/build.log" sandboxed_build'
  before "chain-up: the stub written before the build" "$CU" 'write_account_stub "$D/home/.fisco/get_account.sh"' 'run_group 0 "$D/logs/build.log" sandboxed_build'
  before "chain-up: sdk snapshot after the CA check" "$CU" 'every node and sdk certificate verifies' 'snapshot_sdk "$D"'
  before "chain-up: sdk snapshot before the node start" "$CU" 'snapshot_sdk "$D"' 'NODE_ARGV=('
  before "chain-up: configs rewritten before the start" "$CU" 'rewrite_node_configs "$D"' 'NODE_ARGV=('
  grep -q 'regulator_fact_problems "$D"' "$CU" && ok "chain-up: regulator facts checked before the start" || bad "chain-up facts check"
  grep -qE 'admin\.json|addObserver\(string\)|0x0000000000000000000000000000000000001003' "$CU" &&
    bad "chain-up still has admin.json or addObserver" || ok "chain-up: no admin.json, no direct addObserver"
  grep -qF -- '--keystore "$D/keys/regulator.json"' "$CU" && grep -qF '"$FISCO_SIG_OBSERVER_PROPOSAL" "$NODE4_ID" 0 true 1000' "$CU" &&
    grep -qF '"$FISCO_COMMITTEE_MANAGER"' "$CU" && ok "chain-up: the regulator sends the observer proposal (node4, 0, true, 1000)" || bad "proposal wiring"
  before "chain-up: isGovernor checked before the proposal" "$CU" 'is_governor "$REG_ADDR"' '"$FISCO_SIG_OBSERVER_PROPOSAL" "$NODE4_ID"'
  grep -qF 'write_fact "$D/facts/observer.proposal" "$OBS_TX"' "$CU" && ok "chain-up: facts/observer.proposal (tx hash)" || bad "observer.proposal"
  # --- node.sb: node4's Web3 port in the bind rule only.
  BIND=$(sed -n '/^(allow network-bind/,/))$/p' "$R/node.sb"); OUTB=$(sed -n '/^(allow network-outbound/,/))$/p' "$R/node.sb")
  case "$BIND" in *'(local tcp "localhost:8546")'*) ok "node.sb: bind rule has localhost:8546" ;; *) bad "node.sb bind: no 8546" ;; esac
  case "$OUTB" in *8546*) bad "node.sb: 8546 in the outbound rule" ;; *) ok "node.sb: 8546 not in the outbound rule" ;; esac
  grep -q 8547 "$R/node.sb" && bad "node.sb names 8547" || ok "node.sb: no 8547"
  # --- chain-check.sh's ledger and governor checks, with a stand-in rpc_at (no node, no port).
  CC=$(
    eval "$(sed -n '/^ledger_check() {/,/^}/p; /^governor_check() {/,/^}/p' "$R/chain-check.sh")"
    type ledger_check governor_check >/dev/null 2>&1 || { echo "could not extract"; exit 0; }
    pass() { echo "PASS $*"; }; fail() { echo "FAIL $*"; }; note() { echo "NOTE $*"; }
    D="$C"; FISCO_LEDGER_WAIT=2
    H=0x$(/usr/bin/openssl rand -hex 32)
    rpc_at() {
      case "$1|$2" in
        ("$FISCO_LEDGER_RPC|eth_chainId") printf '%s' "$CID4" ;;
        ("$FISCO_RPC|eth_blockNumber") printf '%s' "$N0" ;;
        ("$FISCO_LEDGER_RPC|eth_blockNumber") printf '%s' "$N4" ;;
        ("$FISCO_RPC|eth_getBlockByNumber") [ "$3" = "[\"$N0\",false]" ] || return 1; printf '{"number":"%s","hash":"%s"}' "$N0" "$H" ;;
        ("$FISCO_LEDGER_RPC|eth_getBlockByNumber") [ "$3" = "[\"$N4\",false]" ] || return 1; printf '{"number":"%s","hash":"%s"}' "$N4" "$H4" ;;
        ("$FISCO_RPC|eth_call") printf '%s' "$GOV" ;;
        (*) return 1 ;;
      esac
    }
    echo 3 >"$C/observer.block"
    echo "== same"; CID4=0x4ee8; N0=0x7; N4=0x7; H4="$H"; ledger_check
    echo "== hash"; H4=0x$(/usr/bin/openssl rand -hex 32); ledger_check
    echo "== chainid"; CID4=0x1; H4="$H"; ledger_check
    echo "== behind"; CID4=0x4ee8; N4=0x6; ledger_check
    echo "== behind-new"; echo 7 >"$C/observer.block"; ledger_check
    echo "== gov-true"; GOV=0x$(printf '%063d' 0)1; governor_check
    echo "== gov-false"; GOV=0x$(printf '%064d' 0); governor_check
    echo "== gov-link"; GOV=0x$(printf '%063d' 0)1; mv "$C/facts/regulator.address" "$T/ra"; ln -s "$T/ra" "$C/facts/regulator.address"
    governor_check; rm "$C/facts/regulator.address"; mv "$T/ra" "$C/facts/regulator.address"
    # listener_check with stand-in listen_pids/port_in_use (no port is opened): who holds 8545, 20200 and 8546.
    eval "$(sed -n '/^listener_check() {/,/^}/p' "$R/chain-check.sh")"
    type listener_check >/dev/null 2>&1 || echo "could not extract listener_check"
    listen_pids() { eval "printf '%s' \"\${L$1:-}\""; }
    port_in_use() { [ "${ANSWERS:-}" = "$1" ]; }
    N=5; NODE0_PID=101; NODE4_PID=105
    echo "== listen-ok"; L8545=101 L20200=101 L8546=105 listener_check
    echo "== listen-other"; L8545=999 L20200=101 L8546=105 listener_check
    echo "== listen-two"; L8545=101 L20200=101,999 L8546=105 listener_check
    echo "== listen-swapped"; L8545=105 L20200=101 L8546=101 listener_check
    echo "== listen-foreign"; ANSWERS=8545 L8545="" L20200=101 L8546=105 listener_check
    echo "== listen-4"; N=4; NODE4_PID=""; L8545=101 L20200=101 L8546="" listener_check
    echo "== listen-down"; N=5; NODE0_PID=""; NODE4_PID=105; L8545=101 L20200=101 L8546=105 listener_check
  )
  sec() { printf '%s\n' "$CC" | sed -n "/^== $1\$/,/^== /p" | sed '1d;/^== /d'; }
  has "ledger: chain id and head match -> PASS" "PASS node4 ledger: eth_chainId 0x4ee8 on http://127.0.0.1:8546" "$(sec same)"
  has "ledger: same head and hash -> PASS" "PASS node4 ledger: head 7 and its hash equal node0's" "$(sec same)"
  has "ledger: another hash at the same head -> FAIL" "FAIL node4 ledger: block 7 hash" "$(sec hash)"
  has "ledger: wrong chain id -> FAIL" "FAIL node4 ledger: eth_chainId '0x1'" "$(sec chainid)"
  has "ledger: behind after blocks since the proposal -> FAIL" "FAIL node4 ledger: head '6', node0 '7'" "$(sec behind)"
  has "ledger: behind with no block since the proposal -> NOTE" "NOTE node4 ledger:" "$(sec behind-new)"
  case "$(sec behind-new)" in *FAIL*) bad "ledger: behind-new also failed" ;; *) ok "ledger: behind-new is not a FAIL" ;; esac
  has "governor: isGovernor true -> PASS" "PASS governor: CommitteeManager.isGovernor($REG) is true" "$(sec gov-true)"
  has "governor: isGovernor false -> FAIL" "FAIL governor: CommitteeManager.isGovernor($REG) is not true" "$(sec gov-false)"
  has "governor: facts/regulator.address a link -> FAIL" "FAIL governor: no valid facts/regulator.address" "$(sec gov-link)"
  # --- run-12: the RPC listeners are tied to their nodes' pids.
  case "$CC" in *"could not extract listener_check"*) bad "listener_check not found in chain-check.sh" ;; esac
  for l in "PASS listener 8545: node0's pid 101 only" "PASS listener 20200: node0's pid 101 only" "PASS listener 8546: node4's pid 105 only"; do
    has "listeners: $l" "$l" "$(sec listen-ok)"
  done
  case "$(sec listen-ok)" in *FAIL*) bad "listeners: a FAIL with every port held by its node" ;; *) ok "listeners: no FAIL when each port is its node's" ;; esac
  has "listeners: 8545 held by another of our processes -> FAIL" "FAIL listener 8545: pids '999', want node0's pid 101 only" "$(sec listen-other)"
  has "listeners: 20200 also held by another process -> FAIL" "FAIL listener 20200: pids '101,999', want node0's pid 101 only" "$(sec listen-two)"
  has "listeners: 8545 held by node4 -> FAIL" "FAIL listener 8545: pids '105', want node0's pid 101 only" "$(sec listen-swapped)"
  has "listeners: 8546 held by node0 -> FAIL" "FAIL listener 8546: pids '101', want node4's pid 105 only" "$(sec listen-swapped)"
  has "listeners: 8545 answers with none of ours listening -> FAIL" "FAIL listener 8545: answers, but none of our processes listens" "$(sec listen-foreign)"
  case "$(sec listen-4)" in *8546*) bad "listeners: 8546 checked with 4 nodes" ;; *FAIL*) bad "listeners: 4 nodes failed" ;;
    *"PASS listener 20200"*) ok "listeners: 4 nodes: 8545 and 20200 only" ;; *) bad "listeners: 4 nodes: $(sec listen-4)" ;; esac
  has "listeners: node0 not running -> FAIL" "FAIL listener 8545: node0 is not running" "$(sec listen-down)"
  grep -qx 'listener_check' "$R/chain-check.sh" && ok "chain-check.sh: listener_check runs" || bad "chain-check.sh: listener_check not called"
  # --- run-12: --chain 20200 on every signed send (observer proposal, DeployFinal) and on VerifyFinal.
  [ "$FISCO_CHAIN_ID" = 20200 ] && ok "lib: FISCO_CHAIN_ID 20200" || bad "FISCO_CHAIN_ID"
  grep -A2 'send --json --legacy' "$CU" | grep -qF -- '--chain "$FISCO_CHAIN_ID" --keystore "$D/keys/regulator.json"' &&
    ok "chain-up: the observer proposal is signed with --chain 20200" || bad "chain-up: no --chain on the proposal"
  for s in DeployFinal VerifyFinal; do
    grep -A1 "script/$s.s.sol:$s" "$R/deploy.sh" | grep -qF -- '--rpc-url "$FISCO_RPC" --chain "$FISCO_CHAIN_ID"' &&
      ok "deploy.sh: forge script $s with --chain 20200" || bad "deploy.sh: no --chain on $s"
  done
  # --- run-12: the self-test runs the new probes on both profiles, and never ps inside a sandbox (setuid: no exec).
  for want in 'selftest_procargs node.sb sb_node' 'selftest_procargs build.sb sb_build' \
    'selftest_trustd node.sb sb_node "$SB_NODES/apple-root.pem"' 'selftest_trustd build.sb sb_build "$SB_NODES/apple-root.pem"' \
    'selftest_hardlink "build.sb hard link in D/tmp to a file outside D" sb_build' \
    'selftest_hardlink "build.sb hard link in D/tmp to a file in D/logs" sb_build'; do
    grep -qF -- "$want" "$R/chain-check.sh" && ok "chain-check --selftest: $want" || bad "chain-check --selftest lacks: $want"
  done
  grep -qE '(sb_node|sb_build|runner"?) /bin/ps' "$R/chain-check.sh" && bad "chain-check runs /bin/ps in a sandbox" ||
    ok "chain-check: no /bin/ps inside a sandbox"
  echo "regulator tests: $P passed, $F failed"
  [ "$F" = 0 ]
)

# ------------------------------------------------------------------------------------- replay.sh keys and fd 3 payload
key_tests() (
T="$TOP/keys"
. "$R/lib.sh"
P=0; F=0
ok() { P=$((P+1)); echo "ok   $*"; }
bad() { F=$((F+1)); echo "FAIL $*"; }
rm -rf "$T"; mkdir -p "$T"; T=$(real_dir "$T")
# The names exactly as replay.sh defines them: four FINAL keys from HOGEE_ENV_FILE, then the regulator's from its keystore.
eval "$(grep -E '^(KEY_NAMES|REGULATOR_KEY_NAME|ALL_KEY_NAMES)=' "$R/replay.sh")"
[ "$KEY_NAMES" = "AGENT_PRIVATE_KEY_FINAL LENDER_PRIVATE_KEY_FINAL ORACLE_PRIVATE_KEY_FINAL RELAYER_PRIVATE_KEY_FINAL" ] &&
  [ "$ALL_KEY_NAMES" = "$KEY_NAMES REGULATOR_PRIVATE_KEY_FISCO" ] && ok "replay.sh: 4 FINAL names, then REGULATOR_PRIVATE_KEY_FISCO" ||
  bad "replay.sh key names: '${ALL_KEY_NAMES:-}'"
eval "$(sed -n '/^for name in \$ALL_KEY_NAMES; do unset/,/^read_role_keys$/p' "$R/replay.sh" | sed '$d')"
type read_role_keys read_regulator_key key_lines >/dev/null || { echo "could not extract"; exit 1; }
hex() { /usr/bin/openssl rand -hex 32; }
A=$(hex); L=$(hex); O=$(hex); RL=$(hex); G=$(hex)
# A throwaway regulator keystore in a fake D/keys (cast offline, dummy key and password; the replay decrypts it).
D="$T/D"; mkdir -p "$D/keys" "$D/cwd"; chmod 700 "$D/keys"
(umask 077 && /usr/bin/openssl rand -hex 32 >"$D/keys/pw")
foundry_in "$D/cwd" /usr/bin/env CAST_UNSAFE_PASSWORD="$(cat "$D/keys/pw")" "$CAST" wallet import regulator.json \
  --keystore-dir "$D/keys" --private-key "0x$(printf '%s' "$G" | tr a-f A-F)" >/dev/null 2>&1 || bad "could not make a test keystore"
chmod 600 "$D/keys/regulator.json"
set_foundry_cwd "$D"
UPPER_L=$(printf '%s' "$L" | tr a-f A-F)
cat >"$T/env" <<X
# comment
OTHER=1
export AGENT_PRIVATE_KEY_FINAL=0x$A
LENDER_PRIVATE_KEY_FINAL="$UPPER_L"
ORACLE_PRIVATE_KEY_FINAL='0x$O'
X
printf 'RELAYER_PRIVATE_KEY_FINAL=%s\r\n' "$RL" >>"$T/env"
# Caller's environment already exports a key name and an RK_ name: neither may reach the reader.
export AGENT_PRIVATE_KEY_FINAL=0xdeadbeef RK_LENDER_PRIVATE_KEY_FINAL=stale RK_REGULATOR_PRIVATE_KEY_FISCO=stale
for name in $ALL_KEY_NAMES; do unset "RK_$name"; done
( key_lines >/dev/null ) && bad "key_lines with no keys read: succeeded" || ok "key_lines fails while a key is missing"
HOGEE_ENV_FILE="$T/env" read_role_keys
( key_lines >/dev/null ) && bad "key_lines without the regulator key: succeeded" || ok "key_lines fails without the regulator key"
ERR=$(read_regulator_key "$D" 2>&1 >/dev/null) || bad "read_regulator_key failed: $ERR"
read_regulator_key "$D" 2>/dev/null
compgen -e | grep -q '^RK_' && bad "an RK_ variable is exported" || ok "RK_ variables not exported"
# The reader: a child shell that prints fd 3, its own env and argv; the key values must appear only on fd 3.
OUT=$( ( scrub_env HOME; exec /bin/sh -c 'echo ARGV "$0" "$@"; echo ENV; /usr/bin/env; echo FD3; /bin/cat <&3' reader --keys-fd 3 3< <(key_lines) ) )
FD3=$(printf '%s\n' "$OUT" | sed -n '/^FD3$/,$p' | sed 1d)
WANT=$(printf 'AGENT_PRIVATE_KEY_FINAL=0x%s\nLENDER_PRIVATE_KEY_FINAL=0x%s\nORACLE_PRIVATE_KEY_FINAL=0x%s\nRELAYER_PRIVATE_KEY_FINAL=0x%s\nREGULATOR_PRIVATE_KEY_FISCO=0x%s' "$A" "$L" "$O" "$RL" "$G")
[ "$FD3" = "$WANT" ] && ok "fd 3: five NAME=0x<lower hex> lines in order (0x added, upper case lowered, quotes/export/CR handled; the 5th decrypted from the keystore)" || { bad "fd 3 content"; printf '%s\n' "$FD3" | sed 's/=.*/=<redacted>/'; }
BYTES=$( ( exec /bin/cat <&3 | /usr/bin/wc -c ) 3< <(key_lines) )
LAST=$( ( exec /bin/cat <&3 | /usr/bin/tail -c 1 | /usr/bin/od -An -c ) 3< <(key_lines) )
# 23+24+24+25+27 name bytes + 5 x ("=" + 66 + LF) = 463
[ "$(printf '%s' "$BYTES" | tr -d ' ')" = 463 ] && [ "$(printf '%s' "$LAST" | tr -d ' ')" = '\n' ] &&
  ok "fd 3: 463 bytes, LF after the last line too" || bad "fd 3 bytes $BYTES last '$LAST'"
ENVPART=$(printf '%s\n' "$OUT" | sed -n '/^ENV$/,/^FD3$/p')
leak=0; for k in "$A" "$L" "$O" "$RL" "$UPPER_L" "$G"; do case "$OUT" in *"$k"*) ;; esac; case "$ENVPART$(printf '%s\n' "$OUT" | grep '^ARGV')" in *"$k"*) leak=1 ;; esac; done
[ "$leak" = 0 ] && ok "no key in the reader's argv or environment" || bad "key in argv/env"
printf '%s\n' "$ENVPART" | grep -q 'PRIVATE_KEY' && bad "a key name is in the reader's env" || ok "no *_PRIVATE_KEY_* name in the reader's env"
# Fail closed: missing, duplicate, malformed.
grep -v RELAYER "$T/env" >"$T/env-missing"; ( HOGEE_ENV_FILE="$T/env-missing" read_role_keys ) 2>"$T/err" && bad "missing key accepted" || { grep -q 'RELAYER_PRIVATE_KEY_FINAL is missing' "$T/err" && ok "missing key refused (names the variable)" || bad "missing msg"; }
{ cat "$T/env"; echo "ORACLE_PRIVATE_KEY_FINAL=0x$O"; } >"$T/env-dup"; ( HOGEE_ENV_FILE="$T/env-dup" read_role_keys ) 2>"$T/err" && bad "duplicate accepted" || ok "duplicate refused"
sed 's/^ORACLE_PRIVATE_KEY_FINAL=.*/ORACLE_PRIVATE_KEY_FINAL=0x1234/' "$T/env" >"$T/env-short"; ( HOGEE_ENV_FILE="$T/env-short" read_role_keys ) 2>"$T/err" && bad "short key accepted" || ok "short key refused"
grep -q "$O" "$T/err" && bad "error text contains a key" || ok "errors never contain a value"
# The regulator keystore: fail closed on a wrong password, a link or a missing file; never print the key.
cp "$D/keys/pw" "$T/pw.good"; chmod 600 "$D/keys/pw"; /usr/bin/openssl rand -hex 32 >"$D/keys/pw"
( read_regulator_key "$D" ) >"$T/out" 2>"$T/err" && bad "wrong keystore password accepted" || ok "regulator keystore: wrong password refused"
cat "$T/pw.good" >"$D/keys/pw"
grep -qi "$G" "$T/out" "$T/err" && bad "the regulator key was printed" || ok "regulator keystore: the key is never printed on failure"
mv "$D/keys/regulator.json" "$T/ks.json"; ln -s "$T/ks.json" "$D/keys/regulator.json"
( read_regulator_key "$D" ) >/dev/null 2>&1 && bad "keystore symlink accepted" || ok "regulator keystore: a symlink is refused"
rm "$D/keys/regulator.json"
( read_regulator_key "$D" ) >/dev/null 2>&1 && bad "missing keystore accepted" || ok "regulator keystore: a missing file is refused"
mv "$T/ks.json" "$D/keys/regulator.json"
ln -s "$T/pw.good" "$T/pw-link"; mv "$D/keys/pw" "$T/pw.real"; ln -s "$T/pw-link" "$D/keys/pw"
( read_regulator_key "$D" ) >/dev/null 2>&1 && bad "pw symlink accepted" || ok "regulator keystore: a linked password file is refused"
rm "$D/keys/pw"; mv "$T/pw.real" "$D/keys/pw"
[ -z "$(ls -A "$D/cwd")" ] && ok "regulator keystore: decrypted from the empty D/cwd, nothing left there" || bad "D/cwd not empty"
# Wiring: decrypted in a foundry_env subshell, password in that subshell only; keystore checked against the facts;
# the replay gets the sdk snapshot for native TLS and node4's Web3 for the ledger.
RS="$R/replay.sh"
grep -q 'exec "$CAST" wallet decrypt-keystore --keystore-dir "$d/keys" regulator.json' "$RS" &&
  ok "replay.sh: cast wallet decrypt-keystore of D/keys/regulator.json" || bad "decrypt wiring"
! grep -qE 'export[^#]*RK_|declare -x' "$RS" && ok "replay.sh: no RK_ variable is ever exported" || bad "an RK_ export in replay.sh"
[ "$(grep -n '^read_regulator_key "$D"$' "$RS" | cut -d: -f1)" -gt "$(grep -n '^read_role_keys$' "$RS" | cut -d: -f1)" ] 2>/dev/null &&
  ok "replay.sh: the regulator key is read after the four FINAL keys" || bad "read_regulator_key call"
grep -qF -- '--native-tls "$D/facts/sdk" --ledger-rpc "$FISCO_LEDGER_RPC"' "$RS" &&
  ok "replay.sh: --native-tls D/facts/sdk --ledger-rpc http://127.0.0.1:8546" || bad "replay flags"
grep -q 'keystore_address "$D" regulator.json' "$RS" && grep -q 'regulator_fact_problems "$D"' "$RS" &&
  ok "replay.sh: keystore address checked against facts/regulator.address" || bad "replay regulator check"
# replay.sh refuses a *_PRIVATE_KEY* variable in its own environment before anything else (no args: usage, exit 2).
V=$(hex)
OUT=$(/usr/bin/env -i PATH=/usr/bin:/bin HOME="$HOME" /bin/bash "$R/replay.sh" 2>&1); RC=$?
[ "$RC" = 2 ] && ok "replay.sh: clean environment reaches the usage (exit 2)" || bad "replay.sh clean env: exit $RC"
for n in AGENT_PRIVATE_KEY_FINAL DEPLOYER_PRIVATE_KEY Some_private_key_x; do
  OUT=$(/usr/bin/env -i PATH=/usr/bin:/bin HOME="$HOME" "$n=0x$V" /bin/bash "$R/replay.sh" --dir /nonexistent 2>&1); RC=$?
  if [ "$RC" = 1 ] && [[ "$OUT" == *"FAIL: $n is set in the environment"* ]] && [[ "$OUT" != *"$V"* ]]; then
    ok "replay.sh: $n in its environment refused first (names it, never the value)"
  else bad "replay.sh: $n in env: exit $RC"; fi
done
grep -q 'exec "$NODE" --disable-sigusr1 ' "$R/replay.sh" && ok "replay.sh: node runs with --disable-sigusr1" || bad "no --disable-sigusr1"
echo "key tests: $P passed, $F failed"
[ "$F" = 0 ]
)

lib_tests || TOTAL_F=$((TOTAL_F + 1))
CHECK=$(check_tests 2>&1) || TOTAL_F=$((TOTAL_F + 1))
printf '%s\n' "$CHECK" | sed 's/^/  chain-check on the fake dir: /'
# Expected chain-check lines on the fake dir (no processes run, so "not running" is expected throughout).
for want in "FAIL node1: started with node.sb NODES_DIR=D, want NODES_DIR=D/nodes" \
  "FAIL node.sb changed since the nodes started (or no D/run/node.sb.sha256)" "  D/nodes/127.0.0.1/node0/evil" \
  "PASS start records: every node under node.sb (same digest) with NODES_DIR=D/nodes, as chain-up.sh starts them"; do
  printf '%s\n' "$CHECK" | grep -qxF -- "$want" && echo "ok   chain-check: $want" || { echo "FAIL missing: $want"; TOTAL_F=$((TOTAL_F + 1)); }
done
key_tests || TOTAL_F=$((TOTAL_F + 1))
reg_tests || TOTAL_F=$((TOTAL_F + 1))
if [ "$TOTAL_F" = 0 ]; then echo "fake-dir: PASS"; else echo "fake-dir: FAIL ($TOTAL_F)"; exit 1; fi
