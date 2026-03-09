#!/usr/bin/env bun

// Task Runner — Long-running task continuation with RAG persistence
//
// Wraps invokeClaude in a continuation loop. When Claude hits maxTurns
// or times out, saves progress and automatically spawns a new session
// to continue. Stores task state in brain/tasks/ (immediate) and
// completed summaries in memory/tasks/ (RAG-ingestible).
//
// Usage:
//   import { runLongTask } from "./task-runner.mjs";
//   const result = await runLongTask({ prompt, systemPrompt, claudeOpts, session, limiter, onProgress });

import { invokeClaude } from "./shared-invoke.mjs";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "fs";
import { resolve } from "path";

const PROJECT_DIR = resolve(import.meta.dirname, "..");
const TASKS_DIR = resolve(PROJECT_DIR, "brain", "tasks");
const MEMORY_TASKS_DIR = resolve(PROJECT_DIR, "memory", "tasks");

mkdirSync(TASKS_DIR, { recursive: true });
mkdirSync(MEMORY_TASKS_DIR, { recursive: true });

// Max number of continuation rounds before giving up
const MAX_CONTINUATIONS = 10;

// ── Task State Persistence ──────────────────────────────────────────────────

function generateTaskId() {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function saveTaskState(taskId, state) {
  writeFileSync(resolve(TASKS_DIR, `${taskId}.json`), JSON.stringify(state, null, 2));
}

function loadTaskState(taskId) {
  const path = resolve(TASKS_DIR, `${taskId}.json`);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/**
 * Find the most recent interrupted task for a session key.
 * Returns the task state or null.
 */
export function findInterruptedTask(sessionKey) {
  try {
    const files = readdirSync(TASKS_DIR).filter(f => f.endsWith(".json")).sort().reverse();
    for (const f of files) {
      const state = loadTaskState(f.replace(".json", ""));
      if (!state) continue;
      if (state.sessionKey === sessionKey && (state.status === "continuing" || state.status === "running")) {
        return state;
      }
    }
  } catch {}
  return null;
}

/**
 * List all tasks, optionally filtered by status.
 */
export function listTasks(status) {
  try {
    const files = readdirSync(TASKS_DIR).filter(f => f.endsWith(".json")).sort().reverse();
    const tasks = [];
    for (const f of files) {
      const state = loadTaskState(f.replace(".json", ""));
      if (!state) continue;
      if (status && state.status !== status) continue;
      tasks.push(state);
    }
    return tasks;
  } catch { return []; }
}

/**
 * Save a completed task summary as markdown for RAG ingestion.
 * Files in memory/tasks/ are picked up by the RAG ingest pipeline.
 */
function saveTaskSummary(taskId, prompt, result, meta) {
  const md = [
    `# Task: ${prompt.slice(0, 120)}`,
    ``,
    `- **Date**: ${new Date().toISOString()}`,
    `- **Continuations**: ${meta.continuations}`,
    `- **Total turns**: ${meta.totalTurns}`,
    `- **Cost**: $${(meta.totalCost || 0).toFixed(4)}`,
    ``,
    `## Result`,
    ``,
    result,
    ``,
  ].join("\n");
  writeFileSync(resolve(MEMORY_TASKS_DIR, `${taskId}.md`), md);
}

// ── RAG Context for Continuations ───────────────────────────────────────────

let _ragSearch = null;

async function getRagContext(query) {
  try {
    if (!_ragSearch) {
      const rag = await import("../brain/rag/index.mjs");
      _ragSearch = rag.search;
    }
    const results = await _ragSearch(query, 3, { minScore: 0.4 });
    if (results.length === 0) return "";
    return `\n## Relevant Knowledge\n${results.map(r => r.text.slice(0, 400)).join("\n---\n")}\n`;
  } catch {
    return "";
  }
}

// ── Continuation Prompt Builder ─────────────────────────────────────────────

async function buildContinuationPrompt(originalPrompt, progressSoFar, wasTimeout) {
  const ragContext = await getRagContext(originalPrompt);

  return [
    `You are continuing a task that was ${wasTimeout ? "interrupted by a timeout" : "cut short by a turn limit"}.`,
    `Pick up exactly where you left off. Do NOT repeat work already completed.`,
    ``,
    `## Original Request`,
    originalPrompt,
    ``,
    `## Progress So Far`,
    progressSoFar || "(Previous attempt was interrupted before producing output — start from the beginning)",
    ragContext,
    `## Instructions`,
    `Continue working from where you stopped. If everything in the original request is already done, just confirm completion with a summary.`,
  ].join("\n");
}

// ── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Run a long task with automatic continuation on maxTurns/timeout.
 *
 * @param {object} opts
 * @param {string} opts.prompt         - The user's original request
 * @param {string} opts.systemPrompt   - System prompt for fresh sessions
 * @param {object} opts.claudeOpts     - Base options for invokeClaude (without prompt/systemPrompt/resumeSession)
 * @param {object} opts.session        - Gateway session object (has .claudeSessionId)
 * @param {object} opts.limiter        - Semaphore for concurrency
 * @param {string} opts.sessionKey     - Session identifier for task state persistence
 * @param {function} opts.onProgress   - Called with progress messages between continuations
 * @param {string} [opts.resumeTaskId] - Resume a previously interrupted task
 *
 * @returns {{ text: string, taskId: string, continuations: number, totalCost: number, totalTurns: number }}
 */
export async function runLongTask({ prompt, systemPrompt, claudeOpts, session, limiter, sessionKey, onProgress, resumeTaskId }) {
  // If resuming an interrupted task, load its state
  let taskId, continuation, fullResult, totalCost, totalTurns;

  if (resumeTaskId) {
    const prev = loadTaskState(resumeTaskId);
    if (prev && prev.progress) {
      taskId = resumeTaskId;
      continuation = prev.continuations || 0;
      fullResult = prev.progress || "";
      totalCost = prev.totalCost || 0;
      totalTurns = prev.totalTurns || 0;
      prompt = prev.prompt || prompt;
      console.log(`[task] resuming ${taskId} from continuation ${continuation}`);
    }
  }

  if (!taskId) {
    taskId = generateTaskId();
    continuation = 0;
    fullResult = "";
    totalCost = 0;
    totalTurns = 0;
  }

  let lastSessionId = session?.claudeSessionId || null;

  // Save initial state
  saveTaskState(taskId, {
    id: taskId,
    prompt,
    status: "running",
    sessionKey,
    startedAt: new Date().toISOString(),
    continuations: continuation,
    totalTurns,
    totalCost,
  });

  while (continuation <= MAX_CONTINUATIONS) {
    let result;
    let timedOut = false;

    try {
      if (continuation === 0 && !lastSessionId) {
        // First attempt — fresh session
        result = await invokeClaude({
          ...claudeOpts,
          prompt,
          systemPrompt,
        }, limiter);

      } else if (lastSessionId) {
        // Resume existing Claude session
        try {
          result = await invokeClaude({
            ...claudeOpts,
            prompt: continuation === 0
              ? prompt
              : "Continue where you left off. Don't repeat completed work.",
            resumeSession: lastSessionId,
          }, limiter);
        } catch (resumeErr) {
          // Session expired or invalid — clear stale ID from both local and gateway
          console.log(`[task] session resume failed: ${resumeErr.message}`);
          lastSessionId = null;
          if (session) session.claudeSessionId = null;

          // Start fresh with context — wrapped in its own try/catch so failures
          // don't bubble to the outer catch as ambiguous timeout errors
          let freshPrompt;
          if (continuation === 0 && session?.messages?.length > 1) {
            // Simple follow-up (not a continuation) — inject recent chat history
            const recent = session.messages.slice(-6, -1); // last few messages, excluding current
            const historyBlock = recent.map(m => `${m.role}: ${m.content}`).join("\n");
            freshPrompt = `## Recent conversation\n${historyBlock}\n\n## Current message\n${prompt}`;
          } else {
            freshPrompt = await buildContinuationPrompt(prompt, fullResult, false);
          }

          try {
            result = await invokeClaude({
              ...claudeOpts,
              prompt: freshPrompt,
              systemPrompt,
            }, limiter);
          } catch (freshErr) {
            // Fresh session also failed — let outer catch handle it,
            // but session ID is already cleared so retry won't hit resume again
            throw freshErr;
          }
        }

      } else {
        // No session (after timeout or fresh continuation) — build context prompt
        const contPrompt = await buildContinuationPrompt(prompt, fullResult, timedOut);
        result = await invokeClaude({
          ...claudeOpts,
          prompt: contPrompt,
          systemPrompt,
        }, limiter);
      }

    } catch (err) {
      if (err.message?.includes("Timed out")) {
        timedOut = true;
        lastSessionId = null; // Process killed, no session to resume

        console.log(`[task] ${taskId} timed out on continuation ${continuation}, retrying...`);
        onProgress?.(`Still working on your request... (chunk ${continuation + 1} timed out, continuing)`);

        // Save checkpoint
        saveTaskState(taskId, {
          id: taskId,
          prompt,
          status: "continuing",
          sessionKey,
          continuations: continuation + 1,
          progress: fullResult.slice(-4000), // Keep recent progress for context
          totalTurns,
          totalCost,
          lastError: "timeout",
          updatedAt: new Date().toISOString(),
        });

        continuation++;
        continue;
      }

      // Fatal error — save state and throw
      saveTaskState(taskId, {
        id: taskId,
        prompt,
        status: "error",
        sessionKey,
        error: err.message,
        continuations: continuation,
        progress: fullResult.slice(-4000),
        totalTurns,
        totalCost,
        updatedAt: new Date().toISOString(),
      });
      throw err;
    }

    // Got a result — update tracking
    lastSessionId = result.session_id;
    if (session) session.claudeSessionId = lastSessionId;

    const text = typeof result.result === "string" ? result.result : JSON.stringify(result.result);
    // Only append non-empty text — hitMaxTurns responses have empty result
    if (text && text.trim()) {
      fullResult += (fullResult ? "\n\n" : "") + text;
    }
    totalCost += result.cost_usd || 0;
    totalTurns += result.num_turns || 0;

    console.log(`[task] ${taskId} cont=${continuation} turns=${result.num_turns}/${claudeOpts.maxTurns} cost=$${(result.cost_usd || 0).toFixed(4)}`);

    // Did Claude finish naturally? (used fewer turns than max)
    if (!result.num_turns || result.num_turns < claudeOpts.maxTurns) {
      // Task completed
      saveTaskState(taskId, {
        id: taskId,
        prompt,
        status: "completed",
        sessionKey,
        continuations: continuation,
        totalTurns,
        totalCost,
        completedAt: new Date().toISOString(),
      });

      // Save summary for RAG ingestion
      saveTaskSummary(taskId, prompt, fullResult, { continuations: continuation, totalTurns, totalCost });

      return { text: fullResult, taskId, continuations: continuation, totalCost, totalTurns };
    }

    // Hit maxTurns — need to continue
    console.log(`[task] ${taskId} hit maxTurns (${result.num_turns}/${claudeOpts.maxTurns}), continuing (${continuation + 1}/${MAX_CONTINUATIONS})`);
    onProgress?.(`Making progress on your request... (part ${continuation + 1} complete)`);

    // Save checkpoint
    saveTaskState(taskId, {
      id: taskId,
      prompt,
      status: "continuing",
      sessionKey,
      continuations: continuation + 1,
      progress: fullResult.slice(-4000),
      totalTurns,
      totalCost,
      updatedAt: new Date().toISOString(),
    });

    continuation++;
  }

  // Hit max continuations — still return what we have
  saveTaskState(taskId, {
    id: taskId,
    prompt,
    status: "max_continuations",
    sessionKey,
    continuations: continuation,
    totalTurns,
    totalCost,
    completedAt: new Date().toISOString(),
  });
  saveTaskSummary(taskId, prompt, fullResult, { continuations: continuation, totalTurns, totalCost });

  return {
    text: fullResult + "\n\n(This was a very long task — reached the continuation limit. Say 'continue' if there's more to do.)",
    taskId,
    continuations: continuation,
    totalCost,
    totalTurns,
  };
}
