#!/usr/bin/env bun

// The Forge — Ground-Truth Data Miner
// Uses REAL merged PR diffs and commit diffs as gold answers instead of Claude's responses.
// This produces higher-quality training data: the "correct answer" is code that was
// actually reviewed, approved, and merged by real developers.
//
// Strategy:
//   1. Find merged PRs on default branch (main/master/dev)
//   2. PR title + description = user prompt
//   3. Actual merged diff = gold answer
//   4. Feed prompt to both Claude and Ollama (cold, no context)
//   5. Score each model's output against the real diff
//   6. Store pair with ground-truth reference for training
//
// Usage:
//   bun ~/familiar/trainer/mine-ground-truth.mjs [--sources your-org,your-user] [--max-prs 10]

import { execSync } from "child_process";
import { appendFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash, randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = resolve(__dirname, "data", "raw");
const CLAUDE_URL = "http://127.0.0.1:18791";
const OLLAMA_URL = "http://localhost:11434";

// Gemini Flash — free tier (1500 req/day), used as default one-shot model
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || (() => {
  try {
    const env = readFileSync(resolve(__dirname, "..", "config", ".env"), "utf8");
    return env.match(/GEMINI_API_KEY=(.+)/)?.[1]?.trim();
  } catch { return null; }
})();
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

// --with-claude flag enables Claude one-shots (off by default to save rate limits)
const USE_CLAUDE = process.argv.includes("--with-claude");

if (!existsSync(RAW_DIR)) mkdirSync(RAW_DIR, { recursive: true });

// ── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_SOURCES = [
  // Add your own GitHub orgs here
  // { name: "your-org", maxRepos: 20, maxPRs: 8 },
  // { name: "your-username", maxRepos: 15, maxPRs: 6 },
  { name: "familiar-run", maxRepos: 10, maxPRs: 6 },
  // High-quality open source
  { name: "BloomTech-Labs", maxRepos: 200, maxPRs: 10 },
  { name: "vercel", maxRepos: 8, maxPRs: 5 },
  { name: "expressjs", maxRepos: 6, maxPRs: 5 },
  { name: "fastify", maxRepos: 5, maxPRs: 4 },
  { name: "sindresorhus", maxRepos: 10, maxPRs: 3 },
  { name: "pallets", maxRepos: 5, maxPRs: 4 },
  { name: "tiangolo", maxRepos: 5, maxPRs: 4 },
];

const DELAY_MS = 2000; // slightly slower since diffs are heavier API calls
const MAX_DIFF_SIZE = 15000; // chars — skip massive PRs
const MIN_DIFF_SIZE = 100; // chars — skip trivial PRs
const MAX_PROMPT_LENGTH = 4000; // truncate long PR descriptions

let pairsCollected = 0;
let pairsSkipped = 0;
let promptsSeen = new Set();

// Load existing prompt hashes for dedup
try {
  const { getDb } = await import("./forge-db.js");
  const db = getDb();
  const rows = db.prepare("SELECT prompt_hash FROM training_pairs").all();
  for (const r of rows) promptsSeen.add(r.prompt_hash);
  console.log(`  Loaded ${promptsSeen.size} existing prompt hashes for dedup\n`);
} catch {}

// ── Helpers ─────────────────────────────────────────────────────────────────

function gh(cmd) {
  try {
    return execSync(`gh ${cmd}`, {
      encoding: "utf8",
      timeout: 45000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function hashPrompt(p) {
  return createHash("sha256").update(p).digest("hex").slice(0, 16);
}
function todayFile() {
  return resolve(RAW_DIR, `${new Date().toISOString().slice(0, 10)}-gt.jsonl`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callGemini(prompt) {
  const start = Date.now();
  if (!GEMINI_API_KEY) return { response: null, durationMs: 0 };
  try {
    const resp = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      console.log(`    Gemini error ${resp.status}: ${err.slice(0, 100)}`);
      return { response: null, durationMs: Date.now() - start };
    }
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    return { response: text, durationMs: Date.now() - start };
  } catch (e) {
    console.log(`    Gemini call failed: ${e.message}`);
    return { response: null, durationMs: Date.now() - start };
  }
}

async function callClaude(prompt) {
  const start = Date.now();
  try {
    const resp = await fetch(`${CLAUDE_URL}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, model: "sonnet" }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!resp.ok) return { response: null, durationMs: Date.now() - start };
    const data = await resp.json();
    const text =
      typeof data.result === "string" ? data.result : JSON.stringify(data.result);
    return { response: text, durationMs: Date.now() - start };
  } catch {
    return { response: null, durationMs: Date.now() - start };
  }
}

async function callOllama(prompt) {
  const start = Date.now();
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "familiar-brain:latest",
        messages: [
          {
            role: "system",
            content:
              "You are Familiar, a persistent AI assistant from familiar.run. Write clean, well-structured code. Focus on the implementation, not explanation.",
          },
          { role: "user", content: prompt },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) return { response: null, durationMs: Date.now() - start };
    const data = await resp.json();
    return {
      response: data.message?.content ?? null,
      durationMs: Date.now() - start,
    };
  } catch {
    return { response: null, durationMs: Date.now() - start };
  }
}

// ── Similarity Scoring ──────────────────────────────────────────────────────

function extractCodeBlocks(text) {
  const blocks = [];
  const regex = /```[\w]*\n?([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks.join("\n");
}

function normalizeCode(code) {
  return code
    .replace(/\s+/g, " ")
    .replace(/['"]/g, "'")
    .trim()
    .toLowerCase();
}

function diffSimilarity(modelOutput, realDiff) {
  // Extract code from model output (it'll be in code blocks)
  const modelCode = normalizeCode(extractCodeBlocks(modelOutput) || modelOutput);
  const realCode = normalizeCode(realDiff);

  if (!modelCode || !realCode) return 0;

  // Token-level Jaccard similarity
  const modelTokens = new Set(modelCode.split(/\s+/));
  const realTokens = new Set(realCode.split(/\s+/));

  let intersection = 0;
  for (const t of modelTokens) {
    if (realTokens.has(t)) intersection++;
  }

  const union = modelTokens.size + realTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function extractKeyIdentifiers(diff) {
  // Pull function names, variable names, class names from the diff
  const identifiers = new Set();
  const patterns = [
    /(?:function|const|let|var|class|def|async)\s+(\w+)/g,
    /(\w+)\s*[=(]/g,
    /\.(\w+)\s*\(/g,
  ];
  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(diff)) !== null) {
      if (m[1].length > 2 && !/^(the|and|for|this|that|new|get|set|has|if|else)$/i.test(m[1])) {
        identifiers.add(m[1].toLowerCase());
      }
    }
  }
  return identifiers;
}

function identifierOverlap(modelOutput, realDiff) {
  const modelIds = extractKeyIdentifiers(modelOutput);
  const realIds = extractKeyIdentifiers(realDiff);

  if (realIds.size === 0) return 0;

  let hits = 0;
  for (const id of realIds) {
    if (modelIds.has(id)) hits++;
  }
  return hits / realIds.size;
}

function scoreAgainstGroundTruth(modelOutput, realDiff) {
  if (!modelOutput || !realDiff) return { total: 0, similarity: 0, identifiers: 0, hasCode: false };

  const similarity = diffSimilarity(modelOutput, realDiff);
  const idOverlap = identifierOverlap(modelOutput, realDiff);
  const hasCode = /```/.test(modelOutput);

  // Weighted score: 50% token similarity, 30% identifier overlap, 20% has code
  const total = similarity * 0.5 + idOverlap * 0.3 + (hasCode ? 0.2 : 0);

  return {
    total: Math.round(total * 100) / 100,
    similarity: Math.round(similarity * 100) / 100,
    identifiers: Math.round(idOverlap * 100) / 100,
    hasCode,
  };
}

// ── Prompt Builders ─────────────────────────────────────────────────────────

function prToPrompt(repo, pr) {
  let prompt = `You are working on the "${repo}" repository.\n\n`;
  prompt += `Implement the following change:\n`;
  prompt += `PR #${pr.number}: ${pr.title}\n`;

  if (pr.body) {
    const body = pr.body.slice(0, MAX_PROMPT_LENGTH);
    prompt += `\nDescription:\n${body}\n`;
  }

  prompt += `\nWrite the code changes needed. Show the actual file modifications with relevant code. Focus on the implementation, not explanation.`;
  return prompt;
}

function commitToPrompt(repo, commit) {
  let prompt = `You are working on the "${repo}" repository.\n\n`;
  prompt += `Implement the following change:\n`;
  prompt += `"${commit.message}"\n`;

  if (commit.files && commit.files.length > 0) {
    prompt += `\nFiles that should be modified: ${commit.files.join(", ")}\n`;
  }

  prompt += `\nWrite the code changes needed. Show the actual implementation. Focus on the code, not explanation.`;
  return prompt;
}

// ── Pair Collection ─────────────────────────────────────────────────────────

async function collectGroundTruthPair(prompt, realDiff, source, metadata = {}) {
  const hash = hashPrompt(prompt);
  if (promptsSeen.has(hash)) {
    pairsSkipped++;
    return;
  }
  promptsSeen.add(hash);

  console.log(`\n  Collecting ground-truth pair (${source})...`);
  console.log(`  Prompt: ${prompt.slice(0, 120)}...`);
  console.log(`  Real diff: ${realDiff.length} chars`);

  // All three models on every PR:
  //   Gemini Flash (free, silver) — always runs
  //   Claude (gold, best-effort) — runs unless --no-claude, gracefully skips on failure
  //   Local brain model (our model) — always runs
  const calls = [
    callGemini(prompt),
    callOllama(prompt),
  ];
  if (USE_CLAUDE) calls.push(callClaude(prompt));

  const results = await Promise.all(calls);
  const gemini = results[0];
  const local = results[1];
  const claude = USE_CLAUDE ? results[2] : { response: null, durationMs: 0 };

  // Need at least one model to respond
  if (!gemini.response && !claude.response && !local.response) {
    console.log(`  SKIP: all models failed to respond`);
    pairsSkipped++;
    return;
  }

  // Score all three against the real merged diff
  const geminiScore = scoreAgainstGroundTruth(gemini.response, realDiff);
  const localScore = scoreAgainstGroundTruth(local.response, realDiff);
  const claudeScore = claude.response
    ? scoreAgainstGroundTruth(claude.response, realDiff)
    : { total: 0, similarity: 0, identifiers: 0, hasCode: false };

  const pair = {
    id: `gt_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    timestamp: new Date().toISOString(),
    prompt,
    prompt_hash: hash,
    type: "ground_truth",
    source,
    ground_truth_diff: realDiff,
    training_eligible: true,
    data_source: "ground_truth_miner",
    gold_source: "ground_truth_diff",
    // Gemini Flash (silver — free, always present) — eval-only metadata
    gemini_response: gemini.response,
    gemini_duration_ms: gemini.durationMs,
    gemini_score: geminiScore,
    // Claude (gold — best-effort, eval-only metadata, NOT used as training target)
    claude_response: claude.response,
    claude_duration_ms: claude.durationMs,
    claude_score: claudeScore,
    // Local brain model (our model being trained)
    local_response: local.response,
    local_duration_ms: local.durationMs,
    local_score: localScore,
    local_model: "familiar-brain:latest",
    // Metadata from the PR/commit
    ...metadata,
  };

  appendFileSync(todayFile(), JSON.stringify(pair) + "\n");

  // Record in DB — use best external score as complexity proxy
  const bestExternal = Math.max(geminiScore.total, claudeScore.total);
  try {
    const { recordPair } = await import("./forge-db.js");
    recordPair({
      id: pair.id,
      prompt_hash: hash,
      timestamp: pair.timestamp,
      complexity_score: bestExternal,
      routed_to: "ground_truth",
      claude_response_length: claude.response?.length ?? 0,
      local_response_length: local.response?.length ?? 0,
      claude_duration_ms: claude.durationMs,
      local_duration_ms: local.durationMs,
      local_model: "familiar-brain:latest",
      has_code: geminiScore.hasCode || claudeScore.hasCode || localScore.hasCode,
      training_eligible: true,
      data_source: "ground_truth_miner",
      gold_source: "ground_truth_diff",
    });
  } catch {}

  pairsCollected++;
  let scoreLog = `Gemini: ${geminiScore.total.toFixed(2)}`;
  scoreLog += ` | Local: ${localScore.total.toFixed(2)}`;
  if (claude.response) scoreLog += ` | Claude: ${claudeScore.total.toFixed(2)}`;
  else if (USE_CLAUDE) scoreLog += ` | Claude: skipped`;
  console.log(`  SAVED ${pair.id} | ${scoreLog} [total: ${pairsCollected}]`);
}

// ── Mine Merged PRs ─────────────────────────────────────────────────────────

async function mineMergedPRs(orgName, repoName, maxPRs) {
  console.log(`\n  Mining merged PRs from ${orgName}/${repoName}...`);

  // Get recently merged PRs — include baseRefName to filter for main/master/dev
  const prJson = gh(
    `pr list --repo ${orgName}/${repoName} --state merged --limit ${maxPRs * 3} --json number,title,body,author,mergedAt,additions,deletions,baseRefName`
  );
  if (!prJson) {
    console.log(`    No merged PRs found`);
    return 0;
  }

  let prs;
  try {
    prs = JSON.parse(prJson);
  } catch {
    return 0;
  }

  let collected = 0;
  let skippedBranch = 0;

  for (const pr of prs) {
    if (collected >= maxPRs) break;

    // STRICT: Only PRs merged into main/master/dev (not feature→feature)
    const base = (pr.baseRefName || "").toLowerCase();
    if (base && !["main", "master", "dev", "develop", "production"].includes(base)) {
      skippedBranch++;
      continue;
    }

    // Skip trivial PRs
    if (!pr.title || pr.title.length < 15) continue;
    if (/^bump|^update deps|^chore\(deps\)|^dependabot|^renovate|^\[bot\]|^merge branch/i.test(pr.title)) continue;
    if ((pr.additions || 0) + (pr.deletions || 0) < 10) continue;
    if ((pr.additions || 0) + (pr.deletions || 0) > 2000) continue; // too big

    // Get the actual diff
    const diff = gh(`pr diff --repo ${orgName}/${repoName} ${pr.number}`);
    if (!diff) continue;
    if (diff.length < MIN_DIFF_SIZE || diff.length > MAX_DIFF_SIZE) continue;

    // Skip if diff is mostly binary, lock files, or generated
    if (/Binary files|package-lock\.json|yarn\.lock|\.min\.js/.test(diff.slice(0, 2000))) continue;

    const prompt = prToPrompt(repoName, pr);
    await collectGroundTruthPair(prompt, diff, `pr:${orgName}/${repoName}#${pr.number}`, {
      pr_number: pr.number,
      pr_title: pr.title,
      pr_author: pr.author?.login,
      pr_merged_at: pr.mergedAt,
    });

    collected++;
    await sleep(DELAY_MS);
  }

  if (skippedBranch > 0) console.log(`    (skipped ${skippedBranch} PRs not targeting main/master/dev)`);
  return collected;
}

// ── Mine Commits with Diffs ─────────────────────────────────────────────────
// STRICT: Only mine merge commits (PRs merged into default branch).
// Skip raw commits — they're often WIP saves, progress pushes, or incomplete work.

async function mineCommits(orgName, repoName, maxCommits = 5) {
  console.log(`  Mining merge commits from ${orgName}/${repoName}...`);

  // Get merge commits only (2 parents = merge commit from a PR)
  // This filters out direct pushes, WIP saves, and progress commits
  const commitData = gh(
    `api repos/${orgName}/${repoName}/commits?per_page=${maxCommits * 4} --jq '[.[] | select(.parents | length == 2)] | .[:${maxCommits * 2}] | .[] | .sha + "|||" + .commit.message + "|||" + (.files // [] | map(.filename) | join(","))'`
  );
  if (!commitData) return 0;

  let collected = 0;

  for (const line of commitData.split("\n")) {
    if (collected >= maxCommits) break;
    if (!line.trim()) continue;

    const parts = line.split("|||");
    const sha = parts[0];
    const fullMsg = parts[1] || "";
    const filesStr = parts[2] || "";

    // Extract the actual PR title from merge commit message
    // Format: "Merge pull request #123 from user/branch\n\nActual title"
    // or: "Title (#123)"
    let message = fullMsg.split("\n")[0]; // first line
    const prMergeMatch = fullMsg.match(/Merge pull request #\d+.*?\n\n(.+)/s);
    if (prMergeMatch) message = prMergeMatch[1].split("\n")[0];

    if (!message || message.length < 15) continue;
    if (/^bump|^update deps|^chore\(deps\)|^dependabot|^renovate|^\[bot\]/i.test(message)) continue;

    // Get the commit diff
    const diff = gh(`api repos/${orgName}/${repoName}/commits/${sha} --jq '.files | map("--- " + .filename + "\\n" + (.patch // "")) | join("\\n\\n")'`);
    if (!diff || diff.length < MIN_DIFF_SIZE || diff.length > MAX_DIFF_SIZE) continue;

    // Skip lock files, generated code
    if (/package-lock\.json|yarn\.lock|\.min\.js/.test(diff.slice(0, 1000))) continue;

    const files = filesStr.split(",").filter(Boolean);
    const prompt = commitToPrompt(repoName, { message, files });
    await collectGroundTruthPair(prompt, diff, `commit:${orgName}/${repoName}@${sha.slice(0, 7)}`, {
      commit_sha: sha,
      commit_message: message,
    });

    collected++;
    await sleep(DELAY_MS);
  }

  return collected;
}

// ── Mine a Single Org/User ──────────────────────────────────────────────────

async function mineSource(source) {
  const { name: orgName, maxRepos, maxPRs } = source;

  console.log(`\n${"█".repeat(60)}`);
  console.log(`  SOURCE: ${orgName} (ground-truth mining)`);
  console.log(`${"█".repeat(60)}`);

  // List repos sorted by most recently pushed
  const repoJson = gh(
    `repo list ${orgName} --limit ${maxRepos * 2} --json name,pushedAt,isArchived --jq '[.[] | select(.isArchived == false)]'`
  );
  if (!repoJson) {
    console.log(`  Failed to list repos for ${orgName}`);
    return;
  }

  let repos;
  try {
    repos = JSON.parse(repoJson);
  } catch {
    console.log(`  Failed to parse repo list for ${orgName}`);
    return;
  }

  repos.sort((a, b) => new Date(b.pushedAt) - new Date(a.pushedAt));
  repos = repos.slice(0, maxRepos);
  console.log(`  Found ${repos.length} active repos\n`);

  for (const repo of repos) {
    const repoName = repo.name;
    console.log(`\n${"─".repeat(50)}`);
    console.log(`  REPO: ${orgName}/${repoName}`);
    console.log(`${"─".repeat(50)}`);

    // Mine merged PRs (primary source — these have review + approval)
    const prCount = await mineMergedPRs(orgName, repoName, maxPRs);

    // Mine commits (secondary — less context but more volume)
    const commitCount = await mineCommits(orgName, repoName, Math.max(2, maxPRs - prCount));

    console.log(`  → ${prCount} PRs + ${commitCount} commits from ${repoName}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Parse CLI args
  const args = process.argv.slice(2);
  let sources = DEFAULT_SOURCES;
  let maxPRsOverride = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sources" && args[i + 1]) {
      const names = args[i + 1].split(",");
      sources = names.map((name) => ({
        name: name.trim(),
        maxRepos: 15,
        maxPRs: 6,
      }));
      i++;
    } else if (args[i] === "--max-prs" && args[i + 1]) {
      maxPRsOverride = parseInt(args[i + 1]);
      i++;
    }
  }

  if (maxPRsOverride) {
    sources = sources.map((s) => ({ ...s, maxPRs: maxPRsOverride }));
  }

  console.log("=== The Forge — Ground-Truth Data Miner ===");
  console.log(`  Strategy: Real merged code as gold standard`);
  console.log(`  Models: Gemini Flash (silver) + familiar-brain (local)${USE_CLAUDE ? " + Claude (gold)" : ""}`);
  console.log(`  Claude: ${USE_CLAUDE ? "ON (--with-claude)" : "OFF (use --with-claude to enable)"}`);
  console.log(`  Gemini API key: ${GEMINI_API_KEY ? "set" : "MISSING — set GEMINI_API_KEY"}`);
  console.log(`  Sources: ${sources.map((s) => s.name).join(", ")}`);
  console.log(`  Existing pairs: ${promptsSeen.size}`);
  console.log("");

  for (const source of sources) {
    await mineSource(source);
  }

  console.log(`\n${"█".repeat(60)}`);
  console.log(`  GROUND-TRUTH MINING COMPLETE`);
  console.log(`  New pairs collected: ${pairsCollected}`);
  console.log(`  Skipped (dupes/too-small/too-big): ${pairsSkipped}`);
  console.log(`  Total in DB: ${promptsSeen.size}`);
  console.log(`  Output file: ${todayFile()}`);
  console.log(`${"█".repeat(60)}`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
