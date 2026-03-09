// The Forge — Task Type Classifier
// Analyzes prompts and classifies them into training domains:
//   coding   — code generation, editing, refactoring
//   reasoning — planning, debugging, architecture, analysis
//   tools    — file operations, search, shell commands, tool orchestration
//   chat     — conversation, status, reminders, general Q&A
//
// Used by the collector at ingestion time to tag pairs,
// and mirrored in Python (scripts/classify.py) for prepare-data.
//
// Usage:
//   import { classifyPrompt } from "./classify.mjs";
//   const { type, scores, confidence } = classifyPrompt(prompt, { hasToolCalls: true });

// ── Pattern banks ──────────────────────────────────────────────────────────

const CODING_PATTERNS = [
  // Direct code requests (allows adjectives: "write a React component", "create a new REST API endpoint")
  /\b(write|implement|create|build|add|generate)\s+(an?\s+)?(\w+\s+){0,3}(function|class|component|endpoint|route|script|module|handler|middleware|hook|util|api|service|page|form|modal|button|table)/i,
  /\b(refactor|rewrite|optimize|convert|migrate|port)\s/i,
  /\b(fix|patch|hotfix)\s+(the\s+)?(\w+\s+)?(bug|error|issue|crash|typo)/i,
  // Code-specific terms
  /\b(async|await|promise|callback|closure|decorator|generic|interface|enum|struct)\b/i,
  /\b(import|export|require|module\.exports|from\s+['"])/i,
  /\b(useState|useEffect|useCallback|useMemo|useRef|useContext)\b/,
  /\b(SELECT|INSERT|UPDATE|DELETE|JOIN|WHERE|GROUP BY)\b/,
  /\b(npm|yarn|bun|pip|cargo|maven|gradle)\s+(install|add|remove|run)/i,
  // File extensions / languages
  /\.(js|ts|tsx|jsx|py|rs|go|java|rb|css|scss|html|sql|sh|yaml|json)\b/,
  /\b(javascript|typescript|python|rust|golang|java|ruby|swift|kotlin)\b/i,
  // Frameworks
  /\b(react|next\.?js|express|fastify|django|flask|fastapi|spring|rails)\b/i,
  /\b(prisma|sequelize|typeorm|mongoose|knex|drizzle)\b/i,
  // Code blocks in prompt
  /```[\s\S]*```/,
];

const REASONING_PATTERNS = [
  // Planning / architecture
  /\b(plan|design|architect|strategy|approach|roadmap)\s+(for|to|the|how)/i,
  /\b(should\s+(i|we)|which\s+(is|would)\s+better|pros\s+and\s+cons|trade.?offs?)\b/i,
  /\b(compare|evaluate|assess|weigh|consider)\s+(the|these|different|various)/i,
  // Debugging / analysis
  /\b(debug|diagnose|investigate|trace|root\s+cause|why\s+(is|does|did|would))\b/i,
  /\b(error|exception|stack\s*trace|segfault|panic|crash|500|404|403|timeout)\b/i,
  /\b(failing|broken|not\s+working|doesn'?t\s+work|wrong\s+output|returning\s+\d{3})\b/i,
  // Code review / audit
  /\b(review|audit|security\s+review|code\s+review|look\s+over)\b/i,
  /\b(explain\s+(why|how|this|the)|what\s+(does|is)\s+(this|the)\s+(code|function|class))\b/i,
  // Architecture keywords
  /\b(microservice|monolith|event.?driven|pub.?sub|cqrs|saga|ddd)\b/i,
  /\b(scaling|bottleneck|latency|throughput|performance\s+issue)\b/i,
  // Multi-step reasoning
  /\b(step\s+by\s+step|break\s+(it\s+)?down|think\s+through|walk\s+me\s+through)\b/i,
];

const TOOLS_PATTERNS = [
  // File operations
  /\b(read|open|cat|view|show\s+me)\s+(the\s+)?(file|contents|source)/i,
  /\b(search|find|grep|look\s+for|locate)\s+(in|for|the|across)/i,
  /\b(list|ls|show)\s+(the\s+)?(files?|directories|folders|structure)/i,
  // Shell / commands
  /\b(run|execute|bash|shell|terminal|command|script)\b/i,
  /\b(git\s+(status|log|diff|commit|push|pull|branch|merge|rebase|cherry|stash|reset|checkout|clone|init|add|tag))\b/i,
  /^git\s/i,  // Bare git commands are always tools
  /\b(docker|kubectl|terraform|ansible|helm)\s/i,
  /\b(curl|wget|ssh|scp|rsync)\s/i,
  // Tool call format indicators
  /\[Tool:\s/,
  /function_call|tool_use|tool_calls/,
  // Navigation
  /\b(navigate|go\s+to|open\s+file|jump\s+to|find\s+the\s+definition)\b/i,
  /\b(codebase|repository|repo|project\s+structure|directory\s+tree)\b/i,
  // CI/CD / deployment
  /\b(deploy|deployment|ci.?cd|pipeline|github\s+actions|workflow)\b/i,
  /\b(environment|staging|production|dev\s+server)\b/i,
  // System / computer queries (require daemon tools)
  /\b(battery|charging|power)\s*(level|status|percent|life)?\b/i,
  /\b(screenshot|screen\s*shot|screen\s*cap|capture\s+(the\s+)?screen)\b/i,
  /\b(windows?|apps?)\b.*\b(open|running|active)\b/i,
  /\b(clipboard|copy|paste)\s*(content|text|value)?\b/i,
  /\b(volume|mute|unmute|audio|sound)\s*(level)?\b/i,
  /\b(brightness|display|screen)\s*(level|info|settings)?\b/i,
  /\b(disk|storage)\s*(usage|space|free|available|left)?\b/i,
  /\b(check|how\s+much)\b.*\b(disk|space|storage)\b/i,
  /\b(cpu|memory|ram|process|processes)\s*(usage|info|list)?\b/i,
  /\b(wifi|network|ip\s*address|connected|internet)\s*(status|info|name)?\b/i,
  /\b(click|type|press|move\s+mouse|hotkey|key\s*press)\b/i,
  /\b(open|launch|quit|close|kill)\s+(the\s+)?(app|application|program|safari|chrome|terminal|finder)\b/i,
  /\b(ocr|read\s+(the\s+)?screen|text\s+on\s+screen)\b/i,
  /\b(system\s+info|uptime|hostname|os\s+version)\b/i,
];

const CHAT_PATTERNS = [
  // Greetings / social
  /^(hi|hey|hello|yo|sup|thanks|thank\s+you|good\s+(morning|afternoon|evening))[\s!.,?]*$/i,
  /\b(how\s+are\s+you|what'?s?\s+up|how'?s?\s+it\s+going)\b/i,
  // Status / updates
  /\b(status|update|standup|summary|summarize|recap|overview)\b/i,
  /\b(remind|reminder|schedule|timer|alarm|note|memo)\b/i,
  // Simple questions (non-technical)
  /\b(what\s+time|what\s+day|weather|calendar)\b/i,
  /\b(who\s+(is|are)|when\s+(is|did|does|will))\b/i,
  // Project management
  /\b(jira|ticket|sprint|board|kanban|backlog|standup)\b/i,
  /\b(slack|message|channel|thread|dm|ping)\b/i,
];

// ── Scoring ────────────────────────────────────────────────────────────────

function scorePatterns(text, patterns) {
  let hits = 0;
  for (const pat of patterns) {
    if (pat.test(text)) hits++;
  }
  return hits;
}

/**
 * Classify a prompt into a training domain type.
 *
 * @param {string} prompt - The user's message
 * @param {object} [opts]
 * @param {boolean} [opts.hasToolCalls] - Response contained tool calls
 * @param {boolean} [opts.hasCode] - Response contained code blocks
 * @param {string[]} [opts.toolsUsed] - Names of tools used in response
 * @param {number} [opts.responseLength] - Length of the response
 * @returns {{ type: string, scores: object, confidence: number }}
 */
export function classifyPrompt(prompt, opts = {}) {
  const { hasToolCalls, hasCode, toolsUsed, responseLength } = opts;

  // Score each category
  const raw = {
    coding: scorePatterns(prompt, CODING_PATTERNS),
    reasoning: scorePatterns(prompt, REASONING_PATTERNS),
    tools: scorePatterns(prompt, TOOLS_PATTERNS),
    chat: scorePatterns(prompt, CHAT_PATTERNS),
  };

  // Normalize to 0-1 range based on pattern count
  const maxPerCategory = {
    coding: CODING_PATTERNS.length,
    reasoning: REASONING_PATTERNS.length,
    tools: TOOLS_PATTERNS.length,
    chat: CHAT_PATTERNS.length,
  };

  const scores = {};
  for (const [type, hits] of Object.entries(raw)) {
    scores[type] = hits / maxPerCategory[type];
  }

  // ── Context bonuses from response metadata ──

  // If the response had tool calls, strongly boost tools
  if (hasToolCalls) {
    scores.tools += 0.4;
  }
  if (toolsUsed && toolsUsed.length > 0) {
    scores.tools += 0.1 * Math.min(toolsUsed.length, 3);
  }

  // Code blocks in prompt → coding boost
  if (/```/.test(prompt)) {
    scores.coding += 0.25;
  }

  // Code blocks in response (but not tool calls) → coding
  if (hasCode && !hasToolCalls) {
    scores.coding += 0.15;
  }

  // Very long response with reasoning keywords → reasoning
  if (responseLength && responseLength > 2000) {
    scores.reasoning += 0.1;
  }

  // No technical signals → bias toward chat (safe default)
  const hasAnySignal = raw.coding > 0 || raw.reasoning > 0 || raw.tools > 0;
  if (!hasAnySignal) {
    if (prompt.length < 30) {
      scores.chat += 0.5;
    } else if (prompt.length < 60) {
      scores.chat += 0.3;
    } else {
      scores.chat += 0.15;
    }
  }

  // ── Pick winner ──
  // bestScore starts at 0 so categories need actual signal to win.
  // If nothing scores above 0, bestType stays "chat" (safe fallback).

  let bestType = "chat";
  let bestScore = 0;

  for (const [type, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestType = type;
    }
  }

  // Confidence: how far ahead is the winner vs runner-up
  const sorted = Object.values(scores).sort((a, b) => b - a);
  const gap = sorted.length > 1 ? sorted[0] - sorted[1] : sorted[0];
  const confidence = Math.min(1, gap + 0.3); // baseline confidence of 0.3

  return { type: bestType, scores, confidence };
}

/**
 * Batch classify an array of pairs (for retroactive tagging).
 *
 * @param {object[]} pairs - Array of raw pair objects
 * @returns {object[]} Same pairs with task_type added
 */
export function classifyPairs(pairs) {
  return pairs.map((pair) => {
    const result = classifyPrompt(pair.prompt, {
      hasCode: /```/.test(pair.claude_response || ""),
      hasToolCalls: /\[Tool:/.test(pair.claude_response || ""),
    });
    return { ...pair, task_type: result.type, task_type_confidence: result.confidence };
  });
}

export default { classifyPrompt, classifyPairs };
