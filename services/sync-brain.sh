#!/usr/bin/env bash
set -euo pipefail

# Familiar Brain Sync — Keep two familiar brains in sync over LAN
#
# Bidirectional sync between Mac and Ubuntu (or any two machines).
# Syncs: code, training data, brain state, RAG knowledge, memory, config.
#
# Usage:
#   bash services/sync-brain.sh push          # Push everything to remote
#   bash services/sync-brain.sh pull          # Pull everything from remote
#   bash services/sync-brain.sh code          # Push code only (git-tracked files)
#   bash services/sync-brain.sh data          # Sync training data + open-source datasets
#   bash services/sync-brain.sh brain         # Sync brain state (hands, skills, RAG, goals)
#   bash services/sync-brain.sh memory        # Sync memory databases
#   bash services/sync-brain.sh status        # Check remote status
#   bash services/sync-brain.sh setup         # Initial setup on remote
#
# Environment:
#   WORKER_SSH          Required. SSH target for worker machine (e.g. user@worker-host)
#   MAC_SSH             Required. SSH target for Mac machine (e.g. user@mac-host)
#   SYNC_REMOTE_DIR     Remote familiar dir (default: ~/familiar)
#   SYNC_SSH_KEY        SSH key (optional, uses ssh default if unset)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

if [ -z "${WORKER_SSH:-}" ]; then
    echo "Error: WORKER_SSH env var is required (e.g. user@worker-host)"
    exit 1
fi

if [ -z "${MAC_SSH:-}" ]; then
    echo "Error: MAC_SSH env var is required (e.g. user@mac-host)"
    exit 1
fi

REMOTE_USER="${WORKER_SSH%%@*}"
REMOTE_HOST="${WORKER_SSH##*@}"
REMOTE_DIR="${SYNC_REMOTE_DIR:-~/familiar}"
SSH_KEY="${SYNC_SSH_KEY:-}"
SSH_OPTS="-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new"

if [ -n "$SSH_KEY" ] && [ -f "$SSH_KEY" ]; then
    SSH_OPTS="$SSH_OPTS -i $SSH_KEY"
fi

RSYNC_OPTS="--rsync-path=/usr/bin/rsync"
REMOTE="$WORKER_SSH"

# Remote PATH fix — Ubuntu box may have minimal shell PATH
REMOTE_PATH_PREFIX="export PATH=/home/$REMOTE_USER/.bun/bin:/usr/local/cuda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:\$PATH"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

ACTION="${1:-help}"

# Shared rsync excludes for code sync
CODE_EXCLUDES=(
    --exclude='node_modules/'
    --exclude='.venv/'
    --exclude='__pycache__/'
    --exclude='.DS_Store'
    --exclude='*.pyc'
    --exclude='target/'
    --exclude='.next/'
    --exclude='models/base/'
    --exclude='models/fused/'
    --exclude='models/gguf/'
    --exclude='models/adapters/'
    --exclude='tools/llama.cpp/'
    --exclude='trainer/data/'
    --exclude='brain/rag/knowledge.db'
    --exclude='brain/rag/knowledge.db-shm'
    --exclude='brain/rag/knowledge.db-wal'
    --exclude='brain/tasks/'
    --exclude='config/.env'
    --exclude='config/credentials/'
    --exclude='config/telegram/'
    --exclude='.claude/'
    --exclude='*.db'
    --exclude='*.db-shm'
    --exclude='*.db-wal'
)

check_connection() {
    if ! ssh $SSH_OPTS "$REMOTE" "echo ok" &>/dev/null; then
        echo -e "${RED}Cannot reach $REMOTE${NC}"
        exit 1
    fi
}

sync_code() {
    echo -e "${CYAN}Syncing code to $REMOTE...${NC}"
    rsync -avz --progress $RSYNC_OPTS "${CODE_EXCLUDES[@]}" \
        -e "ssh $SSH_OPTS" \
        "$REPO_DIR/" \
        "$REMOTE:$REMOTE_DIR/"
    echo -e "${GREEN}Code sync complete.${NC}"
}

sync_data_push() {
    echo -e "${CYAN}Pushing training data to $REMOTE...${NC}"

    # Raw training data
    if [ -d "$REPO_DIR/trainer/data/raw" ]; then
        rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$REPO_DIR/trainer/data/raw/" \
            "$REMOTE:$REMOTE_DIR/trainer/data/raw/"
    fi

    # Open-source datasets
    if [ -d "$REPO_DIR/trainer/data/open_source" ]; then
        rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$REPO_DIR/trainer/data/open_source/" \
            "$REMOTE:$REMOTE_DIR/trainer/data/open_source/"
    fi

    # Traces
    if [ -d "$REPO_DIR/trainer/data/traces" ]; then
        rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$REPO_DIR/trainer/data/traces/" \
            "$REMOTE:$REMOTE_DIR/trainer/data/traces/"
    fi

    # Prepared train/valid splits
    for f in train.jsonl valid.jsonl; do
        if [ -f "$REPO_DIR/trainer/data/$f" ]; then
            rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
                "$REPO_DIR/trainer/data/$f" \
                "$REMOTE:$REMOTE_DIR/trainer/data/"
        fi
    done

    # Forge DB
    for db in "$REPO_DIR/trainer/forge.db" "$REPO_DIR/trainer/db/forge.db"; do
        if [ -f "$db" ]; then
            rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
                "$db" \
                "$REMOTE:$REMOTE_DIR/trainer/$(basename "$(dirname "$db")")/$(basename "$db")" 2>/dev/null || \
            rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
                "$db" \
                "$REMOTE:$REMOTE_DIR/trainer/"
        fi
    done

    # Domain configs + benchmarks
    rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
        "$REPO_DIR/trainer/domains/" \
        "$REMOTE:$REMOTE_DIR/trainer/domains/"
    rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
        --include='*.jsonl' --exclude='results/' \
        "$REPO_DIR/trainer/benchmarks/" \
        "$REMOTE:$REMOTE_DIR/trainer/benchmarks/"

    echo -e "${GREEN}Data push complete.${NC}"
}

sync_data_pull() {
    echo -e "${CYAN}Pulling training data from $REMOTE...${NC}"

    # Raw training data (remote may have mined new data)
    rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
        "$REMOTE:$REMOTE_DIR/trainer/data/raw/" \
        "$REPO_DIR/trainer/data/raw/"

    # Open-source datasets
    ssh $SSH_OPTS "$REMOTE" "test -d $REMOTE_DIR/trainer/data/open_source" 2>/dev/null && \
    rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
        "$REMOTE:$REMOTE_DIR/trainer/data/open_source/" \
        "$REPO_DIR/trainer/data/open_source/" || true

    # Trained models
    rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
        "$REMOTE:$REMOTE_DIR/trainer/models/adapters/" \
        "$REPO_DIR/trainer/models/adapters/" 2>/dev/null || true
    rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
        "$REMOTE:$REMOTE_DIR/trainer/models/gguf/" \
        "$REPO_DIR/trainer/models/gguf/" 2>/dev/null || true

    # Benchmark results
    rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
        "$REMOTE:$REMOTE_DIR/trainer/benchmarks/results/" \
        "$REPO_DIR/trainer/benchmarks/results/" 2>/dev/null || true

    echo -e "${GREEN}Data pull complete.${NC}"
}

sync_brain_push() {
    echo -e "${CYAN}Pushing brain state to $REMOTE...${NC}"

    # Hands manifests (HAND.json files define what each hand does)
    rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
        --include='*/' --include='HAND.json' --exclude='*' \
        "$REPO_DIR/brain/hands/" \
        "$REMOTE:$REMOTE_DIR/brain/hands/"

    # Hands core modules
    for f in cli.mjs registry.mjs runner.mjs scheduler.mjs schema.mjs triggers.mjs; do
        if [ -f "$REPO_DIR/brain/hands/$f" ]; then
            rsync -avz $RSYNC_OPTS -e "ssh $SSH_OPTS" \
                "$REPO_DIR/brain/hands/$f" \
                "$REMOTE:$REMOTE_DIR/brain/hands/"
        fi
    done

    # Hands state (so remote knows what's active/paused)
    if [ -f "$REPO_DIR/brain/hands/state.json" ]; then
        rsync -avz $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$REPO_DIR/brain/hands/state.json" \
            "$REMOTE:$REMOTE_DIR/brain/hands/"
    fi

    # Skills
    rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
        "$REPO_DIR/brain/skills/" \
        "$REMOTE:$REMOTE_DIR/brain/skills/"

    # Goals (module code)
    rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
        "$REPO_DIR/brain/goals/" \
        "$REMOTE:$REMOTE_DIR/brain/goals/"

    # Goals data (~/.familiar/goals.json — the actual goal state, not tracked in repo)
    if [ -f "$HOME/.familiar/goals.json" ]; then
        rsync -avz $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$HOME/.familiar/goals.json" \
            "$REMOTE:~/.familiar/goals.json"
    fi

    # Learner
    if [ -f "$REPO_DIR/brain/learner.mjs" ]; then
        rsync -avz $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$REPO_DIR/brain/learner.mjs" \
            "$REMOTE:$REMOTE_DIR/brain/"
    fi

    # RAG (knowledge DB — careful, can be large)
    if [ -f "$REPO_DIR/brain/rag/knowledge.db" ]; then
        echo -e "${DIM}  (RAG knowledge DB: $(du -sh "$REPO_DIR/brain/rag/knowledge.db" | cut -f1))${NC}"
        rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$REPO_DIR/brain/rag/knowledge.db" \
            "$REMOTE:$REMOTE_DIR/brain/rag/"
    fi

    # RAG modules
    for f in "$REPO_DIR/brain/rag/"*.mjs; do
        [ -f "$f" ] && rsync -avz $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$f" "$REMOTE:$REMOTE_DIR/brain/rag/"
    done

    # Workflows
    if [ -d "$REPO_DIR/brain/workflows" ]; then
        rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$REPO_DIR/brain/workflows/" \
            "$REMOTE:$REMOTE_DIR/brain/workflows/"
    fi

    # Reflection + ideas (learner outputs)
    for d in reflection ideas; do
        if [ -d "$REPO_DIR/brain/$d" ]; then
            rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
                "$REPO_DIR/brain/$d/" \
                "$REMOTE:$REMOTE_DIR/brain/$d/"
        fi
    done

    echo -e "${GREEN}Brain push complete.${NC}"
}

sync_brain_pull() {
    echo -e "${CYAN}Pulling brain state from $REMOTE...${NC}"

    # Pull hands state (remote may have run hands)
    rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
        "$REMOTE:$REMOTE_DIR/brain/hands/state.json" \
        "$REPO_DIR/brain/hands/" 2>/dev/null || true

    # Pull any new skills learned on remote
    rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
        "$REMOTE:$REMOTE_DIR/brain/skills/" \
        "$REPO_DIR/brain/skills/" 2>/dev/null || true

    # Pull RAG knowledge (remote may have ingested new docs)
    rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
        "$REMOTE:$REMOTE_DIR/brain/rag/knowledge.db" \
        "$REPO_DIR/brain/rag/" 2>/dev/null || true

    # Pull reflection + ideas
    for d in reflection ideas; do
        rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$REMOTE:$REMOTE_DIR/brain/$d/" \
            "$REPO_DIR/brain/$d/" 2>/dev/null || true
    done

    echo -e "${GREEN}Brain pull complete.${NC}"
}

sync_memory_push() {
    echo -e "${CYAN}Pushing memory to $REMOTE...${NC}"

    FAMILIAR_HOME="${FAMILIAR_HOME:-$HOME/.familiar}"

    # Memory database
    if [ -f "$FAMILIAR_HOME/memory/familiar.db" ]; then
        ssh $SSH_OPTS "$REMOTE" "$REMOTE_PATH_PREFIX; mkdir -p ~/.familiar/memory"
        rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$FAMILIAR_HOME/memory/familiar.db" \
            "$REMOTE:~/.familiar/memory/"
    fi

    # Chat memory
    if [ -f "$FAMILIAR_HOME/memory/chat-memory.db" ]; then
        rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$FAMILIAR_HOME/memory/chat-memory.db" \
            "$REMOTE:~/.familiar/memory/"
    fi

    # In-repo memory docs
    if [ -d "$REPO_DIR/memory" ]; then
        rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$REPO_DIR/memory/" \
            "$REMOTE:$REMOTE_DIR/memory/"
    fi

    echo -e "${GREEN}Memory push complete.${NC}"
}

sync_memory_pull() {
    echo -e "${CYAN}Pulling memory from $REMOTE...${NC}"

    FAMILIAR_HOME="${FAMILIAR_HOME:-$HOME/.familiar}"

    rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
        "$REMOTE:~/.familiar/memory/familiar.db" \
        "$FAMILIAR_HOME/memory/" 2>/dev/null || true

    rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
        "$REMOTE:~/.familiar/memory/chat-memory.db" \
        "$FAMILIAR_HOME/memory/" 2>/dev/null || true

    rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
        "$REMOTE:$REMOTE_DIR/memory/" \
        "$REPO_DIR/memory/" 2>/dev/null || true

    echo -e "${GREEN}Memory pull complete.${NC}"
}

sync_config() {
    echo -e "${CYAN}Pushing config (excluding secrets) to $REMOTE...${NC}"

    ssh $SSH_OPTS "$REMOTE" "$REMOTE_PATH_PREFIX; mkdir -p ~/.familiar/config"

    # Main config (no secrets)
    if [ -f "$REPO_DIR/config/familiar.json" ]; then
        rsync -avz $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$REPO_DIR/config/familiar.json" \
            "$REMOTE:$REMOTE_DIR/config/"
    fi

    # MCP tools config
    if [ -f "$REPO_DIR/config/mcp-tools.json" ]; then
        rsync -avz $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$REPO_DIR/config/mcp-tools.json" \
            "$REMOTE:$REMOTE_DIR/config/"
    fi

    # Cron jobs
    if [ -f "$REPO_DIR/cron/jobs.json" ]; then
        rsync -avz $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$REPO_DIR/cron/jobs.json" \
            "$REMOTE:$REMOTE_DIR/cron/"
    fi

    # Shared utilities
    rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
        "$REPO_DIR/shared/" \
        "$REMOTE:$REMOTE_DIR/shared/"

    echo -e "${GREEN}Config push complete.${NC}"
    echo -e "${YELLOW}Note: .env and credentials not synced. Set up secrets on remote manually.${NC}"
}

case "$ACTION" in
    push)
        check_connection
        echo -e "${CYAN}=== Full push to $REMOTE ===${NC}"
        echo ""
        sync_code
        echo ""
        sync_data_push
        echo ""
        sync_brain_push
        echo ""
        sync_memory_push
        echo ""
        sync_config
        echo ""
        echo -e "${GREEN}=== Full push complete ===${NC}"
        ;;

    pull)
        check_connection
        echo -e "${CYAN}=== Full pull from $REMOTE ===${NC}"
        echo ""
        sync_data_pull
        echo ""
        sync_brain_pull
        echo ""
        sync_memory_pull
        echo ""
        echo -e "${GREEN}=== Full pull complete ===${NC}"
        ;;

    code)
        check_connection
        sync_code
        ;;

    data)
        check_connection
        sync_data_push
        ;;

    brain)
        check_connection
        sync_brain_push
        ;;

    memory)
        check_connection
        sync_memory_push
        ;;

    pull-state)
        # Lightweight: only syncs brain/hands/state.json from remote
        # Called by worker after each hand run to keep state in sync
        check_connection
        echo -e "${CYAN}Pulling hands state from $REMOTE...${NC}"
        rsync -avz $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$REMOTE:$REMOTE_DIR/brain/hands/state.json" \
            "$REPO_DIR/brain/hands/" 2>/dev/null || true
        # Also pull peer reflections
        rsync -avz $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$REMOTE:$REMOTE_DIR/brain/reflection/peer-reflections.json" \
            "$REPO_DIR/brain/reflection/" 2>/dev/null || true
        rsync -avz $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$REMOTE:$REMOTE_DIR/brain/reflection/peer-feedback.json" \
            "$REPO_DIR/brain/reflection/" 2>/dev/null || true
        echo -e "${GREEN}State pull complete.${NC}"
        ;;

    status)
        echo -e "${CYAN}Remote brain status ($REMOTE):${NC}"
        check_connection
        ssh $SSH_OPTS "$REMOTE" "$REMOTE_PATH_PREFIX;
            echo ''
            echo '  System:'
            uname -a 2>/dev/null | head -1
            echo ''

            echo '  GPU:'
            nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader 2>/dev/null || echo '    (no GPU)'
            echo ''

            echo '  Ollama:'
            if command -v ollama &>/dev/null; then
                ollama --version 2>&1 | head -1
                echo '    Models:'
                ollama list 2>/dev/null | head -10
            else
                echo '    not installed'
            fi
            echo ''

            echo '  Bun:'
            if command -v bun &>/dev/null; then
                bun --version 2>&1
            else
                echo '    not installed'
            fi
            echo ''

            echo '  Familiar repo:'
            if [ -d '$REMOTE_DIR' ]; then
                echo \"    Dir: $REMOTE_DIR\"
                du -sh $REMOTE_DIR 2>/dev/null | awk '{print \"    Size: \"\$1}'
            else
                echo '    not found'
            fi
            echo ''

            echo '  Training data:'
            if [ -d '$REMOTE_DIR/trainer/data/raw' ]; then
                count=\$(find $REMOTE_DIR/trainer/data/raw -name '*.jsonl' 2>/dev/null | wc -l)
                echo \"    Raw files: \$count\"
            fi
            if [ -d '$REMOTE_DIR/trainer/data/open_source' ]; then
                count=\$(find $REMOTE_DIR/trainer/data/open_source -name '*.jsonl' 2>/dev/null | wc -l)
                echo \"    Open-source files: \$count\"
            fi
            echo ''

            echo '  Brain:'
            if [ -f '$REMOTE_DIR/brain/hands/state.json' ]; then
                echo '    Hands state: present'
            fi
            if [ -f '$REMOTE_DIR/brain/rag/knowledge.db' ]; then
                du -sh $REMOTE_DIR/brain/rag/knowledge.db 2>/dev/null | awk '{print \"    RAG DB: \"\$1}'
            fi
            echo ''

            echo '  Services:'
            if command -v systemctl &>/dev/null; then
                systemctl --user list-units 'familiar*' --no-pager 2>/dev/null || echo '    (no systemd user services)'
            fi
            echo ''
        " 2>&1
        ;;

    setup)
        echo -e "${CYAN}=== Setting up remote brain at $REMOTE ===${NC}"
        check_connection
        echo ""

        echo -e "${CYAN}Creating directory structure...${NC}"
        ssh $SSH_OPTS "$REMOTE" "$REMOTE_PATH_PREFIX;
            mkdir -p $REMOTE_DIR/{services,brain/{hands,rag,skills,goals,reflection,ideas,workflows,tasks},trainer/{data/{raw,open_source,traces},models/{base,adapters,fused,gguf},scripts,domains,benchmarks/results,db,logs},config,shared,memory,cron,mcp-bridge}
            mkdir -p ~/.familiar/{memory,config,logs}
        "

        echo -e "${CYAN}Pushing code...${NC}"
        sync_code
        echo ""

        echo -e "${CYAN}Pushing data...${NC}"
        sync_data_push
        echo ""

        echo -e "${CYAN}Pushing brain state...${NC}"
        sync_brain_push
        echo ""

        echo -e "${CYAN}Pushing config...${NC}"
        sync_config
        echo ""

        echo -e "${GREEN}=== Remote setup complete ===${NC}"
        echo ""
        echo "Next steps on the remote machine ($REMOTE):"
        echo ""
        echo "  1. Install Bun (if not already):"
        echo "     curl -fsSL https://bun.sh/install | bash"
        echo ""
        echo "  2. Install Node.js (for MCP bridge):"
        echo "     curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
        echo "     sudo apt install -y nodejs"
        echo ""
        echo "  3. Install dependencies:"
        echo "     cd $REMOTE_DIR/apps/cli && bun install"
        echo "     cd $REMOTE_DIR/mcp-bridge && npm install"
        echo ""
        echo "  4. Set up secrets:"
        echo "     cp $REMOTE_DIR/config/.env.example $REMOTE_DIR/config/.env"
        echo "     # Edit .env with your API keys"
        echo ""
        echo "  5. Set up the training environment:"
        echo "     cd $REMOTE_DIR/trainer && bash scripts/setup-remote.sh"
        echo ""
        echo "  6. Start the gateway:"
        echo "     cd $REMOTE_DIR && bash services/start-gateway.sh"
        echo ""
        echo "  7. (Optional) Set up systemd services:"
        echo "     # See services/install-services.sh for launchd equiv"
        echo "     # Adapt for systemd on Ubuntu"
        echo ""
        ;;

    *)
        echo "Familiar Brain Sync"
        echo ""
        echo "Usage: bash services/sync-brain.sh <command>"
        echo ""
        echo "Commands:"
        echo "  push      Full push: code + data + brain + memory + config"
        echo "  pull      Full pull: data + brain + memory"
        echo "  code      Push code only (git-tracked files, no data/models)"
        echo "  data      Push training data + open-source datasets"
        echo "  brain     Push brain state (hands, skills, RAG, goals)"
        echo "  memory    Push memory databases"
        echo "  pull-state Pull only hands state + peer reflections (lightweight)"
        echo "  status    Check remote system status"
        echo "  setup     Initial setup: create dirs + full push + instructions"
        echo ""
        echo "Environment:"
        echo "  WORKER_SSH          SSH target for worker (e.g. user@host) [required]"
        echo "  MAC_SSH             SSH target for Mac (e.g. user@host) [required]"
        echo "  SYNC_REMOTE_DIR     Remote dir (default: $REMOTE_DIR)"
        echo "  SYNC_SSH_KEY        SSH key (default: ssh default)"
        echo ""
        echo "Current remote: $REMOTE:$REMOTE_DIR"
        echo ""
        echo "Examples:"
        echo "  bash services/sync-brain.sh setup          # First time setup"
        echo "  bash services/sync-brain.sh push            # Sync everything"
        echo "  bash services/sync-brain.sh code            # Just push code changes"
        echo "  bash services/sync-brain.sh pull            # Pull trained models + new data"
        echo ""
        ;;
esac
