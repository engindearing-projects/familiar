// Activity Sync Server — central ledger for cross-platform activity tracking.
// Bun HTTP server on :18790 with bun:sqlite. Fire-and-forget from all clients.

import { Database } from "bun:sqlite";
import { resolve } from "path";
import { homedir } from "os";

const PORT = parseInt(process.env.ACTIVITY_PORT || "18790", 10);
const BIND = process.env.ACTIVITY_BIND || "0.0.0.0";
const DB_PATH = resolve(process.env.FAMILIAR_DB_PATH || `${homedir()}/.familiar/memory/familiar.db`);
const MAX_CONTENT_LEN = 2000;
const CLEANUP_DAYS = 30;

// ── Database ─────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 3000");

db.exec(`
  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    session_key TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_activity_platform ON activity(platform)");
db.exec("CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at)");

db.exec(`
  CREATE TABLE IF NOT EXISTS read_cursors (
    platform TEXT PRIMARY KEY,
    last_seen_id INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// 30-day auto-cleanup on startup
const deleted = db.run(
  `DELETE FROM activity WHERE created_at < datetime('now', '-${CLEANUP_DAYS} days')`
);
if (deleted.changes > 0) {
  console.log(`Cleaned up ${deleted.changes} activity entries older than ${CLEANUP_DAYS} days`);
}

// ── Prepared statements ──────────────────────────────────────────────────────

const insertActivity = db.prepare(`
  INSERT INTO activity (platform, session_key, role, content, metadata)
  VALUES (?, ?, ?, ?, ?)
`);

const queryActivity = db.prepare(`
  SELECT id, platform, session_key, role, content, metadata, created_at
  FROM activity WHERE id > ? ORDER BY id ASC LIMIT ?
`);

const queryCursor = db.prepare(`
  SELECT last_seen_id FROM read_cursors WHERE platform = ?
`);

const queryMaxId = db.prepare(`SELECT COALESCE(MAX(id), 0) as max_id FROM activity`);

const queryUnreadItems = db.prepare(`
  SELECT id, platform, session_key, role, content, created_at
  FROM activity WHERE id > ? ORDER BY id DESC LIMIT ?
`);

const upsertCursor = db.prepare(`
  INSERT INTO read_cursors (platform, last_seen_id, updated_at)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(platform) DO UPDATE SET
    last_seen_id = excluded.last_seen_id,
    updated_at = datetime('now')
`);

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function cors() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

// ── Server ───────────────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  hostname: BIND,

  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") return cors();

    try {
      // GET /health
      if (path === "/health" && req.method === "GET") {
        return json({ status: "ok", db: DB_PATH, port: PORT });
      }

      // POST /activity
      if (path === "/activity" && req.method === "POST") {
        return req.json().then((body) => {
          const { platform, session_key, role, content, metadata } = body;
          if (!platform || !role || !content) {
            return json({ error: "platform, role, and content required" }, 400);
          }
          const truncated = String(content).slice(0, MAX_CONTENT_LEN);
          const meta = metadata ? JSON.stringify(metadata) : null;
          const result = insertActivity.run(
            platform,
            session_key || "default",
            role,
            truncated,
            meta
          );
          return json({ id: Number(result.lastInsertRowid), created_at: new Date().toISOString() });
        });
      }

      // GET /activity?since=<id>&limit=N
      if (path === "/activity" && req.method === "GET") {
        const since = parseInt(url.searchParams.get("since") || "0", 10);
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
        const items = queryActivity.all(since, limit);
        const nextCursor = items.length > 0 ? items[items.length - 1].id : since;
        return json({ items, nextCursor });
      }

      // GET /unread?platform=<name>
      if (path === "/unread" && req.method === "GET") {
        const platform = url.searchParams.get("platform");
        if (!platform) return json({ error: "platform param required" }, 400);

        const cursor = queryCursor.get(platform);
        const lastSeenId = cursor?.last_seen_id ?? 0;
        const maxRow = queryMaxId.get();
        const maxId = maxRow?.max_id ?? 0;
        const unreadCount = Math.max(0, maxId - lastSeenId);
        const latest = queryUnreadItems.all(lastSeenId, 5);

        return json({ unreadCount, cursor: lastSeenId, latest });
      }

      // POST /cursor
      if (path === "/cursor" && req.method === "POST") {
        return req.json().then((body) => {
          const { platform, last_seen_id } = body;
          if (!platform || last_seen_id == null) {
            return json({ error: "platform and last_seen_id required" }, 400);
          }
          upsertCursor.run(platform, last_seen_id);
          return json({ ok: true });
        });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      console.error("Request error:", err.message);
      return json({ error: err.message }, 500);
    }
  },
});

console.log(`Activity sync server running on ${BIND}:${PORT}`);
console.log(`Database: ${DB_PATH}`);
