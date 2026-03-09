#!/usr/bin/env bash
set -euo pipefail

# The Forge — Ubuntu Data Miner Setup
# Sets up the Ubuntu machine as a continuous data collector.
# Uses the local Ollama model + GitHub to gather training data 24/7.
#
# Run this ON the Ubuntu worker box ($WORKER_HOST).
#
# Prerequisites:
#   - Ubuntu 22.04+ with NVIDIA GPU
#   - NVIDIA drivers installed
#   - Ollama installed and running with familiar-brain:latest loaded
#   - gh CLI installed and authenticated
#   - SSH key configured for Mac access (for data sync)
#
# Usage:
#   bash scripts/setup-data-miner.sh              # full setup
#   bash scripts/setup-data-miner.sh --check      # check prerequisites
#   bash scripts/setup-data-miner.sh --start      # start services only
#   bash scripts/setup-data-miner.sh --stop       # stop services
#   bash scripts/setup-data-miner.sh --status     # show service status + stats

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TRAINER_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}=== The Forge — Data Miner Setup ===${NC}"
echo ""

# ── Check mode ────────────────────────────────────────────────────────────

if [ "${1:-}" = "--check" ]; then
    echo "Checking prerequisites..."
    echo ""
    PASS=0
    FAIL=0

    # Bun
    if command -v bun &>/dev/null; then
        echo -e "  ${GREEN}✓${NC} Bun:       $(bun --version)"
        ((PASS++))
    else
        echo -e "  ${RED}✗${NC} Bun:       not found (install: curl -fsSL https://bun.sh/install | bash)"
        ((FAIL++))
    fi

    # gh CLI
    if command -v gh &>/dev/null; then
        AUTH=$(gh auth status 2>&1 | head -1)
        echo -e "  ${GREEN}✓${NC} gh CLI:    $(gh --version | head -1)"
        if gh auth status &>/dev/null; then
            echo -e "  ${GREEN}✓${NC} gh auth:   authenticated"
            ((PASS++))
        else
            echo -e "  ${RED}✗${NC} gh auth:   not authenticated (run: gh auth login)"
            ((FAIL++))
        fi
        ((PASS++))
    else
        echo -e "  ${RED}✗${NC} gh CLI:    not found (install: https://cli.github.com)"
        ((FAIL++))
    fi

    # Ollama
    if command -v ollama &>/dev/null; then
        echo -e "  ${GREEN}✓${NC} Ollama:    $(ollama --version 2>&1 | head -1)"
        ((PASS++))

        # Check if Ollama service is running
        if curl -sf http://localhost:11434/api/tags &>/dev/null; then
            MODELS=$(curl -sf http://localhost:11434/api/tags | python3 -c "import sys,json; tags=json.load(sys.stdin); print(', '.join(m['name'] for m in tags.get('models',[])) or 'none')" 2>/dev/null || echo "error")
            echo -e "  ${GREEN}✓${NC} Ollama OK: models: $MODELS"
            ((PASS++))

            if echo "$MODELS" | grep -q "familiar-brain"; then
                echo -e "  ${GREEN}✓${NC} Model:     familiar-brain found"
                ((PASS++))
            else
                echo -e "  ${YELLOW}!${NC} Model:     familiar-brain not loaded — pull or create it first"
            fi
        else
            echo -e "  ${RED}✗${NC} Ollama:    service not running (run: sudo systemctl start ollama)"
            ((FAIL++))
        fi
    else
        echo -e "  ${RED}✗${NC} Ollama:    not found (install: curl -fsSL https://ollama.com/install.sh | sh)"
        ((FAIL++))
    fi

    # NVIDIA GPU
    if command -v nvidia-smi &>/dev/null; then
        GPU_INFO=$(nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader 2>/dev/null | head -1)
        echo -e "  ${GREEN}✓${NC} GPU:       $GPU_INFO"
        ((PASS++))
    else
        echo -e "  ${RED}✗${NC} GPU:       nvidia-smi not found"
        ((FAIL++))
    fi

    # Network speed test (basic — check if 1gig interface exists)
    SPEED=$(cat /sys/class/net/*/speed 2>/dev/null | sort -rn | head -1 || echo "unknown")
    if [ "$SPEED" != "unknown" ] && [ "$SPEED" -ge 1000 ] 2>/dev/null; then
        echo -e "  ${GREEN}✓${NC} Network:   ${SPEED}Mbps link detected"
        ((PASS++))
    else
        echo -e "  ${YELLOW}!${NC} Network:   link speed: ${SPEED}Mbps"
    fi

    # SSH key
    if [ -f "$HOME/.ssh/id_ed25519" ] || [ -f "$HOME/.ssh/id_rsa" ]; then
        echo -e "  ${GREEN}✓${NC} SSH key:   found"
        ((PASS++))
    else
        echo -e "  ${YELLOW}!${NC} SSH key:   no default key found (needed for Mac sync)"
    fi

    # Trainer directory
    if [ -f "$TRAINER_DIR/mine-autonomous.mjs" ]; then
        echo -e "  ${GREEN}✓${NC} Miner:     $TRAINER_DIR/mine-autonomous.mjs"
        ((PASS++))
    else
        echo -e "  ${RED}✗${NC} Miner:     mine-autonomous.mjs not found in $TRAINER_DIR"
        ((FAIL++))
    fi

    echo ""
    echo -e "  ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
    if [ "$FAIL" -gt 0 ]; then
        echo -e "  ${YELLOW}Fix the failures above before running setup.${NC}"
    else
        echo -e "  ${GREEN}All good — run setup without --check to install services.${NC}"
    fi
    exit 0
fi

# ── Start mode ────────────────────────────────────────────────────────────

if [ "${1:-}" = "--start" ]; then
    echo "Starting Forge data mining services..."
    sudo systemctl start forge-miner
    sudo systemctl start forge-sync.timer
    echo -e "${GREEN}Services started.${NC}"
    systemctl status forge-miner --no-pager -l | head -15
    echo ""
    systemctl list-timers forge-sync.timer --no-pager
    exit 0
fi

# ── Stop mode ─────────────────────────────────────────────────────────────

if [ "${1:-}" = "--stop" ]; then
    echo "Stopping Forge data mining services..."
    sudo systemctl stop forge-miner 2>/dev/null || true
    sudo systemctl stop forge-sync.timer 2>/dev/null || true
    echo -e "${GREEN}Services stopped.${NC}"
    exit 0
fi

# ── Status mode ───────────────────────────────────────────────────────────

if [ "${1:-}" = "--status" ]; then
    echo -e "${CYAN}Forge Miner Status${NC}"
    echo ""

    # Service status
    echo "  Miner service:"
    if systemctl is-active forge-miner &>/dev/null; then
        echo -e "    ${GREEN}● running${NC}"
        UPTIME=$(systemctl show forge-miner --property=ActiveEnterTimestamp --value 2>/dev/null)
        [ -n "$UPTIME" ] && echo "    Since: $UPTIME"
    else
        echo -e "    ${RED}● stopped${NC}"
    fi

    echo ""
    echo "  Sync timer:"
    if systemctl is-active forge-sync.timer &>/dev/null; then
        echo -e "    ${GREEN}● active${NC}"
        NEXT=$(systemctl show forge-sync.timer --property=NextElapseUSecRealtime --value 2>/dev/null)
        [ -n "$NEXT" ] && echo "    Next run: $NEXT"
    else
        echo -e "    ${RED}● inactive${NC}"
    fi

    # Data stats
    echo ""
    echo "  Training data:"
    RAW_COUNT=$(find "$TRAINER_DIR/data/raw" -name "*.jsonl" 2>/dev/null | wc -l)
    RAW_SIZE=$(du -sh "$TRAINER_DIR/data/raw" 2>/dev/null | cut -f1)
    echo "    Raw files: $RAW_COUNT ($RAW_SIZE)"

    TODAY_FILE="$TRAINER_DIR/data/raw/$(date +%Y-%m-%d)-auto.jsonl"
    if [ -f "$TODAY_FILE" ]; then
        TODAY_PAIRS=$(wc -l < "$TODAY_FILE")
        TODAY_SIZE=$(du -sh "$TODAY_FILE" | cut -f1)
        echo "    Today: $TODAY_PAIRS pairs ($TODAY_SIZE)"
    else
        echo "    Today: no data yet"
    fi

    # Autonomous stats
    STATS_FILE="$TRAINER_DIR/data/autonomous-stats.json"
    if [ -f "$STATS_FILE" ]; then
        echo ""
        echo "  Lifetime stats:"
        python3 -c "
import json
with open('$STATS_FILE') as f:
    s = json.load(f)
print(f'    Cycles: {s.get(\"total_cycles\", 0)}')
print(f'    Total pairs: {s.get(\"total_pairs\", 0)}')
print(f'    Synthesized: {s.get(\"total_synthesized\", 0)}')
print(f'    Ground truth: {s.get(\"total_ground_truth\", 0)}')
print(f'    Targeted: {s.get(\"total_targeted\", 0)}')
print(f'    Repos discovered: {s.get(\"total_repos_discovered\", 0)}')
print(f'    Last cycle: {s.get(\"last_cycle\", \"never\")}')
" 2>/dev/null || echo "    (could not read stats)"
    fi

    # GPU
    echo ""
    echo "  GPU:"
    nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader 2>/dev/null | \
        sed 's/^/    /' || echo "    (unavailable)"

    # Recent logs
    echo ""
    echo "  Recent log (last 10 lines):"
    journalctl -u forge-miner --no-pager -n 10 2>/dev/null | sed 's/^/    /' || \
        tail -10 "$TRAINER_DIR/logs/autonomous-$(date +%Y-%m-%d).log" 2>/dev/null | sed 's/^/    /' || \
        echo "    (no logs)"

    exit 0
fi

# ── Full Setup ────────────────────────────────────────────────────────────

echo -e "${CYAN}Step 1: Checking prerequisites...${NC}"

# Check bun
if ! command -v bun &>/dev/null; then
    echo "  Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
fi
echo "  Bun: $(bun --version)"

# Check gh
if ! command -v gh &>/dev/null; then
    echo -e "${RED}  gh CLI not found. Install it first:${NC}"
    echo "    sudo apt install gh"
    echo "    gh auth login"
    exit 1
fi
if ! gh auth status &>/dev/null; then
    echo -e "${RED}  gh not authenticated. Run: gh auth login${NC}"
    exit 1
fi
echo "  gh CLI: authenticated"

# Check Ollama
if ! command -v ollama &>/dev/null; then
    echo "  Installing Ollama..."
    curl -fsSL https://ollama.com/install.sh | sh
fi
echo "  Ollama: $(ollama --version 2>&1 | head -1)"

# Check GPU
if command -v nvidia-smi &>/dev/null; then
    GPU=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -1)
    echo "  GPU: $GPU"
else
    echo -e "${YELLOW}  No NVIDIA GPU detected — miner will use CPU (slow)${NC}"
fi

# Step 2: Create directories
echo ""
echo -e "${CYAN}Step 2: Creating directories...${NC}"
for d in data/raw data/traces logs db models/base models/gguf; do
    mkdir -p "$TRAINER_DIR/$d"
done
echo "  Directories ready"

# Step 3: Configure Mac sync
echo ""
echo -e "${CYAN}Step 3: Configuring Mac sync...${NC}"

# Create env file for sync config
SYNC_ENV="$TRAINER_DIR/.sync-env"
if [ ! -f "$SYNC_ENV" ]; then
    cat > "$SYNC_ENV" <<'ENVEOF'
# Forge sync config — edit these for your network
FORGE_MAC_USER=${USER:-user}
FORGE_MAC_HOST=${MAC_HOST:-localhost}
FORGE_MAC_DIR=~/familiar/trainer
FORGE_SSH_KEY=~/.ssh/id_ed25519
ENVEOF
    echo "  Created $SYNC_ENV — edit with your Mac's IP/user if different"
else
    echo "  Sync config already exists: $SYNC_ENV"
fi

# Source it for the sync script
chmod +x "$TRAINER_DIR/scripts/sync-to-mac.sh"
echo "  Sync script ready"

# Step 4: Install systemd services
echo ""
echo -e "${CYAN}Step 4: Installing systemd services...${NC}"

SERVICES_DIR="$TRAINER_DIR/services"
if [ -d "$SERVICES_DIR" ]; then
    # Copy service files
    sudo cp "$SERVICES_DIR/forge-miner.service" /etc/systemd/system/
    sudo cp "$SERVICES_DIR/forge-sync.service" /etc/systemd/system/
    sudo cp "$SERVICES_DIR/forge-sync.timer" /etc/systemd/system/

    # Patch User= if current user is different
    CURRENT_USER=$(whoami)
    if [ "$CURRENT_USER" != "j" ]; then
        echo "  Updating service user from 'j' to '$CURRENT_USER'..."
        sudo sed -i "s/User=j/User=$CURRENT_USER/g" /etc/systemd/system/forge-miner.service
        sudo sed -i "s/User=j/User=$CURRENT_USER/g" /etc/systemd/system/forge-sync.service
        sudo sed -i "s|/home/j|/home/$CURRENT_USER|g" /etc/systemd/system/forge-miner.service
        sudo sed -i "s|/home/j|/home/$CURRENT_USER|g" /etc/systemd/system/forge-sync.service
    fi

    # Reload and enable
    sudo systemctl daemon-reload
    sudo systemctl enable forge-miner
    sudo systemctl enable forge-sync.timer

    echo "  Services installed and enabled"
else
    echo -e "${YELLOW}  Services directory not found — skipping systemd setup${NC}"
    echo "  You can run the miner manually: bun mine-autonomous.mjs --daemon"
fi

# Step 5: Verify Gemini API (optional but recommended for better data quality)
echo ""
echo -e "${CYAN}Step 5: Gemini API (optional)...${NC}"

GEMINI_KEY=""
CONFIG_ENV="$TRAINER_DIR/../config/.env"
if [ -f "$CONFIG_ENV" ]; then
    GEMINI_KEY=$(grep -oP 'GEMINI_API_KEY=\K.+' "$CONFIG_ENV" 2>/dev/null || true)
fi

if [ -n "$GEMINI_KEY" ]; then
    echo "  Gemini API key found — silver reference scoring enabled"
else
    echo -e "  ${YELLOW}No Gemini API key — data quality scoring will be local-only${NC}"
    echo "  To enable: add GEMINI_API_KEY=... to $CONFIG_ENV"
fi

# Summary
echo ""
echo -e "${GREEN}=== Setup Complete ===${NC}"
echo ""
echo "  Miner:     mine-autonomous.mjs (daemon mode)"
echo "  Cycle:     every 30 minutes, up to 300 pairs per cycle"
echo "  Sync:      every 2 hours to Mac"
echo "  Data dir:  $TRAINER_DIR/data/raw/"
echo "  Logs:      journalctl -u forge-miner -f"
echo ""
echo -e "${CYAN}Commands:${NC}"
echo "  Start mining:     bash scripts/setup-data-miner.sh --start"
echo "  Stop mining:      bash scripts/setup-data-miner.sh --stop"
echo "  Check status:     bash scripts/setup-data-miner.sh --status"
echo "  View live logs:   journalctl -u forge-miner -f"
echo "  Manual sync:      bash scripts/sync-to-mac.sh"
echo "  Run one cycle:    bun mine-autonomous.mjs"
echo ""
echo -e "${CYAN}Before starting, make sure:${NC}"
echo "  1. Ollama has familiar-brain:latest loaded"
echo "  2. You can SSH to your Mac without a password (ssh-copy-id)"
echo "  3. Edit .sync-env if your Mac's IP differs from the default"
echo ""
