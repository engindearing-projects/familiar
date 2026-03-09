// System prerequisite checks for Familiar.
// Each check is safe — catches errors and returns { installed: false } on failure.

import { execSync } from "child_process";

/**
 * Run a shell command and return trimmed stdout, or null on failure.
 */
function tryExec(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

/**
 * Check Bun runtime.
 */
export function checkBun() {
  const version = tryExec("bun --version");
  return { name: "Bun", installed: version !== null, version: version || null };
}

/**
 * Check Homebrew.
 */
export function checkBrew() {
  const output = tryExec("brew --version");
  let version = null;
  if (output) {
    // brew --version returns "Homebrew 4.x.x\n..."
    const match = output.match(/Homebrew\s+(\S+)/);
    version = match ? match[1] : output.split("\n")[0];
  }
  return { name: "Homebrew", installed: output !== null, version };
}

/**
 * Check platform (macOS only for now).
 */
export function checkPlatform() {
  const platform = process.platform;
  return {
    name: "Platform",
    platform,
    supported: platform === "darwin",
    version: platform === "darwin" ? (tryExec("sw_vers -productVersion") || "unknown") : null,
  };
}

/**
 * Check gateway health via HTTP.
 */
export function checkGateway() {
  // Try HTTP health check instead of binary check
  try {
    const output = tryExec("curl -s -o /dev/null -w '%{http_code}' http://localhost:18789/health");
    const healthy = output === "200";
    return { name: "Gateway", installed: healthy, version: healthy ? "0.6.0" : null };
  } catch {
    return { name: "Gateway", installed: false, version: null };
  }
}


/**
 * Check Claude Code CLI.
 */
export function checkClaude() {
  const output = tryExec("claude --version");
  let version = null;
  if (output) {
    const match = output.match(/(\d+\.\d+[\.\d]*)/);
    version = match ? match[1] : output;
  }
  return { name: "Claude CLI", installed: output !== null, version };
}

/**
 * Check Ollama.
 */
export function checkOllama() {
  const output = tryExec("ollama --version");
  let version = null;
  if (output) {
    // "ollama version 0.16.2" or similar
    const match = output.match(/(\d+\.\d+[\.\d]*)/);
    version = match ? match[1] : output;
  }
  return { name: "Ollama", installed: output !== null, version };
}

/**
 * Run all prerequisite checks and return results as an object.
 */
export function runAllChecks() {
  return {
    platform: checkPlatform(),
    bun: checkBun(),
    brew: checkBrew(),
    gateway: checkGateway(),
    claude: checkClaude(),
    ollama: checkOllama(),
  };
}
