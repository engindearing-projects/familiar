#!/usr/bin/env bun

// Hand Runner — executes a hand's phases sequentially
//
// Each phase gets a system prompt derived from the hand's manifest
// and the phase prompt. The runner tracks timing, errors, and metrics.
//
// Usage:
//   import { runHand } from "./runner.mjs";
//   const result = await runHand(registry, "forge-miner");
//
// CLI:
//   bun brain/hands/runner.mjs <hand-name> [--dry-run]

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { HandRegistry } from "./registry.mjs";

const PROJECT_DIR = resolve(import.meta.dir, "../..");
const BRAIN_DIR = resolve(import.meta.dir, "..");
const TRAINER_DIR = resolve(PROJECT_DIR, "trainer");
const OLLAMA_URL = "http://localhost:11434";
const CLAUDE_PROXY_URL = "http://localhost:18791/v1";
const BRAIN_MODEL = "familiar-brain:latest";
const HOME_DIR = process.env.HOME || "/tmp";

/**
 * Expand template variables in a string.
 * Replaces {{PROJECT_DIR}}, {{BRAIN_DIR}}, {{TRAINER_DIR}}, {{HOME}} with runtime values.
 */
function expandVars(str) {
  if (typeof str !== "string") return str;
  return str
    .replaceAll("{{PROJECT_DIR}}", PROJECT_DIR)
    .replaceAll("{{BRAIN_DIR}}", BRAIN_DIR)
    .replaceAll("{{TRAINER_DIR}}", TRAINER_DIR)
    .replaceAll("{{HOME}}", HOME_DIR);
}

/**
 * Recursively expand template variables in an object/array/string.
 */
function expandManifestVars(obj) {
  if (typeof obj === "string") return expandVars(obj);
  if (Array.isArray(obj)) return obj.map(expandManifestVars);
  if (obj && typeof obj === "object") {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = expandManifestVars(v);
    }
    return result;
  }
  return obj;
}

// Load env for Telegram notifications + Gemini API
let botToken = null;
let chatId = null;
let geminiApiKey = null;
try {
  const envFile = resolve(PROJECT_DIR, "config/.env");
  if (existsSync(envFile)) {
    const envContent = readFileSync(envFile, "utf-8");
    for (const line of envContent.split("\n")) {
      const [key, ...rest] = line.split("=");
      const val = rest.join("=").trim().replace(/^["']|["']$/g, "");
      if (key.trim() === "TELEGRAM_BOT_TOKEN") botToken = val;
      if (key.trim() === "TELEGRAM_CHAT_ID") chatId = val;
      if (key.trim() === "GEMINI_API_KEY") geminiApiKey = val;
    }
  }
} catch { /* env not available */ }

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Hands that face other people (Slack, Jira, external comms, autonomous decisions).
// Routing: Claude → Gemini → trained model (only with explicit user approval).
// Internal hands (forge-miner, trainer, learner, researcher) use Gemini → Ollama freely.
const EXTERNAL_FACING_HANDS = new Set(["planner", "anthropic-admin", "email-drafter", "linkedin-poster"]);

async function notify(text) {
  if (!botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch { /* best effort */ }
}

/**
 * Check if the planner's decide result contains an approve-tier action.
 * If so, create a work item and send a Telegram approval request.
 * Returns true if the act phase should be blocked (awaiting approval).
 */
async function checkPlannerApproval(handName, decideResult) {
  try {
    // Parse the decision — look for approvalTier in the result text
    const tierMatch = decideResult.match(/"approvalTier"\s*:\s*"(\w+)"/);
    const tier = tierMatch?.[1];
    if (tier !== "approve") return false;

    // Extract action details from the decision
    const actionMatch = decideResult.match(/"action"\s*:\s*"([^"]+)"/);
    const typeMatch = decideResult.match(/"type"\s*:\s*"([^"]+)"/);
    const reasonMatch = decideResult.match(/"reason"\s*:\s*"([^"]+)"/);
    const riskMatch = decideResult.match(/"risk"\s*:\s*"([^"]+)"/);

    const action = actionMatch?.[1] || "unknown action";
    const type = typeMatch?.[1] || "unknown";
    const reason = reasonMatch?.[1] || "";
    const risk = riskMatch?.[1] || "high";

    // Create a work item in the daemon's queue
    const { createWorkItem, updateWorkItem } = await import("../../shared/work-queue.js");
    const itemId = createWorkItem({
      trigger_type: `planner.${type}`,
      prompt: `Planner wants to: ${action}`,
      risk_level: risk,
    });

    updateWorkItem(itemId, {
      status: "proposed",
      proposed_action: action,
      findings: reason,
      risk_level: risk,
    });

    // Send Telegram approval request
    try {
      const { sendApprovalRequest } = await import("../../services/daemon-telegram.mjs");
      const { message_id, chat_id } = await sendApprovalRequest(itemId, {
        trigger: `Planner (${type})`,
        action,
        findings: reason,
        risk,
      });

      updateWorkItem(itemId, {
        approval_msg_id: message_id,
        approval_chat_id: chat_id,
      });

      console.log(`[hand:${handName}]   Approval request sent to Telegram [${itemId.slice(0, 8)}]`);
    } catch (e) {
      // Telegram not available — still block, user can approve via CLI
      console.log(`[hand:${handName}]   Telegram unavailable (${e.message}), action deferred`);
    }

    return true; // block the act phase
  } catch (e) {
    console.log(`[hand:${handName}]   Approval check failed: ${e.message}`);
    return false; // don't block on errors — let the act phase run
  }
}

// ── LLM Providers ──────────────────────────────────────────────────────────
//
// Routing table:
//   External-facing (planner):
//     Chat:    Claude → Gemini → abort (trained model needs approval)
//     Agentic: Claude → abort + notify (trained model needs approval)
//
//   Internal (forge-miner, trainer, learner, researcher):
//     Chat:    Gemini → Ollama
//     Agentic: Claude → Ollama
//

async function chatOllama(systemPrompt, userPrompt, timeout = 90000) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: BRAIN_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      stream: false,
      options: { num_predict: 4096, temperature: 0.5 },
    }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const data = await res.json();
  return data.message?.content || "";
}

async function chatClaude(systemPrompt, userPrompt, timeout = 120000) {
  // Use /invoke directly — bypasses MCP tool loading, training dual-send,
  // and session management that /v1/chat/completions does. Much faster
  // for simple chat phases that just need a single-turn response.
  // Always use Opus for external-facing content sent as Grant.
  const res = await fetch(`http://127.0.0.1:18791/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: userPrompt,
      systemPrompt,
      model: "opus",
      maxTurns: 1,
      timeoutMs: timeout,
      outputFormat: "json",
    }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Claude proxy error: ${res.status}`);
  }
  const data = await res.json();
  if (!data.success) throw new Error(data.error || "Claude invocation failed");
  return typeof data.result === "string" ? data.result : JSON.stringify(data.result);
}

async function chatGemini(systemPrompt, userPrompt, timeout = 90000) {
  if (!geminiApiKey) throw new Error("Gemini API key not set");
  const res = await fetch(`${GEMINI_URL}?key=${geminiApiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userPrompt }] }],
      generationConfig: { maxOutputTokens: 4096, temperature: 0.5 },
    }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`Gemini error: ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

/**
 * Chat routing — internal hands (forge-miner, trainer, learner, researcher).
 * Gemini → Ollama. These don't face other people so local model is fine.
 */
async function chatInternal(systemPrompt, userPrompt, timeout = 90000) {
  try {
    return await chatGemini(systemPrompt, userPrompt, timeout);
  } catch {
    return chatOllama(systemPrompt, userPrompt, timeout);
  }
}

/**
 * Request Telegram approval before sending Gemini-generated external content.
 * Sends the draft to Grant, waits up to 5 minutes for a reply.
 * Returns true if approved (reply contains "y", "yes", "ok", "send", "approve").
 * Returns false on timeout, rejection, or Telegram failure.
 */
async function requestGeminiFallbackApproval(handName, draft) {
  if (!botToken || !chatId) {
    console.log(`[router] Telegram not configured — cannot request Gemini fallback approval`);
    return false;
  }

  const preview = typeof draft === "string" ? draft.slice(0, 1500) : JSON.stringify(draft).slice(0, 1500);
  const msg = [
    `⚠️ [${handName}] Claude Opus unavailable — Gemini drafted this instead.`,
    ``,
    `--- DRAFT ---`,
    preview,
    `--- END ---`,
    ``,
    `Reply YES to approve sending, or NO to discard.`,
  ].join("\n");

  try {
    // Send the approval request
    const sendRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: msg.slice(0, 4000),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!sendRes.ok) throw new Error(`Telegram send failed: ${sendRes.status}`);
    const sentMsg = await sendRes.json();
    const sentMsgId = sentMsg.result?.message_id;

    console.log(`[router] Gemini fallback approval requested via Telegram (msg ${sentMsgId})`);

    // Poll for a reply — check every 15s for up to 5 minutes
    const deadline = Date.now() + 300_000;
    let lastUpdateId = 0;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 15000));

      const pollRes = await fetch(
        `https://api.telegram.org/bot${botToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=5&allowed_updates=["message"]`,
        { signal: AbortSignal.timeout(15000) }
      );
      if (!pollRes.ok) continue;
      const updates = await pollRes.json();

      for (const update of updates.result || []) {
        lastUpdateId = Math.max(lastUpdateId, update.update_id);
        const reply = update.message;
        if (!reply?.text || String(reply.chat?.id) !== String(chatId)) continue;
        // Check if this is a reply to our approval message, or any message after it
        if (reply.message_id > sentMsgId) {
          const answer = reply.text.trim().toLowerCase();
          if (/^(y|yes|ok|send|approve|go|ship)$/i.test(answer)) {
            console.log(`[router] Gemini fallback APPROVED by Grant`);
            return true;
          }
          if (/^(n|no|nope|reject|discard|cancel|stop)$/i.test(answer)) {
            console.log(`[router] Gemini fallback REJECTED by Grant`);
            return false;
          }
          // Unrelated message — keep polling
        }
      }
    }

    console.log(`[router] Gemini fallback approval timed out (5 min)`);
    await notify(`[${handName}] Gemini fallback approval timed out — draft discarded.`);
    return false;
  } catch (e) {
    console.log(`[router] Telegram approval error: ${e.message}`);
    return false;
  }
}

/**
 * Chat routing — external-facing hands (planner, anything that touches coworkers).
 * Claude Opus → Gemini (with Telegram approval) → abort.
 */
async function chatExternal(systemPrompt, userPrompt, timeout = 90000) {
  // Try Claude Opus first — required for content sent as Grant
  try {
    return await chatClaude(systemPrompt, userPrompt, timeout);
  } catch (e) {
    console.log(`[router] Claude Opus unavailable (${e.message}), trying Gemini with approval gate`);
  }
  // Gemini second — but requires Grant's approval before sending
  try {
    const draft = await chatGemini(systemPrompt, userPrompt, timeout);
    // External-facing: ping Grant on Telegram before using Gemini output
    const approved = await requestGeminiFallbackApproval("chat", draft);
    if (!approved) {
      throw new Error("Gemini fallback rejected or timed out — content not approved for sending");
    }
    return draft;
  } catch (e) {
    if (e.message.includes("rejected or timed out")) throw e;
    console.log(`[router] Gemini unavailable (${e.message})`);
  }
  throw new Error("Claude Opus and Gemini both unavailable — cannot generate external-facing content");
}

// ── Phase Executor ─────────────────────────────────────────────────────────

function buildPhaseSystemPrompt(hand, phase, context) {
  return [
    `You are Familiar, an autonomous AI assistant running the "${hand.manifest.name}" hand.`,
    hand.manifest.description,
    "",
    `Current phase: ${phase.name}`,
    "",
    context.checkpoint ? `Previous checkpoint: ${JSON.stringify(context.checkpoint)}` : "",
    context.previousPhases.length > 0
      ? `Previous phase results:\n${context.previousPhases.map(p => `[${p.name}]: ${p.result?.slice(0, 4000) || "no output"}`).join("\n")}`
      : "",
  ].filter(Boolean).join("\n");
}

async function executePhase(hand, phase, context) {
  const startTime = Date.now();
  const timeoutMs = (phase.timeout || 300) * 1000;
  const mode = phase.mode || "chat";

  const systemPrompt = buildPhaseSystemPrompt(hand, phase, context);

  // Agentic mode — full tool loop with file I/O, bash, etc.
  if (mode === "agentic") {
    return executeAgenticPhase(hand, phase, systemPrompt, timeoutMs);
  }

  // Chat mode — single LLM call, no tools
  // External-facing hands → Claude → Gemini → abort (trained model needs approval)
  // Internal hands → Gemini → Ollama (cheap, no user exposure)
  const isExternal = EXTERNAL_FACING_HANDS.has(hand.manifest.name);
  const chatFn = isExternal ? chatExternal : chatInternal;
  try {
    const result = await chatFn(systemPrompt, phase.prompt, timeoutMs);
    return {
      name: phase.name,
      status: "ok",
      result,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: phase.name,
      status: "error",
      error: err.message,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Agentic phase — routing depends on hand type:
 *
 *   External-facing (planner): Claude → Gemini tool-loop → abort.
 *   Internal (forge-miner, trainer, learner, researcher):
 *     Claude → Gemini tool-loop → local Ollama fallback.
 */
async function executeAgenticPhase(hand, phase, systemPrompt, timeoutMs) {
  const startTime = Date.now();
  const handName = hand.manifest.name;
  const isExternal = EXTERNAL_FACING_HANDS.has(handName);

  // Try Claude first — best at agentic tool use
  try {
    const result = await executeAgenticClaude(hand, phase, systemPrompt, timeoutMs);
    if (result.status === "ok") return result;
    console.log(`[hand:${handName}]   Claude agentic failed (${result.error})`);
  } catch (err) {
    console.log(`[hand:${handName}]   Claude error (${err.message})`);
  }

  // Try Gemini tool-loop — for external hands, requires Telegram approval before using output
  console.log(`[hand:${handName}]   Falling back to Gemini tool loop`);
  try {
    const result = await executeAgenticGemini(hand, phase, systemPrompt, timeoutMs);
    if (result.status === "ok") {
      if (isExternal) {
        // Gate: ping Grant on Telegram before using Gemini output for external-facing content
        console.log(`[hand:${handName}]   Gemini produced output — requesting approval before use`);
        const approved = await requestGeminiFallbackApproval(handName, result.result);
        if (!approved) {
          console.log(`[hand:${handName}]   Gemini output rejected — discarding`);
          return {
            name: phase.name,
            status: "error",
            error: "Gemini fallback rejected or timed out — content not approved",
            duration: Date.now() - startTime,
          };
        }
        console.log(`[hand:${handName}]   Gemini output approved by Grant`);
      }
      return result;
    }
    console.log(`[hand:${handName}]   Gemini agentic failed (${result.error})`);
  } catch (err) {
    console.log(`[hand:${handName}]   Gemini error (${err.message})`);
  }

  // External-facing hands: don't silently fall back to trained model
  if (isExternal) {
    const msg = `Claude Opus and Gemini both unavailable for ${handName} (external-facing).`;
    console.log(`[hand:${handName}]   ${msg}`);
    await notify(`[${handName}] ${msg}`);
    return {
      name: phase.name,
      status: "error",
      error: msg,
      duration: Date.now() - startTime,
    };
  }

  // Internal hands fall back to local tool loop (Ollama) freely
  console.log(`[hand:${handName}]   Falling back to local tool loop`);
  return executeAgenticLocal(hand, phase, systemPrompt, timeoutMs);
}

/** Agentic via Claude — spawns `claude -p` subprocess */
async function executeAgenticClaude(hand, phase, systemPrompt, timeoutMs) {
  const startTime = Date.now();
  const handName = hand.manifest.name;

  try {
    const fullPrompt = [
      systemPrompt,
      "",
      "--- TASK ---",
      phase.prompt,
    ].join("\n");

    // If phase requests long-task mode, use task-runner for auto-continuation
    if (phase.longTask) {
      const { runLongTask } = await import("../../services/task-runner.mjs");
      const result = await runLongTask({
        prompt: fullPrompt,
        systemPrompt,
        claudeOpts: {
          model: "opus",
          workingDir: phase.cwd || PROJECT_DIR,
          maxTurns: phase.maxIterations || 15,
          timeoutMs,
          permissionMode: "bypassPermissions",
          outputFormat: "json",
          mcpConfig: resolve(PROJECT_DIR, "config/mcp-tools.json"),
        },
        sessionKey: `hand:${handName}:${phase.name}`,
      });

      const response = typeof result.text === "string" ? result.text
        : JSON.stringify(result.text).slice(0, 4000);

      return {
        name: phase.name,
        status: "ok",
        result: response,
        toolCalls: result.totalTurns || 0,
        iterations: result.totalTurns || 0,
        cost: result.totalCost || 0,
        continuations: result.continuations || 0,
        finishReason: "complete",
        duration: Date.now() - startTime,
      };
    }

    // Standard single-session invocation
    const { invokeClaude } = await import("../../services/shared-invoke.mjs");

    const result = await invokeClaude({
      prompt: fullPrompt,
      model: "opus",
      workingDir: phase.cwd || PROJECT_DIR,
      maxTurns: phase.maxIterations || 15,
      timeoutMs,
      permissionMode: "bypassPermissions",
      outputFormat: "json",
      mcpConfig: resolve(PROJECT_DIR, "config/mcp-tools.json"),
    });

    // invokeClaude returns { success, result, cost_usd, num_turns, session_id, model, hitMaxTurns }
    const response = typeof result.result === "string" ? result.result
      : JSON.stringify(result.result).slice(0, 4000);

    return {
      name: phase.name,
      status: "ok",
      result: response,
      toolCalls: result.num_turns || 0,
      iterations: result.num_turns || 0,
      cost: result.cost_usd || 0,
      finishReason: result.hitMaxTurns ? "max_turns" : "complete",
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: phase.name,
      status: "error",
      error: err.message,
      duration: Date.now() - startTime,
    };
  }
}

/** Agentic via Gemini tool loop — middle-tier fallback */
async function executeAgenticGemini(hand, phase, systemPrompt, timeoutMs) {
  const startTime = Date.now();

  try {
    const { runToolLoop } = await import("../../services/tool-loop.mjs");

    const result = await runToolLoop({
      prompt: phase.prompt,
      systemPrompt,
      backend: "gemini",
      temperature: 0.5,
      maxIterations: phase.maxIterations || 15,
      maxToolCalls: phase.maxToolCalls || 30,
      timeoutMs,
      cwd: phase.cwd || PROJECT_DIR,
    });

    return {
      name: phase.name,
      status: "ok",
      result: result.response || "",
      toolCalls: result.toolCalls?.length || 0,
      iterations: result.iterations || 0,
      finishReason: result.finishReason,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: phase.name,
      status: "error",
      error: err.message,
      duration: Date.now() - startTime,
    };
  }
}

/** Agentic via local Ollama tool loop */
async function executeAgenticLocal(hand, phase, systemPrompt, timeoutMs) {
  const startTime = Date.now();

  try {
    const { runToolLoop } = await import("../../services/tool-loop.mjs");

    const result = await runToolLoop({
      prompt: phase.prompt,
      systemPrompt,
      model: BRAIN_MODEL,
      temperature: 0.5,
      maxIterations: phase.maxIterations || 15,
      maxToolCalls: phase.maxToolCalls || 30,
      timeoutMs,
      cwd: phase.cwd || PROJECT_DIR,
    });

    return {
      name: phase.name,
      status: "ok",
      result: result.response || "",
      toolCalls: result.toolCalls?.length || 0,
      iterations: result.iterations || 0,
      finishReason: result.finishReason,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: phase.name,
      status: "error",
      error: err.message,
      duration: Date.now() - startTime,
    };
  }
}

// ── Hand Runner ────────────────────────────────────────────────────────────

/**
 * Run a hand's phases sequentially.
 *
 * @param {HandRegistry} registry
 * @param {string} name - Hand name
 * @param {object} opts
 * @param {boolean} opts.dryRun - Log but don't execute
 * @param {boolean} opts.notify - Send Telegram notification
 * @returns {Promise<{ok: boolean, phases: Array, duration: number, metrics: object}>}
 */
export async function runHand(registry, name, opts = {}) {
  const hand = registry.get(name);
  if (!hand) return { ok: false, error: `Hand "${name}" not found` };

  // Expand template variables in manifest ({{PROJECT_DIR}}, etc.)
  hand.manifest = expandManifestVars(hand.manifest);

  // Check guardrails
  if (hand.manifest.guardrails?.maxConcurrent === 1 && hand.status === "running") {
    return { ok: false, error: `Hand "${name}" is already running` };
  }

  if (hand.manifest.guardrails?.approvalRequired) {
    return { ok: false, error: `Hand "${name}" requires approval (not yet implemented)` };
  }

  const startTime = Date.now();
  registry.markRunning(name);

  console.log(`[hand:${name}] Starting (${hand.manifest.phases.length} phases)`);

  const context = {
    checkpoint: hand.checkpoint,
    previousPhases: [],
  };

  const phaseResults = [];
  let aborted = false;

  for (const phase of hand.manifest.phases) {
    if (aborted) break;

    console.log(`[hand:${name}] Phase: ${phase.name}`);

    if (opts.dryRun) {
      console.log(`[hand:${name}]   (dry run) Would execute: ${phase.prompt.slice(0, 100)}...`);
      phaseResults.push({ name: phase.name, status: "skipped", duration: 0 });
      continue;
    }

    // Planner optimizations: check decide result before running act phase
    if (name === "planner" && phase.name === "act") {
      const decideResult = context.previousPhases.find(p => p.name === "decide");
      if (decideResult?.result) {
        // Early exit: skip act phase entirely for "nothing" decisions
        const typeMatch = decideResult.result.match(/"type"\s*:\s*"(\w+)"/);
        if (typeMatch?.[1] === "nothing") {
          console.log(`[hand:${name}]   Skipping act phase — decide returned "nothing"`);
          phaseResults.push({ name: phase.name, status: "ok", duration: 0, result: "Skipped: no action needed" });
          context.previousPhases.push({ name: phase.name, result: "No action taken — system healthy" });
          continue;
        }

        // Approval gate: check if action needs explicit approval
        const shouldBlock = await checkPlannerApproval(name, decideResult.result);
        if (shouldBlock) {
          console.log(`[hand:${name}]   Phase "act" blocked — waiting for Telegram approval`);
          phaseResults.push({ name: phase.name, status: "ok", duration: 0, result: "Blocked: awaiting approval via Telegram" });
          context.previousPhases.push({ name: phase.name, result: "Action deferred — awaiting Telegram approval" });
          continue;
        }
      }
    }

    const result = await executePhase(hand, phase, context);
    phaseResults.push(result);

    if (result.status === "error") {
      const onFail = phase.onFail || "abort";
      console.log(`[hand:${name}]   Phase "${phase.name}" failed: ${result.error} (onFail: ${onFail})`);

      if (onFail === "abort") {
        aborted = true;
      } else if (onFail === "retry") {
        console.log(`[hand:${name}]   Retrying phase "${phase.name}"...`);
        const retry = await executePhase(hand, phase, context);
        phaseResults.push({ ...retry, name: `${phase.name} (retry)` });
        if (retry.status === "error") {
          aborted = true;
        } else {
          context.previousPhases.push(retry);
        }
      }
      // "skip" — just continue to next phase
    } else {
      context.previousPhases.push(result);

      // Save phase result as training data for Forge
      try {
        const { saveHandPhaseTrace } = await import("../goals/trace-collector.mjs");
        saveHandPhaseTrace(name, phase.name, phase.prompt, result.result || "");
      } catch { /* trace collection is best-effort */ }

      const parts = [];
      if (result.toolCalls) parts.push(`${result.toolCalls} turns`);
      if (result.cost) parts.push(`$${result.cost.toFixed(4)}`);
      const extra = parts.length > 0 ? `, ${parts.join(", ")}` : "";
      console.log(`[hand:${name}]   Phase "${phase.name}" complete (${result.duration}ms${extra})`);
    }
  }

  const duration = Date.now() - startTime;

  // Extract metrics from phase results if any phase returned JSON with a _metrics key
  const extractedMetrics = {};
  for (const pr of phaseResults) {
    if (!pr.result) continue;
    try {
      const match = pr.result.match(/\{[\s\S]*"_metrics"[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (parsed._metrics) Object.assign(extractedMetrics, parsed._metrics);
      }
    } catch { /* not JSON or no metrics */ }
  }

  // Record the run
  registry.recordRun(name, {
    duration,
    error: aborted ? phaseResults.find(p => p.status === "error")?.error : null,
    metrics: {
      run_duration: duration / 1000,
      ...extractedMetrics,
    },
    checkpoint: context.previousPhases.length > 0
      ? { lastPhase: context.previousPhases[context.previousPhases.length - 1].name, at: new Date().toISOString() }
      : hand.checkpoint,
  });

  const summary = {
    ok: !aborted,
    hand: name,
    phases: phaseResults.map(p => ({ name: p.name, status: p.status, duration: p.duration })),
    duration,
    metrics: extractedMetrics,
  };

  // Notify
  if (opts.notify !== false) {
    const statusEmoji = aborted ? "x" : "ok";
    const phaseSummary = phaseResults
      .map(p => `  ${p.status === "ok" ? "[ok]" : "[FAIL]"} ${p.name} (${(p.duration / 1000).toFixed(1)}s)`)
      .join("\n");

    await notify(
      `Hand: ${name} ${statusEmoji === "ok" ? "completed" : "failed"}\n` +
      `Duration: ${(duration / 1000).toFixed(1)}s\n` +
      `Phases:\n${phaseSummary}`
    );
  }

  console.log(`[hand:${name}] ${aborted ? "Aborted" : "Complete"} in ${(duration / 1000).toFixed(1)}s`);
  return summary;
}

// ── CLI Mode ───────────────────────────────────────────────────────────────

if (import.meta.main) {
  const handName = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");

  if (!handName) {
    const registry = new HandRegistry();
    registry.load();
    const hands = registry.list();

    if (hands.length === 0) {
      console.log("No hands installed. Create a HAND.json in brain/hands/<name>/");
    } else {
      console.log("Installed hands:\n");
      for (const h of hands) {
        const status = {
          active: "[ACTIVE]",
          inactive: "[ off  ]",
          paused: "[PAUSED]",
          running: "[ RUN  ]",
          error: "[ERROR ]",
        }[h.status] || `[${h.status}]`;

        console.log(`  ${status} ${h.name} — ${h.description}`);
        console.log(`         Schedule: ${h.schedule} | Runs: ${h.runCount} | Last: ${h.lastRun || "never"}`);
      }
    }
    process.exit(0);
  }

  const registry = new HandRegistry();
  registry.load();

  const result = await runHand(registry, handName, { dryRun, notify: !dryRun });
  if (!result.ok) {
    console.error(`Failed: ${result.error || "aborted"}`);
    process.exit(1);
  }
}
