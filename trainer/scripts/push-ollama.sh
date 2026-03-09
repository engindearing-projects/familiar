#!/usr/bin/env bash
set -euo pipefail

# The Forge — Push Model to Ollama Hub
# Rsyncs GGUF to remote PC (1Gbps upload) and pushes to Ollama Hub.
#
# Prerequisites (one-time):
#   SSH to remote PC and run: ollama login
#
# Usage:
#   bash scripts/push-ollama.sh v33                    # push version v33
#   bash scripts/push-ollama.sh v33 --namespace foo    # custom namespace
#   bash scripts/push-ollama.sh v33 --skip-sync        # GGUF already on remote

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TRAINER_DIR="$(dirname "$SCRIPT_DIR")"

# Remote server config (same as sync-remote.sh)
REMOTE_USER="${FORGE_REMOTE_USER:-${USER:-user}}"
REMOTE_HOST="${FORGE_REMOTE_HOST:-${WORKER_HOST:-localhost}}"
REMOTE_DIR="${FORGE_REMOTE_DIR:-~/familiar/trainer}"
SSH_KEY="${FORGE_SSH_KEY:-$HOME/.ssh/id_ed25519_github_personal}"
SSH_OPTS="-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -i $SSH_KEY"
RSYNC_OPTS="--rsync-path=/usr/bin/rsync"

REMOTE="$REMOTE_USER@$REMOTE_HOST"

# Model config
NAMESPACE="${OLLAMA_NAMESPACE:-familiar-run}"
MODEL_NAME="familiar-brain"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
NC='\033[0m'

# Parse args
VERSION="${1:-}"
SKIP_SYNC=false

if [ -z "$VERSION" ]; then
    echo "Usage: bash scripts/push-ollama.sh <version> [--namespace <ns>] [--skip-sync]"
    echo ""
    echo "Example: bash scripts/push-ollama.sh v33"
    exit 1
fi

shift
while [[ $# -gt 0 ]]; do
    case "$1" in
        --namespace) NAMESPACE="$2"; shift 2 ;;
        --skip-sync) SKIP_SYNC=true; shift ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

GGUF_FILE="familiar-brain-${VERSION}-Q4_K_M.gguf"
LOCAL_GGUF="$TRAINER_DIR/models/gguf/$GGUF_FILE"
REMOTE_GGUF="$REMOTE_DIR/models/gguf/$GGUF_FILE"
FULL_TAG="$NAMESPACE/$MODEL_NAME"

echo ""
echo -e "${CYAN}  The Forge — Ollama Hub Push${NC}"
echo ""
echo "  Version:   $VERSION"
echo "  GGUF:      $GGUF_FILE"
echo "  Namespace: $NAMESPACE"
echo "  Tags:      $FULL_TAG:$VERSION, $FULL_TAG:latest"
echo "  Remote:    $REMOTE"
echo ""

# Step 1: Sync GGUF to remote
if [ "$SKIP_SYNC" = false ]; then
    if [ ! -f "$LOCAL_GGUF" ]; then
        echo -e "${RED}  GGUF not found: $LOCAL_GGUF${NC}"
        echo "  Run the training pipeline first, or check the path."
        exit 1
    fi

    echo -e "${CYAN}[1/4] Syncing GGUF to remote...${NC}"
    rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
        "$LOCAL_GGUF" \
        "$REMOTE:$REMOTE_DIR/models/gguf/"
    echo -e "${GREEN}  Synced.${NC}"
else
    echo -e "${YELLOW}[1/4] Skipping sync (--skip-sync)${NC}"
fi

# Step 2: Create Modelfile on remote
echo -e "${CYAN}[2/4] Creating Ollama model on remote...${NC}"

# Read system prompt from domain config
SYSTEM_PROMPT=$(python3 -c "
import json, sys
with open('$TRAINER_DIR/domains/brain.json') as f:
    d = json.load(f)
print(d.get('deploy_system_prompt', d.get('system_prompt', '')))
" 2>/dev/null || echo "You are Familiar, a persistent AI assistant from familiar.run.")

# Read ollama params from domain config
read TEMP TOP_P NUM_CTX <<< $(python3 -c "
import json
with open('$TRAINER_DIR/domains/brain.json') as f:
    d = json.load(f)
o = d.get('ollama', {})
print(o.get('temperature', 0.6), o.get('top_p', 0.9), o.get('num_ctx', 8192))
" 2>/dev/null || echo "0.6 0.9 8192")

ssh $SSH_OPTS "$REMOTE" bash -s <<REMOTE_SCRIPT
set -euo pipefail

GGUF_PATH="$REMOTE_DIR/models/gguf/$GGUF_FILE"
MODELFILE_PATH="$REMOTE_DIR/models/gguf/Modelfile-push-${VERSION}"

if [ ! -f "\$GGUF_PATH" ]; then
    echo "ERROR: GGUF not found on remote: \$GGUF_PATH"
    exit 1
fi

# Write Modelfile
cat > "\$MODELFILE_PATH" <<'MODELFILE'
FROM $REMOTE_DIR/models/gguf/$GGUF_FILE

SYSTEM "$SYSTEM_PROMPT"

PARAMETER temperature $TEMP
PARAMETER top_p $TOP_P
PARAMETER num_ctx $NUM_CTX
MODELFILE

echo "  Modelfile written to \$MODELFILE_PATH"

# Create model in Ollama
echo "  Creating model: $FULL_TAG:$VERSION"
ollama create "$FULL_TAG:$VERSION" -f "\$MODELFILE_PATH"

echo "  Tagging as: $FULL_TAG:latest"
ollama cp "$FULL_TAG:$VERSION" "$FULL_TAG:latest"
REMOTE_SCRIPT

echo -e "${GREEN}  Model created on remote.${NC}"

# Step 3: Push versioned tag
echo -e "${CYAN}[3/4] Pushing $FULL_TAG:$VERSION to Ollama Hub...${NC}"
ssh $SSH_OPTS "$REMOTE" "ollama push $FULL_TAG:$VERSION"
echo -e "${GREEN}  Pushed $FULL_TAG:$VERSION${NC}"

# Step 4: Push latest tag
echo -e "${CYAN}[4/4] Pushing $FULL_TAG:latest to Ollama Hub...${NC}"
ssh $SSH_OPTS "$REMOTE" "ollama push $FULL_TAG:latest"
echo -e "${GREEN}  Pushed $FULL_TAG:latest${NC}"

echo ""
echo -e "${GREEN}  Done. Anyone can now run:${NC}"
echo ""
echo "    ollama pull $FULL_TAG"
echo "    ollama run $FULL_TAG"
echo ""
