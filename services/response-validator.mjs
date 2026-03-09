#!/usr/bin/env bun

// Response Validator — Hallucination Detection for Familiar
// Validates model responses before they reach the user.
// Checks for repetition loops, language drift, empty stubs,
// tool avoidance, timeout truncation, and tool error rates.
//
// Usage:
//   import { validateResponse } from "./response-validator.mjs";
//   const result = validateResponse({ text, prompt, role, finishReason, toolCalls, iterations });
//   // result: { pass: boolean, confidence: number, flags: string[] }

/**
 * Detect repeating n-grams (>3 repeats of same 20+ char substring).
 * Returns true if a repetition loop is detected.
 */
function detectRepetitionLoop(text) {
  if (!text || text.length < 80) return false;

  // Check for repeated substrings of length 20-100
  for (const len of [20, 40, 60, 100]) {
    if (text.length < len * 3) continue;

    const seen = new Map();
    for (let i = 0; i <= text.length - len; i += Math.max(1, Math.floor(len / 4))) {
      const chunk = text.slice(i, i + len);
      const count = (seen.get(chunk) || 0) + 1;
      seen.set(chunk, count);
      if (count >= 3) return true;
    }
  }

  // Also check for repeated lines
  const lines = text.split("\n").filter((l) => l.trim().length > 10);
  if (lines.length >= 6) {
    const lineCounts = new Map();
    for (const line of lines) {
      const trimmed = line.trim();
      const count = (lineCounts.get(trimmed) || 0) + 1;
      lineCounts.set(trimmed, count);
      if (count >= 4) return true;
    }
  }

  return false;
}

/**
 * Detect language drift — response language doesn't match prompt.
 * Uses both non-ASCII ratio AND common non-English word patterns.
 */
// Common function words in languages that small models drift into
const NON_ENGLISH_MARKERS = [
  // Spanish
  /\b(el|la|los|las|es|que|en|por|para|una|del|con|como|pero|esta|esto|ese|puede|necesitas?|funcione|correctamente|archivo|cambiar|sistema|nuevo)\b/gi,
  // French
  /\b(le|la|les|des|est|que|dans|pour|une|avec|sur|pas|mais|cette|sont|vous|nous)\b/gi,
  // Portuguese
  /\b(o|os|ao|da|do|na|no|em|que|com|para|uma|mas|pode|este|isso|arquivo)\b/gi,
  // Chinese/Japanese/Korean (any CJK)
  /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g,
  // Cyrillic
  /[\u0400-\u04ff]/g,
  // Arabic
  /[\u0600-\u06ff]/g,
];

function detectLanguageDrift(text, prompt) {
  if (!text || !prompt) return false;
  if (text.length < 40) return false;

  // Check if prompt is primarily English
  const promptNonAscii = (prompt.match(/[^\x00-\x7F]/g) || []).length;
  const promptIsEnglish = promptNonAscii / prompt.length < 0.1;
  if (!promptIsEnglish) return false;

  // Method 1: Non-ASCII character ratio (catches CJK, Cyrillic, Arabic)
  const responseChars = text.replace(/[\s\n\r\t]/g, "");
  const nonAscii = (responseChars.match(/[^\x00-\x7F]/g) || []).length;
  if (nonAscii / responseChars.length > 0.3) return true;

  // Method 2: Non-English word frequency (catches Spanish, French, etc.)
  const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (words.length < 10) return false;

  let foreignHits = 0;
  for (const pattern of NON_ENGLISH_MARKERS) {
    const matches = text.match(pattern);
    if (matches) foreignHits += matches.length;
    pattern.lastIndex = 0; // reset regex state
  }

  // If >40% of words match non-English markers, flag it
  return foreignHits / words.length > 0.4;
}

/**
 * Detect tool avoidance — model should have used tools but didn't.
 * Checks for coding/tools role with 0 tool calls when prompt asks for action.
 */
const ACTION_PATTERNS = [
  /\b(read|write|edit|create|delete|move|copy|rename)\b.*\b(files?|dirs?|folders?|code)\b/i,
  /\b(run|execute|install|build|test|deploy)\b/i,
  /\b(list|show|find|search|grep|check)\b.*\b(files?|dirs?|code|logs?|errors?)\b/i,
  /\b(what('s| is) in|contents? of|open)\b/i,
  /\b(fix|debug|update|change|modify)\b.*\b(code|files?|bugs?|errors?)\b/i,
  /\b(commit|push|pull|branch|merge)\b/i,
  /\b(battery|disk|memory|cpu|process|port)\b.*\b(level|usage|status|info)\b/i,
];

// Knowledge questions that can be answered without tools
const KNOWLEDGE_PATTERNS = [
  /^(how do (i|you|we)|how to|how can (i|you|we))\b/i,
  /^(what is|what are|what'?s)\b/i,
  /^(explain|describe|tell me about|why does|why is|why do)\b/i,
  /^(can (i|you|we)|should (i|we)|is it possible)\b/i,
  /^(what'?s? the (difference|best|right))\b/i,
];

function detectToolAvoidance(role, toolCalls, prompt) {
  if (role !== "coding" && role !== "tools") return false;
  if (!toolCalls || toolCalls.length > 0) return false;

  // Don't flag knowledge questions — these can be answered without tools
  if (KNOWLEDGE_PATTERNS.some((p) => p.test(prompt.trim()))) return false;

  // Check if prompt asks for an action that requires tools
  return ACTION_PATTERNS.some((p) => p.test(prompt));
}

/**
 * Validate a model response for quality.
 *
 * @param {object} opts
 * @param {string} opts.text - The model's response text
 * @param {string} opts.prompt - The original user prompt
 * @param {string} opts.role - The classified role (coding/tools/reasoning/chat)
 * @param {string} [opts.finishReason] - How the generation ended
 * @param {Array} [opts.toolCalls] - Tool calls made during generation
 * @param {number} [opts.iterations] - Number of tool loop iterations
 *
 * @returns {{ pass: boolean, confidence: number, flags: string[] }}
 */
export function validateResponse(opts) {
  const {
    text = "",
    prompt = "",
    role = "chat",
    finishReason = "complete",
    toolCalls = [],
    iterations = 0,
  } = opts;

  const flags = [];
  let score = 1.0;

  // 1. Repetition loop: 3+ repeats of 20+ char substring
  if (detectRepetitionLoop(text)) {
    flags.push("repetition_loop");
    score -= 0.6;
  }

  // 2. Language drift: >30% non-ASCII when prompt is ASCII
  if (detectLanguageDrift(text, prompt)) {
    flags.push("language_drift");
    score -= 0.4;
  }

  // 3. Empty or stub response (skip for chat role with short prompts — greetings are naturally short)
  if (!text || text.trim().length < 30) {
    const isGreetingResponse = role === "chat" && prompt.trim().length < 50;
    if (!isGreetingResponse) {
      flags.push("empty_or_stub");
      score -= 0.6;
    }
  }

  // 4. Tool avoidance: role=coding/tools, 0 tool calls, prompt asks for action
  if (detectToolAvoidance(role, toolCalls, prompt)) {
    flags.push("tool_avoidance");
    score -= 0.3;
  }

  // 5. Timeout or max iterations truncation
  if (finishReason === "timeout" || finishReason === "max_iterations") {
    flags.push("timeout_truncation");
    score -= 0.3;
  }

  // 6. Error finish
  if (finishReason === "error" || finishReason === "empty_response") {
    flags.push("error_finish");
    score -= 0.5;
  }

  // 7. High tool error rate: >50% of tool calls failed
  if (toolCalls.length > 0) {
    const failures = toolCalls.filter((tc) => tc.ok === false).length;
    if (failures / toolCalls.length > 0.5) {
      flags.push("tool_error_rate");
      score -= 0.2;
    }
  }

  // Clamp score
  const confidence = Math.max(0, Math.min(1, score));

  // Thresholds: <=0.5 = fail, 0.5-0.7 = flag, >0.7 = pass
  const pass = confidence > 0.5;

  return { pass, confidence, flags };
}

export default validateResponse;
