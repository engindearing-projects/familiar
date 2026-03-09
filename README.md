# familiar

> A pair programming buddy that lives in your terminal — local-first, always learning

## What It Does

- Sits alongside your coding tool and observes what you're working on
- Routes between cloud LLMs and your own local model
- Learns from your coding patterns via the Forge training pipeline
- Autonomous hands run scheduled tasks (mining, training, health checks)
- Dev monitor dashboard shows real-time file activity, service health, and inter-service comms

## Quick Start

### macOS

```bash
git clone https://github.com/engindearing-projects/familiar.git
cd familiar
./setup.sh
```

### Ubuntu

```bash
git clone https://github.com/engindearing-projects/familiar.git
cd familiar
./setup.sh
```

The setup script detects your OS, installs dependencies, creates your data directory at `~/.familiar/`, generates an auth token, and installs background services.

## How It Works

### 3-Tier Routing

```
Cloud LLM (Claude/OpenAI/etc) → Gemini Flash → Local Ollama model
```

As your local model improves through training, more requests route locally. The router scores each request by complexity and picks the cheapest model that can handle it.

### The Forge (Training Pipeline)

The Forge is how your local model gets smarter over time:

1. **Mine** — Collects training data from your merged PRs and open-source repos
2. **Prepare** — Formats pairs as instruction/response for fine-tuning
3. **Train** — Runs LoRA/QLoRA training on your base model
4. **Evaluate** — Benchmarks the new model against the previous version
5. **Deploy** — If improved, pushes the new model to Ollama

Your model gets better the more you code.

### Autonomous Hands

Scheduled tasks that run in the background:

| Hand | Schedule | What It Does |
|------|----------|-------------|
| **planner** | Every 30 min | Evaluates goals, checks system health, delegates work |
| **forge-miner** | Daily 4 AM | Mines training data from GitHub repos |
| **forge-trainer** | Daily 2 AM | Triggers training runs |
| **learner** | Daily 5 AM | Daily learning cycle (reflect, learn, ideate) |
| **researcher** | Daily 3 AM | Explores topics autonomously |
| **peer-sync** | Hourly | Exchanges feedback between paired machines |

## GPU Training Machine (Optional)

Familiar supports offloading model training to a separate Ubuntu machine with an NVIDIA GPU. The two machines form a feedback loop.

### What Each Machine Does

**Your Mac (the brain)**
- Runs the gateway, monitor, CLI, and all user-facing services
- Mines training data from your coding sessions
- Routes LLM requests (cloud → local)
- Orchestrates training runs on the Ubuntu machine via SSH

**Ubuntu PC (the muscle)**
- Runs the worker server (port 18792)
- Mines training data autonomously using local Ollama
- Runs CUDA training with QLoRA on your NVIDIA GPU
- Pushes newly mined data back to Mac

### How They Give Each Other Feedback

The peer-sync hand runs hourly on both machines:

1. Mac evaluates Ubuntu's training quality (benchmark scores, pair count)
2. Ubuntu evaluates Mac's planner decisions (task completion, goal progress)
3. Both write constructive feedback to shared reflection files
4. Feedback syncs via the peer-sync hand

### Ubuntu Setup

Requirements: Ubuntu 22.04+, NVIDIA GPU (8GB+ VRAM), SSH access from Mac

```bash
# On the Ubuntu machine:
git clone https://github.com/engindearing-projects/familiar.git
cd familiar
./setup.sh                    # detects Ubuntu + NVIDIA, installs CUDA deps

# Or manual setup:
curl -fsSL https://bun.sh/install | bash
pip install -r trainer/requirements-cuda.txt
ollama pull llama3.2:3b       # or your preferred base model

# Install systemd services:
sudo cp trainer/services/*.service trainer/services/*.timer /etc/systemd/system/
sudo systemctl enable --now forge-miner forge-sync.timer familiar-worker

# On your Mac, configure the pairing:
echo 'WORKER_SSH=user@ubuntu-ip' >> ~/.familiar/config/.env
echo 'WORKER_URL=http://ubuntu-ip:18792' >> ~/.familiar/config/.env
```

### Data Flow

```
Mac mines data → syncs to Ubuntu → Ubuntu trains with CUDA →
model syncs back to Mac → Mac benchmarks → deploys to Ollama
```

### Training: Mac vs Ubuntu

| | Mac (MLX) | Ubuntu (CUDA) |
|---|---|---|
| Framework | MLX (Apple Silicon) | PyTorch + QLoRA |
| Quantization | MLX 4-bit | BitsAndBytes NF4 |
| Speed | Good for small models | Better for 7B+ models |
| VRAM | Shared memory | Dedicated GPU VRAM |

## Tool Integration

Works with any coding tool that supports:

- **OpenAI-compatible API** — point your tool at `http://localhost:18791`
- **MCP protocol** — use the included mcp-bridge or mcp-server package
- **CLI** — just run `familiar`

### Claude Code

Add to your MCP config (`.claude/mcp.json`):

```json
{
  "mcpServers": {
    "familiar": {
      "command": "bun",
      "args": ["run", "/path/to/familiar/mcp-bridge/index.mjs"]
    }
  }
}
```

### OpenCode

The setup script auto-configures OpenCode if it's installed. Or manually create `~/.config/opencode/opencode.json`:

```json
{
  "model": "claude-sub/claude-subscription",
  "provider": {
    "claude-sub": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://localhost:18791/v1" },
      "models": {
        "claude-subscription": {
          "name": "Claude (via Familiar)",
          "limit": { "context": 200000, "output": 65536 }
        }
      }
    }
  }
}
```

## The Monitor Dashboard

Real-time dev observability:

- **File activity** — reads, writes, edits, globs, greps, bash commands
- **Service health** — all launchd/systemd daemons with PIDs
- **Inter-service communication** — proxy→model, gateway→hand, etc.
- **Hands status** — run history and current state

Run: `familiar monitor` or `bun services/monitor.mjs`

## Configuration

```
~/.familiar/              — your data directory (persists across updates)
~/.familiar/config/       — familiar.json + .env
~/.familiar/memory/       — sessions, observations
~/.familiar/logs/         — service logs
~/.familiar/goals/        — autonomous planner goals
```

### Environment Variables

Edit `~/.familiar/config/.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `FAMILIAR_GATEWAY_TOKEN` | Yes | Auth token (auto-generated by setup) |
| `GEMINI_API_KEY` | No | Gemini Flash for silver-tier routing |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `GITHUB_TOKEN` | No | Mining training data from private repos |
| `WORKER_SSH` | No | SSH target for Ubuntu GPU machine |
| `WORKER_URL` | No | Worker HTTP URL for remote training |

## Services

### Core (installed by default)

| Service | Description |
|---------|-------------|
| `familiar-gateway` | WebSocket gateway for all clients |
| `familiar-claude-proxy` | OpenAI-compatible proxy for Claude |
| `familiar-ollama-proxy` | Proxy for local Ollama inference |

### Optional (install with `--all` flag)

| Service | Description |
|---------|-------------|
| `familiar-tunnel` | Cloudflare tunnel for remote access |
| `familiar-activity-sync` | Activity tracking server |
| `familiar-telegram-bridge` | Telegram bot interface |
| `familiar-forge-auto` | Auto-trainer (triggers on pair threshold) |
| `familiar-forge-mine` | Scheduled data mining (4 AM daily) |
| `familiar-learner` | Daily learning cycle (5 AM daily) |
| `familiar-caffeinate` | Prevent sleep (macOS only) |

## Commands

```bash
familiar              # open the TUI
familiar monitor      # dev dashboard
familiar status       # system health
familiar forge stats  # training pipeline status
familiar hand list    # list autonomous hands
familiar hand run <n> # run a hand manually
```

## Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Database**: SQLite (sessions, forge pairs, RAG embeddings)
- **Local AI**: [Ollama](https://ollama.com)
- **Training**: MLX (Mac) / PyTorch + QLoRA (Ubuntu/CUDA)
- **TUI**: [Ink](https://github.com/vadimdemedes/ink) (React for CLI)

## License

MIT
