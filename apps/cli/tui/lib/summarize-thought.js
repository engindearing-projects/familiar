// Summarize raw agent "thought" text into a user-friendly status line via local Ollama.
// Falls back to a truncated version of the original if Ollama is unavailable or slow.

const OLLAMA_URL = "http://localhost:11434/api/chat";
const MODEL = "familiar-brain:latest";
const TIMEOUT_MS = 5000;

/**
 * Rewrite raw agent continuation/planning text into a brief friendly summary.
 * @param {string} rawText - The raw thought text from the agent
 * @returns {Promise<string>} - Summarized text, or trimmed original on failure
 */
/** Truncate to first sentence if Ollama is unavailable */
function truncate(text) {
  if (!text) return text;
  // Grab first sentence or first 120 chars
  const first = text.match(/^[^.!?\n]+[.!?]?/)?.[0] || text.slice(0, 120);
  return first.length < text.length ? first + "..." : first;
}

export async function summarizeThought(rawText) {
  if (!rawText || rawText.length < 20) return rawText;

  try {
    const resp = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "system",
            content:
              "Rewrite the following AI planning text as a casual internal monologue — like someone thinking out loud to themselves. " +
              "Use lowercase, informal tone, short phrases. No markdown, no emojis, no bullet points. " +
              "1-2 sentences max. Never start with 'Understood' or 'I'll'. " +
              "Examples of good style:\n" +
              "- 'hmm, looks like there's unfinished work from last session... should pick that up first'\n" +
              "- 'ok so the jira board has a few open tickets, let me see which one makes sense next'\n" +
              "- 'the error is pointing at the auth module, gonna dig into that'\n" +
              "- 'alright, context loaded... checking what needs attention'",
          },
          {
            role: "user",
            content: rawText.slice(0, 800),
          },
        ],
        stream: false,
        options: { num_predict: 60, temperature: 0.6 },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resp.ok) return rawText;

    const data = await resp.json();
    const summary = data.message?.content?.trim();

    return summary && summary.length > 5 ? summary : truncate(rawText);
  } catch {
    return truncate(rawText);
  }
}
