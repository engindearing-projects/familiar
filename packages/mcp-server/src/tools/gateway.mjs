// Gateway-connected tools — gracefully degrade when gateway is offline.
// Connects to the Familiar gateway via WebSocket for chat, status, routing, etc.

import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";

const HOME = process.env.HOME || "/tmp";
const FAMILIAR_HOME = process.env.FAMILIAR_HOME || resolve(HOME, ".familiar");

// Try to read gateway config for port/token
let GW_PORT = 18789;
let GW_TOKEN = process.env.FAMILIAR_GATEWAY_TOKEN || process.env.COZYTERM_GATEWAY_TOKEN || "";
const CLAUDE_PROXY_URL = process.env.CLAUDE_PROXY_URL || "http://127.0.0.1:18791";

// Check multiple config locations
for (const configPath of [
  process.env.FAMILIAR_CONFIG,
  join(FAMILIAR_HOME, "config", "familiar.json"),
  // Dev: check if we're inside the familiar repo
  resolve(import.meta.dir, "../../../../config/familiar.json"),
]) {
  if (configPath && existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      if (cfg.gateway?.port) GW_PORT = cfg.gateway.port;
      if (cfg.gateway?.auth?.token) GW_TOKEN = cfg.gateway.auth.token;
      break;
    } catch {}
  }
}

const WS_URL = `ws://localhost:${GW_PORT}`;

// WebSocket connection state
let ws = null;
let connected = false;
let requestId = 0;
const pending = new Map();
const eventListeners = new Map();

function nextId() {
  return String(++requestId);
}

function log(...args) {
  process.stderr.write(`[familiar-mcp:gateway] ${args.join(" ")}\n`);
}

function connect() {
  return new Promise((resolve, reject) => {
    if (ws && connected) { resolve(); return; }

    // Dynamic import WebSocket — Bun has it globally
    const WebSocket = globalThis.WebSocket;
    if (!WebSocket) {
      reject(new Error("WebSocket not available"));
      return;
    }

    ws = new WebSocket(WS_URL);
    let settled = false;

    ws.onopen = () => {};

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === "event" && msg.event === "connect.challenge") {
        ws.send(JSON.stringify({
          type: "req",
          id: nextId(),
          method: "connect",
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: { id: "familiar-ui", version: "1.0.0", platform: "bun", mode: "mcp" },
            role: "operator",
            scopes: ["operator.admin", "operator.read", "operator.write", "chat"],
            auth: { token: GW_TOKEN },
          },
        }));
        return;
      }

      if (msg.type === "res" && !settled) {
        settled = true;
        if (msg.ok) { connected = true; resolve(); }
        else { reject(new Error(msg.error?.message || "Connection rejected")); }
        return;
      }

      if (msg.type === "res" && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.payload);
        else p.reject(new Error(msg.error?.message || "Request failed"));
        return;
      }

      if (msg.type === "event") {
        for (const [id, listener] of eventListeners) {
          if (listener.filter(msg)) {
            eventListeners.delete(id);
            clearTimeout(listener.timer);
            listener.resolve(msg);
            break;
          }
        }
      }
    };

    ws.onclose = () => {
      connected = false;
      ws = null;
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error("WebSocket closed")); }
      pending.clear();
      for (const [, l] of eventListeners) { clearTimeout(l.timer); l.reject(new Error("WebSocket closed")); }
      eventListeners.clear();
    };

    ws.onerror = () => {
      if (!settled) { settled = true; reject(new Error("Gateway connection failed")); }
    };

    setTimeout(() => {
      if (!settled) { settled = true; reject(new Error("Connection timeout")); ws?.close(); }
    }, 5000);
  });
}

async function ensureConnected() {
  if (!ws || !connected) await connect();
}

function request(method, params = {}, timeoutMs = 30000) {
  return new Promise(async (resolve, reject) => {
    try { await ensureConnected(); } catch (e) { reject(e); return; }

    const id = nextId();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Request timeout: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

function waitForEvent(filter, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const id = nextId();
    const timer = setTimeout(() => { eventListeners.delete(id); reject(new Error("Event wait timeout")); }, timeoutMs);
    eventListeners.set(id, { resolve, reject, timer, filter });
  });
}

const GATEWAY_OFFLINE_MSG = "Familiar gateway is not running. Memory tools still work. To enable chat/status, start the gateway with `familiar start` or install full Familiar.";

function gatewayError(e) {
  const isOffline = /connection failed|ECONNREFUSED|timeout/i.test(e.message);
  return {
    content: [{ type: "text", text: isOffline ? GATEWAY_OFFLINE_MSG : `Error: ${e.message}` }],
    isError: true,
  };
}

function sessionKey(agent, session) {
  const a = agent || "familiar";
  return session ? `agent:${a}:${session}` : `agent:${a}:main`;
}

function extractText(msg) {
  if (typeof msg.text === "string") return msg.text;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return JSON.stringify(msg);
}

export const gatewayTools = [
  {
    name: "familiar_chat",
    description: "Send a message to Familiar and get a response. Use this to communicate with the Familiar AI assistant.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The message to send to Familiar" },
        agent: { type: "string", description: "Agent ID (default: familiar)" },
        session: { type: "string", description: "Session name (optional, uses 'main')" },
      },
      required: ["message"],
    },
    async handler({ message, agent, session }) {
      try {
        const sk = sessionKey(agent, session);
        const sendResult = await request("chat.send", {
          sessionKey: sk,
          message,
          idempotencyKey: crypto.randomUUID(),
        });

        const runId = sendResult?.runId;
        if (!runId) return { content: [{ type: "text", text: "Failed to send message: no runId returned" }] };

        const finalEvent = await waitForEvent(
          (msg) => msg.event === "chat" && msg.payload?.runId === runId && (msg.payload?.state === "final" || msg.payload?.state === "error"),
          120000
        );

        if (finalEvent.payload?.state === "error") {
          const errMsg = finalEvent.payload?.error || finalEvent.payload?.message || "Unknown error";
          return { content: [{ type: "text", text: `Familiar error: ${typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg)}` }], isError: true };
        }

        const history = await request("chat.history", { sessionKey: sk, limit: 5 });
        const messages = history?.messages || [];
        let responseText = "";
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "assistant") { responseText = extractText(messages[i]); break; }
        }

        return { content: [{ type: "text", text: responseText || "Familiar responded but no text was captured." }] };
      } catch (e) {
        return gatewayError(e);
      }
    },
  },

  {
    name: "familiar_status",
    description: "Check Familiar system health and status",
    inputSchema: { type: "object", properties: {} },
    async handler() {
      try {
        await ensureConnected();
        const info = await request("health", {});
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      } catch (e) {
        return gatewayError(e);
      }
    },
  },

  {
    name: "familiar_system_status",
    description: "Full system health: Familiar gateway + Claude Code proxy + Ollama + online status",
    inputSchema: { type: "object", properties: {} },
    async handler() {
      const [gwHealth, proxyHealth] = await Promise.all([
        ensureConnected().then(() => request("health", {})).catch((e) => ({ error: e.message })),
        fetch(`${CLAUDE_PROXY_URL}/health`, { signal: AbortSignal.timeout(3000) })
          .then((r) => r.json()).catch((e) => ({ status: "unreachable", error: e.message })),
      ]);
      return {
        content: [{ type: "text", text: JSON.stringify({ gateway: gwHealth, claudeCodeProxy: proxyHealth, timestamp: new Date().toISOString() }, null, 2) }],
      };
    },
  },

  {
    name: "familiar_config",
    description: "Read Familiar configuration",
    inputSchema: {
      type: "object",
      properties: {
        section: { type: "string", description: "Config section to read (e.g., 'agents', 'channels'). Omit for full config." },
      },
    },
    async handler({ section }) {
      try {
        const result = await request("config.get", {});
        const data = section ? result?.[section] : result;
        return { content: [{ type: "text", text: JSON.stringify(data ?? result, null, 2) }] };
      } catch (e) {
        return gatewayError(e);
      }
    },
  },

  {
    name: "familiar_route",
    description: "Check which backend (Claude Code or Ollama) should handle a given task based on complexity and availability.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task/message to evaluate" },
        hint: { type: "string", enum: ["heavy", "light", "auto"], description: "Force a routing decision" },
      },
      required: ["prompt"],
    },
    async handler({ prompt, hint }) {
      try {
        const health = await fetch(`${CLAUDE_PROXY_URL}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => ({}));
        const claudeAvailable = health.status === "ok" && health.claudeAvailable && health.online;

        const heavyPatterns = [/\b(refactor|architect|design|implement|build|create|migrate)\b/i, /\b(debug|diagnose|investigate|analyze)\b/i, /\b(multi.?file|across files|codebase|repo)\b/i, /\b(write code|write a|code that|function that|script that)\b/i, /\b(pull request|pr|commit|merge)\b/i];
        const lightPatterns = [/\b(remind|status|update|standup|summary)\b/i, /\b(list|show|get|check|hello|hi|thanks)\b/i];

        let score = 0.5;
        if (hint === "heavy") score = 1.0;
        else if (hint === "light") score = 0.0;
        else {
          for (const p of heavyPatterns) if (p.test(prompt)) score += 0.15;
          for (const p of lightPatterns) if (p.test(prompt)) score -= 0.15;
          if (prompt.length < 50) score -= 0.2;
          if (/```/.test(prompt)) score += 0.2;
          score = Math.max(0, Math.min(1, score));
        }

        const backend = score >= 0.6 && claudeAvailable ? "claude" : "ollama";
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              recommended: backend,
              complexityScore: parseFloat(score.toFixed(2)),
              claudeAvailable,
              reason: backend === "claude"
                ? `Score ${score.toFixed(2)} >= 0.6, Claude available`
                : claudeAvailable ? `Score ${score.toFixed(2)} < 0.6, using Ollama for efficiency` : "Claude unavailable, falling back to Ollama",
            }, null, 2),
          }],
        };
      } catch (e) {
        return gatewayError(e);
      }
    },
  },

  {
    name: "familiar_claude",
    description: "Run a task through Claude Code CLI (the heavy brain). Use this for code generation, refactoring, multi-file edits, debugging, and complex reasoning tasks.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task prompt for Claude Code" },
        model: { type: "string", description: "Model: 'sonnet' (fast, default), 'opus' (best), 'haiku' (cheapest)" },
        workingDir: { type: "string", description: "Working directory for the task" },
        systemPrompt: { type: "string", description: "Custom system prompt to prepend" },
        allowedTools: { type: "array", items: { type: "string" }, description: "Restrict which tools Claude Code can use" },
        maxTurns: { type: "number", description: "Maximum agentic turns" },
        timeoutMs: { type: "number", description: "Timeout in milliseconds (default: 300000)" },
      },
      required: ["prompt"],
    },
    async handler({ prompt, model, workingDir, systemPrompt, allowedTools, maxTurns, timeoutMs }) {
      try {
        const resp = await fetch(`${CLAUDE_PROXY_URL}/invoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, model, workingDir, systemPrompt, allowedTools, maxTurns, timeoutMs, allowOffline: false }),
          signal: AbortSignal.timeout(timeoutMs || 300000),
        });
        const result = await resp.json();

        if (result.error) {
          return { content: [{ type: "text", text: `Claude Code error: ${result.error}${result.hint ? "\nHint: " + result.hint : ""}` }], isError: true };
        }

        const text = typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2);
        const meta = [];
        if (result.model) meta.push(`model: ${result.model}`);
        if (result.cost_usd) meta.push(`cost: $${result.cost_usd.toFixed(4)}`);
        if (result.duration_ms) meta.push(`duration: ${(result.duration_ms / 1000).toFixed(1)}s`);
        if (result.num_turns) meta.push(`turns: ${result.num_turns}`);

        return { content: [{ type: "text", text: text + (meta.length ? `\n\n[${meta.join(" | ")}]` : "") }] };
      } catch (e) {
        return gatewayError(e);
      }
    },
  },

  {
    name: "familiar_raw",
    description: "Call any gateway method directly. Use this for advanced operations not covered by other tools.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", description: "The gateway method to call (e.g., 'agents.list', 'skills.status')" },
        params: { type: "string", description: "JSON string of parameters" },
      },
      required: ["method"],
    },
    async handler({ method, params }) {
      try {
        const parsedParams = params ? JSON.parse(params) : {};
        const result = await request(method, parsedParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return gatewayError(e);
      }
    },
  },

  {
    name: "familiar_sessions",
    description: "List or manage Familiar sessions",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "reset"], description: "Action: list or reset (default: list)" },
        agent: { type: "string", description: "Agent ID (default: familiar)" },
        session: { type: "string", description: "Session name (for reset)" },
      },
    },
    async handler({ action, agent, session }) {
      try {
        if (action === "reset" && session) {
          const result = await request("sessions.reset", { sessionKey: sessionKey(agent, session) });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        const result = await request("sessions.list", { agentId: agent || "familiar" });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return gatewayError(e);
      }
    },
  },

  {
    name: "familiar_history",
    description: "Get recent conversation history from Familiar",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Agent ID (default: familiar)" },
        session: { type: "string", description: "Session name (optional)" },
        limit: { type: "number", description: "Number of messages to retrieve (default: 20)" },
      },
    },
    async handler({ agent, session, limit }) {
      try {
        const result = await request("chat.history", { sessionKey: sessionKey(agent, session), limit: limit || 20 });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return gatewayError(e);
      }
    },
  },
];
