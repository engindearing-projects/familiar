#!/usr/bin/env bun

// RAG Ingestion Pipeline
// Sources: conversation traces, memory observations, project docs
// Chunks into ~512-token blocks, embeds via Ollama nomic-embed-text,
// stores in SQLite with vector embeddings as binary blobs.
//
// Run: bun brain/rag/ingest.mjs
// Daily cron: 5:30 AM after forge-mine (4 AM)

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, mkdirSync, statSync } from "fs";
import { resolve, join, basename, extname } from "path";
import { buildGraph, initGraphSchema } from "./graph.mjs";

const HOME = process.env.HOME || "/tmp";
const PROJECT_DIR = resolve(import.meta.dir, "../..");
const DB_PATH = resolve(import.meta.dir, "knowledge.db");
const OLLAMA_URL = "http://localhost:11434";
const EMBED_MODEL = "nomic-embed-text";
const CHUNK_SIZE = 512;     // ~tokens (approx 4 chars/token = 2048 chars)
const CHUNK_OVERLAP = 50;   // ~tokens overlap between chunks
const CHAR_CHUNK = CHUNK_SIZE * 4;
const CHAR_OVERLAP = CHUNK_OVERLAP * 4;

// ── Database Setup ──────────────────────────────────────────────────────────

function getDb() {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      embedding BLOB,
      source TEXT NOT NULL,
      source_file TEXT,
      date TEXT,
      tags TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
    CREATE INDEX IF NOT EXISTS idx_chunks_date ON chunks(date);

    CREATE TABLE IF NOT EXISTS ingest_state (
      source TEXT PRIMARY KEY,
      last_file TEXT,
      last_offset INTEGER DEFAULT 0,
      last_run TEXT
    );
  `);

  // Migrate: add credibility_score column if not present
  try {
    db.exec("ALTER TABLE chunks ADD COLUMN credibility_score REAL");
  } catch { /* column already exists */ }

  return db;
}

// ── Embedding ───────────────────────────────────────────────────────────────

async function embed(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embed failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  // Ollama returns { embeddings: [[...]] } for single input
  const vec = data.embeddings?.[0];
  if (!vec || vec.length === 0) throw new Error("Empty embedding returned");
  return new Float32Array(vec);
}

function vecToBlob(vec) {
  return Buffer.from(vec.buffer);
}

// ── Chunking ────────────────────────────────────────────────────────────────

function chunkText(text, meta = {}) {
  const chunks = [];
  let offset = 0;

  while (offset < text.length) {
    const end = Math.min(offset + CHAR_CHUNK, text.length);
    const chunk = text.slice(offset, end).trim();

    if (chunk.length > 50) {
      chunks.push({ text: chunk, ...meta });
    }

    offset += CHAR_CHUNK - CHAR_OVERLAP;
  }

  return chunks;
}

// ── Sources ─────────────────────────────────────────────────────────────────

function ingestTraces(db) {
  const tracesDir = resolve(PROJECT_DIR, "trainer/data/traces");
  if (!existsSync(tracesDir)) return [];

  const state = db.prepare("SELECT last_file FROM ingest_state WHERE source = 'traces'").get();
  const lastFile = state?.last_file || "";

  const files = readdirSync(tracesDir)
    .filter(f => f.endsWith(".jsonl") && f > lastFile)
    .sort();

  const chunks = [];
  let latestFile = lastFile;

  for (const file of files) {
    const content = readFileSync(join(tracesDir, file), "utf-8");
    const lines = content.split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        const prompt = record.prompt || "";
        const response = record.response || record.trace?.slice(-1)?.[0]?.content || "";
        const text = `Q: ${prompt}\nA: ${response}`;

        chunks.push(...chunkText(text, {
          source: "traces",
          source_file: file,
          date: record.timestamp?.slice(0, 10) || new Date().toISOString().slice(0, 10),
          tags: "conversation,trace",
        }));
      } catch { /* skip malformed lines */ }
    }

    latestFile = file;
  }

  if (latestFile > lastFile) {
    db.prepare("INSERT OR REPLACE INTO ingest_state (source, last_file, last_run) VALUES ('traces', ?, datetime('now'))").run(latestFile);
  }

  return chunks;
}

function ingestMemory(db) {
  // Import from CLI memory database
  const memoryDbPath = resolve(HOME, ".familiar/memory/memory.db");
  if (!existsSync(memoryDbPath)) return [];

  const state = db.prepare("SELECT last_offset FROM ingest_state WHERE source = 'memory'").get();
  const lastOffset = state?.last_offset || 0;

  const memDb = new Database(memoryDbPath, { readonly: true });
  const rows = memDb.prepare(
    "SELECT id, type, summary, details, project, tags, timestamp FROM observations WHERE id > ? ORDER BY id ASC LIMIT 500"
  ).all(lastOffset);
  memDb.close();

  const chunks = [];
  let maxId = lastOffset;

  for (const row of rows) {
    const text = [
      row.type ? `[${row.type}]` : "",
      row.project ? `Project: ${row.project}` : "",
      row.summary || "",
      row.details || "",
    ].filter(Boolean).join("\n");

    if (text.length > 30) {
      chunks.push(...chunkText(text, {
        source: "memory",
        source_file: `observation:${row.id}`,
        date: row.timestamp?.slice(0, 10),
        tags: [row.type, row.project, "memory"].filter(Boolean).join(","),
      }));
    }

    maxId = Math.max(maxId, row.id);
  }

  if (maxId > lastOffset) {
    db.prepare("INSERT OR REPLACE INTO ingest_state (source, last_offset, last_run) VALUES ('memory', ?, datetime('now'))").run(maxId);
  }

  return chunks;
}

function ingestDocs(db) {
  // Ingest markdown docs from the project
  const docsDir = resolve(PROJECT_DIR, "docs");
  const memoryDir = resolve(PROJECT_DIR, "memory");

  const chunks = [];

  for (const dir of [docsDir, memoryDir]) {
    if (!existsSync(dir)) continue;

    const files = readdirSync(dir).filter(f => extname(f) === ".md");
    for (const file of files) {
      const filePath = join(dir, file);
      const stat = statSync(filePath);
      const content = readFileSync(filePath, "utf-8");

      chunks.push(...chunkText(content, {
        source: "docs",
        source_file: file,
        date: stat.mtime.toISOString().slice(0, 10),
        tags: "docs," + basename(file, ".md"),
      }));
    }
  }

  // Also ingest Claude memory files
  const claudeMemDir = resolve(HOME, `.claude/projects/-Users-${process.env.USER || "user"}/memory`);
  if (existsSync(claudeMemDir)) {
    const files = readdirSync(claudeMemDir).filter(f => extname(f) === ".md");
    for (const file of files) {
      const content = readFileSync(join(claudeMemDir, file), "utf-8");
      chunks.push(...chunkText(content, {
        source: "claude-memory",
        source_file: file,
        date: new Date().toISOString().slice(0, 10),
        tags: "memory,claude," + basename(file, ".md"),
      }));
    }
  }

  return chunks;
}

function ingestGitHistory(db) {
  // Ingest recent git commit messages for project context
  const { execSync } = require("child_process");

  const state = db.prepare("SELECT last_file FROM ingest_state WHERE source = 'git'").get();
  const lastHash = state?.last_file || "";

  try {
    const sinceArg = lastHash ? `${lastHash}..HEAD` : "--since='30 days ago'";
    const log = execSync(
      `git log ${sinceArg} --format='%H|||%ai|||%s|||%b' --no-merges 2>/dev/null`,
      { cwd: PROJECT_DIR, encoding: "utf-8", timeout: 10000 }
    ).trim();

    if (!log) return [];

    const chunks = [];
    let latestHash = lastHash;

    for (const line of log.split("\n").filter(Boolean)) {
      const [hash, date, subject, body] = line.split("|||");
      if (!hash || !subject) continue;

      const text = `Commit: ${subject}${body ? "\n" + body.trim() : ""}`;
      if (text.length > 30) {
        chunks.push(...chunkText(text, {
          source: "git",
          source_file: hash.slice(0, 8),
          date: date?.slice(0, 10),
          tags: "git,commit",
        }));
      }

      if (!latestHash) latestHash = hash;
    }

    // The first line is the newest commit
    const newestHash = log.split("\n")[0]?.split("|||")[0];
    if (newestHash) {
      db.prepare("INSERT OR REPLACE INTO ingest_state (source, last_file, last_run) VALUES ('git', ?, datetime('now'))").run(newestHash);
    }

    return chunks;
  } catch {
    return [];
  }
}

function ingestBrainData(db) {
  // Ingest brain reflections, ideas, and improvements
  const chunks = [];

  // Daily reflections
  const reflectionDir = resolve(PROJECT_DIR, "brain/reflection/daily");
  if (existsSync(reflectionDir)) {
    const state = db.prepare("SELECT last_file FROM ingest_state WHERE source = 'reflections'").get();
    const lastFile = state?.last_file || "";

    const files = readdirSync(reflectionDir)
      .filter(f => f.endsWith(".json") && f > lastFile)
      .sort();

    let latestFile = lastFile;
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(reflectionDir, file), "utf-8"));
        const parts = [`Reflection for ${data.date || file}`];
        if (data.conversationCount) parts.push(`${data.conversationCount} conversations`);
        if (data.gaps?.length > 0) parts.push(`Gaps: ${data.gaps.map(g => g.gap).join(", ")}`);
        if (data.topTopics?.length > 0) parts.push(`Topics: ${data.topTopics.join(", ")}`);

        const text = parts.join("\n");
        chunks.push(...chunkText(text, {
          source: "brain-reflection",
          source_file: file,
          date: data.date || file.replace(".json", ""),
          tags: "brain,reflection",
        }));
        latestFile = file;
      } catch { /* skip malformed */ }
    }

    if (latestFile > lastFile) {
      db.prepare("INSERT OR REPLACE INTO ingest_state (source, last_file, last_run) VALUES ('reflections', ?, datetime('now'))").run(latestFile);
    }
  }

  // Ideas
  const ideasFile = resolve(PROJECT_DIR, "brain/ideas/ideas.jsonl");
  if (existsSync(ideasFile)) {
    const state = db.prepare("SELECT last_offset FROM ingest_state WHERE source = 'ideas'").get();
    const lastOffset = state?.last_offset || 0;

    const content = readFileSync(ideasFile, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    for (let i = lastOffset; i < lines.length; i++) {
      try {
        const idea = JSON.parse(lines[i]);
        const text = `Idea [${idea.category}]: ${idea.title}\n${idea.description}`;
        chunks.push(...chunkText(text, {
          source: "brain-ideas",
          source_file: idea.id || `idea-${i}`,
          date: idea.timestamp?.slice(0, 10),
          tags: "brain,idea," + (idea.category || ""),
        }));
      } catch { /* skip */ }
    }

    if (lines.length > lastOffset) {
      db.prepare("INSERT OR REPLACE INTO ingest_state (source, last_offset, last_run) VALUES ('ideas', ?, datetime('now'))").run(lines.length);
    }
  }

  // Improvements / skill proposals
  const improvementsFile = resolve(PROJECT_DIR, "brain/reflection/improvements.jsonl");
  if (existsSync(improvementsFile)) {
    const state = db.prepare("SELECT last_offset FROM ingest_state WHERE source = 'improvements'").get();
    const lastOffset = state?.last_offset || 0;

    const content = readFileSync(improvementsFile, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    for (let i = lastOffset; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]);
        const text = `${entry.type}: ${entry.name || "unknown"}\n${entry.description || ""}\n${entry.reason || ""}`;
        chunks.push(...chunkText(text, {
          source: "brain-improvements",
          source_file: entry.name || `improvement-${i}`,
          date: entry.timestamp?.slice(0, 10),
          tags: "brain,improvement," + (entry.type || ""),
        }));
      } catch { /* skip */ }
    }

    if (lines.length > lastOffset) {
      db.prepare("INSERT OR REPLACE INTO ingest_state (source, last_offset, last_run) VALUES ('improvements', ?, datetime('now'))").run(lines.length);
    }
  }

  return chunks;
}

// ── CRAAP Pre-check ─────────────────────────────────────────────────────────

// Sources that skip CRAAP evaluation (internal ground truth)
const TRUSTED_SOURCES = new Set([
  "traces", "memory", "git", "brain-reflection",
  "brain-ideas", "brain-improvements", "claude-memory",
]);

let _craapModule = null;

async function getCraapModule() {
  if (_craapModule) return _craapModule;
  try {
    _craapModule = await import("./craap.mjs");
    return _craapModule;
  } catch {
    return null;
  }
}

/**
 * Run CRAAP evaluation on a chunk. Returns true if the chunk should be ingested.
 * Trusted internal sources always pass. External sources are scored.
 */
async function shouldIngest(chunk) {
  // Trusted internal sources are ground truth — assign a high default credibility
  if (TRUSTED_SOURCES.has(chunk.source)) return { pass: true, score: 0.85 };

  const craap = await getCraapModule();
  if (!craap) return { pass: true, score: null }; // if module unavailable, allow

  const result = craap.evaluateSource({
    text: chunk.text,
    date: chunk.date,
    source: chunk.source,
    source_file: chunk.source_file,
    tags: chunk.tags,
  });

  return {
    pass: result.recommendation !== "reject",
    score: result.score,
    recommendation: result.recommendation,
  };
}

// ── Main Pipeline ───────────────────────────────────────────────────────────

async function main() {
  console.log("[ingest] Starting RAG ingestion...");
  const db = getDb();

  // Collect chunks from all sources
  const allChunks = [
    ...ingestTraces(db),
    ...ingestMemory(db),
    ...ingestDocs(db),
    ...ingestGitHistory(db),
    ...ingestBrainData(db),
  ];

  console.log(`[ingest] ${allChunks.length} chunks to embed`);

  if (allChunks.length === 0) {
    console.log("[ingest] Nothing new to ingest");
    db.close();
    return;
  }

  // CRAAP pre-filter
  const craapEnabled = !process.argv.includes("--skip-craap");
  let rejected = 0;
  let reviewed = 0;
  let filteredChunks = allChunks;

  if (craapEnabled) {
    filteredChunks = [];
    for (const chunk of allChunks) {
      const check = await shouldIngest(chunk);
      if (check.pass) {
        chunk._credibilityScore = check.score;
        filteredChunks.push(chunk);
        if (check.recommendation === "review") reviewed++;
      } else {
        rejected++;
      }
    }

    if (rejected > 0 || reviewed > 0) {
      console.log(`[ingest] CRAAP filter: ${rejected} rejected, ${reviewed} flagged for review, ${filteredChunks.length} passed`);
    }
  }

  // Embed and store
  const insert = db.prepare(
    "INSERT INTO chunks (text, embedding, source, source_file, date, tags, credibility_score) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );

  let embedded = 0;
  let errors = 0;

  for (const chunk of filteredChunks) {
    try {
      const vec = await embed(chunk.text);
      insert.run(
        chunk.text,
        vecToBlob(vec),
        chunk.source,
        chunk.source_file || null,
        chunk.date || null,
        chunk.tags || null,
        chunk._credibilityScore ?? null,
      );
      embedded++;

      if (embedded % 50 === 0) {
        console.log(`[ingest] Embedded ${embedded}/${filteredChunks.length}...`);
      }
    } catch (err) {
      errors++;
      if (errors <= 3) console.error(`[ingest] Embed error: ${err.message}`);
    }
  }

  // Initialize graph schema so it's ready even if the async build hasn't run yet
  initGraphSchema(db);

  db.close();
  console.log(`[ingest] Done: ${embedded} embedded, ${errors} errors${rejected > 0 ? `, ${rejected} rejected by CRAAP` : ""}`);

  // Non-blocking: extract entities and build graph edges for new chunks.
  // Runs after db.close() with its own connection so it doesn't block the pipeline.
  if (embedded > 0) {
    console.log("[ingest] Building knowledge graph for new chunks...");
    buildGraph({ limit: embedded + 50, verbose: true })
      .then(result => {
        console.log(`[ingest] Graph built: ${result.processed} chunks, ${result.entities} entities, ${result.skipped} skipped`);
      })
      .catch(err => {
        console.error(`[ingest] Graph build error (non-fatal): ${err.message}`);
      });
  }
}

main().catch(err => {
  console.error("[ingest] Fatal:", err.message);
  process.exit(1);
});
