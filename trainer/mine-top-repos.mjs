#!/usr/bin/env bun

// The Forge — Top Repos Ground-Truth Miner
// Discovers top-starred GitHub repos per language and mines merged PRs.
// Merged diff = gold standard, PR title+body = prompt.
// Feeds to both Claude and familiar-coder, scores against gold, stores for training.
//
// Usage:
//   bun ~/familiar/trainer/mine-top-repos.mjs [--langs js,py,go] [--max-repos 100] [--max-prs 5] [--refresh]

import { execSync } from "child_process";
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash, randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = resolve(__dirname, "data", "raw");
const DATA_DIR = resolve(__dirname, "data");
const CLAUDE_URL = "http://127.0.0.1:18791";
const OLLAMA_URL = "http://localhost:11434";

const REPOS_CACHE = resolve(DATA_DIR, "top-repos.json");
const PROGRESS_FILE = resolve(DATA_DIR, "top-repos-progress.json");
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

if (!existsSync(RAW_DIR)) mkdirSync(RAW_DIR, { recursive: true });

// ── Config ──────────────────────────────────────────────────────────────────

const LANGUAGE_COUNTS = {
  javascript: 1000,
  typescript: 1000,
  python: 1000,
  java: 1000,
  rust: 1000,
  c: 1000,
  cpp: 1000,
  go: 15,
  ruby: 10,
};

// Short aliases for CLI --langs flag
const LANG_ALIASES = {
  js: "javascript",
  ts: "typescript",
  py: "python",
};

const DELAY_MS = 2000;
const SEARCH_DELAY_MS = 3000;
const MAX_DIFF_SIZE = 15000;
const MIN_DIFF_SIZE = 100;
const MAX_PROMPT_LENGTH = 4000;

// Repos that are curated lists, not real codebases
const DOCS_REPO_PATTERNS = [
  /^awesome-/i,
  /^interview/i,
  /^free-programming/i,
  /^coding-interview/i,
  /^system-design/i,
  /^the-art-of/i,
  /^learn-/i,
  /^cheatsheet/i,
  /^curated/i,
  /^list-of/i,
  /^resources/i,
  /^guide$/i,
  /^tutorials?$/i,
  /^examples?$/i,
];

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
        model: "familiar-coder:latest",
        messages: [
          {
            role: "system",
            content:
              "You are Engie, a familiar from familiar.run — an expert coding assistant. Write clean, well-structured code with clear explanations.",
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
  const modelCode = normalizeCode(extractCodeBlocks(modelOutput) || modelOutput);
  const realCode = normalizeCode(realDiff);

  if (!modelCode || !realCode) return 0;

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

  const total = similarity * 0.5 + idOverlap * 0.3 + (hasCode ? 0.2 : 0);

  return {
    total: Math.round(total * 100) / 100,
    similarity: Math.round(similarity * 100) / 100,
    identifiers: Math.round(idOverlap * 100) / 100,
    hasCode,
  };
}

// ── Prompt Builder ──────────────────────────────────────────────────────────

function prToPrompt(repo, language, description, pr) {
  let prompt = `You are working on the "${repo}" repository (${language}).`;
  if (description) {
    prompt += ` ${description.slice(0, 200)}`;
  }
  prompt += `\n\nImplement the following change:\n`;
  prompt += `PR #${pr.number}: ${pr.title}\n`;

  if (pr.body) {
    const body = pr.body.slice(0, MAX_PROMPT_LENGTH);
    prompt += `\nDescription:\n${body}\n`;
  }

  prompt += `\nWrite the code changes needed. Show the actual file modifications with relevant code. Focus on the implementation, not explanation.`;
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

  const [claude, local] = await Promise.all([
    callClaude(prompt),
    callOllama(prompt),
  ]);

  if (!claude.response && !local.response) {
    console.log(`  SKIP: both models failed to respond`);
    pairsSkipped++;
    return;
  }

  const claudeScore = scoreAgainstGroundTruth(claude.response, realDiff);
  const localScore = scoreAgainstGroundTruth(local.response, realDiff);

  const pair = {
    id: `gt_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    timestamp: new Date().toISOString(),
    prompt,
    prompt_hash: hash,
    type: "ground_truth",
    source,
    ground_truth_diff: realDiff,
    claude_response: claude.response,
    claude_duration_ms: claude.durationMs,
    claude_score: claudeScore,
    local_response: local.response,
    local_duration_ms: local.durationMs,
    local_score: localScore,
    local_model: "familiar-coder:latest",
    ...metadata,
  };

  appendFileSync(todayFile(), JSON.stringify(pair) + "\n");

  try {
    const { recordPair } = await import("./forge-db.js");
    recordPair({
      id: pair.id,
      prompt_hash: hash,
      timestamp: pair.timestamp,
      complexity_score: claudeScore.total,
      routed_to: "ground_truth",
      claude_response_length: claude.response?.length ?? 0,
      local_response_length: local.response?.length ?? 0,
      claude_duration_ms: claude.durationMs,
      local_duration_ms: local.durationMs,
      local_model: "familiar-coder:latest",
      has_code: claudeScore.hasCode || localScore.hasCode,
    });
  } catch {}

  pairsCollected++;
  console.log(
    `  SAVED ${pair.id} | Claude: ${claudeScore.total.toFixed(2)} (sim=${claudeScore.similarity}, ids=${claudeScore.identifiers}) | Local: ${localScore.total.toFixed(2)} (sim=${localScore.similarity}, ids=${localScore.identifiers}) [total: ${pairsCollected}]`
  );
}

// ── Repo Discovery ──────────────────────────────────────────────────────────

function isDocsRepo(name) {
  return DOCS_REPO_PATTERNS.some((pat) => pat.test(name));
}

function loadReposCache() {
  if (!existsSync(REPOS_CACHE)) return null;
  try {
    const data = JSON.parse(readFileSync(REPOS_CACHE, "utf8"));
    if (Date.now() - data.cached_at < CACHE_TTL_MS) return data.repos;
  } catch {}
  return null;
}

function saveReposCache(repos) {
  writeFileSync(REPOS_CACHE, JSON.stringify({ cached_at: Date.now(), repos }, null, 2));
}

async function discoverTopRepos(languages, maxReposTotal) {
  // Check cache first
  const cached = loadReposCache();
  if (cached) {
    console.log(`  Using cached repo list (${cached.length} repos)`);
    // Filter to requested languages
    const filtered = cached.filter((r) =>
      languages.includes(r.language?.toLowerCase())
    );
    return filtered.slice(0, maxReposTotal);
  }

  console.log(`  Discovering top repos across ${Object.keys(languages).length || languages.length} languages...`);

  const allRepos = [];
  const langCounts = {};

  // Build language -> count map
  for (const lang of languages) {
    langCounts[lang] = LANGUAGE_COUNTS[lang] || 10;
  }

  for (const [lang, count] of Object.entries(langCounts)) {
    console.log(`    Searching ${lang} (top ${count})...`);

    let added = 0;
    const pages = Math.ceil(count / 100);

    for (let page = 1; page <= pages && added < count; page++) {
      // GitHub search API returns max 1000 results (10 pages of 100)
      if (page > 10) break;
      const result = gh(
        `api search/repositories -X GET -f q="stars:>500 language:${lang}" -f sort=stars -f per_page=100 -f page=${page} --jq '.items[] | .full_name + "|||" + (.description // "") + "|||" + (.stargazers_count | tostring) + "|||" + (.language // "")'`
      );

      if (!result) {
        if (page === 1) console.log(`      No results for ${lang}`);
        break;
      }

      for (const line of result.split("\n")) {
        if (!line.trim() || added >= count) continue;
        const parts = line.split("|||");
        const fullName = parts[0];
        const description = parts[1] || "";
        const stars = parseInt(parts[2]) || 0;
        const repoLang = parts[3] || lang;
        const repoName = fullName.split("/")[1] || fullName;

        // Filter out docs/list repos
        if (isDocsRepo(repoName)) {
          console.log(`      Skip (docs/list): ${fullName}`);
          continue;
        }

        // Dedup across languages
        if (allRepos.some((r) => r.full_name === fullName)) continue;

        allRepos.push({
          full_name: fullName,
          description: description.slice(0, 200),
          stars,
          language: repoLang.toLowerCase(),
        });
        added++;
      }

      await sleep(SEARCH_DELAY_MS);
    }

    console.log(`      Found ${added} repos for ${lang}`);
  }

  // Sort by stars descending
  allRepos.sort((a, b) => b.stars - a.stars);

  // Cache for next run
  saveReposCache(allRepos);
  console.log(`  Cached ${allRepos.length} repos to ${REPOS_CACHE}\n`);

  return allRepos.slice(0, maxReposTotal);
}

// ── Progress Tracking ───────────────────────────────────────────────────────

function loadProgress() {
  if (!existsSync(PROGRESS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(PROGRESS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveProgress(progress) {
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function progressKey(repo, prNumber) {
  return `${repo}#${prNumber}`;
}

// ── Mine Merged PRs from a Repo ─────────────────────────────────────────────

async function mineRepo(repo, maxPRs, progress) {
  const { full_name, language, description } = repo;
  console.log(`\n${"─".repeat(50)}`);
  console.log(`  REPO: ${full_name} (${language}, ${repo.stars.toLocaleString()} stars)`);
  console.log(`${"─".repeat(50)}`);

  // Get recently merged PRs — include baseRefName to filter for main/master/dev
  const prJson = gh(
    `pr list --repo ${full_name} --state merged --limit ${maxPRs * 4} --json number,title,body,author,mergedAt,additions,deletions,baseRefName`
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

    // Check progress — already mined?
    const key = progressKey(full_name, pr.number);
    if (progress[key]) continue;

    // STRICT: Only PRs merged into main/master/dev (not feature→feature)
    const base = (pr.baseRefName || "").toLowerCase();
    if (base && !["main", "master", "dev", "develop", "production"].includes(base)) {
      skippedBranch++;
      continue;
    }

    // Filter: title too short
    if (!pr.title || pr.title.length < 15) continue;

    // Filter: dependency bumps, chores
    if (/^bump|^update deps|^chore\(deps\)|^dependabot|^renovate|^\[bot\]|^merge branch/i.test(pr.title)) continue;

    // Filter: too small or too large (lines changed)
    const linesChanged = (pr.additions || 0) + (pr.deletions || 0);
    if (linesChanged < 10 || linesChanged > 2000) continue;

    // Get the actual diff
    const diff = gh(`pr diff --repo ${full_name} ${pr.number}`);
    if (!diff) continue;
    if (diff.length < MIN_DIFF_SIZE || diff.length > MAX_DIFF_SIZE) continue;

    // Skip binary, lock files, generated content
    if (/Binary files|package-lock\.json|yarn\.lock|\.min\.js|go\.sum|Cargo\.lock|pnpm-lock\.yaml/.test(diff.slice(0, 2000))) continue;

    const prompt = prToPrompt(full_name, language, description, pr);
    await collectGroundTruthPair(prompt, diff, `top-repo:${full_name}#${pr.number}`, {
      pr_number: pr.number,
      pr_title: pr.title,
      pr_author: pr.author?.login,
      pr_merged_at: pr.mergedAt,
      repo_stars: repo.stars,
      repo_language: language,
    });

    // Mark as mined
    progress[key] = new Date().toISOString();
    collected++;
    await sleep(DELAY_MS);
  }

  if (skippedBranch > 0) console.log(`    (skipped ${skippedBranch} PRs not targeting main/master/dev)`);
  // Save progress after each repo (crash-safe)
  saveProgress(progress);
  return collected;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let selectedLangs = null;
  let maxRepos = 100;
  let maxPRs = 5;
  let forceRefresh = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--langs" && args[i + 1]) {
      selectedLangs = args[i + 1].split(",").map((l) => {
        const trimmed = l.trim().toLowerCase();
        return LANG_ALIASES[trimmed] || trimmed;
      });
      i++;
    } else if (args[i] === "--max-repos" && args[i + 1]) {
      maxRepos = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === "--max-prs" && args[i + 1]) {
      maxPRs = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === "--refresh") {
      forceRefresh = true;
    }
  }

  // Default to all languages if none specified
  const languages = selectedLangs || Object.keys(LANGUAGE_COUNTS);

  // Force refresh cache if requested
  if (forceRefresh && existsSync(REPOS_CACHE)) {
    const { unlinkSync } = await import("fs");
    unlinkSync(REPOS_CACHE);
    console.log(`  Cleared repo cache (--refresh)\n`);
  }

  console.log("=== The Forge — Top Repos Ground-Truth Miner ===");
  console.log(`  Strategy: Mine merged PRs from top-starred GitHub repos`);
  console.log(`  Languages: ${languages.join(", ")}`);
  console.log(`  Max repos: ${maxRepos}`);
  console.log(`  Max PRs/repo: ${maxPRs}`);
  console.log(`  Existing pairs: ${promptsSeen.size}`);
  console.log("");

  // Discover repos
  const repos = await discoverTopRepos(languages, maxRepos);
  console.log(`  Selected ${repos.length} repos for mining\n`);

  if (repos.length === 0) {
    console.log("  No repos found. Check your --langs filter or try --refresh.");
    return;
  }

  // Load progress
  const progress = loadProgress();
  const alreadyMined = Object.keys(progress).length;
  if (alreadyMined > 0) {
    console.log(`  Progress tracker: ${alreadyMined} PRs already mined\n`);
  }

  // Mine each repo
  for (const repo of repos) {
    const count = await mineRepo(repo, maxPRs, progress);
    if (count > 0) {
      console.log(`  → ${count} pairs from ${repo.full_name}`);
    }
  }

  console.log(`\n${"█".repeat(60)}`);
  console.log(`  TOP REPOS MINING COMPLETE`);
  console.log(`  New pairs collected: ${pairsCollected}`);
  console.log(`  Skipped (dupes/filtered): ${pairsSkipped}`);
  console.log(`  Total in DB: ${promptsSeen.size}`);
  console.log(`  Output file: ${todayFile()}`);
  console.log(`  Progress: ${PROGRESS_FILE}`);
  console.log(`${"█".repeat(60)}`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
