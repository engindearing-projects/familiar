// Token estimation utilities for context management
// Simple heuristic: ~4 chars per token (matches RAG chunking convention)

/**
 * Estimate token count for a text string.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Estimate total token count across an array of chat messages.
 * @param {Array<{content: string}>} messages
 * @returns {number}
 */
export function estimateMessages(messages) {
  if (!messages?.length) return 0;
  return messages.reduce((n, m) => n + estimateTokens(m.content || ""), 0);
}
