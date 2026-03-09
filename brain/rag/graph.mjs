#!/usr/bin/env bun

// Knowledge Graph Module
// Extracts entities from RAG chunks and builds a co-occurrence relationship graph.
// Stored in the same knowledge.db alongside the chunks table.
//
// API:
//   import { queryGraph, graphStats } from "./graph.mjs";
//   const { entities, related, chunks } = await queryGraph("typescript");
//
// CLI:
//   bun brain/rag/graph.mjs           -- show stats
//   bun brain/rag/graph.mjs build     -- extract entities from new chunks
//   bun brain/rag/graph.mjs query <term>

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { resolve } from "path";

const DB_PATH = resolve(import.meta.dir, "knowledge.db");
const OLLAMA_URL = "http://localhost:11434";
const EXTRACT_MODEL = "llama3.2";

// ── Schema ───────────────────────────────────────────────────────────────────

export function initGraphSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'concept',
      mention_count INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name, type)
    );
    CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

    CREATE TABLE IF NOT EXISTS entity_chunks (
      entity_id INTEGER NOT NULL,
      chunk_id INTEGER NOT NULL,
      PRIMARY KEY (entity_id, chunk_id),
      FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_entity_chunks_entity ON entity_chunks(entity_id);
    CREATE INDEX IF NOT EXISTS idx_entity_chunks_chunk ON entity_chunks(chunk_id);

    CREATE TABLE IF NOT EXISTS relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_entity INTEGER NOT NULL,
      to_entity INTEGER NOT NULL,
      relation TEXT NOT NULL DEFAULT 'co-occurs',
      weight REAL DEFAULT 1.0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(from_entity, to_entity, relation),
      FOREIGN KEY (from_entity) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (to_entity) REFERENCES entities(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(from_entity);
    CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(to_entity);

    CREATE TABLE IF NOT EXISTS graph_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

// ── Entity Extraction ────────────────────────────────────────────────────────

async function extractEntitiesLLM(text) {
  const snippet = text.slice(0, 800);
  const prompt = `Extract named entities from this text. Output a JSON array only, no explanation.
Each entity: {"name": "EntityName", "type": "person|project|technology|concept|organization"}
Rules: names only (no pronouns), max 8 entities, skip generic words.

Text: ${snippet}

JSON:`;

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: EXTRACT_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0, num_predict: 256 },
    }),
    signal: AbortSignal.timeout(25000),
  });

  if (!res.ok) throw new Error(`Generate failed: ${res.status}`);
  const data = await res.json();

  const match = data.response?.match(/\[[\s\S]*?\]/);
  if (!match) return [];

  const parsed = JSON.parse(match[0]);
  return parsed
    .filter(e => e?.name && e?.type && typeof e.name === "string")
    .map(e => ({ name: e.name.trim(), type: e.type.trim() }))
    .slice(0, 8);
}

function extractEntitiesHeuristic(text) {
  const entities = [];
  const seen = new Set();

  // Multi-word capitalized phrases (project/org names)
  const phraseRe = /\b([A-Z][a-z]{1,20}(?:\s[A-Z][a-z]{1,20})+)\b/g;
  for (const [, phrase] of text.matchAll(phraseRe)) {
    const key = phrase.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      entities.push({ name: phrase, type: "concept" });
    }
  }

  // camelCase or PascalCase identifiers (technology names)
  const techRe = /\b([A-Z][a-z]+[A-Z]\w{1,30}|[a-z]{2,}[A-Z]\w{1,30})\b/g;
  for (const [, word] of text.matchAll(techRe)) {
    const key = word.toLowerCase();
    if (!seen.has(key) && word.length <= 40) {
      seen.add(key);
      entities.push({ name: word, type: "technology" });
    }
  }

  // Single capitalized words that look like proper nouns (not sentence starts)
  const properRe = /(?<=[.!?]\s{0,3}|\n|:\s)([A-Z][a-z]{3,20})\b/g;
  for (const [, word] of text.matchAll(properRe)) {
    const key = word.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      entities.push({ name: word, type: "concept" });
    }
  }

  return entities.slice(0, 12);
}

async function extractEntities(text) {
  try {
    const llmEntities = await extractEntitiesLLM(text);
    if (llmEntities.length > 0) return llmEntities;
  } catch {
    // Fall through to heuristic
  }
  return extractEntitiesHeuristic(text);
}

// ── Graph Building ───────────────────────────────────────────────────────────

function upsertEntity(db, name, type) {
  const existing = db.prepare("SELECT id FROM entities WHERE name = ? AND type = ?").get(name, type);
  if (existing) {
    db.prepare("UPDATE entities SET mention_count = mention_count + 1 WHERE id = ?").run(existing.id);
    return existing.id;
  }
  const result = db.prepare("INSERT INTO entities (name, type) VALUES (?, ?)").run(name, type);
  return result.lastInsertRowid;
}

function linkEntityToChunk(db, entityId, chunkId) {
  db.prepare("INSERT OR IGNORE INTO entity_chunks (entity_id, chunk_id) VALUES (?, ?)").run(entityId, chunkId);
}

function upsertRelationship(db, fromId, toId, relation = "co-occurs") {
  if (fromId === toId) return;
  const [a, b] = fromId < toId ? [fromId, toId] : [toId, fromId];
  const existing = db.prepare(
    "SELECT id, weight FROM relationships WHERE from_entity = ? AND to_entity = ? AND relation = ?"
  ).get(a, b, relation);

  if (existing) {
    db.prepare("UPDATE relationships SET weight = weight + 0.5 WHERE id = ?").run(existing.id);
  } else {
    db.prepare(
      "INSERT INTO relationships (from_entity, to_entity, relation, weight) VALUES (?, ?, ?, 1.0)"
    ).run(a, b, relation);
  }
}

/**
 * Process new chunks and extract entities into the graph.
 * @param {object} opts
 * @param {number} opts.limit - max chunks to process per run (default 100)
 * @param {boolean} opts.verbose - print progress (default false)
 */
export async function buildGraph(opts = {}) {
  const { limit = 100, verbose = false } = opts;

  if (!existsSync(DB_PATH)) return { processed: 0, entities: 0, skipped: 0 };

  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode=WAL");
  initGraphSchema(db);

  // Track last processed chunk id
  const stateRow = db.prepare("SELECT value FROM graph_state WHERE key = 'last_chunk_id'").get();
  const lastChunkId = parseInt(stateRow?.value || "0", 10);

  // Get unprocessed chunks
  const chunks = db.prepare(
    "SELECT id, text, source FROM chunks WHERE id > ? ORDER BY id ASC LIMIT ?"
  ).all(lastChunkId, limit);

  if (chunks.length === 0) {
    if (verbose) console.log("[graph] No new chunks to process");
    db.close();
    return { processed: 0, entities: 0, skipped: 0 };
  }

  let processed = 0;
  let skipped = 0;
  let entityCount = 0;
  let maxId = lastChunkId;

  for (const chunk of chunks) {
    const rawEntities = await extractEntities(chunk.text);

    if (rawEntities.length === 0) {
      skipped++;
      maxId = Math.max(maxId, chunk.id);
      continue;
    }

    // Insert entities and link to chunk
    const entityIds = [];
    for (const e of rawEntities) {
      const eid = upsertEntity(db, e.name, e.type);
      linkEntityToChunk(db, eid, chunk.id);
      entityIds.push(eid);
      entityCount++;
    }

    // Build co-occurrence relationships for entities in the same chunk
    for (let i = 0; i < entityIds.length; i++) {
      for (let j = i + 1; j < entityIds.length; j++) {
        upsertRelationship(db, entityIds[i], entityIds[j]);
      }
    }

    processed++;
    maxId = Math.max(maxId, chunk.id);

    if (verbose && processed % 10 === 0) {
      process.stdout.write(`\r[graph] Processed ${processed}/${chunks.length}...`);
    }
  }

  // Update state
  db.prepare("INSERT OR REPLACE INTO graph_state (key, value) VALUES ('last_chunk_id', ?)").run(String(maxId));
  db.prepare("INSERT OR REPLACE INTO graph_state (key, value) VALUES ('last_build', ?)").run(new Date().toISOString());

  db.close();

  if (verbose) {
    console.log(`\n[graph] Done: ${processed} chunks processed, ${entityCount} entity mentions, ${skipped} skipped`);
  }

  return { processed, entities: entityCount, skipped };
}

// ── Graph Query ──────────────────────────────────────────────────────────────

/**
 * Query the knowledge graph for an entity and its relationships.
 *
 * @param {string} term - Entity name to search for
 * @param {object} opts
 * @param {number} opts.depth - Relationship traversal depth (default 1)
 * @param {number} opts.topChunks - Number of related chunks to return (default 5)
 * @returns {Promise<{entities: Array, related: Array, chunks: Array}>}
 */
export async function queryGraph(term, opts = {}) {
  const { depth = 1, topChunks = 5 } = opts;
  if (!existsSync(DB_PATH)) return { entities: [], related: [], chunks: [] };

  const db = new Database(DB_PATH, { readonly: true });

  // Find matching entities (case-insensitive substring)
  const matchingEntities = db.prepare(
    "SELECT id, name, type, mention_count FROM entities WHERE name LIKE ? ORDER BY mention_count DESC LIMIT 10"
  ).all(`%${term}%`);

  if (matchingEntities.length === 0) {
    db.close();
    return { entities: [], related: [], chunks: [] };
  }

  const entityIds = matchingEntities.map(e => e.id);
  const placeholders = entityIds.map(() => "?").join(",");

  // Find related entities via relationships
  const related = db.prepare(`
    SELECT e.id, e.name, e.type, e.mention_count, r.weight, r.relation
    FROM relationships r
    JOIN entities e ON (
      CASE WHEN r.from_entity IN (${placeholders}) THEN r.to_entity ELSE r.from_entity END = e.id
    )
    WHERE r.from_entity IN (${placeholders}) OR r.to_entity IN (${placeholders})
    AND e.id NOT IN (${placeholders})
    ORDER BY r.weight DESC
    LIMIT 20
  `).all(...entityIds, ...entityIds, ...entityIds, ...entityIds);

  // Find associated chunks
  const chunkRows = db.prepare(`
    SELECT DISTINCT c.id, c.text, c.source, c.date, c.tags
    FROM chunks c
    JOIN entity_chunks ec ON ec.chunk_id = c.id
    WHERE ec.entity_id IN (${placeholders})
    ORDER BY c.id DESC
    LIMIT ?
  `).all(...entityIds, topChunks);

  db.close();

  return {
    entities: matchingEntities,
    related: related.filter(r => !entityIds.includes(r.id)),
    chunks: chunkRows,
  };
}

/**
 * Return graph statistics.
 */
export function graphStats() {
  if (!existsSync(DB_PATH)) return { entities: 0, relationships: 0, linkedChunks: 0 };

  const db = new Database(DB_PATH, { readonly: true });

  let entities = 0, relationships = 0, linkedChunks = 0, lastBuild = null;

  try {
    entities = db.prepare("SELECT COUNT(*) as c FROM entities").get()?.c ?? 0;
    relationships = db.prepare("SELECT COUNT(*) as c FROM relationships").get()?.c ?? 0;
    linkedChunks = db.prepare("SELECT COUNT(DISTINCT chunk_id) as c FROM entity_chunks").get()?.c ?? 0;
    lastBuild = db.prepare("SELECT value FROM graph_state WHERE key = 'last_build'").get()?.value ?? null;
  } catch {
    // Tables may not exist yet
  }

  db.close();
  return { entities, relationships, linkedChunks, lastBuild };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);

  if (!cmd || cmd === "stats") {
    const s = graphStats();
    console.log(`Knowledge graph:`);
    console.log(`  Entities:      ${s.entities}`);
    console.log(`  Relationships: ${s.relationships}`);
    console.log(`  Linked chunks: ${s.linkedChunks}`);
    console.log(`  Last build:    ${s.lastBuild || "never"}`);
    process.exit(0);
  }

  if (cmd === "build") {
    const limit = arg ? parseInt(arg, 10) : 100;
    console.log(`[graph] Building graph (limit: ${limit} chunks)...`);
    const result = await buildGraph({ limit, verbose: true });
    console.log(`[graph] Result:`, result);
    process.exit(0);
  }

  if (cmd === "query") {
    if (!arg) {
      console.error("Usage: bun graph.mjs query <term>");
      process.exit(1);
    }
    console.log(`Querying graph for: "${arg}"\n`);
    const result = await queryGraph(arg);

    if (result.entities.length === 0) {
      console.log("No entities found.");
      process.exit(0);
    }

    console.log("Matched entities:");
    for (const e of result.entities) {
      console.log(`  [${e.type}] ${e.name} (${e.mention_count} mentions)`);
    }

    if (result.related.length > 0) {
      console.log("\nRelated entities:");
      for (const r of result.related.slice(0, 10)) {
        console.log(`  [${r.type}] ${r.name} — ${r.relation} (weight: ${r.weight?.toFixed(1)})`);
      }
    }

    if (result.chunks.length > 0) {
      console.log("\nAssociated chunks:");
      for (const c of result.chunks) {
        console.log(`  [${c.source}] ${c.text.slice(0, 150).replace(/\n/g, " ")}...`);
      }
    }
    process.exit(0);
  }

  console.error(`Unknown command: ${cmd}`);
  console.error("Usage: bun graph.mjs [stats|build [limit]|query <term>]");
  process.exit(1);
}
