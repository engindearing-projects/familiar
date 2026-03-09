#!/usr/bin/env bun

// Daily Learning Cycle
// Runs 5 steps: REFLECT → LEARN → INSTALL → IDEATE → INGEST
//
// Run: bun brain/learner.mjs
// Dry run: bun brain/learner.mjs --dry-run
// Launchd: com.familiar.learner at 5 AM daily

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "fs";
import { resolve, join } from "path";
import { randomUUID } from "crypto";
import { resolveBun } from "../shared/resolve.js";

const PROJECT_DIR = resolve(import.meta.dir, "..");
const BRAIN_DIR = import.meta.dir;
const TRACES_DIR = resolve(PROJECT_DIR, "trainer/data/traces");
const REFLECTION_DIR = resolve(BRAIN_DIR, "reflection/daily");
const IDEAS_FILE = resolve(BRAIN_DIR, "ideas/ideas.jsonl");
const SKILLS_DIR = resolve(BRAIN_DIR, "skills");
const REGISTRY_PATH = resolve(SKILLS_DIR, "registry.json");
const IMPROVEMENTS_FILE = resolve(BRAIN_DIR, "reflection/improvements.jsonl");

const OLLAMA_URL = "http://localhost:11434";
const CLAUDE_PROXY_URL = "http://localhost:18791/v1";
const BRAIN_MODEL = "familiar-brain:latest";
const DRY_RUN = process.argv.includes("--dry-run");

// Ensure dirs exist
for (const dir of [REFLECTION_DIR, resolve(BRAIN_DIR, "ideas"), SKILLS_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── Telegram Notifications ──────────────────────────────────────────────────

let botToken = null;
let chatId = null;

try {
  const envFile = resolve(PROJECT_DIR, "config/.env");
  if (existsSync(envFile)) {
    const envContent = readFileSync(envFile, "utf-8");
    for (const line of envContent.split("\n")) {
      const [key, ...rest] = line.split("=");
      const val = rest.join("=").trim().replace(/^["']|["']$/g, "");
      if (key.trim() === "TELEGRAM_BOT_TOKEN") botToken = val;
      if (key.trim() === "TELEGRAM_CHAT_ID") chatId = val;
    }
  }
  botToken = botToken || process.env.TELEGRAM_BOT_TOKEN;
  chatId = chatId || process.env.TELEGRAM_CHAT_ID;
} catch { /* env not available */ }

async function notify(text) {
  if (DRY_RUN) {
    console.log(`[notify] ${text}`);
    return;
  }

  if (!botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.error("[notify] Telegram error:", err.message);
  }
}

// ── Chat Providers ──────────────────────────────────────────────────────────

async function chatOllama(systemPrompt, userPrompt) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: BRAIN_MODEL,
      messages,
      stream: false,
      options: { num_predict: 2048, temperature: 0.7 },
    }),
    signal: AbortSignal.timeout(90000),
  });

  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const data = await res.json();
  return data.message?.content || "";
}

async function chatClaude(systemPrompt, userPrompt) {
  const res = await fetch(`${CLAUDE_PROXY_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer subscription",
    },
    body: JSON.stringify({
      model: "claude-subscription",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 2048,
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) throw new Error(`Claude proxy error: ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// Try Claude proxy first (better at structured JSON), fall back to Ollama
async function chatSmart(systemPrompt, userPrompt) {
  try {
    const result = await chatClaude(systemPrompt, userPrompt);
    if (result) {
      console.log("[learner] Used Claude proxy");
      return result;
    }
  } catch (err) {
    console.log(`[learner] Claude proxy unavailable (${err.message}), falling back to Ollama`);
  }
  return chatOllama(systemPrompt, userPrompt);
}

// Simple chat — Ollama only (for non-structured tasks like REFLECT/LEARN)
async function chat(systemPrompt, userPrompt) {
  return chatOllama(systemPrompt, userPrompt);
}

// ── Step 1: REFLECT ─────────────────────────────────────────────────────────

async function reflect() {
  console.log("[learner] Step 1: REFLECT");

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  // Read yesterday's traces
  const traceFile = join(TRACES_DIR, `${yesterday}-agent.jsonl`);
  let traceData = [];
  if (existsSync(traceFile)) {
    const lines = readFileSync(traceFile, "utf-8").split("\n").filter(Boolean);
    traceData = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  // Count tool calls and analyze
  const toolCounts = {};
  const topics = [];
  const failures = [];

  for (const trace of traceData) {
    const tools = trace.metadata?.tools_used || [];
    for (const t of tools) {
      toolCounts[t] = (toolCounts[t] || 0) + 1;
    }

    if (trace.prompt) topics.push(trace.prompt.slice(0, 100));
    if (trace.metadata?.finish_reason !== "complete") {
      failures.push({
        prompt: trace.prompt?.slice(0, 100),
        reason: trace.metadata?.finish_reason,
      });
    }
  }

  // Ask the brain model to identify gaps
  let gaps = [];
  if (traceData.length > 0) {
    const topicSummary = topics.slice(0, 10).join("\n- ");
    const failureSummary = failures.length > 0
      ? failures.slice(0, 5).map(f => `"${f.prompt}" (${f.reason})`).join("\n- ")
      : "None";

    try {
      const analysis = await chat(
        "You are an AI that analyzes its own performance. Identify gaps — things you couldn't do or did poorly.",
        `Yesterday's activity:\n- ${traceData.length} conversations\n- Topics:\n- ${topicSummary}\n- Failures:\n- ${failureSummary}\n\nIdentify 1-3 specific gaps or things to learn. Output JSON array: [{"gap": "description", "impact": "high|medium|low"}]`
      );

      try {
        const match = analysis.match(/\[[\s\S]*\]/);
        if (match) gaps = JSON.parse(match[0]);
      } catch { /* parse error, continue */ }
    } catch (err) {
      console.log(`[learner] Reflection model unavailable: ${err.message}`);
    }
  }

  const reflection = {
    date: today,
    yesterday,
    conversationCount: traceData.length,
    toolCounts,
    topTopics: topics.slice(0, 5),
    failures: failures.slice(0, 5),
    gaps,
    timestamp: new Date().toISOString(),
  };

  const reflectionPath = join(REFLECTION_DIR, `${today}.json`);
  if (!DRY_RUN) {
    writeFileSync(reflectionPath, JSON.stringify(reflection, null, 2));
  }

  console.log(`[learner] Reflected: ${traceData.length} conversations, ${gaps.length} gaps identified`);
  return reflection;
}

// ── Step 2: LEARN ───────────────────────────────────────────────────────────

async function learn(reflection) {
  console.log("[learner] Step 2: LEARN");

  const gaps = reflection.gaps || [];
  if (gaps.length === 0) {
    console.log("[learner] No gaps to learn from");
    return null;
  }

  // Pick highest impact gap
  const gap = gaps.sort((a, b) => {
    const order = { high: 3, medium: 2, low: 1 };
    return (order[b.impact] || 0) - (order[a.impact] || 0);
  })[0];

  console.log(`[learner] Learning about: ${gap.gap}`);

  // Research the gap
  let findings = "";
  try {
    findings = await chat(
      "You are a research assistant. Provide practical, actionable information.",
      `Research this gap in my capabilities: "${gap.gap}"\n\nProvide:\n1. What this capability involves\n2. How to implement it (tools, APIs, approaches)\n3. A concrete example\n\nKeep it under 500 words.`
    );
  } catch (err) {
    console.log(`[learner] Learning model unavailable: ${err.message}`);
    return null;
  }

  // CRAAP quality check on research findings before accepting
  let craapResult = null;
  try {
    const { evaluateSource } = await import("./rag/craap.mjs");

    // Fetch some existing knowledge for cross-reference
    let existingChunks = [];
    try {
      const { search } = await import("./rag/index.mjs");
      existingChunks = await search(gap.gap, 5);
    } catch { /* RAG may not be available */ }

    craapResult = evaluateSource(
      {
        text: findings,
        date: new Date().toISOString().slice(0, 10),
        source: "learner-research",
        tags: "learning,research," + (gap.gap || "").slice(0, 30),
      },
      {
        context: [gap.gap],
        existingChunks,
      }
    );

    console.log(`[learner] CRAAP score: ${craapResult.score.toFixed(2)} -> ${craapResult.recommendation}`);

    if (craapResult.recommendation === "reject") {
      console.log(`[learner] Research findings rejected by CRAAP (score ${craapResult.score.toFixed(2)} below threshold)`);
      console.log(`[learner] Top reasons: ${craapResult.reasons.slice(0, 3).join("; ")}`);
      return null;
    }

    if (craapResult.recommendation === "review") {
      console.log(`[learner] Research findings flagged for review (score ${craapResult.score.toFixed(2)})`);
    }
  } catch (err) {
    console.log(`[learner] CRAAP evaluation unavailable: ${err.message}, proceeding without`);
  }

  console.log(`[learner] Learned: ${findings.slice(0, 100)}...`);
  return { gap, findings, craapScore: craapResult?.score ?? null, craapRecommendation: craapResult?.recommendation ?? null };
}

// ── Step 3: INSTALL ─────────────────────────────────────────────────────────

import {
  discoverTemplates,
  validateTemplate,
  installSkill as pipelineInstallSkill,
  listInstalled as pipelineListInstalled,
  findTemplate,
} from "./skills/pipeline.mjs";

async function install(learning) {
  console.log("[learner] Step 3: INSTALL");

  // Phase A: Install any uninstalled templates from the templates directory
  const templates = discoverTemplates();
  const installed = pipelineListInstalled();
  const installedNames = new Set(installed.map(s => s.name));
  let templateInstallCount = 0;

  for (const template of templates) {
    if (installedNames.has(template.name)) continue;

    const validation = validateTemplate(template);
    if (!validation.valid) {
      console.log(`[learner] Template '${template.name}' invalid: ${validation.errors[0]}`);
      continue;
    }

    if (!DRY_RUN) {
      const result = pipelineInstallSkill(template);
      if (result.ok) {
        templateInstallCount++;
        console.log(`[learner] Installed template skill: ${template.name}`);
      } else {
        console.log(`[learner] Template install failed: ${template.name} — ${result.message}`);
      }
    } else {
      console.log(`[learner] (dry run) Would install template: ${template.name}`);
      templateInstallCount++;
    }
  }

  if (templateInstallCount > 0) {
    console.log(`[learner] Installed ${templateInstallCount} new template skill(s)`);
  }

  // Phase B: Generate a new skill from learning (existing behavior)
  if (!learning) {
    console.log("[learner] No learning data — skipping skill generation");
    return templateInstallCount > 0 ? { status: "templates_only", count: templateInstallCount } : null;
  }

  // Ask the brain to design AND implement a skill (uses Claude for better JSON + code)
  let skillSpec = null;
  try {
    const response = await chatSmart(
      "You are a tool designer. Design a simple tool/skill based on the research findings. The skill must be implementable as a single JavaScript module that exports { name, description, parameters, execute }.",
      `Gap: ${learning.gap.gap}\n\nFindings:\n${learning.findings}\n\nDesign a skill. Output JSON: {"name": "skill_name", "description": "what it does", "parameters": {"param1": {"type": "string", "description": "desc"}}, "canImplement": true/false, "reason": "why or why not"}\n\nOnly set canImplement to true if this can be a simple, read-only tool (no destructive operations).`
    );

    try {
      const match = response.match(/\{[\s\S]*\}/);
      if (match) skillSpec = JSON.parse(match[0]);
    } catch { /* parse error */ }
  } catch (err) {
    console.log(`[learner] Install model unavailable: ${err.message}`);
    return null;
  }

  if (!skillSpec?.canImplement) {
    console.log(`[learner] Skill not installable: ${skillSpec?.reason || "unknown"}`);
    return skillSpec;
  }

  // Check if skill already exists in registry
  let registry = { skills: [], lastUpdated: null };
  try {
    if (existsSync(REGISTRY_PATH)) {
      registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
    }
  } catch { /* fresh registry */ }

  if (registry.skills.some(s => s.name === skillSpec.name)) {
    console.log(`[learner] Skill "${skillSpec.name}" already exists, skipping`);
    return { ...skillSpec, status: "duplicate" };
  }

  // Generate the actual skill code
  let skillCode = null;
  try {
    const paramEntries = Object.entries(skillSpec.parameters || {});
    const paramDoc = paramEntries.length > 0
      ? paramEntries.map(([n, def]) => `//   ${n}: ${def.type || "any"} — ${def.description || ""}`).join("\n")
      : "//   (none)";

    skillCode = await chatSmart(
      `You are a JavaScript developer. Write a single ES module file that implements a tool/skill.
The module MUST export: name (string), description (string), parameters (object), and execute (async function).
The execute function receives a single object argument with the parameter values.
The skill must be READ-ONLY — no file writes, no network mutations, no destructive operations.
Use only Node.js built-in modules (fs, path, child_process, etc.) — no npm dependencies.
Return ONLY the JavaScript code, no markdown fences, no explanation.`,
      `Implement this skill:
Name: ${skillSpec.name}
Description: ${skillSpec.description}
Parameters:
${paramDoc}

The module should look like:
export const name = "${skillSpec.name}";
export const description = "${skillSpec.description}";
export const parameters = ${JSON.stringify(skillSpec.parameters || {})};
export async function execute(args) {
  // implementation
  return "result string";
}`
    );
  } catch (err) {
    console.log(`[learner] Code generation failed: ${err.message}`);
  }

  if (!skillCode || skillCode.length < 50) {
    console.log("[learner] Generated code too short or empty, logging as proposal only");
    skillCode = null;
  }

  // Clean up code — strip markdown fences if model wrapped it
  if (skillCode) {
    skillCode = skillCode.replace(/^```(?:javascript|js|mjs)?\n?/m, "").replace(/\n?```\s*$/m, "").trim();
  }

  const proposal = {
    ...skillSpec,
    proposedAt: new Date().toISOString(),
    status: skillCode ? "installed" : "proposed",
    approved: false, // sandboxed until approved
    hasCode: !!skillCode,
  };

  if (!DRY_RUN) {
    // Log to improvements
    const improvementEntry = {
      type: "skill_proposal",
      ...proposal,
      timestamp: new Date().toISOString(),
    };
    const improvementsDir = resolve(BRAIN_DIR, "reflection");
    if (!existsSync(improvementsDir)) mkdirSync(improvementsDir, { recursive: true });

    const fs = await import("fs");
    fs.appendFileSync(IMPROVEMENTS_FILE, JSON.stringify(improvementEntry) + "\n");

    // Write skill module and update registry via pipeline if we have code
    if (skillCode) {
      const template = {
        name: skillSpec.name,
        description: skillSpec.description,
        parameters: skillSpec.parameters || {},
        source: { code: skillCode },
        tags: ["auto-generated"],
        author: "familiar-learner",
      };
      const installResult = pipelineInstallSkill(template);
      if (installResult.ok) {
        console.log(`[learner] Installed skill: ${skillSpec.name} (sandboxed until approved)`);
      } else {
        // Fallback to direct write if pipeline rejects (e.g. already exists)
        console.log(`[learner] Pipeline install note: ${installResult.message}`);
      }
    }
  }

  console.log(`[learner] ${proposal.status === "installed" ? "Installed" : "Proposed"} skill: ${skillSpec.name} — ${skillSpec.description}`);
  return proposal;
}

// ── Step 4: IDEATE ──────────────────────────────────────────────────────────

async function ideate() {
  console.log("[learner] Step 4: IDEATE");

  // Query RAG for user context
  let ragContext = "";
  try {
    const { search } = await import("./rag/index.mjs");
    const results = await search("what am I working on", 3);
    ragContext = results.map(r => r.text.slice(0, 300)).join("\n---\n");
  } catch (err) {
    console.log(`[learner] RAG unavailable: ${err.message}`);
  }

  let idea = null;
  try {
    const categories = [
      "personal — deadlines, blockers, health reminders",
      "family — schedules, education ideas, activities",
      "community — local events, civic tech, volunteering",
      "global — open source, research, climate",
      "humanitarian — trafficking awareness, disaster response, accessibility, missing persons",
    ];

    const response = await chatSmart(
      `You are a helpful AI that generates actionable ideas. Prioritize ideas that help those who can't help themselves — children, trafficking victims, disaster-affected communities. Be specific and practical.`,
      `Based on what you know about the user:\n\n${ragContext || "(no context available)"}\n\nCategories (weighted by impact):\n${categories.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\nGenerate ONE actionable idea. Output ONLY valid JSON, no other text: {"category": "personal|family|community|global|humanitarian", "title": "short title", "description": "2-3 sentence actionable description", "impact": "high|medium|low"}`
    );

    try {
      const match = response.match(/\{[\s\S]*\}/);
      if (match) idea = JSON.parse(match[0]);
    } catch { /* parse error */ }
  } catch (err) {
    console.log(`[learner] Ideate model unavailable: ${err.message}`);
  }

  if (idea) {
    const entry = {
      id: randomUUID().slice(0, 12),
      ...idea,
      timestamp: new Date().toISOString(),
      status: "new",
    };

    if (!DRY_RUN) {
      const fs = await import("fs");
      fs.appendFileSync(IDEAS_FILE, JSON.stringify(entry) + "\n");
    }

    console.log(`[learner] Idea: [${idea.category}] ${idea.title}`);
  }

  return idea;
}

// ── Step 5: INGEST ──────────────────────────────────────────────────────────

async function ingest() {
  console.log("[learner] Step 5: INGEST");

  if (DRY_RUN) {
    console.log("[learner] (dry run — skipping ingest)");
    return;
  }

  try {
    // Run the RAG ingest pipeline
    const { execSync } = await import("child_process");
    execSync(`${resolveBun()} ${resolve(BRAIN_DIR, "rag/ingest.mjs")}`, {
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: PROJECT_DIR,
    });
    console.log("[learner] RAG updated");
  } catch (err) {
    console.error("[learner] Ingest error:", err.message);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  console.log(`[learner] Starting daily learning cycle ${DRY_RUN ? "(DRY RUN)" : ""}`);
  console.log(`[learner] Date: ${new Date().toISOString().slice(0, 10)}`);

  const results = {
    reflection: null,
    learning: null,
    skill: null,
    idea: null,
  };

  try {
    // Step 1: Reflect
    results.reflection = await reflect();

    // Step 2: Learn
    results.learning = await learn(results.reflection);

    // Step 3: Install (propose skill)
    results.skill = await install(results.learning);

    // Step 4: Ideate
    results.idea = await ideate();

    // Step 5: Ingest new data into RAG
    await ingest();
  } catch (err) {
    console.error("[learner] Cycle error:", err.message);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[learner] Cycle complete in ${duration}s`);

  // Send daily summary via Telegram
  const summaryParts = [`Daily learning cycle (${duration}s):`];

  if (results.reflection) {
    summaryParts.push(`Reflected on ${results.reflection.conversationCount} conversations`);
    if (results.reflection.gaps.length > 0) {
      summaryParts.push(`Gaps: ${results.reflection.gaps.map(g => g.gap).join(", ")}`);
    }
  }

  if (results.learning) {
    const craapInfo = results.learning.craapScore != null
      ? ` (CRAAP: ${results.learning.craapScore.toFixed(2)} ${results.learning.craapRecommendation})`
      : "";
    summaryParts.push(`Learned: ${results.learning.gap.gap}${craapInfo}`);
  }

  if (results.skill) {
    const verb = results.skill.status === "installed" ? "Installed" : "Proposed";
    summaryParts.push(`${verb} skill: ${results.skill.name || "none"}${results.skill.status === "installed" ? " (sandboxed)" : ""}`);
  }

  if (results.idea) {
    summaryParts.push(`Idea [${results.idea.category}]: ${results.idea.title}`);
  }

  await notify(summaryParts.join("\n"));
}

main().catch(err => {
  console.error("[learner] Fatal:", err.message);
  process.exit(1);
});
