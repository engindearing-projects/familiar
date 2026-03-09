#!/usr/bin/env bun

// Claude Session Manager — manages interactive Claude Code sessions running
// in real terminals (tmux preferred, Terminal.app fallback). Each session is
// a real terminal running `claude` interactively, with I/O bridged through
// the daemon's terminal MCP tools.
//
// Architecture:
//   User (Telegram/TUI/Web) → Gateway → ClaudeSessionManager → Daemon MCP → tmux/Terminal.app → Claude Code
//
// Usage:
//   import { ClaudeSessionManager } from "./claude-sessions.mjs";
//   const manager = new ClaudeSessionManager();
//   await manager.startSession("my-project", "~/my-project", "fix the login bug");

import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { McpClient } from "./mcp-client.mjs";

const PROJECT_DIR = resolve(dirname(new URL(import.meta.url).pathname), "..");
const DAEMON_BIN = resolve(PROJECT_DIR, "daemon", "target", "release", "familiar-daemon");

// How often to poll terminal output (ms)
const POLL_INTERVAL_MS = 2500;
// Lines to capture per poll
const CAPTURE_LINES = 200;
// Grace period after sending a command before polling (ms)
const SEND_SETTLE_MS = 500;
// How long to wait for claude to boot before sending initial prompt (ms)
const BOOT_WAIT_MS = 3000;

export class ClaudeSessionManager {
  constructor() {
    // Active sessions: Map<name, SessionInfo>
    this.sessions = new Map();
    // Daemon MCP client (shared)
    this._daemon = null;
    // Output listeners: Map<name, Set<Function>>
    this._listeners = new Map();
    // Poll timers: Map<name, timer>
    this._pollTimers = new Map();
  }

  // ── Daemon Connection ──────────────────────────────────────────────────

  async _getDaemon() {
    if (this._daemon?.connected) return this._daemon;

    if (!existsSync(DAEMON_BIN)) {
      throw new Error(`Daemon binary not found: ${DAEMON_BIN}`);
    }

    this._daemon = new McpClient({
      command: DAEMON_BIN,
      args: [],
      env: { RUST_LOG: "warn" },
    });
    await this._daemon.connect();
    console.log("[claude-sessions] Daemon connected");
    return this._daemon;
  }

  async _callDaemon(toolName, args = {}) {
    const daemon = await this._getDaemon();
    const result = await daemon.callTool(toolName, args);
    // MCP returns { content: [{ type: "text", text: "..." }], isError?: boolean }
    const text = (result.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (result.isError) {
      throw new Error(`Daemon tool error (${toolName}): ${text}`);
    }
    return text;
  }

  // ── Session Lifecycle ──────────────────────────────────────────────────

  /**
   * Start a new Claude Code session in a terminal.
   * @param {string} name - Unique session name
   * @param {string} projectDir - Working directory for Claude
   * @param {string} [initialPrompt] - Optional first message to send
   * @returns {object} Session info
   */
  async startSession(name, projectDir, initialPrompt = null, opts = {}) {
    if (this.sessions.has(name)) {
      throw new Error(`Session "${name}" already exists`);
    }

    const expandedDir = projectDir.replace(/^~/, process.env.HOME || "/tmp");
    if (!existsSync(expandedDir)) {
      throw new Error(`Project directory not found: ${expandedDir}`);
    }

    // Create a terminal running claude interactively
    await this._callDaemon("terminal_create", {
      name,
      command: "claude",
      directory: expandedDir,
    });

    const session = {
      name,
      projectDir: expandedDir,
      status: "starting",
      lastCapture: "",
      lastCaptureAt: null,
      createdAt: Date.now(),
      messageCount: 0,
      origin: opts?.origin || null,       // e.g. { type: "telegram", chatId: "123" }
      parentSession: opts?.parentSession || null,
    };
    this.sessions.set(name, session);

    console.log(`[claude-sessions] Started session "${name}" in ${expandedDir}`);

    // Wait for Claude to boot, then send initial prompt if provided
    if (initialPrompt) {
      await new Promise((r) => setTimeout(r, BOOT_WAIT_MS));
      await this.sendMessage(name, initialPrompt);
    }

    // Mark as active and start output monitoring
    session.status = "active";
    this._startMonitor(name);

    return {
      name: session.name,
      projectDir: session.projectDir,
      status: session.status,
      createdAt: session.createdAt,
    };
  }

  /**
   * Send a message to an existing Claude session.
   * Types the text into the terminal and presses Enter.
   * @param {string} name - Session name
   * @param {string} message - Message to send
   */
  async sendMessage(name, message) {
    const session = this.sessions.get(name);
    if (!session) {
      throw new Error(`Session "${name}" not found`);
    }

    // Send the text literally, then press Enter
    // For multiline messages, send text first, then Enter separately
    await this._callDaemon("terminal_send_keys", {
      target: name,
      keys: message,
      literal: true,
    });
    await this._callDaemon("terminal_send_keys", {
      target: name,
      keys: "Enter",
    });

    session.messageCount++;
    console.log(`[claude-sessions] Sent message to "${name}" (${message.length} chars)`);
  }

  /**
   * Read current terminal output.
   * Returns only NEW content since last capture (delta).
   * @param {string} name - Session name
   * @param {number} [lines] - Number of lines to capture
   * @returns {{ full: string, delta: string }}
   */
  async capture(name, lines = CAPTURE_LINES) {
    const session = this.sessions.get(name);
    if (!session) {
      throw new Error(`Session "${name}" not found`);
    }

    const captured = await this._callDaemon("terminal_capture", {
      target: name,
      lines,
    });

    const delta = extractDelta(session.lastCapture, captured);
    session.lastCapture = captured;
    session.lastCaptureAt = Date.now();

    return { full: captured, delta };
  }

  /**
   * Close a session. Sends Ctrl+C to exit Claude, then kills the terminal.
   * @param {string} name - Session name
   */
  async closeSession(name) {
    const session = this.sessions.get(name);
    if (!session) {
      throw new Error(`Session "${name}" not found`);
    }

    // Stop the monitor first
    this._stopMonitor(name);

    // Send Ctrl+C to exit Claude gracefully
    try {
      await this._callDaemon("terminal_send_keys", {
        target: name,
        keys: "C-c",
      });
      // Give it a moment to exit
      await new Promise((r) => setTimeout(r, 1000));
    } catch {
      // Terminal may already be gone
    }

    // Send "exit" to close the shell
    try {
      await this._callDaemon("terminal_send_keys", {
        target: name,
        keys: "exit",
        literal: true,
      });
      await this._callDaemon("terminal_send_keys", {
        target: name,
        keys: "Enter",
      });
    } catch {
      // Best effort
    }

    session.status = "closed";
    this.sessions.delete(name);
    this._listeners.delete(name);

    console.log(`[claude-sessions] Closed session "${name}"`);
  }

  /**
   * List all active sessions, cross-referenced with actual terminal sessions.
   * @returns {Array<object>}
   */
  async listSessions() {
    let terminalSessions = [];
    try {
      const raw = await this._callDaemon("terminal_list_sessions");
      // Parse the daemon output — varies by format
      if (raw) {
        terminalSessions = raw.split("\n").filter(Boolean);
      }
    } catch {
      // Daemon unavailable
    }

    const result = [];
    for (const [name, session] of this.sessions) {
      result.push({
        name: session.name,
        projectDir: session.projectDir,
        status: session.status,
        messageCount: session.messageCount,
        age: Date.now() - session.createdAt,
        createdAt: session.createdAt,
        lastCaptureAt: session.lastCaptureAt,
        origin: session.origin,
        parentSession: session.parentSession,
      });
    }
    return result;
  }

  // ── Output Monitoring ──────────────────────────────────────────────────

  /**
   * Register a listener for new output from a session.
   * @param {string} name - Session name
   * @param {function} callback - Called with (name, delta) on new output
   * @returns {function} Unsubscribe function
   */
  onOutput(name, callback) {
    if (!this._listeners.has(name)) {
      this._listeners.set(name, new Set());
    }
    this._listeners.get(name).add(callback);
    return () => this._listeners.get(name)?.delete(callback);
  }

  /**
   * Register a listener for ALL sessions.
   * @param {function} callback - Called with (name, delta) on new output
   * @returns {function} Unsubscribe function
   */
  onAnyOutput(callback) {
    if (!this._listeners.has("*")) {
      this._listeners.set("*", new Set());
    }
    this._listeners.get("*").add(callback);
    return () => this._listeners.get("*")?.delete(callback);
  }

  _startMonitor(name) {
    if (this._pollTimers.has(name)) return;

    const poll = async () => {
      if (!this.sessions.has(name)) {
        this._pollTimers.delete(name);
        return;
      }

      try {
        const { delta } = await this.capture(name);
        if (delta) {
          this._emit(name, delta);
        }
      } catch (err) {
        // Session may have been killed externally
        if (err.message?.includes("not found") || err.message?.includes("no session")) {
          console.log(`[claude-sessions] Session "${name}" appears to have ended`);
          this.sessions.get(name).status = "ended";
          this._stopMonitor(name);
          this._emit(name, "[Session ended]");
          return;
        }
      }

      // Schedule next poll
      const timer = setTimeout(poll, POLL_INTERVAL_MS);
      this._pollTimers.set(name, timer);
    };

    // Start first poll after a short delay
    const timer = setTimeout(poll, SEND_SETTLE_MS);
    this._pollTimers.set(name, timer);
  }

  _stopMonitor(name) {
    const timer = this._pollTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this._pollTimers.delete(name);
    }
  }

  _emit(name, delta) {
    // Notify session-specific listeners
    const sessionListeners = this._listeners.get(name);
    if (sessionListeners) {
      for (const cb of sessionListeners) {
        try { cb(name, delta); } catch (err) {
          console.error(`[claude-sessions] Listener error for "${name}":`, err.message);
        }
      }
    }
    // Notify wildcard listeners
    const wildcard = this._listeners.get("*");
    if (wildcard) {
      for (const cb of wildcard) {
        try { cb(name, delta); } catch (err) {
          console.error(`[claude-sessions] Wildcard listener error:`, err.message);
        }
      }
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  /**
   * Close all sessions and disconnect daemon.
   */
  async shutdown() {
    for (const name of [...this.sessions.keys()]) {
      try {
        await this.closeSession(name);
      } catch {
        // Best effort
      }
    }
    if (this._daemon) {
      this._daemon.close();
      this._daemon = null;
    }
  }
}

// ── Utility: Delta Extraction ────────────────────────────────────────────

/**
 * Extract new content by comparing previous and current terminal captures.
 * Uses suffix matching — finds where old content ends in new content,
 * returns everything after that point.
 */
function extractDelta(previous, current) {
  if (!previous) return current;
  if (previous === current) return "";

  // Try to find the end of previous content in current
  // Use last N lines of previous as anchor
  const prevLines = previous.split("\n");
  const currLines = current.split("\n");

  // Try progressively shorter suffixes of previous to find overlap
  for (let anchor = Math.min(prevLines.length, 10); anchor >= 1; anchor--) {
    const suffix = prevLines.slice(-anchor).join("\n");
    const idx = current.lastIndexOf(suffix);
    if (idx !== -1) {
      const after = current.slice(idx + suffix.length);
      return after.replace(/^\n/, ""); // trim leading newline
    }
  }

  // No overlap found — return everything (terminal may have scrolled)
  return current;
}

// Singleton instance for use across services
let _instance = null;

export function getSessionManager() {
  if (!_instance) {
    _instance = new ClaudeSessionManager();
  }
  return _instance;
}

export default ClaudeSessionManager;
