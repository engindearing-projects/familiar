#!/usr/bin/env bun
// Telegram Bridge — unified Telegram <-> Familiar gateway + terminal sessions.
// - Receives Telegram messages via long-polling
// - Routes normal chat to Familiar gateway
// - Starts/controls local terminal sessions (claude/codex/familiar/ollama)
// - Sends terminal output + input prompts back to Telegram

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { findConfig, logsDir, familiarHome } from "../apps/cli/lib/paths.js";
import { historyGet, historyAppend } from "../apps/cli/lib/chat-memory.js";
import { getFamiliarName } from "../shared/resolve.js";
import { classifyPrompt } from "../trainer/classify.mjs";
import { Database } from "bun:sqlite";
import { getWorkItem, updateWorkItem } from "../shared/work-queue.js";
import { answerCallbackQuery as answerCb, updateApprovalMessage } from "./daemon-telegram.mjs";
import { Router } from "./router.mjs";
import { runToolLoop } from "./tool-loop.mjs";
import { validateResponse } from "./response-validator.mjs";
import { resolveProject, listProjects } from "./project-resolver.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(__dirname, "..");

const CONFIG_PATH = findConfig() || (
  resolve(PROJECT_DIR, "config", "familiar.json")
);
const ACTIVITY_URL = process.env.ACTIVITY_URL || "http://localhost:18790";
const POLL_MS = parseInt(process.env.TG_BRIDGE_POLL_MS || "2000", 10);
const TG_LONG_POLL = parseInt(process.env.TG_BRIDGE_LONG_POLL || "30", 10);
const MAX_TG_TEXT = 3500; // keep under Telegram 4096 limit
const OLLAMA_URL = process.env.OLLAMA_URL || process.env.OLLAMA_HOST || "http://localhost:11434";
const ALLOW_ALL_CHATS = process.env.TG_BRIDGE_ALLOW_ALL === "1";

// Router instance for fallback path — resolves role-specific models
const bridgeRouter = new Router({
  ollamaUrl: OLLAMA_URL,
  localModel: "familiar-brain:latest",
});

const STATE_DIR = resolve(familiarHome(), "telegram");
const STATE_PATH = resolve(STATE_DIR, "bridge-state.json");
const HISTORY_DIR = resolve(STATE_DIR, "history");
const LOGS_DIR = resolve(logsDir(), "term-bridge");

const DEFAULT_COMMANDS = {
  claude: process.env.TERM_CLAUDE_CMD || "claude",
  codex: process.env.TERM_CODEX_CMD || "codex",
  familiar: process.env.TERM_FAMILIAR_CMD || `bun ${resolve(PROJECT_DIR, "apps/cli", "bin", "familiar.mjs")}`,
  ollama: process.env.TERM_OLLAMA_CMD || "ollama run familiar-brain:latest",
};

const PREPROCESS_ENABLED = process.env.TG_PREPROCESS !== "0";
const PREPROCESS_PASSES = Math.max(1, parseInt(process.env.TG_PREPROCESS_PASSES || "2", 10));
const PREPROCESS_MODELS = (process.env.TG_PREPROCESS_MODELS || "familiar-brain:latest,llama3.2")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const PREPROCESS_JUDGE_MODEL = process.env.TG_PREPROCESS_JUDGE || PREPROCESS_MODELS[0] || "familiar-brain:latest";
const PREPROCESS_AB = process.env.TG_PREPROCESS_AB === "1";
const PREPROCESS_AB_HARD_ONLY = process.env.TG_PREPROCESS_AB_HARD_ONLY !== "0";

const COMPARE_HARD_ONLY = process.env.TG_COMPARE_HARD_ONLY !== "0";
const COMPARE_ENABLE_CLAUDE = process.env.TG_COMPARE_CLAUDE !== "0";
const COMPARE_ENABLE_CODEX = process.env.TG_COMPARE_CODEX !== "0";
const COMPARE_ENABLE_OLLAMA = process.env.TG_COMPARE_OLLAMA !== "0";
const COMPARE_LOCAL_MODELS = (process.env.TG_COMPARE_LOCAL_MODELS || "familiar-brain:latest,llama3.2")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const COMPARE_JSONL = resolve(familiarHome(), "memory", "compare.jsonl");
const COMPARE_DB = resolve(familiarHome(), "memory", "compare.db");

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

ensureDir(STATE_DIR);
ensureDir(HISTORY_DIR);
ensureDir(LOGS_DIR);
ensureDir(resolve(familiarHome(), "memory"));

function loadJson(path, fallback = {}) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function stripAnsi(input) {
  return input
    .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function chunkText(text, maxLen = MAX_TG_TEXT) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}

// ── Config + Telegram ─────────────────────────────────────────────────────

let BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BRIDGE_TOKEN;
let GW_TOKEN = process.env.FAMILIAR_GATEWAY_TOKEN;
let GW_PORT = 18789;
let TG_ALLOWLIST = (process.env.TG_BRIDGE_ALLOWLIST || "").split(",").map((s) => s.trim()).filter(Boolean);
let TELEGRAM_PLUGIN_ENABLED = null;

try {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  BOT_TOKEN = BOT_TOKEN || cfg.channels?.telegram?.botToken;
  GW_PORT = cfg.gateway?.port ?? GW_PORT;
  GW_TOKEN = GW_TOKEN || cfg.gateway?.auth?.token;
  TELEGRAM_PLUGIN_ENABLED = cfg.plugins?.entries?.telegram?.enabled ?? cfg.channels?.telegram?.enabled ?? null;
} catch (e) {
  console.error("Failed to read gateway config:", e.message);
}

if (!BOT_TOKEN) {
  console.error("Missing Telegram bot token. Set TELEGRAM_BOT_TOKEN or TG_BRIDGE_TOKEN.");
  process.exit(1);
}

if (!GW_TOKEN) {
  console.warn("Warning: No gateway token found. Gateway features disabled; using direct Ollama for chat.");
}

const WS_URL = `ws://localhost:${GW_PORT}`;

async function tgCall(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || `Telegram API error: ${method}`);
  return data.result;
}

async function tgSend(chatId, text, opts = {}) {
  const clean = stripAnsi(text);
  for (const chunk of chunkText(clean)) {
    await tgCall("sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
      ...opts,
    });
  }
}

function logActivity(platform, role, content, sessionKey = "main") {
  fetch(`${ACTIVITY_URL}/activity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ platform, session_key: sessionKey, role, content }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

// ── Familiar Gateway (WebSocket) ──────────────────────────────────────────

let ws = null;
let connected = false;
let requestId = 0;
const pending = new Map();
const eventListeners = new Map();

function nextId() {
  return String(++requestId);
}

function buildConnectParams() {
  return {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: "familiar-telegram",
      version: "1.0.0",
      platform: "node",
      mode: "backend",
      instanceId: randomUUID(),
    },
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write", "operator.pairing", "chat"],
    auth: { token: GW_TOKEN },
  };
}

function connectGateway() {
  return new Promise((resolve, reject) => {
    if (ws && connected) {
      resolve();
      return;
    }

    console.log("[gateway] creating WebSocket to", WS_URL);
    ws = new WebSocket(WS_URL, {
      headers: { Origin: `http://localhost:${GW_PORT}` },
    });
    console.log("[gateway] WebSocket created, waiting for open...");

    let settled = false;
    let connectSent = false;
    let connectId = null;
    let queueTimer = null;

    function sendConnect() {
      if (connectSent) return;
      connectSent = true;
      if (queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
      connectId = nextId();
      console.log("[gateway] sending connect (id:", connectId + ")");
      ws.send(JSON.stringify({
        type: "req",
        id: connectId,
        method: "connect",
        params: buildConnectParams(),
      }));
    }

    ws.onopen = () => {
      console.log("[gateway] ws opened, queuing connect in 750ms");
      queueTimer = setTimeout(sendConnect, 750);
    };

    ws.onmessage = (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data.toString());
      } catch {
        return;
      }

      if (msg.type === "event" && msg.event === "connect.challenge") {
        console.log("[gateway] got connect.challenge, sending connect immediately");
        sendConnect();
        return;
      }

      // Handle connect response
      if (msg.type === "res" && msg.id === connectId && !settled) {
        if (msg.ok) {
          console.log("[gateway] connect OK");
          connected = true;
          settled = true;
          resolve();
        } else {
          console.error("[gateway] connect rejected:", msg.error?.message);
          settled = true;
          reject(new Error(msg.error?.message || "Connection rejected"));
        }
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
      console.log("[gateway] ws closed");
      connected = false;
      ws = null;
      if (queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
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
    };

    ws.onerror = (err) => {
      console.error("[gateway] ws error:", err?.message || err);
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("Connection timeout"));
        ws?.close();
      }
    }, 10000);
  });
}

async function ensureGateway() {
  if (!ws || !connected) await connectGateway();
}

function request(method, params = {}, timeoutMs = 30000) {
  return new Promise(async (resolve, reject) => {
    try {
      await ensureGateway();
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

    ws.send(JSON.stringify({ type: "req", id, method, params }));
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

// ── Terminal Session Manager (screen) ─────────────────────────────────────

function hasScreen() {
  const res = spawnSync("/usr/bin/which", ["screen"], { encoding: "utf8" });
  return res.status === 0;
}

function screenSessionExists(name) {
  const res = spawnSync("screen", ["-list"], { encoding: "utf8" });
  if (res.status !== 0) return false;
  return res.stdout.includes(`\t${name}`) || res.stdout.includes(`.${name}`) || res.stdout.includes(name);
}

function screenStart(name, command) {
  const res = spawnSync("screen", ["-dmS", name, "bash", "-lc", command], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`screen start failed: ${res.stderr || res.stdout}`);
  }
  spawnSync("screen", ["-S", name, "-X", "logfile", `${LOGS_DIR}/${name}.log`]);
  spawnSync("screen", ["-S", name, "-X", "log", "on"]);
}

function screenStop(name) {
  spawnSync("screen", ["-S", name, "-X", "quit"]);
}

function escapeForAnsiC(str) {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

function screenSend(name, text) {
  const payload = escapeForAnsiC(text) + "\\r";
  const cmd = `screen -S ${name} -X stuff $'${payload}'`;
  const res = spawnSync("/bin/bash", ["-lc", cmd], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`screen stuff failed: ${res.stderr || res.stdout}`);
  }
}

// ── State ────────────────────────────────────────────────────────────────

const state = loadJson(STATE_PATH, {
  offset: 0,
  sessions: {},
  chats: {},
  allowlist: TG_ALLOWLIST,
});

function saveState() {
  saveJson(STATE_PATH, state);
}

function ensureChatAllowed(chatId) {
  if (ALLOW_ALL_CHATS) return true;
  if (state.allowlist?.length) {
    return state.allowlist.includes(String(chatId));
  }
  // First chat to connect becomes allowed if no allowlist
  if (!state.allowlist) state.allowlist = [];
  if (!state.allowlist.includes(String(chatId))) state.allowlist.push(String(chatId));
  saveState();
  return true;
}

function getChatState(chatId) {
  if (!state.chats[chatId]) {
    state.chats[chatId] = {
      activeSession: null,
      pendingSession: null,
      pendingClarify: null,
      compareAlways: false,
    };
  }
  return state.chats[chatId];
}

function registerSession(chatId, agent, command) {
  const id = `tg-${chatId}-${agent}-${Date.now().toString(36)}`;
  const logPath = resolve(LOGS_DIR, `${id}.log`);
  state.sessions[id] = {
    id,
    chatId,
    agent,
    command,
    logPath,
    logOffset: 0,
    createdAt: new Date().toISOString(),
    pendingInput: false,
    lastOutputAt: null,
  };
  saveState();
  return state.sessions[id];
}

function detectInputNeeded(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/\b(select|choose|pick|enter choice|enter your choice|which option|type (1|2|3)|press (enter|return)|y\/n)\b/i.test(trimmed)) return true;
  if (/\n\s*1[\.)\]]\s.+\n\s*2[\.)\]]\s.+/i.test(trimmed)) return true;
  if (/^\s*1[\.)\]]\s.+/m.test(trimmed) && /^\s*2[\.)\]]\s.+/m.test(trimmed)) return true;
  return false;
}

async function pollSessionOutput(session) {
  if (!existsSync(session.logPath)) return;
  const stat = statSync(session.logPath);
  if (stat.size <= session.logOffset) return;

  const fd = openSync(session.logPath, "r");
  const buf = Buffer.alloc(stat.size - session.logOffset);
  readSync(fd, buf, 0, buf.length, session.logOffset);
  closeSync(fd);

  session.logOffset = stat.size;
  session.lastOutputAt = new Date().toISOString();
  saveState();

  const text = stripAnsi(buf.toString("utf8"));
  if (!text.trim()) return;

  const chatId = session.chatId;
  const prefix = `[${session.agent}:${session.id.slice(-6)}]`;

  const outputMsg = `${prefix}\n${text}`.trim();
  await tgSend(chatId, outputMsg);
  logActivity("telegram", "assistant", outputMsg, `term:${session.id}`);

  if (detectInputNeeded(text) && !session.pendingInput) {
    session.pendingInput = true;
    const chatState = getChatState(chatId);
    chatState.pendingSession = session.id;
    saveState();

    const prompt = `${prefix} needs input. Reply with a number or use /send ${session.id} <text>`;
    await tgSend(chatId, prompt);
    logActivity("telegram", "assistant", prompt, `term:${session.id}`);
  }
}

async function pollAllSessions() {
  const sessions = Object.values(state.sessions);
  for (const s of sessions) {
    if (!screenSessionExists(s.id)) continue;
    try {
      await pollSessionOutput(s);
    } catch (e) {
      console.error(`pollSessionOutput error (${s.id}):`, e.message);
    }
  }
}

// ── Prompt Preprocessing (Local Model) ────────────────────────────────────

async function ollamaChat(model, messages, { temperature = 0.2, maxTokens = 1024 } = {}) {
  const payload = JSON.stringify({
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  });

  // Use curl to avoid Bun fetch socket restrictions in this environment.
  const res = spawnSync(
    "/usr/bin/curl",
    [
      "-s",
      "-X",
      "POST",
      `${OLLAMA_URL}/v1/chat/completions`,
      "-H",
      "Content-Type: application/json",
      "-d",
      payload,
    ],
    { encoding: "utf8", timeout: 60000 }
  );

  if (res.status !== 0 || !res.stdout) {
    throw new Error(res.stderr || res.stdout || `Ollama curl failed (status ${res.status})`);
  }

  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch (e) {
    throw new Error(`Ollama JSON parse error: ${e.message}`);
  }
  const content = data.choices?.[0]?.message?.content || "";
  return String(content);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function isHardPrompt(text) {
  const hardPatterns = [
    /\b(refactor|architect|design|implement|build|create|migrate)\b/i,
    /\b(debug|diagnose|investigate|analyze|root cause)\b/i,
    /\b(multi[-\s]?file|across files|codebase|repo|repository)\b/i,
    /\b(write code|write a|code that|script that|pipeline|deploy)\b/i,
    /\b(pr|pull request|commit|merge)\b/i,
    /\b(performance|optimiz(e|ation)|scal(e|ability))\b/i,
  ];
  let score = 0;
  for (const p of hardPatterns) if (p.test(text)) score += 1;
  if (text.length > 400) score += 1;
  if (/```/.test(text)) score += 1;
  return score >= 2;
}

function isCodingPrompt(text) {
  const codePatterns = [
    /\b(code|bug|issue|error|stack trace|exception|traceback)\b/i,
    /\b(function|class|method|module|package|library|dependency)\b/i,
    /\b(refactor|implement|build|fix|debug|test|lint|format)\b/i,
    /\b(api|endpoint|database|sql|schema|migration)\b/i,
    /\b(typescript|javascript|python|go|rust|java|c\+\+|c#|node|react|docker|kubernetes)\b/i,
    /\b(file|folder|directory|repo|repository|git)\b/i,
    /\b(ci|pipeline|deploy|build)\b/i,
    /```/,
    /\b\w+\.(js|ts|tsx|py|go|rs|java|sql|json|yml|yaml|md)\b/i,
  ];
  return codePatterns.some((p) => p.test(text));
}

async function triagePrompt(text, model) {
  const sys = [
    "You are a prompt triage assistant.",
    "Return only JSON.",
    "Decide if the user prompt needs clarification before routing to an agent.",
    "If unclear, ask 1-3 specific questions.",
    "Otherwise, produce a refined prompt with helpful structure and missing assumptions filled as TODOs.",
    "JSON format:",
    "{",
    '  "needs_clarification": boolean,',
    '  "questions": string[],',
    '  "refined_prompt": string',
    "}",
  ].join("\n");

  const content = await ollamaChat(model, [
    { role: "system", content: sys },
    { role: "user", content: text },
  ], { temperature: 0.2, maxTokens: 800 });

  const parsed = safeJsonParse(content) || {};
  return {
    needsClarification: !!parsed.needs_clarification,
    questions: Array.isArray(parsed.questions) ? parsed.questions.slice(0, 3) : [],
    refinedPrompt: typeof parsed.refined_prompt === "string" ? parsed.refined_prompt.trim() : "",
  };
}

async function refinePrompt(text, model) {
  const sys = [
    "You are a prompt refiner for coding tasks.",
    "Rewrite the prompt to be clearer, more specific, and actionable.",
    "Preserve intent. Add missing context as TODO placeholders, not assumptions.",
    "Return only the refined prompt text.",
  ].join("\n");

  return (await ollamaChat(model, [
    { role: "system", content: sys },
    { role: "user", content: text },
  ], { temperature: 0.2, maxTokens: 900 })).trim();
}

async function judgePrompt(a, b) {
  const sys = [
    "You are a strict judge choosing the better refined prompt.",
    "Pick the one that is clearer, more complete, and best structured for an agent.",
    "Return only JSON: {\"winner\":\"A\"|\"B\",\"reason\":\"...\"}",
  ].join("\n");
  const content = await ollamaChat(PREPROCESS_JUDGE_MODEL, [
    { role: "system", content: sys },
    { role: "user", content: `Prompt A:\\n${a}\\n\\nPrompt B:\\n${b}` },
  ], { temperature: 0.1, maxTokens: 400 });
  const parsed = safeJsonParse(content) || {};
  return parsed.winner === "B" ? "B" : "A";
}

async function preprocessPrompt(chatId, text, { allowClarify = true } = {}) {
  if (!PREPROCESS_ENABLED || PREPROCESS_MODELS.length === 0) {
    return { action: "forward", prompt: text };
  }

  const triageModel = PREPROCESS_MODELS[0];
  const triage = await triagePrompt(text, triageModel);

  if (allowClarify && triage.needsClarification && triage.questions.length > 0) {
    const chatState = getChatState(chatId);
    chatState.pendingClarify = {
      original: text,
      questions: triage.questions,
      createdAt: new Date().toISOString(),
    };
    saveState();
    const msg = [
      "Quick clarifications so I can route this well:",
      ...triage.questions.map((q, i) => `${i + 1}. ${q}`),
      "Reply with the answers (bulleted or numbered).",
    ].join("\n");
    await tgSend(chatId, msg);
    return { action: "asked" };
  }

  let refined = triage.refinedPrompt || text;

  const shouldAB = PREPROCESS_AB || (PREPROCESS_AB_HARD_ONLY && isHardPrompt(text));
  if (shouldAB && PREPROCESS_MODELS.length >= 2) {
    const [modelA, modelB] = PREPROCESS_MODELS;
    const [a, b] = await Promise.all([
      refinePrompt(refined, modelA),
      refinePrompt(refined, modelB),
    ]);
    const winner = await judgePrompt(a, b);
    refined = winner === "B" ? b : a;
  }

  // Extra passes for deeper refinement on hard prompts
  for (let i = 1; i < PREPROCESS_PASSES; i++) {
    refined = await refinePrompt(refined, PREPROCESS_MODELS[0]);
  }

  return { action: "forward", prompt: refined };
}

// ── Claude Prompt Enhancement (Gemini-powered, fast) ───────────────────────
// Structures raw Telegram messages into well-formed prompts before they hit
// Claude sessions. Uses Gemini Flash (free, fast) to avoid adding latency.

async function enhanceForClaude(rawPrompt, chatId) {
  // Get recent conversation context to include in the enhancement
  const sessionKey = sessionKeyForChat(chatId);
  const history = historyGet(sessionKey, 10);
  const contextLines = history.slice(-6).map(m => {
    const who = m.role === "user" ? "Grant" : "Familiar";
    return `${who}: ${m.content}`;
  });
  const conversationContext = contextLines.length > 0
    ? `\nRecent conversation:\n${contextLines.join("\n")}\n`
    : "";

  const geminiKey = (() => {
    try {
      const envFile = resolve(PROJECT_DIR, "config/.env");
      if (existsSync(envFile)) {
        const raw = readFileSync(envFile, "utf8");
        return raw.match(/GEMINI_API_KEY=(.+)/)?.[1]?.trim() || null;
      }
    } catch {}
    return process.env.GEMINI_API_KEY || null;
  })();

  if (!geminiKey) {
    // No Gemini — return raw prompt with context prepended
    return contextLines.length > 0
      ? `Context from our Telegram conversation:\n${contextLines.join("\n")}\n\nRequest: ${rawPrompt}`
      : rawPrompt;
  }

  const sys = [
    "You are a prompt structuring assistant. Your job is to take a short, informal user message and restructure it into a well-formed prompt for Claude Code (an AI coding assistant).",
    "Rules:",
    "- Preserve the original intent exactly — do NOT add features or requirements the user didn't ask for",
    "- Add structure: clear goal, relevant context from the conversation, specific acceptance criteria",
    "- If the conversation history contains relevant details (file paths, error messages, prior decisions), include them",
    "- Keep it concise — Claude works best with focused, specific prompts",
    "- Output ONLY the enhanced prompt text, nothing else",
    "- Write in first person as the user (Grant)",
  ].join("\n");

  const userMsg = [
    conversationContext,
    `User's raw message: ${rawPrompt}`,
    "",
    "Restructure this into a clear, well-formed prompt for Claude Code.",
  ].join("\n");

  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
    const resp = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: sys }] },
        contents: [{ parts: [{ text: userMsg }] }],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) throw new Error(`Gemini ${resp.status}`);
    const data = await resp.json();
    const enhanced = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (enhanced && enhanced.length > 10) {
      console.log(`[enhance] ${rawPrompt.length} chars → ${enhanced.length} chars via Gemini`);
      return enhanced;
    }
  } catch (err) {
    console.log(`[enhance] Gemini enhancement failed (${err.message}), using raw prompt with context`);
  }

  // Fallback: raw prompt with conversation context
  return contextLines.length > 0
    ? `Context from our Telegram conversation:\n${contextLines.join("\n")}\n\nRequest: ${rawPrompt}`
    : rawPrompt;
}

// ── Comparison & Logging ───────────────────────────────────────────────────

const compareDb = new Database(COMPARE_DB);
compareDb.exec(`
  CREATE TABLE IF NOT EXISTS compare_runs (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    session_key TEXT NOT NULL,
    prompt TEXT NOT NULL,
    refined_prompt TEXT NOT NULL,
    is_coding INTEGER NOT NULL,
    is_hard INTEGER NOT NULL,
    compare_reason TEXT NOT NULL,
    outputs_json TEXT NOT NULL
  )
`);

function logCompareJsonl(payload) {
  try {
    writeFileSync(COMPARE_JSONL, JSON.stringify(payload) + "\n", { flag: "a" });
  } catch (e) {
    console.error("compare jsonl write error:", e.message);
  }
}

function logCompareSqlite(payload) {
  try {
    const stmt = compareDb.prepare(`
      INSERT INTO compare_runs
      (id, created_at, chat_id, session_key, prompt, refined_prompt, is_coding, is_hard, compare_reason, outputs_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      payload.id,
      payload.created_at,
      payload.chat_id,
      payload.session_key,
      payload.prompt,
      payload.refined_prompt,
      payload.is_coding ? 1 : 0,
      payload.is_hard ? 1 : 0,
      payload.compare_reason,
      JSON.stringify(payload.outputs || {})
    );
  } catch (e) {
    console.error("compare sqlite write error:", e.message);
  }
}

function logCompare(payload) {
  logCompareJsonl(payload);
  logCompareSqlite(payload);
}

function commandExists(cmd) {
  const res = spawnSync("/usr/bin/which", [cmd], { encoding: "utf8" });
  return res.status === 0;
}

function runClaudeCompare(prompt) {
  if (!commandExists("claude")) return { error: "claude not found" };
  const res = spawnSync(
    "claude",
    [
      "-p",
      "--no-session-persistence",
      "--output-format",
      "text",
      "--append-system-prompt",
      "Do not use tools. Answer with plain text only.",
      prompt,
    ],
    { encoding: "utf8", timeout: 180000, maxBuffer: 5_000_000 }
  );
  if (res.status !== 0) {
    return { error: res.stderr || res.stdout || "claude failed" };
  }
  return { text: res.stdout.trim() };
}

function runCodexCompare(prompt) {
  if (!commandExists("codex")) return { error: "codex not found" };
  const res = spawnSync(
    "codex",
    [
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--json",
      "-",
    ],
    { encoding: "utf8", input: prompt, timeout: 180000, maxBuffer: 5_000_000 }
  );
  if (res.status !== 0) {
    return { error: res.stderr || res.stdout || "codex failed" };
  }
  const parsed = safeJsonParse(res.stdout);
  if (parsed && parsed.final) {
    return { text: String(parsed.final).trim(), raw: parsed };
  }
  return { text: res.stdout.trim() };
}

async function runLocalCompare(prompt) {
  const outputs = {};
  for (const model of COMPARE_LOCAL_MODELS) {
    try {
      const text = await ollamaChat(model, [
        { role: "system", content: "Answer the request in plain text only." },
        { role: "user", content: prompt },
      ], { temperature: 0.2, maxTokens: 1800 });
      outputs[model] = { text: text.trim() };
    } catch (e) {
      outputs[model] = { error: e.message };
    }
  }
  return outputs;
}

async function runComparisons(prompt) {
  const outputs = {};

  if (COMPARE_ENABLE_OLLAMA && COMPARE_LOCAL_MODELS.length > 0) {
    outputs.local = await runLocalCompare(prompt);
  }

  if (COMPARE_ENABLE_CLAUDE) {
    outputs.claude = runClaudeCompare(prompt);
  }

  if (COMPARE_ENABLE_CODEX) {
    outputs.codex = runCodexCompare(prompt);
  }

  return outputs;
}

// ── Claude Terminal Session Commands ──────────────────────────────────────
// /claude start <project_dir> [initial prompt] — start a Claude Code session
// /claude send <message>                       — send to active claude session
// /claude stop [name]                          — close the active/named session
// /claude status                               — list active sessions

// Active claude sessions for this bridge (chatId → sessionName)
const claudeSessions = new Map();
// Batched output buffers: sessionName → { chatId, buffer, timer }
const claudeOutputBuffers = new Map();
const CLAUDE_OUTPUT_BATCH_MS = 15000; // batch output every 15 seconds

function parseClaudeCommand(text) {
  const match = text.match(/^\/claude\s+(\w+)\s*([\s\S]*)$/i);
  if (!match) return null;
  return { subcommand: match[1].toLowerCase(), args: match[2].trim() };
}

async function handleClaudeStart(chatId, args) {
  if (!args) {
    await tgSend(chatId, "Usage: /claude start <project_dir> [initial prompt]");
    return;
  }

  // Parse: first token is project dir, rest is optional initial prompt
  const parts = args.match(/^(\S+)\s*([\s\S]*)$/);
  if (!parts) {
    await tgSend(chatId, "Usage: /claude start <project_dir> [initial prompt]");
    return;
  }

  const projectDir = parts[1];
  const rawPrompt = parts[2] || null;
  const sessionName = `tg-claude-${chatId}-${Date.now().toString(36)}`;

  // Enhance prompt with conversation context before sending to Claude
  const initialPrompt = rawPrompt ? await enhanceForClaude(rawPrompt, chatId) : null;

  try {
    await ensureGateway();
    const result = await request("claude.start", {
      name: sessionName,
      projectDir,
      initialPrompt,
    }, 30000);

    claudeSessions.set(String(chatId), sessionName);

    await tgSend(chatId, `Claude session started: ${sessionName}\nProject: ${projectDir}${initialPrompt ? "\nSent initial prompt." : ""}\n\nReply with /claude send <message> or just type normally while session is active.`);

    // Start listening for output from this session via gateway events
    startClaudeOutputListener(chatId, sessionName);
  } catch (err) {
    await tgSend(chatId, `Failed to start Claude session: ${err.message}`);
  }
}

async function handleClaudeSendMsg(chatId, message) {
  const sessionName = claudeSessions.get(String(chatId));
  if (!sessionName) {
    await tgSend(chatId, "No active Claude session. Use /claude start <project_dir> first.");
    return;
  }

  if (!message) {
    await tgSend(chatId, "Usage: /claude send <message>");
    return;
  }

  try {
    await ensureGateway();
    await request("claude.send", { name: sessionName, message }, 15000);
  } catch (err) {
    await tgSend(chatId, `Failed to send to Claude: ${err.message}`);
  }
}

async function handleClaudeStop(chatId, name) {
  const sessionName = name || claudeSessions.get(String(chatId));
  if (!sessionName) {
    await tgSend(chatId, "No active Claude session to stop.");
    return;
  }

  try {
    await ensureGateway();
    await request("claude.close", { name: sessionName }, 15000);
  } catch (err) {
    // Session may already be gone
    console.log(`[claude-tg] close error: ${err.message}`);
  }

  // Clean up
  if (claudeSessions.get(String(chatId)) === sessionName) {
    claudeSessions.delete(String(chatId));
  }
  stopClaudeOutputListener(sessionName);

  await tgSend(chatId, `Claude session closed: ${sessionName}`);
}

async function handleClaudeStatus(chatId) {
  try {
    await ensureGateway();
    const result = await request("claude.list", {}, 10000);
    const sessions = result?.sessions || [];
    if (sessions.length === 0) {
      await tgSend(chatId, "No active Claude sessions.");
      return;
    }
    const lines = sessions.map((s) => {
      const age = Math.round(s.age / 1000);
      const ageStr = age < 60 ? `${age}s` : `${Math.round(age / 60)}m`;
      return `- ${s.name} (${s.projectDir}) ${s.status} ${ageStr} ago, ${s.messageCount} msgs`;
    });
    await tgSend(chatId, `Claude sessions:\n${lines.join("\n")}`);
  } catch (err) {
    await tgSend(chatId, `Failed to list sessions: ${err.message}`);
  }
}

// ── Hands Command Handlers ──────────────────────────────────────────────────

let _tgHandRegistry = null;

async function getTgHandRegistry() {
  if (_tgHandRegistry) return _tgHandRegistry;
  try {
    const { HandRegistry } = await import("../brain/hands/registry.mjs");
    _tgHandRegistry = new HandRegistry();
    _tgHandRegistry.load();
    return _tgHandRegistry;
  } catch (err) {
    return null;
  }
}

async function handleHandsList(chatId) {
  try {
    const reg = await getTgHandRegistry();
    if (!reg) { await tgSend(chatId, "Hands system unavailable."); return; }
    reg.load(); // refresh state
    const hands = reg.list();
    if (hands.length === 0) {
      await tgSend(chatId, "No hands installed.");
      return;
    }
    const icons = { active: "ON", inactive: "OFF", paused: "PAUSED", running: "RUN", error: "ERR" };
    const lines = hands.map(h => {
      const icon = icons[h.status] || h.status;
      const lastStr = h.lastRun ? new Date(h.lastRun).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never";
      return `[${icon}] ${h.name}\n  ${h.description}\n  Schedule: ${h.schedule} | Runs: ${h.runCount} | Last: ${lastStr}`;
    });
    await tgSend(chatId, `Hands:\n\n${lines.join("\n\n")}`);
  } catch (err) {
    await tgSend(chatId, `Error: ${err.message}`);
  }
}

async function handleHandCommand(chatId, action, name) {
  try {
    const reg = await getTgHandRegistry();
    if (!reg) { await tgSend(chatId, "Hands system unavailable."); return; }
    reg.load(); // refresh state

    if (action === "status") {
      const metrics = reg.getMetrics(name);
      if (!metrics) { await tgSend(chatId, `Hand "${name}" not found.`); return; }
      const lines = [
        `Hand: ${metrics.name}`,
        `Status: ${metrics.status}`,
        `Runs: ${metrics.runCount}`,
        `Last: ${metrics.lastRun || "never"}`,
        `Duration: ${metrics.lastDuration ? `${(metrics.lastDuration / 1000).toFixed(1)}s` : "n/a"}`,
      ];
      if (metrics.lastError) lines.push(`Error: ${metrics.lastError}`);
      if (Object.keys(metrics.metrics).length > 0) {
        lines.push("\nMetrics:");
        for (const [key, value] of Object.entries(metrics.metrics)) {
          lines.push(`  ${key}: ${value}`);
        }
      }
      await tgSend(chatId, lines.join("\n"));
      return;
    }

    if (action === "run") {
      const hand = reg.get(name);
      if (!hand) { await tgSend(chatId, `Hand "${name}" not found.`); return; }
      if (hand.status === "inactive") reg.activate(name);
      await tgSend(chatId, `Running "${name}"...`);

      // Run async — results come via Telegram notification from the runner
      const { runHand } = await import("../brain/hands/runner.mjs");
      runHand(reg, name, { notify: true }).catch(err => {
        tgSend(chatId, `Hand "${name}" error: ${err.message}`).catch(() => {});
      });
      return;
    }

    // Lifecycle commands: activate, pause, resume, deactivate
    if (typeof reg[action] !== "function") {
      await tgSend(chatId, `Unknown action: ${action}`);
      return;
    }
    const result = reg[action](name);
    if (result.ok) {
      await tgSend(chatId, `${action}d "${name}".`);
    } else {
      await tgSend(chatId, `Failed: ${result.error}`);
    }
  } catch (err) {
    await tgSend(chatId, `Error: ${err.message}`);
  }
}

function startClaudeOutputListener(chatId, sessionName) {
  // Poll the session's output periodically and batch-send to Telegram
  const buffer = { chatId: String(chatId), buffer: "", timer: null, updateCount: 0 };
  claudeOutputBuffers.set(sessionName, buffer);

  const flushBuffer = async () => {
    const buf = claudeOutputBuffers.get(sessionName);
    if (!buf || !buf.buffer) return;
    let text = buf.buffer.trim();
    buf.buffer = "";
    if (!text) return;

    // Clean terminal noise: ANSI codes, spinner chars, progress bars
    text = stripAnsi(text)
      .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●○◐◑◒◓▓░▒█]/g, "")
      .replace(/\r/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // Skip empty or very short noise updates
    if (text.length < 5) return;

    // Truncate long outputs to avoid Telegram message limits
    if (text.length > 3500) {
      text = text.slice(-3500);
      text = "..." + text.slice(text.indexOf("\n") + 1);
    }

    buf.updateCount++;
    await tgSend(buf.chatId, `[claude] ${text}`).catch((e) =>
      console.error(`[claude-tg] send error: ${e.message}`)
    );
  };

  // Use gateway event listening to get output
  // Poll via claude.capture every CLAUDE_OUTPUT_BATCH_MS
  const pollOutput = async () => {
    if (!claudeOutputBuffers.has(sessionName)) return;

    try {
      await ensureGateway();
      const result = await request("claude.capture", { name: sessionName, lines: 100 }, 10000);
      if (result?.delta) {
        const buf = claudeOutputBuffers.get(sessionName);
        if (buf) {
          buf.buffer += result.delta;
        }
      }
    } catch {
      // Session may be gone
      if (!claudeSessions.has(String(chatId))) {
        stopClaudeOutputListener(sessionName);
        return;
      }
    }

    // Flush and schedule next poll
    await flushBuffer();
    const buf = claudeOutputBuffers.get(sessionName);
    if (buf) {
      buf.timer = setTimeout(pollOutput, CLAUDE_OUTPUT_BATCH_MS);
    }
  };

  buffer.timer = setTimeout(pollOutput, CLAUDE_OUTPUT_BATCH_MS);
}

function stopClaudeOutputListener(sessionName) {
  const buf = claudeOutputBuffers.get(sessionName);
  if (buf) {
    if (buf.timer) clearTimeout(buf.timer);
    claudeOutputBuffers.delete(sessionName);
  }
}

// ── Telegram Command Handling ─────────────────────────────────────────────

function parseStartCommand(text) {
  const lower = text.toLowerCase().trim();
  const direct = lower.match(/^\/term\s+(claude|codex|familiar|ollama)\b/);
  if (direct) return direct[1];

  const phrased = lower.match(/\b(start|open|launch)\b[\s\w]*(claude|codex|familiar|ollama)\b/);
  if (phrased) return phrased[2];

  return null;
}

function parseSendCommand(text) {
  const match = text.match(/^\/send\s+(\S+)\s+([\s\S]+)$/i);
  if (!match) return null;
  return { sessionId: match[1], payload: match[2] };
}

function parseActiveCommand(text) {
  const match = text.match(/^\/active\s+(\S+)/i);
  if (!match) return null;
  return match[1];
}

function parseStopCommand(text) {
  const match = text.match(/^\/stop\s+(\S+)/i);
  if (!match) return null;
  return match[1];
}

async function handleTermStart(chatId, agent) {
  if (!hasScreen()) {
    await tgSend(chatId, "Screen is not installed. Install it or set up tmux and update this script.");
    return;
  }

  const command = DEFAULT_COMMANDS[agent];
  if (!command) {
    await tgSend(chatId, `Unknown session type: ${agent}`);
    return;
  }

  const session = registerSession(chatId, agent, command);
  try {
    screenStart(session.id, command);
  } catch (e) {
    await tgSend(chatId, `Failed to start ${agent} session: ${e.message}`);
    return;
  }

  const chatState = getChatState(chatId);
  chatState.activeSession = session.id;
  saveState();

  await tgSend(chatId, `Started ${agent} terminal session: ${session.id}`);
}

async function handleSendToSession(chatId, sessionId, payload) {
  const session = state.sessions[sessionId];
  if (!session || session.chatId !== chatId) {
    await tgSend(chatId, `Session not found: ${sessionId}`);
    return;
  }

  try {
    screenSend(sessionId, payload);
  } catch (e) {
    await tgSend(chatId, `Failed to send input: ${e.message}`);
    return;
  }

  session.pendingInput = false;
  const chatState = getChatState(chatId);
  if (chatState.pendingSession === sessionId) chatState.pendingSession = null;
  chatState.activeSession = sessionId;
  saveState();
}

async function handleActiveSession(chatId, sessionId) {
  const session = state.sessions[sessionId];
  if (!session || session.chatId !== chatId) {
    await tgSend(chatId, `Session not found: ${sessionId}`);
    return;
  }
  const chatState = getChatState(chatId);
  chatState.activeSession = sessionId;
  saveState();
  await tgSend(chatId, `Active session set to ${sessionId}`);
}

async function handleStopSession(chatId, sessionId) {
  const session = state.sessions[sessionId];
  if (!session || session.chatId !== chatId) {
    await tgSend(chatId, `Session not found: ${sessionId}`);
    return;
  }
  screenStop(sessionId);
  delete state.sessions[sessionId];
  const chatState = getChatState(chatId);
  if (chatState.activeSession === sessionId) chatState.activeSession = null;
  if (chatState.pendingSession === sessionId) chatState.pendingSession = null;
  saveState();
  await tgSend(chatId, `Stopped session ${sessionId}`);
}

async function handleListSessions(chatId) {
  const sessions = Object.values(state.sessions).filter((s) => s.chatId === chatId);
  if (sessions.length === 0) {
    await tgSend(chatId, "No active terminal sessions.");
    return;
  }
  const lines = sessions.map((s) => `- ${s.id} (${s.agent})${s.pendingInput ? " [needs input]" : ""}`);
  await tgSend(chatId, `Active sessions:\n${lines.join("\n")}`);
}

// ── Familiar Chat Relay ──────────────────────────────────────────────────

function sessionKeyForChat(chatId) {
  return `familiar:telegram:${chatId}`;
}

const MAX_CHAT_HISTORY = 20;

// Role-specific system prompts — one brain, different hats
const _fn = getFamiliarName();
const ROLE_SYSTEMS = {
  coding: `You are ${_fn}, a familiar from familiar.run — an AI coding assistant. Write clean, well-structured code with clear explanations. Keep replies concise.`,
  reasoning: `You are ${_fn}, a familiar from familiar.run. Think step by step. When debugging, trace from symptom to root cause. When planning, identify dependencies and risks. Keep replies concise.`,
  tools: `You are ${_fn}, a familiar from familiar.run. You're great at navigating codebases and running shell commands. Explain what you'd do and why. Keep replies concise.`,
  chat: `You are ${_fn}, a familiar from familiar.run. You run locally and can access the filesystem, run shell commands, read/write files, search code, and query APIs. Be concise — respond in 1-3 sentences unless asked for more. Match the energy of the message: short greetings get short replies. If unsure about something, say so honestly rather than guessing. Never fabricate file contents, system info, or data you don't have.`,
};

/**
 * Send a message through the gateway WebSocket for full agent capabilities
 * (tool loop, MCP bridge, smart routing, Forge training collection).
 * Falls back to direct ollamaChat if gateway is unavailable.
 */
async function sendViaGateway(sessionKey, message, onProgress) {
  // 30 min timeout for long-running tasks (task-runner handles continuations)
  const GATEWAY_TIMEOUT_MS = 30 * 60 * 1000;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${GW_PORT}`);
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("Gateway timeout (30min)"));
    }, GATEWAY_TIMEOUT_MS);

    let resolved = false;
    let reqId = 0;

    ws.addEventListener("open", () => {});

    ws.addEventListener("message", (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      // Step 1: respond to connect challenge
      if (msg.type === "event" && msg.event === "connect.challenge") {
        reqId++;
        ws.send(JSON.stringify({
          type: "req",
          id: reqId,
          method: "connect",
          params: {
            client: { id: "familiar-telegram" },
            auth: GW_TOKEN ? { token: GW_TOKEN } : undefined,
          },
        }));
        return;
      }

      // Step 2: after connect succeeds, send chat message
      if (msg.type === "res" && msg.id === 1 && msg.ok) {
        reqId++;
        ws.send(JSON.stringify({
          type: "req",
          id: reqId,
          method: "chat.send",
          params: { sessionKey, message },
        }));
        return;
      }

      // Step 3: handle chat events (progress + final)
      if (msg.type === "event" && msg.event === "chat" && msg.payload?.sessionKey === sessionKey) {
        if (msg.payload.state === "progress") {
          // Intermediate progress update — forward to Telegram
          onProgress?.(msg.payload.message?.content || "");
        } else if (msg.payload.state === "final") {
          resolved = true;
          clearTimeout(timeout);
          try { ws.close(); } catch {}
          resolve(msg.payload.message?.content || "");
        } else if (msg.payload.state === "error") {
          resolved = true;
          clearTimeout(timeout);
          try { ws.close(); } catch {}
          reject(new Error(msg.payload.error || msg.payload.errorMessage || "Gateway error"));
        }
      }
    });

    ws.addEventListener("error", (err) => {
      if (!resolved) {
        clearTimeout(timeout);
        reject(new Error(`Gateway WebSocket error: ${err.message || "connection refused"}`));
      }
    });

    ws.addEventListener("close", () => {
      if (!resolved) {
        clearTimeout(timeout);
        reject(new Error("Gateway connection closed before response"));
      }
    });
  });
}

async function sendToFamiliar(chatId, message) {
  const sessionKey = sessionKeyForChat(chatId);
  const { type: role } = classifyPrompt(message);

  // Try gateway first — gives full agent capabilities (tool loop, routing, Forge training)
  // Progress messages are forwarded to Telegram as intermediate updates
  try {
    console.log(`[sendToFamiliar] role=${role} trying gateway at :${GW_PORT}...`);
    const text = await sendViaGateway(sessionKey, message, (progressMsg) => {
      // Send intermediate progress updates to Telegram
      tgSend(chatId, progressMsg).catch(() => {});
    });
    historyAppend(sessionKey, "user", message, MAX_CHAT_HISTORY);
    historyAppend(sessionKey, "assistant", text, MAX_CHAT_HISTORY);
    console.log(`[sendToFamiliar] gateway response length: ${text.length}`);
    return { text, role, fallback: false };
  } catch (gwErr) {
    console.warn(`[sendToFamiliar] gateway failed: ${gwErr.message}, falling back to direct ollama`);
  }

  // Fallback: direct Ollama with router-resolved models + tool loop for coding/tools
  try {
    // Resolve the correct model for this role via the router
    const resolvedModel = await bridgeRouter.resolveModel(role);
    const roleInfo = bridgeRouter.classifyRole(message);
    const systemPrompt = roleInfo.systemPrompt || ROLE_SYSTEMS[role] || ROLE_SYSTEMS.chat;
    const temperature = roleInfo.temperature ?? 0.7;

    console.log(`[sendToFamiliar] role=${role} model=${resolvedModel} calling ollama fallback...`);

    let text;
    let finishReason = "complete";
    let toolCalls = [];

    if (role === "coding" || role === "tools") {
      // Use the tool loop for coding/tools roles — prevents hallucination
      const loopResult = await runToolLoop({
        prompt: message,
        systemPrompt,
        model: resolvedModel,
        temperature,
        maxIterations: 8,
        maxToolCalls: 20,
        timeoutMs: 90_000,
      });
      text = loopResult.response || "(no response)";
      finishReason = loopResult.finishReason;
      toolCalls = loopResult.toolCalls || [];
      console.log(`[sendToFamiliar] tool loop done: ${loopResult.iterations} iters, ${toolCalls.length} tools`);
    } else {
      // Direct call for reasoning and chat (no tool loop needed)
      const history = historyGet(sessionKey, MAX_CHAT_HISTORY);
      const messages = [
        { role: "system", content: systemPrompt },
        ...history.map(({ role, content }) => ({ role, content })),
        { role: "user", content: message },
      ];
      text = await ollamaChat(resolvedModel, messages, { temperature, maxTokens: 2048 });
    }

    // Validate response quality before sending
    const validation = validateResponse({ text, prompt: message, role, finishReason, toolCalls });

    if (!validation.pass) {
      console.warn(`[sendToFamiliar] response failed validation: ${validation.flags.join(", ")} (confidence: ${validation.confidence.toFixed(2)})`);
      text = "I couldn't generate a reliable response for this. Try again or say 'use claude' for the heavy brain.";
    } else if (validation.confidence < 0.7) {
      console.warn(`[sendToFamiliar] low confidence response: ${validation.flags.join(", ")} (${validation.confidence.toFixed(2)})`);
      text = `[Low confidence] ${text}`;
    }

    historyAppend(sessionKey, "user", message, MAX_CHAT_HISTORY);
    historyAppend(sessionKey, "assistant", text, MAX_CHAT_HISTORY);
    console.log("[sendToFamiliar] fallback response length:", text.length);
    return { text, role, fallback: true };
  } catch (e) {
    console.error("[sendToFamiliar] fallback error:", e.message);
    return { text: `Sorry, I ran into an error: ${e.message}`, fallback: true };
  }
}

// ── Main Loop ─────────────────────────────────────────────────────────────

async function handleTelegramMessage(msg) {
  const chatId = msg.chat?.id;
  const text = msg.text?.trim();
  if (!chatId || !text) return;

  if (!ensureChatAllowed(chatId)) return;

  if (/^\/help$/i.test(text)) {
    const help = [
      "Telegram Bridge Help",
      "",
      "Claude Code sessions (auto-detected from coding messages):",
      "/claude start <dir> [prompt] — manual start",
      "/claude stop — close active session",
      "/claude status — list active sessions",
      "/chat — switch back to Familiar (session keeps running)",
      "",
      "Terminal sessions:",
      "/term claude | /term codex | /term familiar | /term ollama",
      "",
      "Compare mode:",
      "/compare on | /compare off | /compare <prompt>",
      "",
      "Send input:",
      "/send <sessionId> <text>",
      "Or prefix with '>' to send to the active session",
      "",
      "Manage sessions:",
      "/sessions",
      "/active <sessionId>",
      "/stop <sessionId>",
      "",
      "Hands (autonomous tasks):",
      "/hands — list all hands + status",
      "/hand run <name> — trigger a hand now",
      "/hand activate <name> — enable scheduling",
      "/hand pause <name> — pause without losing state",
      "/hand status <name> — detailed metrics",
      "",
      "Notes:",
      "- If a session asks for 1/2/3, just reply with the number.",
      "- When a Claude session is active, messages are forwarded to it.",
    ].join("\n");
    await tgSend(chatId, help);
    return;
  }

  // Claude session commands
  const claudeCmd = parseClaudeCommand(text);
  if (claudeCmd) {
    switch (claudeCmd.subcommand) {
      case "start":
        await handleClaudeStart(chatId, claudeCmd.args);
        return;
      case "send":
        await handleClaudeSendMsg(chatId, claudeCmd.args);
        return;
      case "stop":
        await handleClaudeStop(chatId, claudeCmd.args || null);
        return;
      case "status":
        await handleClaudeStatus(chatId);
        return;
      default:
        await tgSend(chatId, `Unknown /claude subcommand: ${claudeCmd.subcommand}\nUse: start, send, stop, status`);
        return;
    }
  }

  // /chat — detach from active Claude session, route to Familiar
  if (/^\/chat$/i.test(text)) {
    const detached = claudeSessions.get(String(chatId));
    if (detached) {
      claudeSessions.delete(String(chatId));
      await tgSend(chatId, `Detached from Claude session (still running: ${detached}).\nMessages now go to Familiar. Use /claude status to check on it.`);
    } else {
      await tgSend(chatId, "Already in chat mode (no active Claude session).");
    }
    return;
  }

  // Terminal commands
  const startAgent = parseStartCommand(text);
  if (startAgent) {
    await handleTermStart(chatId, startAgent);
    return;
  }

  const sendCmd = parseSendCommand(text);
  if (sendCmd) {
    await handleSendToSession(chatId, sendCmd.sessionId, sendCmd.payload);
    return;
  }

  const activeCmd = parseActiveCommand(text);
  if (activeCmd) {
    await handleActiveSession(chatId, activeCmd);
    return;
  }

  const stopCmd = parseStopCommand(text);
  if (stopCmd) {
    await handleStopSession(chatId, stopCmd);
    return;
  }

  if (/^\/(sessions|ls|list)$/.test(text.toLowerCase())) {
    await handleListSessions(chatId);
    return;
  }

  // ── Hands commands ──
  if (/^\/hands$/i.test(text)) {
    await handleHandsList(chatId);
    return;
  }

  const handCmd = text.match(/^\/hand\s+(run|activate|pause|resume|deactivate|status)\s+(\S+)/i);
  if (handCmd) {
    await handleHandCommand(chatId, handCmd[1].toLowerCase(), handCmd[2]);
    return;
  }

  // Compare toggles / one-off
  const compareToggle = text.match(/^\/compare\s+(on|off)\s*$/i);
  if (compareToggle) {
    const chatState = getChatState(chatId);
    chatState.compareAlways = compareToggle[1].toLowerCase() === "on";
    saveState();
    await tgSend(chatId, `Compare is now ${chatState.compareAlways ? "ON" : "OFF"}.`);
    return;
  }

  const compareOnce = text.match(/^\/compare\s+([\s\S]+)$/i);
  if (compareOnce) {
    const forcedText = compareOnce[1].trim();
    const pre = await preprocessPrompt(chatId, forcedText);
    if (pre.action === "asked") return;
    logActivity("telegram-bridge", "user", forcedText, sessionKeyForChat(chatId));
    const comparePromise = runComparisons(pre.prompt);
    const reply = await sendToFamiliar(chatId, pre.prompt);
    await tgSend(chatId, reply.text);
    logActivity("telegram-bridge", "assistant", reply.text, sessionKeyForChat(chatId));

    comparePromise.then((outputs) => {
      const payload = {
        id: randomUUID(),
        created_at: new Date().toISOString(),
        chat_id: String(chatId),
        session_key: sessionKeyForChat(chatId),
        prompt: forcedText,
        refined_prompt: pre.prompt,
        is_coding: isCodingPrompt(pre.prompt),
        is_hard: isHardPrompt(pre.prompt),
        compare_reason: "manual",
        outputs: { ...outputs, familiar_gateway: { text: reply.text, fallback: reply.fallback } },
      };
      logCompare(payload);
    }).catch((e) => console.error("compare error:", e.message));
    return;
  }

  // Clarification flow
  const chatState = getChatState(chatId);
  if (chatState.pendingClarify) {
    const { original, questions } = chatState.pendingClarify;
    chatState.pendingClarify = null;
    saveState();
    const combined = [
      "Original request:",
      original,
      "",
      "Clarifications:",
      text,
    ].join("\n");
    const pre = await preprocessPrompt(chatId, combined, { allowClarify: false });
    if (pre.action === "asked") return;
    logActivity("telegram-bridge", "user", combined, sessionKeyForChat(chatId));
    const reply = await sendToFamiliar(chatId, pre.prompt);
    await tgSend(chatId, reply.text);
    logActivity("telegram-bridge", "assistant", reply.text, sessionKeyForChat(chatId));
    return;
  }

  // If pending input, forward short replies to pending session
  if (chatState.pendingSession && /^\d+$/.test(text)) {
    await handleSendToSession(chatId, chatState.pendingSession, text);
    return;
  }

  // If active session and user starts with ">", route to terminal
  if (chatState.activeSession && text.startsWith(">")) {
    await handleSendToSession(chatId, chatState.activeSession, text.slice(1).trim());
    return;
  }

  // If there's an active Claude terminal session, forward ALL messages to it.
  // The user is in a conversation with Claude — "yes", "looks good", "try again"
  // are all valid replies. Use /chat to detach.
  const activeClaudeSession = claudeSessions.get(String(chatId));
  if (activeClaudeSession) {
    try {
      await ensureGateway();
      await request("claude.send", { name: activeClaudeSession, message: text }, 15000);
      logActivity("telegram-bridge", "user", `[→claude] ${text}`, sessionKeyForChat(chatId));
      return;
    } catch (err) {
      // Session may have ended — clean up and fall through
      console.log(`[claude-tg] forward failed, session may be gone: ${err.message}`);
      claudeSessions.delete(String(chatId));
      stopClaudeOutputListener(activeClaudeSession);
      await tgSend(chatId, "Claude session ended. Switching back to Familiar.");
    }
  }

  // Auto-detect coding tasks and spawn a Claude session
  if (isCodingPrompt(text) && isHardPrompt(text)) {
    const match = resolveProject(text);
    if (match && match.confidence >= 0.5) {
      // Auto-start a Claude session for the resolved project
      const sessionName = `tg-claude-${chatId}-${Date.now().toString(36)}`;
      try {
        // Enhance prompt with conversation context before sending to Claude
        const enhancedPrompt = await enhanceForClaude(text, chatId);
        await ensureGateway();
        await request("claude.start", {
          name: sessionName,
          projectDir: match.dir,
          initialPrompt: enhancedPrompt,
        }, 30000);

        claudeSessions.set(String(chatId), sessionName);
        startClaudeOutputListener(chatId, sessionName);
        await tgSend(chatId, `Starting Claude in ${match.name} (${match.dir})...\nUse /chat to switch back to Familiar.`);
        logActivity("telegram-bridge", "user", `[auto→claude:${match.name}] ${text}`, sessionKeyForChat(chatId));
        return;
      } catch (err) {
        console.log(`[claude-tg] auto-start failed: ${err.message}`);
        // Fall through to normal chat
      }
    } else if (!match) {
      // Clearly a coding task but can't figure out which project
      const projects = listProjects();
      const projectList = projects.map((p) => `- ${p.name} (${p.dir})`).join("\n");
      await tgSend(chatId, `That looks like a coding task but I'm not sure which project.\nUse /claude start <dir> or mention the project name.\n\nKnown projects:\n${projectList}`);
      return;
    }
  }

  // Otherwise forward to Familiar directly (no preprocessing)
  logActivity("telegram-bridge", "user", text, sessionKeyForChat(chatId));
  const reply = await sendToFamiliar(chatId, text);
  if (reply.text) await tgSend(chatId, reply.text);
  logActivity("telegram-bridge", "assistant", reply.text, sessionKeyForChat(chatId));

}

// ── Daemon callback query handler ─────────────────────────────────────────

async function handleCallbackQuery(query) {
  const data = query.data || "";
  const parts = data.split(":");

  // Handle daemon and planner callbacks (format: daemon:action:itemId or planner:action:itemId)
  if ((parts[0] !== "daemon" && parts[0] !== "planner") || parts.length < 3) return;

  const action = parts[1];
  const itemId = parts.slice(2).join(":"); // UUID may not contain ":", but be safe
  const userName = query.from?.first_name || query.from?.username || "user";

  // Answer immediately (Telegram requires within 10s)
  try {
    await answerCb(query.id, `${action === "approve" ? "Approved" : action === "skip" ? "Skipped" : "Deferred 1h"}`);
  } catch (e) {
    console.error("answerCallbackQuery failed:", e.message);
  }

  const item = getWorkItem(itemId);
  if (!item) {
    console.error(`Callback for unknown work item: ${itemId}`);
    return;
  }

  const chatId = String(query.message?.chat?.id || item.approval_chat_id);
  const msgId = query.message?.message_id || item.approval_msg_id;
  const shortId = itemId.slice(0, 8);

  if (action === "approve") {
    updateWorkItem(itemId, { status: "approved", approved_by: userName });
    if (chatId && msgId) {
      await updateApprovalMessage(chatId, msgId,
        `✅ *Approved* by ${userName} [${shortId}]\n\n${item.proposed_action || "—"}`
      );
    }
    console.log(`Work item ${shortId} approved by ${userName}`);
  } else if (action === "skip") {
    updateWorkItem(itemId, { status: "rejected" });
    if (chatId && msgId) {
      await updateApprovalMessage(chatId, msgId,
        `⏭ *Skipped* by ${userName} [${shortId}]`
      );
    }
    console.log(`Work item ${shortId} skipped by ${userName}`);
  } else if (action === "defer") {
    const deferUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    updateWorkItem(itemId, { status: "deferred", defer_until: deferUntil });
    if (chatId && msgId) {
      await updateApprovalMessage(chatId, msgId,
        `⏰ *Deferred 1h* by ${userName} [${shortId}]\nWill re-propose after ${new Date(deferUntil).toLocaleTimeString()}`
      );
    }
    console.log(`Work item ${shortId} deferred 1h by ${userName}`);
  }
}

async function pollTelegram() {
  const url = new URL(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`);
  url.searchParams.set("offset", String(state.offset || 0));
  url.searchParams.set("timeout", String(TG_LONG_POLL));
  url.searchParams.set("allowed_updates", JSON.stringify(["message", "callback_query"]));

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout((TG_LONG_POLL + 5) * 1000) });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "Telegram getUpdates failed");

  for (const update of data.result || []) {
    state.offset = update.update_id + 1;
    saveState();
    if (update.message) {
      try {
        await handleTelegramMessage(update.message);
      } catch (e) {
        console.error("handleTelegramMessage error:", e?.stack || e?.message || String(e));
      }
    }
    if (update.callback_query) {
      try {
        await handleCallbackQuery(update.callback_query);
      } catch (e) {
        console.error("handleCallbackQuery error:", e?.stack || e?.message || String(e));
      }
    }
  }
}

async function main() {
  console.log("Telegram bridge starting...");
  console.log(`Config: ${CONFIG_PATH}`);
  console.log(`Gateway: ${WS_URL}`);
  if (TELEGRAM_PLUGIN_ENABLED) {
    console.log("Warning: Gateway Telegram plugin appears enabled. This bridge should be the only Telegram consumer.");
  }

  // Ensure Telegram long-polling works by clearing any webhook
  try {
    await tgCall("setWebhook", { url: "" });
    console.log("Telegram webhook cleared (using long-polling).");
  } catch (e) {
    console.error("Failed to clear Telegram webhook:", e.message);
  }

  // Poll loops
  setInterval(() => {
    pollAllSessions().catch((e) => console.error("pollAllSessions error:", e.message));
  }, POLL_MS);

  while (true) {
    try {
      await pollTelegram();
    } catch (e) {
      console.error("pollTelegram error:", e.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

main().catch((e) => {
  console.error("Fatal:", e.stack || e.message);
  process.exit(1);
});
