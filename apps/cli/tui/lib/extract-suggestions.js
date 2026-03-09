// Extract SUGGESTIONS: [...] from assistant messages.
// Format: SUGGESTIONS: ["cmd1", "cmd2", "cmd3"]

const SUGGESTIONS_RE = /SUGGESTIONS:\s*(\[.*?\])/s;

/**
 * Extract suggestion strings from assistant text.
 * @param {string} text
 * @returns {string[]} up to 5 suggestions
 */
export function extractSuggestions(text) {
  const match = text.match(SUGGESTIONS_RE);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[1]);
    if (!Array.isArray(arr)) return [];
    return arr.filter((s) => typeof s === "string").slice(0, 5);
  } catch {
    return [];
  }
}

/**
 * Strip the SUGGESTIONS: [...] block from text.
 * @param {string} text
 * @returns {string}
 */
export function stripSuggestions(text) {
  return text.replace(SUGGESTIONS_RE, "").trimEnd();
}
