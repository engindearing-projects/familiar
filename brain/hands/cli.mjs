#!/usr/bin/env bun

// Hands CLI — manage autonomous capability packages
//
// Usage:
//   bun brain/hands/cli.mjs list                    — list all hands
//   bun brain/hands/cli.mjs status <name>           — detailed status + metrics
//   bun brain/hands/cli.mjs activate <name>         — activate a hand
//   bun brain/hands/cli.mjs pause <name>            — pause a hand
//   bun brain/hands/cli.mjs resume <name>           — resume a paused hand
//   bun brain/hands/cli.mjs deactivate <name>       — deactivate a hand
//   bun brain/hands/cli.mjs run <name> [--dry-run]  — run a hand now
//   bun brain/hands/cli.mjs activate-all            — activate all hands
//   bun brain/hands/cli.mjs metrics                 — show metrics for all hands

import { HandRegistry } from "./registry.mjs";
import { runHand } from "./runner.mjs";

const registry = new HandRegistry();
registry.load();

const [cmd, arg] = process.argv.slice(2);
const dryRun = process.argv.includes("--dry-run");

switch (cmd) {
  case "list":
  case undefined: {
    const hands = registry.list();
    if (hands.length === 0) {
      console.log("No hands installed.");
      break;
    }
    console.log("Hands:\n");
    for (const h of hands) {
      const icon = {
        active: " [ACTIVE]",
        inactive: " [ off  ]",
        paused: " [PAUSED]",
        running: " [ RUN  ]",
        error: " [ERROR ]",
      }[h.status] || `[${h.status}]`;
      console.log(`  ${icon} ${h.name}`);
      console.log(`         ${h.description}`);
      console.log(`         Schedule: ${h.schedule} | Runs: ${h.runCount} | Last: ${h.lastRun || "never"}`);
      console.log();
    }
    break;
  }

  case "status": {
    if (!arg) { console.error("Usage: status <hand-name>"); process.exit(1); }
    const metrics = registry.getMetrics(arg);
    if (!metrics) { console.error(`Hand "${arg}" not found`); process.exit(1); }
    console.log(`Hand: ${metrics.name}`);
    console.log(`Status: ${metrics.status}`);
    console.log(`Runs: ${metrics.runCount}`);
    console.log(`Last run: ${metrics.lastRun || "never"}`);
    console.log(`Last duration: ${metrics.lastDuration ? `${(metrics.lastDuration / 1000).toFixed(1)}s` : "n/a"}`);
    if (metrics.lastError) console.log(`Last error: ${metrics.lastError}`);
    if (Object.keys(metrics.metrics).length > 0) {
      console.log("\nMetrics:");
      for (const [key, value] of Object.entries(metrics.metrics)) {
        console.log(`  ${key}: ${value}`);
      }
    }
    if (metrics.checkpoint) {
      console.log(`\nCheckpoint: ${JSON.stringify(metrics.checkpoint)}`);
    }
    break;
  }

  case "activate": {
    if (!arg) { console.error("Usage: activate <hand-name>"); process.exit(1); }
    const result = registry.activate(arg);
    if (result.ok) {
      console.log(result.already ? `"${arg}" was already active` : `Activated "${arg}"`);
    } else {
      console.error(result.error);
      process.exit(1);
    }
    break;
  }

  case "pause": {
    if (!arg) { console.error("Usage: pause <hand-name>"); process.exit(1); }
    const result = registry.pause(arg);
    console.log(result.ok ? `Paused "${arg}"` : result.error);
    if (!result.ok) process.exit(1);
    break;
  }

  case "resume": {
    if (!arg) { console.error("Usage: resume <hand-name>"); process.exit(1); }
    const result = registry.resume(arg);
    console.log(result.ok ? `Resumed "${arg}"` : result.error);
    if (!result.ok) process.exit(1);
    break;
  }

  case "deactivate": {
    if (!arg) { console.error("Usage: deactivate <hand-name>"); process.exit(1); }
    const result = registry.deactivate(arg);
    console.log(result.ok ? `Deactivated "${arg}"` : result.error);
    if (!result.ok) process.exit(1);
    break;
  }

  case "run": {
    if (!arg) { console.error("Usage: run <hand-name> [--dry-run]"); process.exit(1); }
    // Auto-activate if inactive
    const hand = registry.get(arg);
    if (hand && hand.status === "inactive") {
      registry.activate(arg);
    }
    const result = await runHand(registry, arg, { dryRun, notify: !dryRun });
    if (!result.ok) {
      console.error(`Run failed: ${result.error || "aborted"}`);
      process.exit(1);
    }
    break;
  }

  case "activate-all": {
    const hands = registry.list();
    for (const h of hands) {
      if (h.status === "inactive") {
        registry.activate(h.name);
        console.log(`Activated "${h.name}"`);
      } else {
        console.log(`"${h.name}" already ${h.status}`);
      }
    }
    break;
  }

  case "metrics": {
    const hands = registry.list();
    console.log("Hand Metrics:\n");
    for (const h of hands) {
      const m = registry.getMetrics(h.name);
      console.log(`  ${h.name} (${m.status})`);
      console.log(`    Runs: ${m.runCount} | Last: ${m.lastRun || "never"} | Duration: ${m.lastDuration ? `${(m.lastDuration / 1000).toFixed(1)}s` : "n/a"}`);
      if (Object.keys(m.metrics).length > 0) {
        for (const [key, value] of Object.entries(m.metrics)) {
          console.log(`    ${key}: ${value}`);
        }
      }
      console.log();
    }
    break;
  }

  default:
    console.error(`Unknown command: ${cmd}`);
    console.error("Commands: list, status, activate, pause, resume, deactivate, run, activate-all, metrics");
    process.exit(1);
}
