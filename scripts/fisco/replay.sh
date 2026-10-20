#!/bin/bash
# replay.sh: run the final-2 replay (scripts/redteam src/fisco/cli.ts, straight with node, no pnpm) against the local
# FISCO mirror chain. The four FINAL role keys are read line by line from the file named by HOGEE_ENV_FILE; nothing
# else from that file is read. The fifth, the regulator's (local to this chain), is decrypted from D/keys/regulator.json
# by cast in a scrubbed subshell. All five go to the replay on file descriptor 3 (--keys-fd 3), from a pipe written by
# the shell's own printf: never in any process's environment or argv, never printed, never `source`d, never traced.
# node runs with --disable-sigusr1, so another process of the same user cannot open its inspector with SIGUSR1.
set -euo pipefail
set +x
ulimit -c 0
# Before anything else: no *_PRIVATE_KEY* variable (any letter case) in this script's own environment. The keys come
# only from HOGEE_ENV_FILE; one already exported would reach every child. The message names the variable only.
for _v in $(compgen -e); do
  case "$(printf '%s' "$_v" | tr '[:lower:]' '[:upper:]')" in
    *_PRIVATE_KEY*)
      printf 'FAIL: %s is set in the environment; unset it (replay.sh reads the role keys from HOGEE_ENV_FILE only)\n' \
        "$_v" >&2
      exit 1
      ;;
  esac
done
unset _v
# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/lib.sh"
# shellcheck source=chain-lib.sh
. "$FISCO_SCRIPT_DIR/chain-lib.sh"

usage() {
  cat <<'EOF'
Usage: HOGEE_ENV_FILE=<path> replay.sh --dir D --repo <worktree> --sepolia-code <dir> [-- <extra replay args>]
  --dir D           chain dir with D/deploy from deploy.sh (chain-check.sh must pass)
  --repo            repo checkout with scripts/redteam (fisco:replay), contracts/out and the final-2 bundle
  --sepolia-code    folder written by `pnpm --filter @hogee/redteam fisco:sepolia-code` (the code-sepolia/ capture)
  HOGEE_ENV_FILE    file holding AGENT_PRIVATE_KEY_FINAL, LENDER_PRIVATE_KEY_FINAL, ORACLE_PRIVATE_KEY_FINAL and
                    RELAYER_PRIVATE_KEY_FINAL as NAME=value lines (only these four are read)
The fifth key line, REGULATOR_PRIVATE_KEY_FISCO, is decrypted from D/keys/regulator.json (password D/keys/pw), whose
address must equal D/facts/regulator.address and the genesis auth admin.
<repo> must be the checkout this script is in (the keys go only to that code). The replay reads D/deploy (written
by deploy.sh), D/facts/config.genesis (chain-up.sh's snapshot) and D/facts/sdk (the native RPC's TLS files, for
https://127.0.0.1:20200), which no sandbox can write, and node4's Web3 at http://127.0.0.1:8546 (the regulator's
ledger). The pack is written under <repo>/evidence/fisco; check it with `make verify-fisco PACK=<pack dir>`.
EOF
}

KEY_NAMES="AGENT_PRIVATE_KEY_FINAL LENDER_PRIVATE_KEY_FINAL ORACLE_PRIVATE_KEY_FINAL RELAYER_PRIVATE_KEY_FINAL"
REGULATOR_KEY_NAME="REGULATOR_PRIVATE_KEY_FISCO"
ALL_KEY_NAMES="$KEY_NAMES $REGULATOR_KEY_NAME"
SEPOLIA_BUNDLE_ID="ev-74756ea61a72ae7c"

D_RAW=""
REPO_RAW=""
SEPOLIA_CODE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) D_RAW="${2:?--dir needs a path}"; shift 2 ;;
    --repo) REPO_RAW="${2:?--repo needs a path}"; shift 2 ;;
    --sepolia-code) SEPOLIA_CODE="${2:?--sepolia-code needs a path}"; shift 2 ;;
    --) shift; break ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument $1" ;;
  esac
done
[ -n "$D_RAW" ] && [ -n "$REPO_RAW" ] && [ -n "$SEPOLIA_CODE" ] || { usage >&2; exit 2; }
refuse_root
need_exec "$CAST" "$JQ" "$CURL"
D=$(resolve_chain_dir "$D_RAW")
require_marker "$D"
[ -d "$REPO_RAW" ] || die "no such repo folder: $REPO_RAW"
REPO=$(real_dir "$REPO_RAW")
[ "$REPO" = "$FISCO_REPO_DIR" ] || die "--repo must be this script's checkout ($FISCO_REPO_DIR)"
[ -d "$SEPOLIA_CODE" ] || die "no such folder: $SEPOLIA_CODE"
SEPOLIA_CODE=$(cd -- "$SEPOLIA_CODE" && pwd -P)
[ -d "$D/deploy" ] && [ ! -L "$D/deploy" ] && [ -O "$D/deploy" ] || die "missing $D/deploy (run deploy.sh)"
MANIFEST="$D/deploy/fisco-final-2.json"
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || die "missing $MANIFEST (run deploy.sh)"
RUN=""
for f in "$D/deploy"/run-[0-9]*.json; do
  [ -f "$f" ] || continue
  [ ! -L "$f" ] || die "$f is a symlink"
  [ -z "$RUN" ] || die "more than one broadcast run file in $D/deploy"
  RUN="$f"
done
[ -n "$RUN" ] || die "no broadcast run file in $D/deploy (run deploy.sh)"
BUNDLE="$REPO/evidence/$SEPOLIA_BUNDLE_ID"
[ -d "$BUNDLE" ] || die "missing the Sepolia bundle $BUNDLE"
[ -d "$REPO/contracts/out" ] || die "missing $REPO/contracts/out (deploy.sh builds it)"
REDTEAM="$REPO/scripts/redteam"
[ -f "$REDTEAM/src/fisco/cli.ts" ] || die "missing scripts/redteam/src/fisco/cli.ts in $REPO"
[ -d "$REDTEAM/node_modules/tsx" ] || die "missing tsx in scripts/redteam (pnpm install --frozen-lockfile --offline)"
GENESIS="$D/facts/config.genesis"
[ -f "$GENESIS" ] && [ ! -L "$GENESIS" ] || die "missing $GENESIS (chain-up.sh snapshots node0's genesis there)"
NODE=$(command -v node) || die "node not found"
TOOL_PATH="$(dirname -- "$NODE"):/usr/bin:/bin" # resolved before scrub_env empties PATH

# The regulator: D/facts as chain-up.sh left them, auth checks on in the genesis snapshot, its admin the regulator,
# and D/keys/regulator.json that very account (cast reads the address with the password file; no key in argv).
FACT_PROBLEMS=$(regulator_fact_problems "$D")
[ -z "$FACT_PROBLEMS" ] || die "regulator facts: $(printf '%s' "$FACT_PROBLEMS" | tr '\n' ';')"
REG_ADDR=$(cat -- "$D/facts/regulator.address")
[ "$(ini_get "$GENESIS" executor is_auth_check)" = true ] || die "the genesis snapshot has auth checks off"
[ "$(ini_get "$GENESIS" executor auth_admin_account | tr 'A-F' 'a-f')" = "$REG_ADDR" ] ||
  die "the genesis auth admin is not D/facts/regulator.address"
owned_file "$D/keys/regulator.json" && owned_file "$D/keys/pw" ||
  die "D/keys/regulator.json and D/keys/pw must be regular files owned by $(id -un)"
set_foundry_cwd "$D"
[ "$(keystore_address "$D" regulator.json | tr 'A-F' 'a-f')" = "$REG_ADDR" ] ||
  die "D/keys/regulator.json is not the regulator in D/facts/regulator.address"

"$FISCO_SCRIPT_DIR/chain-check.sh" --dir "$D" || die "chain-check.sh failed"

# The five role keys: exact names, one value each, 32-byte hex, normalised to 0x + lower case. They are kept in
# RK_<name>, plain shell variables that are never exported (unset first, in case the caller's environment had them);
# the key names themselves are never assigned. Errors name the variable, never the value.
for name in $ALL_KEY_NAMES; do unset "RK_$name"; done
read_role_keys() {
  local f="${HOGEE_ENV_FILE:-}" line name value seen=" "
  [ -n "$f" ] || die "HOGEE_ENV_FILE is not set"
  [ -f "$f" ] && [ -r "$f" ] || die "HOGEE_ENV_FILE does not name a readable file"
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line#export }"
    name="${line%%=*}"
    case " $KEY_NAMES " in *" $name "*) ;; *) continue ;; esac
    [ "$name" != "$line" ] || continue
    case "$seen" in *" $name "*) die "$name appears more than once" ;; esac
    value="${line#*=}"
    value="${value%"${value##*[![:space:]]}"}"
    case "$value" in \"*\") value="${value#\"}"; value="${value%\"}" ;; \'*\') value="${value#\'}"; value="${value%\'}" ;; esac
    [[ "$value" =~ ^(0x)?[0-9a-fA-F]{64}$ ]] || die "$name is not a 32-byte hex key"
    value="${value#0x}"
    value="${value//A/a}"; value="${value//B/b}"; value="${value//C/c}"
    value="${value//D/d}"; value="${value//E/e}"; value="${value//F/f}"
    printf -v "RK_$name" '0x%s' "$value"
    seen="$seen$name "
  done <"$f"
  for name in $KEY_NAMES; do
    case "$seen" in *" $name "*) ;; *) die "$name is missing" ;; esac
  done
}

# The regulator's key, from D/keys/regulator.json: cast wallet decrypt-keystore in a foundry_env subshell (scrubbed
# environment, dead proxy) run from the empty D/cwd. The password reaches cast as CAST_UNSAFE_PASSWORD in that
# subshell only; the key comes back on cast's stdout into a plain shell variable, is checked and lowered with
# builtins, and is never printed: on any failure the message names the file, never cast's output.
read_regulator_key() {
  local d="$1" out key re
  [ -n "${FOUNDRY_CWD:-}" ] || die "read_regulator_key: set_foundry_cwd first"
  owned_file "$d/keys/regulator.json" && owned_file "$d/keys/pw" ||
    die "$d/keys/regulator.json and $d/keys/pw must be regular files owned by $(id -un)"
  out=$(
    cd -- "$FOUNDRY_CWD" || exit 1
    foundry_env
    CAST_UNSAFE_PASSWORD="$(cat -- "$d/keys/pw")"
    export CAST_UNSAFE_PASSWORD
    exec "$CAST" wallet decrypt-keystore --keystore-dir "$d/keys" regulator.json </dev/null 2>/dev/null
  ) || die "could not decrypt $d/keys/regulator.json with $d/keys/pw"
  re="^regulator\.json's private key is: (0x[0-9a-fA-F]{64})$"
  [[ "$out" =~ $re ]] || die "cast wallet decrypt-keystore gave an unexpected answer (not printed)"
  key="${BASH_REMATCH[1]#0x}"
  out=""
  key="${key//A/a}"; key="${key//B/b}"; key="${key//C/c}"
  key="${key//D/d}"; key="${key//E/e}"; key="${key//F/f}"
  printf -v "RK_$REGULATOR_KEY_NAME" '0x%s' "$key"
}

# The fd 3 payload: exactly five lines NAME=0x<64 lower-case hex> (the four FINAL keys, then the regulator's), each
# ending in a newline. Builtins only (printf runs inside the shell), so no key reaches an argv. Fails while any key is
# missing.
key_lines() {
  local name var
  for name in $ALL_KEY_NAMES; do
    var="RK_$name"
    [[ "${!var:-}" =~ ^0x[0-9a-f]{64}$ ]] || return 1
  done
  for name in $ALL_KEY_NAMES; do
    var="RK_$name"
    printf '%s=%s\n' "$name" "${!var}"
  done
}

read_role_keys
read_regulator_key "$D"
unset HOGEE_ENV_FILE
key_lines >/dev/null || die "a role key is missing"

info "replaying final-2 on $FISCO_RPC, regulator $REG_ADDR, ledger $FISCO_LEDGER_RPC (pack under $REPO/evidence/fisco)"
(
  cd -- "$REDTEAM"
  scrub_env HOME USER LOGNAME TMPDIR LANG TERM
  export PATH="$TOOL_PATH"
  exec "$NODE" --disable-sigusr1 --import tsx src/fisco/cli.ts --keys-fd 3 --rpc "$FISCO_RPC" --deployment "$MANIFEST" --broadcast "$RUN" \
    --sepolia-bundle "$BUNDLE" --sepolia-code "$SEPOLIA_CODE" --artifacts "$REPO/contracts/out" --genesis "$GENESIS" \
    --native-tls "$D/facts/sdk" --ledger-rpc "$FISCO_LEDGER_RPC" --out "$REPO/evidence/fisco" "$@" 3< <(key_lines)
)
