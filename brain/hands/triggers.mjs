// Event-driven trigger system for Hands
//
// Extends the cron-only scheduler with reactive triggers:
//   - file_change: watch filesystem paths, fire on modification
//   - webhook: HTTP endpoint that fires a trigger when hit
//   - threshold: monitor a value via a poll function, fire when threshold crossed
//   - hand_complete: fire when a specific hand finishes (inter-hand chaining)
//   - schedule: existing cron (delegates to scheduler)
//
// Usage:
//   import { EventBus, TriggerManager } from "./triggers.mjs";
//   const bus = new EventBus();
//   const triggers = new TriggerManager(bus, registry);
//   triggers.loadFromManifests();
//   triggers.start();

import { watch } from "fs";
import { resolve } from "path";

const PROJECT_DIR = resolve(import.meta.dir, "../..");

// Shared exclusive lock — imported by scheduler to coordinate
export const exclusiveLock = { hands: new Set() };

// ── EventBus ────────────────────────────────────────────────────────────────
// Simple pub/sub for internal events. Listeners receive (eventName, payload).

export class EventBus {
  constructor() {
    this._listeners = new Map();   // eventName → Set<callback>
    this._onceListeners = new Map();
  }

  /** Subscribe to an event */
  on(event, callback) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  /** Subscribe to an event, auto-remove after first fire */
  once(event, callback) {
    if (!this._onceListeners.has(event)) this._onceListeners.set(event, new Set());
    this._onceListeners.get(event).add(callback);
    return () => {
      const set = this._onceListeners.get(event);
      if (set) set.delete(callback);
    };
  }

  /** Unsubscribe */
  off(event, callback) {
    const set = this._listeners.get(event);
    if (set) set.delete(callback);
  }

  /** Emit an event to all subscribers */
  emit(event, payload) {
    const listeners = this._listeners.get(event);
    if (listeners) {
      for (const cb of listeners) {
        try { cb(event, payload); } catch (err) {
          console.error(`[event-bus] Error in listener for "${event}":`, err.message);
        }
      }
    }

    const onceListeners = this._onceListeners.get(event);
    if (onceListeners) {
      for (const cb of onceListeners) {
        try { cb(event, payload); } catch (err) {
          console.error(`[event-bus] Error in once-listener for "${event}":`, err.message);
        }
      }
      this._onceListeners.delete(event);
    }
  }

  /** List all event names with active listeners */
  listEvents() {
    const events = new Set();
    for (const [name, set] of this._listeners) {
      if (set.size > 0) events.add(name);
    }
    for (const [name, set] of this._onceListeners) {
      if (set.size > 0) events.add(name);
    }
    return [...events];
  }
}

// ── Trigger Types ───────────────────────────────────────────────────────────

const VALID_TRIGGER_TYPES = new Set([
  "file_change",
  "webhook",
  "threshold",
  "hand_complete",
  "schedule",
]);

/**
 * Validate a trigger definition from a HAND.json manifest.
 * Returns { valid: true } or { valid: false, error: "..." }
 */
export function validateTrigger(triggerDef) {
  if (!triggerDef || typeof triggerDef !== "object") {
    return { valid: false, error: "Trigger must be an object" };
  }
  if (!VALID_TRIGGER_TYPES.has(triggerDef.type)) {
    return { valid: false, error: `Unknown trigger type: "${triggerDef.type}". Valid: ${[...VALID_TRIGGER_TYPES].join(", ")}` };
  }

  switch (triggerDef.type) {
    case "file_change":
      if (!triggerDef.paths || !Array.isArray(triggerDef.paths) || triggerDef.paths.length === 0) {
        return { valid: false, error: "file_change trigger requires 'paths' array" };
      }
      break;

    case "webhook":
      if (!triggerDef.route || typeof triggerDef.route !== "string") {
        return { valid: false, error: "webhook trigger requires 'route' string" };
      }
      break;

    case "threshold":
      if (!triggerDef.metric || typeof triggerDef.metric !== "string") {
        return { valid: false, error: "threshold trigger requires 'metric' string" };
      }
      if (triggerDef.above == null && triggerDef.below == null) {
        return { valid: false, error: "threshold trigger requires 'above' or 'below' value" };
      }
      break;

    case "hand_complete":
      if (!triggerDef.hand || typeof triggerDef.hand !== "string") {
        return { valid: false, error: "hand_complete trigger requires 'hand' string (name of hand to watch)" };
      }
      break;

    case "schedule":
      if (!triggerDef.cron || typeof triggerDef.cron !== "string") {
        return { valid: false, error: "schedule trigger requires 'cron' string" };
      }
      break;
  }

  return { valid: true };
}

// ── TriggerManager ──────────────────────────────────────────────────────────
// Manages active triggers, wires them to the EventBus, and executes hands
// when triggers fire.

export class TriggerManager {
  constructor(bus, registry) {
    this.bus = bus;
    this.registry = registry;
    this._triggers = new Map();     // "handName:triggerType:id" → { def, cleanup, active }
    this._watchers = new Map();     // path → FSWatcher
    this._thresholdTimers = new Map(); // handKey → timer
    this._webhookRoutes = new Map();   // route → { handName, triggerDef }
    this._webhookServer = null;
    this._running = false;
    this._runHand = null;            // lazy-loaded runner
    this._cooldowns = new Map();     // handName → lastFiredAt (prevent rapid re-fires)
    this._triggerIdCounter = 0;
  }

  /** Load triggers from all hand manifests that have a "triggers" array */
  loadFromManifests() {
    for (const hand of this.registry.list()) {
      const handData = this.registry.get(hand.name);
      if (!handData?.manifest?.triggers) continue;

      for (const triggerDef of handData.manifest.triggers) {
        const validation = validateTrigger(triggerDef);
        if (!validation.valid) {
          console.error(`[triggers] Invalid trigger for ${hand.name}: ${validation.error}`);
          continue;
        }
        this._register(hand.name, triggerDef);
      }
    }
  }

  /** Register a trigger for a hand */
  registerTrigger(handName, triggerDef) {
    const validation = validateTrigger(triggerDef);
    if (!validation.valid) {
      return { ok: false, error: validation.error };
    }

    const hand = this.registry.get(handName);
    if (!hand) {
      return { ok: false, error: `Hand "${handName}" not found` };
    }

    const key = this._register(handName, triggerDef);

    // If already running, activate the trigger immediately
    if (this._running) {
      this._activate(key);
    }

    return { ok: true, key };
  }

  /** Remove trigger(s) for a hand by type (or all if type is omitted) */
  removeTrigger(handName, triggerType) {
    const removed = [];
    for (const [key, trigger] of this._triggers) {
      if (!key.startsWith(`${handName}:`)) continue;
      if (triggerType && trigger.def.type !== triggerType) continue;

      this._deactivate(key);
      this._triggers.delete(key);
      removed.push(key);
    }
    return { ok: true, removed };
  }

  /** List all active triggers */
  listTriggers() {
    const list = [];
    for (const [key, trigger] of this._triggers) {
      const [handName] = key.split(":");
      list.push({
        key,
        hand: handName,
        type: trigger.def.type,
        active: trigger.active,
        def: trigger.def,
      });
    }
    return list;
  }

  /** Start all triggers — call after loadFromManifests */
  start() {
    if (this._running) return;
    this._running = true;

    for (const [key] of this._triggers) {
      this._activate(key);
    }

    console.log(`[triggers] Started ${this._triggers.size} trigger(s)`);
  }

  /** Stop all triggers and clean up watchers/timers */
  stop() {
    this._running = false;

    for (const [key] of this._triggers) {
      this._deactivate(key);
    }

    // Close webhook server
    if (this._webhookServer) {
      this._webhookServer.stop();
      this._webhookServer = null;
    }

    console.log("[triggers] Stopped");
  }

  // ── Internal ────────────────────────────────────────────────────────────

  _register(handName, triggerDef) {
    this._triggerIdCounter++;
    const key = `${handName}:${triggerDef.type}:${this._triggerIdCounter}`;
    this._triggers.set(key, {
      def: triggerDef,
      active: false,
      cleanup: null,
    });
    return key;
  }

  _activate(key) {
    const trigger = this._triggers.get(key);
    if (!trigger || trigger.active) return;

    const [handName] = key.split(":");

    switch (trigger.def.type) {
      case "file_change":
        trigger.cleanup = this._activateFileChange(key, handName, trigger.def);
        break;

      case "webhook":
        trigger.cleanup = this._activateWebhook(key, handName, trigger.def);
        break;

      case "threshold":
        trigger.cleanup = this._activateThreshold(key, handName, trigger.def);
        break;

      case "hand_complete":
        trigger.cleanup = this._activateHandComplete(key, handName, trigger.def);
        break;

      case "schedule":
        // Schedule triggers are handled by the existing cron scheduler.
        // We emit an event here so the scheduler can pick it up if needed,
        // but we don't duplicate the cron logic.
        trigger.cleanup = () => {};
        break;
    }

    trigger.active = true;
  }

  _deactivate(key) {
    const trigger = this._triggers.get(key);
    if (!trigger || !trigger.active) return;

    if (trigger.cleanup) {
      trigger.cleanup();
      trigger.cleanup = null;
    }
    trigger.active = false;
  }

  /** Fire a hand — runs it through the runner with cooldown protection */
  async _fireHand(handName, triggerType, detail) {
    // Cooldown: don't re-fire the same hand within 60s
    const cooldownKey = handName;
    const now = Date.now();
    const lastFired = this._cooldowns.get(cooldownKey) || 0;
    const cooldownMs = 60_000;

    if (now - lastFired < cooldownMs) {
      console.log(`[triggers] ${handName} — cooldown (${triggerType}), skipping`);
      return;
    }
    this._cooldowns.set(cooldownKey, now);

    console.log(`[triggers] ${handName} — fired by ${triggerType}`, detail || "");

    // Emit the trigger event on the bus
    this.bus.emit("trigger.fired", { hand: handName, type: triggerType, detail, at: new Date().toISOString() });

    // Check hand status — only fire if active
    const hand = this.registry.get(handName);
    if (!hand) return;
    if (hand.status !== "active" && hand.status !== "inactive") {
      console.log(`[triggers] ${handName} — status is ${hand.status}, skipping trigger`);
      return;
    }

    // Respect exclusive lock — don't fire if an exclusive hand is running (unless it's that hand)
    if (exclusiveLock.hands.size > 0 && !exclusiveLock.hands.has(handName)) {
      console.log(`[triggers] ${handName} — skipped (exclusive hand running: ${[...exclusiveLock.hands].join(", ")})`);
      return;
    }

    // Auto-activate if inactive
    if (hand.status === "inactive") {
      this.registry.activate(handName);
    }

    // Lazy-load runner
    if (!this._runHand) {
      const mod = await import("./runner.mjs");
      this._runHand = mod.runHand;
    }

    try {
      const result = await this._runHand(this.registry, handName, { notify: true });

      // Emit hand_complete event so other triggers can chain
      this.bus.emit("hand.complete", {
        hand: handName,
        ok: result.ok,
        duration: result.duration,
        triggeredBy: triggerType,
      });
    } catch (err) {
      console.error(`[triggers] ${handName} — run error: ${err.message}`);
      this.bus.emit("hand.error", {
        hand: handName,
        error: err.message,
        triggeredBy: triggerType,
      });
    }
  }

  // ── file_change ─────────────────────────────────────────────────────────

  _activateFileChange(key, handName, def) {
    const watchers = [];
    const debounceMs = def.debounce || 5000; // default 5s debounce
    let debounceTimer = null;

    for (const rawPath of def.paths) {
      const fullPath = resolve(PROJECT_DIR, rawPath);

      try {
        const watcher = watch(fullPath, { recursive: def.recursive || false }, (eventType, filename) => {
          // Debounce — batch rapid changes
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            this._fireHand(handName, "file_change", { path: fullPath, eventType, filename });
          }, debounceMs);
        });

        watchers.push(watcher);
        console.log(`[triggers] ${handName} — watching ${fullPath}`);
      } catch (err) {
        console.error(`[triggers] ${handName} — failed to watch ${fullPath}: ${err.message}`);
      }
    }

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      for (const w of watchers) {
        try { w.close(); } catch {}
      }
    };
  }

  // ── webhook ─────────────────────────────────────────────────────────────

  _activateWebhook(key, handName, def) {
    const route = def.route.startsWith("/") ? def.route : `/${def.route}`;
    this._webhookRoutes.set(route, { handName, triggerDef: def });

    // Start HTTP server for webhooks if not already running
    this._ensureWebhookServer();

    console.log(`[triggers] ${handName} — webhook registered at ${route}`);

    return () => {
      this._webhookRoutes.delete(route);
    };
  }

  _ensureWebhookServer() {
    if (this._webhookServer) return;

    const port = parseInt(process.env.TRIGGER_WEBHOOK_PORT || "18795");

    this._webhookServer = Bun.serve({
      port,
      fetch: (req) => {
        const url = new URL(req.url);
        const route = url.pathname;

        const handler = this._webhookRoutes.get(route);
        if (!handler) {
          return new Response(JSON.stringify({ error: "Not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Check secret if configured
        if (handler.triggerDef.secret) {
          const provided = req.headers.get("x-trigger-secret") || url.searchParams.get("secret");
          if (provided !== handler.triggerDef.secret) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            });
          }
        }

        // Fire async — respond immediately
        this._fireHand(handler.handName, "webhook", { route, method: req.method });

        return new Response(JSON.stringify({ ok: true, hand: handler.handName, triggered: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    console.log(`[triggers] Webhook server listening on port ${port}`);
  }

  // ── threshold ───────────────────────────────────────────────────────────

  _activateThreshold(key, handName, def) {
    const pollInterval = (def.pollInterval || 300) * 1000; // default 5 minutes
    let lastValue = null;
    let fired = false;

    const check = async () => {
      try {
        const value = await this._readMetricValue(def.metric, handName);
        if (value == null) return;

        const crossed = (
          (def.above != null && value >= def.above && (lastValue == null || lastValue < def.above)) ||
          (def.below != null && value <= def.below && (lastValue == null || lastValue > def.below))
        );

        if (crossed && !fired) {
          fired = true;
          this._fireHand(handName, "threshold", {
            metric: def.metric,
            value,
            threshold: def.above != null ? { above: def.above } : { below: def.below },
          });

          // Reset fired state after cooldown so it can fire again
          if (def.resetAfter !== false) {
            setTimeout(() => { fired = false; }, 300_000); // 5 min reset
          }
        }

        // Reset fired flag if value goes back to normal
        if (def.above != null && value < def.above) fired = false;
        if (def.below != null && value > def.below) fired = false;

        lastValue = value;
      } catch (err) {
        console.error(`[triggers] ${handName} — threshold check error: ${err.message}`);
      }
    };

    // Initial check
    check();
    const timer = setInterval(check, pollInterval);

    return () => {
      clearInterval(timer);
    };
  }

  /** Read a metric value. Supports hand metrics and custom metric providers. */
  async _readMetricValue(metric, handName) {
    // Format: "handName.metricKey" or just "metricKey" (from own hand)
    const parts = metric.split(".");
    let targetHand, metricKey;

    if (parts.length >= 2) {
      targetHand = parts[0];
      metricKey = parts.slice(1).join(".");
    } else {
      targetHand = handName;
      metricKey = metric;
    }

    const metrics = this.registry.getMetrics(targetHand);
    if (!metrics) return null;

    // Check direct metrics
    if (metrics.metrics && metrics.metrics[metricKey] != null) {
      return metrics.metrics[metricKey];
    }

    // Check built-in stats
    if (metricKey === "runCount") return metrics.runCount;
    if (metricKey === "lastDuration") return metrics.lastDuration;

    return null;
  }

  // ── hand_complete ───────────────────────────────────────────────────────

  _activateHandComplete(key, handName, def) {
    const watchedHand = def.hand;
    const onlyOnSuccess = def.onlyOnSuccess !== false; // default true

    const listener = (event, payload) => {
      if (payload.hand !== watchedHand) return;
      if (onlyOnSuccess && !payload.ok) {
        console.log(`[triggers] ${handName} — ${watchedHand} failed, skipping (onlyOnSuccess)`);
        return;
      }
      this._fireHand(handName, "hand_complete", {
        completedHand: watchedHand,
        ok: payload.ok,
        duration: payload.duration,
      });
    };

    this.bus.on("hand.complete", listener);

    console.log(`[triggers] ${handName} — watching for ${watchedHand} completion`);

    return () => {
      this.bus.off("hand.complete", listener);
    };
  }
}

export default TriggerManager;
