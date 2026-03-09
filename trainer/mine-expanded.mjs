#!/usr/bin/env bun

// The Forge — Expanded Data Miner
// Mines training data from multiple GitHub orgs/users with more aggressive collection.
// Targets: closed issues, more PRs, deeper commit history, popular open-source repos.

import { execSync } from "child_process";
import { appendFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash, randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = resolve(__dirname, "data", "raw");
const OLLAMA_URL = "http://localhost:11434";

// Gemini Flash — free tier, default one-shot model
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || (() => {
  try {
    const env = readFileSync(resolve(__dirname, "..", "config", ".env"), "utf8");
    return env.match(/GEMINI_API_KEY=(.+)/)?.[1]?.trim();
  } catch { return null; }
})();
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

if (!existsSync(RAW_DIR)) mkdirSync(RAW_DIR, { recursive: true });

// ── Sources to mine ─────────────────────────────────────────────────────────

const SOURCES = [
  // Add your own GitHub orgs here
  // { name: "your-org", maxRepos: 30, maxItems: 10, closedIssues: true },
  // { name: "your-username", maxRepos: 30, maxItems: 8, closedIssues: true },
  { name: "familiar-run", maxRepos: 20, maxItems: 8, closedIssues: true },
  // Popular open-source repos with great code patterns
  { name: "vercel", maxRepos: 10, maxItems: 5 },
  { name: "expressjs", maxRepos: 8, maxItems: 5 },
  { name: "fastify", maxRepos: 6, maxItems: 5 },
  { name: "sindresorhus", maxRepos: 15, maxItems: 4 },
  { name: "tj", maxRepos: 10, maxItems: 4 },
  { name: "pallets", maxRepos: 6, maxItems: 5 },
  { name: "tiangolo", maxRepos: 6, maxItems: 5 },
];

const DELAY_MS = 1500;
let pairsCollected = 0;
let pairsSkipped = 0;
let promptsSeen = new Set();

// Load existing prompt hashes to avoid dupes with previous runs
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
    return execSync(`gh ${cmd}`, { encoding: "utf8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) { return null; }
}

function hashPrompt(p) { return createHash("sha256").update(p).digest("hex").slice(0, 16); }
function todayFile() { return resolve(RAW_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
    if (!resp.ok) return { response: null, durationMs: Date.now() - start };
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    return { response: text, durationMs: Date.now() - start };
  } catch { return { response: null, durationMs: Date.now() - start }; }
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
          { role: "system", content: "You are Familiar, a persistent AI assistant from familiar.run. Write clean, well-structured code. Focus on the implementation, not explanation." },
          { role: "user", content: prompt },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) return { response: null, durationMs: Date.now() - start };
    const data = await resp.json();
    return { response: data.message?.content ?? null, durationMs: Date.now() - start };
  } catch { return { response: null, durationMs: Date.now() - start }; }
}

async function collectPair(prompt, source, { groundTruthDiff = null } = {}) {
  const hash = hashPrompt(prompt);
  if (promptsSeen.has(hash)) { pairsSkipped++; return; }
  promptsSeen.add(hash);

  const isGroundTruth = !!groundTruthDiff;

  console.log(`\n  Collecting pair (${source})${isGroundTruth ? " [ground-truth]" : " [eval-only]"}...`);
  console.log(`  Prompt: ${prompt.slice(0, 120)}...`);

  // Gemini (silver, free) + local brain — no Claude (TOS compliance)
  const [gemini, local] = await Promise.all([callGemini(prompt), callOllama(prompt)]);

  // Need at least one response with code blocks
  const anyResponse = gemini.response || local.response;
  if (!anyResponse) {
    console.log(`  SKIP: all models failed`);
    pairsSkipped++; return;
  }
  if (!/```/.test(anyResponse)) {
    console.log(`  SKIP: no code blocks in any response`);
    pairsSkipped++; return;
  }

  const pair = {
    id: `${isGroundTruth ? "gt" : "pair"}_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    timestamp: new Date().toISOString(),
    prompt, prompt_hash: hash,
    complexity_score: null, routed_to: isGroundTruth ? "ground_truth" : "mine", source,
    type: isGroundTruth ? "ground_truth" : undefined,
    ground_truth_diff: groundTruthDiff,
    training_eligible: isGroundTruth,
    data_source: "expanded_miner",
    gold_source: isGroundTruth ? "ground_truth_diff" : "eval_only",
    gemini_response: gemini.response, gemini_duration_ms: gemini.durationMs,
    local_response: local.response, local_duration_ms: local.durationMs,
    local_model: "familiar-brain:latest",
  };

  appendFileSync(todayFile(), JSON.stringify(pair) + "\n");

  try {
    const { recordPair } = await import("./forge-db.js");
    recordPair({
      id: pair.id, prompt_hash: hash, timestamp: pair.timestamp,
      complexity_score: null, routed_to: pair.routed_to,
      claude_response_length: 0,
      local_response_length: local.response?.length ?? 0,
      claude_duration_ms: 0, local_duration_ms: local.durationMs,
      local_model: "familiar-brain:latest", has_code: true,
      training_eligible: isGroundTruth,
      data_source: "expanded_miner",
      gold_source: isGroundTruth ? "ground_truth_diff" : "eval_only",
    });
  } catch {}

  pairsCollected++;
  const log = `gemini=${gemini.response?.length ?? 0}c, local=${local.response?.length ?? 0}c`;
  console.log(`  SAVED pair ${pair.id} (${log}) [total: ${pairsCollected}]`);
}

// ── Prompt Builders ─────────────────────────────────────────────────────────

function detectStack(repoName) {
  const lower = repoName.toLowerCase();
  if (lower.includes("-fe") || lower.includes("frontend") || lower.includes("-ui")) return "React/JavaScript frontend";
  if (lower.includes("-be") || lower.includes("-api") || lower.includes("service-")) return "Node.js/TypeScript backend API";
  if (lower.includes("mobile") || lower.includes("ios") || lower.includes("android")) return "React Native mobile app";
  if (lower.includes("devops") || lower.includes("pipeline") || lower.includes("infra")) return "DevOps/infrastructure";
  if (lower.includes("python") || lower.includes("-py") || lower.includes("flask") || lower.includes("fastapi")) return "Python";
  return "full-stack JavaScript/TypeScript";
}

function issueToPrompt(repo, issue, stack) {
  const labels = issue.labels?.map(l => l.name).join(", ") || "";
  return `You are working on the "${repo}" repository (${stack}).

Issue #${issue.number}: ${issue.title}
${labels ? `Labels: ${labels}` : ""}

${issue.body ? issue.body.slice(0, 1500) : "(no description)"}

Write the code to implement this. Include relevant file paths, function signatures, and implementation. If it's a bug fix, show the fix. If it's a feature, show the key files and implementation.`;
}

function prToPrompt(repo, pr, stack) {
  return `You are working on the "${repo}" repository (${stack}).

PR #${pr.number}: ${pr.title}
Author: ${pr.author?.login || "unknown"}
State: ${pr.state}
${pr.body ? `\nDescription:\n${pr.body.slice(0, 1500)}` : ""}

Based on this PR description, write the key code changes that would implement this. Show the main files and implementation approach.`;
}

function commitToPrompt(repo, commit, stack) {
  return `You are working on the "${repo}" repository (${stack}).

A commit was made: "${commit.message}"
Author: ${commit.author} | Date: ${commit.date}

Write the code that would accomplish what's described. Show relevant files and clean, production-ready implementation.`;
}

function prReviewPrompt(repo, pr, diff, stack) {
  return `You are reviewing code on the "${repo}" repository (${stack}).

PR #${pr.number}: ${pr.title}
${pr.body ? `Description: ${pr.body.slice(0, 800)}` : ""}

Here's a portion of the diff:
\`\`\`diff
${diff.slice(0, 3000)}
\`\`\`

Review this code. Point out bugs, security issues, or improvements. Then show how you would implement this differently if there's a better approach. Include code.`;
}

function closedIssueToPrompt(repo, issue, stack) {
  const labels = issue.labels?.map(l => l.name).join(", ") || "";
  return `You are working on the "${repo}" repository (${stack}).

This issue was filed and resolved:
Issue #${issue.number}: ${issue.title}
${labels ? `Labels: ${labels}` : ""}

${issue.body ? issue.body.slice(0, 1500) : "(no description)"}

Write the code that would resolve this issue. Show the implementation with relevant file paths and clean, production-ready code.`;
}

// ── Mine a single org/user ──────────────────────────────────────────────────

async function mineSource(orgName, maxRepos, maxItems, includeClosedIssues = false) {
  console.log(`\n${"█".repeat(60)}`);
  console.log(`  SOURCE: ${orgName}`);
  console.log(`${"█".repeat(60)}`);

  const repoJson = gh(`repo list ${orgName} --limit ${maxRepos * 2} --json name,pushedAt,isArchived --jq '[.[] | select(.isArchived == false)]'`);
  if (!repoJson) {
    console.log(`  Failed to list repos for ${orgName}`);
    return;
  }

  let repos = JSON.parse(repoJson);
  repos.sort((a, b) => new Date(b.pushedAt) - new Date(a.pushedAt));
  repos = repos.slice(0, maxRepos);
  console.log(`  Found ${repos.length} active repos\n`);

  for (const repo of repos) {
    const repoName = repo.name;
    const stack = detectStack(repoName);
    console.log(`\n${"─".repeat(50)}`);
    console.log(`  REPO: ${orgName}/${repoName} (${stack})`);
    console.log(`${"─".repeat(50)}`);

    let items = 0;

    // Open issues
    try {
      const data = gh(`issue list --repo ${orgName}/${repoName} --state open --limit 5 --json number,title,body,labels`);
      if (data) {
        for (const issue of JSON.parse(data)) {
          if (items >= maxItems) break;
          if (!issue.title || issue.title.length < 10) continue;
          await collectPair(issueToPrompt(repoName, issue, stack), `issue:${orgName}/${repoName}#${issue.number}`);
          items++; await sleep(DELAY_MS);
        }
      }
    } catch {}

    // Closed issues (if enabled)
    if (includeClosedIssues && items < maxItems) {
      try {
        const data = gh(`issue list --repo ${orgName}/${repoName} --state closed --limit 5 --json number,title,body,labels`);
        if (data) {
          for (const issue of JSON.parse(data)) {
            if (items >= maxItems) break;
            if (!issue.title || issue.title.length < 10) continue;
            await collectPair(closedIssueToPrompt(repoName, issue, stack), `closed:${orgName}/${repoName}#${issue.number}`);
            items++; await sleep(DELAY_MS);
          }
        }
      } catch {}
    }

    // Open PRs + reviews
    try {
      const data = gh(`pr list --repo ${orgName}/${repoName} --state open --limit 3 --json number,title,body,author,state`);
      if (data) {
        for (const pr of JSON.parse(data)) {
          if (items >= maxItems) break;
          if (!pr.title || pr.title.length < 10) continue;
          await collectPair(prToPrompt(repoName, pr, stack), `pr:${orgName}/${repoName}#${pr.number}`);
          items++; await sleep(DELAY_MS);

          if (items < maxItems) {
            const diff = gh(`pr diff --repo ${orgName}/${repoName} ${pr.number}`);
            if (diff && diff.length > 100 && diff.length < 50000) {
              await collectPair(prReviewPrompt(repoName, pr, diff, stack), `review:${orgName}/${repoName}#${pr.number}`);
              items++; await sleep(DELAY_MS);
            }
          }
        }
      }
    } catch {}

    // Merged PRs — STRICT: only PRs merged into main/master/dev
    // Fetch actual diffs for ground-truth training data
    try {
      const data = gh(`pr list --repo ${orgName}/${repoName} --state merged --limit 10 --json number,title,body,author,state,baseRefName,additions,deletions`);
      if (data) {
        for (const pr of JSON.parse(data)) {
          if (items >= maxItems) break;
          if (!pr.title || pr.title.length < 10) continue;
          const base = (pr.baseRefName || "").toLowerCase();
          if (base && !["main", "master", "dev", "develop", "production"].includes(base)) continue;
          if (/^bump|^update deps|^chore\(deps\)|^dependabot|^renovate|^\[bot\]|^merge branch/i.test(pr.title)) continue;
          if ((pr.additions || 0) + (pr.deletions || 0) < 10) continue;
          if ((pr.additions || 0) + (pr.deletions || 0) > 2000) continue;

          // Fetch actual diff for ground truth
          const diff = gh(`pr diff --repo ${orgName}/${repoName} ${pr.number}`);
          const hasGoodDiff = diff && diff.length >= 100 && diff.length <= 15000
            && !/Binary files|package-lock\.json|yarn\.lock|\.min\.js/.test(diff.slice(0, 2000));

          await collectPair(
            prToPrompt(repoName, pr, stack),
            `merged:${orgName}/${repoName}#${pr.number}`,
            hasGoodDiff ? { groundTruthDiff: diff } : {}
          );
          items++; await sleep(DELAY_MS);
        }
      }
    } catch {}

    // Merge commits only — skip raw commits (WIP, progress saves, etc.)
    try {
      const data = gh(`api repos/${orgName}/${repoName}/commits?per_page=12 --jq '[.[] | select(.parents | length == 2)] | .[0:6] | .[] | .commit.message + "|||" + .commit.author.name + "|||" + .commit.author.date'`);
      if (data) {
        for (const line of data.split("\n")) {
          if (items >= maxItems) break;
          const [rawMsg, author, date] = line.split("|||");
          if (!rawMsg) continue;
          // Extract PR title from merge commit message
          let msg = rawMsg.split("\n")[0];
          const prMatch = rawMsg.match(/Merge pull request #\d+.*?\n\n(.+)/s);
          if (prMatch) msg = prMatch[1].split("\n")[0];
          if (msg.length < 15 || /^bump|^update deps|^chore\(deps\)|^dependabot|^renovate|^\[bot\]/i.test(msg)) continue;
          await collectPair(commitToPrompt(repoName, { message: msg, author, date }, stack), `commit:${orgName}/${repoName}`);
          items++; await sleep(DELAY_MS);
        }
      }
    } catch {}

    console.log(`  → ${items} items from ${repoName}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== The Forge — Expanded Data Miner ===");
  console.log(`  Sources: ${SOURCES.map(s => s.name).join(", ")}`);
  console.log(`  Existing pairs: ${promptsSeen.size}`);
  console.log("");

  for (const source of SOURCES) {
    await mineSource(source.name, source.maxRepos, source.maxItems, source.closedIssues || false);
  }

  console.log(`\n${"█".repeat(60)}`);
  console.log(`  MINING COMPLETE`);
  console.log(`  New pairs collected: ${pairsCollected}`);
  console.log(`  Skipped (dupes/no-code): ${pairsSkipped}`);
  console.log(`  Total in DB: ${promptsSeen.size}`);
  console.log(`${"█".repeat(60)}`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
