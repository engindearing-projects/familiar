import React from "react";
import { Box, Text } from "ink";
import { colors } from "../lib/theme.js";
import { renderMarkdown } from "../lib/markdown.js";
import { extractDiffBlocks, DiffView } from "./DiffView.js";

const e = React.createElement;

export function AssistantMessage({ text }) {
  const blocks = extractDiffBlocks(text);
  const hasDiff = blocks.some((b) => b.type === "diff");

  // If no diff blocks, render as plain markdown (fast path)
  if (!hasDiff) {
    const rendered = renderMarkdown(text);
    return e(Box, { flexDirection: "column", marginLeft: 2, marginBottom: 1 },
      e(Text, { color: colors.primaryDim, bold: true }, "familiar"),
      e(Text, null, rendered)
    );
  }

  // Mixed content: render text blocks as markdown, diff blocks as DiffView
  const children = blocks.map((block, i) => {
    if (block.type === "diff") {
      return e(DiffView, { key: `diff-${i}`, text: block.content });
    }
    const rendered = renderMarkdown(block.content);
    if (!rendered.trim()) return null;
    return e(Text, { key: `text-${i}` }, rendered);
  }).filter(Boolean);

  return e(Box, { flexDirection: "column", marginLeft: 2, marginBottom: 1 },
    e(Text, { color: colors.primaryDim, bold: true }, "familiar"),
    ...children
  );
}
