// Markdown rendering for assistant messages
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { NO_COLOR } from "./theme.js";

if (!NO_COLOR) {
  marked.use(
    markedTerminal({
      // Code blocks
      code: { style: "dim" },
      // Inline code
      codespan: { style: "cyan" },
      // Headings
      heading: { style: "bold" },
      // Links
      href: { style: "cyan,underline" },
      // Tables
      tableOptions: {
        style: { head: ["cyan"] },
      },
      // General
      showSectionPrefix: false,
      reflowText: true,
      width: process.stdout.columns ? Math.min(process.stdout.columns - 4, 120) : 100,
    })
  );
}

/**
 * Render completed markdown text to ANSI terminal output.
 */
export function renderMarkdown(text) {
  if (!text) return "";
  if (NO_COLOR) return text;
  try {
    return marked.parse(text).trimEnd();
  } catch {
    return text;
  }
}

/**
 * Render markdown safely for streaming — handles incomplete fences and parse errors.
 * Closes any unclosed code fences so partial markdown doesn't crash the renderer.
 */
export function renderMarkdownSafe(text) {
  if (!text) return "";
  if (NO_COLOR) return text;
  try {
    let safe = text;
    // Count backtick fences (``` lines)
    const fenceMatches = safe.match(/^```/gm);
    const fenceCount = fenceMatches ? fenceMatches.length : 0;
    // If odd number of fences, close the last one
    if (fenceCount % 2 !== 0) {
      safe += "\n```";
    }
    return marked.parse(safe).trimEnd();
  } catch {
    // If marked throws for any reason, return raw text
    return text;
  }
}
