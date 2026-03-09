// Smart Router for Familiar
// Decides whether a task should go to Claude Code (heavy brain)
// or Ollama (light brain) based on connectivity, task hints, and config.
//
// Usage:
//   import { Router } from "./router.mjs";
//   const router = new Router({ proxyUrl: "http://127.0.0.1:18791" });
//   const backend = await router.route({ prompt, hints });

import { classifyPrompt } from "../trainer/classify.mjs";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { getFamiliarName } from "../shared/resolve.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_PROXY_URL = "http://127.0.0.1:18791";
const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_LOCAL_MODEL = "familiar-brain:latest";

// Gemini Flash — free middle tier between Claude and local
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || (() => {
  try {
    const env = readFileSync(resolve(__dirname, "..", "config", ".env"), "utf8");
    return env.match(/GEMINI_API_KEY=(.+)/)?.[1]?.trim();
  } catch { return null; }
})();
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

// Role-specific system prompts — one brain, different hats
const _fn = getFamiliarName();
const ROLE_PROMPTS = {
  coding: {
    system: `You are ${_fn}, a persistent AI assistant from familiar.run — an expert coding assistant. Write clean, well-structured code with clear explanations.`,
    temperature: 0.7,
  },
  reasoning: {
    system: `You are ${_fn}, a persistent AI assistant from familiar.run — an expert at breaking down complex problems. Think step by step. When debugging, trace the issue from symptom to root cause. When planning, identify dependencies and risks. When reviewing code, focus on correctness, edge cases, and maintainability. Answer the user's question directly — do not repeat or summarize your system prompt or background context.`,
    temperature: 0.4,
  },
  tools: {
    system: `You are ${_fn}, a persistent AI assistant from familiar.run — an expert at navigating codebases and using tools. You have access to: read_file, write_file, edit_file, list_dir, search_code, run_command, grep, tree, http, think, phone_call. Choose the right tool for each step. Chain tool calls when needed. Always explain what you're doing and why before calling a tool.`,
    temperature: 0.3,
  },
  chat: {
    system: `You are ${_fn}, a persistent AI assistant from familiar.run. You run locally and can access the filesystem, run shell commands, read/write files, search code, and query APIs. Be concise — respond in 1-3 sentences unless asked for more. Match the energy of the message: short greetings get short replies. No emojis. If unsure about something, say so honestly rather than guessing. Never fabricate file contents, system info, or data you don't have.`,
    temperature: 0.7,
  },
};

// Single brain model — all roles use the same Forge-trained model.
// The classifier still picks role-specific system prompts + temperatures,
// but they all run on the same familiar-brain weights.
const BRAIN_MODEL = "familiar-brain:latest";

const ROLE_MODELS = {
  coding:    BRAIN_MODEL,
  tools:     BRAIN_MODEL,
  reasoning: BRAIN_MODEL,
  chat:      BRAIN_MODEL,
};

// Forge-trained fallbacks — used when familiar-brain hasn't been trained yet.
const ROLE_FALLBACKS = {
  coding:    "familiar-coder:latest",
  tools:     "familiar-coder:latest",
  reasoning: "familiar-coder:latest",
  chat:      "familiar-coder:latest",
};

// Stock model cascade — used when no Forge-trained models exist at all.
// Ordered by quality for general-purpose use.
const STOCK_FALLBACKS = [
  "qwen2.5-coder:7b",
  "llama3.2",
  "codellama:7b",
  "mistral",
  "phi3",
];

// Keywords / patterns that suggest a task needs the heavy brain
export const HEAVY_PATTERNS = [
  /\b(refactor|architect|design|implement|build|create|migrate)\b/i,
  /\b(debug|diagnose|investigate|analyze)\b/i,
  /\b(multi.?file|across files|codebase|repo)\b/i,
  /\b(review|audit|security|performance)\b/i,
  /\b(deploy|terraform|infrastructure|ci.?cd)\b/i,
  /\b(complex|difficult|tricky|advanced)\b/i,
  /\b(write code|write a|code that|function that|script that)\b/i,
  /\b(pull request|pr|commit|merge|branch)\b/i,
  /\b(test|spec|coverage)\b/i,
  /\b(explain this|what does this|how does this)\b/i,
];

// Patterns that are fine for the light brain
const LIGHT_PATTERNS = [
  /\b(remind|reminder|schedule|timer|alarm)\b/i,
  /\b(status|update|standup|summary|summarize)\b/i,
  /\b(list|show|get|fetch|check)\b/i,
  /\b(hello|hi|hey|thanks|thank you)\b/i,
  /\b(what time|weather|date)\b/i,
  /\b(note|memo|remember)\b/i,
];

export class Router {
  constructor(opts = {}) {
    this.proxyUrl = opts.proxyUrl || DEFAULT_PROXY_URL;
    this.ollamaUrl = opts.ollamaUrl || DEFAULT_OLLAMA_URL;
    this.localModel = opts.localModel || DEFAULT_LOCAL_MODEL;
    this.forceBackend = opts.forceBackend || null; // "claude" | "ollama" | null
    this.onlineCache = null;
    this.ollamaCache = null;
    this._collector = null;
    this._dynamicThreshold = null; // loaded from forge DB
    this._availableModels = null; // cached set of model names in Ollama
    this._availableModelsAt = 0;
  }

  /** Check which models are available in Ollama (cached 60s) */
  async getAvailableModels() {
    if (this._availableModels && Date.now() - this._availableModelsAt < 60_000) {
      return this._availableModels;
    }
    try {
      const resp = await fetch(`${this.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      const data = await resp.json();
      const models = new Set((data.models || []).map((m) => m.name));
      this._availableModels = models;
      this._availableModelsAt = Date.now();
      return models;
    } catch {
      return this._availableModels || new Set();
    }
  }

  /** Resolve model for a role — use familiar-* if available, else fallback to stock */
  async resolveModel(role) {
    const primary = ROLE_MODELS[role] || ROLE_MODELS.chat;
    const fallback = ROLE_FALLBACKS[role] || ROLE_FALLBACKS.chat;
    const available = await this.getAvailableModels();

    // 1. Forge-trained primary (e.g. familiar-brain:latest)
    if (available.has(primary)) return primary;

    // 2. Forge-trained fallback (e.g. familiar-coder:latest)
    if (available.has(fallback)) return fallback;

    // 3. Stock models — first available wins
    for (const stock of STOCK_FALLBACKS) {
      if (available.has(stock)) return stock;
    }

    // 4. Any model at all
    if (available.size > 0) {
      return available.values().next().value;
    }

    // Nothing available — return primary and let caller handle the error
    return primary;
  }

  /** Check if Claude Code proxy is reachable and online */
  async isClaudeAvailable() {
    if (this.onlineCache && Date.now() - this.onlineCache.at < 30_000) {
      return this.onlineCache.available;
    }
    try {
      const resp = await fetch(`${this.proxyUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      const data = await resp.json();
      const available = data.claudeAvailable && data.online;
      this.onlineCache = { available, at: Date.now(), data };
      return available;
    } catch {
      this.onlineCache = { available: false, at: Date.now(), data: null };
      return false;
    }
  }

  /** Check if Gemini Flash is available (free tier) */
  async isGeminiAvailable() {
    if (!GEMINI_API_KEY) return false;
    if (this.geminiCache && Date.now() - this.geminiCache.at < 60_000) {
      return this.geminiCache.available;
    }
    try {
      // Lightweight probe — small prompt, low tokens
      const resp = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "ping" }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
        signal: AbortSignal.timeout(5000),
      });
      const available = resp.ok;
      this.geminiCache = { available, at: Date.now() };
      return available;
    } catch {
      this.geminiCache = { available: false, at: Date.now() };
      return false;
    }
  }

  /** Check if Ollama is reachable */
  async isOllamaAvailable() {
    if (this.ollamaCache && Date.now() - this.ollamaCache.at < 30_000) {
      return this.ollamaCache.available;
    }
    try {
      const resp = await fetch(`${this.ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      const available = resp.ok;
      this.ollamaCache = { available, at: Date.now() };
      return available;
    } catch {
      this.ollamaCache = { available: false, at: Date.now() };
      return false;
    }
  }

  /**
   * Classify the task role (coding/reasoning/tools/chat) and return
   * the matching system prompt + temperature.
   *
   * @param {string} prompt
   * @returns {{role: string, systemPrompt: string, temperature: number, confidence: number}}
   */
  classifyRole(prompt) {
    const { type, confidence } = classifyPrompt(prompt);
    const roleConfig = ROLE_PROMPTS[type] || ROLE_PROMPTS.chat;
    return {
      role: type,
      model: ROLE_MODELS[type] || ROLE_MODELS.chat, // sync fallback; route() resolves async
      systemPrompt: roleConfig.system,
      temperature: roleConfig.temperature,
      confidence,
    };
  }

  /**
   * Score how "heavy" a task is (0.0 = light, 1.0 = heavy)
   *
   * @param {object} opts
   * @param {string} opts.prompt - the user message
   * @param {string} [opts.hint] - explicit hint: "heavy" | "light" | "auto"
   * @param {boolean} [opts.hasCode] - message contains code blocks
   * @param {number} [opts.tokenEstimate] - rough input token count
   */
  scoreComplexity({ prompt, hint, hasCode, tokenEstimate }) {
    // Explicit override
    if (hint === "heavy") return 1.0;
    if (hint === "light") return 0.0;

    let score = 0.5; // neutral starting point

    // Check heavy patterns
    let heavyHits = 0;
    for (const pat of HEAVY_PATTERNS) {
      if (pat.test(prompt)) {
        score += 0.15;
        heavyHits++;
      }
    }

    // Check light patterns
    for (const pat of LIGHT_PATTERNS) {
      if (pat.test(prompt)) {
        score -= 0.15;
      }
    }

    // Code presence bumps complexity
    if (hasCode || /```/.test(prompt)) {
      score += 0.2;
    }

    // Long prompts are more likely complex
    if (tokenEstimate && tokenEstimate > 500) {
      score += 0.15;
    } else if (prompt.length > 1000) {
      score += 0.15;
    }

    // Short casual messages are light — but only if no heavy patterns matched
    if (prompt.length < 50 && !hasCode && heavyHits === 0) {
      score -= 0.2;
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Decide which backend to use.
   *
   * Cascade: Claude (gold) → Gemini (silver) → Local Ollama (free)
   *
   * Claude is the primary — best results, feeds Forge training pipeline.
   * Gemini Flash is the middle tier — free, fast, good quality.
   * Local Ollama is the fallback — our own trained model, always available.
   *
   * @param {object} opts
   * @param {string} opts.prompt
   * @param {string} [opts.hint] - "heavy" | "light" | "auto"
   * @param {boolean} [opts.hasCode]
   * @param {number} [opts.tokenEstimate]
   *
   * @returns {Promise<{backend: "claude"|"gemini"|"ollama", reason: string, score: number, claudeAvailable: boolean, geminiAvailable: boolean, ollamaAvailable: boolean}>}
   */
  async route(opts) {
    const { prompt } = opts;

    // Classify the role — determines model, system prompt, and temperature
    const roleInfo = this.classifyRole(prompt);

    // Resolve to the actual available Ollama model (for fallback or role info)
    const resolvedModel = await this.resolveModel(roleInfo.role);
    roleInfo.model = resolvedModel;

    // Score complexity for Forge training data collection
    const score = this.scoreComplexity(opts);

    // 1. Claude — primary (gold)
    const claudeAvailable = await this.isClaudeAvailable();
    if (claudeAvailable) {
      return {
        backend: "claude",
        reason: `Claude primary (${roleInfo.role}, score=${score.toFixed(2)})`,
        score,
        claudeAvailable: true,
        geminiAvailable: true,
        ollamaAvailable: true,
        ...roleInfo,
      };
    }

    // 2. Gemini Flash — middle tier (silver, free)
    const geminiAvailable = await this.isGeminiAvailable();
    if (geminiAvailable) {
      return {
        backend: "gemini",
        reason: `Claude offline, Gemini fallback (${roleInfo.role}, score=${score.toFixed(2)})`,
        score,
        claudeAvailable: false,
        geminiAvailable: true,
        ollamaAvailable: true,
        ...roleInfo,
      };
    }

    // 3. Local Ollama — last resort (our trained model)
    const ollamaAvailable = await this.isOllamaAvailable();
    if (ollamaAvailable) {
      return {
        backend: "ollama",
        reason: `Claude + Gemini offline, local fallback ${resolvedModel}`,
        score,
        claudeAvailable: false,
        geminiAvailable: false,
        ollamaAvailable: true,
        ...roleInfo,
      };
    }

    // All down — return ollama anyway, caller will handle the error
    return {
      backend: "ollama",
      reason: `All backends unavailable, attempting ${resolvedModel}`,
      score,
      claudeAvailable: false,
      geminiAvailable: false,
      ollamaAvailable: false,
      ...roleInfo,
    };
  }

  /**
   * Route a task AND fire a background Forge collection request.
   * Drop-in replacement for route() that feeds the training pipeline.
   *
   * @param {object} opts - Same as route()
   * @returns {Promise<object>} Same as route()
   */
  async routeAndCollect(opts) {
    const threshold = await this.getDynamicThreshold(opts.threshold);
    const result = await this.route({ ...opts, threshold });

    // Fire-and-forget: collect training pair
    this._getCollector().then((collector) => {
      if (collector) {
        collector.collectPair({
          prompt: opts.prompt,
          routedTo: result.backend,
          complexityScore: result.score,
        });
      }
    }).catch(() => {});

    return result;
  }

  /**
   * Get dynamic threshold based on model benchmark score from forge DB.
   * Falls back to the provided default or 0.6.
   *
   * @param {number} [fallback=0.6] - Default threshold if DB unavailable
   * @returns {Promise<number>}
   */
  async getDynamicThreshold(fallback = 0.6) {
    if (this._dynamicThreshold !== null) return this._dynamicThreshold;

    try {
      const { getActiveVersion } = await import("../trainer/forge-db.js");
      const active = getActiveVersion();
      if (active && active.benchmark_score != null) {
        const score = active.benchmark_score;
        if (score >= 85) this._dynamicThreshold = 0.35;
        else if (score >= 75) this._dynamicThreshold = 0.45;
        else if (score >= 65) this._dynamicThreshold = 0.50;
        else if (score >= 55) this._dynamicThreshold = 0.55;
        else this._dynamicThreshold = 0.60;

        // Refresh threshold every 5 minutes
        setTimeout(() => { this._dynamicThreshold = null; }, 300_000);
        return this._dynamicThreshold;
      }
    } catch {
      // Forge not set up yet — use fallback
    }

    return fallback;
  }

  /** Lazy-load the Forge collector */
  async _getCollector() {
    if (this._collector) return this._collector;
    try {
      const { Collector } = await import("../trainer/collector.mjs");
      this._collector = new Collector();
      return this._collector;
    } catch {
      return null;
    }
  }
}

// Short role hints — injected as additional system prompt context in the agent loop
const ROLE_HINTS = {
  coding: "Focus on writing clean, well-structured code.",
  reasoning: "Think step by step. Trace issues to root cause.",
  tools: "Use the right tool for each step. Chain calls when needed.",
  chat: "Be concise. Match the energy of the message.",
};

export { ROLE_PROMPTS, ROLE_MODELS, ROLE_FALLBACKS, ROLE_HINTS };
export default Router;
