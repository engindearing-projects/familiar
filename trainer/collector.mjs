#!/usr/bin/env bun

// The Forge — Data Collector
// Intercepts requests and collects paired (prompt, claude_answer, local_answer) responses.
// Runs shadow requests to the backend that WASN'T chosen by the router.

import { existsSync, mkdirSync, appendFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash, randomUUID } from "crypto";
import { classifyPrompt } from "./classify.mjs";
import { getActiveDomain, getOllamaUrl } from "./domain-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = resolve(__dirname, "data", "raw");
const CLAUDE_PROXY_URL = "http://127.0.0.1:18791";
const DEFAULT_LOCAL_MODEL = "familiar-coder:latest";

/** Resolve Ollama URL from active domain config (remote GPU if available) */
function resolveOllamaUrl() {
  try {
    return getOllamaUrl(getActiveDomain());
  } catch {
    return "http://localhost:11434";
  }
}

// Ensure raw data directory exists
if (!existsSync(RAW_DIR)) {
  mkdirSync(RAW_DIR, { recursive: true });
}

function hashPrompt(prompt) {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

function todayFile(suffix = "") {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return resolve(RAW_DIR, `${date}${suffix}.jsonl`);
}

async function callClaude(prompt) {
  const start = Date.now();
  try {
    const resp = await fetch(`${CLAUDE_PROXY_URL}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, model: "sonnet" }),
      signal: AbortSignal.timeout(300_000), // 5 min max
    });
    if (!resp.ok) return { response: null, durationMs: Date.now() - start };
    const data = await resp.json();
    const text = typeof data.result === "string" ? data.result : JSON.stringify(data.result);
    return { response: text, durationMs: Date.now() - start };
  } catch {
    return { response: null, durationMs: Date.now() - start };
  }
}

async function callOllama(prompt, model = DEFAULT_LOCAL_MODEL) {
  const ollamaUrl = resolveOllamaUrl();
  const start = Date.now();
  try {
    const resp = await fetch(`${ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are Familiar, an AI assistant from familiar.run — an expert coding assistant. Write clean, well-structured code with clear explanations." },
          { role: "user", content: prompt },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000), // 2 min max for local
    });
    if (!resp.ok) return { response: null, durationMs: Date.now() - start };
    const data = await resp.json();
    return { response: data.message?.content ?? null, durationMs: Date.now() - start };
  } catch {
    return { response: null, durationMs: Date.now() - start };
  }
}

function writePair(pair) {
  const file = todayFile();
  appendFileSync(file, JSON.stringify(pair) + "\n");
}

export class Collector {
  constructor(opts = {}) {
    this.localModel = opts.localModel || DEFAULT_LOCAL_MODEL;
    this.enabled = opts.enabled !== false;
    this._inflight = 0;
    this._maxInflight = opts.maxInflight || 3; // limit concurrent shadow requests
  }

  /**
   * Collect a paired response — fires a shadow request to the backend that
   * WASN'T chosen by the router. Never blocks the caller.
   *
   * @param {object} opts
   * @param {string} opts.prompt - The original user prompt
   * @param {string} opts.routedTo - Which backend was actually used ("claude" | "ollama")
   * @param {number} [opts.complexityScore] - Router's complexity score
   * @param {string} [opts.primaryResponse] - The response from the chosen backend
   * @param {number} [opts.primaryDurationMs] - How long the chosen backend took
   * @param {string} [opts.primaryModel] - Which model generated the primary response
   * @param {object[]} [opts.toolCalls] - Tool calls made during this response
   * @param {string[]} [opts.toolsUsed] - Names of tools used
   */
  collectPair({ prompt, routedTo, complexityScore, primaryResponse, primaryDurationMs, primaryModel, toolCalls, toolsUsed }) {
    if (!this.enabled) return;
    if (!prompt || !routedTo) return;
    if (this._inflight >= this._maxInflight) return; // skip if too many in flight

    // Fire and forget — never block
    this._inflight++;
    this._doCollect({ prompt, routedTo, complexityScore, primaryResponse, primaryDurationMs, primaryModel, toolCalls, toolsUsed })
      .catch((err) => console.error("[Forge Collector] error:", err.message))
      .finally(() => this._inflight--);
  }

  async _doCollect({ prompt, routedTo, complexityScore, primaryResponse, primaryDurationMs, primaryModel, toolCalls, toolsUsed }) {
    const promptHash = hashPrompt(prompt);

    // Shadow request to the OTHER backend
    let claudeResponse = null;
    let claudeDurationMs = null;
    let localResponse = null;
    let localDurationMs = null;

    if (routedTo === "claude") {
      // Primary was Claude — shadow to local
      claudeResponse = primaryResponse || null;
      claudeDurationMs = primaryDurationMs || null;

      const shadow = await callOllama(prompt, this.localModel);
      localResponse = shadow.response;
      localDurationMs = shadow.durationMs;
    } else {
      // Primary was Ollama — shadow to Claude
      localResponse = primaryResponse || null;
      localDurationMs = primaryDurationMs || null;

      const shadow = await callClaude(prompt);
      claudeResponse = shadow.response;
      claudeDurationMs = shadow.durationMs;
    }

    // Only write if we got both responses
    if (!claudeResponse || !localResponse) return;

    // Detect tool calls from response content or explicit metadata
    const hasToolCallsDetected = !!(toolCalls?.length) || /\[Tool:/.test(claudeResponse) || /tool_use|tool_calls/.test(claudeResponse);
    const detectedToolsUsed = toolsUsed || [];

    // Classify prompt for multi-model routing
    const classification = classifyPrompt(prompt, {
      hasCode: /```/.test(claudeResponse),
      hasToolCalls: hasToolCallsDetected,
      toolsUsed: detectedToolsUsed,
      responseLength: claudeResponse.length,
    });

    const pair = {
      id: `pair_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      timestamp: new Date().toISOString(),
      prompt,
      prompt_hash: promptHash,
      complexity_score: complexityScore ?? null,
      routed_to: routedTo,
      task_type: classification.type,
      task_type_confidence: classification.confidence,
      claude_response: claudeResponse,
      claude_duration_ms: claudeDurationMs,
      local_response: localResponse,
      local_duration_ms: localDurationMs,
      local_model: this.localModel,
      primary_model: primaryModel || (routedTo === "claude" ? "claude" : this.localModel),
      training_eligible: false,
      data_source: "collector",
      gold_source: "claude_distillation",
    };

    writePair(pair);

    // If tool calls were present, also save to dedicated tools dataset
    // with the full structured tool call sequence for tool-use training
    if (hasToolCallsDetected && toolCalls?.length) {
      const toolPair = {
        id: `tool_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        type: "tool_trace",
        timestamp: new Date().toISOString(),
        prompt,
        prompt_hash: promptHash,
        task_type: "tools",
        tools_used: detectedToolsUsed,
        num_tool_calls: toolCalls.length,
        tool_calls: toolCalls,
        claude_response: claudeResponse,
        local_response: localResponse,
      };
      appendFileSync(todayFile("-tools"), JSON.stringify(toolPair) + "\n");
    }

    // Also record in forge DB (non-blocking)
    try {
      const { recordPair } = await import("./forge-db.js");
      recordPair({
        id: pair.id,
        prompt_hash: promptHash,
        timestamp: pair.timestamp,
        complexity_score: pair.complexity_score,
        routed_to: pair.routed_to,
        claude_response_length: pair.claude_response.length,
        local_response_length: pair.local_response.length,
        claude_duration_ms: pair.claude_duration_ms,
        local_duration_ms: pair.local_duration_ms,
        local_model: pair.local_model,
        has_code: /```/.test(pair.claude_response),
        task_type: classification.type,
        task_type_confidence: classification.confidence,
        training_eligible: false,
        data_source: "collector",
        gold_source: "claude_distillation",
      });
    } catch (err) {
      // DB errors are non-fatal
      console.error("[Forge Collector] DB error:", err.message);
    }

    console.log(`[Forge Collector] Pair ${pair.id} [${classification.type}] saved (${claudeResponse.length}/${localResponse.length} chars)`);
  }

  /**
   * Collect a comparison from dual-send (training mode).
   * Stores Claude and familiar-coder responses side-by-side.
   * Fire-and-forget — never blocks the caller.
   */
  collectComparison({ prompt, goal, context, claudeResponse, claudeDurationMs, engieResponse, engieDurationMs, sessionKey, complexityScore }) {
    if (!this.enabled) return;
    if (!prompt) return;

    const classification = classifyPrompt(prompt, {
      hasCode: /```/.test(claudeResponse || ""),
      hasToolCalls: /\[Tool:/.test(claudeResponse || ""),
      responseLength: claudeResponse?.length,
    });

    (async () => {
      try {
        const { recordComparison } = await import("./forge-db.js");
        recordComparison({
          prompt,
          goal,
          context,
          claudeResponse,
          claudeDurationMs,
          engieResponse,
          engieDurationMs,
          sessionKey,
          complexityScore,
          taskType: classification.type,
          taskTypeConfidence: classification.confidence,
        });
        console.log(`[Forge Collector] Comparison [${classification.type}] saved (claude=${claudeDurationMs}ms familiar=${engieDurationMs}ms)`);
      } catch (err) {
        console.error("[Forge Collector] Comparison error:", err.message);
      }
    })();
  }

  get inflight() {
    return this._inflight;
  }
}

export default Collector;
