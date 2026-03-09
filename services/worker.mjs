#!/usr/bin/env bun

// Familiar Worker Daemon — Ubuntu's brain
// HTTP server that runs hands, exchanges peer reflections, and reports health.
// Not a dumb task runner — it's a peer that can think.
//
// Usage:
//   bun services/worker.mjs
//   WORKER_PORT=18792 bun services/worker.mjs
//
// Endpoints:
//   POST /task/run          — run a hand, return task ID
//   GET  /task/status/:id   — check task status
//   GET  /health            — system health (GPU, Ollama, running tasks, disk)
//   POST /peer/reflect      — receive a reflection, respond with own perspective
//   POST /peer/evaluate     — receive work to evaluate, return feedback
//   GET  /peer/feedback     — pull latest feedback/observations

import { resolve, dirname } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(__dirname, "..");
const PORT = parseInt(process.env.WORKER_PORT || "18792");

// Load auth token — prefer WORKER_AUTH_TOKEN for peer communication,
// fall back to gateway tokens for backward compat
let AUTH_TOKEN = process.env.WORKER_AUTH_TOKEN || "";
try {
  const envFile = resolve(PROJECT_DIR, "config/.env");
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf-8").split("\n")) {
      const [key, ...rest] = line.split("=");
      const val = rest.join("=").trim().replace(/^["']|["']$/g, "");
      if (key.trim() === "WORKER_AUTH_TOKEN" && !AUTH_TOKEN) AUTH_TOKEN = val;
      if (key.trim() === "FAMILIAR_GATEWAY_TOKEN" && !AUTH_TOKEN) AUTH_TOKEN = val;
      if (key.trim() === "COZYTERM_GATEWAY_TOKEN" && !AUTH_TOKEN) AUTH_TOKEN = val;
    }
  }
} catch {}

// Mac activity server URL (for posting results back)
const MAC_ACTIVITY_URL = process.env.MAC_ACTIVITY_URL || "http://localhost:18790";

// ── Auth ─────────────────────────────────────────────────────────────────────

function checkAuth(req) {
  if (!AUTH_TOKEN) return true; // no token configured = open
  const header = req.headers.get("authorization") || "";
  return header === `Bearer ${AUTH_TOKEN}`;
}

function unauthorized() {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

// ── Task Management ──────────────────────────────────────────────────────────

const tasks = new Map(); // id → { hand, startTime, status, result, error }

async function runTask(taskId, handName) {
  try {
    // Dynamic import to avoid loading heavy modules at startup
    const { HandRegistry } = await import("../brain/hands/registry.mjs");
    const { runHand } = await import("../brain/hands/runner.mjs");

    const registry = new HandRegistry();
    registry.load();

    const manifest = registry.get(handName);
    if (!manifest) {
      tasks.get(taskId).status = "failed";
      tasks.get(taskId).error = `Hand "${handName}" not found`;
      return;
    }

    tasks.get(taskId).status = "running";

    const result = await runHand(registry, handName, { notify: true });

    const task = tasks.get(taskId);
    task.status = result.ok ? "completed" : "failed";
    task.result = result;
    task.endTime = Date.now();
    task.duration = task.endTime - task.startTime;

    // Post result to Mac activity server (best-effort)
    try {
      await fetch(`${MAC_ACTIVITY_URL}/activity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "hand_complete",
          source: "ubuntu-worker",
          hand: handName,
          ok: result.ok,
          duration: task.duration,
          timestamp: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {}

    // Sync state back to Mac (best-effort)
    try {
      const { execSync } = await import("child_process");
      execSync(`bash ${PROJECT_DIR}/services/sync-brain.sh pull-state`, {
        timeout: 30000,
        stdio: "ignore",
      });
    } catch {}

  } catch (err) {
    const task = tasks.get(taskId);
    task.status = "failed";
    task.error = err.message;
    task.endTime = Date.now();
  }
}

// ── Peer Reflection Storage ──────────────────────────────────────────────────

const REFLECTION_DIR = resolve(PROJECT_DIR, "brain/reflection");
const PEER_REFLECTIONS_FILE = resolve(REFLECTION_DIR, "peer-reflections.json");
const PEER_FEEDBACK_FILE = resolve(REFLECTION_DIR, "peer-feedback.json");

function ensureReflectionDir() {
  if (!existsSync(REFLECTION_DIR)) mkdirSync(REFLECTION_DIR, { recursive: true });
}

function loadPeerReflections() {
  try {
    return JSON.parse(readFileSync(PEER_REFLECTIONS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function savePeerReflections(reflections) {
  ensureReflectionDir();
  writeFileSync(PEER_REFLECTIONS_FILE, JSON.stringify(reflections, null, 2));
}

function loadPeerFeedback() {
  try {
    return JSON.parse(readFileSync(PEER_FEEDBACK_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function savePeerFeedback(feedback) {
  ensureReflectionDir();
  writeFileSync(PEER_FEEDBACK_FILE, JSON.stringify(feedback, null, 2));
}

// ── Health Check Helpers ─────────────────────────────────────────────────────

async function getSystemHealth() {
  const health = {
    hostname: (await import("os")).hostname(),
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    gpu: null,
    ollama: null,
    runningTasks: 0,
    disk: null,
  };

  // GPU status
  try {
    const { execSync } = await import("child_process");
    const gpu = execSync(
      "nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader",
      { timeout: 5000 }
    ).toString().trim();
    if (gpu) {
      const parts = gpu.split(", ");
      health.gpu = {
        name: parts[0],
        memoryUsed: parts[1],
        memoryTotal: parts[2],
        utilization: parts[3],
        temperature: parts[4],
      };
    }
  } catch {
    health.gpu = { error: "nvidia-smi unavailable" };
  }

  // Ollama status
  try {
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      health.ollama = {
        status: "ok",
        models: (data.models || []).map(m => m.name),
      };
    } else {
      health.ollama = { status: "error", code: res.status };
    }
  } catch {
    health.ollama = { status: "down" };
  }

  // Running tasks
  health.runningTasks = [...tasks.values()].filter(t => t.status === "running").length;

  // Disk usage
  try {
    const { execSync } = await import("child_process");
    const df = execSync("df -h / | tail -1", { timeout: 3000 }).toString().trim();
    const parts = df.split(/\s+/);
    health.disk = {
      total: parts[1],
      used: parts[2],
      available: parts[3],
      usedPercent: parts[4],
    };
  } catch {}

  return health;
}

// ── HTTP Server ──────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;

    // Health endpoint — no auth required
    if (url.pathname === "/health" && method === "GET") {
      const health = await getSystemHealth();
      return Response.json(health);
    }

    // All other endpoints require auth
    if (!checkAuth(req)) return unauthorized();

    // ── Task endpoints ─────────────────────────────────────────────────

    if (url.pathname === "/task/run" && method === "POST") {
      const body = await req.json();
      const { hand, params } = body;
      if (!hand) return Response.json({ error: "missing 'hand' field" }, { status: 400 });

      const taskId = randomUUID().slice(0, 8);
      tasks.set(taskId, {
        hand,
        startTime: Date.now(),
        status: "queued",
        result: null,
        error: null,
      });

      // Run async — don't await
      runTask(taskId, hand);

      return Response.json({ ok: true, taskId, hand });
    }

    if (url.pathname.startsWith("/task/status/") && method === "GET") {
      const taskId = url.pathname.split("/").pop();
      const task = tasks.get(taskId);
      if (!task) return Response.json({ error: "task not found" }, { status: 404 });
      return Response.json({
        taskId,
        hand: task.hand,
        status: task.status,
        duration: task.endTime ? task.endTime - task.startTime : Date.now() - task.startTime,
        error: task.error,
        result: task.status === "completed" ? { ok: task.result?.ok, duration: task.result?.duration } : null,
      });
    }

    if (url.pathname === "/task/list" && method === "GET") {
      const list = [...tasks.entries()].map(([id, t]) => ({
        taskId: id,
        hand: t.hand,
        status: t.status,
        startTime: new Date(t.startTime).toISOString(),
      }));
      return Response.json(list);
    }

    // ── Peer endpoints ─────────────────────────────────────────────────

    if (url.pathname === "/peer/reflect" && method === "POST") {
      const reflection = await req.json();
      reflection.receivedAt = new Date().toISOString();

      // Store incoming reflection
      const reflections = loadPeerReflections();
      reflections.push(reflection);
      // Keep last 50 reflections
      if (reflections.length > 50) reflections.splice(0, reflections.length - 50);
      savePeerReflections(reflections);

      // Respond with our own latest reflection + acknowledgment
      const ownFeedback = loadPeerFeedback();
      const latest = ownFeedback.length > 0 ? ownFeedback[ownFeedback.length - 1] : null;

      return Response.json({
        ok: true,
        received: reflection.from || "unknown",
        ownLatestReflection: latest,
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname === "/peer/evaluate" && method === "POST") {
      const work = await req.json();

      // Store evaluation request and return acknowledgment
      // The peer-sync hand will process these during its cycle
      const feedback = loadPeerFeedback();
      feedback.push({
        type: "evaluation_request",
        from: work.from || "unknown",
        work: work,
        receivedAt: new Date().toISOString(),
        evaluated: false,
      });
      if (feedback.length > 50) feedback.splice(0, feedback.length - 50);
      savePeerFeedback(feedback);

      return Response.json({
        ok: true,
        message: "evaluation queued, will be processed during next peer-sync cycle",
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname === "/peer/feedback" && method === "GET") {
      const feedback = loadPeerFeedback();
      // Return only evaluated feedback entries
      const evaluated = feedback.filter(f => f.evaluated || f.type === "feedback");
      return Response.json(evaluated);
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
});

// Clean up old completed tasks periodically (keep last 100)
setInterval(() => {
  if (tasks.size > 100) {
    const sorted = [...tasks.entries()]
      .filter(([, t]) => t.status !== "running" && t.status !== "queued")
      .sort((a, b) => a[1].startTime - b[1].startTime);
    const toRemove = sorted.slice(0, sorted.length - 50);
    for (const [id] of toRemove) tasks.delete(id);
  }
}, 300_000);

console.log(`[worker] Familiar Worker started on :${PORT}`);
console.log(`[worker] Auth: ${AUTH_TOKEN ? "enabled" : "disabled (no token)"}`);
console.log(`[worker] Mac activity URL: ${MAC_ACTIVITY_URL}`);
console.log(`[worker] Project: ${PROJECT_DIR}`);
