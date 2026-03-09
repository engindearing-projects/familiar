#!/usr/bin/env bun

// Shared Claude CLI invocation utilities.
// Used by both gateway.mjs and claude-code-proxy.mjs to avoid duplication.

import { spawn, execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_DIR = resolve(__dirname, "..");

// ── Concurrency Limiter ─────────────────────────────────────────────────────

export class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.current < this.max) { this.current++; return; }
    await new Promise(resolve => this.queue.push(resolve));
  }
  release() {
    if (this.current <= 0) { this.current = 0; return; } // guard against double-release
    this.current--;
    if (this.queue.length > 0) { this.current++; this.queue.shift()(); }
  }
}

// ── Environment ─────────────────────────────────────────────────────────────

/** Build a clean env for claude subprocess — strip all Claude Code session vars and API key */
export function cleanEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRY;
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_CODE_SESSION;
  // Remove ANTHROPIC_API_KEY so claude uses the subscription instead of API credits
  delete env.ANTHROPIC_API_KEY;
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDECODE")) delete env[key];
  }
  return env;
}

/** Strip Claude Code session env vars from current process on import */
export function stripSessionEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CLAUDECODE") || key === "CLAUDE_CODE_ENTRY" || key === "CLAUDE_CODE_SESSION") {
      delete process.env[key];
    }
  }
}

// ── Claude Binary ───────────────────────────────────────────────────────────

export function claudeBin() {
  try {
    const bin = execSync("which claude", { stdio: "pipe", env: cleanEnv() })
      .toString()
      .trim();
    return bin || null;
  } catch {
    return null;
  }
}

// ── Online Check ────────────────────────────────────────────────────────────

let onlineStatus = null;

export async function checkOnline() {
  if (onlineStatus && Date.now() - onlineStatus.checkedAt < 60_000) {
    return onlineStatus.online;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    await fetch("https://api.anthropic.com", {
      method: "HEAD",
      signal: controller.signal,
    });
    clearTimeout(timer);
    onlineStatus = { online: true, checkedAt: Date.now() };
    return true;
  } catch {
    onlineStatus = { online: false, checkedAt: Date.now() };
    return false;
  }
}

// ── Claude CLI Invocation ───────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MODEL = process.env.CLAUDE_PROXY_MODEL || "opus";

/**
 * Invoke the Claude CLI in headless mode.
 *
 * @param {object} opts
 * @param {Semaphore} limiter - concurrency limiter to acquire/release
 * @returns {Promise<object>} result with jobId, success, result, cost_usd, etc.
 */
export function invokeClaude(opts, limiter) {
  const {
    prompt,
    model = DEFAULT_MODEL,
    workingDir,
    systemPrompt,
    allowedTools,
    disallowedTools,
    maxTurns,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    outputFormat = "json",
    continueSession,
    resumeSession,
    addDirs,
    permissionMode,
    noSessionPersistence,
    mcpConfig,
    strictMcpConfig,
    captureRawOutput = false,
  } = opts;

  const jobId = randomUUID();

  return (async () => {
    if (limiter) await limiter.acquire();
    return new Promise((resolveJob, rejectJob) => {
      const args = ["-p", prompt, "--output-format", outputFormat];

      if (outputFormat === "stream-json") args.push("--verbose");
      if (model) args.push("--model", model);
      if (systemPrompt) args.push("--system-prompt", systemPrompt);
      if (maxTurns) args.push("--max-turns", String(maxTurns));
      if (continueSession) args.push("--continue");
      if (resumeSession) args.push("--resume", resumeSession);

      if (allowedTools && allowedTools.length > 0) {
        args.push("--allowedTools", ...allowedTools);
      }
      if (disallowedTools && disallowedTools.length > 0) {
        args.push("--disallowed-tools", ...disallowedTools);
      }
      if (permissionMode) {
        args.push("--permission-mode", permissionMode);
      }
      if (noSessionPersistence) {
        args.push("--no-session-persistence");
      }
      if (mcpConfig) {
        args.push("--mcp-config", mcpConfig);
      }
      if (strictMcpConfig) {
        args.push("--strict-mcp-config");
      }
      if (addDirs && addDirs.length > 0) {
        args.push("--add-dir", ...addDirs);
      }

      const cwd = workingDir || mkdtempSync(resolve(tmpdir(), "claude-proxy-"));

      if (!workingDir) {
        args.push("--no-session-persistence");
      }

      const child = spawn("claude", args, {
        cwd,
        env: cleanEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        if (limiter) limiter.release();
        rejectJob(new Error(`Timed out after ${timeoutMs}ms`));
      }, Math.min(timeoutMs, MAX_TIMEOUT_MS));

      child.on("close", (code) => {
        clearTimeout(timer);
        if (limiter) limiter.release();

        if (code === 0) {
          try {
            const parsed = JSON.parse(stdout);

            // Handle error_max_turns: the response has no useful `result` text,
            // just metadata (subtype, session_id, num_turns). Don't dump raw JSON.
            const hitMaxTurns = parsed.subtype === "error_max_turns"
              || (parsed.is_error && !parsed.result && parsed.num_turns);

            const result = {
              jobId,
              success: true,
              result: hitMaxTurns ? "" : (parsed.result || parsed),
              cost_usd: parsed.cost_usd,
              duration_ms: parsed.duration_ms,
              num_turns: parsed.num_turns,
              session_id: parsed.session_id,
              model: parsed.model,
              hitMaxTurns,
            };
            if (captureRawOutput) result._rawOutput = stdout;
            resolveJob(result);
          } catch {
            const result = {
              jobId,
              success: true,
              result: stdout.trim(),
              raw: true,
            };
            if (captureRawOutput) result._rawOutput = stdout;
            resolveJob(result);
          }
        } else {
          // Try to parse JSON output even on non-zero exit (e.g. rate limit returns JSON with is_error)
          try {
            const parsed = JSON.parse(stdout);
            if (parsed.result) {
              console.error(`[invokeClaude] exit code=${code} is_error=true result=${String(parsed.result).slice(0, 200)}`);
              rejectJob(new Error(String(parsed.result)));
              return;
            }
          } catch { /* not JSON, use stderr */ }
          const errDetail = stderr ? stderr.trim() : stdout.trim().slice(0, 500);
          console.error(`[invokeClaude] exit code=${code} stderr=${stderr.slice(0, 500)}`);
          rejectJob(
            new Error(`claude exited with code ${code}${errDetail ? ": " + errDetail : ""}`)
          );
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        if (limiter) limiter.release();
        rejectJob(err);
      });
    });
  })();
}
