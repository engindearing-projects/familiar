#!/usr/bin/env bun

// Entry point for familiar-mcp.
// No args → start MCP stdio server
// init    → register in Claude Code + OpenCode configs

const args = process.argv.slice(2);
const command = args[0];

if (command === "init") {
  const flags = {
    claude: args.includes("--claude"),
    opencode: args.includes("--opencode"),
  };

  const { runInit } = await import("../src/init.mjs");
  runInit(flags);
} else if (command === "help" || command === "--help" || command === "-h") {
  console.log(`familiar-mcp — Persistent AI memory for Claude Code and OpenCode

Usage:
  familiar-mcp          Start the MCP server (stdio mode)
  familiar-mcp init     Register in Claude Code and OpenCode configs
    --claude            Register in Claude Code only
    --opencode          Register in OpenCode only

Install:
  bunx familiar-mcp init

The server provides memory tools that work standalone and gateway
tools that connect to the full Familiar stack when available.`);
} else {
  // Default: start the MCP server
  await import("../src/server.mjs");
}
