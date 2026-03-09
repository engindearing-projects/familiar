// Structured memory system for Familiar — SQLite + FTS5 powered by bun:sqlite.
// Stores observations (task updates, decisions, blockers, insights) with full-text search.
// Zero native deps — bun:sqlite is built into the Bun runtime.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync } from "fs";
import { memoryDbPath, memoryDir } from "./paths.js";

let _db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  project TEXT,
  summary TEXT NOT NULL,
  details TEXT,
  tags TEXT,
  source TEXT
);

CREATE TABLE IF NOT EXISTS user_profile (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  learned_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  summary, details, tags, content=observations, content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, summary, details, tags)
    VALUES (new.rowid, new.summary, new.details, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, summary, details, tags)
    VALUES ('delete', old.rowid, old.summary, old.details, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, summary, details, tags)
    VALUES ('delete', old.rowid, old.summary, old.details, old.tags);
  INSERT INTO observations_fts(rowid, summary, details, tags)
    VALUES (new.rowid, new.summary, new.details, new.tags);
END;
`;

/**
 * Lazy-open singleton — creates DB file + schema on first call.
 * Uses WAL mode for better concurrent read performance.
 */
export function getDb() {
  if (_db) return _db;

  const dir = memoryDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const dbPath = memoryDbPath();
  _db = new Database(dbPath);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec(SCHEMA);

  return _db;
}

/**
 * Generate a short random ID like "obs_a1b2c3d4".
 * Uses crypto.randomUUID and takes first 8 hex chars.
 */
function generateId() {
  const uuid = crypto.randomUUID().replace(/-/g, "");
  return "obs_" + uuid.slice(0, 8);
}

/**
 * Add a structured observation to the memory DB.
 * @param {object} obs - { type, project?, summary, details?, tags?: string[], source? }
 * @returns {string} The generated observation ID.
 */
export function addObservation(obs) {
  const db = getDb();
  const id = generateId();
  const timestamp = new Date().toISOString();
  const tags = obs.tags ? JSON.stringify(obs.tags) : null;

  const stmt = db.prepare(`
    INSERT INTO observations (id, type, timestamp, project, summary, details, tags, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(id, obs.type, timestamp, obs.project || null, obs.summary, obs.details || null, tags, obs.source || null);

  return id;
}

/**
 * Full-text search with optional filters.
 * Returns summaries only (progressive disclosure layer 1).
 *
 * @param {string} query - Search string (FTS5 syntax supported).
 * @param {object} opts - { type?, project?, since?, until?, limit? }
 * @returns {Array<{ id, type, timestamp, project, summary, tags, rank }>}
 */
export function search(query, opts = {}) {
  const db = getDb();
  const limit = opts.limit || 20;

  const conditions = [];
  const params = [];

  // FTS match — join observations with the FTS table
  conditions.push("observations_fts MATCH ?");
  params.push(query);

  if (opts.type) {
    conditions.push("o.type = ?");
    params.push(opts.type);
  }

  if (opts.project) {
    conditions.push("o.project = ?");
    params.push(opts.project);
  }

  if (opts.since) {
    conditions.push("o.timestamp >= ?");
    params.push(opts.since);
  }

  if (opts.until) {
    conditions.push("o.timestamp <= ?");
    params.push(opts.until);
  }

  params.push(limit);

  const where = conditions.join(" AND ");

  const sql = `
    SELECT o.id, o.type, o.timestamp, o.project, o.summary, o.tags, rank
    FROM observations o
    JOIN observations_fts ON observations_fts.rowid = o.rowid
    WHERE ${where}
    ORDER BY rank
    LIMIT ?
  `;

  const rows = db.prepare(sql).all(...params);

  return rows.map((row) => ({
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
  }));
}

/**
 * Parse a range string like "1h", "1d", "1w" into milliseconds.
 */
function parseRange(range) {
  const match = range.match(/^(\d+)([hdw])$/);
  if (!match) return 24 * 60 * 60 * 1000; // default 1 day

  const num = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case "h":
      return num * 60 * 60 * 1000;
    case "d":
      return num * 24 * 60 * 60 * 1000;
    case "w":
      return num * 7 * 24 * 60 * 60 * 1000;
    default:
      return 24 * 60 * 60 * 1000;
  }
}

/**
 * Get chronological context around a timestamp.
 *
 * @param {string} around - ISO 8601 timestamp to center on.
 * @param {string} range - Duration string: "1h", "1d", "1w".
 * @returns {Array} Observations ordered by timestamp.
 */
export function getTimeline(around, range = "1d") {
  const db = getDb();
  const center = new Date(around).getTime();
  const halfRange = parseRange(range) / 2;

  const start = new Date(center - halfRange).toISOString();
  const end = new Date(center + halfRange).toISOString();

  const rows = db
    .prepare(
      `SELECT id, type, timestamp, project, summary, tags, source
       FROM observations
       WHERE timestamp >= ? AND timestamp <= ?
       ORDER BY timestamp ASC`
    )
    .all(start, end);

  return rows.map((row) => ({
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
  }));
}

/**
 * Get full observation details by ID (progressive disclosure layer 3).
 *
 * @param {string} id - Observation ID.
 * @returns {object|null} Full observation or null if not found.
 */
export function getObservation(id) {
  const db = getDb();

  const row = db.prepare("SELECT * FROM observations WHERE id = ?").get(id);

  if (!row) return null;

  return {
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
  };
}

/**
 * Get recent context for a project — useful for session warm-start.
 *
 * @param {string} project - Project name to filter by.
 * @param {number} limit - Max number of observations (default 10).
 * @returns {Array} Recent observations ordered newest first.
 */
export function getRecentContext(project, limit = 10) {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT id, type, timestamp, project, summary, tags, source
       FROM observations
       WHERE project = ?
       ORDER BY timestamp DESC
       LIMIT ?`
    )
    .all(project, limit);

  return rows.map((row) => ({
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
  }));
}

/**
 * Get all observations of a specific type.
 *
 * @param {string} type - Observation type (task_update, decision, blocker, etc.).
 * @param {number} limit - Max results (default 50).
 * @returns {Array} Observations of the given type, newest first.
 */
export function getByType(type, limit = 50) {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT id, type, timestamp, project, summary, tags, source
       FROM observations
       WHERE type = ?
       ORDER BY timestamp DESC
       LIMIT ?`
    )
    .all(type, limit);

  return rows.map((row) => ({
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
  }));
}

/**
 * Delete an observation by ID.
 *
 * @param {string} id - Observation ID.
 * @returns {boolean} True if a row was deleted.
 */
export function deleteObservation(id) {
  const db = getDb();
  const result = db.prepare("DELETE FROM observations WHERE id = ?").run(id);
  return result.changes > 0;
}

/**
 * Get recent observations across all projects — no project filter.
 *
 * @param {number} limit - Max number of observations (default 10).
 * @returns {Array} Recent observations ordered newest first.
 */
export function getRecentAll(limit = 10) {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT id, type, timestamp, project, summary, tags, source
       FROM observations
       ORDER BY timestamp DESC
       LIMIT ?`
    )
    .all(limit);

  return rows.map((row) => ({
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
  }));
}

/**
 * Count observations recorded today (UTC).
 *
 * @returns {number}
 */
export function getTodayCount() {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  const row = db
    .prepare("SELECT COUNT(*) as count FROM observations WHERE timestamp >= ?")
    .get(today + "T00:00:00.000Z");
  return row?.count ?? 0;
}

/**
 * Get observation count and DB stats.
 *
 * @returns {{ totalObservations, byType: object, byProject: object, dbSizeBytes: number }}
 */
export function getStats() {
  const db = getDb();

  const total = db.prepare("SELECT COUNT(*) as count FROM observations").get();

  const typeRows = db
    .prepare("SELECT type, COUNT(*) as count FROM observations GROUP BY type ORDER BY count DESC")
    .all();

  const projectRows = db
    .prepare(
      "SELECT COALESCE(project, '(none)') as project, COUNT(*) as count FROM observations GROUP BY project ORDER BY count DESC"
    )
    .all();

  const byType = {};
  for (const row of typeRows) {
    byType[row.type] = row.count;
  }

  const byProject = {};
  for (const row of projectRows) {
    byProject[row.project] = row.count;
  }

  // Get file size
  let dbSizeBytes = 0;
  try {
    dbSizeBytes = statSync(memoryDbPath()).size;
  } catch {
    // DB might not exist on disk yet
  }

  return {
    totalObservations: total.count,
    byType,
    byProject,
    dbSizeBytes,
  };
}
