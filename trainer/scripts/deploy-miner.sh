#!/usr/bin/env bash
set -euo pipefail

# The Forge — Deploy Data Miner to Ubuntu Box
# Run this FROM your Mac to push the miner code + services to the Ubuntu box
# and set everything up remotely.
#
# Usage:
#   bash scripts/deploy-miner.sh              # deploy and setup
#   bash scripts/deploy-miner.sh --start      # deploy, setup, and start
#   bash scripts/deploy-miner.sh --status     # check remote miner status

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TRAINER_DIR="$(dirname "$SCRIPT_DIR")"

# Remote config (matches sync-remote.sh)
REMOTE_USER="${FORGE_REMOTE_USER:-j}"
REMOTE_HOST="${FORGE_REMOTE_HOST:-localhost}"
REMOTE_DIR="${FORGE_REMOTE_DIR:-~/familiar/trainer}"
SSH_KEY="${FORGE_SSH_KEY:-$HOME/.ssh/id_ed25519_github_personal}"
SSH_OPTS="-o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -i $SSH_KEY"

REMOTE="$REMOTE_USER@$REMOTE_HOST"
ACTION="${1:-deploy}"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}=== The Forge — Deploy Miner to $REMOTE ===${NC}"
echo ""

# Check connectivity
echo "Checking connection to $REMOTE..."
if ! ssh $SSH_OPTS "$REMOTE" "echo ok" &>/dev/null; then
    echo -e "${RED}Cannot reach $REMOTE — check SSH config${NC}"
    exit 1
fi
echo -e "  ${GREEN}✓${NC} Connected"
echo ""

if [ "$ACTION" = "--status" ]; then
    ssh $SSH_OPTS "$REMOTE" "cd $REMOTE_DIR && bash scripts/setup-data-miner.sh --status" 2>&1
    exit 0
fi

# Deploy: push miner code and services
echo -e "${CYAN}Pushing miner code to $REMOTE:$REMOTE_DIR...${NC}"

# Ensure remote dirs exist
ssh $SSH_OPTS "$REMOTE" "mkdir -p $REMOTE_DIR/{scripts,services,data/raw,logs,db,domains}"

# Push the miner and its dependencies
RSYNC_OPTS="--rsync-path=/usr/bin/rsync"
for f in mine-autonomous.mjs forge-db.js domain-config.mjs; do
    rsync -avz $RSYNC_OPTS -e "ssh $SSH_OPTS" \
        "$TRAINER_DIR/$f" \
        "$REMOTE:$REMOTE_DIR/"
done

# Push scripts
rsync -avz $RSYNC_OPTS -e "ssh $SSH_OPTS" \
    "$TRAINER_DIR/scripts/sync-to-mac.sh" \
    "$TRAINER_DIR/scripts/setup-data-miner.sh" \
    "$REMOTE:$REMOTE_DIR/scripts/"

# Push services
rsync -avz $RSYNC_OPTS -e "ssh $SSH_OPTS" \
    "$TRAINER_DIR/services/" \
    "$REMOTE:$REMOTE_DIR/services/"

# Push domain configs
rsync -avz $RSYNC_OPTS -e "ssh $SSH_OPTS" \
    "$TRAINER_DIR/domains/" \
    "$REMOTE:$REMOTE_DIR/domains/"

# Push existing raw data so dedup works
echo ""
echo "Syncing existing training data for dedup..."
rsync -avz $RSYNC_OPTS -e "ssh $SSH_OPTS" \
    "$TRAINER_DIR/data/raw/" \
    "$REMOTE:$REMOTE_DIR/data/raw/"

echo ""
echo -e "${GREEN}Code deployed.${NC}"

# Run setup on remote
echo ""
echo -e "${CYAN}Running setup on remote...${NC}"
ssh $SSH_OPTS "$REMOTE" "cd $REMOTE_DIR && bash scripts/setup-data-miner.sh"

# Optionally start
if [ "$ACTION" = "--start" ]; then
    echo ""
    echo -e "${CYAN}Starting services...${NC}"
    ssh $SSH_OPTS "$REMOTE" "cd $REMOTE_DIR && bash scripts/setup-data-miner.sh --start"
fi

echo ""
echo -e "${GREEN}=== Deployment Complete ===${NC}"
echo ""
echo "  Remote: $REMOTE:$REMOTE_DIR"
echo ""
echo "To start:   bash scripts/deploy-miner.sh --start"
echo "To check:   bash scripts/deploy-miner.sh --status"
echo "Live logs:  ssh $SSH_OPTS $REMOTE 'journalctl -u forge-miner -f'"
echo ""
