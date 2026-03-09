import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { writeObservation } from "./lib/observe.mjs";
import { queryRecent, querySearch, queryStats, queryProfile } from "./lib/memory-query.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────────
const PROJECT_DIR = resolve(__dirname, "..");
const FAMILIAR_HOME = process.env.FAMILIAR_HOME || resolve(process.env.HOME, ".familiar");
const CONFIG_PATH = existsSync(resolve(FAMILIAR_HOME, "config/familiar.json"))
  ? resolve(FAMILIAR_HOME, "config/familiar.json")
  : resolve(PROJECT_DIR, "config/familiar.json");
const DEFAULT_AGENT = "familiar";
const DEFAULT_SESSION_KEY = "familiar:mcp:main";
const CLAUDE_PROXY_URL = process.env.CLAUDE_PROXY_URL || "http://127.0.0.1:18791";
const ACTIVITY_URL = process.env.ACTIVITY_URL || "http://localhost:18790";

function logActivity(platform, role, content, sessionKey = "main") {
  fetch(`${ACTIVITY_URL}/activity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ platform, session_key: sessionKey, role, content }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
} catch (e) {
  console.error("Failed to read gateway config:", e.message);
  process.exit(1);
}

const GW_PORT = config.gateway?.port ?? 18789;
const GW_TOKEN = config.gateway?.auth?.token ?? process.env.FAMILIAR_GATEWAY_TOKEN ?? process.env.COZYTERM_GATEWAY_TOKEN;
const WS_URL = `ws://localhost:${GW_PORT}`;

// ── WebSocket connection to Familiar gateway ────────────────────────────────
let ws = null;
let connected = false;
let requestId = 0;
const pending = new Map();
const eventListeners = new Map();

function nextId() {
  return String(++requestId);
}

function connect() {
  return new Promise((resolve, reject) => {
    if (ws && connected) {
      resolve();
      return;
    }

    ws = new WebSocket(WS_URL, {
      headers: { Origin: `http://localhost:${GW_PORT}` },
    });
    let settled = false;

    ws.on("open", () => {
      // Wait for connect.challenge from server
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Handle connect challenge
      if (msg.type === "event" && msg.event === "connect.challenge") {
        ws.send(JSON.stringify({
          type: "req",
          id: nextId(),
          method: "connect",
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: "familiar-ui",
              version: "1.0.0",
              platform: "node",
              mode: "ui",
            },
            role: "operator",
            scopes: ["operator.admin", "operator.read", "operator.write", "operator.pairing", "chat"],
            auth: {
              token: GW_TOKEN,
            },
          },
        }));
        return;
      }

      // Handle connect response
      if (msg.type === "res" && !settled) {
        if (msg.ok) {
          connected = true;
          settled = true;
          resolve();
        } else {
          settled = true;
          reject(new Error(msg.error?.message || "Connection rejected"));
        }
        return;
      }

      // Handle request responses
      if (msg.type === "res" && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) {
          p.resolve(msg.payload);
        } else {
          p.reject(new Error(msg.error?.message || "Request failed"));
        }
        return;
      }

      // Handle events (for chat streaming, etc.)
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
    });

    ws.on("close", () => {
      connected = false;
      ws = null;
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error("WebSocket closed"));
      }
      pending.clear();
      for (const [id, l] of eventListeners) {
        clearTimeout(l.timer);
        l.reject(new Error("WebSocket closed"));
      }
      eventListeners.clear();
    });

    ws.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("Connection timeout"));
        ws?.close();
      }
    }, 10000);
  });
}

async function ensureConnected() {
  if (!ws || !connected) {
    await connect();
  }
}

function request(method, params = {}, timeoutMs = 30000) {
  return new Promise(async (resolve, reject) => {
    try {
      await ensureConnected();
    } catch (e) {
      reject(e);
      return;
    }

    const id = nextId();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Request timeout: ${method}`));
    }, timeoutMs);

    pending.set(id, { resolve, reject, timer });

    ws.send(JSON.stringify({
      type: "req",
      id,
      method,
      params,
    }));
  });
}

function waitForEvent(filter, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const id = nextId();
    const timer = setTimeout(() => {
      eventListeners.delete(id);
      reject(new Error("Event wait timeout"));
    }, timeoutMs);

    eventListeners.set(id, { resolve, reject, timer, filter });
  });
}

function sessionKey(agent, session) {
  const a = agent || DEFAULT_AGENT;
  return session ? `agent:${a}:${session}` : `agent:${a}:main`;
}

function extractText(msg) {
  if (typeof msg.text === "string") return msg.text;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
  return JSON.stringify(msg);
}

// ── MCP Server ──────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "familiar",
  version: "1.0.0",
});

// Tool: familiar_chat
server.tool(
  "familiar_chat",
  "Send a message to Familiar and get a response. Use this to communicate with the Familiar AI assistant.",
  {
    message: z.string().describe("The message to send to Familiar"),
    agent: z.string().optional().describe("Agent ID (default: familiar)"),
    session: z.string().optional().describe("Session name (optional, uses 'main')"),
  },
  async ({ message, agent, session }) => {
    try {
      const sk = sessionKey(agent, session);

      const sendResult = await request("chat.send", {
        sessionKey: sk,
        message,
        idempotencyKey: randomUUID(),
      });

      const runId = sendResult?.runId;
      if (!runId) {
        return { content: [{ type: "text", text: "Failed to send message: no runId returned" }] };
      }

      // Wait for the chat run to complete
      const finalEvent = await waitForEvent(
        (msg) =>
          msg.event === "chat" &&
          msg.payload?.runId === runId &&
          (msg.payload?.state === "final" || msg.payload?.state === "error"),
        120000
      );

      if (finalEvent.payload?.state === "error") {
        const errMsg = finalEvent.payload?.error || finalEvent.payload?.message || "Unknown error";
        return {
          content: [{ type: "text", text: `Familiar error: ${typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg)}` }],
          isError: true,
        };
      }

      // Get the response from history
      const history = await request("chat.history", {
        sessionKey: sk,
        limit: 5,
      });

      const messages = history?.messages || [];
      let responseText = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === "assistant") {
          responseText = extractText(m);
          break;
        }
      }

      // Fire-and-forget activity logging
      logActivity("telegram", "user", message, sk);
      if (responseText) logActivity("telegram", "assistant", responseText, sk);

      return {
        content: [{ type: "text", text: responseText || "Familiar responded but no text was captured." }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: familiar_status
server.tool(
  "familiar_status",
  "Check Familiar system health and status",
  {},
  async () => {
    try {
      await ensureConnected();
      const info = await request("health", {});
      return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: familiar_history
server.tool(
  "familiar_history",
  "Get recent conversation history from Familiar",
  {
    agent: z.string().optional().describe("Agent ID (default: familiar)"),
    session: z.string().optional().describe("Session name (optional)"),
    limit: z.number().optional().describe("Number of messages to retrieve (default: 20)"),
  },
  async ({ agent, session, limit }) => {
    try {
      const result = await request("chat.history", {
        sessionKey: sessionKey(agent, session),
        limit: limit || 20,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: familiar_sessions
server.tool(
  "familiar_sessions",
  "List or manage Familiar sessions",
  {
    action: z.enum(["list", "reset"]).optional().describe("Action: list or reset (default: list)"),
    agent: z.string().optional().describe("Agent ID (default: familiar)"),
    session: z.string().optional().describe("Session name (for reset)"),
  },
  async ({ action, agent, session }) => {
    try {
      const agentId = agent || DEFAULT_AGENT;
      if (action === "reset" && session) {
        const result = await request("sessions.reset", { sessionKey: sessionKey(agent, session) });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      const result = await request("sessions.list", { agentId });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: familiar_config
server.tool(
  "familiar_config",
  "Read Familiar configuration",
  {
    section: z.string().optional().describe("Config section to read (e.g., 'agents', 'channels', 'skills'). Omit for full config."),
  },
  async ({ section }) => {
    try {
      const result = await request("config.get", {});
      const data = section ? result?.[section] : result;
      return {
        content: [{ type: "text", text: JSON.stringify(data ?? result, null, 2) }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: familiar_raw
server.tool(
  "familiar_raw",
  "Call any gateway method directly. Use this for advanced operations not covered by other tools.",
  {
    method: z.string().describe("The gateway method to call (e.g., 'agents.list', 'skills.status', 'cron.list')"),
    params: z.string().optional().describe("JSON string of parameters to pass to the method"),
  },
  async ({ method, params }) => {
    try {
      const parsedParams = params ? JSON.parse(params) : {};
      const result = await request(method, parsedParams);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// ── Claude Code Proxy helpers ────────────────────────────────────────────────

async function claudeProxyHealth() {
  try {
    const resp = await fetch(`${CLAUDE_PROXY_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return await resp.json();
  } catch (e) {
    return { status: "unreachable", error: e.message };
  }
}

async function claudeProxyInvoke(body) {
  const resp = await fetch(`${CLAUDE_PROXY_URL}/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(body.timeoutMs || 300000),
  });
  return await resp.json();
}

// ── Claude Code tools ────────────────────────────────────────────────────────

// Tool: familiar_claude — invoke Claude Code CLI for heavy tasks
server.tool(
  "familiar_claude",
  "Run a task through Claude Code CLI (the heavy brain). Use this for code generation, refactoring, multi-file edits, debugging, and complex reasoning tasks. Requires the Claude Code proxy to be running.",
  {
    prompt: z.string().describe("The task prompt for Claude Code"),
    model: z
      .string()
      .optional()
      .describe("Model to use: 'sonnet' (fast, default), 'opus' (best), 'haiku' (cheapest)"),
    workingDir: z
      .string()
      .optional()
      .describe("Working directory for the task (default: familiar workspace)"),
    systemPrompt: z
      .string()
      .optional()
      .describe("Custom system prompt to prepend"),
    allowedTools: z
      .array(z.string())
      .optional()
      .describe("Restrict which tools Claude Code can use (e.g. ['Read', 'Grep', 'Bash'])"),
    maxTurns: z
      .number()
      .optional()
      .describe("Maximum agentic turns (default: unlimited within timeout)"),
    timeoutMs: z
      .number()
      .optional()
      .describe("Timeout in milliseconds (default: 300000 = 5 min)"),
    addDirs: z
      .array(z.string())
      .optional()
      .describe("Additional directories to give Claude Code access to"),
  },
  async ({ prompt, model, workingDir, systemPrompt, allowedTools, maxTurns, timeoutMs, addDirs }) => {
    try {
      const result = await claudeProxyInvoke({
        prompt,
        model,
        workingDir,
        systemPrompt,
        allowedTools,
        maxTurns,
        timeoutMs,
        addDirs,
        allowOffline: false,
      });

      if (result.error) {
        return {
          content: [{ type: "text", text: `Claude Code error: ${result.error}${result.hint ? "\nHint: " + result.hint : ""}` }],
          isError: true,
        };
      }

      const text = typeof result.result === "string"
        ? result.result
        : JSON.stringify(result.result, null, 2);

      const meta = [];
      if (result.model) meta.push(`model: ${result.model}`);
      if (result.cost_usd) meta.push(`cost: $${result.cost_usd.toFixed(4)}`);
      if (result.duration_ms) meta.push(`duration: ${(result.duration_ms / 1000).toFixed(1)}s`);
      if (result.num_turns) meta.push(`turns: ${result.num_turns}`);

      const metaLine = meta.length > 0 ? `\n\n[${meta.join(" | ")}]` : "";

      return {
        content: [{ type: "text", text: text + metaLine }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error invoking Claude Code: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: familiar_route — ask the router which backend to use for a task
server.tool(
  "familiar_route",
  "Check which backend (Claude Code or Ollama) should handle a given task based on complexity and availability. Useful for deciding before sending a message.",
  {
    prompt: z.string().describe("The task/message to evaluate"),
    hint: z
      .enum(["heavy", "light", "auto"])
      .optional()
      .describe("Force a routing decision: 'heavy' (always Claude), 'light' (always Ollama), 'auto' (let router decide)"),
  },
  async ({ prompt, hint }) => {
    try {
      const health = await claudeProxyHealth();
      const claudeAvailable = health.status === "ok" && health.claudeAvailable && health.online;

      // Simple inline scoring (mirrors router.mjs logic)
      const heavyPatterns = [
        /\b(refactor|architect|design|implement|build|create|migrate)\b/i,
        /\b(debug|diagnose|investigate|analyze)\b/i,
        /\b(multi.?file|across files|codebase|repo)\b/i,
        /\b(write code|write a|code that|function that|script that)\b/i,
        /\b(pull request|pr|commit|merge)\b/i,
      ];
      const lightPatterns = [
        /\b(remind|status|update|standup|summary)\b/i,
        /\b(list|show|get|check|hello|hi|thanks)\b/i,
      ];

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
            ollamaAvailable: true, // assume if Familiar is running
            reason: backend === "claude"
              ? `Score ${score.toFixed(2)} >= 0.6, Claude available`
              : claudeAvailable
                ? `Score ${score.toFixed(2)} < 0.6, using Ollama for efficiency`
                : "Claude unavailable, falling back to Ollama",
          }, null, 2),
        }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Router error: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// ── Full system status including Claude Code proxy ──────────────────────────
// Note: McpServer doesn't support removing tools, so we registered the
// original above. The new Claude Code status is in familiar_system_status.

server.tool(
  "familiar_system_status",
  "Full system health: Familiar gateway + Claude Code proxy + Ollama + online status",
  {},
  async () => {
    try {
      const [gwHealth, proxyHealth] = await Promise.all([
        ensureConnected()
          .then(() => request("health", {}))
          .catch((e) => ({ error: e.message })),
        claudeProxyHealth(),
      ]);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            gateway: gwHealth,
            claudeCodeProxy: proxyHealth,
            timestamp: new Date().toISOString(),
          }, null, 2),
        }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: familiar_observe — write a structured observation to memory
server.tool(
  "familiar_observe",
  "Store a structured observation in Familiar's memory. Use this to record decisions, blockers, task updates, insights, and preferences discovered during work.",
  {
    type: z.enum(["task_update", "code_change", "decision", "blocker", "preference", "insight", "chat_exchange"]).describe("Observation type"),
    summary: z.string().describe("Concise summary of the observation"),
    project: z.string().optional().describe("Project name (e.g., 'myapp', 'familiar')"),
    details: z.string().optional().describe("Additional details or context"),
    tags: z.array(z.string()).optional().describe("Tags for categorization (e.g., ticket IDs like 'PROJ-42')"),
  },
  async ({ type, summary, project, details, tags }) => {
    try {
      const result = writeObservation({
        type,
        summary,
        project: project || null,
        details: details || null,
        tags: tags || [],
        source: "mcp",
      });

      if (result.ok) {
        return {
          content: [{ type: "text", text: `Observation stored: ${result.id}` }],
        };
      } else {
        return {
          content: [{ type: "text", text: `Failed to store observation: ${result.error}` }],
          isError: true,
        };
      }
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// ── Memory read tools ──────────────────────────────────────────────────────

// Tool: familiar_memory_search — full-text search across observations
server.tool(
  "familiar_memory_search",
  "Search Familiar's memory for past observations, decisions, blockers, and insights. Uses full-text search with optional filters.",
  {
    query: z.string().describe("Search query (FTS5 syntax supported, e.g. 'PROJ-42 blocker')"),
    type: z.enum(["task_update", "code_change", "decision", "blocker", "preference", "insight", "chat_exchange"]).optional().describe("Filter by observation type"),
    project: z.string().optional().describe("Filter by project name"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ query, type, project, limit }) => {
    try {
      const opts = {};
      if (type) opts.type = type;
      if (project) opts.project = project;
      if (limit) opts.limit = limit;

      const results = querySearch(query, opts);

      if (results.error) {
        return { content: [{ type: "text", text: `Search error: ${results.error}` }], isError: true };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: familiar_memory_recent — get recent observations
server.tool(
  "familiar_memory_recent",
  "Get the most recent observations from Familiar's memory, across all projects.",
  {
    limit: z.number().optional().describe("Number of observations to return (default 10)"),
  },
  async ({ limit }) => {
    try {
      const results = queryRecent(limit || 10);

      if (results.error) {
        return { content: [{ type: "text", text: `Query error: ${results.error}` }], isError: true };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: familiar_memory_stats — memory DB statistics
server.tool(
  "familiar_memory_stats",
  "Get statistics about Familiar's memory: observation counts by type and project, database size.",
  {},
  async () => {
    try {
      const stats = queryStats();

      if (stats.error) {
        return { content: [{ type: "text", text: `Stats error: ${stats.error}` }], isError: true };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: familiar_memory_profile — read user profile and preferences
server.tool(
  "familiar_memory_profile",
  "Read the user's profile and preferences. Use this to understand who you're talking to and how they prefer to work.",
  {},
  async () => {
    try {
      const data = queryProfile();

      if (data.error) {
        return { content: [{ type: "text", text: `Profile error: ${data.error}` }], isError: true };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Start server ────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
