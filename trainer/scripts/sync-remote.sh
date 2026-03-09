#!/usr/bin/env bash
set -euo pipefail

# The Forge — Sync with Remote Training Server
# Pushes training data to the remote PC and pulls trained models back.
#
# Usage:
#   bash scripts/sync-remote.sh push          # push training data to remote
#   bash scripts/sync-remote.sh pull          # pull trained adapters from remote
#   bash scripts/sync-remote.sh full          # push data, train remotely, pull results
#   bash scripts/sync-remote.sh status        # check remote status

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TRAINER_DIR="$(dirname "$SCRIPT_DIR")"

# Remote server config — edit these
REMOTE_USER="${FORGE_REMOTE_USER:-j}"
REMOTE_HOST="${FORGE_REMOTE_HOST:-localhost}"
REMOTE_DIR="${FORGE_REMOTE_DIR:-~/familiar/trainer}"
SSH_KEY="${FORGE_SSH_KEY:-$HOME/.ssh/id_ed25519_github_personal}"
SSH_OPTS="-o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -i $SSH_KEY"
RSYNC_OPTS="--rsync-path=/usr/bin/rsync"

REMOTE="$REMOTE_USER@$REMOTE_HOST"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

ACTION="${1:-help}"
DOMAIN="${2:-}"

# Parse --domain flag from any position
for arg in "$@"; do
    case "$arg" in
        --domain=*) DOMAIN="${arg#--domain=}" ;;
    esac
done
# Also check positional: sync-remote.sh push brain
if [ -z "$DOMAIN" ] && [ -n "${2:-}" ] && [ "${2:0:2}" != "--" ]; then
    DOMAIN="$2"
fi

case "$ACTION" in
    push)
        echo -e "${CYAN}Pushing training data to $REMOTE...${NC}"

        # Push raw training data
        rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$TRAINER_DIR/data/raw/" \
            "$REMOTE:$REMOTE_DIR/data/raw/"

        # Push domain-specific prepared data if it exists
        if [ -n "$DOMAIN" ] && [ -d "$TRAINER_DIR/data/$DOMAIN" ]; then
            rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
                "$TRAINER_DIR/data/$DOMAIN/" \
                "$REMOTE:$REMOTE_DIR/data/$DOMAIN/"
        fi

        # Push top-level train/valid if they exist (for coding domain)
        for f in train.jsonl valid.jsonl; do
            if [ -f "$TRAINER_DIR/data/$f" ]; then
                rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
                    "$TRAINER_DIR/data/$f" \
                    "$REMOTE:$REMOTE_DIR/data/"
            fi
        done

        # Push domain configs
        rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$TRAINER_DIR/domains/" \
            "$REMOTE:$REMOTE_DIR/domains/"

        # Push benchmark tasks
        rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$TRAINER_DIR/benchmarks/"*.jsonl \
            "$REMOTE:$REMOTE_DIR/benchmarks/"

        # Push scripts
        rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$TRAINER_DIR/scripts/" \
            "$REMOTE:$REMOTE_DIR/scripts/"

        # Push requirements
        rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$TRAINER_DIR/requirements-cuda.txt" \
            "$REMOTE:$REMOTE_DIR/"

        # Push open-source datasets
        if [ -d "$TRAINER_DIR/data/open_source" ]; then
            rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
                "$TRAINER_DIR/data/open_source/" \
                "$REMOTE:$REMOTE_DIR/data/open_source/"
        fi

        # Push JS modules needed for remote mining/ingestion
        for f in forge-db.js collector.mjs mine-ground-truth.mjs mine-expanded.mjs mine-autonomous.mjs ingest-datasets.mjs forge-cli.mjs domain-config.mjs serve.mjs self-iterate.mjs; do
            if [ -f "$TRAINER_DIR/$f" ]; then
                rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
                    "$TRAINER_DIR/$f" \
                    "$REMOTE:$REMOTE_DIR/"
            fi
        done

        # Push forge.db for pair tracking
        if [ -f "$TRAINER_DIR/forge.db" ]; then
            rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
                "$TRAINER_DIR/forge.db" \
                "$REMOTE:$REMOTE_DIR/"
        fi
        # Also check db/ subdir
        if [ -f "$TRAINER_DIR/db/forge.db" ]; then
            ssh $SSH_OPTS "$REMOTE" "mkdir -p $REMOTE_DIR/db"
            rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
                "$TRAINER_DIR/db/forge.db" \
                "$REMOTE:$REMOTE_DIR/db/"
        fi

        echo -e "${GREEN}Push complete.${NC}"
        ;;

    pull)
        echo -e "${CYAN}Pulling trained models from $REMOTE...${NC}"

        # Pull adapters
        rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$REMOTE:$REMOTE_DIR/models/adapters/" \
            "$TRAINER_DIR/models/adapters/"

        # Pull GGUF files
        rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$REMOTE:$REMOTE_DIR/models/gguf/" \
            "$TRAINER_DIR/models/gguf/"

        # Pull benchmark results
        rsync -avz --progress $RSYNC_OPTS -e "ssh $SSH_OPTS" \
            "$REMOTE:$REMOTE_DIR/benchmarks/results/" \
            "$TRAINER_DIR/benchmarks/results/" 2>/dev/null || true

        echo -e "${GREEN}Pull complete.${NC}"
        echo ""
        echo "To deploy a pulled GGUF to Ollama:"
        echo "  ls $TRAINER_DIR/models/gguf/"
        echo "  # Then create a Modelfile and run: ollama create familiar-coder:vN -f Modelfile"
        ;;

    full)
        DOMAIN_FLAG=""
        if [ -n "$DOMAIN" ]; then
            DOMAIN_FLAG="--domain $DOMAIN"
            echo -e "${CYAN}Full remote training cycle (domain: $DOMAIN)...${NC}"
        else
            echo -e "${CYAN}Full remote training cycle...${NC}"
        fi
        echo ""

        # Step 1: Push
        echo -e "${CYAN}[1/4] Pushing data...${NC}"
        bash "$0" push $DOMAIN
        echo ""

        # Step 2: Prepare data on remote
        echo -e "${CYAN}[2/4] Preparing data on remote...${NC}"
        ssh $SSH_OPTS "$REMOTE" "export PATH=/usr/local/cuda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:\$PATH && cd $REMOTE_DIR && .venv/bin/python scripts/prepare-data.py $DOMAIN_FLAG"
        echo ""

        # Step 3: Train on remote (CUDA)
        echo -e "${CYAN}[3/4] Training on remote (CUDA)...${NC}"
        ssh $SSH_OPTS "$REMOTE" "export PATH=/usr/local/cuda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:\$PATH && cd $REMOTE_DIR && .venv/bin/python scripts/train-cuda.py $DOMAIN_FLAG"
        echo ""

        # Step 4: Pull results
        echo -e "${CYAN}[4/4] Pulling results...${NC}"
        bash "$0" pull
        echo ""

        echo -e "${GREEN}Remote training cycle complete.${NC}"
        ;;

    status)
        echo -e "${CYAN}Remote server status ($REMOTE):${NC}"
        ssh $SSH_OPTS "$REMOTE" "export PATH=/usr/local/cuda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:\$PATH;
            echo ''
            echo '  GPU:'
            nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader 2>/dev/null || echo '    (nvidia-smi not available)'
            echo ''
            echo '  Training data:'
            if [ -d '$REMOTE_DIR/data/raw' ]; then
                count=\$(find $REMOTE_DIR/data/raw -name '*.jsonl' 2>/dev/null | wc -l)
                echo \"    Raw files: \$count\"
            fi
            if [ -f '$REMOTE_DIR/data/train.jsonl' ]; then
                lines=\$(wc -l < $REMOTE_DIR/data/train.jsonl)
                echo \"    Train examples: \$lines\"
            fi
            echo ''
            echo '  Adapters:'
            ls -d $REMOTE_DIR/models/adapters/v* 2>/dev/null || echo '    (none)'
            echo ''
            echo '  GGUF files:'
            ls -lh $REMOTE_DIR/models/gguf/*.gguf 2>/dev/null || echo '    (none)'
            echo ''
        " 2>&1 || echo -e "${RED}Cannot connect to $REMOTE${NC}"
        ;;

    *)
        echo "The Forge — Remote Sync"
        echo ""
        echo "Usage: bash scripts/sync-remote.sh <command>"
        echo ""
        echo "Commands:"
        echo "  push      Push training data and configs to remote"
        echo "  pull      Pull trained adapters and GGUFs from remote"
        echo "  full      Full cycle: push → prepare → train → pull"
        echo "  status    Check remote server status"
        echo ""
        echo "Environment variables:"
        echo "  FORGE_REMOTE_USER  SSH user (default: j)"
        echo "  FORGE_REMOTE_HOST  SSH host (default: localhost)"
        echo "  FORGE_REMOTE_DIR   Remote trainer dir (default: ~/familiar/trainer)"
        ;;
esac
