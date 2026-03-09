// Builds a compact memory context block from recent observations.
// Injected as a system prefix before outgoing chat messages so the agent
// gets warm context about recent work, decisions, and blockers.
// Always fails silently — never breaks the chat flow.

const MAX_CONTEXT_OBSERVATIONS = 6;
const MAX_SUMMARY_LEN = 100;
const MAX_CONTEXT_CHARS = 800;

/**
 * Truncate a string to maxLen, adding ellipsis if needed.
 */
function trunc(str, maxLen) {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

/**
 * Format an observation for context injection.
 * Keeps it terse — timestamp + type + summary only.
 */
function formatObs(obs) {
  const date = new Date(obs.timestamp);
  const label = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const project = obs.project ? `[${obs.project}] ` : "";
  const type = obs.type !== "chat_exchange" ? `(${obs.type}) ` : "";
  return `- ${label} ${project}${type}${trunc(obs.summary, MAX_SUMMARY_LEN)}`;
}

/**
 * Build a memory context prefix string for injection into chat messages.
 * Returns null if no relevant context exists or DB is unavailable.
 *
 * @param {object} opts
 * @param {string} [opts.project] - Optional project filter for relevance
 * @param {string} [opts.query]   - Optional FTS query for targeted context
 * @returns {string|null}
 */
export async function buildContextPrefix(opts = {}) {
  try {
    const mem = await import("./memory-db.js");
    const db = mem.getDb();

    let rows;

    if (opts.query) {
      // FTS-targeted context — most relevant observations
      rows = mem.search(opts.query, {
        project: opts.project,
        limit: MAX_CONTEXT_OBSERVATIONS,
      });
    } else if (opts.project) {
      // Project-scoped recent context
      rows = mem.getRecentContext(opts.project, MAX_CONTEXT_OBSERVATIONS);
    } else {
      // General recent context — skip chat_exchange noise, prefer substantive types
      rows = db
        .prepare(
          `SELECT id, type, timestamp, project, summary, tags
           FROM observations
           WHERE type != 'chat_exchange'
           ORDER BY timestamp DESC
           LIMIT ?`
        )
        .all(MAX_CONTEXT_OBSERVATIONS)
        .map((r) => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : [] }));

      // If nothing substantive, fall back to any recent
      if (rows.length === 0) {
        rows = db
          .prepare(
            `SELECT id, type, timestamp, project, summary, tags
             FROM observations
             ORDER BY timestamp DESC
             LIMIT ?`
          )
          .all(MAX_CONTEXT_OBSERVATIONS)
          .map((r) => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : [] }));
      }
    }

    if (!rows || rows.length === 0) return null;

    const lines = rows.map(formatObs);
    const block = `[Recent context]\n${lines.join("\n")}`;

    // Hard cap on total context size
    if (block.length > MAX_CONTEXT_CHARS) {
      return block.slice(0, MAX_CONTEXT_CHARS) + "\n[...truncated]";
    }

    return block;
  } catch {
    // Never break chat — return null silently
    return null;
  }
}

/**
 * Inject memory context as a prefix to a user message.
 * Only injects if there's relevant context.
 *
 * @param {string} userMessage - The raw user message
 * @param {object} opts - Options passed to buildContextPrefix
 * @returns {Promise<string>} The message, optionally prefixed with context
 */
export async function injectContext(userMessage, opts = {}) {
  try {
    const prefix = await buildContextPrefix(opts);
    if (!prefix) return userMessage;
    return `${prefix}\n\n${userMessage}`;
  } catch {
    return userMessage;
  }
}
