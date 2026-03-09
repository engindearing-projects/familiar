#!/bin/bash
set -euo pipefail

# Start the Claude Code Proxy server
# This runs on the HOST (not in Docker) so it can access
# the local `claude` CLI and subscription credentials.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

export CLAUDE_PROXY_PORT="${CLAUDE_PROXY_PORT:-18791}"
export CLAUDE_PROXY_MODEL="${CLAUDE_PROXY_MODEL:-opus}"

# Check for claude CLI
if ! command -v claude &>/dev/null; then
  echo "Error: claude CLI not found on PATH"
  echo ""
  echo "Install it with:"
  echo "  npm install -g @anthropic-ai/claude-code"
  echo ""
  echo "Then authenticate:"
  echo "  claude auth"
  exit 1
fi

echo "Starting Claude Code Proxy..."
echo "  Port:  $CLAUDE_PROXY_PORT"
echo "  Model: $CLAUDE_PROXY_MODEL"
echo ""

# Use env -u to strip CLAUDECODE in case this is launched from inside a Claude Code session
exec env -u CLAUDECODE -u CLAUDE_CODE_ENTRY -u CLAUDE_CODE_SESSION node "$SCRIPT_DIR/claude-code-proxy.mjs"
