// SQLite database layer for Familiar MCP server.
// Uses bun:sqlite directly — zero dependencies.
// Schema matches apps/cli/lib/memory-db.js exactly so both share the same DB.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync } from "fs";
import { resolve, join } from "path";

const HOME = process.env.HOME || "/tmp";
const FAMILIAR_HOME = process.env.FAMILIAR_HOME || resolve(HOME, ".familiar");
const MEMORY_DIR = join(FAMILIAR_HOME, "memory");
const DB_PATH = join(MEMORY_DIR, "familiar.db");
const PROFILE_DIR = join(FAMILIAR_HOME, "profile");

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

let _db = null;

export function getDb() {
  if (_db) return _db;

  if (!existsSync(MEMORY_DIR)) {
    mkdirSync(MEMORY_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec(SCHEMA);
  return _db;
}

export function dbPath() {
  return DB_PATH;
}

export function profileDirPath() {
  return PROFILE_DIR;
}

function generateId() {
  const uuid = crypto.randomUUID().replace(/-/g, "");
  return "obs_" + uuid.slice(0, 8);
}

export function addObservation(obs) {
  const db = getDb();
  const id = generateId();
  const timestamp = new Date().toISOString();
  const tags = obs.tags ? JSON.stringify(obs.tags) : null;

  db.prepare(
    `INSERT INTO observations (id, type, timestamp, project, summary, details, tags, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, obs.type, timestamp, obs.project || null, obs.summary, obs.details || null, tags, obs.source || null);

  return id;
}

function parseTags(row) {
  return { ...row, tags: row.tags ? JSON.parse(row.tags) : [] };
}

export function search(query, opts = {}) {
  const db = getDb();
  const limit = opts.limit || 20;
  const conditions = ["observations_fts MATCH ?"];
  const params = [query];

  if (opts.type) { conditions.push("o.type = ?"); params.push(opts.type); }
  if (opts.project) { conditions.push("o.project = ?"); params.push(opts.project); }
  if (opts.since) { conditions.push("o.timestamp >= ?"); params.push(opts.since); }
  if (opts.until) { conditions.push("o.timestamp <= ?"); params.push(opts.until); }

  params.push(limit);

  const sql = `
    SELECT o.id, o.type, o.timestamp, o.project, o.summary, o.tags, rank
    FROM observations o
    JOIN observations_fts ON observations_fts.rowid = o.rowid
    WHERE ${conditions.join(" AND ")}
    ORDER BY rank
    LIMIT ?
  `;

  return db.prepare(sql).all(...params).map(parseTags);
}

export function getRecentAll(limit = 10) {
  const db = getDb();
  return db.prepare(
    `SELECT id, type, timestamp, project, summary, tags, source
     FROM observations ORDER BY timestamp DESC LIMIT ?`
  ).all(limit).map(parseTags);
}

export function getStats() {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) as count FROM observations").get();

  const byType = {};
  for (const row of db.prepare("SELECT type, COUNT(*) as count FROM observations GROUP BY type ORDER BY count DESC").all()) {
    byType[row.type] = row.count;
  }

  const byProject = {};
  for (const row of db.prepare("SELECT COALESCE(project, '(none)') as project, COUNT(*) as count FROM observations GROUP BY project ORDER BY count DESC").all()) {
    byProject[row.project] = row.count;
  }

  let dbSizeBytes = 0;
  try { dbSizeBytes = statSync(DB_PATH).size; } catch {}

  return { totalObservations: total.count, byType, byProject, dbSizeBytes };
}

export function readProfile() {
  const userPath = join(PROFILE_DIR, "user.json");
  try {
    if (!existsSync(userPath)) return {};
    return JSON.parse(require("fs").readFileSync(userPath, "utf-8"));
  } catch {
    return {};
  }
}

export function readPreferences() {
  const prefsPath = join(PROFILE_DIR, "preferences.json");
  try {
    if (!existsSync(prefsPath)) return {};
    return JSON.parse(require("fs").readFileSync(prefsPath, "utf-8"));
  } catch {
    return {};
  }
}
