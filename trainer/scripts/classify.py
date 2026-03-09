"""
The Forge — Task Type Classifier (Python)
Mirrors classify.mjs logic for use in prepare-data.py.

Classifies prompts into training domains:
  coding    — code generation, editing, refactoring
  reasoning — planning, debugging, architecture, analysis
  tools     — file operations, search, shell commands, tool orchestration
  chat      — conversation, status, reminders, general Q&A

Usage:
    from classify import classify_prompt, classify_pair
    result = classify_prompt("write a function that sorts a list")
    # {'type': 'coding', 'scores': {...}, 'confidence': 0.85}
"""

import re

# ── Pattern banks ──────────────────────────────────────────────────────────

CODING_PATTERNS = [
    # Direct code requests (allows adjectives: "write a React component", "create a new endpoint")
    re.compile(r"\b(write|implement|create|build|add|generate)\s+(an?\s+)?(\w+\s+){0,3}(function|class|component|endpoint|route|script|module|handler|middleware|hook|util|api|service|page|form|modal|button|table)", re.I),
    re.compile(r"\b(refactor|rewrite|optimize|convert|migrate|port)\s", re.I),
    re.compile(r"\b(fix|patch|hotfix)\s+(the\s+)?(\w+\s+)?(bug|error|issue|crash|typo)", re.I),
    # Code-specific terms
    re.compile(r"\b(async|await|promise|callback|closure|decorator|generic|interface|enum|struct)\b", re.I),
    re.compile(r"\b(import|export|require|module\.exports|from\s+['\"])", re.I),
    re.compile(r"\b(useState|useEffect|useCallback|useMemo|useRef|useContext)\b"),
    re.compile(r"\b(SELECT|INSERT|UPDATE|DELETE|JOIN|WHERE|GROUP BY)\b"),
    re.compile(r"\b(npm|yarn|bun|pip|cargo|maven|gradle)\s+(install|add|remove|run)", re.I),
    # File extensions / languages
    re.compile(r"\.(js|ts|tsx|jsx|py|rs|go|java|rb|css|scss|html|sql|sh|yaml|json)\b"),
    re.compile(r"\b(javascript|typescript|python|rust|golang|java|ruby|swift|kotlin)\b", re.I),
    # Frameworks
    re.compile(r"\b(react|next\.?js|express|fastify|django|flask|fastapi|spring|rails)\b", re.I),
    re.compile(r"\b(prisma|sequelize|typeorm|mongoose|knex|drizzle)\b", re.I),
    # Code blocks in prompt
    re.compile(r"```[\s\S]*```"),
]

REASONING_PATTERNS = [
    # Planning / architecture
    re.compile(r"\b(plan|design|architect|strategy|approach|roadmap)\s+(for|to|the|how)", re.I),
    re.compile(r"\b(should\s+(i|we)|which\s+(is|would)\s+better|pros\s+and\s+cons|trade.?offs?)\b", re.I),
    re.compile(r"\b(compare|evaluate|assess|weigh|consider)\s+(the|these|different|various)", re.I),
    # Debugging / analysis
    re.compile(r"\b(debug|diagnose|investigate|trace|root\s+cause|why\s+(is|does|did|would))\b", re.I),
    re.compile(r"\b(error|exception|stack\s*trace|segfault|panic|crash|500|404|403|timeout)\b", re.I),
    re.compile(r"\b(failing|broken|not\s+working|doesn'?t\s+work|wrong\s+output|returning\s+\d{3})\b", re.I),
    # Code review / audit
    re.compile(r"\b(review|audit|security\s+review|code\s+review|look\s+over)\b", re.I),
    re.compile(r"\b(explain\s+(why|how|this|the)|what\s+(does|is)\s+(this|the)\s+(code|function|class))\b", re.I),
    # Architecture keywords
    re.compile(r"\b(microservice|monolith|event.?driven|pub.?sub|cqrs|saga|ddd)\b", re.I),
    re.compile(r"\b(scaling|bottleneck|latency|throughput|performance\s+issue)\b", re.I),
    # Multi-step reasoning
    re.compile(r"\b(step\s+by\s+step|break\s+(it\s+)?down|think\s+through|walk\s+me\s+through)\b", re.I),
]

TOOLS_PATTERNS = [
    # File operations
    re.compile(r"\b(read|open|cat|view|show\s+me)\s+(the\s+)?(file|contents|source)", re.I),
    re.compile(r"\b(search|find|grep|look\s+for|locate)\s+(in|for|the|across)", re.I),
    re.compile(r"\b(list|ls|show)\s+(the\s+)?(files?|directories|folders|structure)", re.I),
    # Shell / commands
    re.compile(r"\b(run|execute|bash|shell|terminal|command|script)\b", re.I),
    re.compile(r"\b(git\s+(status|log|diff|commit|push|pull|branch|merge|rebase|cherry|stash|reset|checkout|clone|init|add|tag))\b", re.I),
    re.compile(r"^git\s", re.I),  # Bare git commands are always tools
    re.compile(r"\b(docker|kubectl|terraform|ansible|helm)\s", re.I),
    re.compile(r"\b(curl|wget|ssh|scp|rsync)\s", re.I),
    # Tool call format indicators
    re.compile(r"\[Tool:\s"),
    re.compile(r"function_call|tool_use|tool_calls"),
    # Navigation
    re.compile(r"\b(navigate|go\s+to|open\s+file|jump\s+to|find\s+the\s+definition)\b", re.I),
    re.compile(r"\b(codebase|repository|repo|project\s+structure|directory\s+tree)\b", re.I),
    # CI/CD / deployment
    re.compile(r"\b(deploy|deployment|ci.?cd|pipeline|github\s+actions|workflow)\b", re.I),
    re.compile(r"\b(environment|staging|production|dev\s+server)\b", re.I),
]

CHAT_PATTERNS = [
    # Greetings / social
    re.compile(r"^(hi|hey|hello|yo|sup|thanks|thank\s+you|good\s+(morning|afternoon|evening))[\s!.,?]*$", re.I),
    re.compile(r"\b(how\s+are\s+you|what'?s?\s+up|how'?s?\s+it\s+going)\b", re.I),
    # Status / updates
    re.compile(r"\b(status|update|standup|summary|summarize|recap|overview)\b", re.I),
    re.compile(r"\b(remind|reminder|schedule|timer|alarm|note|memo)\b", re.I),
    # Simple questions (non-technical)
    re.compile(r"\b(what\s+time|what\s+day|weather|calendar)\b", re.I),
    re.compile(r"\b(who\s+(is|are)|when\s+(is|did|does|will))\b", re.I),
    # Project management
    re.compile(r"\b(jira|ticket|sprint|board|kanban|backlog|standup)\b", re.I),
    re.compile(r"\b(slack|message|channel|thread|dm|ping)\b", re.I),
]


def _score_patterns(text, patterns):
    """Count how many patterns match the text."""
    hits = 0
    for pat in patterns:
        if pat.search(text):
            hits += 1
    return hits


def classify_prompt(prompt, has_tool_calls=False, has_code=False,
                    tools_used=None, response_length=None):
    """
    Classify a prompt into a training domain type.

    Args:
        prompt: The user's message
        has_tool_calls: Whether the response contained tool calls
        has_code: Whether the response contained code blocks
        tools_used: List of tool names used in response
        response_length: Length of the response text

    Returns:
        dict with 'type', 'scores', 'confidence'
    """
    raw = {
        "coding": _score_patterns(prompt, CODING_PATTERNS),
        "reasoning": _score_patterns(prompt, REASONING_PATTERNS),
        "tools": _score_patterns(prompt, TOOLS_PATTERNS),
        "chat": _score_patterns(prompt, CHAT_PATTERNS),
    }

    max_per_category = {
        "coding": len(CODING_PATTERNS),
        "reasoning": len(REASONING_PATTERNS),
        "tools": len(TOOLS_PATTERNS),
        "chat": len(CHAT_PATTERNS),
    }

    scores = {t: hits / max_per_category[t] for t, hits in raw.items()}

    # Context bonuses from response metadata
    if has_tool_calls:
        scores["tools"] += 0.4
    if tools_used:
        scores["tools"] += 0.1 * min(len(tools_used), 3)

    if "```" in prompt:
        scores["coding"] += 0.25

    if has_code and not has_tool_calls:
        scores["coding"] += 0.15

    if response_length and response_length > 2000:
        scores["reasoning"] += 0.1

    has_any_signal = raw["coding"] > 0 or raw["reasoning"] > 0 or raw["tools"] > 0
    if len(prompt) < 30 and not has_any_signal:
        scores["chat"] += 0.5
    elif len(prompt) < 60 and not has_any_signal:
        scores["chat"] += 0.3

    # Pick winner
    best_type = max(scores, key=scores.get)
    best_score = scores[best_type]

    # Confidence: gap between winner and runner-up
    sorted_scores = sorted(scores.values(), reverse=True)
    gap = sorted_scores[0] - sorted_scores[1] if len(sorted_scores) > 1 else sorted_scores[0]
    confidence = min(1.0, gap + 0.3)

    return {"type": best_type, "scores": scores, "confidence": confidence}


def classify_pair(pair):
    """
    Classify a raw data pair and return it with task_type added.

    Works with both standard pairs (claude_response) and GT pairs (ground_truth_diff).
    """
    prompt = pair.get("prompt", "")
    claude_resp = pair.get("claude_response", "")
    gt_diff = pair.get("ground_truth_diff", "")
    response_text = claude_resp or gt_diff

    result = classify_prompt(
        prompt,
        has_code="```" in response_text,
        has_tool_calls="[Tool:" in response_text,
        response_length=len(response_text),
    )

    pair["task_type"] = result["type"]
    pair["task_type_confidence"] = result["confidence"]
    return pair


# ── Mapping: task_type → target domain ──────────────────────────────────

# Each task type maps to the domain that should train on it.
# A pair can be used by multiple domains if it's relevant.
TASK_TYPE_TO_DOMAINS = {
    "coding": ["coding"],
    "reasoning": ["reasoning"],
    "tools": ["tools"],
    "chat": ["chat"],
}

# Some domains accept secondary types too
DOMAIN_ACCEPTS = {
    "coding": {"coding"},
    "reasoning": {"reasoning"},
    "tools": {"tools", "coding"},  # tools model also learns from coding (tool+code combos)
    "chat": {"chat"},
    "brain": {"coding", "reasoning", "tools", "chat"},  # unified brain accepts everything
}


def pair_matches_domain(pair, domain_id):
    """Check if a pair should be included in training for a given domain."""
    task_type = pair.get("task_type")
    if not task_type:
        # Unclassified — only include in coding (backward compat)
        return domain_id == "coding"
    accepted = DOMAIN_ACCEPTS.get(domain_id, {domain_id})
    return task_type in accepted


if __name__ == "__main__":
    # Quick test
    test_prompts = [
        "write a function that sorts a list by name",
        "why is this throwing a null pointer exception in the payment handler?",
        "search the codebase for all uses of getUserProfile",
        "hey, what's the status of the sprint?",
        "refactor the auth middleware to use JWT tokens instead of sessions",
        "deploy the staging environment and run the migration",
        "explain how the event-driven architecture works in this system",
        "hi",
    ]

    for p in test_prompts:
        r = classify_prompt(p)
        print(f"  [{r['type']:10s}] (conf={r['confidence']:.2f}) {p[:70]}")
