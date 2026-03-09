// Dynamic binary path resolution for cross-platform compatibility.
// Replaces hardcoded paths like /opt/homebrew/bin/bun with runtime detection.

import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/**
 * Resolve an executable by walking PATH.
 * @param {string} name - Binary name (e.g. "bun", "node")
 * @returns {string|null} Absolute path or null
 */
export function whichSync(name) {
  try {
    return execSync(`which ${name}`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Resolve the Bun binary path.
 * Checks: process.execPath (if Bun runtime) → which bun → common locations.
 * @returns {string} Absolute path to bun, or "bun" as last resort
 */
export function resolveBun() {
  // If we're running under Bun, use this process's path
  if (typeof Bun !== "undefined" && process.execPath && process.execPath.endsWith("/bun")) {
    return process.execPath;
  }

  const found = whichSync("bun");
  if (found) return found;

  // Common install locations
  const candidates = [
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
    join(homedir(), ".bun", "bin", "bun"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  return "bun";
}

/**
 * Resolve the Node binary path.
 * Checks: which node → common locations.
 * @returns {string} Absolute path to node, or "node" as last resort
 */
export function resolveNode() {
  const found = whichSync("node");
  if (found) return found;

  const candidates = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    join(homedir(), ".nvm", "versions", "node"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  return "node";
}

/**
 * Get the familiar's display name from local preferences.
 * Reads ~/.familiar/profile/preferences.json → familiarName.
 * Returns "Familiar" if not set.
 * @returns {string}
 */
export function getFamiliarName() {
  const home = process.env.FAMILIAR_HOME || process.env.COZYTERM_HOME || join(homedir(), ".familiar");
  const prefsPath = join(home, "profile", "preferences.json");
  try {
    const prefs = JSON.parse(readFileSync(prefsPath, "utf-8"));
    const entry = prefs.familiarName;
    if (entry && typeof entry === "object" && "value" in entry) return entry.value;
    if (typeof entry === "string") return entry;
  } catch { /* no prefs file yet */ }
  return "Familiar";
}
