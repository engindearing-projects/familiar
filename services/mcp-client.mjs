#!/usr/bin/env bun

// MCP Client — Speaks JSON-RPC 2.0 over stdio to MCP servers.
// Spawns a server process, discovers tools, and calls them on demand.
// Used by the Familiar tool loop to access Rust daemon capabilities
// (screenshots, window management, input, clipboard, OCR, etc.)
// without depending on any external coding tool.
//
// Usage:
//   import { McpClient } from "./mcp-client.mjs";
//   const client = new McpClient({ command: "/path/to/familiar-daemon", args: [] });
//   await client.connect();
//   const tools = await client.listTools();
//   const result = await client.callTool("screenshot_screen", {});
//   client.close();

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 30_000;

export class McpClient {
  constructor(opts = {}) {
    this.command = opts.command;
    this.args = opts.args || [];
    this.env = { ...process.env, ...(opts.env || {}) };
    this.process = null;
    this._buffer = "";
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._tools = null; // cached tool list
    this._nextId = 1;
    this._ready = false;
  }

  /** Spawn the MCP server and complete the initialize handshake. */
  async connect() {
    if (this.process) return;

    this.process = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env,
    });

    this.process.stdout.on("data", (chunk) => this._onData(chunk.toString()));
    this.process.stderr.on("data", (chunk) => {
      // MCP servers log to stderr — ignore unless debugging
    });

    this.process.on("close", (code) => {
      this._ready = false;
      // Reject all pending requests
      for (const [id, pending] of this._pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`MCP server exited with code ${code}`));
      }
      this._pending.clear();
      this.process = null;
    });

    this.process.on("error", (err) => {
      this._ready = false;
      for (const [id, pending] of this._pending) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this._pending.clear();
    });

    // MCP initialize handshake
    const initResult = await this._request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "familiar-tool-loop", version: "1.0.0" },
    });

    // Send initialized notification (no response expected)
    this._notify("notifications/initialized", {});

    this._ready = true;
    return initResult;
  }

  /** List available tools from the server. Cached after first call. */
  async listTools() {
    if (this._tools) return this._tools;
    const result = await this._request("tools/list", {});
    this._tools = result.tools || [];
    return this._tools;
  }

  /** Call a tool by name with arguments. */
  async callTool(name, args = {}) {
    const result = await this._request("tools/call", { name, arguments: args });
    return result;
  }

  /** Get tool names as a simple array. */
  async getToolNames() {
    const tools = await this.listTools();
    return tools.map((t) => t.name);
  }

  /** Get tool schemas formatted for the system prompt. */
  async getToolSchemaText() {
    const tools = await this.listTools();
    return tools.map((tool) => {
      const params = tool.inputSchema?.properties || {};
      const required = new Set(tool.inputSchema?.required || []);
      const paramLines = Object.entries(params).map(([name, def]) => {
        const req = required.has(name) ? " (required)" : "";
        return `  - ${name}: ${def.type || "any"}${req} — ${def.description || ""}`;
      });
      const paramText = paramLines.length > 0 ? paramLines.join("\n") : "(no parameters)";
      return `### ${tool.name}\n${tool.description || ""}\nParameters:\n${paramText}`;
    }).join("\n\n");
  }

  /** Check if connected and ready. */
  get connected() {
    return this._ready && this.process !== null;
  }

  /** Gracefully close the server process. */
  close() {
    this._ready = false;
    if (this.process) {
      try { this.process.stdin.end(); } catch {}
      try { this.process.kill("SIGTERM"); } catch {}
      this.process = null;
    }
    this._tools = null;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  _request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;

      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP request timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this._pending.set(id, { resolve, reject, timer });

      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      try {
        this.process.stdin.write(msg);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(new Error(`Failed to write to MCP server: ${err.message}`));
      }
    });
  }

  _notify(method, params) {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    try {
      this.process.stdin.write(msg);
    } catch {
      // Notification failures are non-fatal
    }
  }

  _onData(chunk) {
    this._buffer += chunk;

    // Process complete lines (JSON-RPC messages are newline-delimited)
    let newlineIdx;
    while ((newlineIdx = this._buffer.indexOf("\n")) !== -1) {
      const line = this._buffer.slice(0, newlineIdx).trim();
      this._buffer = this._buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const msg = JSON.parse(line);

        // Response to a request
        if (msg.id != null && this._pending.has(msg.id)) {
          const pending = this._pending.get(msg.id);
          this._pending.delete(msg.id);
          clearTimeout(pending.timer);

          if (msg.error) {
            pending.reject(new Error(`MCP error: ${msg.error.message || JSON.stringify(msg.error)}`));
          } else {
            pending.resolve(msg.result);
          }
        }
        // Notifications from server (ignore for now)
      } catch {
        // Malformed JSON — skip
      }
    }
  }
}

export default McpClient;
