// ActivityTree — live file tree with per-node breathing animations.
// Three modes: empty (null), collapsed (summary line), live (full tree).
import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { colors, NO_COLOR, NARROW } from "../lib/theme.js";
import { stripCommonPrefix, buildTree, flattenTree } from "../lib/tree-builder.js";

const e = React.createElement;

const MAX_VISIBLE = 15;
const PULSE_MS = 400;

// Tool name → short label for tree nodes
const TOOL_SHORT = {
  Read: "Reading",
  Grep: "Searching",
  Glob: "Finding",
  Bash: "Running",
  Edit: "Editing",
  Write: "Writing",
  WebFetch: "Fetching",
  WebSearch: "Searching",
};

function shortToolLabel(toolName) {
  if (!toolName) return null;
  if (TOOL_SHORT[toolName]) return TOOL_SHORT[toolName];
  for (const [key, label] of Object.entries(TOOL_SHORT)) {
    if (toolName.startsWith(key)) return label;
  }
  return null;
}

/**
 * @param {{ files: Array, busy: boolean, isCollapsed: boolean, summary: { totalFiles: number, directories: string[] } }} props
 */
export function ActivityTree({ files, busy, isCollapsed, summary }) {
  const [pulse, setPulse] = useState(false);

  // Single shared pulse toggle for all active nodes
  useEffect(() => {
    if (NO_COLOR || (!busy && isCollapsed)) return;
    const id = setInterval(() => setPulse((p) => !p), PULSE_MS);
    return () => clearInterval(id);
  }, [busy, isCollapsed]);

  // Empty — nothing to show
  if (!files || files.length === 0) return null;

  // Collapsed — single summary line
  if (isCollapsed && !busy) {
    const dirs = summary.directories.length > 0
      ? summary.directories.slice(0, 4).join(" ")
      : "";
    const suffix = summary.directories.length > 4
      ? ` +${summary.directories.length - 4} more`
      : "";
    const label = NO_COLOR
      ? `* ${summary.totalFiles} file${summary.totalFiles !== 1 ? "s" : ""} ${dirs}${suffix}`
      : null;

    return e(Box, { marginLeft: 2, marginTop: 0, marginBottom: 0 },
      NO_COLOR
        ? e(Text, null, label)
        : e(Text, { color: colors.gray },
            "\u270E ",
            e(Text, { color: colors.green }, `${summary.totalFiles} file${summary.totalFiles !== 1 ? "s" : ""}`),
            ` \u00B7 ${dirs}${suffix}`
          )
    );
  }

  // NARROW mode — compact single line
  if (NARROW) {
    const activeCount = files.filter((f) => f.status === "active").length;
    const doneCount = files.filter((f) => f.status === "done").length;
    const parts = [];
    if (activeCount > 0) parts.push(`${activeCount} active`);
    if (doneCount > 0) parts.push(`${doneCount} done`);
    return e(Box, { marginLeft: 2 },
      e(Text, { color: NO_COLOR ? undefined : colors.gray }, `files: ${parts.join(", ")}`)
    );
  }

  // Live mode — full tree with box-drawing and animations
  const { prefix, entries: stripped } = stripCommonPrefix(files);
  const tree = buildTree(stripped);
  const lines = flattenTree(tree, NO_COLOR);

  const overflow = lines.length > MAX_VISIBLE ? lines.length - MAX_VISIBLE : 0;
  const visible = overflow > 0 ? lines.slice(0, MAX_VISIBLE) : lines;

  const headerText = prefix ? `files: ${prefix}/` : "files:";

  return e(Box, { flexDirection: "column", marginLeft: 2, marginTop: 0, marginBottom: 0 },
    // Header
    e(Text, { color: NO_COLOR ? undefined : colors.gray }, headerText),
    // Tree lines
    ...visible.map((line, i) => {
      const { indent, connector, node } = line;
      const isActive = node.status === "active";
      const isDone = node.status === "done";
      const toolLabel = isActive ? shortToolLabel(node.toolName) : null;

      // Node glyph
      let glyph;
      let glyphColor;
      if (node.isDir) {
        glyph = NO_COLOR ? ">" : "\u25B8";
        glyphColor = NO_COLOR ? undefined : (isDone ? colors.green : colors.yellow);
      } else if (isDone) {
        glyph = NO_COLOR ? "+" : "\u2713";
        glyphColor = NO_COLOR ? undefined : colors.green;
      } else if (isActive) {
        glyph = NO_COLOR ? "*" : (pulse ? "\u25CF" : "\u25C9");
        glyphColor = NO_COLOR ? undefined : (pulse ? colors.cyan : colors.cyanDim);
      } else {
        glyph = NO_COLOR ? "-" : "\u2022";
        glyphColor = NO_COLOR ? undefined : colors.gray;
      }

      return e(Box, { key: `tree-${i}` },
        e(Text, { color: NO_COLOR ? undefined : colors.grayDim }, indent + connector),
        e(Text, { color: glyphColor }, glyph + " "),
        e(Text, { color: NO_COLOR ? undefined : (isActive ? colors.white : colors.gray) }, node.name),
        toolLabel
          ? e(Text, { color: NO_COLOR ? undefined : colors.grayDim }, ` ${toolLabel}`)
          : null
      );
    }),
    // Overflow indicator
    overflow > 0
      ? e(Text, { color: NO_COLOR ? undefined : colors.grayDim }, `    ... and ${overflow} more file${overflow !== 1 ? "s" : ""}`)
      : null
  );
}
