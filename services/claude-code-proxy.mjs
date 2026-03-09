#!/usr/bin/env bun

// Claude Code Proxy Server
// Wraps the `claude` CLI in headless mode (-p) behind an HTTP API
// so Familiar can invoke it for heavy-brain tasks.
//
// Runs on the HOST (not in Docker) because `claude` authenticates
// via the local subscription/keychain.
//
// Usage:
//   node scripts/claude-code-proxy.mjs
//   CLAUDE_PROXY_PORT=18791 node scripts/claude-code-proxy.mjs

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  Semaphore,
  cleanEnv,
  stripSessionEnv,
  claudeBin,
  checkOnline,
  invokeClaude as _invokeClaude,
  PROJECT_DIR,
} from "./shared-invoke.mjs";
import { Router, HEAVY_PATTERNS } from "./router.mjs";
import { runToolLoop } from "./tool-loop.mjs";
import { warmDaemon } from "./tools.mjs";
import { getFamiliarName } from "../shared/resolve.js";
import { emitProxyEvent, getRecentEvents, getAllSessionStats } from "./proxy-events.mjs";

// ── Forge Collectors (lazy-loaded) ───────────────────────────────────────────
let _collector = null;
async function getCollector() {
  if (_collector) return _collector;
  try {
    const { Collector } = await import("../trainer/collector.mjs");
    _collector = new Collector();
    console.log("[Forge] Collector initialized");
    return _collector;
  } catch {
    return null; // Forge not set up yet — silently skip
  }
}

let _toolCollector = null;
async function getToolCollector() {
  if (_toolCollector) return _toolCollector;
  try {
    const { ToolCollector } = await import("../trainer/tool-collector.mjs");
    _toolCollector = new ToolCollector();
    console.log("[Forge] ToolCollector initialized");
    return _toolCollector;
  } catch {
    return null;
  }
}

// ── Token Estimation ────────────────────────────────────────────────────────
// Approximate token counts from character length (~4 chars/token for English).
// Cost estimated from current API pricing — shows what this would cost if billed
// per-token instead of through the subscription.

// Per-million-token pricing (USD) — update if Anthropic changes rates
const TOKEN_PRICING = {
  opus:   { input: 5.00,  output: 25.00 },
  sonnet: { input: 3.00,  output: 15.00 },
  haiku:  { input: 1.00,  output:  5.00 },
  // Local models are free
  local:  { input: 0,     output: 0     },
};

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function estimateCost(promptTokens, completionTokens, model) {
  const tier = model?.includes("familiar") || model?.includes("ollama") || model?.includes("coder")
    ? "local"
    : model?.includes("opus") ? "opus"
    : model?.includes("sonnet") ? "sonnet"
    : model?.includes("haiku") ? "haiku"
    : "sonnet"; // default to sonnet pricing
  const pricing = TOKEN_PRICING[tier];
  const inputCost = (promptTokens / 1_000_000) * pricing.input;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;
  return { total: inputCost + outputCost, input: inputCost, output: outputCost, tier };
}

function estimateUsage(promptText, completionText, model) {
  const prompt_tokens = estimateTokens(promptText);
  const completion_tokens = estimateTokens(completionText);
  const cost = estimateCost(prompt_tokens, completion_tokens, model);
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
    estimated_cost: cost.total,
    _estimated: true,
    _note: `Est. ~$${cost.total.toFixed(4)} (${cost.tier} rates). Routed via subscription, not billed per-token.`,
    _cost_breakdown: { input: cost.input, output: cost.output, tier: cost.tier },
  };
}

// ── Concurrency Limiter ─────────────────────────────────────────────────────

const claudeLimiter = new Semaphore(parseInt(process.env.CLAUDE_MAX_CONCURRENT || "2", 10));

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.CLAUDE_PROXY_PORT || "18791", 10);
const DEFAULT_TIMEOUT_MS = 300_000; // 5 min
const MAX_TIMEOUT_MS = 600_000; // 10 min
const DEFAULT_MODEL = process.env.CLAUDE_PROXY_MODEL || "opus";

/**
 * Pick the right Claude model based on complexity score.
 * Opus for heavy/complex tasks, Sonnet for light/simple ones.
 * Threshold: >= 0.5 → opus, < 0.5 → sonnet
 */
function resolveClaudeModel(complexityScore) {
  if (complexityScore >= 0.5) return "opus";
  return "sonnet";
}
const TRAINING_MODE = process.env.FAMILIAR_TRAINING_MODE === "true";

// ── Familiar-specific constants ──────────────────────────────────────────────

/** Tools that would create circular calls back through the gateway/proxy */
const FAMILIAR_DISALLOWED_TOOLS = [
  "mcp__familiar__familiar_chat",
  "mcp__familiar__familiar_claude",
];

const FAMILIAR_MAX_TURNS = 25;
const FAMILIAR_TIMEOUT_MS = 300_000; // 5 min — coding tasks need room
const RESUME_TIMEOUT_MS = 30_000;    // 30s — session resumes should be fast, bail early if stale
const FAMILIAR_MCP_CONFIG = resolve(PROJECT_DIR, "config", "mcp-tools.json");

/** System preamble prepended to whatever Familiar sends */
const FAMILIAR_SYSTEM_PREAMBLE = [
  `You are ${getFamiliarName()}, a familiar from familiar.run — an AI project manager and coding assistant.`,
  "You have read/write access to local memory files in ~/.familiar/memory/.",
  "You have full access to the filesystem, Bash, and all standard Claude Code tools.",
  "You have MCP tools for Jira (Atlassian), Slack, and Figma.",
  "",
  "Guidelines:",
  "- For Jira: use the mcp__atlassian__jira_* tools to look up tickets, sprints, boards, and update issues.",
  "- For Slack: use the mcp__slack__slack_* tools to read channels, post messages, and reply to threads.",
  "- For Figma: use the mcp__figma__* tools to get design screenshots, metadata, and design context.",
  "- For coding tasks: read files, edit code, run builds/tests, commit with git — use the full tool suite.",
  "- For GitHub: use the `gh` CLI tool.",
  "- Be concise and factual. Summarize results clearly.",
  "- If a tool call fails, mention the error briefly and try an alternative approach.",
  "- Never fabricate ticket numbers, statuses, or data — only report what tools return.",
].join("\n");

// ── State ────────────────────────────────────────────────────────────────────

const activeJobs = new Map(); // jobId -> { process, startedAt, prompt }

// ── Smart Router ─────────────────────────────────────────────────────────────

const router = new Router({
  proxyUrl: `http://127.0.0.1:${PORT}`,
  ollamaUrl: "http://localhost:11434",
  localModel: "familiar-brain:latest",
});

// ── Session Tracking (multi-turn) ────────────────────────────────────────────
// Maps sessionKey → { sessionId, lastActivity }
// Claude Code sessions expire after 30 min of inactivity
const SESSION_TTL_MS = 30 * 60 * 1000;
const sessionStore = new Map();

function getSession(sessionKey) {
  const entry = sessionStore.get(sessionKey);
  if (!entry) return null;
  if (Date.now() - entry.lastActivity > SESSION_TTL_MS) {
    sessionStore.delete(sessionKey);
    return null;
  }
  return entry;
}

function setSession(sessionKey, sessionId) {
  sessionStore.set(sessionKey, { sessionId, lastActivity: Date.now() });
}

// Clean up expired sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sessionStore) {
    if (now - entry.lastActivity > SESSION_TTL_MS) {
      sessionStore.delete(key);
    }
  }
}, 600_000);

function sendSyntheticResponse(res, id, created, content, stream, promptText) {
  if (stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "familiar-assistant", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "familiar-assistant", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    jsonResponse(res, 200, {
      id, object: "chat.completion", created, model: "familiar-assistant",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: estimateUsage(promptText || "", content, "familiar-assistant"),
    });
  }
}

function fireDualComparison({ prompt, category, details, claudeText, claudeDuration, sessionKey, complexityScore }) {
  (async () => {
    const start = Date.now();
    try {
      const resp = await fetch("http://localhost:11434/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer ollama" },
        body: JSON.stringify({
          model: "familiar-coder:latest",
          messages: [
            { role: "system", content: `You are ${getFamiliarName()}, a familiar from familiar.run — an expert coding assistant. Write clean, well-structured code with clear explanations.` },
            { role: "user", content: prompt },
          ],
          stream: false,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const data = await resp.json();
      const familiarText = data.choices?.[0]?.message?.content || "";
      const familiarDuration = Date.now() - start;

      const collector = await getCollector();
      if (collector) {
        collector.collectComparison({
          prompt,
          goal: category,
          context: details,
          claudeResponse: claudeText,
          claudeDurationMs: claudeDuration,
          familiarResponse: familiarText,
          familiarDurationMs: familiarDuration,
          sessionKey,
          complexityScore,
        });
      }
      console.log(`[Training] Comparison stored (claude=${claudeDuration}ms familiar=${familiarDuration}ms familiar_len=${familiarText.length})`);
      emitProxyEvent("forge", { sessionKey, kind: "comparison", promptLength: prompt.length, score: complexityScore });
    } catch (err) {
      console.log(`[Training] Comparison failed: ${err.message}`);
    }
  })();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Strip Claude Code session env vars on startup
stripSessionEnv();

/** Forward an OpenAI-compatible chat request to Ollama */
async function forwardToOllama(messages, stream = false) {
  const ollamaUrl = "http://localhost:11434/v1/chat/completions";
  const resp = await fetch(ollamaUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer ollama" },
    body: JSON.stringify({
      model: "familiar-coder:latest",
      messages,
      stream,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  return resp;
}

function jsonResponse(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ── Claude CLI invocation ────────────────────────────────────────────────────

function invokeClaude(opts) {
  return _invokeClaude(opts, claudeLimiter);
}

// ── HTTP Server ──────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}`);

  // CORS headers for local use
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // ── GET /health ──────────────────────────────────────────────────────────
  if (url.pathname === "/health" && req.method === "GET") {
    const bin = claudeBin();
    const online = await checkOnline();
    return jsonResponse(res, 200, {
      status: "ok",
      claudeAvailable: !!bin,
      claudePath: bin,
      online,
      activeJobs: activeJobs.size,
      uptime: process.uptime(),
    });
  }

  // ── GET /status ──────────────────────────────────────────────────────────
  if (url.pathname === "/status" && req.method === "GET") {
    const online = await checkOnline();
    const jobs = [];
    for (const [id, job] of activeJobs) {
      jobs.push({
        jobId: id,
        startedAt: job.startedAt,
        runningMs: Date.now() - job.startedAt,
        prompt: job.prompt,
      });
    }
    return jsonResponse(res, 200, {
      online,
      activeJobs: jobs,
      defaultModel: DEFAULT_MODEL,
      concurrency: {
        running: claudeLimiter.current,
        max: claudeLimiter.max,
        queued: claudeLimiter.queue.length,
      },
    });
  }

  // ── POST /invoke ─────────────────────────────────────────────────────────
  if (url.pathname === "/invoke" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return jsonResponse(res, 400, { error: e.message });
    }

    if (!body.prompt) {
      return jsonResponse(res, 400, { error: "prompt is required" });
    }

    // Check if claude is available
    if (!claudeBin()) {
      return jsonResponse(res, 503, {
        error: "claude CLI not found on PATH",
        hint: "Install Claude Code: npm install -g @anthropic-ai/claude-code",
      });
    }

    // Check online status if caller wants to know
    const online = await checkOnline();
    if (!online && !body.allowOffline) {
      return jsonResponse(res, 503, {
        error: "Anthropic API unreachable",
        online: false,
        hint: "Set allowOffline: true to attempt anyway, or route to Ollama",
      });
    }

    try {
      const result = await invokeClaude({
        prompt: body.prompt,
        model: body.model,
        workingDir: body.workingDir,
        systemPrompt: body.systemPrompt,
        allowedTools: body.allowedTools,
        maxTurns: body.maxTurns,
        timeoutMs: body.timeoutMs,
        outputFormat: body.outputFormat,
        continueSession: body.continueSession,
        resumeSession: body.resumeSession,
        addDirs: body.addDirs,
      });
      return jsonResponse(res, 200, result);
    } catch (e) {
      return jsonResponse(res, 500, {
        error: e.message,
        jobFailed: true,
      });
    }
  }

  // ── POST /invoke/stream ──────────────────────────────────────────────────
  // Streaming variant — returns newline-delimited JSON chunks
  if (url.pathname === "/invoke/stream" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return jsonResponse(res, 400, { error: e.message });
    }

    if (!body.prompt) {
      return jsonResponse(res, 400, { error: "prompt is required" });
    }

    if (!claudeBin()) {
      return jsonResponse(res, 503, { error: "claude CLI not found" });
    }

    await claudeLimiter.acquire();

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Transfer-Encoding": "chunked",
    });

    const cwd = body.workingDir || resolve(PROJECT_DIR, "workspace");
    const args = [
      "-p",
      body.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
    ];

    if (body.model) args.push("--model", body.model);
    if (body.systemPrompt) args.push("--system-prompt", body.systemPrompt);
    if (body.maxTurns) args.push("--max-turns", String(body.maxTurns));
    if (body.allowedTools) args.push("--allowedTools", ...body.allowedTools);
    if (body.addDirs) args.push("--add-dir", ...body.addDirs);

    const child = spawn("claude", args, {
      cwd,
      env: cleanEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const jobId = randomUUID();
    const startedAt = Date.now();
    activeJobs.set(jobId, {
      process: child,
      startedAt,
      prompt: body.prompt.slice(0, 200),
    });

    // Capture full stream output for tool-use training data
    let streamBuffer = "";

    // Forward stream-json chunks to HTTP response
    child.stdout.on("data", (chunk) => {
      const str = chunk.toString();
      streamBuffer += str;
      res.write(chunk);
    });

    child.stderr.on("data", (chunk) => {
      // Emit errors as JSON lines
      res.write(
        JSON.stringify({ type: "error", error: chunk.toString().trim() }) +
          "\n"
      );
    });

    const timeout = Math.min(
      body.timeoutMs || DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    );
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      // Note: release happens in the 'close' handler triggered by SIGTERM
      res.write(JSON.stringify({ type: "error", error: "timeout" }) + "\n");
      res.end();
    }, timeout);

    child.on("close", () => {
      clearTimeout(timer);
      activeJobs.delete(jobId);
      claudeLimiter.release();

      // Fire-and-forget: collect tool-use trace for The Forge
      getToolCollector().then((tc) => {
        if (tc && streamBuffer.length > 100) {
          tc.collectTrace({
            prompt: body.prompt,
            streamOutput: streamBuffer,
            durationMs: Date.now() - startedAt,
          });
        }
      }).catch(() => {});

      res.end();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      activeJobs.delete(jobId);
      claudeLimiter.release();
      res.write(
        JSON.stringify({ type: "error", error: err.message }) + "\n"
      );
      res.end();
    });

    return;
  }

  // ── GET /v1/models ──────────────────────────────────────────────────────
  // OpenAI-compatible model listing
  if (url.pathname === "/v1/models" && req.method === "GET") {
    return jsonResponse(res, 200, {
      object: "list",
      data: [
        { id: "claude-subscription", object: "model", created: Date.now(), owned_by: "anthropic" },
      ],
    });
  }

  // ── POST /v1/chat/completions ─────────────────────────────────────────
  // OpenAI-compatible chat completions — smart routed + session-aware
  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return jsonResponse(res, 400, { error: { message: e.message, type: "invalid_request_error" } });
    }

    const messages = body.messages || [];
    if (messages.length === 0) {
      return jsonResponse(res, 400, { error: { message: "messages is required", type: "invalid_request_error" } });
    }

    // msg.content can be a string OR an array of content blocks
    function flattenContent(content) {
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
      }
      return String(content);
    }

    // Extract the last user message for routing decisions
    let lastUserMessage = "";
    let systemPrompt = FAMILIAR_SYSTEM_PREAMBLE;
    const nonSystemMessages = [];
    for (const msg of messages) {
      if (msg.role === "system") {
        systemPrompt += "\n\n" + flattenContent(msg.content);
      } else {
        nonSystemMessages.push(msg);
        if (msg.role === "user") {
          lastUserMessage = flattenContent(msg.content);
        }
      }
    }

    // Extract sessionKey from the request (Familiar embeds it in system messages or metadata)
    const sessionKeyMatch = systemPrompt.match(/sessionKey:\s*(\S+)/);
    const sessionKey = sessionKeyMatch?.[1] || body._sessionKey || "default";

    const stream = body.stream === true;
    const id = `chatcmpl-${randomUUID().slice(0, 8)}`;
    const created = Math.floor(Date.now() / 1000);

    // No session resume — each request is self-contained.
    // OpenCode sends the full message history, and the brain/memory system
    // captures relevant context across sessions automatically.
    const existingClaudeSession = null;
    const isFollowUp = false;

    emitProxyEvent("request", {
      sessionKey, requestId: id, msgCount: messages.length,
      stream, prompt: lastUserMessage.slice(0, 120),
    });

    // ── Training Mode ──────────────────────────────────────────────────
    // Dual-send: Claude (primary, shown to user) + familiar-coder (background comparison)
    if (TRAINING_MODE) {
      const intakeCategory = null;
      const intakeDetails = null;

      // Build prompt for Claude
      let prompt;
      if (isFollowUp) {
        prompt = lastUserMessage;
      } else {
        const recentMsgs = nonSystemMessages.slice(-20);
        const turns = [];
        for (const msg of recentMsgs) {
          const text = flattenContent(msg.content);
          if (msg.role === "user") turns.push(`User: ${text}`);
          else if (msg.role === "assistant") turns.push(`Assistant: ${text}`);
        }
        prompt = turns.join("\n\n");
      }

      if (!claudeBin()) {
        return jsonResponse(res, 503, { error: { message: "claude CLI not found", type: "server_error" } });
      }
      const online = await checkOnline();
      if (!online) {
        return jsonResponse(res, 503, { error: { message: "Anthropic API unreachable", type: "server_error" } });
      }

      const complexity = router.scoreComplexity({ prompt: lastUserMessage, hasCode: /```/.test(lastUserMessage) });
      console.log(`  [training] dual-send session=${sessionKey} follow_up=${isFollowUp} complexity=${complexity.toFixed(2)}`);
      emitProxyEvent("route", {
        sessionKey, requestId: id, backend: "claude", role: "training",
        score: complexity, reason: "training-mode",
      });

      const trainingModel = resolveClaudeModel(complexity);
      console.log(`  [training] model=${trainingModel} complexity=${complexity.toFixed(2)}`);
      try {
        const claudeStart = Date.now();
        const result = await invokeClaude({
          prompt,
          model: trainingModel,
          systemPrompt: isFollowUp ? undefined : (systemPrompt || undefined),
          outputFormat: "json",
          permissionMode: "bypassPermissions",
          disallowedTools: FAMILIAR_DISALLOWED_TOOLS,
          maxTurns: FAMILIAR_MAX_TURNS,
          addDirs: [resolve(PROJECT_DIR, "memory"), resolve(PROJECT_DIR, "workspace")],
          timeoutMs: FAMILIAR_TIMEOUT_MS,
          mcpConfig: FAMILIAR_MCP_CONFIG,
          resumeSession: isFollowUp ? existingClaudeSession.sessionId : undefined,
        });
        const claudeDuration = Date.now() - claudeStart;
        if (result.session_id) {
          setSession(sessionKey, result.session_id);
          emitProxyEvent("session", {
            sessionKey, requestId: id,
            action: isFollowUp ? "resumed" : "created",
            sessionId: result.session_id,
          });
        }
        const claudeText = typeof result.result === "string" ? result.result : JSON.stringify(result.result);
        emitProxyEvent("invoke", {
          sessionKey, requestId: id, model: "claude",
          duration: claudeDuration, cost: result.cost_usd || 0,
          turns: result.num_turns || 0,
        });

        // Fire-and-forget: background comparison to familiar-coder
        fireDualComparison({ prompt, category: intakeCategory, details: intakeDetails, claudeText, claudeDuration, sessionKey, complexityScore: complexity });

        if (stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "claude-subscription", choices: [{ index: 0, delta: { role: "assistant", content: claudeText }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "claude-subscription", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          jsonResponse(res, 200, {
            id, object: "chat.completion", created, model: "claude-subscription",
            choices: [{ index: 0, message: { role: "assistant", content: claudeText }, finish_reason: "stop" }],
            usage: estimateUsage(prompt, claudeText, trainingModel),
          });
        }
      } catch (e) {
        // If session expired/lost, retry fresh with full context
        if (isFollowUp && e.message?.includes("session")) {
          console.log(`  → [training] Session resume failed, retrying fresh`);
          sessionStore.delete(sessionKey);
          try {
            const recentMsgs = nonSystemMessages.slice(-20);
            const turns = [];
            for (const msg of recentMsgs) {
              const text = flattenContent(msg.content);
              if (msg.role === "user") turns.push(`User: ${text}`);
              else if (msg.role === "assistant") turns.push(`Assistant: ${text}`);
            }
            const freshPrompt = turns.join("\n\n");

            const claudeStart = Date.now();
            const result = await invokeClaude({
              prompt: freshPrompt,
              model: trainingModel,
              systemPrompt: systemPrompt || undefined,
              outputFormat: "json",
              permissionMode: "bypassPermissions",
              disallowedTools: FAMILIAR_DISALLOWED_TOOLS,
              maxTurns: FAMILIAR_MAX_TURNS,
              addDirs: [resolve(PROJECT_DIR, "memory"), resolve(PROJECT_DIR, "workspace")],
              timeoutMs: FAMILIAR_TIMEOUT_MS,
              mcpConfig: FAMILIAR_MCP_CONFIG,
            });
            const claudeDuration = Date.now() - claudeStart;
            if (result.session_id) setSession(sessionKey, result.session_id);
            const claudeText = typeof result.result === "string" ? result.result : JSON.stringify(result.result);

            fireDualComparison({ prompt: freshPrompt, category: intakeCategory, details: intakeDetails, claudeText, claudeDuration, sessionKey, complexityScore: complexity });

            if (stream) {
              if (!res.headersSent) res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
              res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "claude-subscription", choices: [{ index: 0, delta: { role: "assistant", content: claudeText }, finish_reason: null }] })}\n\n`);
              res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "claude-subscription", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
              res.write("data: [DONE]\n\n");
              res.end();
            } else {
              jsonResponse(res, 200, {
                id, object: "chat.completion", created, model: "claude-subscription",
                choices: [{ index: 0, message: { role: "assistant", content: claudeText }, finish_reason: "stop" }],
                usage: estimateUsage(freshPrompt, claudeText, trainingModel),
              });
            }
            return;
          } catch (retryErr) {
            e = retryErr;
          }
        }

        if (stream) {
          if (!res.headersSent) res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "claude-subscription", choices: [{ index: 0, delta: { content: `Error: ${e.message}` }, finish_reason: "stop" }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          jsonResponse(res, 500, { error: { message: e.message, type: "server_error" } });
        }
      }
      return;
    }

    // ── Smart Routing (production mode) ─────────────────────────────────
    // Use the Router to decide: Claude Code (heavy) vs Ollama (light)
    const routeResult = await router.routeAndCollect({
      prompt: lastUserMessage,
      hasCode: /```/.test(lastUserMessage),
    });

    console.log(`  stream=${body.stream} msgs=${messages.length} route=${routeResult.backend} role=${routeResult.role} score=${routeResult.score?.toFixed(2)} session=${sessionKey}`);
    emitProxyEvent("route", {
      sessionKey, requestId: id, backend: routeResult.backend,
      role: routeResult.role, score: routeResult.score,
      reason: routeResult.reason,
    });

    // ── Route to Ollama for light tasks (with agentic tool loop) ────
    if (routeResult.backend === "ollama") {
      console.log(`  → Ollama + Tool Loop (${routeResult.reason})`);
      try {
        const loopResult = await runToolLoop({
          prompt: lastUserMessage,
          systemPrompt: routeResult.systemPrompt || (systemPrompt !== FAMILIAR_SYSTEM_PREAMBLE ? systemPrompt : ""),
          model: "familiar-coder:latest",
          maxIterations: 10,
          maxToolCalls: 25,
          timeoutMs: 120_000,
        });

        const responseText = loopResult.response || "(no response)";
        console.log(`  → Tool loop done: ${loopResult.iterations} iters, ${loopResult.toolCalls.length} tools, ${loopResult.finishReason}`);
        emitProxyEvent("toolloop", {
          sessionKey, requestId: id, iterations: loopResult.iterations,
          toolCount: loopResult.toolCalls.length, duration: loopResult.totalDurationMs,
          finishReason: loopResult.finishReason,
        });

        if (stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "familiar-coder", choices: [{ index: 0, delta: { role: "assistant", content: responseText }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "familiar-coder", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          return jsonResponse(res, 200, {
            id, object: "chat.completion", created, model: "familiar-coder",
            choices: [{ index: 0, message: { role: "assistant", content: responseText }, finish_reason: "stop" }],
            usage: estimateUsage(lastUserMessage, responseText, "familiar-coder"),
            _meta: { iterations: loopResult.iterations, toolCalls: loopResult.toolCalls.length, finishReason: loopResult.finishReason, durationMs: loopResult.totalDurationMs },
          });
        }
        return;
      } catch (e) {
        console.log(`  → Tool loop failed (${e.message}), falling through to Claude`);
        // Fall through to Claude if tool loop fails
      }
    }

    // ── Route to Claude Code (primary) ─────────────────────────
    const claudeModel = resolveClaudeModel(routeResult.score);
    console.log(`  → Claude Code ${claudeModel} (${routeResult.reason})`);

    // If Claude is unavailable, fall back to Ollama tool-loop
    if (!claudeBin() || !(await checkOnline())) {
      console.log(`  → Claude unavailable, falling back to Ollama tool-loop`);
      emitProxyEvent("fallback", {
        sessionKey, requestId: id, from: "claude", to: "ollama",
        reason: "offline",
      });
      try {
        const loopResult = await runToolLoop({
          prompt: lastUserMessage,
          systemPrompt: routeResult.systemPrompt || (systemPrompt !== FAMILIAR_SYSTEM_PREAMBLE ? systemPrompt : ""),
          model: routeResult.model || "familiar-coder:latest",
          maxIterations: 10,
          maxToolCalls: 25,
          timeoutMs: 120_000,
        });

        const responseText = `(Local model — Claude is offline)\n\n${loopResult.response || "(no response)"}`;
        console.log(`  → Ollama fallback done: ${loopResult.iterations} iters, ${loopResult.toolCalls.length} tools`);

        if (stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "familiar-coder", choices: [{ index: 0, delta: { role: "assistant", content: responseText }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "familiar-coder", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          return jsonResponse(res, 200, {
            id, object: "chat.completion", created, model: "familiar-coder",
            choices: [{ index: 0, message: { role: "assistant", content: responseText }, finish_reason: "stop" }],
            usage: estimateUsage(lastUserMessage, responseText, "familiar-coder"),
            _meta: { fallback: true, iterations: loopResult.iterations, toolCalls: loopResult.toolCalls.length },
          });
        }
        return;
      } catch (e) {
        console.error(`  → Ollama fallback also failed: ${e.message}`);
        return jsonResponse(res, 503, { error: { message: "Both Claude and local model unavailable", type: "server_error" } });
      }
    }

    // For follow-ups with an existing session, use --resume with just the new message
    // For first messages, send the full prompt
    let prompt;
    if (isFollowUp) {
      // Only send the latest user message — Claude Code will have context from the session
      prompt = lastUserMessage;
      console.log(`  → Resuming session ${existingClaudeSession.sessionId.slice(0, 8)}...`);
    } else {
      // First message — build full context prompt
      const MAX_CONTEXT_MESSAGES = 20;
      const recentMessages = nonSystemMessages.slice(-MAX_CONTEXT_MESSAGES);
      const turns = [];
      for (const msg of recentMessages) {
        const text = flattenContent(msg.content);
        if (msg.role === "user") {
          turns.push(`User: ${text}`);
        } else if (msg.role === "assistant") {
          turns.push(`Assistant: ${text}`);
        }
      }
      prompt = turns.join("\n\n");
    }

    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      try {
        const result = await invokeClaude({
          prompt,
          model: claudeModel,
          systemPrompt: isFollowUp ? undefined : (systemPrompt || undefined),
          outputFormat: "json",
          permissionMode: "bypassPermissions",
          disallowedTools: FAMILIAR_DISALLOWED_TOOLS,
          maxTurns: FAMILIAR_MAX_TURNS,
          addDirs: [resolve(PROJECT_DIR, "memory"), resolve(PROJECT_DIR, "workspace")],
          timeoutMs: isFollowUp ? RESUME_TIMEOUT_MS : FAMILIAR_TIMEOUT_MS,
          mcpConfig: FAMILIAR_MCP_CONFIG,
          resumeSession: isFollowUp ? existingClaudeSession.sessionId : undefined,
        });

        // Store session for follow-up
        if (result.session_id) {
          setSession(sessionKey, result.session_id);
          emitProxyEvent("session", {
            sessionKey, requestId: id,
            action: isFollowUp ? "resumed" : "created",
            sessionId: result.session_id,
          });
        }

        const text = typeof result.result === "string" ? result.result : JSON.stringify(result.result);
        emitProxyEvent("invoke", {
          sessionKey, requestId: id, model: "claude",
          duration: result.duration_ms || 0, cost: result.cost_usd || 0,
          turns: result.num_turns || 0,
        });

        // Fire-and-forget: collect training pair for The Forge
        getCollector().then((c) => {
          if (c) {
            c.collectPair({
              prompt,
              routedTo: "claude",
              primaryResponse: text,
              primaryDurationMs: result.duration_ms,
            });
            emitProxyEvent("forge", {
              sessionKey, requestId: id, kind: "pair",
              promptLength: prompt.length, score: routeResult.score,
            });
          }
        }).catch(() => {});

        const sseChunk = {
          id, object: "chat.completion.chunk", created,
          model: "claude-subscription",
          choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);

        const sseDone = {
          id, object: "chat.completion.chunk", created,
          model: "claude-subscription",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
        res.write(`data: ${JSON.stringify(sseDone)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } catch (e) {
        // If resume fails (session expired, timed out, etc.), retry without session
        if (isFollowUp && (e.message?.includes("session") || e.message?.includes("Timed out"))) {
          console.log(`  → Session resume failed (${e.message.slice(0, 60)}), retrying fresh`);
          sessionStore.delete(sessionKey);
          try {
            const MAX_CONTEXT_MESSAGES = 20;
            const recentMessages = nonSystemMessages.slice(-MAX_CONTEXT_MESSAGES);
            const turns = [];
            for (const msg of recentMessages) {
              const text = flattenContent(msg.content);
              if (msg.role === "user") turns.push(`User: ${text}`);
              else if (msg.role === "assistant") turns.push(`Assistant: ${text}`);
            }
            const freshPrompt = turns.join("\n\n");

            const result = await invokeClaude({
              prompt: freshPrompt,
              model: claudeModel,
              systemPrompt: systemPrompt || undefined,
              outputFormat: "json",
              permissionMode: "bypassPermissions",
              disallowedTools: FAMILIAR_DISALLOWED_TOOLS,
              maxTurns: FAMILIAR_MAX_TURNS,
              addDirs: [resolve(PROJECT_DIR, "memory"), resolve(PROJECT_DIR, "workspace")],
              timeoutMs: FAMILIAR_TIMEOUT_MS,
              mcpConfig: FAMILIAR_MCP_CONFIG,
            });
            if (result.session_id) setSession(sessionKey, result.session_id);
            const text = typeof result.result === "string" ? result.result : JSON.stringify(result.result);
            res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "claude-subscription", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "claude-subscription", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          } catch (retryErr) {
            e = retryErr;
          }
        }

        // Rate limit or fatal error — try Ollama fallback before giving up
        if (e.message?.includes("hit your limit") || e.message?.includes("rate limit")) {
          console.log(`  → Claude rate-limited, falling back to Ollama tool-loop`);
          emitProxyEvent("fallback", {
            sessionKey, requestId: id, from: "claude", to: "ollama",
            reason: "rate-limited",
          });
          try {
            const loopResult = await runToolLoop({
              prompt: lastUserMessage,
              systemPrompt: routeResult?.systemPrompt || (systemPrompt !== FAMILIAR_SYSTEM_PREAMBLE ? systemPrompt : ""),
              model: routeResult?.model || "familiar-coder:latest",
              maxIterations: 10,
              maxToolCalls: 25,
              timeoutMs: 120_000,
            });
            const fallbackText = loopResult.response || "(no response)";
            res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "familiar-coder", choices: [{ index: 0, delta: { role: "assistant", content: fallbackText }, finish_reason: null }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "familiar-coder", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          } catch (fallbackErr) {
            console.error(`  → Ollama fallback also failed: ${fallbackErr.message}`);
          }
        }

        const sseErr = {
          id, object: "chat.completion.chunk", created,
          model: "claude-subscription",
          choices: [{ index: 0, delta: { content: `Error: ${e.message}` }, finish_reason: "stop" }],
        };
        res.write(`data: ${JSON.stringify(sseErr)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      return;
    }

    // Non-streaming mode
    try {
      const result = await invokeClaude({
        prompt,
        model: claudeModel,
        systemPrompt: isFollowUp ? undefined : (systemPrompt || undefined),
        outputFormat: "json",
        permissionMode: "bypassPermissions",
        disallowedTools: FAMILIAR_DISALLOWED_TOOLS,
        maxTurns: FAMILIAR_MAX_TURNS,
        addDirs: [resolve(PROJECT_DIR, "memory"), resolve(PROJECT_DIR, "workspace")],
        timeoutMs: isFollowUp ? RESUME_TIMEOUT_MS : FAMILIAR_TIMEOUT_MS,
        mcpConfig: FAMILIAR_MCP_CONFIG,
        resumeSession: isFollowUp ? existingClaudeSession.sessionId : undefined,
      });

      // Store session for follow-up
      if (result.session_id) {
        setSession(sessionKey, result.session_id);
        emitProxyEvent("session", {
          sessionKey, requestId: id,
          action: isFollowUp ? "resumed" : "created",
          sessionId: result.session_id,
        });
      }

      const text = typeof result.result === "string" ? result.result : JSON.stringify(result.result);
      emitProxyEvent("invoke", {
        sessionKey, requestId: id, model: "claude",
        duration: result.duration_ms || 0, cost: result.cost_usd || 0,
        turns: result.num_turns || 0,
      });

      // Fire-and-forget: collect training pair for The Forge
      getCollector().then((c) => {
        if (c) {
          c.collectPair({
            prompt,
            routedTo: "claude",
            primaryResponse: text,
            primaryDurationMs: result.duration_ms,
          });
          emitProxyEvent("forge", {
            sessionKey, requestId: id, kind: "pair",
            promptLength: prompt.length, score: routeResult.score,
          });
        }
      }).catch(() => {});

      return jsonResponse(res, 200, {
        id,
        object: "chat.completion",
        created,
        model: "claude-subscription",
        choices: [{
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        }],
        usage: estimateUsage(prompt, text, claudeModel),
      });
    } catch (e) {
      // If resume fails (session expired, timed out, etc.), retry without session
      if (isFollowUp && (e.message?.includes("session") || e.message?.includes("Timed out"))) {
        console.log(`  → Session resume failed (${e.message.slice(0, 60)}), retrying fresh`);
        sessionStore.delete(sessionKey);
        try {
          const MAX_CONTEXT_MESSAGES = 20;
          const recentMessages = nonSystemMessages.slice(-MAX_CONTEXT_MESSAGES);
          const turns = [];
          for (const msg of recentMessages) {
            const text = flattenContent(msg.content);
            if (msg.role === "user") turns.push(`User: ${text}`);
            else if (msg.role === "assistant") turns.push(`Assistant: ${text}`);
          }
          const freshPrompt = turns.join("\n\n");

          const result = await invokeClaude({
            prompt: freshPrompt,
            model: claudeModel,
            systemPrompt: systemPrompt || undefined,
            outputFormat: "json",
            permissionMode: "bypassPermissions",
            disallowedTools: FAMILIAR_DISALLOWED_TOOLS,
            maxTurns: FAMILIAR_MAX_TURNS,
            addDirs: [resolve(PROJECT_DIR, "memory"), resolve(PROJECT_DIR, "workspace")],
            timeoutMs: FAMILIAR_TIMEOUT_MS,
            mcpConfig: FAMILIAR_MCP_CONFIG,
          });
          if (result.session_id) setSession(sessionKey, result.session_id);
          const text = typeof result.result === "string" ? result.result : JSON.stringify(result.result);
          return jsonResponse(res, 200, {
            id, object: "chat.completion", created, model: "claude-subscription",
            choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
            usage: estimateUsage(freshPrompt, text, claudeModel),
          });
        } catch (retryErr) {
          e = retryErr;
        }
      }

      // Rate limit — try Ollama fallback
      if (e.message?.includes("hit your limit") || e.message?.includes("rate limit")) {
        console.log(`  → Claude rate-limited, falling back to Ollama tool-loop`);
        emitProxyEvent("fallback", {
          sessionKey, requestId: id, from: "claude", to: "ollama",
          reason: "rate-limited",
        });
        try {
          const loopResult = await runToolLoop({
            prompt: lastUserMessage,
            systemPrompt: routeResult?.systemPrompt || (systemPrompt !== FAMILIAR_SYSTEM_PREAMBLE ? systemPrompt : ""),
            model: routeResult?.model || "familiar-coder:latest",
            maxIterations: 10,
            maxToolCalls: 25,
            timeoutMs: 120_000,
          });
          const fallbackText = loopResult.response || "(no response)";
          return jsonResponse(res, 200, {
            id, object: "chat.completion", created, model: "familiar-coder",
            choices: [{ index: 0, message: { role: "assistant", content: fallbackText }, finish_reason: "stop" }],
            usage: estimateUsage(lastUserMessage, fallbackText, "familiar-coder"),
            _meta: { fallback: true, reason: "rate-limited", iterations: loopResult.iterations, toolCalls: loopResult.toolCalls.length },
          });
        } catch (fallbackErr) {
          console.error(`  → Ollama fallback also failed: ${fallbackErr.message}`);
        }
      }

      emitProxyEvent("error", { sessionKey, requestId: id, message: e.message, context: "non-streaming" });
      return jsonResponse(res, 500, { error: { message: e.message, type: "server_error" } });
    }
  }

  // ── POST /cancel ─────────────────────────────────────────────────────────
  if (url.pathname === "/cancel" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return jsonResponse(res, 400, { error: e.message });
    }

    const job = activeJobs.get(body.jobId);
    if (!job) {
      return jsonResponse(res, 404, { error: "Job not found or already completed" });
    }

    job.process.kill("SIGTERM");
    activeJobs.delete(body.jobId);
    return jsonResponse(res, 200, { cancelled: true, jobId: body.jobId });
  }

  // ── GET /v1/sessions ─────────────────────────────────────────────────────
  // List active Claude Code sessions
  if (url.pathname === "/v1/sessions" && req.method === "GET") {
    const sessions = [];
    for (const [key, entry] of sessionStore) {
      sessions.push({
        sessionKey: key,
        sessionId: entry.sessionId,
        lastActivity: entry.lastActivity,
        idleMs: Date.now() - entry.lastActivity,
      });
    }
    return jsonResponse(res, 200, { sessions });
  }

  // ── GET /proxy/events ──────────────────────────────────────────────────
  if (url.pathname === "/proxy/events" && req.method === "GET") {
    return jsonResponse(res, 200, {
      events: getRecentEvents(),
      sessions: getAllSessionStats(),
    });
  }

  // ── 404 ──────────────────────────────────────────────────────────────────
  jsonResponse(res, 404, { error: "Not found" });
});

// ── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, "127.0.0.1", () => {
  const bin = claudeBin();
  console.log(`Claude Code Proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`  claude binary: ${bin || "NOT FOUND"}`);
  console.log(`  default model: ${DEFAULT_MODEL}`);
  console.log(`  workspace:     ${resolve(PROJECT_DIR, "workspace")}`);
  console.log("");
  console.log(`  concurrency:   max ${claudeLimiter.max} (CLAUDE_MAX_CONCURRENT)`);
  console.log(`  training mode: ${TRAINING_MODE ? "ON (dual-send)" : "OFF (smart routing)"}`);
  console.log(`  smart router:  ${TRAINING_MODE ? "BYPASSED" : "ON (score threshold: dynamic)"}`);
  console.log(`  sessions:      ON (TTL: ${SESSION_TTL_MS / 60000}min)`);
  console.log("");
  console.log("Endpoints:");
  console.log("  GET  /health              — check proxy + claude + online status");
  console.log("  GET  /status              — active jobs and connectivity");
  console.log("  POST /invoke              — run claude -p (blocking, returns JSON)");
  console.log("  POST /invoke/stream       — run claude -p (streaming NDJSON)");
  console.log("  POST /v1/chat/completions — OpenAI-compat (smart routed + session-aware)");
  console.log("  GET  /v1/sessions         — list active Claude Code sessions");
  console.log("  GET  /proxy/events        — recent events + session stats");
  console.log("  POST /cancel              — kill a running job by jobId");

  // Pre-warm daemon connection so browser/desktop tools are available in system prompts
  warmDaemon().then(() => {
    console.log("[proxy] Daemon tools pre-warmed");
  }).catch(() => {
    console.warn("[proxy] Daemon pre-warm failed (tools will be unavailable)");
  });
});
