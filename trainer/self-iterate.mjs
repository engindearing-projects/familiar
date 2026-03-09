#!/usr/bin/env bun

// The Forge — Self-Iteration Runner
// Runs familiar-coder through an agent-style loop:
//   1. Model generates code for a task
//   2. Runner executes tests
//   3. If tests fail → feeds errors back to model
//   4. Model fixes code → tests again
//   5. Repeat until tests pass or max iterations hit
//   6. Successful traces become training data for the next version
//
// This is the bootstrap loop — the model improves itself.
//
// Usage:
//   bun trainer/self-iterate.mjs                        # run all benchmarks
//   bun trainer/self-iterate.mjs --task py-fibonacci     # run one task
//   bun trainer/self-iterate.mjs --max-iters 5           # max retries
//   bun trainer/self-iterate.mjs --model hermes3:8b      # test another model

import { readFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { parseArgs } from "util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARKS_FILE = resolve(__dirname, "benchmarks", "coding-tasks.jsonl");
const TRACES_DIR = resolve(__dirname, "data", "traces");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const DEFAULT_MODEL = "familiar-coder:latest";
const DEFAULT_MAX_ITERS = 3;

if (!existsSync(TRACES_DIR)) {
  mkdirSync(TRACES_DIR, { recursive: true });
}

// ── CLI args ──────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    task: { type: "string" },
    model: { type: "string", default: DEFAULT_MODEL },
    "max-iters": { type: "string", default: String(DEFAULT_MAX_ITERS) },
    verbose: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
  strict: false,
});

const MODEL = args.model || DEFAULT_MODEL;
const MAX_ITERS = parseInt(args["max-iters"]) || DEFAULT_MAX_ITERS;
const VERBOSE = args.verbose || false;

// ── Load benchmark tasks ──────────────────────────────────────────────────

function loadTasks(taskId) {
  if (!existsSync(BENCHMARKS_FILE)) {
    console.error("Benchmark file not found:", BENCHMARKS_FILE);
    process.exit(1);
  }
  const lines = readFileSync(BENCHMARKS_FILE, "utf8").split("\n").filter(Boolean);
  const tasks = lines.map((l) => JSON.parse(l));

  if (taskId) {
    const filtered = tasks.filter((t) => t.id === taskId);
    if (filtered.length === 0) {
      console.error(`Task "${taskId}" not found. Available:`, tasks.map((t) => t.id).join(", "));
      process.exit(1);
    }
    return filtered;
  }

  // Only tasks with test_cases can self-iterate (need executable feedback)
  return tasks.filter((t) => t.test_cases && t.test_cases.length > 0);
}

// ── Ollama API ────────────────────────────────────────────────────────────

async function chat(messages, model = MODEL) {
  const start = Date.now();
  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: { temperature: 0.3 },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    throw new Error(`Ollama returned ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json();
  return {
    content: data.message?.content || "",
    durationMs: Date.now() - start,
    evalCount: data.eval_count || 0,
  };
}

// ── Code extraction & test execution ──────────────────────────────────────

function extractCode(response, language = "python") {
  // Extract code blocks, preferring language-tagged blocks
  const langTags = language === "javascript" || language === "js"
    ? /```(?:javascript|js|typescript|ts)\n([\s\S]*?)```/g
    : /```(?:python|py)\n([\s\S]*?)```/g;

  const tagged = response.match(langTags);
  const generic = response.match(/```\n([\s\S]*?)```/g);
  const blocks = tagged || generic;

  if (!blocks) return null;

  return blocks
    .map((b) => b.replace(/^```(?:\w+)?\n/, "").replace(/```$/, ""))
    .join("\n");
}

async function runTests(code, testCases, language = "python") {
  const results = [];
  let passed = 0;

  const runtime = language === "javascript" || language === "js"
    ? ["bun", "-e"]
    : ["python3", "-c"];

  for (const tc of testCases) {
    const fullCode = code + "\n" + tc.code;
    try {
      const proc = Bun.spawn([...runtime, fullCode], {
        stdout: "pipe",
        stderr: "pipe",
      });

      // Implement timeout manually
      const timeout = setTimeout(() => proc.kill(), 10_000);
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      clearTimeout(timeout);

      // Check last line of stdout — model code may print extra output before our test
      const lines = stdout.trim().split("\n");
      const output = lines[lines.length - 1]?.trim() || "";
      const expected = String(tc.expected || "").trim();
      const pass = exitCode === 0 && (!expected || output === expected);

      if (pass) passed++;

      results.push({
        code: tc.code,
        expected,
        actual: output,
        stderr: stderr.trim(),
        exitCode,
        pass,
      });
    } catch (err) {
      results.push({
        code: tc.code,
        expected: tc.expected || "",
        actual: "",
        stderr: err.message,
        exitCode: -1,
        pass: false,
      });
    }
  }

  return { results, passed, total: testCases.length, allPassed: passed === testCases.length };
}

function formatTestFeedback(testResults) {
  const failures = testResults.results.filter((r) => !r.pass);
  if (failures.length === 0) return null;

  let feedback = `${testResults.passed}/${testResults.total} tests passed. Here are the failures:\n\n`;

  for (const f of failures) {
    feedback += `Test: ${f.code}\n`;
    if (f.expected) feedback += `  Expected: ${f.expected}\n`;
    if (f.actual) feedback += `  Got:      ${f.actual}\n`;
    if (f.stderr) feedback += `  Error:    ${f.stderr.split("\n").slice(-3).join("\n  ")}\n`;
    feedback += "\n";
  }

  feedback += "Please fix your code and provide the COMPLETE corrected solution in a ```python code block. Include all functions and classes, not just the changed parts.";

  return feedback;
}

// ── Self-iteration loop ───────────────────────────────────────────────────

async function iterateOnTask(task) {
  const systemPrompt =
    "You are Engie, a familiar from familiar.run — an expert coding assistant. Write clean, correct code. " +
    "When given test failures, analyze the errors carefully and fix your code. " +
    "Always output your complete solution in a single fenced code block.";

  const messages = [{ role: "system", content: systemPrompt }];
  const trace = []; // full conversation for training data
  const timings = [];

  // Initial prompt
  messages.push({ role: "user", content: task.prompt });
  trace.push({ role: "user", content: task.prompt });

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    // Get model response
    const response = await chat(messages);
    timings.push(response.durationMs);

    messages.push({ role: "assistant", content: response.content });
    trace.push({ role: "assistant", content: response.content });

    // Extract code
    const code = extractCode(response.content, task.language);
    if (!code) {
      if (VERBOSE) console.log(`    iter ${iter + 1}: no code extracted`);
      // Ask model to try again with the original task
      const retry =
        "I need your solution as code I can execute. Please rewrite your complete solution " +
        "inside a ```python code block. Here's the original task again:\n\n" + task.prompt;
      messages.push({ role: "user", content: retry });
      trace.push({ role: "user", content: retry });
      continue;
    }

    // Run tests
    const testResults = await runTests(code, task.test_cases, task.language);

    if (testResults.allPassed) {
      if (VERBOSE) console.log(`    iter ${iter + 1}: ALL PASSED (${response.durationMs}ms)`);
      return {
        success: true,
        iterations: iter + 1,
        trace,
        code,
        testResults,
        timings,
        totalDurationMs: timings.reduce((a, b) => a + b, 0),
      };
    }

    if (VERBOSE) {
      console.log(`    iter ${iter + 1}: ${testResults.passed}/${testResults.total} passed (${response.durationMs}ms)`);
    }

    // Feed error feedback
    const feedback = formatTestFeedback(testResults);
    if (feedback && iter < MAX_ITERS - 1) {
      messages.push({ role: "user", content: feedback });
      trace.push({ role: "user", content: feedback });
    }
  }

  return {
    success: false,
    iterations: MAX_ITERS,
    trace,
    code: null,
    testResults: null,
    timings,
    totalDurationMs: timings.reduce((a, b) => a + b, 0),
  };
}

// ── Save successful traces ────────────────────────────────────────────────

function saveTrace(task, result) {
  const date = new Date().toISOString().slice(0, 10);
  const file = resolve(TRACES_DIR, `${date}-self-iterate.jsonl`);

  const record = {
    id: `si_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    timestamp: new Date().toISOString(),
    type: "self_iterate",
    task_id: task.id,
    category: task.category,
    language: task.language,
    success: result.success,
    iterations: result.iterations,
    model: MODEL,
    duration_ms: result.totalDurationMs,
    // Only save the winning trace (all iterations leading to success)
    trace: result.trace,
  };

  appendFileSync(file, JSON.stringify(record) + "\n");
  return record.id;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const tasks = loadTasks(args.task);
  console.log(`\n=== The Forge — Self-Iteration ===`);
  console.log(`  Model:      ${MODEL}`);
  console.log(`  Max iters:  ${MAX_ITERS}`);
  console.log(`  Tasks:      ${tasks.length}`);
  console.log();

  let totalPassed = 0;
  let totalFailed = 0;
  let totalIterations = 0;
  let totalDurationMs = 0;
  const improvements = []; // tasks that failed first try but passed after iteration

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    process.stdout.write(`  [${i + 1}/${tasks.length}] ${task.id}...`);

    try {
      const result = await iterateOnTask(task);
      totalIterations += result.iterations;
      totalDurationMs += result.totalDurationMs;

      if (result.success) {
        totalPassed++;
        const tag = result.iterations > 1 ? ` (fixed on iter ${result.iterations})` : "";
        console.log(` PASS${tag} (${Math.round(result.totalDurationMs / 1000)}s)`);

        if (result.iterations > 1) {
          improvements.push(task.id);
        }

        // Save successful traces
        if (!args["dry-run"]) {
          const id = saveTrace(task, result);
          if (VERBOSE) console.log(`    saved: ${id}`);
        }
      } else {
        totalFailed++;
        console.log(` FAIL after ${result.iterations} iters (${Math.round(result.totalDurationMs / 1000)}s)`);

        // Save failed traces too (useful for analyzing failure modes)
        if (!args["dry-run"]) {
          saveTrace(task, result);
        }
      }
    } catch (err) {
      totalFailed++;
      console.log(` ERROR: ${err.message}`);
    }
  }

  // Summary
  console.log(`\n=== Results ===`);
  console.log(`  Passed:       ${totalPassed}/${tasks.length} (${Math.round((totalPassed / tasks.length) * 100)}%)`);
  console.log(`  Failed:       ${totalFailed}/${tasks.length}`);
  console.log(`  Avg iters:    ${(totalIterations / tasks.length).toFixed(1)}`);
  console.log(`  Total time:   ${Math.round(totalDurationMs / 1000)}s`);

  if (improvements.length > 0) {
    console.log(`\n  Self-fixed (${improvements.length}): ${improvements.join(", ")}`);
    console.log(`  ^ These tasks failed initially but the model fixed its own code.`);
  }

  // Compare with single-shot (iteration 1 only)
  console.log(`\n  Single-shot pass rate: would need evaluate.py`);
  console.log(`  With iteration: ${totalPassed}/${tasks.length}`);
  console.log(`  Training traces saved to: ${TRACES_DIR}/`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
