#!/usr/bin/env bun

// Familiar CLI — get your familiar
// Usage:
//   familiar                  Interactive TUI (chat)
//   familiar "question"       One-shot query
//   familiar init             Setup wizard
//   familiar status           Service health table
//   familiar doctor           Diagnostics & self-healing
//   familiar web              Open web UI (auto-authenticated)
//   familiar start            Start all services
//   familiar stop             Stop all services
//   familiar -h, --help       Show help

import chalk from "chalk";
import { findConfig } from "../lib/paths.js";

const VERSION = "1.0.0";

const HELP = `
  ${chalk.bold("familiar")} v${VERSION} — get your familiar

  ${chalk.cyan("Usage:")}
    familiar                     Interactive chat (TUI)
    familiar "your question"     One-shot query
    familiar init                Setup wizard
    familiar status              Service health
    familiar doctor [--fix]      Diagnostics
    familiar web [port]          Open web UI (auto-authenticated)
    familiar start               Start all services
    familiar stop                Stop all services
    familiar observe [type] <text> [--project p] [--tag t]
                                 Save an observation to memory
    familiar forge <cmd>         Training pipeline (status, train, eval, compare, data, rollback)
    familiar open [name]         Launch cmux terminal workspace

  ${chalk.cyan("Options:")}
    -s, --session <key>   Session key (default: familiar:cli:main)
    --coach               Start with coaching mode enabled
    -h, --help            Show this help
    -v, --version         Show version

  ${chalk.cyan("Chat commands:")}
    /quit, /exit, /q           Exit
    /clear                     Clear screen
    /session                   Show session key
    /help                      Available commands
    /status                    Inline service health
    /memory [query]            Search memory DB
    /observe <text>            Save observation to memory
    /coach                     Toggle coaching mode

  ${chalk.dim("familiar.run")}
`;

// Subcommands that map to command modules
const SUBCOMMANDS = new Set(["init", "status", "doctor", "start", "stop", "observe", "web", "forge", "open"]);

async function main() {
  const args = process.argv.slice(2);

  // Global flags
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
  }

  // Extract --session / -s before routing
  let sessionKey = "familiar:cli:main";
  const sessionIdx = args.findIndex((a) => a === "--session" || a === "-s");
  if (sessionIdx !== -1) {
    sessionKey = args[sessionIdx + 1] || sessionKey;
    args.splice(sessionIdx, 2);
  }

  // Extract --coach flag
  let coach = false;
  const coachIdx = args.indexOf("--coach");
  if (coachIdx !== -1) {
    coach = true;
    args.splice(coachIdx, 1);
  }

  // Route to subcommand or chat
  const sub = args[0];

  if (!sub || (!SUBCOMMANDS.has(sub) && !sub.startsWith("-"))) {
    // First-run detection — if no config exists, launch the setup wizard
    if (!findConfig()) {
      console.log(chalk.cyan("\n  Welcome to Familiar!\n"));
      console.log(chalk.gray("  No configuration found. Starting setup wizard...\n"));
      const { run } = await import("../commands/init.mjs");
      return run({ args: [] });
    }

    // No subcommand = chat mode
    // If there are args that aren't flags, treat as one-shot
    const oneshot = args.length > 0 ? args.join(" ") : null;
    const { run } = await import("../commands/chat.mjs");
    return run({ oneshot, sessionKey, coach });
  }

  // Pass remaining args to the subcommand
  const subArgs = args.slice(1);

  switch (sub) {
    case "init": {
      const { run } = await import("../commands/init.mjs");
      return run({ args: subArgs });
    }
    case "status": {
      const { run } = await import("../commands/status.mjs");
      return run({ args: subArgs });
    }
    case "doctor": {
      const { run } = await import("../commands/doctor.mjs");
      return run({ args: subArgs });
    }
    case "start": {
      const { run } = await import("../commands/start.mjs");
      return run({ args: subArgs });
    }
    case "stop": {
      const { run } = await import("../commands/stop.mjs");
      return run({ args: subArgs });
    }
    case "observe": {
      const { run } = await import("../commands/observe.mjs");
      return run({ args: subArgs });
    }
    case "web": {
      const { run } = await import("../commands/web.mjs");
      return run({ args: subArgs });
    }
    case "forge": {
      const { run } = await import("../commands/forge.mjs");
      return run({ args: subArgs });
    }
    case "open": {
      const { run } = await import("../commands/open.mjs");
      return run({ args: subArgs });
    }
    default:
      console.error(chalk.red(`Unknown command: ${sub}`));
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(chalk.red(err.message));
  process.exit(1);
});
