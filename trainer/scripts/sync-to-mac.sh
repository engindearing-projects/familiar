#!/usr/bin/env bash
set -euo pipefail

# The Forge — Sync collected data from Ubuntu miner back to Mac
# Runs on the Ubuntu box (via systemd timer or manually).
# Pushes raw training data, stats, and logs to the Mac over LAN.
#
# Usage:
#   bash scripts/sync-to-mac.sh              # sync everything
#   bash scripts/sync-to-mac.sh --dry-run    # preview what would sync

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TRAINER_DIR="$(dirname "$SCRIPT_DIR")"

# Mac config — edit these or set env vars
MAC_USER="${FORGE_MAC_USER:-grant}"
MAC_HOST="${FORGE_MAC_HOST:-localhost}"
MAC_DIR="${FORGE_MAC_DIR:-~/familiar/trainer}"
SSH_KEY="${FORGE_SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_OPTS="-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new"

if [ -n "$SSH_KEY" ] && [ -f "$SSH_KEY" ]; then
    SSH_OPTS="$SSH_OPTS -i $SSH_KEY"
fi

MAC="$MAC_USER@$MAC_HOST"
DRY_RUN=""
if [ "${1:-}" = "--dry-run" ]; then
    DRY_RUN="--dry-run"
    echo "[DRY RUN] Would sync the following:"
fi

TS=$(date +"%Y-%m-%d %H:%M:%S")
echo "[$TS] Syncing training data to $MAC..."

# Check Mac is reachable
if ! ssh $SSH_OPTS "$MAC" "echo ok" &>/dev/null; then
    echo "[$TS] ERROR: Cannot reach $MAC — skipping sync"
    exit 1
fi

# 1. Sync raw training data (the main payload)
echo "  Syncing raw data..."
rsync -avz $DRY_RUN --progress -e "ssh $SSH_OPTS" \
    "$TRAINER_DIR/data/raw/" \
    "$MAC:$MAC_DIR/data/raw/"

# 2. Sync autonomous state files (so Mac can see miner progress)
echo "  Syncing state files..."
for f in autonomous-repos.json autonomous-progress.json autonomous-stats.json; do
    if [ -f "$TRAINER_DIR/data/$f" ]; then
        rsync -avz $DRY_RUN -e "ssh $SSH_OPTS" \
            "$TRAINER_DIR/data/$f" \
            "$MAC:$MAC_DIR/data/"
    fi
done

# 3. Sync top-repos cache
if [ -f "$TRAINER_DIR/data/top-repos.json" ]; then
    rsync -avz $DRY_RUN -e "ssh $SSH_OPTS" \
        "$TRAINER_DIR/data/top-repos.json" \
        "$MAC:$MAC_DIR/data/"
fi

# 3b. Sync open-source datasets (may have been ingested on Ubuntu)
if [ -d "$TRAINER_DIR/data/open_source" ]; then
    echo "  Syncing open-source datasets..."
    rsync -avz $DRY_RUN -e "ssh $SSH_OPTS" \
        "$TRAINER_DIR/data/open_source/" \
        "$MAC:$MAC_DIR/data/open_source/"
fi

# 4. Sync logs (last 7 days only to save bandwidth)
echo "  Syncing recent logs..."
find "$TRAINER_DIR/logs/" -name "autonomous-*.log" -mtime -7 -print0 2>/dev/null | \
    xargs -0 -I{} rsync -avz $DRY_RUN -e "ssh $SSH_OPTS" {} "$MAC:$MAC_DIR/logs/"

# 5. Quick stats
RAW_COUNT=$(find "$TRAINER_DIR/data/raw" -name "*.jsonl" 2>/dev/null | wc -l)
RAW_SIZE=$(du -sh "$TRAINER_DIR/data/raw" 2>/dev/null | cut -f1)
TODAY_FILE="$TRAINER_DIR/data/raw/$(date +%Y-%m-%d)-auto.jsonl"
TODAY_PAIRS=0
if [ -f "$TODAY_FILE" ]; then
    TODAY_PAIRS=$(wc -l < "$TODAY_FILE")
fi

TS2=$(date +"%Y-%m-%d %H:%M:%S")
echo ""
echo "[$TS2] Sync complete."
echo "  Raw files: $RAW_COUNT ($RAW_SIZE)"
echo "  Today's auto pairs: $TODAY_PAIRS"
