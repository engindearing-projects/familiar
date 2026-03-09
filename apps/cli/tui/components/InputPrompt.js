import React from "react";
import { Box, Text, useStdout } from "ink";
import TextInput from "ink-text-input";
import { colors } from "../lib/theme.js";

const e = React.createElement;

// Prefix length: "  familiar > " = 13 chars (or "[N queued] " variant)
const PROMPT_PREFIX_LEN = 13;

export function InputPrompt({ value, onChange, onSubmit, busy, queueLength = 0 }) {
  const { stdout } = useStdout();
  const cols = stdout?.columns || 80;
  const promptColor = busy ? colors.grayDim : colors.cyan;
  const promptBold = !busy;
  const placeholder = busy ? "Type to queue..." : "Type a message...";

  // Calculate how many rows the current input occupies
  const inputLen = PROMPT_PREFIX_LEN + (value?.length || 0);
  const rows = Math.max(1, Math.ceil(inputLen / cols));

  return e(Box, { flexDirection: "column", height: rows },
    e(Box, { flexWrap: "wrap" },
      // Queue badge
      queueLength > 0
        ? e(Text, { color: colors.yellow }, `  [${queueLength} queued] `)
        : e(Text, null, "  "),
      e(Text, { color: promptColor, bold: promptBold }, "familiar"),
      e(Text, { color: colors.gray }, " > "),
      e(TextInput, {
        value,
        onChange,
        onSubmit,
        placeholder,
      })
    )
  );
}
