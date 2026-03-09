// Forge Metrics DB — SQLite powered by bun:sqlite
// Tracks training pairs, runs, model versions, and evaluations.
// Pattern follows cli/lib/memory-db.js (lazy singleton, WAL mode).

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "db", "forge.db");

let _db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS training_pairs (
  id TEXT PRIMARY KEY,
  prompt_hash TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  complexity_score REAL,
  routed_to TEXT,
  claude_response_length INTEGER,
  local_response_length INTEGER,
  claude_duration_ms INTEGER,
  local_duration_ms INTEGER,
  local_model TEXT,
  has_code INTEGER DEFAULT 0,
  used_in_training INTEGER DEFAULT 0,
  training_version TEXT,
  task_type TEXT,
  task_type_confidence REAL,
  training_eligible INTEGER DEFAULT 1,
  data_source TEXT,
  gold_source TEXT
);

CREATE TABLE IF NOT EXISTS training_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  train_loss REAL,
  valid_loss REAL,
  train_examples INTEGER,
  valid_examples INTEGER,
  iterations INTEGER,
  duration_seconds REAL,
  adapter_path TEXT,
  status TEXT DEFAULT 'running'
);

CREATE TABLE IF NOT EXISTS model_versions (
  version TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  benchmark_score REAL,
  benchmark_details TEXT,
  adapter_path TEXT,
  fused_path TEXT,
  gguf_path TEXT,
  ollama_tag TEXT,
  deployed INTEGER DEFAULT 0,
  active INTEGER DEFAULT 0,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL,
  evaluated_at TEXT NOT NULL DEFAULT (datetime('now')),
  overall_score REAL,
  syntax_score REAL,
  test_score REAL,
  similarity_score REAL,
  completeness_score REAL,
  tasks_evaluated INTEGER,
  details TEXT,
  FOREIGN KEY (version) REFERENCES model_versions(version)
);

CREATE INDEX IF NOT EXISTS idx_pairs_hash ON training_pairs(prompt_hash);
CREATE INDEX IF NOT EXISTS idx_pairs_used ON training_pairs(used_in_training);
CREATE INDEX IF NOT EXISTS idx_pairs_ts ON training_pairs(timestamp);

CREATE TABLE IF NOT EXISTS comparisons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt TEXT NOT NULL,
  goal TEXT,
  context TEXT,
  claude_response TEXT,
  claude_duration_ms INTEGER,
  engie_response TEXT,
  engie_duration_ms INTEGER,
  session_key TEXT,
  complexity_score REAL,
  task_type TEXT,
  task_type_confidence REAL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_comparisons_ts ON comparisons(created_at);
`;

export function getDb() {
  if (_db) return _db;

  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec(SCHEMA);

  // Migration: add task_type columns to existing DBs + create indexes
  try {
    const cols = _db.prepare("PRAGMA table_info(training_pairs)").all().map(c => c.name);
    if (!cols.includes("task_type")) {
      _db.exec("ALTER TABLE training_pairs ADD COLUMN task_type TEXT");
      _db.exec("ALTER TABLE training_pairs ADD COLUMN task_type_confidence REAL");
    }
    const compCols = _db.prepare("PRAGMA table_info(comparisons)").all().map(c => c.name);
    if (!compCols.includes("task_type")) {
      _db.exec("ALTER TABLE comparisons ADD COLUMN task_type TEXT");
      _db.exec("ALTER TABLE comparisons ADD COLUMN task_type_confidence REAL");
    }
    // Migration: add training eligibility columns
    if (!cols.includes("training_eligible")) {
      _db.exec("ALTER TABLE training_pairs ADD COLUMN training_eligible INTEGER DEFAULT 1");
      _db.exec("ALTER TABLE training_pairs ADD COLUMN data_source TEXT");
      _db.exec("ALTER TABLE training_pairs ADD COLUMN gold_source TEXT");
      // Mark all existing collector/distillation pairs as ineligible.
      // Ground truth pairs (routed_to = 'ground_truth') stay eligible.
      _db.exec(`UPDATE training_pairs SET training_eligible = 0, data_source = 'collector', gold_source = 'claude_distillation'
                WHERE routed_to IS NOT NULL AND routed_to != 'ground_truth'
                  AND training_eligible = 1`);
      _db.exec(`UPDATE training_pairs SET data_source = 'ground_truth', gold_source = 'ground_truth_diff'
                WHERE routed_to = 'ground_truth'`);
    }
  } catch (e) {
    // Migration already applied or not needed
  }
  // Indexes on task_type (safe to run after migration or fresh create)
  _db.exec("CREATE INDEX IF NOT EXISTS idx_pairs_task_type ON training_pairs(task_type)");
  _db.exec("CREATE INDEX IF NOT EXISTS idx_comparisons_task_type ON comparisons(task_type)");

  return _db;
}

export function dbPath() {
  return DB_PATH;
}

// ── Training Pairs ──────────────────────────────────────────────────────────

export function recordPair(pair) {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO training_pairs
      (id, prompt_hash, timestamp, complexity_score, routed_to,
       claude_response_length, local_response_length,
       claude_duration_ms, local_duration_ms, local_model, has_code,
       task_type, task_type_confidence,
       training_eligible, data_source, gold_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pair.id,
    pair.prompt_hash,
    pair.timestamp || new Date().toISOString(),
    pair.complexity_score ?? null,
    pair.routed_to ?? null,
    pair.claude_response_length ?? 0,
    pair.local_response_length ?? 0,
    pair.claude_duration_ms ?? null,
    pair.local_duration_ms ?? null,
    pair.local_model ?? null,
    pair.has_code ? 1 : 0,
    pair.task_type ?? null,
    pair.task_type_confidence ?? null,
    pair.training_eligible !== undefined ? (pair.training_eligible ? 1 : 0) : 1,
    pair.data_source ?? null,
    pair.gold_source ?? null
  );
}

export function getUnusedPairCount() {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM training_pairs WHERE used_in_training = 0 AND training_eligible = 1").get();
  return row?.count ?? 0;
}

export function getTotalPairCount() {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM training_pairs").get();
  return row?.count ?? 0;
}

export function markPairsUsed(version) {
  const db = getDb();
  db.prepare("UPDATE training_pairs SET used_in_training = 1, training_version = ? WHERE used_in_training = 0 AND training_eligible = 1").run(version);
}

// ── Training Runs ───────────────────────────────────────────────────────────

export function startRun(version, trainExamples, validExamples) {
  const db = getDb();
  db.prepare(`
    INSERT INTO training_runs (version, train_examples, valid_examples, status)
    VALUES (?, ?, ?, 'running')
  `).run(version, trainExamples, validExamples);
  return version;
}

export function completeRun(version, { trainLoss, validLoss, iterations, durationSeconds }) {
  const db = getDb();
  db.prepare(`
    UPDATE training_runs SET
      completed_at = datetime('now'),
      train_loss = ?,
      valid_loss = ?,
      iterations = ?,
      duration_seconds = ?,
      status = 'completed'
    WHERE version = ?
  `).run(trainLoss, validLoss, iterations, durationSeconds, version);
}

export function failRun(version, error) {
  const db = getDb();
  db.prepare(`
    UPDATE training_runs SET
      completed_at = datetime('now'),
      status = 'failed'
    WHERE version = ?
  `).run(version);
}

export function getLastRun() {
  const db = getDb();
  return db.prepare("SELECT * FROM training_runs ORDER BY id DESC LIMIT 1").get() || null;
}

export function getAllRuns() {
  const db = getDb();
  return db.prepare("SELECT * FROM training_runs ORDER BY id DESC").all();
}

// ── Model Versions ──────────────────────────────────────────────────────────

export function createVersion(version, opts = {}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO model_versions (version, adapter_path, notes)
    VALUES (?, ?, ?)
  `).run(version, opts.adapterPath ?? null, opts.notes ?? null);
}

export function updateVersion(version, fields) {
  const db = getDb();
  const sets = [];
  const params = [];
  for (const [key, val] of Object.entries(fields)) {
    const col = key.replace(/([A-Z])/g, "_$1").toLowerCase();
    sets.push(`${col} = ?`);
    params.push(val);
  }
  if (sets.length === 0) return;
  params.push(version);
  db.prepare(`UPDATE model_versions SET ${sets.join(", ")} WHERE version = ?`).run(...params);
}

export function getActiveVersion() {
  const db = getDb();
  return db.prepare("SELECT * FROM model_versions WHERE active = 1 LIMIT 1").get() || null;
}

export function getLatestVersion() {
  const db = getDb();
  return db.prepare("SELECT * FROM model_versions ORDER BY created_at DESC LIMIT 1").get() || null;
}

export function getAllVersions() {
  const db = getDb();
  return db.prepare("SELECT * FROM model_versions ORDER BY created_at DESC").all();
}

export function setActiveVersion(version) {
  const db = getDb();
  db.prepare("UPDATE model_versions SET active = 0 WHERE active = 1").run();
  db.prepare("UPDATE model_versions SET active = 1, deployed = 1 WHERE version = ?").run(version);
}

export function getNextVersion() {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM model_versions").get();
  return `v${(row?.count ?? 0) + 1}`;
}

// ── Evaluations ─────────────────────────────────────────────────────────────

export function recordEvaluation(eval_) {
  const db = getDb();
  db.prepare(`
    INSERT INTO evaluations
      (version, overall_score, syntax_score, test_score, similarity_score,
       completeness_score, tasks_evaluated, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eval_.version,
    eval_.overallScore,
    eval_.syntaxScore ?? null,
    eval_.testScore ?? null,
    eval_.similarityScore ?? null,
    eval_.completenessScore ?? null,
    eval_.tasksEvaluated ?? 0,
    eval_.details ? JSON.stringify(eval_.details) : null
  );
}

export function getLatestEvaluation(version) {
  const db = getDb();
  return db.prepare("SELECT * FROM evaluations WHERE version = ? ORDER BY id DESC LIMIT 1").get(version) || null;
}

export function getAllEvaluations() {
  const db = getDb();
  return db.prepare("SELECT * FROM evaluations ORDER BY id DESC").all();
}

// ── Stats ───────────────────────────────────────────────────────────────────

export function getForgeStats() {
  const db = getDb();
  const totalPairs = getTotalPairCount();
  const unusedPairs = getUnusedPairCount();
  const lastRun = getLastRun();
  const activeVersion = getActiveVersion();
  const totalRuns = db.prepare("SELECT COUNT(*) as count FROM training_runs").get()?.count ?? 0;
  const totalVersions = db.prepare("SELECT COUNT(*) as count FROM model_versions").get()?.count ?? 0;

  // Task type distribution
  const taskTypeCounts = {};
  const rows = db.prepare("SELECT task_type, COUNT(*) as count FROM training_pairs WHERE task_type IS NOT NULL GROUP BY task_type").all();
  for (const row of rows) {
    taskTypeCounts[row.task_type] = row.count;
  }
  const untagged = db.prepare("SELECT COUNT(*) as count FROM training_pairs WHERE task_type IS NULL").get()?.count ?? 0;

  return {
    totalPairs,
    unusedPairs,
    totalRuns,
    totalVersions,
    lastRun,
    activeVersion,
    taskTypeCounts,
    untaggedPairs: untagged,
  };
}

export function getEligibilityStats() {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) as count FROM training_pairs").get()?.count ?? 0;
  const eligible = db.prepare("SELECT COUNT(*) as count FROM training_pairs WHERE training_eligible = 1").get()?.count ?? 0;
  const ineligible = total - eligible;

  const bySource = {};
  const rows = db.prepare("SELECT gold_source, training_eligible, COUNT(*) as count FROM training_pairs GROUP BY gold_source, training_eligible").all();
  for (const r of rows) {
    const src = r.gold_source || "unknown";
    if (!bySource[src]) bySource[src] = { eligible: 0, ineligible: 0 };
    if (r.training_eligible) bySource[src].eligible += r.count;
    else bySource[src].ineligible += r.count;
  }

  return { total, eligible, ineligible, bySource };
}

// ── Comparisons (Training Mode) ─────────────────────────────────────────────

export function recordComparison(comp) {
  const db = getDb();
  db.prepare(`
    INSERT INTO comparisons
      (prompt, goal, context, claude_response, claude_duration_ms,
       engie_response, engie_duration_ms, session_key, complexity_score,
       task_type, task_type_confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    comp.prompt,
    comp.goal ?? null,
    comp.context ?? null,
    comp.claudeResponse ?? null,
    comp.claudeDurationMs ?? null,
    comp.engieResponse ?? null,
    comp.engieDurationMs ?? null,
    comp.sessionKey ?? null,
    comp.complexityScore ?? null,
    comp.taskType ?? null,
    comp.taskTypeConfidence ?? null
  );
}

export function getComparisons(limit = 50) {
  const db = getDb();
  return db.prepare("SELECT * FROM comparisons ORDER BY id DESC LIMIT ?").all(limit);
}

export function getComparisonStats() {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) as count FROM comparisons").get()?.count ?? 0;
  const withGoal = db.prepare("SELECT COUNT(*) as count FROM comparisons WHERE goal IS NOT NULL").get()?.count ?? 0;
  const avgClaudeDuration = db.prepare("SELECT AVG(claude_duration_ms) as avg FROM comparisons WHERE claude_duration_ms IS NOT NULL").get()?.avg ?? 0;
  const avgEngieDuration = db.prepare("SELECT AVG(engie_duration_ms) as avg FROM comparisons WHERE engie_duration_ms IS NOT NULL").get()?.avg ?? 0;
  return { total, withGoal, avgClaudeDuration: Math.round(avgClaudeDuration), avgEngieDuration: Math.round(avgEngieDuration) };
}
