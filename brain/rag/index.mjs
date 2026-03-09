#!/usr/bin/env bun

// RAG Query Module
// Searches the knowledge base using cosine similarity on embeddings.
// Supports graph-boosted hybrid search via the knowledge graph.
//
// API:
//   import { search, graphSearch } from "./index.mjs";
//   const results = await search("patient portal", 5);
//   const hybrid = await graphSearch("patient portal", 5);
//
// CLI:
//   bun brain/rag/index.mjs "patient portal"
//   bun brain/rag/index.mjs --graph "patient portal"

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { resolve } from "path";
import { queryGraph } from "./graph.mjs";

const DB_PATH = resolve(import.meta.dir, "knowledge.db");
const OLLAMA_URL = "http://localhost:11434";
const EMBED_MODEL = "nomic-embed-text";

// ── Embedding ───────────────────────────────────────────────────────────────

async function embed(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`Embed failed: ${res.status}`);

  const data = await res.json();
  return new Float32Array(data.embeddings?.[0] || []);
}

// ── Vector Math ─────────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function blobToVec(blob) {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

// ── Search ──────────────────────────────────────────────────────────────────

/**
 * Search the RAG knowledge base.
 *
 * @param {string} query - Search query text
 * @param {number} topK - Number of results to return (default 5)
 * @param {object} opts - Optional filters
 * @param {string} opts.source - Filter by source type (traces, memory, docs, claude-memory)
 * @param {number} opts.minScore - Minimum cosine similarity score (default 0.3)
 * @returns {Promise<Array<{text: string, score: number, source: string, date: string}>>}
 */
export async function search(query, topK = 5, opts = {}) {
  if (!existsSync(DB_PATH)) return [];

  const db = new Database(DB_PATH, { readonly: true });

  // Get all chunks with embeddings
  let sql = "SELECT id, text, embedding, source, source_file, date, tags FROM chunks WHERE embedding IS NOT NULL";
  const params = [];

  if (opts.source) {
    sql += " AND source = ?";
    params.push(opts.source);
  }

  const rows = db.prepare(sql).all(...params);
  db.close();

  if (rows.length === 0) return [];

  // Embed the query
  const queryVec = await embed(query);
  const minScore = opts.minScore ?? 0.3;

  // Score all chunks by vector similarity
  const vectorScored = rows
    .map(row => ({
      id: row.id,
      text: row.text,
      score: cosineSimilarity(queryVec, blobToVec(row.embedding)),
      source: row.source,
      source_file: row.source_file,
      date: row.date,
      tags: row.tags,
    }))
    .filter(r => r.score >= minScore)
    .sort((a, b) => b.score - a.score);

  let results = vectorScored.slice(0, topK);

  // Graph-enhanced: pull in related chunks the vector search may have missed
  const useGraph = opts.graph !== false;
  if (useGraph) {
    const seenIds = new Set(results.map(r => r.id));
    const terms = query.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 3);

    for (const term of terms) {
      try {
        const { chunks: gChunks } = await queryGraph(term, { topChunks: 3 });
        for (const gc of gChunks) {
          if (!seenIds.has(gc.id)) {
            seenIds.add(gc.id);
            results.push({
              id: gc.id,
              text: gc.text,
              score: 0.35,
              source: gc.source,
              source_file: null,
              date: gc.date,
              tags: gc.tags,
              via: "graph",
            });
          }
        }
      } catch { /* graph unavailable, continue with vector results */ }
    }

    results.sort((a, b) => b.score - a.score);
    results = results.slice(0, topK);
  }

  return results;
}

// ── Graph-Boosted Search ─────────────────────────────────────────────────────

const GRAPH_BOOST = 0.05; // score bonus for chunks that also appear in graph results

/**
 * Hybrid search: vector similarity + knowledge graph.
 * Runs a normal embedding search and a graph entity query in parallel,
 * then boosts vector results that also have graph connections and
 * appends any graph-only chunks that passed the score threshold.
 *
 * @param {string} query - Search query text
 * @param {number} topK - Number of results to return (default 5)
 * @param {object} opts - Same opts as search(), plus:
 * @param {number} opts.graphBoost - Score bonus for graph-connected chunks (default 0.05)
 * @returns {Promise<Array<{text: string, score: number, source: string, date: string, graphBoosted: boolean}>>}
 */
export async function graphSearch(query, topK = 5, opts = {}) {
  const boost = opts.graphBoost ?? GRAPH_BOOST;

  // Run vector search and graph query in parallel
  const [vectorResults, graphResult] = await Promise.all([
    search(query, topK * 2, opts),  // fetch extra so we have room after merge
    queryGraph(query, { topChunks: topK * 2 }).catch(() => ({ entities: [], related: [], chunks: [] })),
  ]);

  // Build a set of chunk texts from the graph for quick lookup
  const graphChunkTexts = new Set(graphResult.chunks.map(c => c.text));

  // Also collect related entity names to check for term overlap
  const relatedNames = new Set([
    ...graphResult.entities.map(e => e.name.toLowerCase()),
    ...graphResult.related.map(e => e.name.toLowerCase()),
  ]);

  // Boost vector results that appear in graph chunks or match related entities
  const boostedResults = vectorResults.map(r => {
    let boosted = false;

    // Direct graph chunk match — this chunk is linked to a matching entity
    if (graphChunkTexts.has(r.text)) {
      boosted = true;
    }

    // Check if any related entity name appears in the chunk text
    if (!boosted && relatedNames.size > 0) {
      const lowerText = r.text.toLowerCase();
      for (const name of relatedNames) {
        if (name.length >= 3 && lowerText.includes(name)) {
          boosted = true;
          break;
        }
      }
    }

    return {
      ...r,
      score: boosted ? r.score + boost : r.score,
      graphBoosted: boosted,
    };
  });

  // Find graph-only chunks not already in vector results (add with a base score)
  const vectorTexts = new Set(vectorResults.map(r => r.text));
  const minScore = opts.minScore ?? 0.3;

  for (const gc of graphResult.chunks) {
    if (!vectorTexts.has(gc.text)) {
      // Graph-only chunk: give it a baseline score just above threshold
      boostedResults.push({
        text: gc.text,
        score: minScore + boost,
        source: gc.source,
        source_file: gc.source_file || null,
        date: gc.date,
        tags: gc.tags,
        graphBoosted: true,
      });
    }
  }

  // Re-sort and trim
  return boostedResults
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Get total chunk count and source breakdown.
 */
export function stats() {
  if (!existsSync(DB_PATH)) return { total: 0, sources: {} };

  const db = new Database(DB_PATH, { readonly: true });
  const total = db.prepare("SELECT COUNT(*) as count FROM chunks").get().count;
  const sources = {};
  for (const row of db.prepare("SELECT source, COUNT(*) as count FROM chunks GROUP BY source").all()) {
    sources[row.source] = row.count;
  }
  db.close();
  return { total, sources };
}

// ── CLI Mode ────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const useGraph = args.includes("--graph");
  const query = args.filter(a => a !== "--graph").join(" ");

  if (!query) {
    // Show stats
    const s = stats();
    console.log(`Knowledge base: ${s.total} chunks`);
    for (const [source, count] of Object.entries(s.sources)) {
      console.log(`  ${source}: ${count}`);
    }
    process.exit(0);
  }

  const mode = useGraph ? "graph-boosted" : "vector";
  console.log(`Searching (${mode}) for: "${query}"\n`);

  const results = useGraph
    ? await graphSearch(query, 5)
    : await search(query, 5);

  if (results.length === 0) {
    console.log("No results found.");
  } else {
    for (const r of results) {
      const graphTag = r.graphBoosted ? " [graph]" : "";
      console.log(`[${r.score.toFixed(3)}] ${r.source} (${r.date || "?"})${graphTag}`);
      console.log(`  ${r.text.slice(0, 200).replace(/\n/g, " ")}...`);
      console.log();
    }
  }
}
