import React from "react";
import { Box, Text } from "ink";
import { colors } from "../lib/theme.js";

const e = React.createElement;

/**
 * Check if text contains a unified diff.
 * Looks for ---/+++/@@ patterns that indicate diff format.
 */
export function containsDiff(text) {
  if (!text) return false;
  // Match unified diff headers
  const hasFileHeaders = /^---\s+\S/m.test(text) && /^\+\+\+\s+\S/m.test(text);
  const hasHunkHeaders = /^@@\s+-\d+/m.test(text);
  return hasFileHeaders && hasHunkHeaders;
}

/**
 * Extract diff blocks from mixed text.
 * Returns array of { type: "text"|"diff", content: string }
 */
export function extractDiffBlocks(text) {
  if (!text) return [{ type: "text", content: "" }];

  const lines = text.split("\n");
  const blocks = [];
  let current = { type: "text", lines: [] };
  let inDiff = false;

  for (const line of lines) {
    // Detect start of a diff block
    if (!inDiff && (line.startsWith("diff --git") || line.startsWith("--- "))) {
      // Check if next-ish line has +++ to confirm it's a diff
      const idx = lines.indexOf(line);
      const upcoming = lines.slice(idx, idx + 5).join("\n");
      if (/^\+\+\+\s/m.test(upcoming)) {
        // Flush current text block
        if (current.lines.length > 0) {
          blocks.push({ type: current.type, content: current.lines.join("\n") });
        }
        current = { type: "diff", lines: [line] };
        inDiff = true;
        continue;
      }
    }

    // Detect end of diff block (empty line after diff content, or non-diff line)
    if (inDiff) {
      const isDiffLine = line.startsWith("+") || line.startsWith("-") || line.startsWith("@") ||
        line.startsWith(" ") || line.startsWith("diff ") || line.startsWith("index ") ||
        line.startsWith("\\") || line === "";

      if (isDiffLine || line.startsWith("--- ") || line.startsWith("+++ ")) {
        current.lines.push(line);
        continue;
      } else {
        // End of diff
        blocks.push({ type: "diff", content: current.lines.join("\n") });
        current = { type: "text", lines: [line] };
        inDiff = false;
        continue;
      }
    }

    current.lines.push(line);
  }

  // Flush remaining
  if (current.lines.length > 0) {
    blocks.push({ type: current.type, content: current.lines.join("\n") });
  }

  return blocks;
}

/**
 * Parse a unified diff into structured hunks.
 */
function parseDiff(diffText) {
  const lines = diffText.split("\n");
  const files = [];
  let currentFile = null;
  let currentHunk = null;

  for (const line of lines) {
    // File header: --- a/path or --- /dev/null
    if (line.startsWith("--- ")) {
      currentFile = { oldFile: line.slice(4), newFile: null, hunks: [] };
      files.push(currentFile);
      continue;
    }

    // File header: +++ b/path
    if (line.startsWith("+++ ") && currentFile) {
      currentFile.newFile = line.slice(4);
      continue;
    }

    // Hunk header: @@ -start,count +start,count @@
    const hunkMatch = line.match(/^@@\s+(-\d+(?:,\d+)?)\s+(\+\d+(?:,\d+)?)\s+@@(.*)/);
    if (hunkMatch && currentFile) {
      currentHunk = {
        oldRange: hunkMatch[1],
        newRange: hunkMatch[2],
        context: hunkMatch[3].trim(),
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    // diff --git or index lines — skip
    if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("\\")) {
      continue;
    }

    // Diff content lines
    if (currentHunk) {
      if (line.startsWith("+")) {
        currentHunk.lines.push({ type: "add", text: line.slice(1) });
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({ type: "del", text: line.slice(1) });
      } else if (line.startsWith(" ")) {
        currentHunk.lines.push({ type: "ctx", text: line.slice(1) });
      } else if (line === "") {
        currentHunk.lines.push({ type: "ctx", text: "" });
      }
    }
  }

  return files;
}

/**
 * Compute line numbers for diff lines within a hunk.
 */
function computeLineNumbers(hunk) {
  const oldMatch = hunk.oldRange.match(/-(\d+)/);
  const newMatch = hunk.newRange.match(/\+(\d+)/);
  let oldLine = oldMatch ? parseInt(oldMatch[1]) : 1;
  let newLine = newMatch ? parseInt(newMatch[1]) : 1;

  return hunk.lines.map((line) => {
    const result = { ...line, oldLineNo: null, newLineNo: null };
    if (line.type === "ctx") {
      result.oldLineNo = oldLine++;
      result.newLineNo = newLine++;
    } else if (line.type === "del") {
      result.oldLineNo = oldLine++;
    } else if (line.type === "add") {
      result.newLineNo = newLine++;
    }
    return result;
  });
}

/**
 * DiffView component — renders a unified diff with semantic colors.
 *
 * Props:
 *   text: string — raw unified diff text
 */
export function DiffView({ text }) {
  if (!text) return null;

  const files = parseDiff(text);
  if (files.length === 0) {
    return e(Text, { color: colors.textMuted }, text);
  }

  const elements = [];

  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    const fileName = file.newFile || file.oldFile || "unknown";
    const displayName = fileName.replace(/^[ab]\//, "");

    // File header
    elements.push(
      e(Box, { key: `file-${fi}`, marginTop: fi > 0 ? 1 : 0 },
        e(Text, { color: colors.primary, bold: true }, `  ${displayName}`)
      )
    );

    for (let hi = 0; hi < file.hunks.length; hi++) {
      const hunk = file.hunks[hi];
      const numberedLines = computeLineNumbers(hunk);

      // Hunk header
      const hunkLabel = `@@ ${hunk.oldRange} ${hunk.newRange} @@`;
      elements.push(
        e(Box, { key: `hunk-${fi}-${hi}`, marginTop: 0 },
          e(Text, { color: colors.primaryDim },
            `  ${hunkLabel}`,
            hunk.context ? ` ${hunk.context}` : ""
          )
        )
      );

      // Diff lines
      for (let li = 0; li < numberedLines.length; li++) {
        const line = numberedLines[li];
        const oldNo = line.oldLineNo ? String(line.oldLineNo).padStart(4) : "    ";
        const newNo = line.newLineNo ? String(line.newLineNo).padStart(4) : "    ";

        let lineColor, prefix;
        if (line.type === "add") {
          lineColor = colors.green;
          prefix = "+";
        } else if (line.type === "del") {
          lineColor = colors.red;
          prefix = "-";
        } else {
          lineColor = colors.textMuted;
          prefix = " ";
        }

        elements.push(
          e(Box, { key: `line-${fi}-${hi}-${li}` },
            e(Text, { color: colors.textDim }, `${oldNo} ${newNo} `),
            e(Text, { color: lineColor }, `${prefix}${line.text}`)
          )
        );
      }
    }
  }

  return e(Box, { flexDirection: "column", marginLeft: 2 }, ...elements);
}
