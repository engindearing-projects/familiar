// Persistent work queue for the background daemon.
// Uses a separate SQLite DB (~/.familiar/memory/daemon.db) to avoid WAL contention
// with the main memory DB.
//
// State machine:
//   pending → investigating → proposed → approved → executing → done
//   proposed → rejected | deferred | timeout
//   deferred → pending (after timer expires)

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { memoryDir } from "../apps/cli/lib/paths.js";

let _db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  trigger_type TEXT NOT NULL,
  prompt TEXT NOT NULL,
  findings TEXT,
  proposed_action TEXT,
  proposed_command TEXT,
  risk_level TEXT DEFAULT 'low',
  approval_msg_id INTEGER,
  approval_chat_id TEXT,
  approved_by TEXT,
  defer_until TEXT,
  execution_result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status);
CREATE INDEX IF NOT EXISTS idx_work_items_created ON work_items(created_at);
CREATE INDEX IF NOT EXISTS idx_work_items_defer ON work_items(defer_until);
`;

/**
 * Lazy-open singleton. Separate DB file from main memory to avoid WAL contention.
 */
export function getDb() {
  if (_db) return _db;

  const dir = memoryDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const dbPath = join(dir, "daemon.db");
  _db = new Database(dbPath);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec(SCHEMA);
  return _db;
}

/**
 * Create a new work item.
 * @param {{ trigger_type: string, prompt: string, risk_level?: string }} opts
 * @returns {string} The work item ID.
 */
export function createWorkItem({ trigger_type, prompt, risk_level = "low" }) {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO work_items (id, status, trigger_type, prompt, risk_level, created_at, updated_at)
    VALUES (?, 'pending', ?, ?, ?, ?, ?)
  `).run(id, trigger_type, prompt, risk_level, now, now);

  return id;
}

/**
 * Update a work item by ID.
 * @param {string} id
 * @param {object} fields - Any fields to update (status, findings, proposed_action, etc.)
 */
export function updateWorkItem(id, fields) {
  const db = getDb();
  const allowed = [
    "status", "findings", "proposed_action", "proposed_command",
    "risk_level", "approval_msg_id", "approval_chat_id", "approved_by",
    "defer_until", "execution_result", "error", "completed_at",
  ];

  const sets = [];
  const values = [];

  for (const [key, val] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      sets.push(`${key} = ?`);
      values.push(val);
    }
  }

  if (sets.length === 0) return;

  // Always bump updated_at
  sets.push("updated_at = ?");
  values.push(new Date().toISOString());

  // If transitioning to a terminal state, set completed_at
  const terminalStates = ["done", "rejected", "timeout", "error"];
  if (fields.status && terminalStates.includes(fields.status) && !fields.completed_at) {
    sets.push("completed_at = ?");
    values.push(new Date().toISOString());
  }

  values.push(id);

  db.prepare(`UPDATE work_items SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

/**
 * Get a work item by ID.
 * @param {string} id
 * @returns {object|null}
 */
export function getWorkItem(id) {
  return getDb().prepare("SELECT * FROM work_items WHERE id = ?").get(id) || null;
}

/**
 * Get all items with status = 'pending'.
 * @returns {object[]}
 */
export function getPendingItems() {
  return getDb().prepare(
    "SELECT * FROM work_items WHERE status = 'pending' ORDER BY created_at ASC"
  ).all();
}

/**
 * Get items by status.
 * @param {string} status
 * @param {number} limit
 * @returns {object[]}
 */
export function getItemsByStatus(status, limit = 50) {
  return getDb().prepare(
    "SELECT * FROM work_items WHERE status = ? ORDER BY updated_at DESC LIMIT ?"
  ).all(status, limit);
}

/**
 * Get deferred items whose defer_until has passed.
 * @returns {object[]}
 */
export function getDeferredItems() {
  const now = new Date().toISOString();
  return getDb().prepare(
    "SELECT * FROM work_items WHERE status = 'deferred' AND defer_until <= ? ORDER BY defer_until ASC"
  ).all(now);
}

/**
 * Get recent items (any status) from the last N hours.
 * @param {number} hours - Lookback window in hours (default 12).
 * @param {number} limit
 * @returns {object[]}
 */
export function getRecentItems(hours = 12, limit = 50) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  return getDb().prepare(
    "SELECT * FROM work_items WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?"
  ).all(since, limit);
}

/**
 * Count work items by status.
 * @returns {Record<string, number>}
 */
export function countByStatus() {
  const rows = getDb().prepare(
    "SELECT status, COUNT(*) as count FROM work_items GROUP BY status"
  ).all();

  const counts = {};
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

/**
 * Auto-skip proposed items that have been waiting longer than the timeout.
 * @param {number} timeoutMs - Timeout in milliseconds (default 2 hours).
 * @returns {number} Number of items timed out.
 */
export function timeoutStaleApprovals(timeoutMs = 2 * 60 * 60 * 1000) {
  const cutoff = new Date(Date.now() - timeoutMs).toISOString();
  const stale = getDb().prepare(
    "SELECT id FROM work_items WHERE status = 'proposed' AND updated_at <= ?"
  ).all(cutoff);

  for (const { id } of stale) {
    updateWorkItem(id, { status: "timeout" });
  }

  return stale.length;
}
