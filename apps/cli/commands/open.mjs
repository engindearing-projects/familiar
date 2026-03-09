#!/usr/bin/env bun

// familiar open — Launch cmux with a multi-pane Familiar workspace.
// Sets up: main chat pane + project shell + optional browser split.

import chalk from "chalk";
import { existsSync } from "node:fs";
import { execSync, spawn } from "node:child_process";

const SOCKET_POLL_INTERVAL_MS = 300;
const SOCKET_POLL_MAX_MS = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run({ args }) {
  // Check if cmux is installed
  let cmuxInstalled = false;
  try {
    const out = execSync("which cmux 2>/dev/null || mdfind -name 'cmux.app' -onlyin /Applications 2>/dev/null | head -1", { encoding: "utf-8" }).trim();
    cmuxInstalled = !!out;
  } catch {}

  // Also check if the .app bundle exists even without CLI
  if (!cmuxInstalled) {
    cmuxInstalled = existsSync("/Applications/cmux.app");
  }

  if (!cmuxInstalled) {
    console.log(chalk.red("cmux is not installed."));
    console.log();
    console.log(chalk.cyan("Install via Homebrew:"));
    console.log(chalk.dim("  brew tap manaflow-ai/cmux && brew install --cask cmux"));
    console.log();
    console.log(chalk.cyan("Or download from:"));
    console.log(chalk.dim("  https://github.com/manaflow-ai/cmux/releases"));
    process.exit(1);
  }

  // Ensure cmux socket is in automation mode
  try {
    const currentMode = execSync("defaults read com.manaflow.cmux socketControlMode 2>/dev/null", { encoding: "utf-8" }).trim();
    if (currentMode !== "automation") {
      execSync("defaults write com.manaflow.cmux socketControlMode automation", { stdio: "ignore" });
      console.log(chalk.cyan("Set cmux socket mode to automation."));
    }
  } catch {
    try {
      execSync("defaults write com.manaflow.cmux socketControlMode automation", { stdio: "ignore" });
    } catch {}
  }

  const { CmuxClient, isCmuxAvailable } = await import("../../../services/cmux-client.mjs");

  // Launch cmux if not running
  if (!isCmuxAvailable()) {
    console.log(chalk.cyan("Launching cmux..."));
    try {
      execSync("open -a cmux", { stdio: "ignore" });
    } catch {
      try {
        spawn("cmux", [], { detached: true, stdio: "ignore" }).unref();
      } catch (err) {
        console.log(chalk.red(`Failed to launch cmux: ${err.message}`));
        process.exit(1);
      }
    }

    const start = Date.now();
    while (Date.now() - start < SOCKET_POLL_MAX_MS) {
      if (isCmuxAvailable()) break;
      await sleep(SOCKET_POLL_INTERVAL_MS);
    }

    if (!isCmuxAvailable()) {
      console.log(chalk.yellow("cmux launched but socket not ready. Try again in a moment."));
      process.exit(0);
    }
  }

  // Connect
  const client = new CmuxClient();
  try {
    await client.connect();
  } catch (err) {
    if (err.code === "CMUX_ACCESS_DENIED" || err.message?.includes("Access denied")) {
      console.log(chalk.red("cmux rejected the connection (socket in cmuxOnly mode)."));
      console.log(chalk.cyan("Fix: Quit cmux (Cmd+Q), then reopen it."));
      console.log(chalk.dim("The automation socket mode was set but cmux needs a restart to pick it up."));
      process.exit(1);
    }
    console.log(chalk.red(`Could not connect to cmux: ${err.message}`));
    process.exit(1);
  }

  // Determine project context
  const projectArg = args[0];
  const cwd = process.cwd();
  const projectName = projectArg || inferProjectName(cwd);

  console.log(chalk.cyan(`Setting up workspace: ${projectName}`));

  // Create or switch to workspace
  let workspaces = [];
  try { workspaces = await client.workspaceList(); } catch {}

  const existing = workspaces.find(
    (w) => (w.name || "").toLowerCase() === projectName.toLowerCase()
  );

  if (existing) {
    try { await client.workspaceSelect(existing.id || existing.workspace_id); } catch {}
    console.log(chalk.dim(`  Switched to existing workspace`));
  } else {
    try { await client.workspaceCreate(projectName); } catch {}
    console.log(chalk.dim(`  Created new workspace`));
    await sleep(500);
  }

  // Get the main surface
  let surfaces = [];
  try { surfaces = await client.surfaceList(); } catch {}

  const mainSurface = surfaces[0];
  const mainId = mainSurface?.id || mainSurface?.surface_id;

  if (mainId) {
    // Set the working directory to the project
    try {
      await client.surfaceSendText(mainId, `cd ${cwd} && clear\n`);
      await sleep(300);
    } catch {}

    // Split right — project shell
    try {
      const splitRes = await client.surfaceSplit(mainId, "right");
      await sleep(500);

      // Get updated surface list to find the new pane
      let newSurfaces = [];
      try { newSurfaces = await client.surfaceList(); } catch {}

      const rightPane = newSurfaces.find(
        (s) => (s.id || s.surface_id) !== mainId
      );
      const rightId = rightPane?.id || rightPane?.surface_id;

      if (rightId) {
        // Right pane: clean project shell with concise context
        try {
          await client.surfaceSendText(rightId, `cd ${cwd} && clear && echo "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '-') | $(git diff --stat --shortstat 2>/dev/null | tail -1 || echo 'no git')" && echo ""\n`);
        } catch {}

        // Split left pane down for monitor dashboard
        let monitorId = null;
        try {
          await client.surfaceFocus(mainId);
          await sleep(200);
          await client.surfaceSplit(mainId, "down");
          await sleep(500);

          // Find the new bottom pane
          let afterSplit = [];
          try { afterSplit = await client.surfaceList(); } catch {}
          const knownIds = new Set([mainId, rightId]);
          const monitorPane = afterSplit.find(
            (s) => !knownIds.has(s.id || s.surface_id)
          );
          monitorId = monitorPane?.id || monitorPane?.surface_id;

          if (monitorId) {
            await client.surfaceSendText(monitorId, `cd ${cwd} && bun ~/familiar/services/monitor.mjs\n`);
          }
        } catch {
          // Monitor split failed — non-fatal, continue without it
        }

        // Top-left pane: start familiar chat
        try {
          await client.surfaceFocus(mainId);
          await sleep(200);
          await client.surfaceSendText(mainId, `cd ${cwd} && familiar\n`);
        } catch {}
      }

      console.log(chalk.dim(`  Split: chat (top-left) + monitor (bottom-left) + shell (right)`));
    } catch {
      // Split failed — just start familiar in the single pane
      try {
        await client.surfaceSendText(mainId, `familiar\n`);
      } catch {}
    }
  }

  // Notification
  try {
    await client.notificationCreate("Familiar", `${projectName} workspace ready`);
  } catch {}

  client.close();

  console.log(chalk.green(`Workspace "${projectName}" ready in cmux.`));
}

function inferProjectName(cwd) {
  // Try git repo name
  try {
    const remote = execSync("git remote get-url origin 2>/dev/null", { encoding: "utf-8", cwd }).trim();
    const match = remote.match(/\/([^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch {}

  // Try directory name
  const parts = cwd.split("/").filter(Boolean);
  const dir = parts[parts.length - 1];
  if (dir && dir !== (process.env.USER || "")) return dir;

  return "familiar";
}
