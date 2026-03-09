// Single source of truth for all Familiar path resolution.
// Every module that needs a path imports from here — no hardcoded paths anywhere else.

import { resolve, join } from "path";
import { existsSync, mkdirSync } from "fs";

const HOME = process.env.HOME || "/tmp";

/** Root Familiar directory — $FAMILIAR_HOME or ~/.familiar/ */
export function familiarHome() {
  return process.env.FAMILIAR_HOME || resolve(HOME, ".familiar");
}

/** Config dir (inside familiar home) */
export function configDir() {
  return join(familiarHome(), "config");
}

/** Workspace dir — skills, tools, persistent data */
export function workspaceDir() {
  return join(familiarHome(), "workspace");
}

/** Memory dir — structured memory, SQLite DB */
export function memoryDir() {
  return join(familiarHome(), "memory");
}

/** Cron dir — scheduled jobs */
export function cronDir() {
  return join(familiarHome(), "cron");
}

/** Logs dir — service output, archived logs */
export function logsDir() {
  return join(familiarHome(), "logs");
}

/** Profile dir — user.json, preferences.json, patterns.json */
export function profileDir() {
  return join(familiarHome(), "profile");
}

/** All managed directories */
export function allDirs() {
  return [
    familiarHome(),
    configDir(),
    workspaceDir(),
    memoryDir(),
    cronDir(),
    logsDir(),
    profileDir(),
  ];
}

/** Ensure all directories exist */
export function ensureDirs() {
  for (const dir of allDirs()) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

/** Gateway config file path */
export function configPath() {
  return join(configDir(), "familiar.json");
}


/** Env file path */
export function envFilePath() {
  return join(configDir(), ".env");
}

/** MCP tools config path */
export function mcpToolsPath() {
  return join(configDir(), "mcp-tools.json");
}

/** Memory SQLite database path */
export function memoryDbPath() {
  return join(memoryDir(), "familiar.db");
}

/** Init state path (for setup wizard resume) */
export function initStatePath() {
  return join(familiarHome(), ".init-state.json");
}

/**
 * Resolve the gateway config file — checks multiple locations.
 * Priority: $FAMILIAR_CONFIG > ~/.familiar/config/familiar.json
 */
export function findConfig() {
  const familiarPath = process.env.FAMILIAR_CONFIG;
  if (familiarPath && existsSync(familiarPath)) return familiarPath;

  const primary = join(configDir(), "familiar.json");
  if (existsSync(primary)) return primary;

  return null;
}


/** Return all paths as a plain object (useful for config generation / debugging) */
export function configPaths() {
  return {
    familiarHome: familiarHome(),
    config: configDir(),
    workspace: workspaceDir(),
    memory: memoryDir(),
    cron: cronDir(),
    logs: logsDir(),
    profile: profileDir(),
    gatewayConfig: configPath(),
    envFile: envFilePath(),
    mcpTools: mcpToolsPath(),
    memoryDb: memoryDbPath(),
  };
}
