#!/bin/bash
# Start Familiar gateway with env vars from config/.env
# All paths are resolved relative to $HOME — no hardcoded user paths.

FAMILIAR_HOME="${FAMILIAR_HOME:-$HOME/.familiar}"
ENV_FILE="${FAMILIAR_HOME}/config/.env"

if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

# Resolve the script directory to find gateway.mjs
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${SCRIPT_DIR%/services}"

# Resolve bun binary dynamically
BUN_BIN="$(which bun 2>/dev/null || echo "")"
if [ -z "$BUN_BIN" ]; then
  for candidate in /opt/homebrew/bin/bun /usr/local/bin/bun "$HOME/.bun/bin/bun"; do
    [ -x "$candidate" ] && BUN_BIN="$candidate" && break
  done
fi
if [ -z "$BUN_BIN" ]; then
  echo "ERROR: bun not found" >&2
  exit 1
fi

# Keep machine awake while gateway is running (prevents sleep with lid closed)
# -i = prevent idle sleep, -s = prevent system sleep
"$BUN_BIN" "$PROJECT_DIR/services/gateway.mjs" &
GATEWAY_PID=$!
/usr/bin/caffeinate -is -w $GATEWAY_PID &

# Forward signals to the gateway so launchd restarts work cleanly
trap "kill $GATEWAY_PID 2>/dev/null; exit" SIGTERM SIGINT SIGHUP
wait $GATEWAY_PID
