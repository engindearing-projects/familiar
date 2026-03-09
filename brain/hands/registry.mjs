// Hand Registry — loads, manages, and persists Hand manifests
//
// Scans brain/hands/*/HAND.json for installed hands.
// Persists runtime state (metrics, checkpoints) in brain/hands/state.json.
//
// Usage:
//   import { HandRegistry } from "./registry.mjs";
//   const registry = new HandRegistry();
//   await registry.load();
//   const hand = registry.get("forge-miner");

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "fs";
import { resolve, join } from "path";
import { validateManifest } from "./schema.mjs";

const HANDS_DIR = import.meta.dir;
const STATE_FILE = resolve(HANDS_DIR, "state.json");

export class HandRegistry {
  constructor() {
    this.hands = new Map();     // name → manifest + runtime info
    this.state = {};            // persisted state per hand
    this._loaded = false;
  }

  /** Scan hands directory and load all valid HAND.json manifests */
  load() {
    // Load persisted state
    if (existsSync(STATE_FILE)) {
      try {
        this.state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
      } catch {
        this.state = {};
      }
    }

    // Scan for HAND.json files in subdirectories
    const entries = readdirSync(HANDS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const manifestPath = join(HANDS_DIR, entry.name, "HAND.json");
      if (!existsSync(manifestPath)) continue;

      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        const validation = validateManifest(manifest);

        if (!validation.valid) {
          console.error(`[hands] Invalid manifest ${entry.name}/HAND.json:`, validation.errors);
          continue;
        }

        // Merge persisted state
        const savedState = this.state[manifest.name] || {};

        this.hands.set(manifest.name, {
          manifest,
          dir: join(HANDS_DIR, entry.name),
          status: savedState.status || "inactive",   // inactive | active | paused | running | error
          lastRun: savedState.lastRun || null,
          lastDuration: savedState.lastDuration || null,
          lastError: savedState.lastError || null,
          runCount: savedState.runCount || 0,
          metrics: savedState.metrics || {},
          checkpoint: savedState.checkpoint || null,
          activatedAt: savedState.activatedAt || null,
        });
      } catch (err) {
        console.error(`[hands] Failed to load ${entry.name}/HAND.json:`, err.message);
      }
    }

    this._loaded = true;
    return this;
  }

  /** Reload state from disk (for processes that share state.json with the scheduler) */
  reload() {
    if (!existsSync(STATE_FILE)) return;
    try {
      const fresh = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
      for (const [name, hand] of this.hands) {
        const s = fresh[name];
        if (!s) continue;
        hand.status = s.status ?? hand.status;
        hand.lastRun = s.lastRun ?? hand.lastRun;
        hand.lastDuration = s.lastDuration ?? hand.lastDuration;
        hand.lastError = s.lastError ?? hand.lastError;
        hand.runCount = s.runCount ?? hand.runCount;
        hand.metrics = s.metrics ?? hand.metrics;
        hand.checkpoint = s.checkpoint ?? hand.checkpoint;
        hand.activatedAt = s.activatedAt ?? hand.activatedAt;
      }
      this.state = fresh;
    } catch {}
  }

  /** Get a hand by name */
  get(name) {
    return this.hands.get(name) || null;
  }

  /** List all hands with their status */
  list() {
    return Array.from(this.hands.values()).map(h => ({
      name: h.manifest.name,
      description: h.manifest.description,
      status: h.status,
      lastRun: h.lastRun,
      runCount: h.runCount,
      schedule: h.manifest.schedule?.cron || "manual",
    }));
  }

  /** Activate a hand */
  activate(name) {
    const hand = this.hands.get(name);
    if (!hand) return { ok: false, error: `Hand "${name}" not found` };
    if (hand.status === "active") return { ok: true, already: true };

    hand.status = "active";
    hand.activatedAt = new Date().toISOString();
    this._persist();
    return { ok: true };
  }

  /** Pause a hand (keeps state, stops scheduling) */
  pause(name) {
    const hand = this.hands.get(name);
    if (!hand) return { ok: false, error: `Hand "${name}" not found` };
    if (hand.status !== "active" && hand.status !== "running") {
      return { ok: false, error: `Hand "${name}" is ${hand.status}, can't pause` };
    }

    hand.status = "paused";
    this._persist();
    return { ok: true };
  }

  /** Resume a paused hand */
  resume(name) {
    const hand = this.hands.get(name);
    if (!hand) return { ok: false, error: `Hand "${name}" not found` };
    if (hand.status !== "paused") {
      return { ok: false, error: `Hand "${name}" is ${hand.status}, not paused` };
    }

    hand.status = "active";
    this._persist();
    return { ok: true };
  }

  /** Deactivate a hand */
  deactivate(name) {
    const hand = this.hands.get(name);
    if (!hand) return { ok: false, error: `Hand "${name}" not found` };

    hand.status = "inactive";
    this._persist();
    return { ok: true };
  }

  /** Mark a hand as running (called by runner before execution) */
  markRunning(name) {
    const hand = this.hands.get(name);
    if (!hand) return;
    hand.status = "running";
    this._persist();
  }

  /** Record run completion */
  recordRun(name, { duration, error, metrics, checkpoint }) {
    const hand = this.hands.get(name);
    if (!hand) return;

    hand.lastRun = new Date().toISOString();
    hand.lastDuration = duration;
    hand.runCount++;

    if (error) {
      hand.lastError = error;
      hand.status = "error";
    } else {
      hand.lastError = null;
      hand.status = "active";
    }

    // Merge metrics
    if (metrics) {
      for (const [key, value] of Object.entries(metrics)) {
        const metricDef = hand.manifest.metrics?.[key];
        if (!metricDef) continue;

        if (metricDef.type === "counter") {
          hand.metrics[key] = (hand.metrics[key] || 0) + (value || 0);
        } else {
          hand.metrics[key] = value;
        }
      }
    }

    // Save checkpoint
    if (checkpoint !== undefined) {
      hand.checkpoint = checkpoint;
    }

    this._persist();
  }

  /** Get hand metrics */
  getMetrics(name) {
    const hand = this.hands.get(name);
    if (!hand) return null;
    return {
      name: hand.manifest.name,
      status: hand.status,
      runCount: hand.runCount,
      lastRun: hand.lastRun,
      lastDuration: hand.lastDuration,
      lastError: hand.lastError,
      metrics: hand.metrics,
      checkpoint: hand.checkpoint,
    };
  }

  /** Get all active hands that should be scheduled */
  getScheduled() {
    return Array.from(this.hands.values())
      .filter(h => h.status === "active" && h.manifest.schedule?.cron)
      .map(h => ({
        name: h.manifest.name,
        cron: h.manifest.schedule.cron,
        tz: h.manifest.schedule.tz || "America/Los_Angeles",
        maxDuration: h.manifest.schedule.maxDuration || 3600,
      }));
  }

  /** Persist state to disk */
  _persist() {
    const state = {};
    for (const [name, hand] of this.hands) {
      state[name] = {
        status: hand.status,
        lastRun: hand.lastRun,
        lastDuration: hand.lastDuration,
        lastError: hand.lastError,
        runCount: hand.runCount,
        metrics: hand.metrics,
        checkpoint: hand.checkpoint,
        activatedAt: hand.activatedAt,
      };
    }
    this.state = state;
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }
}

export default HandRegistry;
