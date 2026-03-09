// Persistent session store using bun:sqlite
// Used by gateway.mjs for cross-client session access (CLI, Telegram, web)

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";

const HOME = process.env.HOME || "/tmp";
const FAMILIAR_HOME = process.env.FAMILIAR_HOME || process.env.COZYTERM_HOME || resolve(HOME, ".familiar");
const DATA_DIR = resolve(FAMILIAR_HOME, "data");
const DB_PATH = resolve(DATA_DIR, "sessions.db");

let _db = null;

export function getSessionDb() {
  if (_db) return _db;

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  _db = new Database(DB_PATH);
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'Untitled',
      session_key TEXT,
      source TEXT,
      parent_id TEXT,
      working_dir TEXT,
      created TEXT NOT NULL DEFAULT (datetime('now')),
      updated TEXT NOT NULL DEFAULT (datetime('now')),
      archived INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (parent_id) REFERENCES sessions(id) ON DELETE SET NULL
    )
  `);

  // Add columns if upgrading from older schema
  try { _db.exec(`ALTER TABLE sessions ADD COLUMN session_key TEXT`); } catch {}
  try { _db.exec(`ALTER TABLE sessions ADD COLUMN source TEXT`); } catch {}
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_key ON sessions(session_key)`);

  _db.exec(`
    CREATE TABLE IF NOT EXISTS session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      metadata TEXT,
      created TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  _db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session ON session_messages(session_id)`);
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated DESC)`);

  return _db;
}

/**
 * Create a new session.
 */
export function createSession({ title, workingDir, parentId, sessionKey } = {}) {
  const db = getSessionDb();
  const id = randomUUID().slice(0, 12);
  const now = new Date().toISOString();

  // Derive source from session key (e.g. "familiar:cli:main" → "cli")
  const source = sessionKey ? (sessionKey.split(":")[1] || null) : null;

  db.prepare(`
    INSERT INTO sessions (id, title, session_key, source, working_dir, parent_id, created, updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, title || "Untitled", sessionKey || null, source, workingDir || process.cwd(), parentId || null, now, now);

  return { id, title: title || "Untitled", sessionKey, source, parentId: parentId || null, workingDir: workingDir || process.cwd(), created: now, updated: now, archived: 0 };
}

/**
 * List sessions (most recently updated first).
 */
export function listSessions({ includeArchived = false, limit = 50 } = {}) {
  const db = getSessionDb();
  const where = includeArchived ? "" : "WHERE s.archived = 0";
  const rows = db.prepare(`
    SELECT s.*,
      COUNT(m.id) as message_count,
      (SELECT text FROM session_messages WHERE session_id = s.id ORDER BY created DESC LIMIT 1) as last_message,
      (SELECT role FROM session_messages WHERE session_id = s.id ORDER BY created DESC LIMIT 1) as last_role
    FROM sessions s
    LEFT JOIN session_messages m ON m.session_id = s.id
    ${where}
    GROUP BY s.id
    ORDER BY s.updated DESC
    LIMIT ?
  `).all(limit);
  // Truncate last_message for the list view
  return rows.map(r => ({
    ...r,
    last_message: r.last_message ? r.last_message.slice(0, 120) : null,
  }));
}

/**
 * Get a single session by ID.
 */
export function getSessionById(id) {
  const db = getSessionDb();
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) || null;
}

/**
 * Rename a session.
 */
export function renameSession(id, title) {
  const db = getSessionDb();
  const now = new Date().toISOString();
  db.prepare(`UPDATE sessions SET title = ?, updated = ? WHERE id = ?`).run(title, now, id);
}

/**
 * Archive/unarchive a session.
 */
export function archiveSession(id, archived = true) {
  const db = getSessionDb();
  const now = new Date().toISOString();
  db.prepare(`UPDATE sessions SET archived = ?, updated = ? WHERE id = ?`).run(archived ? 1 : 0, now, id);
}

/**
 * Add a message to a session.
 */
export function addSessionMessage(sessionId, { role, text, metadata } = {}) {
  const db = getSessionDb();
  const id = randomUUID().slice(0, 12);
  const now = new Date().toISOString();
  const metaJson = metadata ? JSON.stringify(metadata) : null;

  db.prepare(`
    INSERT INTO session_messages (id, session_id, role, text, metadata, created)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, sessionId, role, text, metaJson, now);

  // Touch session updated timestamp
  db.prepare(`UPDATE sessions SET updated = ? WHERE id = ?`).run(now, sessionId);

  return id;
}

/**
 * Get messages for a session.
 */
export function getSessionMessages(sessionId, { limit = 100, offset = 0 } = {}) {
  const db = getSessionDb();
  return db.prepare(`
    SELECT * FROM session_messages
    WHERE session_id = ?
    ORDER BY created ASC
    LIMIT ? OFFSET ?
  `).all(sessionId, limit, offset);
}

/**
 * Fork a session — copies messages up to a point into a new session.
 */
export function forkSession(sourceSessionId, { title, upToMessageId } = {}) {
  const db = getSessionDb();
  const source = getSessionById(sourceSessionId);
  if (!source) throw new Error(`Session not found: ${sourceSessionId}`);

  const forkTitle = title || `Fork of ${source.title}`;
  const newSession = createSession({
    title: forkTitle,
    workingDir: source.working_dir,
    parentId: sourceSessionId,
  });

  // Copy messages
  let whereClause = "WHERE session_id = ?";
  const params = [sourceSessionId];
  if (upToMessageId) {
    const targetMsg = db.prepare(`SELECT created FROM session_messages WHERE id = ?`).get(upToMessageId);
    if (targetMsg) {
      whereClause += " AND created <= ?";
      params.push(targetMsg.created);
    }
  }

  const messages = db.prepare(`
    SELECT role, text, metadata, created FROM session_messages ${whereClause} ORDER BY created ASC
  `).all(...params);

  const insertStmt = db.prepare(`
    INSERT INTO session_messages (id, session_id, role, text, metadata, created)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const msg of messages) {
    insertStmt.run(randomUUID().slice(0, 12), newSession.id, msg.role, msg.text, msg.metadata, msg.created);
  }

  return { ...newSession, messageCount: messages.length };
}

/**
 * Auto-generate session title from first user message.
 */
export function autoTitleSession(sessionId) {
  const db = getSessionDb();
  const session = getSessionById(sessionId);
  if (!session || session.title !== "Untitled") return;

  const firstMsg = db.prepare(`
    SELECT text FROM session_messages WHERE session_id = ? AND role = 'user' ORDER BY created ASC LIMIT 1
  `).get(sessionId);

  if (firstMsg?.text) {
    const title = firstMsg.text.slice(0, 60).replace(/\n/g, " ").trim();
    renameSession(sessionId, title || "Untitled");
  }
}
