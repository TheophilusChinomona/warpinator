#!/usr/bin/env bash
#
# warpinator launcher — one command to run the open-source, account-free Warp
# with its AI backed by the local warpinator bridge (Pi -> OpenRouter, BYO key).
#
# It: (1) ensures the bridge's npm deps are installed, (2) starts the bridge if
# it isn't already running, (3) launches warp-oss pointed at it. The bridge is
# stopped when warp exits (unless it was already running).
#
# Usage:
#   projects/warpinator/run.sh                 # build must already exist
#   BRIDGE_MODEL=anthropic/claude-haiku-4.5 projects/warpinator/run.sh
#   WARP_DATA_PROFILE=scratch projects/warpinator/run.sh   # isolated profile (debug builds)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BRIDGE_DIR="${REPO_ROOT}/projects/warpinator/bridge"
PORT="${WARPINATOR_BRIDGE_PORT:-8787}"
WARP_BIN="${WARP_BIN:-${REPO_ROOT}/target/debug/warp-oss}"
BRIDGE_LOG="${TMPDIR:-/tmp}/warpinator-bridge.log"

log() { printf '\033[36m[warpinator]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[warpinator] %s\033[0m\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "node is required (the bridge runs on Node)."
[ -x "$WARP_BIN" ] || die "warp-oss not built. Run: cargo build --bin warp-oss --features gui"

# 1. deps
if [ ! -d "${BRIDGE_DIR}/node_modules" ]; then
  log "installing bridge dependencies…"
  (cd "$BRIDGE_DIR" && npm install --no-fund --no-audit >/dev/null)
fi

# 2. bridge (start only if nothing is already serving the port)
STARTED_BRIDGE=0
if curl -s -o /dev/null -m 2 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null; then
  log "bridge already running on :${PORT}"
else
  log "starting bridge on :${PORT} (log: ${BRIDGE_LOG})"
  (cd "$BRIDGE_DIR" && WARPINATOR_BRIDGE_PORT="$PORT" node server.js >"$BRIDGE_LOG" 2>&1 &)
  STARTED_BRIDGE=1
  for _ in $(seq 1 20); do
    curl -s -o /dev/null -m 1 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null && break
    sleep 0.25
  done
fi

cleanup() {
  if [ "$STARTED_BRIDGE" = "1" ]; then
    log "stopping bridge"
    pid="$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)"
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# 3. warp, pointed at the bridge
export WARP_SERVER_ROOT_URL="http://127.0.0.1:${PORT}"
export WARP_WS_SERVER_URL="ws://127.0.0.1:${PORT}/graphql/v2"
log "launching warp-oss → ${WARP_SERVER_ROOT_URL} (model: ${BRIDGE_MODEL:-openrouter/owl-alpha})"
"$WARP_BIN" "$@"
