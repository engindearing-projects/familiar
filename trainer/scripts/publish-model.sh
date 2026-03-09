#!/usr/bin/env bash
set -euo pipefail

# The Forge — Publish Model to All Channels
# Orchestrates pushing a trained model to Ollama Hub, HuggingFace, and the hosted API.
#
# Usage:
#   bash scripts/publish-model.sh v33              # all 3 channels
#   bash scripts/publish-model.sh v33 --ollama     # just Ollama Hub
#   bash scripts/publish-model.sh v33 --hf         # just HuggingFace
#   bash scripts/publish-model.sh v33 --api        # restart API server only
#   bash scripts/publish-model.sh v33 --skip-sync  # GGUF already on remote

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TRAINER_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

# Parse args
VERSION="${1:-}"

if [ -z "$VERSION" ]; then
    echo ""
    echo "  The Forge — Model Publisher"
    echo ""
    echo "  Usage: bash scripts/publish-model.sh <version> [flags]"
    echo ""
    echo "  Flags:"
    echo "    --ollama      Push to Ollama Hub only"
    echo "    --hf          Push to HuggingFace only"
    echo "    --api         Restart the hosted API service only"
    echo "    --skip-sync   Skip rsync to remote (GGUF already there)"
    echo ""
    echo "  Examples:"
    echo "    bash scripts/publish-model.sh v33"
    echo "    bash scripts/publish-model.sh v33 --ollama --hf"
    echo ""
    exit 1
fi

shift

DO_OLLAMA=false
DO_HF=false
DO_API=false
SKIP_SYNC=""
EXTRA_ARGS=()

# If no channel flags given, do all
CHANNEL_SPECIFIED=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --ollama) DO_OLLAMA=true; CHANNEL_SPECIFIED=true; shift ;;
        --hf)     DO_HF=true; CHANNEL_SPECIFIED=true; shift ;;
        --api)    DO_API=true; CHANNEL_SPECIFIED=true; shift ;;
        --skip-sync) SKIP_SYNC="--skip-sync"; shift ;;
        --namespace) EXTRA_ARGS+=("--namespace" "$2"); shift 2 ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

# Default: all channels
if [ "$CHANNEL_SPECIFIED" = false ]; then
    DO_OLLAMA=true
    DO_HF=true
    DO_API=true
fi

GGUF_FILE="familiar-brain-${VERSION}-Q4_K_M.gguf"
LOCAL_GGUF="$TRAINER_DIR/models/gguf/$GGUF_FILE"

echo ""
echo -e "${BOLD}  The Forge — Model Publisher${NC}"
echo ""
echo "  Version: $VERSION"
echo "  GGUF:    $GGUF_FILE"
echo "  Channels:"
[ "$DO_OLLAMA" = true ] && echo "    - Ollama Hub"
[ "$DO_HF" = true ]     && echo "    - HuggingFace"
[ "$DO_API" = true ]     && echo "    - Hosted API (api.familiar.run)"
echo ""

# Verify GGUF exists locally (unless skipping sync)
if [ -z "$SKIP_SYNC" ] && [ ! -f "$LOCAL_GGUF" ]; then
    echo -e "${RED}  GGUF not found: $LOCAL_GGUF${NC}"
    echo "  Run the training pipeline first."
    exit 1
fi

FAILED=()
SUCCEEDED=()

# ── Ollama Hub ────────────────────────────────────────────────────────────────

if [ "$DO_OLLAMA" = true ]; then
    echo -e "${CYAN}━━━ Ollama Hub ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    if bash "$SCRIPT_DIR/push-ollama.sh" "$VERSION" $SKIP_SYNC "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"; then
        SUCCEEDED+=("Ollama Hub")
    else
        echo -e "${RED}  Ollama Hub push failed.${NC}"
        FAILED+=("Ollama Hub")
    fi
    echo ""
fi

# ── HuggingFace ───────────────────────────────────────────────────────────────

if [ "$DO_HF" = true ]; then
    echo -e "${CYAN}━━━ HuggingFace ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    # If we already synced for Ollama, skip the HF sync
    HF_SKIP=""
    if [ "$DO_OLLAMA" = true ] || [ -n "$SKIP_SYNC" ]; then
        HF_SKIP="--skip-sync"
    fi
    if bash "$SCRIPT_DIR/push-huggingface.sh" "$VERSION" $HF_SKIP "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"; then
        SUCCEEDED+=("HuggingFace")
    else
        echo -e "${RED}  HuggingFace push failed.${NC}"
        FAILED+=("HuggingFace")
    fi
    echo ""
fi

# ── Hosted API ────────────────────────────────────────────────────────────────

if [ "$DO_API" = true ]; then
    echo -e "${CYAN}━━━ Hosted API ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo "  Restarting forge-serve service..."

    DOMAIN_TARGET="gui/$(id -u)"

    # Restart the serve service
    if launchctl kickstart -k "$DOMAIN_TARGET/com.familiar.forge-serve" 2>/dev/null; then
        echo -e "${GREEN}  API server restarted.${NC}"
        SUCCEEDED+=("Hosted API")
    else
        echo -e "${YELLOW}  Service not running. Attempting bootstrap...${NC}"
        PLIST="$HOME/Library/LaunchAgents/com.familiar.forge-serve.plist"
        if [ -f "$PLIST" ]; then
            launchctl bootstrap "$DOMAIN_TARGET" "$PLIST" 2>/dev/null || true
            echo -e "${GREEN}  API server started.${NC}"
            SUCCEEDED+=("Hosted API")
        else
            echo -e "${RED}  Plist not found. Run install-services.sh first.${NC}"
            FAILED+=("Hosted API")
        fi
    fi

    # Also restart the tunnel if it exists
    if launchctl kickstart -k "$DOMAIN_TARGET/com.familiar.model-tunnel" 2>/dev/null; then
        echo "  Tunnel restarted."
    fi
    echo ""
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo -e "${BOLD}━━━ Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [ ${#SUCCEEDED[@]} -gt 0 ]; then
    for s in "${SUCCEEDED[@]}"; do
        echo -e "  ${GREEN}✓${NC} $s"
    done
fi

if [ ${#FAILED[@]} -gt 0 ]; then
    for f in "${FAILED[@]}"; do
        echo -e "  ${RED}✗${NC} $f"
    done
    echo ""
    exit 1
fi

echo ""
echo -e "${GREEN}  All channels published successfully.${NC}"
echo ""
echo "  Verify:"
echo "    ollama pull familiar-run/familiar-brain"
echo "    curl https://api.familiar.run/health"
echo "    https://huggingface.co/familiar-run/familiar-brain-GGUF"
echo ""
