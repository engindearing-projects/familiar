// Registers familiar-mcp in Claude Code and OpenCode MCP configs.
// Non-destructive — merges into existing config without overwriting other servers.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, join, dirname } from "path";

const HOME = process.env.HOME || "/tmp";

// Config file locations
const CLAUDE_MCP_PATH = join(HOME, ".claude", "mcp.json");
const OPENCODE_CONFIG_PATH = join(HOME, ".config", "opencode", "opencode.json");

// The command that starts our server
const SERVER_COMMAND = "bunx";
const SERVER_ARGS = ["familiar-mcp"];

function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function writeJson(path, data) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function registerClaudeCode() {
  const existing = readJson(CLAUDE_MCP_PATH) || {};
  if (!existing.mcpServers) existing.mcpServers = {};

  if (existing.mcpServers.familiar) {
    console.log(`  Claude Code: already registered in ${CLAUDE_MCP_PATH}`);
    return false;
  }

  existing.mcpServers.familiar = {
    command: SERVER_COMMAND,
    args: SERVER_ARGS,
  };

  writeJson(CLAUDE_MCP_PATH, existing);
  console.log(`  Claude Code: registered in ${CLAUDE_MCP_PATH}`);
  return true;
}

function registerOpenCode() {
  const existing = readJson(OPENCODE_CONFIG_PATH);

  if (!existing) {
    // Create minimal opencode config
    const config = {
      "$schema": "https://opencode.ai/config.json",
      mcp: {
        familiar: {
          type: "local",
          command: ["bun", "run", "familiar-mcp"],
          enabled: true,
          timeout: 10000,
        },
      },
    };
    writeJson(OPENCODE_CONFIG_PATH, config);
    console.log(`  OpenCode: created config at ${OPENCODE_CONFIG_PATH}`);
    return true;
  }

  if (!existing.mcp) existing.mcp = {};

  if (existing.mcp.familiar) {
    console.log(`  OpenCode: already registered in ${OPENCODE_CONFIG_PATH}`);
    return false;
  }

  existing.mcp.familiar = {
    type: "local",
    command: ["bun", "run", "familiar-mcp"],
    enabled: true,
    timeout: 10000,
  };

  writeJson(OPENCODE_CONFIG_PATH, existing);
  console.log(`  OpenCode: registered in ${OPENCODE_CONFIG_PATH}`);
  return true;
}

export function runInit(flags = {}) {
  const doAll = !flags.claude && !flags.opencode;

  console.log("Registering familiar-mcp...\n");

  let changed = 0;

  if (doAll || flags.claude) {
    if (registerClaudeCode()) changed++;
  }

  if (doAll || flags.opencode) {
    if (registerOpenCode()) changed++;
  }

  if (changed > 0) {
    console.log("\nDone. Familiar will start automatically next time you open Claude Code or OpenCode.");
  } else {
    console.log("\nNo changes needed — already registered.");
  }

  // Ensure ~/.familiar exists
  const familiarHome = process.env.FAMILIAR_HOME || join(HOME, ".familiar");
  for (const sub of ["memory", "profile", "config"]) {
    const dir = join(familiarHome, sub);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
