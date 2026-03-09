#!/usr/bin/env bun
/**
 * Retroactively classify all untagged training pairs.
 * Updates both raw JSONL files (adds/fixes task_type) and the forge DB.
 */

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { classifyPrompt } from "./classify.mjs";
import { getDb } from "./forge-db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = resolve(__dirname, "data", "raw");

// ── Step 1: Retag raw JSONL files ──────────────────────────────────────────

console.log("=== Retagging raw JSONL files ===");

const files = readdirSync(RAW_DIR).filter(f => f.endsWith(".jsonl")).sort();
let totalPairs = 0;
let retagged = 0;
let alreadyTagged = 0;
const typeCounts = {};

for (const file of files) {
  const path = resolve(RAW_DIR, file);
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  let changed = false;
  const updated = [];

  for (const line of lines) {
    try {
      const pair = JSON.parse(line);
      totalPairs++;

      if (!pair.task_type || pair.task_type === "") {
        // Classify it
        const claude = pair.claude_response || pair.ground_truth_diff || "";
        const classification = classifyPrompt(pair.prompt || "", {
          hasCode: /```/.test(claude),
          hasToolCalls: /\[Tool:/.test(claude) || /tool_use|tool_calls/.test(claude),
          responseLength: claude.length,
        });
        pair.task_type = classification.type;
        pair.task_type_confidence = classification.confidence;
        changed = true;
        retagged++;
      } else {
        alreadyTagged++;
      }

      typeCounts[pair.task_type] = (typeCounts[pair.task_type] || 0) + 1;
      updated.push(JSON.stringify(pair));
    } catch {
      updated.push(line); // preserve unparseable lines
    }
  }

  if (changed) {
    writeFileSync(path, updated.join("\n") + "\n");
  }
}

console.log(`  Files scanned: ${files.length}`);
console.log(`  Total pairs: ${totalPairs}`);
console.log(`  Already tagged: ${alreadyTagged}`);
console.log(`  Newly tagged: ${retagged}`);
console.log(`  Distribution:`);
for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
  const pct = ((count / totalPairs) * 100).toFixed(1);
  console.log(`    ${type}: ${count} (${pct}%)`);
}

// ── Step 2: Retag DB entries ──────────────────────────────────────────────

console.log("\n=== Retagging forge DB ===");

const db = getDb();
const untaggedRows = db.prepare(
  "SELECT id, prompt_hash FROM training_pairs WHERE task_type IS NULL OR task_type = ''"
).all();

console.log(`  Untagged DB rows: ${untaggedRows.length}`);

if (untaggedRows.length > 0) {
  // Build a hash→type lookup from the newly tagged raw files
  const hashToType = {};
  for (const file of files) {
    const path = resolve(RAW_DIR, file);
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const pair = JSON.parse(line);
        if (pair.prompt_hash && pair.task_type) {
          hashToType[pair.prompt_hash] = {
            type: pair.task_type,
            confidence: pair.task_type_confidence || 0.5,
          };
        }
      } catch {}
    }
  }

  const update = db.prepare(
    "UPDATE training_pairs SET task_type = ?, task_type_confidence = ? WHERE id = ?"
  );

  let dbUpdated = 0;
  let dbMissed = 0;

  const tx = db.transaction(() => {
    for (const row of untaggedRows) {
      const match = hashToType[row.prompt_hash];
      if (match) {
        update.run(match.type, match.confidence, row.id);
        dbUpdated++;
      } else {
        // No matching raw pair — classify from prompt hash alone won't work,
        // but at least mark it as "chat" (safe default) so it's not null
        update.run("chat", 0.3, row.id);
        dbMissed++;
      }
    }
  });
  tx();

  console.log(`  DB updated: ${dbUpdated}`);
  console.log(`  DB defaulted to chat: ${dbMissed}`);
}

// Final DB distribution
const dbDist = db.prepare(
  "SELECT task_type, COUNT(*) as count FROM training_pairs GROUP BY task_type ORDER BY count DESC"
).all();
const dbTotal = db.prepare("SELECT COUNT(*) as count FROM training_pairs").get().count;

console.log(`\n=== Final DB distribution (${dbTotal} total) ===`);
for (const row of dbDist) {
  const pct = ((row.count / dbTotal) * 100).toFixed(1);
  console.log(`  ${row.task_type || "(null)"}: ${row.count} (${pct}%)`);
}

console.log("\nDone.");
