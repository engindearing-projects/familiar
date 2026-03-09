#!/usr/bin/env bash
set -euo pipefail

# The Forge — Remote Training Server Setup
# Sets up a Linux machine with NVIDIA GPU for model training.
# Run this on the remote PC, not on your Mac.
#
# Prerequisites: Python 3.10+, NVIDIA drivers, CUDA toolkit
#
# Usage:
#   bash setup-remote.sh                    # full setup
#   bash setup-remote.sh --check            # check environment only
#   bash setup-remote.sh --sync-only        # just sync training data

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TRAINER_DIR="$(dirname "$SCRIPT_DIR")"
VENV_DIR="$TRAINER_DIR/.venv"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}=== The Forge — Remote Server Setup ===${NC}"
echo ""

# ── Check mode ─────────────────────────────────────────────────────────────

if [ "${1:-}" = "--check" ]; then
    echo "Checking environment..."
    echo ""

    # Python
    if command -v python3 &>/dev/null; then
        PYVER=$(python3 --version 2>&1)
        echo -e "  ${GREEN}✓${NC} Python:    $PYVER"
    else
        echo -e "  ${RED}✗${NC} Python:    not found"
    fi

    # NVIDIA GPU
    if command -v nvidia-smi &>/dev/null; then
        GPU_INFO=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -1)
        echo -e "  ${GREEN}✓${NC} GPU:       $GPU_INFO"
        CUDA_VER=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)
        echo -e "  ${GREEN}✓${NC} Driver:    $CUDA_VER"
    else
        echo -e "  ${RED}✗${NC} nvidia-smi not found"
    fi

    # CUDA
    if command -v nvcc &>/dev/null; then
        CUDA_VER=$(nvcc --version 2>&1 | grep "release" | awk '{print $6}')
        echo -e "  ${GREEN}✓${NC} CUDA:      $CUDA_VER"
    else
        echo -e "  ${YELLOW}!${NC} nvcc not found (CUDA toolkit not in PATH)"
    fi

    # Ollama
    if command -v ollama &>/dev/null; then
        OLLAMA_VER=$(ollama --version 2>&1 | head -1)
        echo -e "  ${GREEN}✓${NC} Ollama:    $OLLAMA_VER"
    else
        echo -e "  ${YELLOW}!${NC} Ollama:    not installed (needed for model deployment)"
    fi

    # Venv
    if [ -d "$VENV_DIR" ]; then
        echo -e "  ${GREEN}✓${NC} Venv:      $VENV_DIR"
    else
        echo -e "  ${YELLOW}!${NC} Venv:      not set up (run setup without --check)"
    fi

    echo ""
    exit 0
fi

# ── Sync mode ──────────────────────────────────────────────────────────────

if [ "${1:-}" = "--sync-only" ]; then
    MAC_HOST="${2:-}"
    if [ -z "$MAC_HOST" ]; then
        echo "Usage: bash setup-remote.sh --sync-only <mac-host>"
        echo "  e.g. bash setup-remote.sh --sync-only user@your-mac-ip"
        exit 1
    fi
    echo "Syncing training data from $MAC_HOST..."
    rsync -avz --progress "$MAC_HOST:~/familiar/trainer/data/raw/" "$TRAINER_DIR/data/raw/"
    echo -e "${GREEN}Sync complete.${NC}"
    exit 0
fi

# ── Full setup ─────────────────────────────────────────────────────────────

# Step 1: Check prerequisites
echo -e "${CYAN}Step 1: Checking prerequisites...${NC}"

# Python
PYTHON=""
for p in python3.12 python3.11 python3.10 python3; do
    if command -v "$p" &>/dev/null; then
        PYTHON="$p"
        break
    fi
done

if [ -z "$PYTHON" ]; then
    echo -e "${RED}Python 3.10+ not found. Install with:${NC}"
    echo "  sudo apt install python3 python3-venv python3-pip"
    exit 1
fi

PYVER=$($PYTHON --version 2>&1)
echo "  Python: $PYVER ($PYTHON)"

# NVIDIA GPU check
if ! command -v nvidia-smi &>/dev/null; then
    echo -e "${RED}nvidia-smi not found. Install NVIDIA drivers:${NC}"
    echo "  sudo apt install nvidia-driver-550"
    exit 1
fi

GPU_INFO=$(nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader 2>/dev/null | head -1)
echo "  GPU: $GPU_INFO"

GPU_VRAM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')
echo "  VRAM: ${GPU_VRAM}MB"

if [ "$GPU_VRAM" -lt 6000 ]; then
    echo -e "${YELLOW}  Warning: <6GB VRAM. Training will use aggressive quantization.${NC}"
fi

# Step 2: Create directories
echo ""
echo -e "${CYAN}Step 2: Creating directories...${NC}"
dirs=(
    "$TRAINER_DIR/data/raw"
    "$TRAINER_DIR/data/traces"
    "$TRAINER_DIR/models/base"
    "$TRAINER_DIR/models/adapters"
    "$TRAINER_DIR/models/fused"
    "$TRAINER_DIR/models/gguf"
    "$TRAINER_DIR/benchmarks/results"
    "$TRAINER_DIR/db"
    "$TRAINER_DIR/logs"
    "$TRAINER_DIR/domains"
)
for d in "${dirs[@]}"; do
    mkdir -p "$d"
done
echo "  Created ${#dirs[@]} directories"

# Step 3: Set up Python venv
echo ""
echo -e "${CYAN}Step 3: Setting up Python environment...${NC}"

if [ ! -d "$VENV_DIR" ]; then
    echo "  Creating virtual environment..."
    $PYTHON -m venv "$VENV_DIR"
else
    echo "  Virtual environment already exists"
fi

source "$VENV_DIR/bin/activate"

echo "  Installing CUDA training dependencies..."
pip install --upgrade pip --quiet
pip install -r "$TRAINER_DIR/requirements-cuda.txt" --quiet

# Verify PyTorch CUDA
TORCH_CUDA=$($VENV_DIR/bin/python -c "import torch; print(f'PyTorch {torch.__version__}, CUDA: {torch.cuda.is_available()}, Device: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else \"N/A\"}')" 2>&1)
echo "  $TORCH_CUDA"

if echo "$TORCH_CUDA" | grep -q "CUDA: False"; then
    echo -e "${YELLOW}  Warning: PyTorch doesn't see CUDA. You may need:${NC}"
    echo "    pip install torch --index-url https://download.pytorch.org/whl/cu124"
fi

# Step 4: Download base model
echo ""
echo -e "${CYAN}Step 4: Base model...${NC}"

BASE_MODEL_DIR="$TRAINER_DIR/models/base/Qwen3-Coder-30B-A3B-Instruct"
if [ -d "$BASE_MODEL_DIR" ] && [ -f "$BASE_MODEL_DIR/config.json" ]; then
    echo "  Base model already downloaded"
else
    echo "  Downloading Qwen3-Coder-30B-A3B-Instruct from HuggingFace..."
    echo "  This will take a while (~60GB)..."
    $VENV_DIR/bin/python -c "
from huggingface_hub import snapshot_download
snapshot_download(
    'Qwen/Qwen3-Coder-30B-A3B-Instruct',
    local_dir='$BASE_MODEL_DIR',
    local_dir_use_symlinks=False,
)
print('  Download complete.')
"
fi

# Step 5: Install Ollama (if not present)
echo ""
echo -e "${CYAN}Step 5: Ollama...${NC}"

if command -v ollama &>/dev/null; then
    echo "  Ollama already installed"
else
    echo "  Installing Ollama..."
    curl -fsSL https://ollama.com/install.sh | sh
fi

# Step 6: Install llama.cpp tools
echo ""
echo -e "${CYAN}Step 6: GGUF conversion tools...${NC}"

LLAMA_DIR="$TRAINER_DIR/tools/llama.cpp"
if [ -d "$LLAMA_DIR" ]; then
    echo "  llama.cpp already cloned"
else
    echo "  Cloning llama.cpp (for convert_hf_to_gguf.py)..."
    git clone --depth 1 https://github.com/ggml-org/llama.cpp.git "$LLAMA_DIR"
fi

# Check for llama-quantize binary
if command -v llama-quantize &>/dev/null; then
    echo "  llama-quantize: found"
else
    echo -e "${YELLOW}  llama-quantize not found. Build it:${NC}"
    echo "    cd $LLAMA_DIR && mkdir build && cd build && cmake .. -DGGML_CUDA=ON && cmake --build . --config Release -j"
fi

# Summary
echo ""
echo -e "${GREEN}=== Setup Complete ===${NC}"
echo ""
echo "  GPU:     $GPU_INFO"
echo "  Python:  $PYVER"
echo "  Venv:    $VENV_DIR"
echo "  Base:    $BASE_MODEL_DIR"
echo ""
echo -e "${CYAN}Next steps:${NC}"
echo "  1. Sync training data from your Mac:"
echo "     rsync -avz mac-user@mac-ip:~/familiar/trainer/data/raw/ ~/familiar/trainer/data/raw/"
echo ""
echo "  2. Prepare training data:"
echo "     $VENV_DIR/bin/python scripts/prepare-data.py"
echo ""
echo "  3. Train (uses PyTorch + CUDA, not MLX):"
echo "     $VENV_DIR/bin/python scripts/train-cuda.py"
echo ""
echo "  4. Convert to GGUF and copy back to Mac:"
echo "     $VENV_DIR/bin/python scripts/fuse-and-deploy.py"
echo "     scp models/gguf/familiar-coder-*.gguf mac-user@mac-ip:~/familiar/trainer/models/gguf/"
echo ""
