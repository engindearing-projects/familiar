#!/usr/bin/env bun

// Familiar Gateway — Bun WebSocket server for agent dispatch.
// Speaks the same protocol as cli/src/gateway.mjs expects:
//   connect.challenge → connect → chat.send / chat.history / sessions.list / health / config.get
//
// Usage:
//   bun scripts/gateway.mjs
//   GATEWAY_PORT=18789 bun scripts/gateway.mjs

import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  Semaphore,
  cleanEnv,
  stripSessionEnv,
  claudeBin,
  checkOnline,
  invokeClaude,
  PROJECT_DIR,
} from "./shared-invoke.mjs";
import { Router, ROLE_HINTS } from "./router.mjs";
import { runToolLoop, getSoulContent } from "./tool-loop.mjs";
import { getFamiliarName } from "../shared/resolve.js";
import { warmDaemon, warmMcpServers } from "./tools.mjs";
import { validateResponse } from "./response-validator.mjs";
import { estimateTokens, estimateMessages } from "./token-utils.mjs";
import { runLongTask, findInterruptedTask } from "./task-runner.mjs";
import { getSessionManager } from "./claude-sessions.mjs";
import { resolveProject } from "./project-resolver.mjs";
import {
  createSession as dbCreateSession,
  listSessions as dbListSessions,
  getSessionById as dbGetSession,
  renameSession as dbRenameSession,
  archiveSession as dbArchiveSession,
  addSessionMessage as dbAddMessage,
  getSessionMessages as dbGetMessages,
  forkSession as dbForkSession,
  autoTitleSession as dbAutoTitle,
} from "./session-store.mjs";

stripSessionEnv();

// ── Gemini Flash — middle-tier fallback between Claude and local ────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || (() => {
  try {
    const env = readFileSync(resolve(PROJECT_DIR, "config", ".env"), "utf8");
    return env.match(/GEMINI_API_KEY=(.+)/)?.[1]?.trim();
  } catch { return null; }
})();
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

async function callGemini(prompt, systemPrompt) {
  if (!GEMINI_API_KEY) throw new Error("No Gemini API key");
  const contents = [];
  if (systemPrompt) {
    contents.push({ role: "user", parts: [{ text: systemPrompt }] });
    contents.push({ role: "model", parts: [{ text: "Understood." }] });
  }
  contents.push({ role: "user", parts: [{ text: prompt }] });
  const resp = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      generationConfig: { temperature: 0.5, maxOutputTokens: 16384 },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error(`Gemini ${resp.status}: ${err.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "(no response)";
}

// ── Config ──────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const HOME = process.env.HOME || "/tmp";
  const candidates = [
    resolve(HOME, ".familiar", "config", "familiar.json"),
    resolve(PROJECT_DIR, "config", "familiar.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return { config: JSON.parse(readFileSync(p, "utf8")), path: p };
      } catch { /* skip bad JSON */ }
    }
  }
  return { config: {}, path: null };
}

const { config, path: configPath } = loadConfig();
const PORT = parseInt(process.env.GATEWAY_PORT || String(config.gateway?.port ?? 18789), 10);
const AUTH_TOKEN = config.gateway?.auth?.token
  || process.env.FAMILIAR_GATEWAY_TOKEN
;
const BIND = config.gateway?.bind || "lan";

// Accepted client IDs
const ACCEPTED_CLIENT_IDS = new Set([
  "familiar-ui",
  "familiar-tray",
  "familiar-terminal",
  "familiar-telegram",
  "familiar-worker",
]);

// ── Claude Trigger ──────────────────────────────────────────────────────────
// Explicit phrases that invoke Claude. Checked BEFORE routing.
const CLAUDE_TRIGGER = /\b(ask\s+claude|@claude|use\s+claude|claude\s+says|hey\s+claude)\b/i;

const FAMILIAR_DISALLOWED_TOOLS = config.claude?.disallowedTools || [
  "mcp__familiar__familiar_chat",
  "mcp__familiar__familiar_claude",
];
const FAMILIAR_MAX_TURNS = 25;
const FAMILIAR_TIMEOUT_MS = 300_000;
const FAMILIAR_MCP_CONFIG = resolve(PROJECT_DIR, "config", "mcp-tools.json");
// MCP tool integrations — configurable via config file or env
const MCP_INTEGRATIONS = config.mcp?.integrations || [
  { name: "Jira", prefix: "mcp__atlassian__jira_*" },
  { name: "Slack", prefix: "mcp__slack__slack_*" },
  { name: "Figma", prefix: "mcp__figma__*" },
];

function buildSystemPreamble() {
  const lines = [
    `You are ${getFamiliarName()}, a persistent AI assistant from familiar.run — an AI project manager and coding assistant.`,
    "You have read/write access to local memory files in ~/.familiar/memory/.",
    "You have full access to the filesystem, Bash, and all standard Claude Code tools.",
  ];
  if (MCP_INTEGRATIONS.length > 0) {
    lines.push(`You have MCP tools for ${MCP_INTEGRATIONS.map(i => i.name).join(", ")}.`);
  }
  lines.push(
    "",
    "Guidelines:",
  );
  for (const integration of MCP_INTEGRATIONS) {
    lines.push(`- For ${integration.name}: use the ${integration.prefix} tools.`);
  }
  lines.push(
    "- For coding tasks: read files, edit code, run builds/tests, commit with git.",
    "- For GitHub: use the `gh` CLI tool.",
    "- Be concise and factual. Summarize results clearly.",
    "- If a tool call fails, mention the error briefly and try an alternative approach.",
    "- Never fabricate ticket numbers, statuses, or data.",
  );
  return lines.join("\n");
}

const FAMILIAR_SYSTEM_PREAMBLE = buildSystemPreamble();

// ── Smart Router ────────────────────────────────────────────────────────────

const claudeLimiter = new Semaphore(parseInt(process.env.CLAUDE_MAX_CONCURRENT || "2", 10));

const router = new Router({
  proxyUrl: `http://127.0.0.1:${process.env.CLAUDE_PROXY_PORT || 18791}`,
  ollamaUrl: "http://localhost:11434",
  localModel: "familiar-brain:latest",
});

// ── Forge Collectors (lazy-loaded) ──────────────────────────────────────────

let _collector = null;
async function getCollector() {
  if (_collector) return _collector;
  try {
    const { Collector } = await import("../trainer/collector.mjs");
    _collector = new Collector();
    return _collector;
  } catch { return null; }
}

// ── Session Store ───────────────────────────────────────────────────────────

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const sessions = new Map(); // sessionKey -> { messages[], lastActivity, claudeSessionId? }

function getSession(key) {
  const s = sessions.get(key);
  if (!s) return null;
  if (Date.now() - s.lastActivity > SESSION_TTL_MS) {
    sessions.delete(key);
    return null;
  }
  s.lastActivity = Date.now();
  return s;
}

function ensureSession(key) {
  let s = getSession(key);
  if (!s) {
    // Try to restore recent context from SQLite (last hour only).
    // Older sessions stay dead — stale history pollutes new context.
    s = hydrateRecentSession(key);
    if (!s) {
      s = { messages: [], lastActivity: Date.now(), claudeSessionId: null, dbSessionId: null };
      sessions.set(key, s);
    }
  }
  return s;
}

function hydrateRecentSession(sessionKey) {
  try {
    const dbSessions = dbListSessions({ limit: 50 });
    // Match by session_key column first, fall back to title match for backward compat
    const match = dbSessions.find(s => s.session_key === sessionKey)
      || dbSessions.find(s => s.title === sessionKey.slice(0, 60));
    if (!match) return null;

    // Only hydrate if the session was active in the last hour
    const lastUpdated = new Date(match.updated || match.created).getTime();
    if (Date.now() - lastUpdated > 60 * 60 * 1000) return null;

    const msgs = dbGetMessages(match.id, { limit: MAX_HISTORY });
    if (!msgs?.length) return null;

    const session = {
      messages: msgs.map(m => ({ role: m.role, content: m.text, ts: new Date(m.created).getTime() })),
      lastActivity: Date.now(),
      claudeSessionId: null,
      dbSessionId: match.id,
    };
    sessions.set(sessionKey, session);
    return session;
  } catch { return null; }
}

// Cleanup stale sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, s] of sessions) {
    if (now - s.lastActivity > SESSION_TTL_MS) sessions.delete(key);
  }
}, 600_000);

// ── Greeting Detection ──────────────────────────────────────────────────────

const GREETING_RE = /^(hi|hey|hello|yo|sup|thanks|thank\s+you|good\s+(morning|afternoon|evening|night)|what'?s?\s+up|how\s+are\s+you|how'?s?\s+it\s+going)[\s!.,?]*$/i;

function isPureGreeting(msg, role, conf) {
  return role === "chat" && conf > 0.7 && msg.length < 50 && GREETING_RE.test(msg.trim());
}

// ── Session History Helper ──────────────────────────────────────────────────

const MAX_HISTORY = 10;

function getSessionHistory(session) {
  if (!session?.messages?.length) return [];
  // Exclude the current (last) message, take the most recent MAX_HISTORY
  return session.messages.slice(0, -1).slice(-MAX_HISTORY).map(({ role, content }) => ({ role, content }));
}

// ── RAG (lightweight, for non-tool paths) ───────────────────────────────────

let _ragSearch = null;

async function getLightRagContext(query) {
  if (!_ragSearch) {
    try {
      const mod = await import("../brain/rag/index.mjs");
      _ragSearch = mod.search;
    } catch { return ""; }
  }
  try {
    const results = await _ragSearch(query, 2, { minScore: 0.5 });
    if (results.length === 0) return "";
    return results.map(r => r.text.slice(0, 300)).join("\n---\n");
  } catch { return ""; }
}

// ── Context Compaction ──────────────────────────────────────────────────────

const HISTORY_TOKEN_BUDGET = 4000;

async function compactHistory(session, model) {
  const history = getSessionHistory(session);
  if (!history.length) return history;

  const tokens = estimateMessages(history);
  if (tokens <= HISTORY_TOKEN_BUDGET) return history;

  // Split: keep last 4 messages as-is, summarize older ones
  const recent = history.slice(-4);
  const older = history.slice(0, -4);

  if (older.length === 0) return recent;

  // If we already have a cached summary and recent fits in budget, use it
  if (session.contextSummary) {
    const summaryMsg = { role: "system", content: `[Previous context] ${session.contextSummary}` };
    const combined = [summaryMsg, ...recent];
    if (estimateMessages(combined) <= HISTORY_TOKEN_BUDGET) return combined;
  }

  // Summarize older messages via a quick LLM call
  try {
    const olderText = older.map(m => `${m.role}: ${m.content}`).join("\n");
    const summary = await callOllamaDirect({
      prompt: `Summarize this conversation so far in 2-3 sentences:\n\n${olderText}`,
      systemPrompt: "You are a concise summarizer. Output only the summary, nothing else.",
      model,
      temperature: 0.3,
    });
    if (summary && summary.length > 10) {
      session.contextSummary = summary.trim();
      return [{ role: "system", content: `[Previous context] ${session.contextSummary}` }, ...recent];
    }
  } catch { /* summarization failed, just truncate */ }

  // Fallback: just return recent messages
  return recent;
}

// ── Session Persistence (SQLite) ────────────────────────────────────────────

function persistMessage(sessionKey, role, content) {
  try {
    // Ensure a persistent session exists for this key
    let session = sessions.get(sessionKey);
    if (!session?.dbSessionId) {
      const dbSession = dbCreateSession({ title: sessionKey.slice(0, 60), sessionKey });
      if (session) session.dbSessionId = dbSession.id;
    }
    const dbId = session?.dbSessionId;
    if (dbId) {
      dbAddMessage(dbId, { role, text: content });
    }
  } catch { /* persistence is best-effort */ }
}

function hydrateSession(sessionKey) {
  // Try to restore from SQLite when in-memory session is missing
  try {
    const dbSessions = dbListSessions({ limit: 100 });
    const match = dbSessions.find(s => s.title === sessionKey.slice(0, 60));
    if (!match) return null;

    const msgs = dbGetMessages(match.id, { limit: MAX_HISTORY * 2 });
    if (!msgs?.length) return null;

    const session = {
      messages: msgs.map(m => ({ role: m.role, content: m.text, ts: new Date(m.created).getTime() })),
      lastActivity: Date.now(),
      claudeSessionId: null,
      dbSessionId: match.id,
    };
    sessions.set(sessionKey, session);
    return session;
  } catch { return null; }
}

// ── Auto-Observation ────────────────────────────────────────────────────────

const PREFERENCE_RE = /\b(always|never|prefer|don'?t|stop|use|switch to)\b.{5,80}/i;
const DECISION_RE = /\b(let'?s (go with|use|do)|we'?(re|ll) (using|going|switching))\b.{5,80}/i;
const BLOCKER_RE = /\b(blocked|waiting on|can'?t|haven'?t|hasn'?t)\b.{5,80}/i;

let _memoryStore = null;

async function getMemoryStore() {
  if (_memoryStore) return _memoryStore;
  try {
    const mod = await import("./tools.mjs");
    if (mod.executeTool) {
      _memoryStore = mod.executeTool;
      return _memoryStore;
    }
  } catch { /* no memory store */ }
  return null;
}

function autoObserve(prompt, response, role) {
  // Skip greetings and very short exchanges
  if (isPureGreeting(prompt, role, 1.0)) return;
  if (prompt.length < 20 && response.length < 50) return;

  const observations = [];

  // Check the USER's prompt for preference/decision/blocker signals
  for (const [re, type] of [[PREFERENCE_RE, "preference"], [DECISION_RE, "decision"], [BLOCKER_RE, "blocker"]]) {
    const match = prompt.match(re);
    if (match) {
      observations.push({ type, text: match[0].trim(), source: "auto-observed" });
    }
  }

  if (observations.length === 0) return;

  // Fire-and-forget: store observations via memory_store tool
  getMemoryStore().then(exec => {
    if (!exec) return;
    for (const obs of observations) {
      exec("memory_store", {
        category: obs.type,
        content: obs.text,
        metadata: JSON.stringify({ source: "auto-observed", ts: new Date().toISOString() }),
      }).catch(() => {});
    }
  }).catch(() => {});
}

// ── Session Quality Logging ─────────────────────────────────────────────────

const QUALITY_LOG_DIR = resolve(PROJECT_DIR, "brain", "reflection");

function logSessionQuality({ role, confidence, flags, toolCalls, iterations }) {
  try {
    if (!existsSync(QUALITY_LOG_DIR)) mkdirSync(QUALITY_LOG_DIR, { recursive: true });
    const logPath = resolve(QUALITY_LOG_DIR, "session-quality.jsonl");
    const record = {
      ts: new Date().toISOString(),
      role,
      confidence,
      flags,
      toolCalls: toolCalls?.length || 0,
      iterations: iterations || 0,
    };
    appendFileSync(logPath, JSON.stringify(record) + "\n");
  } catch { /* best-effort */ }
}

// ── Memory Context Builder ───────────────────────────────────────────────────

const MEMORY_DIR = resolve(PROJECT_DIR, "memory");
const MEMORY_FILES = ["projects.md", "repos.md"];
const MEMORY_CACHE_TTL = 60_000; // 60 seconds
let _memoryCache = { text: null, at: 0 };

function buildMemoryContext() {
  if (_memoryCache.text && Date.now() - _memoryCache.at < MEMORY_CACHE_TTL) {
    return _memoryCache.text;
  }
  try {
    const parts = ["[Memory Context]"];
    for (const file of MEMORY_FILES) {
      const p = resolve(MEMORY_DIR, file);
      if (existsSync(p)) {
        const content = readFileSync(p, "utf8").trim();
        if (content) parts.push(`## ${file}\n${content}`);
      }
    }
    parts.push("[/Memory Context]");
    const text = parts.length > 2 ? parts.join("\n") : "";
    _memoryCache = { text, at: Date.now() };
    return text;
  } catch {
    return "";
  }
}

// ── Direct Ollama Call (non-tool models) ─────────────────────────────────────
// For reasoning and chat models that don't use the tool loop.
// Simple prompt → response via /api/generate.

async function callOllamaDirect({ prompt, systemPrompt, model, temperature, history }) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  if (history?.length > 0) messages.push(...history);
  messages.push({ role: "user", content: prompt });

  const resp = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: {
        num_predict: 4096,
        temperature: temperature ?? 0.7,
      },
    }),
    signal: AbortSignal.timeout(180_000), // longer timeout for cold starts (glm-4.7-flash)
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Ollama error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  return data.message?.content || "";
}

// ── Connected Clients ───────────────────────────────────────────────────────

const clients = new Map(); // ws -> { authed, clientId, connectedAt }

function broadcast(event, payload) {
  const msg = JSON.stringify({ type: "event", event, payload });
  for (const [ws, client] of clients) {
    if (client.authed && ws.readyState === 1) {
      ws.send(msg);
    }
  }
}

function formatStatusText(toolName, toolInput) {
  const basename = (p) => p ? p.split("/").pop() : "";
  switch (toolName) {
    case "Read":      return `Reading ${basename(toolInput?.file_path)}`;
    case "Grep":      return `Searching for '${(toolInput?.pattern || "").slice(0, 30)}'`;
    case "Glob":      return `Finding ${toolInput?.pattern || "files"}`;
    case "Bash":      return `Running ${(toolInput?.command || "").slice(0, 40)}`;
    case "Edit":      return `Editing ${basename(toolInput?.file_path)}`;
    case "Write":     return `Writing ${basename(toolInput?.file_path)}`;
    case "WebFetch":  return `Fetching web page`;
    case "WebSearch":  return `Searching '${(toolInput?.query || "").slice(0, 30)}'`;
    default:
      // Check configured MCP integrations for status text
      for (const integration of MCP_INTEGRATIONS) {
        const prefix = integration.prefix.replace(/\*$/, "");
        if (toolName?.startsWith(prefix)) return `Working in ${integration.name}`;
      }
      return toolName ? toolName.replace(/_/g, " ") : "Working";
  }
}

function sendTo(ws, obj) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
  }
}

// ── Chat Handler ────────────────────────────────────────────────────────────

async function handleChatSend(ws, reqId, params) {
  const { sessionKey, message } = params;
  if (!sessionKey || !message) {
    return sendTo(ws, { type: "res", id: reqId, ok: false, error: { message: "sessionKey and message required" } });
  }

  const runId = randomUUID().slice(0, 12);
  const session = ensureSession(sessionKey);

  // Acknowledge immediately
  sendTo(ws, { type: "res", id: reqId, ok: true, payload: { runId } });

  // Store user message
  session.messages.push({ role: "user", content: message, ts: Date.now() });

  try {
    let responseText = "";

    // ── Detect task resume requests ──
    const RESUME_RE = /^(continue|resume|keep going|pick up where you left off)[\s!.]*$/i;
    let resumeTaskId = null;
    if (RESUME_RE.test(message.trim())) {
      const interrupted = findInterruptedTask(sessionKey);
      if (interrupted) {
        resumeTaskId = interrupted.id;
        console.log(`[chat] resuming interrupted task ${resumeTaskId}`);
      }
    }

    // ── Route + build system prompt ──
    const isExplicitClaude = CLAUDE_TRIGGER.test(message);
    const effectivePrompt = isExplicitClaude
      ? (message.replace(CLAUDE_TRIGGER, "").trim() || message)
      : message;

    const routeResult = await router.route({ prompt: effectivePrompt, hasCode: /```/.test(message) });
    const { role } = routeResult;
    const roleHint = ROLE_HINTS[role] || "";

    console.log(`[chat] session=${sessionKey.slice(0, 30)} role=${role} route=${routeResult.backend}${isExplicitClaude ? " (explicit)" : ""} score=${routeResult.score?.toFixed(2)}`);

    // ── Auto-route to Claude terminal session for heavy coding tasks ──
    if (role === "coding" && routeResult.score >= 0.7) {
      const manager = getSessionManager();

      // Check for an existing active session for this sessionKey
      let activeSession = null;
      for (const [name, sess] of manager.sessions) {
        if (name.startsWith(`gw-${sessionKey.slice(0, 20)}`) && sess.status === "active") {
          activeSession = name;
          break;
        }
      }

      if (activeSession) {
        // Forward to existing session
        try {
          await manager.sendMessage(activeSession, effectivePrompt);
          console.log(`[chat] routed to active Claude session: ${activeSession}`);
          sendTo(ws, { type: "res", id: reqId, ok: true, payload: { runId } });
          broadcast("chat", { runId, sessionKey, state: "progress", message: { role: "assistant", content: `Sent to Claude session (${activeSession})...` } });
          return;
        } catch (err) {
          console.log(`[chat] session forward failed: ${err.message}, falling through to normal flow`);
        }
      } else {
        // Try to auto-start a session for the resolved project
        const match = resolveProject(effectivePrompt);
        if (match && match.confidence >= 0.6) {
          const sessionName = `gw-${sessionKey.slice(0, 20)}-${Date.now().toString(36)}`;
          try {
            await manager.startSession(sessionName, match.dir, effectivePrompt);
            manager.onOutput(sessionName, (name, delta) => {
              broadcast("claude.output", { name, delta });
            });
            console.log(`[chat] auto-started Claude session: ${sessionName} in ${match.dir}`);
            broadcast("chat", { runId, sessionKey, state: "progress", message: { role: "assistant", content: `Starting Claude in ${match.name} (${match.dir})...` } });
            // Don't return yet — the session will stream output via claude.output events
            // But we do need to send the final event eventually
            broadcast("chat", { runId, sessionKey, state: "final", message: { role: "assistant", content: `Claude session started for ${match.name}. Output streaming via claude.output events.` } });
            return;
          } catch (err) {
            console.log(`[chat] auto-start failed: ${err.message}, falling through to normal flow`);
          }
        }
      }
    }

    // Build system prompt with SOUL.md + role hint + memory context
    const soulContent = getSoulContent();
    const memoryCtx = buildMemoryContext();
    const systemParts = [FAMILIAR_SYSTEM_PREAMBLE];
    if (roleHint) systemParts.push(`\n${roleHint}`);
    if (soulContent) systemParts.push(`\n## Identity\n${soulContent.split("\n").slice(0, 15).join("\n")}`);
    if (memoryCtx) systemParts.push(`\n${memoryCtx}`);
    const fullSystemPrompt = systemParts.join("\n");

    const responseStart = Date.now();

    // Progress callback — sends intermediate updates to the client
    const onProgress = (msg) => {
      broadcast("chat", { runId, sessionKey, state: "progress", message: { role: "assistant", content: msg } });
    };

    // Status broadcast for tray/character presence
    broadcast("status", { text: "Thinking...", phase: "thinking" });
    broadcast("agent", { runId, sessionKey, stream: "thinking", data: { phase: "start" } });

    // Check Claude availability — fall back to local Ollama if offline
    let claudeReady = claudeBin() && await checkOnline();

    let usedFallback = false;

    if (claudeReady) {
      // ── Primary: Claude Code ──
      try {
        broadcast("agent", { runId, sessionKey, stream: "tool", data: { tool: "claude", name: "claude" } });
        broadcast("status", { text: "Working with Claude...", tool: "claude", phase: "tool_start" });
        const taskResult = await runLongTask({
          prompt: effectivePrompt,
          systemPrompt: fullSystemPrompt,
          claudeOpts: {
            outputFormat: "json",
            permissionMode: "bypassPermissions",
            disallowedTools: FAMILIAR_DISALLOWED_TOOLS,
            maxTurns: FAMILIAR_MAX_TURNS,
            addDirs: [resolve(PROJECT_DIR, "memory"), resolve(PROJECT_DIR, "workspace")],
            timeoutMs: FAMILIAR_TIMEOUT_MS,
            mcpConfig: FAMILIAR_MCP_CONFIG,
          },
          session,
          limiter: claudeLimiter,
          sessionKey,
          onProgress,
          resumeTaskId,
        });

        responseText = taskResult.text;
        const responseDurationMs = Date.now() - responseStart;

        if (taskResult.continuations > 0) {
          console.log(`[chat] long task done: ${taskResult.continuations} continuations, ${taskResult.totalTurns} turns, $${(taskResult.totalCost || 0).toFixed(4)}`);
        } else {
          console.log(`[chat] claude done: role=${role} duration=${responseDurationMs}ms`);
        }

        // Log session quality
        logSessionQuality({ role, confidence: 1.0, flags: [], toolCalls: null, iterations: 0 });

        // Fire Forge collector — every Claude response is training data
        getCollector().then((c) => {
          if (c) {
            // Detect tool calls from response text (Claude Code embeds them)
            const tcMatches = responseText.match(/\[Tool:\s*(\w+)/g) || [];
            const detectedTools = tcMatches.map(m => m.replace(/\[Tool:\s*/, ""));
            c.collectPair({
              prompt: message,
              routedTo: "claude",
              complexityScore: routeResult.score,
              primaryResponse: responseText,
              primaryDurationMs: responseDurationMs,
              toolsUsed: detectedTools.length ? [...new Set(detectedTools)] : undefined,
            });
          }
        }).catch(() => {});
      } catch (claudeErr) {
        // Claude failed (rate limit, crash, etc.) — try Gemini next
        const reason = claudeErr.message?.includes("hit your limit") ? "rate-limited" : "errored";
        console.log(`[chat] Claude ${reason}: ${claudeErr.message}`);
        claudeReady = false;
        usedFallback = true;
      }
    }

    // ── Gemini Flash — middle tier (silver, free) ──
    let geminiDone = false;
    if (!claudeReady && GEMINI_API_KEY) {
      try {
        console.log(`[chat] trying Gemini Flash fallback`);
        broadcast("agent", { runId, sessionKey, stream: "thinking", data: { phase: "end" } });
        broadcast("chat", { runId, sessionKey, state: "progress", message: { role: "assistant", content: "(Claude unavailable — using Gemini Flash)" } });
        broadcast("agent", { runId, sessionKey, stream: "tool", data: { tool: "gemini", name: "gemini" } });
        broadcast("status", { text: "Working with Gemini...", tool: "gemini", phase: "tool_start" });

        responseText = await callGemini(effectivePrompt, fullSystemPrompt);
        const responseDurationMs = Date.now() - responseStart;
        console.log(`[chat] gemini done: duration=${responseDurationMs}ms len=${responseText.length}`);

        logSessionQuality({ role, confidence: 0.7, flags: ["gemini-fallback"], toolCalls: 0, iterations: 0 });

        // Forge collector — Gemini responses are training data too
        getCollector().then((c) => {
          if (c) {
            const tcMatches = responseText.match(/\[Tool:\s*(\w+)/g) || [];
            const detectedTools = tcMatches.map(m => m.replace(/\[Tool:\s*/, ""));
            c.collectPair({
              prompt: message,
              routedTo: "gemini",
              complexityScore: routeResult.score,
              primaryResponse: responseText,
              primaryDurationMs: responseDurationMs,
              toolsUsed: detectedTools.length ? [...new Set(detectedTools)] : undefined,
            });
          }
        }).catch(() => {});

        geminiDone = true;
      } catch (geminiErr) {
        console.log(`[chat] Gemini failed: ${geminiErr.message}`);
      }
    }

    if (!claudeReady && !geminiDone) {
      // ── Last resort: Local Ollama model ──
      const reason = usedFallback ? "Claude + Gemini failed, using local model" : "Claude + Gemini offline";
      console.log(`[chat] ${reason}, falling back to Ollama tool-loop`);
      broadcast("agent", { runId, sessionKey, stream: "thinking", data: { phase: "end" } });
      broadcast("chat", { runId, sessionKey, state: "progress", message: { role: "assistant", content: `(Running on local model — ${reason})` } });

      const loopResult = await runToolLoop({
        prompt: effectivePrompt,
        systemPrompt: fullSystemPrompt,
        model: routeResult.model || "familiar-brain:latest",
        maxIterations: 10,
        maxToolCalls: 25,
        timeoutMs: 120_000,
        onToolCall: (name, input) => {
          const text = formatStatusText(name, input);
          broadcast("status", { text, tool: name, phase: "tool_start" });
        },
      });

      responseText = loopResult.response || "(no response)";
      const responseDurationMs = Date.now() - responseStart;
      console.log(`[chat] ollama fallback done: ${loopResult.iterations} iters, ${loopResult.toolCalls.length} tools, duration=${responseDurationMs}ms`);

      logSessionQuality({ role, confidence: 0.5, flags: [usedFallback ? "claude+gemini-fallback" : "offline-fallback"], toolCalls: loopResult.toolCalls.length, iterations: loopResult.iterations });

      // Forge collector — local tool-loop responses with full tool call data
      if (loopResult.toolCalls?.length) {
        getCollector().then((c) => {
          if (c) c.collectPair({
            prompt: message,
            routedTo: "ollama",
            complexityScore: routeResult.score,
            primaryResponse: responseText,
            primaryDurationMs: responseDurationMs,
            primaryModel: routeResult.model || "familiar-brain:latest",
            toolCalls: loopResult.toolCalls.map(tc => ({
              name: tc.name,
              arguments: tc.arguments,
              result: (tc.result || "").slice(0, 4000),
            })),
            toolsUsed: [...new Set(loopResult.toolCalls.map(tc => tc.name))],
          });
        }).catch(() => {});
      }
    }

    // Signal thinking ended before sending the response
    broadcast("agent", { runId, sessionKey, stream: "thinking", data: { phase: "end" } });
    broadcast("agent", { runId, sessionKey, stream: "assistant", data: { delta: responseText } });

    // Store assistant message
    session.messages.push({ role: "assistant", content: responseText, ts: Date.now() });

    // Persist to SQLite (fire-and-forget)
    persistMessage(sessionKey, "user", message);
    persistMessage(sessionKey, "assistant", responseText);

    // Auto-observe preferences, decisions, blockers (fire-and-forget)
    autoObserve(message, responseText, "chat");

    // Broadcast final
    broadcast("chat", {
      runId,
      sessionKey,
      state: "final",
      message: { role: "assistant", content: responseText },
    });

    // Clear status indicator
    broadcast("status", { text: null, phase: "idle" });

    // Push cmux notification on task completion
    cmuxNotify("Task Complete", responseText.slice(0, 100)).catch(() => {});
  } catch (err) {
    console.error(`[chat] error for ${sessionKey}:`, err.message);
    broadcast("chat", {
      runId,
      sessionKey,
      state: "error",
      error: err.message,
      errorMessage: err.message,
    });

    // Push cmux notification on error
    cmuxNotify("Error", err.message.slice(0, 100)).catch(() => {});
  }
}

// ── Hands (Autonomous Capability Packages) ────────────────────────────────

let _handRegistry = null;

async function getHandRegistry() {
  if (_handRegistry) return _handRegistry;
  try {
    const { HandRegistry } = await import("../brain/hands/registry.mjs");
    _handRegistry = new HandRegistry();
    _handRegistry.load();
    return _handRegistry;
  } catch (err) {
    console.error("[hands] Failed to load registry:", err.message);
    return null;
  }
}

function handleHandList(ws, id) {
  getHandRegistry().then(reg => {
    if (!reg) return sendTo(ws, { type: "res", id, ok: false, error: { message: "Hands system unavailable" } });
    reg.reload();
    const hands = reg.list();
    sendTo(ws, { type: "res", id, ok: true, payload: { hands } });
  });
}

function handleHandStatus(ws, id, params) {
  getHandRegistry().then(reg => {
    if (!reg) return sendTo(ws, { type: "res", id, ok: false, error: { message: "Hands system unavailable" } });
    reg.reload();
    const metrics = reg.getMetrics(params.name);
    if (!metrics) return sendTo(ws, { type: "res", id, ok: false, error: { message: `Hand "${params.name}" not found` } });
    sendTo(ws, { type: "res", id, ok: true, payload: metrics });
  });
}

function handleHandLifecycle(ws, id, params, action) {
  getHandRegistry().then(reg => {
    if (!reg) return sendTo(ws, { type: "res", id, ok: false, error: { message: "Hands system unavailable" } });
    const result = reg[action](params.name);
    if (result.ok) {
      sendTo(ws, { type: "res", id, ok: true, payload: { action, name: params.name } });
    } else {
      sendTo(ws, { type: "res", id, ok: false, error: { message: result.error } });
    }
  });
}

function handleHandRun(ws, id, params) {
  getHandRegistry().then(async reg => {
    if (!reg) return sendTo(ws, { type: "res", id, ok: false, error: { message: "Hands system unavailable" } });
    const hand = reg.get(params.name);
    if (!hand) return sendTo(ws, { type: "res", id, ok: false, error: { message: `Hand "${params.name}" not found` } });

    // Auto-activate if inactive
    if (hand.status === "inactive") reg.activate(params.name);

    // Acknowledge the request immediately — hand runs async
    sendTo(ws, { type: "res", id, ok: true, payload: { started: true, name: params.name } });

    // Run in background
    try {
      const { runHand } = await import("../brain/hands/runner.mjs");
      const result = await runHand(reg, params.name, { notify: true });
      broadcast("hand.complete", { name: params.name, ok: result.ok, duration: result.duration });
      cmuxNotify(`Hand: ${params.name}`, result.ok ? "Completed" : "Failed").catch(() => {});
    } catch (err) {
      broadcast("hand.error", { name: params.name, error: err.message });
    }
  });
}

function handleHandMetrics(ws, id) {
  getHandRegistry().then(reg => {
    if (!reg) return sendTo(ws, { type: "res", id, ok: false, error: { message: "Hands system unavailable" } });
    reg.reload();
    const hands = reg.list();
    const metrics = hands.map(h => ({
      ...reg.getMetrics(h.name),
      schedule: h.schedule,
    }));
    sendTo(ws, { type: "res", id, ok: true, payload: { hands: metrics } });
  });
}

// ── Triggers (Event-Driven Hand Activation) ─────────────────────────────────

let _triggerManager = null;
let _eventBus = null;

async function getTriggerManager() {
  if (_triggerManager) return _triggerManager;
  try {
    const reg = await getHandRegistry();
    if (!reg) return null;
    const { EventBus, TriggerManager } = await import("../brain/hands/triggers.mjs");
    _eventBus = new EventBus();
    _triggerManager = new TriggerManager(_eventBus, reg);
    _triggerManager.loadFromManifests();
    _triggerManager.start();
    return _triggerManager;
  } catch (err) {
    console.error("[triggers] Failed to load trigger manager:", err.message);
    return null;
  }
}

function handleTriggerList(ws, id) {
  getTriggerManager().then(mgr => {
    if (!mgr) return sendTo(ws, { type: "res", id, ok: false, error: { message: "Trigger system unavailable" } });
    const triggers = mgr.listTriggers();
    sendTo(ws, { type: "res", id, ok: true, payload: { triggers } });
  });
}

function handleTriggerRegister(ws, id, params) {
  getTriggerManager().then(mgr => {
    if (!mgr) return sendTo(ws, { type: "res", id, ok: false, error: { message: "Trigger system unavailable" } });
    if (!params.hand || !params.trigger) {
      return sendTo(ws, { type: "res", id, ok: false, error: { message: "Requires 'hand' and 'trigger' params" } });
    }
    const result = mgr.registerTrigger(params.hand, params.trigger);
    if (result.ok) {
      sendTo(ws, { type: "res", id, ok: true, payload: { registered: true, hand: params.hand, key: result.key } });
    } else {
      sendTo(ws, { type: "res", id, ok: false, error: { message: result.error } });
    }
  });
}

function handleTriggerRemove(ws, id, params) {
  getTriggerManager().then(mgr => {
    if (!mgr) return sendTo(ws, { type: "res", id, ok: false, error: { message: "Trigger system unavailable" } });
    if (!params.hand) {
      return sendTo(ws, { type: "res", id, ok: false, error: { message: "Requires 'hand' param" } });
    }
    const result = mgr.removeTrigger(params.hand, params.type);
    sendTo(ws, { type: "res", id, ok: true, payload: { removed: result.removed } });
  });
}

// ── Workflows (Dependency Graph Task Chaining) ──────────────────────────────

function handleWorkflowRun(ws, id, params) {
  (async () => {
    try {
      const { loadWorkflow, startWorkflow, executeWorkflow } = await import("../brain/workflows/engine.mjs");

      let definition;
      if (params.definition) {
        definition = params.definition;
      } else if (params.file) {
        const loaded = loadWorkflow(params.file);
        if (!loaded.ok) {
          return sendTo(ws, { type: "res", id, ok: false, error: { message: loaded.error } });
        }
        definition = loaded.definition;
      } else {
        return sendTo(ws, { type: "res", id, ok: false, error: { message: "Provide 'file' or 'definition'" } });
      }

      const dryRun = params.dryRun || false;

      const { runId, workflow } = startWorkflow(definition, {
        dryRun,
        onStep: (event) => {
          broadcast("workflow.step", { runId, workflow, ...event });
        },
      });

      sendTo(ws, { type: "res", id, ok: true, payload: { started: true, runId, workflow } });

      const { getWorkflowStatus } = await import("../brain/workflows/engine.mjs");
      const checkDone = setInterval(() => {
        const status = getWorkflowStatus(runId);
        if (status && status.status !== "running") {
          clearInterval(checkDone);
          broadcast("workflow.complete", { runId, workflow, ok: status.result?.ok, duration: status.duration });
        }
      }, 2000);

      setTimeout(() => clearInterval(checkDone), (definition.timeout || 7200) * 1000 + 30000);

    } catch (err) {
      sendTo(ws, { type: "res", id, ok: false, error: { message: err.message } });
    }
  })();
}

function handleWorkflowStatus(ws, id, params) {
  (async () => {
    try {
      const { getWorkflowStatus } = await import("../brain/workflows/engine.mjs");
      const status = getWorkflowStatus(params.runId || null);
      if (status === null) {
        return sendTo(ws, { type: "res", id, ok: false, error: { message: `Workflow run "${params.runId}" not found` } });
      }
      sendTo(ws, { type: "res", id, ok: true, payload: Array.isArray(status) ? { workflows: status } : status });
    } catch (err) {
      sendTo(ws, { type: "res", id, ok: false, error: { message: err.message } });
    }
  })();
}

function handleWorkflowList(ws, id) {
  (async () => {
    try {
      const { listWorkflows } = await import("../brain/workflows/engine.mjs");
      const workflows = listWorkflows();
      sendTo(ws, { type: "res", id, ok: true, payload: { workflows } });
    } catch (err) {
      sendTo(ws, { type: "res", id, ok: false, error: { message: err.message } });
    }
  })();
}

function handleWorkflowValidate(ws, id, params) {
  (async () => {
    try {
      const { validateWorkflow } = await import("../brain/workflows/schema.mjs");
      const { loadWorkflow } = await import("../brain/workflows/engine.mjs");

      let definition;
      if (params.definition) {
        definition = params.definition;
      } else if (params.file) {
        const loaded = loadWorkflow(params.file);
        if (!loaded.ok) {
          return sendTo(ws, { type: "res", id, ok: false, error: { message: loaded.error } });
        }
        definition = loaded.definition;
      } else {
        return sendTo(ws, { type: "res", id, ok: false, error: { message: "Provide 'file' or 'definition'" } });
      }

      const result = validateWorkflow(definition);
      sendTo(ws, { type: "res", id, ok: result.valid, payload: result.valid ? { valid: true, steps: definition.steps.length } : { valid: false, errors: result.errors } });
    } catch (err) {
      sendTo(ws, { type: "res", id, ok: false, error: { message: err.message } });
    }
  })();
}

// ── cmux Terminal Integration ────────────────────────────────────────────────
// Lazy-connects to cmux socket for notifications and terminal control.
// All calls are fire-and-forget — failures are silently ignored so cmux
// is never a hard dependency.

let _cmuxGatewayClient = null;

async function getCmuxGatewayClient() {
  if (_cmuxGatewayClient?.connected) return _cmuxGatewayClient;
  const { CmuxClient, isCmuxAvailable } = await import("./cmux-client.mjs");
  if (!isCmuxAvailable()) return null;
  try {
    _cmuxGatewayClient = new CmuxClient();
    await _cmuxGatewayClient.connect();
    console.log("[gateway] cmux connected");
    return _cmuxGatewayClient;
  } catch {
    _cmuxGatewayClient = null;
    return null;
  }
}

async function cmuxNotify(title, body) {
  try {
    const client = await getCmuxGatewayClient();
    if (client) await client.notificationCreate(title, body);
  } catch {
    _cmuxGatewayClient = null; // reset on failure, will retry next time
  }
}

async function handleCmuxStatus(ws, id) {
  try {
    const client = await getCmuxGatewayClient();
    if (!client) return sendTo(ws, { type: "res", id, ok: true, payload: { connected: false } });
    const workspaces = await client.workspaceList();
    return sendTo(ws, { type: "res", id, ok: true, payload: { connected: true, workspaces: workspaces.length } });
  } catch (err) {
    return sendTo(ws, { type: "res", id, ok: false, error: { message: err.message } });
  }
}

async function handleCmuxWorkspaces(ws, id) {
  try {
    const client = await getCmuxGatewayClient();
    if (!client) return sendTo(ws, { type: "res", id, ok: false, error: { message: "cmux not connected" } });
    const workspaces = await client.workspaceList();
    return sendTo(ws, { type: "res", id, ok: true, payload: { workspaces } });
  } catch (err) {
    return sendTo(ws, { type: "res", id, ok: false, error: { message: err.message } });
  }
}

async function handleCmuxSurfaces(ws, id, params) {
  try {
    const client = await getCmuxGatewayClient();
    if (!client) return sendTo(ws, { type: "res", id, ok: false, error: { message: "cmux not connected" } });
    const surfaces = await client.surfaceList();
    return sendTo(ws, { type: "res", id, ok: true, payload: { surfaces } });
  } catch (err) {
    return sendTo(ws, { type: "res", id, ok: false, error: { message: err.message } });
  }
}

async function handleCmuxNotifyReq(ws, id, params) {
  try {
    await cmuxNotify(params.title || "Familiar", params.body || "");
    return sendTo(ws, { type: "res", id, ok: true, payload: { sent: true } });
  } catch (err) {
    return sendTo(ws, { type: "res", id, ok: false, error: { message: err.message } });
  }
}

// ── Request Dispatch ────────────────────────────────────────────────────────

function handleRequest(ws, msg) {
  const { id, method, params = {} } = msg;

  switch (method) {
    case "connect":
      return handleConnect(ws, id, params);

    case "chat.send":
      // Fire-and-forget async — response is sent inside
      handleChatSend(ws, id, params);
      return;

    case "chat.history": {
      const session = getSession(params.sessionKey);
      const limit = params.limit || 20;
      const messages = session ? session.messages.slice(-limit) : [];
      return sendTo(ws, { type: "res", id, ok: true, payload: { messages } });
    }

    case "sessions.list": {
      const list = [];
      for (const [key, s] of sessions) {
        const source = key.split(":")[1] || "unknown";
        const lastMsg = s.messages.length > 0 ? s.messages[s.messages.length - 1] : null;
        list.push({
          sessionKey: key,
          source,
          messageCount: s.messages.length,
          lastActivity: s.lastActivity,
          idleMs: Date.now() - s.lastActivity,
          hasClaudeSession: !!s.claudeSessionId,
          lastMessage: lastMsg ? lastMsg.content?.slice(0, 120) : null,
          lastRole: lastMsg?.role || null,
        });
      }
      return sendTo(ws, { type: "res", id, ok: true, payload: { sessions: list } });
    }

    case "sessions.reset": {
      if (params.sessionKey) {
        sessions.delete(params.sessionKey);
      }
      return sendTo(ws, { type: "res", id, ok: true, payload: { ok: true } });
    }

    case "health":
      return handleHealth(ws, id);

    case "config.get":
      return handleConfigGet(ws, id);

    // ── Persistent Session Management ──
    case "session.create": {
      try {
        const session = dbCreateSession({ title: params.title, workingDir: params.workingDir });
        return sendTo(ws, { type: "res", id, ok: true, payload: session });
      } catch (err) {
        return sendTo(ws, { type: "res", id, ok: false, error: { message: err.message } });
      }
    }

    case "session.list": {
      try {
        const sessions = dbListSessions({ includeArchived: params.includeArchived, limit: params.limit });
        return sendTo(ws, { type: "res", id, ok: true, payload: { sessions } });
      } catch (err) {
        return sendTo(ws, { type: "res", id, ok: false, error: { message: err.message } });
      }
    }

    case "session.get": {
      try {
        const session = dbGetSession(params.sessionId);
        if (!session) return sendTo(ws, { type: "res", id, ok: false, error: { message: "Session not found" } });
        return sendTo(ws, { type: "res", id, ok: true, payload: session });
      } catch (err) {
        return sendTo(ws, { type: "res", id, ok: false, error: { message: err.message } });
      }
    }

    case "session.rename": {
      try {
        dbRenameSession(params.sessionId, params.title);
        return sendTo(ws, { type: "res", id, ok: true, payload: { ok: true } });
      } catch (err) {
        return sendTo(ws, { type: "res", id, ok: false, error: { message: err.message } });
      }
    }

    case "session.archive": {
      try {
        dbArchiveSession(params.sessionId, params.archived ?? true);
        return sendTo(ws, { type: "res", id, ok: true, payload: { ok: true } });
      } catch (err) {
        return sendTo(ws, { type: "res", id, ok: false, error: { message: err.message } });
      }
    }

    case "session.fork": {
      try {
        const forked = dbForkSession(params.sessionId, { title: params.title, upToMessageId: params.upToMessageId });
        return sendTo(ws, { type: "res", id, ok: true, payload: forked });
      } catch (err) {
        return sendTo(ws, { type: "res", id, ok: false, error: { message: err.message } });
      }
    }

    case "session.messages": {
      try {
        const messages = dbGetMessages(params.sessionId, { limit: params.limit, offset: params.offset });
        return sendTo(ws, { type: "res", id, ok: true, payload: { messages } });
      } catch (err) {
        return sendTo(ws, { type: "res", id, ok: false, error: { message: err.message } });
      }
    }

    case "session.addMessage": {
      try {
        const msgId = dbAddMessage(params.sessionId, { role: params.role, text: params.text, metadata: params.metadata });
        dbAutoTitle(params.sessionId);
        return sendTo(ws, { type: "res", id, ok: true, payload: { messageId: msgId } });
      } catch (err) {
        return sendTo(ws, { type: "res", id, ok: false, error: { message: err.message } });
      }
    }

    // ── Claude Terminal Sessions ──
    case "claude.start": {
      handleClaudeStart(ws, id, params);
      return;
    }

    case "claude.send": {
      handleClaudeSend(ws, id, params);
      return;
    }

    case "claude.close": {
      handleClaudeClose(ws, id, params);
      return;
    }

    case "claude.list": {
      handleClaudeList(ws, id);
      return;
    }

    case "claude.capture": {
      handleClaudeCapture(ws, id, params);
      return;
    }

    // ── Hands (Autonomous Capability Packages) ──
    case "hand.list": {
      handleHandList(ws, id);
      return;
    }

    case "hand.status": {
      handleHandStatus(ws, id, params);
      return;
    }

    case "hand.activate": {
      handleHandLifecycle(ws, id, params, "activate");
      return;
    }

    case "hand.pause": {
      handleHandLifecycle(ws, id, params, "pause");
      return;
    }

    case "hand.resume": {
      handleHandLifecycle(ws, id, params, "resume");
      return;
    }

    case "hand.deactivate": {
      handleHandLifecycle(ws, id, params, "deactivate");
      return;
    }

    case "hand.run": {
      handleHandRun(ws, id, params);
      return;
    }

    case "hand.metrics": {
      handleHandMetrics(ws, id);
      return;
    }

    // ── Triggers (Event-Driven) ──
    case "trigger.list": {
      handleTriggerList(ws, id);
      return;
    }

    case "trigger.register": {
      handleTriggerRegister(ws, id, params);
      return;
    }

    case "trigger.remove": {
      handleTriggerRemove(ws, id, params);
      return;
    }

    // ── Workflows (Task Chaining Engine) ──
    case "workflow.run": {
      handleWorkflowRun(ws, id, params);
      return;
    }

    case "workflow.status": {
      handleWorkflowStatus(ws, id, params);
      return;
    }

    case "workflow.list": {
      handleWorkflowList(ws, id);
      return;
    }

    case "workflow.validate": {
      handleWorkflowValidate(ws, id, params);
      return;
    }

    // ── cmux Terminal Control ──
    case "cmux.status": {
      handleCmuxStatus(ws, id);
      return;
    }
    case "cmux.workspaces": {
      handleCmuxWorkspaces(ws, id);
      return;
    }
    case "cmux.surfaces": {
      handleCmuxSurfaces(ws, id, params);
      return;
    }
    case "cmux.notify": {
      handleCmuxNotifyReq(ws, id, params);
      return;
    }

    default:
      return sendTo(ws, { type: "res", id, ok: false, error: { message: `Unknown method: ${method}` } });
  }
}

function handleConnect(ws, id, params) {
  const clientId = params.client?.id;
  const token = params.auth?.token;

  // Validate client ID (accept both old and new)
  if (clientId && !ACCEPTED_CLIENT_IDS.has(clientId)) {
    console.log(`[auth] rejected unknown client: ${clientId}`);
    return sendTo(ws, { type: "res", id, ok: false, error: { message: "Unknown client ID" } });
  }

  // Validate auth token
  if (AUTH_TOKEN && token !== AUTH_TOKEN) {
    console.log(`[auth] rejected bad token from ${clientId}`);
    return sendTo(ws, { type: "res", id, ok: false, error: { message: "Invalid auth token" } });
  }

  const client = clients.get(ws);
  if (client) {
    client.authed = true;
    client.clientId = clientId;
  }

  console.log(`[auth] connected: ${clientId}`);
  return sendTo(ws, {
    type: "res",
    id,
    ok: true,
    payload: {
      protocol: 3,
      server: { id: "familiar-gateway", version: "1.0.0" },
    },
  });
}

async function handleHealth(ws, id) {
  const bin = claudeBin();
  const online = await checkOnline();

  let ollamaUp = false;
  try {
    const r = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(3000) });
    ollamaUp = r.ok;
  } catch { /* offline */ }

  sendTo(ws, {
    type: "res",
    id,
    ok: true,
    payload: {
      status: "ok",
      gateway: "familiar",
      version: "1.0.0",
      uptime: process.uptime(),
      claudeAvailable: !!bin,
      claudePath: bin,
      online,
      ollamaAvailable: ollamaUp,
      activeSessions: sessions.size,
      connectedClients: clients.size,
    },
  });
}

function handleConfigGet(ws, id) {
  // Return sanitized config (strip auth token)
  const safe = { ...config };
  if (safe.gateway?.auth) {
    safe.gateway = { ...safe.gateway, auth: { mode: "token", token: "***" } };
  }
  sendTo(ws, { type: "res", id, ok: true, payload: safe });
}

// ── Claude Terminal Session Handlers ──────────────────────────────────────

async function handleClaudeStart(ws, id, params) {
  const { name, projectDir, initialPrompt } = params;
  if (!name || !projectDir) {
    return sendTo(ws, { type: "res", id, ok: false, error: { message: "name and projectDir required" } });
  }

  try {
    const manager = getSessionManager();
    const session = await manager.startSession(name, projectDir, initialPrompt || null);

    // Wire output monitoring to broadcast
    manager.onOutput(name, (sessionName, delta) => {
      broadcast("claude.output", { name: sessionName, delta });
    });

    sendTo(ws, { type: "res", id, ok: true, payload: session });
  } catch (err) {
    sendTo(ws, { type: "res", id, ok: false, error: { message: err.message } });
  }
}

async function handleClaudeSend(ws, id, params) {
  const { name, message } = params;
  if (!name || !message) {
    return sendTo(ws, { type: "res", id, ok: false, error: { message: "name and message required" } });
  }

  try {
    const manager = getSessionManager();
    await manager.sendMessage(name, message);
    sendTo(ws, { type: "res", id, ok: true, payload: { ok: true } });
  } catch (err) {
    sendTo(ws, { type: "res", id, ok: false, error: { message: err.message } });
  }
}

async function handleClaudeClose(ws, id, params) {
  const { name } = params;
  if (!name) {
    return sendTo(ws, { type: "res", id, ok: false, error: { message: "name required" } });
  }

  try {
    const manager = getSessionManager();
    await manager.closeSession(name);
    sendTo(ws, { type: "res", id, ok: true, payload: { ok: true } });
  } catch (err) {
    sendTo(ws, { type: "res", id, ok: false, error: { message: err.message } });
  }
}

async function handleClaudeList(ws, id) {
  try {
    const manager = getSessionManager();
    const sessions = await manager.listSessions();
    sendTo(ws, { type: "res", id, ok: true, payload: { sessions } });
  } catch (err) {
    sendTo(ws, { type: "res", id, ok: false, error: { message: err.message } });
  }
}

async function handleClaudeCapture(ws, id, params) {
  const { name, lines } = params;
  if (!name) {
    return sendTo(ws, { type: "res", id, ok: false, error: { message: "name required" } });
  }

  try {
    const manager = getSessionManager();
    const { full, delta } = await manager.capture(name, lines || 100);
    sendTo(ws, { type: "res", id, ok: true, payload: { content: full, delta } });
  } catch (err) {
    sendTo(ws, { type: "res", id, ok: false, error: { message: err.message } });
  }
}

// ── Bun Server ──────────────────────────────────────────────────────────────

const hostname = BIND === "lan" ? "0.0.0.0" : "127.0.0.1";

const server = Bun.serve({
  port: PORT,
  hostname,

  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const origin = req.headers.get("origin") || "";
      if (server.upgrade(req, { data: { origin } })) {
        return;
      }
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // HTTP /health endpoint
    if (url.pathname === "/health" && req.method === "GET") {
      const bin = claudeBin();
      return Response.json({
        status: "ok",
        gateway: "familiar",
        version: "1.0.0",
        uptime: process.uptime(),
        claudeAvailable: !!bin,
        activeSessions: sessions.size,
        connectedClients: clients.size,
      });
    }

    // ── POST /internal/broadcast (loopback-only) ─────────────────────────
    // Allows co-located services (proxy, tool-loop) to push events to all WS clients
    if (url.pathname === "/internal/broadcast" && req.method === "POST") {
      const remote = req.headers.get("x-forwarded-for") || server.requestIP(req)?.address || "";
      const isLocal = remote.startsWith("127.") || remote === "::1" || remote === "localhost" || remote === "::ffff:127.0.0.1";
      const workerIp = process.env.WORKER_IP || "localhost";
      const isWorker = remote === workerIp || remote === `::ffff:${workerIp}`;
      if (!isLocal && !isWorker) {
        return Response.json({ error: "not allowed" }, { status: 403 });
      }
      return req.json().then((body) => {
        if (body.event) {
          broadcast(body.event, body.payload || {});
        }
        return Response.json({ ok: true });
      }).catch(() => Response.json({ error: "invalid body" }, { status: 400 }));
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(ws) {
      clients.set(ws, { authed: false, clientId: null, connectedAt: Date.now() });
      // Send connect challenge
      sendTo(ws, { type: "event", event: "connect.challenge", payload: {} });
    },

    message(ws, raw) {
      let msg;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      } catch {
        return;
      }

      if (msg.type === "req") {
        handleRequest(ws, msg);
      }
    },

    close(ws) {
      clients.delete(ws);
    },
  },
});

// ── Graceful Shutdown ───────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n[gateway] ${signal} received, shutting down...`);
  // Close all Claude terminal sessions
  try {
    const manager = getSessionManager();
    manager.shutdown().catch(() => {});
  } catch {}
  for (const [ws] of clients) {
    try { ws.close(1001, "Server shutting down"); } catch {}
  }
  clients.clear();
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Startup Banner ──────────────────────────────────────────────────────────

const bin = claudeBin();
console.log(`Familiar Gateway v2.1.0 (Claude-First Architecture)`);
console.log(`  listening:    ${hostname}:${PORT}`);
console.log(`  config:       ${configPath || "none"}`);
console.log(`  sessions TTL: ${SESSION_TTL_MS / 60000} min`);
console.log(`  persistence:  SQLite (survives restarts)`);
console.log(`  claude:       ${bin ? "available" : "NOT FOUND"}`);
console.log("");
console.log("Routing: ALL requests → Claude (via subscription)");
console.log("  SOUL.md personality + memory context injected");
console.log("  Multi-turn sessions with Claude session resume");
console.log("  Every response feeds Forge training pipeline");
console.log("");
console.log("Features: session persistence, auto-observe, quality logging, Forge collection");
console.log("");

// Pre-warm the daemon connection so tool schemas are ready for first request
warmDaemon().then(() => {
  console.log("  daemon:  familiar-daemon connected");
}).catch(() => {
  console.log("  daemon:  familiar-daemon not available (will lazy-connect on first tool call)");
});

// Pre-warm external MCP servers (Jira, Slack, etc.)
warmMcpServers().then(() => {
  console.log("  mcp:     external servers connected");
}).catch(() => {
  console.log("  mcp:     external servers unavailable (will lazy-connect on first tool call)");
});
