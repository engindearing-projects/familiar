#!/usr/bin/env bash
set -euo pipefail

# The Forge — Push Model to HuggingFace
# Uploads GGUF + model card to HuggingFace via the remote PC (1Gbps upload).
#
# Prerequisites (one-time on remote PC):
#   pip3 install --user --break-system-packages huggingface-hub
#   ~/.local/bin/hf auth login
#
# Usage:
#   bash scripts/push-huggingface.sh v33
#   bash scripts/push-huggingface.sh v33 --namespace familiar-run
#   bash scripts/push-huggingface.sh v33 --skip-sync

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TRAINER_DIR="$(dirname "$SCRIPT_DIR")"

# Remote server config
REMOTE_USER="${FORGE_REMOTE_USER:-${USER:-user}}"
REMOTE_HOST="${FORGE_REMOTE_HOST:-${WORKER_HOST:-localhost}}"
REMOTE_DIR="${FORGE_REMOTE_DIR:-~/familiar/trainer}"
SSH_KEY="${FORGE_SSH_KEY:-$HOME/.ssh/id_ed25519_github_personal}"
SSH_OPTS="-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -i $SSH_KEY"
RSYNC_OPTS="--rsync-path=/usr/bin/rsync"

REMOTE="$REMOTE_USER@$REMOTE_HOST"

# HuggingFace config
NAMESPACE="${HF_NAMESPACE:-familiar-run}"
REPO_NAME="familiar-brain-GGUF"

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
    echo "Usage: bash scripts/push-huggingface.sh <version> [--namespace <ns>] [--skip-sync]"
    echo ""
    echo "Example: bash scripts/push-huggingface.sh v33"
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
HF_REPO="$NAMESPACE/$REPO_NAME"

echo ""
echo -e "${CYAN}  The Forge — HuggingFace Push${NC}"
echo ""
echo "  Version:   $VERSION"
echo "  GGUF:      $GGUF_FILE"
echo "  Repo:      $HF_REPO"
echo "  Remote:    $REMOTE"
echo ""

# Step 1: Generate model card locally
echo -e "${CYAN}[1/4] Generating model card...${NC}"
CARD_PATH="/tmp/familiar-model-card-${VERSION}.md"
python3 "$SCRIPT_DIR/generate-model-card.py" "$VERSION" --output "$CARD_PATH"
echo -e "${GREEN}  Model card generated.${NC}"

# Step 2: Sync GGUF + model card to remote
if [ "$SKIP_SYNC" = false ]; then
    if [ ! -f "$LOCAL_GGUF" ]; then
        echo -e "${RED}  GGUF not found: $LOCAL_GGUF${NC}"
        exit 1
    fi

    echo -e "${CYAN}[2/4] Syncing GGUF to remote...${NC}"
    rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
        "$LOCAL_GGUF" \
        "$REMOTE:$REMOTE_DIR/models/gguf/"
    echo -e "${GREEN}  GGUF synced.${NC}"
else
    echo -e "${YELLOW}[2/4] Skipping GGUF sync (--skip-sync)${NC}"
fi

# Sync model card to remote
echo "  Syncing model card..."
rsync -avz $RSYNC_OPTS -e "ssh $SSH_OPTS" \
    "$CARD_PATH" \
    "$REMOTE:/tmp/README.md"

# Step 3: Create repo if needed
echo -e "${CYAN}[3/4] Ensuring HuggingFace repo exists...${NC}"
ssh $SSH_OPTS "$REMOTE" bash -s <<REMOTE_SCRIPT
set -euo pipefail

# Create repo (no-op if exists)
~/.local/bin/hf repos create "$NAMESPACE/$REPO_NAME" --type model 2>/dev/null || true
echo "  Repo ready: $HF_REPO"
REMOTE_SCRIPT

# Step 4: Upload GGUF + README
echo -e "${CYAN}[4/4] Uploading to HuggingFace (this may take a while)...${NC}"
ssh $SSH_OPTS "$REMOTE" bash -s <<REMOTE_SCRIPT
set -euo pipefail

GGUF_PATH="$REMOTE_DIR/models/gguf/$GGUF_FILE"

if [ ! -f "\$GGUF_PATH" ]; then
    echo "ERROR: GGUF not found on remote: \$GGUF_PATH"
    exit 1
fi

# Upload GGUF
echo "  Uploading $GGUF_FILE..."
~/.local/bin/hf upload "$HF_REPO" "\$GGUF_PATH" "$GGUF_FILE" --commit-message "Add $GGUF_FILE" --repo-type model

# Upload README
echo "  Uploading README.md..."
~/.local/bin/hf upload "$HF_REPO" "/tmp/README.md" "README.md" --commit-message "Update model card for $VERSION" --repo-type model

echo "  Upload complete."
REMOTE_SCRIPT

echo ""
echo -e "${GREEN}  Done. Model available at:${NC}"
echo ""
echo "    https://huggingface.co/$HF_REPO"
echo ""
