#!/usr/bin/env bash
set -euo pipefail

# Familiar — Cross-platform installer
# Supports macOS (Apple Silicon / Intel) and Ubuntu/Linux
# Handles both fresh install and updates

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$HOME/.familiar"
CONFIG_DIR="$DATA_DIR/config"
LOG_DIR="$DATA_DIR/logs"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}  →${NC} $1"; }
ok()    { echo -e "${GREEN}  ✓${NC} $1"; }
warn()  { echo -e "${YELLOW}  !${NC} $1"; }
err()   { echo -e "${RED}  ✗${NC} $1"; }

# ── Detection ────────────────────────────────────────────────────────────────

detect_os() {
  case "$(uname -s)" in
    Darwin) OS="macos" ;;
    Linux)  OS="linux" ;;
    *)      err "Unsupported OS: $(uname -s)"; exit 1 ;;
  esac
}

detect_gpu() {
  GPU="none"
  if [ "$OS" = "macos" ]; then
    # Apple Silicon always has Metal
    if sysctl -n machdep.cpu.brand_string 2>/dev/null | grep -qi "apple"; then
      GPU="metal"
    fi
  elif [ "$OS" = "linux" ]; then
    if command -v nvidia-smi &>/dev/null; then
      GPU="nvidia"
      VRAM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 || echo "0")
      info "NVIDIA GPU detected (${VRAM}MB VRAM)"
    fi
  fi
}

detect_install_type() {
  if [ -d "$DATA_DIR" ] && [ -f "$CONFIG_DIR/familiar.json" ]; then
    INSTALL_TYPE="update"
  else
    INSTALL_TYPE="fresh"
  fi
}

# ── Bun ──────────────────────────────────────────────────────────────────────

install_bun() {
  if command -v bun &>/dev/null; then
    ok "Bun $(bun --version) already installed"
    return
  fi

  info "Installing Bun..."
  if [ "$OS" = "macos" ]; then
    if command -v brew &>/dev/null; then
      brew install oven-sh/bun/bun
    else
      curl -fsSL https://bun.sh/install | bash
    fi
  else
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  fi

  if command -v bun &>/dev/null; then
    ok "Bun $(bun --version) installed"
  else
    err "Bun installation failed"
    exit 1
  fi
}

# ── Dependencies ─────────────────────────────────────────────────────────────

install_deps() {
  info "Installing dependencies..."

  if [ -d "$SCRIPT_DIR/apps/cli" ]; then
    (cd "$SCRIPT_DIR/apps/cli" && bun install --silent 2>/dev/null)
    ok "CLI dependencies installed"
  fi

  if [ -d "$SCRIPT_DIR/mcp-bridge" ] && [ -f "$SCRIPT_DIR/mcp-bridge/package.json" ]; then
    (cd "$SCRIPT_DIR/mcp-bridge" && bun install --silent 2>/dev/null)
    ok "MCP bridge dependencies installed"
  fi

  if [ -d "$SCRIPT_DIR/packages/mcp-server" ]; then
    (cd "$SCRIPT_DIR/packages/mcp-server" && bun install --silent 2>/dev/null)
    ok "MCP server dependencies installed"
  fi
}

# ── CLI Link ─────────────────────────────────────────────────────────────────

link_cli() {
  if [ -d "$SCRIPT_DIR/apps/cli" ]; then
    info "Linking familiar CLI..."
    (cd "$SCRIPT_DIR/apps/cli" && bun link 2>/dev/null)
    ok "familiar CLI linked globally"
  fi
}

# ── Data Directory ───────────────────────────────────────────────────────────

setup_data_dir() {
  if [ "$INSTALL_TYPE" = "update" ]; then
    ok "Data directory exists at $DATA_DIR (preserving existing data)"
    return
  fi

  info "Creating data directory at $DATA_DIR..."
  mkdir -p "$CONFIG_DIR" "$LOG_DIR" \
    "$DATA_DIR/memory" \
    "$DATA_DIR/sessions"

  # Copy example configs
  if [ -f "$SCRIPT_DIR/config/familiar.example.json" ]; then
    cp "$SCRIPT_DIR/config/familiar.example.json" "$CONFIG_DIR/familiar.json"
  fi
  if [ -f "$SCRIPT_DIR/config/.env.example" ]; then
    cp "$SCRIPT_DIR/config/.env.example" "$CONFIG_DIR/.env"
  fi

  # Generate auth token
  TOKEN=$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 64)
  if [ -f "$CONFIG_DIR/familiar.json" ]; then
    # Replace the placeholder token
    if command -v python3 &>/dev/null; then
      python3 -c "
import json, sys
with open('$CONFIG_DIR/familiar.json', 'r') as f:
    c = json.load(f)
c['gateway']['auth']['token'] = '$TOKEN'
with open('$CONFIG_DIR/familiar.json', 'w') as f:
    json.dump(c, f, indent=2)
"
    else
      # Fallback: sed replacement
      sed -i.bak "s/REPLACE_WITH_GENERATED_TOKEN/$TOKEN/" "$CONFIG_DIR/familiar.json"
      rm -f "$CONFIG_DIR/familiar.json.bak"
    fi
  fi
  if [ -f "$CONFIG_DIR/.env" ]; then
    sed -i.bak "s/^FAMILIAR_GATEWAY_TOKEN=$/FAMILIAR_GATEWAY_TOKEN=$TOKEN/" "$CONFIG_DIR/.env"
    rm -f "$CONFIG_DIR/.env.bak"
  fi

  # Copy seed goals
  if [ -f "$SCRIPT_DIR/brain/goals/seed-goals.json" ]; then
    mkdir -p "$DATA_DIR/goals"
    cp "$SCRIPT_DIR/brain/goals/seed-goals.json" "$DATA_DIR/goals/goals.json"
  fi

  # Copy empty hands state
  if [ -f "$SCRIPT_DIR/brain/hands/state.json.example" ]; then
    cp "$SCRIPT_DIR/brain/hands/state.json.example" "$SCRIPT_DIR/brain/hands/state.json"
  fi

  # Copy empty cron jobs
  if [ -f "$SCRIPT_DIR/cron/jobs.example.json" ]; then
    mkdir -p "$DATA_DIR/cron"
    cp "$SCRIPT_DIR/cron/jobs.example.json" "$DATA_DIR/cron/jobs.json"
  fi

  ok "Data directory created with generated auth token"
}

# ── Services ─────────────────────────────────────────────────────────────────

install_services() {
  if [ "$OS" = "macos" ]; then
    install_services_macos
  else
    install_services_linux
  fi
}

install_services_macos() {
  if [ -f "$SCRIPT_DIR/services/install-services.sh" ]; then
    info "Installing macOS services (launchd)..."
    bash "$SCRIPT_DIR/services/install-services.sh" install
    ok "macOS services installed"
  else
    warn "install-services.sh not found, skipping service installation"
  fi
}

install_services_linux() {
  info "Installing Linux services (systemd)..."
  local SYSTEMD_DIR="$HOME/.config/systemd/user"
  mkdir -p "$SYSTEMD_DIR"

  BUN_BIN="$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"

  # Gateway service
  cat > "$SYSTEMD_DIR/familiar-gateway.service" <<EOF
[Unit]
Description=Familiar Gateway
After=network.target

[Service]
Type=simple
ExecStart=/bin/bash $SCRIPT_DIR/services/start-gateway.sh
WorkingDirectory=$SCRIPT_DIR
Restart=always
RestartSec=5
Environment=PATH=$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME

[Install]
WantedBy=default.target
EOF

  # Worker service
  cat > "$SYSTEMD_DIR/familiar-worker.service" <<EOF
[Unit]
Description=Familiar Worker
After=network.target

[Service]
Type=simple
ExecStart=$BUN_BIN $SCRIPT_DIR/services/worker.mjs
WorkingDirectory=$SCRIPT_DIR
Restart=always
RestartSec=5
Environment=PATH=$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME

[Install]
WantedBy=default.target
EOF

  # Forge auto-trainer
  cat > "$SYSTEMD_DIR/familiar-forge-auto.service" <<EOF
[Unit]
Description=Familiar Forge Auto-Trainer
After=network.target

[Service]
Type=simple
ExecStart=$BUN_BIN $SCRIPT_DIR/trainer/forge-auto.mjs --threshold 100 --interval 300
WorkingDirectory=$SCRIPT_DIR/trainer
Restart=always
RestartSec=30
Environment=PATH=$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME

[Install]
WantedBy=default.target
EOF

  # Copy existing systemd units from trainer/services/
  for unit in "$SCRIPT_DIR/trainer/services/"*.service "$SCRIPT_DIR/trainer/services/"*.timer; do
    if [ -f "$unit" ]; then
      cp "$unit" "$SYSTEMD_DIR/"
    fi
  done

  # Enable and start core services
  systemctl --user daemon-reload
  systemctl --user enable familiar-gateway.service
  systemctl --user start familiar-gateway.service 2>/dev/null || true

  # Enable worker if this is a GPU machine
  if [ "$GPU" = "nvidia" ]; then
    systemctl --user enable familiar-worker.service
    systemctl --user start familiar-worker.service 2>/dev/null || true
    ok "Worker service enabled (NVIDIA GPU detected)"
  fi

  ok "Linux systemd services installed"
  info "Check status: systemctl --user status familiar-gateway"
}

# ── Ollama ───────────────────────────────────────────────────────────────────

setup_ollama() {
  if ! command -v ollama &>/dev/null; then
    warn "Ollama not installed. Install it from https://ollama.com"
    warn "Then run: ollama pull llama3.2:3b"
    return
  fi

  ok "Ollama found"

  # Check if base model is pulled
  if ! ollama list 2>/dev/null | grep -q "llama3.2:3b"; then
    echo ""
    read -p "  Pull llama3.2:3b base model for local inference? (y/N) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      info "Pulling llama3.2:3b (this may take a few minutes)..."
      ollama pull llama3.2:3b
      ok "Base model ready"
    fi
  else
    ok "Base model llama3.2:3b already available"
  fi
}

# ── Python (CUDA) ────────────────────────────────────────────────────────────

setup_python_cuda() {
  if [ "$GPU" != "nvidia" ]; then
    return
  fi

  info "Setting up Python environment for CUDA training..."

  if ! command -v python3 &>/dev/null; then
    err "Python 3 not found. Install it: sudo apt install python3 python3-venv python3-pip"
    return
  fi

  VENV_DIR="$SCRIPT_DIR/trainer/.venv"
  if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
  fi

  source "$VENV_DIR/bin/activate"

  if [ -f "$SCRIPT_DIR/trainer/requirements-cuda.txt" ]; then
    pip install -q -r "$SCRIPT_DIR/trainer/requirements-cuda.txt"
    ok "CUDA Python dependencies installed"
  elif [ -f "$SCRIPT_DIR/trainer/requirements.txt" ]; then
    pip install -q -r "$SCRIPT_DIR/trainer/requirements.txt"
    ok "Python dependencies installed"
  fi

  deactivate
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
  echo ""
  echo "  ╔═══════════════════════════════════╗"
  echo "  ║       familiar — setup            ║"
  echo "  ╚═══════════════════════════════════╝"
  echo ""

  detect_os
  detect_gpu
  detect_install_type

  if [ "$INSTALL_TYPE" = "update" ]; then
    info "Update detected — preserving existing data in $DATA_DIR"
  else
    info "Fresh install on $OS (GPU: $GPU)"
  fi

  echo ""

  install_bun
  install_deps
  link_cli
  setup_data_dir
  install_services
  setup_ollama
  setup_python_cuda

  echo ""
  echo "  ╔═══════════════════════════════════╗"
  if [ "$INSTALL_TYPE" = "fresh" ]; then
    echo "  ║       Setup complete!             ║"
  else
    echo "  ║       Update complete!            ║"
  fi
  echo "  ╚═══════════════════════════════════╝"
  echo ""
  echo "  Config:   $CONFIG_DIR/familiar.json"
  echo "  Env:      $CONFIG_DIR/.env"
  echo "  Logs:     $LOG_DIR/"
  echo "  Data:     $DATA_DIR/"
  echo ""
  echo "  Quick start:"
  echo "    familiar              — open the TUI"
  echo "    familiar monitor      — dev dashboard"
  echo "    familiar status       — system health"
  echo "    familiar forge stats  — training pipeline"
  echo ""

  if [ "$INSTALL_TYPE" = "fresh" ]; then
    echo "  Next steps:"
    echo "    1. Edit $CONFIG_DIR/.env with your API keys"
    echo "    2. Run 'familiar' to start the TUI"
    echo ""
  fi
}

main "$@"
