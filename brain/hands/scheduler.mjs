#!/usr/bin/env bun

// Hands Scheduler Daemon
// Watches active hands, evaluates cron expressions, and triggers runs.
// Replaces separate launchd services with a unified scheduling system.
//
// Usage:
//   bun brain/hands/scheduler.mjs              — run as daemon
//   bun brain/hands/scheduler.mjs --once       — single tick (check + run due hands, then exit)
//   bun brain/hands/scheduler.mjs --dry-run    — show what would run without executing
//
// Launchd: com.familiar.hands-scheduler (KeepAlive)

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { HandRegistry } from "./registry.mjs";
import { runHand } from "./runner.mjs";
import { EventBus, TriggerManager, exclusiveLock } from "./triggers.mjs";

const PROJECT_DIR = resolve(import.meta.dir, "../..");
const ONCE = process.argv.includes("--once");
const DRY_RUN = process.argv.includes("--dry-run");
const TICK_INTERVAL_MS = 60_000; // check every 60 seconds

// WORKER_HANDS filter — comma-separated list of hands this instance should run.
// If set, only listed hands are scheduled. If unset, all hands run (backward compatible).
// Mac: WORKER_HANDS=planner,learner,anthropic-admin,email-drafter,linkedin-poster,peer-sync
// Ubuntu: WORKER_HANDS=forge-trainer,forge-miner,researcher,repo-scout,peer-sync
const WORKER_HANDS = process.env.WORKER_HANDS
  ? new Set(process.env.WORKER_HANDS.split(",").map(s => s.trim()).filter(Boolean))
  : null;

// ── Cron Parser ────────────────────────────────────────────────────────────
// Supports standard 5-field cron: minute hour dayOfMonth month dayOfWeek
// Fields: * (any), N (exact), N,M (list), N-M (range), */N (step)

function parseCronField(field, min, max) {
  if (field === "*") return null; // matches any value

  const values = new Set();

  for (const part of field.split(",")) {
    // Step: */N or N-M/S
    const stepMatch = part.match(/^(\*|(\d+)-(\d+))\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[4]);
      const start = stepMatch[2] ? parseInt(stepMatch[2]) : min;
      const end = stepMatch[3] ? parseInt(stepMatch[3]) : max;
      for (let i = start; i <= end; i += step) values.add(i);
      continue;
    }

    // Range: N-M
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]);
      const end = parseInt(rangeMatch[2]);
      for (let i = start; i <= end; i++) values.add(i);
      continue;
    }

    // Exact: N
    const num = parseInt(part);
    if (!isNaN(num)) {
      values.add(num);
    }
  }

  return values.size > 0 ? values : null;
}

function parseCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  return {
    minute: parseCronField(parts[0], 0, 59),
    hour: parseCronField(parts[1], 0, 23),
    dayOfMonth: parseCronField(parts[2], 1, 31),
    month: parseCronField(parts[3], 1, 12),
    dayOfWeek: parseCronField(parts[4], 0, 6),
  };
}

function cronMatches(parsed, date) {
  if (!parsed) return false;

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay();

  if (parsed.minute && !parsed.minute.has(minute)) return false;
  if (parsed.hour && !parsed.hour.has(hour)) return false;
  if (parsed.dayOfMonth && !parsed.dayOfMonth.has(dayOfMonth)) return false;
  if (parsed.month && !parsed.month.has(month)) return false;
  if (parsed.dayOfWeek && !parsed.dayOfWeek.has(dayOfWeek)) return false;

  return true;
}

// ── Timezone ───────────────────────────────────────────────────────────────

function nowInTz(tz) {
  // Get current time in the specified timezone
  const str = new Date().toLocaleString("en-US", { timeZone: tz });
  return new Date(str);
}

// ── Telegram Notifications ─────────────────────────────────────────────────

let botToken = null;
let chatId = null;
try {
  const envFile = resolve(PROJECT_DIR, "config/.env");
  if (existsSync(envFile)) {
    const envContent = readFileSync(envFile, "utf-8");
    for (const line of envContent.split("\n")) {
      const [key, ...rest] = line.split("=");
      const val = rest.join("=").trim().replace(/^["']|["']$/g, "");
      if (key.trim() === "TELEGRAM_BOT_TOKEN") botToken = val;
      if (key.trim() === "TELEGRAM_CHAT_ID") chatId = val;
    }
  }
} catch {}

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
  } catch {}
}

// ── Scheduler ──────────────────────────────────────────────────────────────

// Track which hands we've already triggered this minute to avoid double-runs
const triggeredThisMinute = new Map(); // "handName:YYYY-MM-DD-HH:mm" → true

// Track currently running hands
const runningHands = new Set();

// Exclusive lock shared with triggers.mjs — blocks all other hands while GPU-heavy hands run
const exclusiveRunning = exclusiveLock.hands;

async function tick(registry, eventBus) {
  // Reload registry to pick up state changes from CLI/Telegram/gateway
  registry.load();

  const scheduled = registry.getScheduled();
  if (scheduled.length === 0) return;

  for (const hand of scheduled) {
    const tz = hand.tz || "America/Los_Angeles";
    const now = nowInTz(tz);
    const parsed = parseCron(hand.cron);

    if (!parsed) {
      console.error(`[scheduler] Invalid cron for ${hand.name}: ${hand.cron}`);
      continue;
    }

    if (!cronMatches(parsed, now)) continue;

    // WORKER_HANDS filter: skip hands not assigned to this instance
    if (WORKER_HANDS && !WORKER_HANDS.has(hand.name)) continue;

    // Dedup: don't trigger same hand twice in the same minute
    const minuteKey = `${hand.name}:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (triggeredThisMinute.has(minuteKey)) continue;
    triggeredThisMinute.set(minuteKey, true);

    // Don't run if already running
    if (runningHands.has(hand.name)) {
      console.log(`[scheduler] ${hand.name} — skipped (already running)`);
      continue;
    }

    // If an exclusive hand is running, skip all other hands
    if (exclusiveRunning.size > 0 && !exclusiveRunning.has(hand.name)) {
      console.log(`[scheduler] ${hand.name} — skipped (exclusive hand running: ${[...exclusiveRunning].join(", ")})`);
      continue;
    }

    // If this hand is exclusive, don't start if other hands are running
    const manifest = registry.get(hand.name);
    if (manifest?.guardrails?.exclusive && runningHands.size > 0) {
      console.log(`[scheduler] ${hand.name} — skipped (exclusive but other hands running: ${[...runningHands].join(", ")})`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`[scheduler] ${hand.name} — would run (cron: ${hand.cron}, tz: ${tz})`);
      continue;
    }

    // Launch the hand
    const isExclusive = manifest?.guardrails?.exclusive || false;
    console.log(`[scheduler] ${hand.name} — triggering (cron: ${hand.cron})${isExclusive ? " [exclusive]" : ""}`);
    runningHands.add(hand.name);
    if (isExclusive) exclusiveRunning.add(hand.name);

    // Run with timeout
    const timeoutMs = (hand.maxDuration || 3600) * 1000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    runHand(registry, hand.name, { notify: true })
      .then(result => {
        const status = result.ok ? "completed" : "failed";
        console.log(`[scheduler] ${hand.name} — ${status} (${(result.duration / 1000).toFixed(0)}s)`);

        // Emit hand.complete event so triggers can chain
        if (eventBus) {
          eventBus.emit("hand.complete", {
            hand: hand.name,
            ok: result.ok,
            duration: result.duration,
            triggeredBy: "schedule",
          });
        }
      })
      .catch(err => {
        console.error(`[scheduler] ${hand.name} — error: ${err.message}`);
        if (eventBus) {
          eventBus.emit("hand.error", { hand: hand.name, error: err.message, triggeredBy: "schedule" });
        }
      })
      .finally(() => {
        clearTimeout(timer);
        runningHands.delete(hand.name);
        exclusiveRunning.delete(hand.name);
      });
  }

  // Clean up old dedup entries (keep last 120 minutes)
  const cutoff = Date.now() - 120 * 60_000;
  for (const [key] of triggeredThisMinute) {
    // Keys are name:date strings — just limit map size
    if (triggeredThisMinute.size > 500) {
      triggeredThisMinute.delete(key);
    }
  }
}

// ── Workflow Scheduling ─────────────────────────────────────────────────────
// Loads workflow templates that have a trigger.cron field and runs them on schedule.

const runningWorkflows = new Set();
const triggeredWorkflowsThisMinute = new Map();

async function tickWorkflows() {
  let listWorkflows, loadWorkflow, executeWorkflow;
  try {
    const mod = await import("../workflows/engine.mjs");
    listWorkflows = mod.listWorkflows;
    loadWorkflow = mod.loadWorkflow;
    executeWorkflow = mod.executeWorkflow;
  } catch {
    return; // workflow engine not available
  }

  const workflows = listWorkflows();
  if (workflows.length === 0) return;

  for (const wf of workflows) {
    const loaded = loadWorkflow(wf.file);
    if (!loaded.ok) continue;

    const def = loaded.definition;
    if (!def.trigger || def.trigger.type !== "schedule" || !def.trigger.cron) continue;

    const tz = def.trigger.tz || "America/Los_Angeles";
    const now = nowInTz(tz);
    const parsed = parseCron(def.trigger.cron);
    if (!parsed || !cronMatches(parsed, now)) continue;

    // Dedup within same minute
    const minuteKey = `${def.name}:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (triggeredWorkflowsThisMinute.has(minuteKey)) continue;
    triggeredWorkflowsThisMinute.set(minuteKey, true);

    if (runningWorkflows.has(def.name)) {
      console.log(`[scheduler] workflow ${def.name} — skipped (already running)`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`[scheduler] workflow ${def.name} — would run (cron: ${def.trigger.cron}, tz: ${tz})`);
      continue;
    }

    console.log(`[scheduler] workflow ${def.name} — triggering (cron: ${def.trigger.cron})`);
    runningWorkflows.add(def.name);

    executeWorkflow(def, { dryRun: false })
      .then(result => {
        const status = result.ok ? "completed" : "failed";
        console.log(`[scheduler] workflow ${def.name} — ${status} (${(result.duration / 1000).toFixed(0)}s)`);
      })
      .catch(err => {
        console.error(`[scheduler] workflow ${def.name} — error: ${err.message}`);
      })
      .finally(() => {
        runningWorkflows.delete(def.name);
      });
  }

  // Clean up old dedup entries
  if (triggeredWorkflowsThisMinute.size > 200) {
    const keys = [...triggeredWorkflowsThisMinute.keys()];
    for (let i = 0; i < keys.length - 100; i++) {
      triggeredWorkflowsThisMinute.delete(keys[i]);
    }
  }
}

// ── Exports (for gateway integration) ───────────────────────────────────────

export { EventBus, TriggerManager };

// ── Main ───────────────────────────────────────────────────────────────────

const registry = new HandRegistry();
registry.load();

// Create event bus and trigger manager
const eventBus = new EventBus();
const triggerManager = new TriggerManager(eventBus, registry);
triggerManager.loadFromManifests();

const activeCount = registry.getScheduled().length;
const totalCount = registry.list().length;
const triggerCount = triggerManager.listTriggers().length;

// Count scheduled workflows
let workflowCount = 0;
try {
  const { listWorkflows, loadWorkflow } = await import("../workflows/engine.mjs");
  for (const wf of listWorkflows()) {
    const loaded = loadWorkflow(wf.file);
    if (loaded.ok && loaded.definition.trigger?.cron) workflowCount++;
  }
} catch { /* workflows module not available */ }

console.log(`[scheduler] Hands Scheduler started`);
console.log(`[scheduler] ${totalCount} hands loaded, ${activeCount} active with schedules, ${triggerCount} trigger(s), ${workflowCount} workflow(s)`);
if (WORKER_HANDS) {
  console.log(`[scheduler] WORKER_HANDS filter: ${[...WORKER_HANDS].join(", ")}`);
}

if (activeCount > 0) {
  const scheduled = registry.getScheduled();
  for (const h of scheduled) {
    console.log(`[scheduler]   ${h.name} — ${h.cron} (${h.tz})`);
  }
}

if (triggerCount > 0) {
  for (const t of triggerManager.listTriggers()) {
    console.log(`[scheduler]   ${t.hand} — trigger: ${t.type}${t.def.hand ? ` (watches ${t.def.hand})` : ""}`);
  }
}

if (ONCE) {
  console.log(`[scheduler] Running single tick...`);
  await tick(registry, eventBus);
  await tickWorkflows();
  console.log(`[scheduler] Done.`);
  process.exit(0);
}

// Start event-driven triggers
triggerManager.start();

// Initial tick
await tick(registry, eventBus);
await tickWorkflows();

// Run every minute
const interval = setInterval(() => {
  tick(registry, eventBus);
  tickWorkflows();
}, TICK_INTERVAL_MS);

// Graceful shutdown
function shutdown(signal) {
  console.log(`[scheduler] ${signal} received, shutting down...`);
  clearInterval(interval);
  triggerManager.stop();

  if (runningHands.size > 0) {
    console.log(`[scheduler] Waiting for ${runningHands.size} running hand(s): ${[...runningHands].join(", ")}`);
    // Give running hands 10s to wrap up, then exit
    setTimeout(() => process.exit(0), 10_000);
  } else {
    process.exit(0);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

console.log(`[scheduler] Ticking every ${TICK_INTERVAL_MS / 1000}s. Waiting for scheduled hands...`);
