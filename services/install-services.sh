#!/bin/bash
set -euo pipefail

# Install Familiar services as background daemons.
# Supports macOS (launchd) and Linux (systemd).
#
# Usage:
#   ./services/install-services.sh              # install core services
#   ./services/install-services.sh --all        # install core + optional services
#   ./services/install-services.sh uninstall    # stop and remove all
#   ./services/install-services.sh status       # show service status
#
# Core services (auto-installed):
#   com.familiar.gateway          - WebSocket gateway (port 18789)
#   com.familiar.claude-proxy     - Claude Code proxy (port 18791)
#   com.familiar.ollama-proxy     - Ollama proxy (port 11435)
#
# Optional services (install with --all or individually with --service <name>):
#   com.familiar.tunnel           - Cloudflare quick tunnel
#   com.familiar.activity-sync    - Activity server (port 18790)
#   com.familiar.telegram-bridge  - Telegram bot bridge
#   com.familiar.telegram-push    - Telegram push notifier (every 30 min)
#   com.familiar.forge-auto       - Auto-trainer daemon
#   com.familiar.forge-mine       - Ground-truth data miner (daily 4 AM)
#   com.familiar.learner          - Daily learning cycle (5 AM)
#   com.familiar.caffeinate       - Prevent sleep (macOS only)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAMILIAR_DIR="${FAMILIAR_DIR:-$(dirname "$SCRIPT_DIR")}"
LOG_DIR="$HOME/.familiar/logs"

ACTION="${1:-install}"
INSTALL_ALL=false
INSTALL_SPECIFIC=""

# Parse flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) INSTALL_ALL=true; shift ;;
    --service) INSTALL_SPECIFIC="$2"; shift 2 ;;
    install|uninstall|status) ACTION="$1"; shift ;;
    *) shift ;;
  esac
done

# Detect OS
OS="$(uname -s)"
case "$OS" in
  Darwin) INIT_SYSTEM="launchd" ;;
  Linux)
    if command -v systemctl &>/dev/null; then
      INIT_SYSTEM="systemd"
    else
      echo "  ERROR: Only systemd is supported on Linux."
      exit 1
    fi
    ;;
  *)
    echo "  ERROR: Unsupported OS: $OS"
    exit 1
    ;;
esac

# Resolve bun binary dynamically
BUN_BIN="$(which bun 2>/dev/null || echo "")"
if [ -z "$BUN_BIN" ]; then
  for candidate in /opt/homebrew/bin/bun /usr/local/bin/bun "$HOME/.bun/bin/bun"; do
    if [ -x "$candidate" ]; then
      BUN_BIN="$candidate"
      break
    fi
  done
fi
if [ -z "$BUN_BIN" ]; then
  echo "  ERROR: bun not found. Install it: https://bun.sh/docs/installation"
  exit 1
fi

# Source config/.env for tokens used by services
ENV_FILE="$FAMILIAR_DIR/config/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

# Service categories
CORE_SERVICES=(
  "com.familiar.gateway"
  "com.familiar.claude-proxy"
  "com.familiar.ollama-proxy"
)

OPTIONAL_SERVICES=(
  "com.familiar.tunnel"
  "com.familiar.activity-sync"
  "com.familiar.telegram-bridge"
  "com.familiar.telegram-push"
  "com.familiar.forge-auto"
  "com.familiar.forge-mine"
  "com.familiar.learner"
  "com.familiar.caffeinate"
)

# Build the list of services to install based on flags
get_install_list() {
  if [ -n "$INSTALL_SPECIFIC" ]; then
    echo "$INSTALL_SPECIFIC"
    return
  fi

  for svc in "${CORE_SERVICES[@]}"; do
    echo "$svc"
  done

  if [ "$INSTALL_ALL" = true ]; then
    for svc in "${OPTIONAL_SERVICES[@]}"; do
      # caffeinate is macOS only
      if [ "$svc" = "com.familiar.caffeinate" ] && [ "$INIT_SYSTEM" != "launchd" ]; then
        continue
      fi
      echo "$svc"
    done
  fi
}

ALL_SERVICES=( "${CORE_SERVICES[@]}" "${OPTIONAL_SERVICES[@]}" )

mkdir -p "$LOG_DIR"

# ─── macOS launchd ──────────────────────────────────────────────────────────

generate_plist() {
  local label="$1"
  local LA_DIR="$HOME/Library/LaunchAgents"
  mkdir -p "$LA_DIR"
  local file="$LA_DIR/$label.plist"

  case "$label" in
    com.familiar.gateway)
      cat > "$file" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$SCRIPT_DIR/start-gateway.sh</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$LOG_DIR/gateway.log</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/gateway.err.log</string>
    <key>WorkingDirectory</key><string>$FAMILIAR_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key><string>$HOME</string>
    </dict>
</dict>
</plist>
PLIST
      ;;

    com.familiar.claude-proxy)
      cat > "$file" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BUN_BIN</string>
        <string>claude-code-proxy.mjs</string>
    </array>
    <key>WorkingDirectory</key><string>$SCRIPT_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>CLAUDE_PROXY_PORT</key><string>18791</string>
        <key>CLAUDE_PROXY_MODEL</key><string>opus</string>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>FAMILIAR_TRAINING_MODE</key><string>true</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$LOG_DIR/claude-proxy.log</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/claude-proxy.error.log</string>
    <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
PLIST
      ;;

    com.familiar.tunnel)
      cat > "$file" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$SCRIPT_DIR/start-tunnel.sh</string>
    </array>
    <key>WorkingDirectory</key><string>$FAMILIAR_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>FAMILIAR_PROXY_PORT</key><string>18791</string>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key><string>$HOME</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$LOG_DIR/tunnel-launchd.log</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/tunnel-launchd.error.log</string>
    <key>ThrottleInterval</key><integer>30</integer>
</dict>
</plist>
PLIST
      ;;

    com.familiar.ollama-proxy)
      cat > "$file" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BUN_BIN</string>
        <string>run</string>
        <string>ollama-proxy.mjs</string>
    </array>
    <key>WorkingDirectory</key><string>$SCRIPT_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>OLLAMA_PROXY_PORT</key><string>11435</string>
        <key>OLLAMA_URL</key><string>http://localhost:11434</string>
        <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$LOG_DIR/ollama-proxy.log</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/ollama-proxy.error.log</string>
    <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
PLIST
      ;;

    com.familiar.activity-sync)
      cat > "$file" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BUN_BIN</string>
        <string>run</string>
        <string>activity-server.mjs</string>
    </array>
    <key>WorkingDirectory</key><string>$SCRIPT_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>ACTIVITY_PORT</key><string>18790</string>
        <key>ACTIVITY_BIND</key><string>0.0.0.0</string>
        <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$LOG_DIR/activity-sync.log</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/activity-sync.error.log</string>
    <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
PLIST
      ;;

    com.familiar.telegram-bridge)
      local BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
      if [ -z "$BOT_TOKEN" ]; then
        echo "  WARN: TELEGRAM_BOT_TOKEN not set, telegram-bridge may not start"
      fi
      cat > "$file" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BUN_BIN</string>
        <string>run</string>
        <string>$SCRIPT_DIR/telegram-bridge.mjs</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
        <key>HOME</key><string>$HOME</string>
        <key>TELEGRAM_BOT_TOKEN</key><string>$BOT_TOKEN</string>
        <key>TG_BRIDGE_ALLOW_ALL</key><string>1</string>
    </dict>
    <key>WorkingDirectory</key><string>$FAMILIAR_DIR</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$LOG_DIR/telegram-bridge.log</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/telegram-bridge.error.log</string>
</dict>
</plist>
PLIST
      ;;

    com.familiar.telegram-push)
      local PUSH_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
      local PUSH_CHAT_ID="${TELEGRAM_CHAT_ID:-}"
      cat > "$file" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BUN_BIN</string>
        <string>run</string>
        <string>$FAMILIAR_DIR/cron/telegram-push.mjs</string>
    </array>
    <key>StartInterval</key><integer>1800</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
        <key>HOME</key><string>$HOME</string>
        <key>TELEGRAM_BOT_TOKEN</key><string>$PUSH_BOT_TOKEN</string>
        <key>TELEGRAM_CHAT_ID</key><string>$PUSH_CHAT_ID</string>
    </dict>
    <key>RunAtLoad</key><false/>
    <key>StandardOutPath</key><string>$LOG_DIR/telegram-push.log</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/telegram-push.error.log</string>
    <key>WorkingDirectory</key><string>$FAMILIAR_DIR</string>
</dict>
</plist>
PLIST
      ;;

    com.familiar.forge-auto)
      cat > "$file" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BUN_BIN</string>
        <string>$FAMILIAR_DIR/trainer/forge-auto.mjs</string>
        <string>--threshold</string>
        <string>100</string>
        <string>--interval</string>
        <string>300</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$LOG_DIR/forge-auto.log</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/forge-auto.err.log</string>
    <key>WorkingDirectory</key><string>$FAMILIAR_DIR/trainer</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key><string>$HOME</string>
    </dict>
</dict>
</plist>
PLIST
      ;;

    com.familiar.forge-mine)
      cat > "$file" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>$BUN_BIN $FAMILIAR_DIR/trainer/mine-ground-truth.mjs 2>&amp;1; $BUN_BIN $FAMILIAR_DIR/trainer/mine-expanded.mjs 2>&amp;1</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key><integer>4</integer>
        <key>Minute</key><integer>0</integer>
    </dict>
    <key>StandardOutPath</key><string>$LOG_DIR/forge-mine.log</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/forge-mine.err.log</string>
    <key>WorkingDirectory</key><string>$FAMILIAR_DIR/trainer</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key><string>$HOME</string>
    </dict>
</dict>
</plist>
PLIST
      ;;

    com.familiar.learner)
      cat > "$file" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BUN_BIN</string>
        <string>$FAMILIAR_DIR/brain/learner.mjs</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key><integer>5</integer>
        <key>Minute</key><integer>0</integer>
    </dict>
    <key>StandardOutPath</key><string>$LOG_DIR/learner.log</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/learner.err.log</string>
    <key>WorkingDirectory</key><string>$FAMILIAR_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key><string>$HOME</string>
    </dict>
</dict>
</plist>
PLIST
      ;;

    com.familiar.caffeinate)
      cat > "$file" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/caffeinate</string>
        <string>-dis</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
</dict>
</plist>
PLIST
      ;;

  esac
}

# ─── Linux systemd ──────────────────────────────────────────────────────────

generate_systemd_unit() {
  local label="$1"
  local unit_name="${label//com.familiar./familiar-}"
  local UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  local file="$UNIT_DIR/$unit_name.service"

  local common_env="Environment=PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.bun/bin"

  case "$label" in
    com.familiar.gateway)
      cat > "$file" <<UNIT
[Unit]
Description=Familiar Gateway
After=network.target

[Service]
Type=simple
ExecStart=/bin/bash $SCRIPT_DIR/start-gateway.sh
WorkingDirectory=$FAMILIAR_DIR
$common_env
Environment=HOME=$HOME
Restart=always
RestartSec=5
StandardOutput=append:$LOG_DIR/gateway.log
StandardError=append:$LOG_DIR/gateway.err.log

[Install]
WantedBy=default.target
UNIT
      ;;

    com.familiar.claude-proxy)
      cat > "$file" <<UNIT
[Unit]
Description=Familiar Claude Proxy
After=network.target

[Service]
Type=simple
ExecStart=$BUN_BIN claude-code-proxy.mjs
WorkingDirectory=$SCRIPT_DIR
$common_env
Environment=CLAUDE_PROXY_PORT=18791
Environment=CLAUDE_PROXY_MODEL=opus
Environment=FAMILIAR_TRAINING_MODE=true
Restart=always
RestartSec=10
StandardOutput=append:$LOG_DIR/claude-proxy.log
StandardError=append:$LOG_DIR/claude-proxy.error.log

[Install]
WantedBy=default.target
UNIT
      ;;

    com.familiar.ollama-proxy)
      cat > "$file" <<UNIT
[Unit]
Description=Familiar Ollama Proxy
After=network.target

[Service]
Type=simple
ExecStart=$BUN_BIN run ollama-proxy.mjs
WorkingDirectory=$SCRIPT_DIR
$common_env
Environment=OLLAMA_PROXY_PORT=11435
Environment=OLLAMA_URL=http://localhost:11434
Restart=always
RestartSec=10
StandardOutput=append:$LOG_DIR/ollama-proxy.log
StandardError=append:$LOG_DIR/ollama-proxy.error.log

[Install]
WantedBy=default.target
UNIT
      ;;

    com.familiar.tunnel)
      cat > "$file" <<UNIT
[Unit]
Description=Familiar Cloudflare Tunnel
After=network.target

[Service]
Type=simple
ExecStart=/bin/bash $SCRIPT_DIR/start-tunnel.sh
WorkingDirectory=$FAMILIAR_DIR
$common_env
Environment=HOME=$HOME
Environment=FAMILIAR_PROXY_PORT=18791
Restart=always
RestartSec=30
StandardOutput=append:$LOG_DIR/tunnel.log
StandardError=append:$LOG_DIR/tunnel.error.log

[Install]
WantedBy=default.target
UNIT
      ;;

    com.familiar.activity-sync)
      cat > "$file" <<UNIT
[Unit]
Description=Familiar Activity Sync
After=network.target

[Service]
Type=simple
ExecStart=$BUN_BIN run activity-server.mjs
WorkingDirectory=$SCRIPT_DIR
$common_env
Environment=ACTIVITY_PORT=18790
Environment=ACTIVITY_BIND=0.0.0.0
Restart=always
RestartSec=10
StandardOutput=append:$LOG_DIR/activity-sync.log
StandardError=append:$LOG_DIR/activity-sync.error.log

[Install]
WantedBy=default.target
UNIT
      ;;

    com.familiar.telegram-bridge)
      local BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
      if [ -z "$BOT_TOKEN" ]; then
        echo "  WARN: TELEGRAM_BOT_TOKEN not set, telegram-bridge may not start"
      fi
      cat > "$file" <<UNIT
[Unit]
Description=Familiar Telegram Bridge
After=network.target

[Service]
Type=simple
ExecStart=$BUN_BIN run $SCRIPT_DIR/telegram-bridge.mjs
WorkingDirectory=$FAMILIAR_DIR
$common_env
Environment=HOME=$HOME
Environment=TELEGRAM_BOT_TOKEN=$BOT_TOKEN
Environment=TG_BRIDGE_ALLOW_ALL=1
Restart=always
RestartSec=5
StandardOutput=append:$LOG_DIR/telegram-bridge.log
StandardError=append:$LOG_DIR/telegram-bridge.error.log

[Install]
WantedBy=default.target
UNIT
      ;;

    com.familiar.telegram-push)
      local PUSH_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
      local PUSH_CHAT_ID="${TELEGRAM_CHAT_ID:-}"
      cat > "$file" <<UNIT
[Unit]
Description=Familiar Telegram Push

[Service]
Type=oneshot
ExecStart=$BUN_BIN run $FAMILIAR_DIR/cron/telegram-push.mjs
WorkingDirectory=$FAMILIAR_DIR
$common_env
Environment=HOME=$HOME
Environment=TELEGRAM_BOT_TOKEN=$PUSH_BOT_TOKEN
Environment=TELEGRAM_CHAT_ID=$PUSH_CHAT_ID
StandardOutput=append:$LOG_DIR/telegram-push.log
StandardError=append:$LOG_DIR/telegram-push.error.log
UNIT

      # Also create the timer
      cat > "$UNIT_DIR/$unit_name.timer" <<TIMER
[Unit]
Description=Familiar Telegram Push Timer

[Timer]
OnBootSec=5min
OnUnitActiveSec=30min

[Install]
WantedBy=timers.target
TIMER
      ;;

    com.familiar.forge-auto)
      cat > "$file" <<UNIT
[Unit]
Description=Familiar Forge Auto-Trainer
After=network.target

[Service]
Type=simple
ExecStart=$BUN_BIN $FAMILIAR_DIR/trainer/forge-auto.mjs --threshold 100 --interval 300
WorkingDirectory=$FAMILIAR_DIR/trainer
$common_env
Environment=HOME=$HOME
Restart=always
RestartSec=10
StandardOutput=append:$LOG_DIR/forge-auto.log
StandardError=append:$LOG_DIR/forge-auto.err.log

[Install]
WantedBy=default.target
UNIT
      ;;

    com.familiar.forge-mine)
      cat > "$file" <<UNIT
[Unit]
Description=Familiar Forge Miner

[Service]
Type=oneshot
ExecStart=/bin/bash -c '$BUN_BIN $FAMILIAR_DIR/trainer/mine-ground-truth.mjs 2>&1; $BUN_BIN $FAMILIAR_DIR/trainer/mine-expanded.mjs 2>&1'
WorkingDirectory=$FAMILIAR_DIR/trainer
$common_env
Environment=HOME=$HOME
StandardOutput=append:$LOG_DIR/forge-mine.log
StandardError=append:$LOG_DIR/forge-mine.err.log
UNIT

      cat > "$UNIT_DIR/$unit_name.timer" <<TIMER
[Unit]
Description=Familiar Forge Miner Timer

[Timer]
OnCalendar=*-*-* 04:00:00

[Install]
WantedBy=timers.target
TIMER
      ;;

    com.familiar.learner)
      cat > "$file" <<UNIT
[Unit]
Description=Familiar Learner

[Service]
Type=oneshot
ExecStart=$BUN_BIN $FAMILIAR_DIR/brain/learner.mjs
WorkingDirectory=$FAMILIAR_DIR
$common_env
Environment=HOME=$HOME
StandardOutput=append:$LOG_DIR/learner.log
StandardError=append:$LOG_DIR/learner.err.log
UNIT

      cat > "$UNIT_DIR/$unit_name.timer" <<TIMER
[Unit]
Description=Familiar Learner Timer

[Timer]
OnCalendar=*-*-* 05:00:00

[Install]
WantedBy=timers.target
TIMER
      ;;

    com.familiar.caffeinate)
      # caffeinate is macOS only, skip on Linux
      echo "  SKIP: caffeinate is macOS only"
      return
      ;;
  esac
}

# ─── Install / Uninstall / Status ───────────────────────────────────────────

install_launchd() {
  local LA_DIR="$HOME/Library/LaunchAgents"
  local DOMAIN_TARGET="gui/$(id -u)"
  mkdir -p "$LA_DIR"

  local services=()
  while IFS= read -r line; do services+=("$line"); done < <(get_install_list)

  echo ""
  echo "  Familiar - Service Installer (macOS launchd)"
  echo ""

  echo "  Installing services..."
  for svc in "${services[@]}"; do
    generate_plist "$svc"
    launchctl bootstrap "$DOMAIN_TARGET" "$LA_DIR/$svc.plist" 2>/dev/null || true
    echo "    + $svc"
  done

  echo ""
  echo "  All services installed."
  echo "  Logs: $LOG_DIR/"
  echo "  Status: launchctl list | grep familiar"
  echo ""
}

install_systemd() {
  local UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"

  local services=()
  while IFS= read -r line; do services+=("$line"); done < <(get_install_list)

  echo ""
  echo "  Familiar - Service Installer (Linux systemd)"
  echo ""

  echo "  Installing services..."
  for svc in "${services[@]}"; do
    generate_systemd_unit "$svc"
    local unit_name="${svc//com.familiar./familiar-}"

    systemctl --user daemon-reload
    systemctl --user enable "$unit_name.service" 2>/dev/null || true
    systemctl --user start "$unit_name.service" 2>/dev/null || true

    # Enable timers for scheduled services
    if [ -f "$UNIT_DIR/$unit_name.timer" ]; then
      systemctl --user enable "$unit_name.timer" 2>/dev/null || true
      systemctl --user start "$unit_name.timer" 2>/dev/null || true
      echo "    + $svc (with timer)"
    else
      echo "    + $svc"
    fi
  done

  echo ""
  echo "  All services installed."
  echo "  Logs: $LOG_DIR/"
  echo "  Status: systemctl --user list-units 'familiar-*'"
  echo ""
}

uninstall_launchd() {
  local LA_DIR="$HOME/Library/LaunchAgents"
  local DOMAIN_TARGET="gui/$(id -u)"

  echo ""
  echo "  Removing all familiar services (launchd)..."
  for svc in "${ALL_SERVICES[@]}"; do
    launchctl bootout "$DOMAIN_TARGET/$svc" 2>/dev/null || true
    rm -f "$LA_DIR/$svc.plist"
    echo "    - $svc"
  done
  echo "  Done."
  echo ""
}

uninstall_systemd() {
  local UNIT_DIR="$HOME/.config/systemd/user"

  echo ""
  echo "  Removing all familiar services (systemd)..."
  for svc in "${ALL_SERVICES[@]}"; do
    local unit_name="${svc//com.familiar./familiar-}"
    systemctl --user stop "$unit_name.service" 2>/dev/null || true
    systemctl --user disable "$unit_name.service" 2>/dev/null || true
    rm -f "$UNIT_DIR/$unit_name.service"

    if [ -f "$UNIT_DIR/$unit_name.timer" ]; then
      systemctl --user stop "$unit_name.timer" 2>/dev/null || true
      systemctl --user disable "$unit_name.timer" 2>/dev/null || true
      rm -f "$UNIT_DIR/$unit_name.timer"
    fi
    echo "    - $svc"
  done
  systemctl --user daemon-reload
  echo "  Done."
  echo ""
}

show_status_launchd() {
  echo ""
  echo "  Familiar Services (launchd)"
  echo ""
  launchctl list 2>/dev/null | head -1
  launchctl list 2>/dev/null | grep familiar || echo "  (no services running)"
  echo ""
}

show_status_systemd() {
  echo ""
  echo "  Familiar Services (systemd)"
  echo ""
  systemctl --user list-units 'familiar-*' --no-pager 2>/dev/null || echo "  (no services running)"
  echo ""
  # Also show timers
  systemctl --user list-timers 'familiar-*' --no-pager 2>/dev/null || true
  echo ""
}

case "$ACTION" in
  install)
    if [ "$INIT_SYSTEM" = "launchd" ]; then
      install_launchd
    else
      install_systemd
    fi
    ;;
  uninstall)
    if [ "$INIT_SYSTEM" = "launchd" ]; then
      uninstall_launchd
    else
      uninstall_systemd
    fi
    ;;
  status)
    if [ "$INIT_SYSTEM" = "launchd" ]; then
      show_status_launchd
    else
      show_status_systemd
    fi
    ;;
  *)
    echo "Usage: $0 [install|uninstall|status] [--all] [--service <name>]"
    exit 1
    ;;
esac
