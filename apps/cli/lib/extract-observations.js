// Lightweight pattern-based observation extraction.
// Runs after each completed exchange to capture decisions, blockers, preferences,
// and task updates into the memory DB. Detects any Jira-style ticket tags automatically.
// All errors are caught silently — this must never break chat.

import { addObservation } from "./memory-db.js";

// --- Detection patterns ---

const TICKET_PATTERN = /\b([A-Z]{2,10}-\d+)\b/g;

const DECISION_PHRASES = [
  "let's",
  "let's",
  "going with",
  "decided to",
  "decision is",
  "we'll go with",
  "i'll go with",
  "plan is to",
];

const BLOCKER_PHRASES = [
  "blocked by",
  "waiting on",
  "can't proceed",
  "cannot proceed",
  "depends on",
  "blocking issue",
  "stuck on",
];

const PREFERENCE_PHRASES = [
  "always use",
  "prefer",
  "never use",
  "convention is",
  "standard is",
  "rule is",
  "from now on",
];

const TASK_COMPLETION_PHRASES = [
  "done with",
  "merged",
  "deployed",
  "completed",
  "shipped",
  "finished",
  "landed",
  "closed",
];

// Greetings and trivial messages to skip
const SKIP_PATTERNS = [
  /^(hi|hey|hello|yo|sup|thanks|ty|ok|okay|sure|yep|yup|nope|no|yes|k|lol|lmao|haha|hmm)\.?$/i,
];

// Short affirmatives — user is confirming, not providing content.
// When matched, the assistant response is used for the summary instead.
const AFFIRMATIVE_PATTERNS = [
  /^(yes|yep|yup|yeah|sure|do it|go ahead|go for it|sounds good|perfect|great|exactly|correct|right|that works|ok do it|please do|approved|confirmed|start|proceed)/i,
];

/**
 * Check if a message is trivial and should be skipped.
 */
function isTrivial(text) {
  if (!text || text.length < 3) return true;
  const trimmed = text.trim();
  if (trimmed.split(/\s+/).length <= 1 && trimmed.length < 10) return true;
  return SKIP_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Check if user message is a short affirmative/confirmation.
 * These shouldn't be used as observation summaries.
 */
function isAffirmative(text) {
  const trimmed = text.trim();
  if (trimmed.split(/\s+/).length > 8) return false;
  return AFFIRMATIVE_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Check if text contains any of the given phrases (case-insensitive).
 */
function containsPhrase(text, phrases) {
  const lower = text.toLowerCase();
  return phrases.some((phrase) => lower.includes(phrase));
}

/**
 * Extract all unique Jira ticket references from combined text.
 */
function extractTickets(text) {
  const matches = text.match(TICKET_PATTERN);
  if (!matches) return [];
  return [...new Set(matches.map((t) => t.toUpperCase()))];
}

/**
 * Build a short summary from user text (first meaningful sentence, capped).
 */
function summarize(text, maxLen = 120) {
  // Take first line or first sentence
  const first = text.split(/[.\n]/).find((s) => s.trim().length > 10) || text;
  const trimmed = first.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 3) + "...";
}

/**
 * Extract observations from a completed exchange and store them.
 * Returns an array of observation IDs. Never throws.
 *
 * @param {string} userText - The user's message
 * @param {string} assistantText - The assistant's response
 * @param {string} source - Origin identifier (e.g. "tui", "cli-oneshot")
 * @returns {string[]} Array of observation IDs created
 */
export function extractAndStore(userText, assistantText, source) {
  try {
    if (!userText || !assistantText) return [];

    const userTrimmed = userText.trim();
    const assistantTrimmed = assistantText.trim();

    // Skip trivial exchanges
    if (isTrivial(userTrimmed)) return [];
    if (assistantTrimmed.length < 20) return [];

    const combined = userTrimmed + " " + assistantTrimmed;
    const tickets = extractTickets(combined);
    const ids = [];

    // When the user message is just a confirmation ("yes", "do it", etc.),
    // use the assistant response as the summary source — it has the real content.
    const summarySource = isAffirmative(userTrimmed) ? assistantTrimmed : userTrimmed;

    // --- Decision detection ---
    if (containsPhrase(combined, DECISION_PHRASES)) {
      const id = addObservation({
        type: "decision",
        project: null,
        summary: summarize(summarySource),
        details: assistantTrimmed.slice(0, 500),
        tags: tickets.length ? tickets : undefined,
        source,
      });
      ids.push(id);
    }

    // --- Blocker detection ---
    if (containsPhrase(combined, BLOCKER_PHRASES)) {
      const id = addObservation({
        type: "blocker",
        project: null,
        summary: summarize(summarySource),
        details: assistantTrimmed.slice(0, 500),
        tags: tickets.length ? tickets : undefined,
        source,
      });
      ids.push(id);
    }

    // --- Preference detection ---
    if (containsPhrase(combined, PREFERENCE_PHRASES)) {
      const id = addObservation({
        type: "preference",
        project: null,
        summary: summarize(summarySource),
        details: assistantTrimmed.slice(0, 500),
        tags: tickets.length ? tickets : undefined,
        source,
      });
      ids.push(id);
    }

    // --- Task completion detection ---
    if (containsPhrase(combined, TASK_COMPLETION_PHRASES)) {
      const id = addObservation({
        type: "task_update",
        project: null,
        summary: summarize(summarySource),
        details: assistantTrimmed.slice(0, 500),
        tags: tickets.length ? tickets : undefined,
        source,
      });
      ids.push(id);
    }

    // --- Lightweight chat_exchange only when no typed observation was captured ---
    // Avoids redundant records when a specific type already covers the exchange.
    if (ids.length === 0) {
      const exchangeId = addObservation({
        type: "chat_exchange",
        project: null,
        summary: summarize(summarySource),
        tags: tickets.length ? tickets : undefined,
        source,
      });
      ids.push(exchangeId);
    }

    return ids;
  } catch {
    // Never break chat — swallow all errors silently
    return [];
  }
}
