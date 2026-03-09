#!/usr/bin/env bun

// The Forge — Open-Source Dataset Ingestion
// Downloads coding datasets from HuggingFace (REST API, no Python deps)
// and converts them to Forge JSONL format for training.
//
// All datasets are Apache 2.0 licensed — safe for training.
//
// Usage:
//   bun trainer/ingest-datasets.mjs                    # download all datasets
//   bun trainer/ingest-datasets.mjs --dataset magicoder  # specific dataset
//   bun trainer/ingest-datasets.mjs --dry-run            # show what would download

import { mkdirSync, existsSync, writeFileSync, readFileSync, appendFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(__dirname, "data", "open_source");
const DRY_RUN = process.argv.includes("--dry-run");
const SPECIFIC = (() => {
  const i = process.argv.indexOf("--dataset");
  return i !== -1 ? process.argv[i + 1] : null;
})();

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

// ── Dataset Definitions ──────────────────────────────────────────────────────

const DATASETS = [
  {
    id: "magicoder",
    name: "Magicoder-OSS-Instruct",
    repo: "ise-uiuc/Magicoder-OSS-Instruct-75K",
    split: "train",
    maxPairs: 10000,
    license: "Apache 2.0",
    promptField: "problem",
    responseField: "solution",
  },
  {
    id: "self-oss-instruct",
    name: "Self-OSS-Instruct (bigcode)",
    repo: "bigcode/self-oss-instruct-sc2-exec-filter-50k",
    split: "train",
    maxPairs: 5000,
    license: "Apache 2.0",
    promptField: "instruction",
    responseField: "output",
    fallbackPromptField: "problem",
    fallbackResponseField: "solution",
  },
  {
    id: "evol-instruct-code",
    name: "Evol-Instruct-Code",
    repo: "nickrosh/Evol-Instruct-Code-80k-v1",
    split: "train",
    maxPairs: 5000,
    license: "Apache 2.0",
    promptField: "instruction",
    responseField: "output",
  },
  {
    id: "code-alpaca",
    name: "CodeAlpaca",
    repo: "sahil2801/CodeAlpaca-20k",
    split: "train",
    maxPairs: 3000,
    license: "Apache 2.0",
    promptField: "instruction",
    responseField: "output",
  },
  {
    id: "glaive-code",
    name: "Glaive Code Assistant",
    repo: "glaiveai/glaive-code-assistant",
    split: "train",
    maxPairs: 3000,
    license: "Apache 2.0",
    promptField: "question",
    responseField: "answer",
    fallbackPromptField: "instruction",
    fallbackResponseField: "output",
  },
  {
    id: "openhermes-code",
    name: "OpenHermes 2.5 (coding subset)",
    repo: "teknium/OpenHermes-2.5",
    split: "train",
    maxPairs: 2000,
    license: "Apache 2.0",
    conversationsFormat: true,
    codeFilter: true,
  },
  {
    id: "commitpackft",
    name: "CommitPackFT (commit msg → diff pairs)",
    repo: "bigcode/commitpackft",
    split: "train",
    maxPairs: 10000,
    license: "Apache 2.0",
    promptField: "message",
    responseField: "content",
  },
  {
    id: "the-stack-smol",
    name: "The Stack Smol (curated code samples)",
    repo: "bigcode/the-stack-smol",
    split: "train",
    maxPairs: 5000,
    license: "Apache 2.0",
    promptField: "content",
    responseField: "content",
    // Single-field — we'll generate instruction prompts from the code
    codeOnly: true,
  },
  {
    id: "code-feedback",
    name: "Code Feedback (instruction + refinement pairs)",
    repo: "m-a-p/Code-Feedback",
    split: "train",
    maxPairs: 5000,
    license: "Apache 2.0",
    conversationsFormat: true,
    codeFilter: true,
  },
  {
    id: "python-code-instructions",
    name: "Python Code Instructions (18k)",
    repo: "iamtarun/python_code_instructions_18k_alpaca",
    split: "train",
    maxPairs: 5000,
    license: "Apache 2.0",
    promptField: "instruction",
    responseField: "output",
  },
  {
    id: "leetcode-solutions",
    name: "LeetCode Solutions",
    repo: "gblazex/rosetta-code",
    split: "train",
    maxPairs: 3000,
    license: "MIT",
    promptField: "task_name",
    responseField: "code",
  },
];

// ── Quality Filters ──────────────────────────────────────────────────────────

const REFUSAL_PATTERNS = [
  /^(i'm sorry|i cannot|i can't|as an ai|i am not able)/i,
  /^(sorry,? but|unfortunately,? i)/i,
  /^(i don't have the ability|i'm unable)/i,
];

const MIN_RESPONSE_LENGTH = 100;
const MIN_PROMPT_LENGTH = 20;
const MAX_RESPONSE_LENGTH = 24000;

function passesQuality(prompt, response) {
  if (!prompt || !response) return false;
  if (prompt.length < MIN_PROMPT_LENGTH) return false;
  if (response.length < MIN_RESPONSE_LENGTH) return false;
  if (response.length > MAX_RESPONSE_LENGTH) return false;

  // Must contain code (code block or indented code)
  if (!response.includes("```") && !response.includes("    ")) return false;

  // Reject refusals
  for (const pat of REFUSAL_PATTERNS) {
    if (pat.test(response)) return false;
  }

  return true;
}

// ── HuggingFace Downloader ───────────────────────────────────────────────────

async function fetchDatasetRows(repo, split, offset, limit) {
  const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(repo)}&config=default&split=${split}&offset=${offset}&length=${limit}`;
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(60_000),
      headers: { "User-Agent": "familiar-forge/1.0" },
    });
    if (!resp.ok) {
      // Try without config=default
      const url2 = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(repo)}&split=${split}&offset=${offset}&length=${limit}`;
      const resp2 = await fetch(url2, {
        signal: AbortSignal.timeout(60_000),
        headers: { "User-Agent": "familiar-forge/1.0" },
      });
      if (!resp2.ok) {
        console.log(`    HTTP ${resp2.status} for ${repo}`);
        return null;
      }
      return resp2.json();
    }
    return resp.json();
  } catch (e) {
    console.log(`    Fetch error for ${repo}: ${e.message}`);
    return null;
  }
}

// ── Dataset Processing ───────────────────────────────────────────────────────

function extractConversation(row) {
  // OpenHermes format: { conversations: [{ from: "human", value: "..." }, { from: "gpt", value: "..." }] }
  const convos = row.conversations || row.conversation;
  if (!Array.isArray(convos) || convos.length < 2) return null;

  const human = convos.find(c => c.from === "human" || c.role === "user");
  const assistant = convos.find(c => c.from === "gpt" || c.role === "assistant");

  if (!human || !assistant) return null;
  return { prompt: human.value || human.content, response: assistant.value || assistant.content };
}

function extractFields(row, dataset) {
  if (dataset.conversationsFormat) {
    return extractConversation(row);
  }

  // Code-only datasets: generate an instruction from the code itself
  if (dataset.codeOnly) {
    const code = row[dataset.promptField] || row.content;
    if (!code || code.length < 100) return null;
    // Use first line comment or function signature as instruction
    const lines = code.split("\n").filter(l => l.trim());
    const firstMeaningful = lines.find(l =>
      /^(\/\/|#|\/\*|\*|"""|def |function |class |export |import |pub )/.test(l.trim())
    ) || lines[0];
    const prompt = `Write the following code:\n${firstMeaningful.trim()}`;
    return { prompt, response: code };
  }

  let prompt = row[dataset.promptField];
  let response = row[dataset.responseField];

  // Try fallback fields
  if (!prompt && dataset.fallbackPromptField) prompt = row[dataset.fallbackPromptField];
  if (!response && dataset.fallbackResponseField) response = row[dataset.fallbackResponseField];

  if (!prompt || !response) return null;
  return { prompt, response };
}

async function ingestDataset(dataset) {
  const outputFile = resolve(OUTPUT_DIR, `${dataset.id}.jsonl`);

  // Check if already ingested
  if (existsSync(outputFile)) {
    const lines = readFileSync(outputFile, "utf8").trim().split("\n").filter(Boolean).length;
    if (lines >= dataset.maxPairs * 0.8) {
      console.log(`  ${dataset.name}: already ingested (${lines} pairs), skipping`);
      return lines;
    }
  }

  console.log(`  ${dataset.name} (${dataset.repo})`);
  console.log(`    Target: ${dataset.maxPairs} pairs | License: ${dataset.license}`);

  if (DRY_RUN) {
    console.log(`    [DRY RUN] Would download and process`);
    return 0;
  }

  let collected = 0;
  let offset = 0;
  const BATCH_SIZE = 100;
  const pairs = [];

  while (collected < dataset.maxPairs) {
    const data = await fetchDatasetRows(dataset.repo, dataset.split, offset, BATCH_SIZE);
    if (!data || !data.rows || data.rows.length === 0) break;

    for (const item of data.rows) {
      if (collected >= dataset.maxPairs) break;

      const row = item.row || item;
      const extracted = extractFields(row, dataset);
      if (!extracted) continue;

      const { prompt, response } = extracted;

      // Code filter for OpenHermes (only keep coding-related entries)
      if (dataset.codeFilter) {
        const combined = (prompt + response).toLowerCase();
        const isCode = combined.includes("```") ||
          /\b(function|class|import|def |const |let |var |return)\b/.test(combined);
        if (!isCode) continue;
      }

      if (!passesQuality(prompt, response)) continue;

      pairs.push({
        prompt,
        response,
        task_type: "coding",
        source_dataset: dataset.id,
        training_eligible: true,
        gold_source: "open_source",
      });
      collected++;
    }

    offset += data.rows.length;

    // Safety: don't fetch more than 10x what we need
    if (offset > dataset.maxPairs * 10) break;

    // Rate limit
    await new Promise(r => setTimeout(r, 500));
  }

  // Write output
  writeFileSync(outputFile, pairs.map(p => JSON.stringify(p)).join("\n") + "\n");
  console.log(`    Collected: ${collected} pairs → ${outputFile}`);

  return collected;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== The Forge — Open-Source Dataset Ingestion ===\n");
  console.log(`  Output: ${OUTPUT_DIR}`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log("");

  const datasets = SPECIFIC
    ? DATASETS.filter(d => d.id.includes(SPECIFIC))
    : DATASETS;

  if (datasets.length === 0) {
    console.error(`No dataset matching "${SPECIFIC}". Available: ${DATASETS.map(d => d.id).join(", ")}`);
    process.exit(1);
  }

  let totalCollected = 0;

  for (const dataset of datasets) {
    try {
      const count = await ingestDataset(dataset);
      totalCollected += count;
    } catch (e) {
      console.log(`    ERROR: ${e.message}`);
    }
    console.log("");
  }

  console.log(`\nTotal ingested: ${totalCollected} pairs across ${datasets.length} datasets`);
  console.log(`Output directory: ${OUTPUT_DIR}`);
  console.log("\nNext: run 'familiar forge train' to include these in training data");
}

main().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
