// Dynamic status — generates creative task-specific status messages via local Ollama.
// Falls back gracefully to null if Ollama is slow or unavailable.

const OLLAMA_URL = "http://localhost:11434/api/chat";
const MODEL = "familiar-coder:latest";
const TIMEOUT_MS = 1500;
const CYCLE_INTERVAL_MS = 3000;

/**
 * Generate creative one-liner status messages from local LLM.
 * Returns null if Ollama is unavailable or too slow.
 * @param {string} userQuery - What the user asked
 * @returns {Promise<string[]|null>}
 */
export async function generateStatusMessages(userQuery) {
  try {
    const resp = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "user",
            content: `Generate 6-8 witty one-liners (max 50 chars each, no emojis) describing what an AI assistant is doing while working on: "${userQuery.slice(0, 100)}". Just the lines, no numbering.`,
          },
        ],
        stream: false,
        options: { num_predict: 256, temperature: 0.9 },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resp.ok) return null;

    const data = await resp.json();
    const content = data.message?.content || "";

    // Parse: split lines, strip numbering, filter by length
    const lines = content
      .split("\n")
      .map((l) => l.replace(/^\d+[\.\)]\s*/, "").replace(/^[-*]\s*/, "").trim())
      .filter((l) => l.length >= 10 && l.length <= 50);

    return lines.length >= 3 ? lines : null;
  } catch {
    return null;
  }
}

/**
 * Creates a status message cycler that fire-and-forgets Ollama calls.
 * @returns {{ start: (query: string) => void, current: () => string|null, stop: () => void }}
 */
export function createStatusCycler() {
  let messages = null;
  let idx = 0;
  let timer = null;
  let cachedQuery = null;

  function cycle() {
    if (messages && messages.length > 0) {
      idx = (idx + 1) % messages.length;
    }
  }

  return {
    /**
     * Start generating and cycling status messages for a query.
     * Reuses cached messages if the same query is sent again.
     */
    start(query) {
      // Reuse cached messages for the same query
      if (cachedQuery === query && messages) {
        idx = 0;
        if (!timer) {
          timer = setInterval(cycle, CYCLE_INTERVAL_MS);
        }
        return;
      }

      // Reset
      messages = null;
      idx = 0;
      cachedQuery = query;

      // Clear existing timer
      if (timer) {
        clearInterval(timer);
        timer = null;
      }

      // Fire-and-forget Ollama call
      generateStatusMessages(query).then((result) => {
        if (result) {
          messages = result;
          idx = 0;
          if (!timer) {
            timer = setInterval(cycle, CYCLE_INTERVAL_MS);
          }
        }
      });
    },

    /** Returns current status message or null if not ready. */
    current() {
      if (!messages || messages.length === 0) return null;
      return messages[idx];
    },

    /** Stop cycling. */
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
