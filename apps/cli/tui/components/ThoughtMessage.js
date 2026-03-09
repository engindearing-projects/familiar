import React from "react";
import { Box, Text } from "ink";
import { colors } from "../lib/theme.js";

const e = React.createElement;

const THOUGHT_COLOR = "#a78bfa";   // soft purple — distinct from cyan assistant
const BUBBLE_BORDER = "#7c3aed";   // deeper purple for the border
const DOT_COLOR = "#8b5cf6";       // mid purple for trail dots

export function ThoughtMessage({ text }) {
  // Wrap text to fit inside the bubble (leave room for border + padding)
  const cols = process.stdout.columns || 80;
  const maxWidth = Math.min(cols - 10, 70);

  // Word-wrap the text into lines
  const lines = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph.trim()) { lines.push(""); continue; }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (line.length + word.length + 1 > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = line ? line + " " + word : word;
      }
    }
    if (line) lines.push(line);
  }

  return e(Box, { flexDirection: "column", marginLeft: 4, marginBottom: 1 },
    // Thought bubble with rounded border
    e(Box, {
        flexDirection: "column",
        borderStyle: "round",
        borderColor: BUBBLE_BORDER,
        paddingLeft: 1,
        paddingRight: 1,
      },
      e(Text, { color: THOUGHT_COLOR, italic: true },
        lines.join("\n")
      )
    ),
    // Thought trail — the classic bubble dots
    e(Text, { color: DOT_COLOR }, "      ○"),
    e(Text, { color: DOT_COLOR }, "     ○"),
    e(Text, { color: DOT_COLOR }, "    familiar")
  );
}
