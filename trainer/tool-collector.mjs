#!/usr/bin/env bun

// The Forge — Tool-Use Collector
// Captures full agent traces (tool calls, results, reasoning) from Claude Code sessions.
// These traces train the model to be a full agent, not just a code generator.
//
// Data format: each trace is a multi-turn conversation showing:
//   1. User prompt
//   2. Assistant reasoning + tool_use call
//   3. Tool result
//   4. Assistant reasoning + next tool_use (or final answer)
//   ... repeat until done
//
// This is the missing piece for training familiar-coder to handle the agent loop.

import { existsSync, mkdirSync, appendFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash, randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACES_DIR = resolve(__dirname, "data", "traces");

if (!existsSync(TRACES_DIR)) {
  mkdirSync(TRACES_DIR, { recursive: true });
}

function hashPrompt(prompt) {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

function todayFile() {
  const date = new Date().toISOString().slice(0, 10);
  return resolve(TRACES_DIR, `${date}-tools.jsonl`);
}

/**
 * Parse Claude Code stream-json output into structured tool traces.
 * stream-json emits one JSON object per line with types like:
 *   - assistant: text content from Claude
 *   - tool_use: Claude calling a tool (name + input)
 *   - tool_result: result from the tool
 *   - result: final result object
 */
function parseStreamEvents(rawOutput) {
  const events = [];
  for (const line of rawOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip non-JSON lines (progress bars, etc.)
    }
  }
  return events;
}

/**
 * Convert stream events into a training-ready conversation trace.
 * Returns an array of messages in chat format, preserving the full
 * tool-use chain so the model learns the agent loop.
 */
function eventsToTrace(events) {
  const messages = [];
  let currentAssistantText = "";

  for (const event of events) {
    switch (event.type) {
      case "assistant": {
        // Accumulate assistant text (may come in multiple chunks)
        const text = typeof event.message === "string"
          ? event.message
          : event.message?.content || "";
        if (text) currentAssistantText += text;
        break;
      }

      case "tool_use": {
        // Flush any accumulated text, then record the tool call
        const toolCall = {
          role: "assistant",
          content: currentAssistantText || null,
          tool_calls: [{
            id: event.id || `call_${randomUUID().slice(0, 8)}`,
            type: "function",
            function: {
              name: event.name,
              arguments: typeof event.input === "string"
                ? event.input
                : JSON.stringify(event.input),
            },
          }],
        };
        messages.push(toolCall);
        currentAssistantText = "";
        break;
      }

      case "tool_result": {
        // Record what the tool returned
        const content = typeof event.content === "string"
          ? event.content
          : JSON.stringify(event.content);
        messages.push({
          role: "tool",
          tool_call_id: event.tool_use_id || event.id || "unknown",
          content: content.slice(0, 8000), // cap tool results to avoid huge traces
        });
        break;
      }

      case "result": {
        // Final response — flush any remaining text
        if (currentAssistantText) {
          messages.push({ role: "assistant", content: currentAssistantText });
          currentAssistantText = "";
        }
        break;
      }
    }
  }

  // Flush any remaining text that wasn't followed by a tool call
  if (currentAssistantText) {
    messages.push({ role: "assistant", content: currentAssistantText });
  }

  return messages;
}

/**
 * Extract tool names used in a trace for metadata.
 */
function extractToolNames(messages) {
  const tools = new Set();
  for (const msg of messages) {
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        tools.add(tc.function.name);
      }
    }
  }
  return [...tools];
}

export class ToolCollector {
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this._inflight = 0;
    this._maxInflight = opts.maxInflight || 2;
  }

  /**
   * Record a full agent trace from a Claude Code session.
   * Called with the raw stream-json output from claude -p.
   *
   * @param {object} opts
   * @param {string} opts.prompt - The original user prompt
   * @param {string} opts.streamOutput - Raw stream-json output (newline-delimited JSON)
   * @param {number} [opts.durationMs] - Total session duration
   * @param {number} [opts.numTurns] - Number of agentic turns
   * @param {string} [opts.sessionId] - Claude Code session ID
   */
  collectTrace({ prompt, streamOutput, durationMs, numTurns, sessionId }) {
    if (!this.enabled || !prompt || !streamOutput) return;
    if (this._inflight >= this._maxInflight) return;

    this._inflight++;
    this._doCollect({ prompt, streamOutput, durationMs, numTurns, sessionId })
      .catch((err) => console.error("[Forge ToolCollector] error:", err.message))
      .finally(() => this._inflight--);
  }

  async _doCollect({ prompt, streamOutput, durationMs, numTurns, sessionId }) {
    const events = parseStreamEvents(streamOutput);
    if (events.length < 2) return; // need at least prompt + response

    const trace = eventsToTrace(events);
    if (trace.length === 0) return;

    // Only save traces that actually have tool calls (that's the whole point)
    const toolNames = extractToolNames(trace);
    const hasToolCalls = toolNames.length > 0;

    // Also save non-tool traces if they have substantial content
    // (these teach the model when NOT to use tools)
    const totalContent = trace.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    if (!hasToolCalls && totalContent < 200) return;

    const record = {
      id: `trace_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      timestamp: new Date().toISOString(),
      prompt_hash: hashPrompt(prompt),
      prompt,
      trace,
      metadata: {
        type: hasToolCalls ? "tool_use" : "direct_answer",
        tools_used: toolNames,
        num_tool_calls: toolNames.length,
        num_messages: trace.length,
        total_content_length: totalContent,
        duration_ms: durationMs || null,
        num_turns: numTurns || null,
        session_id: sessionId || null,
      },
    };

    appendFileSync(todayFile(), JSON.stringify(record) + "\n");

    console.log(
      `[Forge ToolCollector] Trace ${record.id} saved — ` +
      `${trace.length} messages, ${toolNames.length} tool calls` +
      (toolNames.length > 0 ? ` (${toolNames.slice(0, 3).join(", ")}${toolNames.length > 3 ? "..." : ""})` : "")
    );
  }

  get inflight() {
    return this._inflight;
  }
}

export { parseStreamEvents, eventsToTrace, extractToolNames };
export default ToolCollector;
