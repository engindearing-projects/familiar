#!/usr/bin/env bun

// CRAAP Source Evaluation Module
// Scores sources on Currency, Relevance, Authority, Accuracy, Purpose
// before they enter the RAG knowledge base.
//
// API:
//   import { evaluateSource, scoreCurrency, scoreRelevance } from "./craap.mjs";
//   const result = evaluateSource(source);
//   // { score: 0.72, breakdown: {...}, recommendation: "ingest" }
//
// CLI:
//   bun brain/rag/craap.mjs                          -- run sample evaluation
//   bun brain/rag/craap.mjs file <path>              -- evaluate a file
//   bun brain/rag/craap.mjs text "some content..."   -- evaluate raw text

import { existsSync, readFileSync, statSync } from "fs";
import { resolve, extname } from "path";

const PROJECT_DIR = resolve(import.meta.dir, "../..");

// ── Thresholds ───────────────────────────────────────────────────────────────

const THRESHOLDS = {
  ingest: 0.55,   // >= 0.55 total score: auto-ingest
  review: 0.35,   // >= 0.35 but < 0.55: flag for review
                   // < 0.35: reject
};

// Weights for each CRAAP dimension (must sum to 1.0)
const WEIGHTS = {
  currency:  0.20,
  relevance: 0.30,
  authority: 0.20,
  accuracy:  0.20,
  purpose:   0.10,
};

// ── Domain Knowledge ─────────────────────────────────────────────────────────

// Core domains Familiar operates in (from memory: multi-vertical)
const CORE_DOMAINS = [
  "coding", "programming", "software", "javascript", "typescript", "bun",
  "node", "react", "next.js", "rust", "python", "git", "devops",
  "kubernetes", "docker", "terraform", "aws", "cloud",
  "ai", "machine learning", "llm", "ollama", "embedding", "rag",
  "healthcare", "patient", "clinical", "hl7", "fhir", "hipaa",
  "legal", "compliance", "regulation",
  "finance", "accounting", "billing",
  "education", "training", "learning",
  "api", "rest", "graphql", "websocket", "mcp",
  "database", "mongodb", "postgresql", "sqlite", "redis",
  "security", "authentication", "authorization", "cognito",
  "infrastructure", "deployment", "ci/cd", "pipeline",
];

// Known authoritative domains
const AUTHORITATIVE_DOMAINS = [
  // Official docs
  "developer.mozilla.org", "docs.github.com", "nodejs.org",
  "bun.sh", "doc.rust-lang.org", "typescriptlang.org",
  "react.dev", "nextjs.org", "kubernetes.io", "terraform.io",
  "docs.aws.amazon.com", "cloud.google.com",
  // Standards bodies
  "w3.org", "ietf.org", "ecma-international.org", "tc39.es",
  "hl7.org", "fhir.org",
  // Trusted knowledge sources
  "arxiv.org", "ieee.org", "acm.org",
  "stackoverflow.com", "github.com",
  // Package registries
  "npmjs.com", "crates.io", "pypi.org",
];

// Patterns that suggest low-quality or biased content
const BIAS_PATTERNS = [
  /\b(buy now|limited time|act fast|click here|subscribe)\b/i,
  /\b(guaranteed|miracle|secret|shocking|unbelievable)\b/i,
  /\b(sponsored|advertisement|affiliate|promoted)\b/i,
  /\b(100% free|no risk|get rich|make money)\b/i,
  /\b(you won't believe|this one trick|doctors hate)\b/i,
];

// Patterns that suggest factual, objective content
const OBJECTIVITY_PATTERNS = [
  /\b(according to|research shows|data indicates|studies suggest)\b/i,
  /\b(documentation|specification|rfc|standard|protocol)\b/i,
  /\b(example|implementation|usage|syntax|parameter)\b/i,
  /\b(version \d|v\d+\.\d+|changelog|release notes)\b/i,
  /\b(function|class|interface|module|export|import)\b/i,
  /\b(returns?|throws?|accepts?|requires?)\b/i,
];

// ── Date Extraction ──────────────────────────────────────────────────────────

function extractDates(text) {
  const dates = [];

  // ISO dates: 2024-01-15, 2024-01-15T10:30:00Z
  const isoRe = /\b(20[12]\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b/g;
  for (const m of text.matchAll(isoRe)) {
    dates.push(new Date(m[1]));
  }

  // Written dates: January 15, 2024 / Jan 15 2024 / 15 January 2024
  const months = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const writtenRe = new RegExp(`\\b(${months})\\s+(\\d{1,2}),?\\s+(20[12]\\d)\\b|\\b(\\d{1,2})\\s+(${months}),?\\s+(20[12]\\d)\\b`, "gi");
  for (const m of text.matchAll(writtenRe)) {
    try {
      const dateStr = m[0].replace(/,/g, "");
      const parsed = new Date(dateStr);
      if (!isNaN(parsed.getTime())) dates.push(parsed);
    } catch { /* skip unparseable */ }
  }

  return dates.filter(d => !isNaN(d.getTime()));
}

function extractVersions(text) {
  // Semver-ish: v1.2.3, 1.2.3, v2.0
  const versionRe = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)\b/g;
  const versions = [];
  for (const m of text.matchAll(versionRe)) {
    // Filter out things that look like IP addresses or other numeric patterns
    if (!m[0].match(/\d+\.\d+\.\d+\.\d+/)) {
      versions.push(m[1]);
    }
  }
  return versions;
}

// ── Scoring Functions ────────────────────────────────────────────────────────

/**
 * Score how current/recent the source information is.
 * Checks for dates, version numbers, and temporal indicators.
 *
 * @param {object} source
 * @param {string} source.text - The content text
 * @param {string} [source.date] - Known date of the source (ISO string)
 * @param {string} [source.source_file] - File name/path
 * @returns {{ score: number, reasons: string[] }}
 */
export function scoreCurrency(source) {
  const reasons = [];
  let score = 0.5; // neutral starting point

  const now = new Date();
  const text = source.text || "";

  // Check explicit source date
  if (source.date) {
    const sourceDate = new Date(source.date);
    if (!isNaN(sourceDate.getTime())) {
      const daysSince = (now - sourceDate) / (1000 * 60 * 60 * 24);
      if (daysSince < 30) {
        score += 0.3;
        reasons.push(`Source date is recent (${Math.round(daysSince)} days ago)`);
      } else if (daysSince < 180) {
        score += 0.2;
        reasons.push(`Source date within 6 months`);
      } else if (daysSince < 365) {
        score += 0.1;
        reasons.push(`Source date within 1 year`);
      } else if (daysSince < 730) {
        // no bonus, no penalty
        reasons.push(`Source date is 1-2 years old`);
      } else {
        score -= 0.2;
        reasons.push(`Source date is over 2 years old`);
      }
    }
  }

  // Check dates found in the text
  const textDates = extractDates(text);
  if (textDates.length > 0) {
    const mostRecent = new Date(Math.max(...textDates.map(d => d.getTime())));
    const daysSince = (now - mostRecent) / (1000 * 60 * 60 * 24);
    if (daysSince < 90) {
      score += 0.15;
      reasons.push(`Contains recent dates (most recent: ${mostRecent.toISOString().slice(0, 10)})`);
    } else if (daysSince > 730) {
      score -= 0.1;
      reasons.push(`Dates in text are over 2 years old`);
    }
  } else {
    // No dates at all slightly penalizes — can't verify currency
    score -= 0.05;
    reasons.push("No dates found in content");
  }

  // Check for version numbers (indicates technical currency)
  const versions = extractVersions(text);
  if (versions.length > 0) {
    score += 0.05;
    reasons.push(`Contains version references: ${versions.slice(0, 3).join(", ")}`);
  }

  // Check for temporal staleness indicators
  if (/\b(deprecated|obsolete|legacy|end[- ]of[- ]life|eol|sunset)\b/i.test(text)) {
    score -= 0.15;
    reasons.push("Contains deprecation/obsolescence language");
  }

  // Check for freshness indicators
  if (/\b(latest|current|updated|new in|just released|breaking change)\b/i.test(text)) {
    score += 0.05;
    reasons.push("Contains freshness indicators");
  }

  return { score: clamp(score), reasons };
}

/**
 * Score how relevant the source is to Familiar's domains.
 *
 * @param {object} source
 * @param {string} source.text - The content text
 * @param {string[]} [context] - Additional context terms to match against
 * @returns {{ score: number, reasons: string[] }}
 */
export function scoreRelevance(source, context = []) {
  const reasons = [];
  const text = (source.text || "").toLowerCase();
  const tags = (source.tags || "").toLowerCase();

  // Count domain keyword matches
  const allTerms = [...CORE_DOMAINS, ...context.map(c => c.toLowerCase())];
  let matchCount = 0;
  const matched = [];

  for (const term of allTerms) {
    // Word boundary match to avoid partial hits
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text) || re.test(tags)) {
      matchCount++;
      if (matched.length < 5) matched.push(term);
    }
  }

  // Score based on density of domain matches
  let score;
  if (matchCount >= 8) {
    score = 0.95;
    reasons.push(`Highly relevant: ${matchCount} domain terms matched`);
  } else if (matchCount >= 5) {
    score = 0.8;
    reasons.push(`Very relevant: ${matchCount} domain terms matched`);
  } else if (matchCount >= 3) {
    score = 0.65;
    reasons.push(`Relevant: ${matchCount} domain terms matched`);
  } else if (matchCount >= 1) {
    score = 0.45;
    reasons.push(`Somewhat relevant: ${matchCount} domain term(s) matched`);
  } else {
    score = 0.15;
    reasons.push("No domain terms matched");
  }

  if (matched.length > 0) {
    reasons.push(`Matched: ${matched.join(", ")}`);
  }

  // Bonus for source type relevance
  const sourceType = source.source || "";
  if (["traces", "memory", "brain-reflection", "brain-ideas"].includes(sourceType)) {
    score += 0.1;
    reasons.push(`Source type "${sourceType}" is inherently relevant`);
  }

  // Check if content looks like code (highly relevant to a coding assistant)
  const codeIndicators = (text.match(/\b(function|const|let|import|export|async|await|return|class|interface|struct|fn|pub|impl)\b/g) || []).length;
  if (codeIndicators >= 5) {
    score += 0.1;
    reasons.push(`Contains code patterns (${codeIndicators} indicators)`);
  }

  return { score: clamp(score), reasons };
}

/**
 * Score the authority/credibility of the source.
 *
 * @param {object} source
 * @param {string} source.text - The content text
 * @param {string} [source.source] - Source type (traces, docs, git, etc.)
 * @param {string} [source.source_file] - File name or URL
 * @returns {{ score: number, reasons: string[] }}
 */
export function scoreAuthority(source) {
  const reasons = [];
  let score = 0.5;

  const sourceType = source.source || "";
  const sourceFile = source.source_file || "";
  const text = source.text || "";

  // Internal sources (our own traces, memory, reflections) are highly authoritative
  // for our purposes — they represent ground truth of our operations
  const internalSources = ["traces", "memory", "brain-reflection", "brain-ideas",
    "brain-improvements", "git", "docs", "claude-memory"];
  if (internalSources.includes(sourceType)) {
    score += 0.35;
    reasons.push(`Internal source "${sourceType}" — high authority for our context`);
  }

  // Check if source references authoritative domains
  const urlRe = /https?:\/\/([\w.-]+)/g;
  const foundDomains = [];
  for (const m of text.matchAll(urlRe)) {
    foundDomains.push(m[1].toLowerCase());
  }

  const authoritativeMentions = foundDomains.filter(d =>
    AUTHORITATIVE_DOMAINS.some(ad => d === ad || d.endsWith("." + ad))
  );

  if (authoritativeMentions.length > 0) {
    score += 0.15;
    reasons.push(`References authoritative sources: ${[...new Set(authoritativeMentions)].slice(0, 3).join(", ")}`);
  }

  // Check if source URL/file itself is from an authoritative domain
  const sourceUrlMatch = sourceFile.match(/https?:\/\/([\w.-]+)/);
  if (sourceUrlMatch) {
    const domain = sourceUrlMatch[1].toLowerCase();
    const isAuth = AUTHORITATIVE_DOMAINS.some(ad => domain === ad || domain.endsWith("." + ad));
    if (isAuth) {
      score += 0.2;
      reasons.push(`Source domain "${domain}" is authoritative`);
    }
  }

  // Check for attribution patterns (cites authors, references)
  if (/\b(authored by|written by|published by|source:|reference:|citation:)\b/i.test(text)) {
    score += 0.05;
    reasons.push("Contains attribution");
  }

  // Official documentation markers
  if (/\b(official|documentation|spec|specification|rfc \d+|standard)\b/i.test(text)) {
    score += 0.1;
    reasons.push("Contains official/documentation markers");
  }

  // Penalize anonymous or unverifiable sources
  if (!sourceType && !sourceFile && foundDomains.length === 0) {
    score -= 0.2;
    reasons.push("No source attribution — cannot verify authority");
  }

  return { score: clamp(score), reasons };
}

/**
 * Score the accuracy of the source by cross-referencing with existing knowledge.
 * This is a heuristic check — it looks for internal consistency, code correctness
 * patterns, and contradiction signals.
 *
 * @param {object} source
 * @param {string} source.text - The content text
 * @param {object} [opts]
 * @param {Array} [opts.existingChunks] - Existing RAG chunks to cross-reference against
 * @returns {{ score: number, reasons: string[] }}
 */
export function scoreAccuracy(source, opts = {}) {
  const reasons = [];
  let score = 0.6; // slightly optimistic baseline

  const text = source.text || "";
  const existingChunks = opts.existingChunks || [];

  // Check for self-contradictions (crude heuristic)
  const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 10);
  // Not much we can do with < 2 sentences
  if (sentences.length < 2) {
    reasons.push("Too short for internal consistency check");
  }

  // Check for hedging (moderate confidence language — not bad, just informational)
  const hedges = (text.match(/\b(might|maybe|possibly|unclear|uncertain|reportedly|allegedly)\b/gi) || []).length;
  if (hedges > 3) {
    score -= 0.1;
    reasons.push(`High uncertainty language (${hedges} hedging terms)`);
  } else if (hedges > 0) {
    // Some hedging is fine — shows appropriate caution
    reasons.push(`Some uncertainty language (${hedges} hedging terms)`);
  }

  // Check for absolute/unqualified claims (often inaccurate)
  const absolutes = (text.match(/\b(always|never|impossible|guaranteed|every single|without exception)\b/gi) || []).length;
  if (absolutes > 2) {
    score -= 0.1;
    reasons.push(`Contains absolute claims (${absolutes} instances) — may be inaccurate`);
  }

  // Code accuracy heuristics
  const hasCode = /```|\bfunction\b|\bconst\b|\bimport\b|\bclass\b/.test(text);
  if (hasCode) {
    // Check for common code accuracy signals
    const balancedBraces = (text.match(/\{/g) || []).length === (text.match(/\}/g) || []).length;
    const balancedParens = (text.match(/\(/g) || []).length === (text.match(/\)/g) || []).length;

    if (balancedBraces && balancedParens) {
      score += 0.1;
      reasons.push("Code has balanced braces/parens");
    } else {
      score -= 0.1;
      reasons.push("Code has unbalanced braces/parens — possible truncation or error");
    }
  }

  // Cross-reference with existing knowledge if available
  if (existingChunks.length > 0) {
    // Simple term overlap check — if content uses same terminology
    // as existing knowledge, it is more likely accurate in our context
    const sourceTerms = new Set(text.toLowerCase().split(/\W+/).filter(w => w.length > 3));
    let overlapCount = 0;
    const sampleSize = Math.min(existingChunks.length, 10);

    for (let i = 0; i < sampleSize; i++) {
      const chunkTerms = (existingChunks[i].text || "").toLowerCase().split(/\W+/).filter(w => w.length > 3);
      for (const term of chunkTerms) {
        if (sourceTerms.has(term)) overlapCount++;
      }
    }

    const avgOverlap = overlapCount / sampleSize;
    if (avgOverlap > 20) {
      score += 0.15;
      reasons.push(`Strong terminology overlap with existing knowledge (avg ${avgOverlap.toFixed(0)} terms)`);
    } else if (avgOverlap > 8) {
      score += 0.05;
      reasons.push(`Moderate terminology overlap with existing knowledge`);
    } else if (avgOverlap < 2) {
      score -= 0.05;
      reasons.push(`Very low overlap with existing knowledge — may be novel or inaccurate`);
    }
  } else {
    reasons.push("No existing knowledge to cross-reference");
  }

  // Factual patterns (numbers, specific claims)
  const specificClaims = (text.match(/\d+(?:\.\d+)?%|\d{4,}|\$\d+|RFC \d+/g) || []).length;
  if (specificClaims > 0) {
    score += 0.05;
    reasons.push(`Contains specific data points (${specificClaims} found)`);
  }

  return { score: clamp(score), reasons };
}

/**
 * Score whether the source is objective or biased/promotional.
 *
 * @param {object} source
 * @param {string} source.text - The content text
 * @returns {{ score: number, reasons: string[] }}
 */
export function scorePurpose(source) {
  const reasons = [];
  let score = 0.7; // assume decent purpose by default

  const text = source.text || "";

  // Check for promotional/biased patterns
  let biasHits = 0;
  for (const pattern of BIAS_PATTERNS) {
    if (pattern.test(text)) biasHits++;
  }

  if (biasHits >= 3) {
    score -= 0.4;
    reasons.push(`Highly promotional/biased content (${biasHits} bias patterns)`);
  } else if (biasHits >= 1) {
    score -= 0.15;
    reasons.push(`Some promotional language (${biasHits} bias pattern(s))`);
  }

  // Check for objectivity indicators
  let objectivityHits = 0;
  for (const pattern of OBJECTIVITY_PATTERNS) {
    if (pattern.test(text)) objectivityHits++;
  }

  if (objectivityHits >= 4) {
    score += 0.2;
    reasons.push(`Strong objectivity signals (${objectivityHits} patterns)`);
  } else if (objectivityHits >= 2) {
    score += 0.1;
    reasons.push(`Good objectivity signals (${objectivityHits} patterns)`);
  }

  // Excessive exclamation marks or ALL CAPS suggest promotional content
  const exclamations = (text.match(/!/g) || []).length;
  const capsWords = (text.match(/\b[A-Z]{4,}\b/g) || []).filter(
    // Exclude common acronyms
    w => !["HTML", "HTTP", "JSON", "UUID", "NULL", "TRUE", "FALSE", "HTTPS",
      "CORS", "CRUD", "REST", "FHIR", "HIPAA", "SMTP", "IMAP", "CSRF",
      "YAML", "TOML", "WASM", "BLOB", "TODO", "NOTE", "WARN", "INFO",
      "PRAGMA", "SELECT", "INSERT", "UPDATE", "DELETE", "WHERE", "FROM",
      "CREATE", "TABLE", "INDEX"].includes(w)
  ).length;

  if (exclamations > 5 || capsWords > 5) {
    score -= 0.1;
    reasons.push("Excessive emphasis (exclamations/caps) suggests promotional tone");
  }

  // Educational/informational purpose indicators
  if (/\b(tutorial|guide|how[- ]to|documentation|reference|example|walkthrough)\b/i.test(text)) {
    score += 0.1;
    reasons.push("Educational/informational purpose detected");
  }

  // Internal sources are almost always purposeful for our use
  const sourceType = source.source || "";
  if (["traces", "memory", "git", "docs", "brain-reflection"].includes(sourceType)) {
    score += 0.1;
    reasons.push("Internal source — inherently purposeful");
  }

  return { score: clamp(score), reasons };
}

// ── Combined Evaluation ──────────────────────────────────────────────────────

/**
 * Run full CRAAP evaluation on a source.
 *
 * @param {object} source
 * @param {string} source.text - The content text
 * @param {string} [source.date] - Known date (ISO string)
 * @param {string} [source.source] - Source type
 * @param {string} [source.source_file] - File name/URL
 * @param {string} [source.tags] - Comma-separated tags
 * @param {object} [opts]
 * @param {string[]} [opts.context] - Extra relevance context terms
 * @param {Array} [opts.existingChunks] - Existing chunks for cross-reference
 * @returns {{ score: number, breakdown: object, recommendation: "ingest"|"review"|"reject", reasons: string[] }}
 */
export function evaluateSource(source, opts = {}) {
  const currency = scoreCurrency(source);
  const relevance = scoreRelevance(source, opts.context || []);
  const authority = scoreAuthority(source);
  const accuracy = scoreAccuracy(source, { existingChunks: opts.existingChunks || [] });
  const purpose = scorePurpose(source);

  const weightedScore =
    currency.score * WEIGHTS.currency +
    relevance.score * WEIGHTS.relevance +
    authority.score * WEIGHTS.authority +
    accuracy.score * WEIGHTS.accuracy +
    purpose.score * WEIGHTS.purpose;

  const finalScore = clamp(weightedScore);

  let recommendation;
  if (finalScore >= THRESHOLDS.ingest) {
    recommendation = "ingest";
  } else if (finalScore >= THRESHOLDS.review) {
    recommendation = "review";
  } else {
    recommendation = "reject";
  }

  // Collect all reasons
  const allReasons = [
    ...currency.reasons.map(r => `[Currency] ${r}`),
    ...relevance.reasons.map(r => `[Relevance] ${r}`),
    ...authority.reasons.map(r => `[Authority] ${r}`),
    ...accuracy.reasons.map(r => `[Accuracy] ${r}`),
    ...purpose.reasons.map(r => `[Purpose] ${r}`),
  ];

  return {
    score: Math.round(finalScore * 100) / 100,
    breakdown: {
      currency: Math.round(currency.score * 100) / 100,
      relevance: Math.round(relevance.score * 100) / 100,
      authority: Math.round(authority.score * 100) / 100,
      accuracy: Math.round(accuracy.score * 100) / 100,
      purpose: Math.round(purpose.score * 100) / 100,
    },
    recommendation,
    reasons: allReasons,
  };
}

/**
 * Batch evaluate multiple sources, returning sorted results.
 *
 * @param {object[]} sources - Array of source objects
 * @param {object} [opts] - Options passed to evaluateSource
 * @returns {Array<{ source: object, evaluation: object }>}
 */
export function evaluateBatch(sources, opts = {}) {
  return sources
    .map(source => ({
      source,
      evaluation: evaluateSource(source, opts),
    }))
    .sort((a, b) => b.evaluation.score - a.evaluation.score);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

// ── CLI Mode ─────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);

  if (cmd === "file" && arg) {
    // Evaluate a file
    const filePath = resolve(arg);
    if (!existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }

    const stat = statSync(filePath);
    const text = readFileSync(filePath, "utf-8");
    const source = {
      text,
      date: stat.mtime.toISOString().slice(0, 10),
      source: "docs",
      source_file: filePath,
    };

    const result = evaluateSource(source);
    printResult(source, result);
    process.exit(0);
  }

  if (cmd === "text" && arg) {
    // Evaluate raw text
    const source = { text: arg };
    const result = evaluateSource(source);
    printResult(source, result);
    process.exit(0);
  }

  // Default: run sample evaluations
  console.log("CRAAP Source Evaluation — Sample Tests\n");
  console.log("=".repeat(60));

  const samples = [
    {
      name: "High quality — internal trace",
      source: {
        text: "Q: How do I configure the Kubernetes deployment for the patient portal?\nA: The patient portal uses a Helm chart in the hos-portal-api repository. You need to set MEMO_AI_URL in the environment variables. The deployment pipeline triggers automatically when you merge to dev or master branch.",
        date: new Date().toISOString().slice(0, 10),
        source: "traces",
        source_file: "2026-03-01-agent.jsonl",
        tags: "conversation,trace",
      },
    },
    {
      name: "Medium quality — external docs",
      source: {
        text: "Bun is a fast JavaScript runtime. According to the documentation, Bun v1.1.0 includes native SQLite support via bun:sqlite. The Database class accepts a file path and optional configuration. Example: const db = new Database('mydb.sqlite'); db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY)');",
        date: "2025-11-15",
        source: "docs",
        source_file: "https://bun.sh/docs/api/sqlite",
        tags: "docs,bun",
      },
    },
    {
      name: "Low quality — outdated marketing",
      source: {
        text: "BUY NOW! This amazing JavaScript framework from 2019 will GUARANTEE your app runs 1000x faster! Click here for our limited time offer. You won't believe how easy it is! Subscribe to our newsletter for more secrets. No risk, 100% free trial!!!",
        date: "2019-03-15",
        source: "",
        source_file: "",
        tags: "",
      },
    },
    {
      name: "Good quality — git commit context",
      source: {
        text: "Commit: Added CRAAP source evaluation for learner quality control\nImplemented Currency, Relevance, Authority, Accuracy, and Purpose scoring for RAG ingestion pipeline. Sources below 0.35 threshold are rejected, 0.35-0.55 flagged for review, above 0.55 auto-ingested.",
        date: new Date().toISOString().slice(0, 10),
        source: "git",
        source_file: "abc12345",
        tags: "git,commit",
      },
    },
    {
      name: "Edge case — code snippet no context",
      source: {
        text: 'export async function handler(req, res) {\n  const { id } = req.params;\n  const patient = await db.collection("patients").findOne({ _id: id });\n  if (!patient) return res.status(404).json({ error: "Not found" });\n  return res.json(patient);\n}',
        source: "",
        source_file: "",
        tags: "",
      },
    },
  ];

  for (const sample of samples) {
    const result = evaluateSource(sample.source);
    console.log(`\n${sample.name}`);
    console.log("-".repeat(50));
    printResult(sample.source, result);
  }
}

function printResult(source, result) {
  const bar = (val) => {
    const filled = Math.round(val * 20);
    return "[" + "#".repeat(filled) + ".".repeat(20 - filled) + "]";
  };

  console.log(`  Score:      ${result.score.toFixed(2)} ${bar(result.score)} -> ${result.recommendation.toUpperCase()}`);
  console.log(`  Currency:   ${result.breakdown.currency.toFixed(2)} ${bar(result.breakdown.currency)}`);
  console.log(`  Relevance:  ${result.breakdown.relevance.toFixed(2)} ${bar(result.breakdown.relevance)}`);
  console.log(`  Authority:  ${result.breakdown.authority.toFixed(2)} ${bar(result.breakdown.authority)}`);
  console.log(`  Accuracy:   ${result.breakdown.accuracy.toFixed(2)} ${bar(result.breakdown.accuracy)}`);
  console.log(`  Purpose:    ${result.breakdown.purpose.toFixed(2)} ${bar(result.breakdown.purpose)}`);
  console.log(`  Reasons:`);
  for (const r of result.reasons) {
    console.log(`    - ${r}`);
  }
}
