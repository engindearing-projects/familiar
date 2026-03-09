// Chat memory: fast key-value store for conversation history + context.
// Uses SQLite (WAL) as the durable store and an in-memory Map as a write-through cache.
// O(1) average reads — cache hit returns immediately, only misses hit the DB.
//
// Two namespaces:
//   history — ring-buffer of chat messages per sessionKey
//   context — arbitrary JSON values per key (facts, project state, notes)

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { memoryDir } from "./paths.js";

const DB_FILENAME = "chat-memory.db";

let _db = null;

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS chat_history (
  key   TEXT    NOT NULL,
  seq   INTEGER NOT NULL,
  role  TEXT    NOT NULL,
  content TEXT  NOT NULL,
  ts    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (key, seq)
);

-- Newest-first index per key for fast tail reads
CREATE INDEX IF NOT EXISTS idx_chat_key_seq ON chat_history(key, seq DESC);

-- Global auto-increment sequence counter per key
CREATE TABLE IF NOT EXISTS chat_seq (
  key  TEXT PRIMARY KEY,
  next INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS context (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
`;

function db() {
  if (_db) return _db;
  const dir = memoryDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  _db = new Database(resolve(dir, DB_FILENAME));
  _db.exec(SCHEMA);
  return _db;
}

// ── In-memory cache ────────────────────────────────────────────────────────
// Map<key, Message[]> — populated lazily on first read, kept in sync on write
const _histCache = new Map();   // key → [{role, content, ts}]
const _ctxCache  = new Map();   // key → parsed JSON value

// ── History ────────────────────────────────────────────────────────────────

/**
 * Get the last `limit` messages for a session key.
 * Returns messages in chronological order (oldest first).
 */
export function historyGet(key, limit = 20) {
  if (_histCache.has(key)) return _histCache.get(key).slice(-limit);

  const rows = db()
    .prepare(
      `SELECT role, content, ts FROM chat_history
       WHERE key = ?
       ORDER BY seq DESC
       LIMIT ?`
    )
    .all(key, limit);

  // DB returns newest-first; reverse for chronological order
  const msgs = rows.reverse().map(({ role, content, ts }) => ({ role, content, ts }));
  _histCache.set(key, msgs);
  return msgs;
}

/**
 * Append a message to the history for a key.
 * Trims the in-memory cache to `maxLen`; DB keeps `maxLen * 2` rows (buffer for pruning).
 */
export function historyAppend(key, role, content, maxLen = 20) {
  const d = db();
  const ts = new Date().toISOString();

  // Get/bump sequence number
  d.exec(`INSERT OR IGNORE INTO chat_seq (key, next) VALUES ('${key}', 0)`);
  const { next } = d.prepare(`UPDATE chat_seq SET next = next + 1 WHERE key = ? RETURNING next`).get(key);

  d.prepare(`INSERT INTO chat_history (key, seq, role, content, ts) VALUES (?, ?, ?, ?, ?)`)
    .run(key, next, role, content, ts);

  // Prune DB rows to 2× maxLen so we don't grow forever
  const keep = maxLen * 2;
  d.prepare(
    `DELETE FROM chat_history WHERE key = ? AND seq <= (
       SELECT MIN(seq) FROM (SELECT seq FROM chat_history WHERE key = ? ORDER BY seq DESC LIMIT ?)
     )`
  ).run(key, key, keep);

  // Update in-memory cache
  const cached = _histCache.get(key) ?? [];
  cached.push({ role, content, ts });
  while (cached.length > maxLen) cached.shift();
  _histCache.set(key, cached);
}

/**
 * Clear all history for a key (both DB and cache).
 */
export function historyClear(key) {
  db().prepare(`DELETE FROM chat_history WHERE key = ?`).run(key);
  db().prepare(`DELETE FROM chat_seq WHERE key = ?`).run(key);
  _histCache.delete(key);
}

/**
 * List all history keys that match an optional prefix.
 */
export function historyKeys(prefix = "") {
  const rows = db()
    .prepare(`SELECT DISTINCT key FROM chat_seq WHERE key LIKE ?`)
    .all(`${prefix}%`);
  return rows.map((r) => r.key);
}

// ── Context ────────────────────────────────────────────────────────────────

/**
 * Get a context value by key. Returns `undefined` if not found.
 */
export function contextGet(key) {
  if (_ctxCache.has(key)) return _ctxCache.get(key);

  const row = db().prepare(`SELECT value FROM context WHERE key = ?`).get(key);
  if (!row) return undefined;

  let parsed;
  try { parsed = JSON.parse(row.value); } catch { parsed = row.value; }
  _ctxCache.set(key, parsed);
  return parsed;
}

/**
 * Set a context value. Value can be any JSON-serializable type.
 */
export function contextSet(key, value) {
  const raw = JSON.stringify(value);
  const ts = new Date().toISOString();
  db().prepare(
    `INSERT INTO context (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, raw, ts);
  _ctxCache.set(key, value);
}

/**
 * Delete a context key.
 */
export function contextDelete(key) {
  db().prepare(`DELETE FROM context WHERE key = ?`).run(key);
  _ctxCache.delete(key);
}

/**
 * List context keys matching an optional prefix.
 */
export function contextKeys(prefix = "") {
  const rows = db()
    .prepare(`SELECT key FROM context WHERE key LIKE ?`)
    .all(`${prefix}%`);
  return rows.map((r) => r.key);
}

/**
 * Get all context entries matching a prefix as a plain object.
 */
export function contextGetAll(prefix = "") {
  const keys = contextKeys(prefix);
  const out = {};
  for (const k of keys) out[k] = contextGet(k);
  return out;
}
