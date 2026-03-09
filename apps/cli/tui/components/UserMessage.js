import React from "react";
import { Box, Text } from "ink";
import { colors } from "../lib/theme.js";

const e = React.createElement;

export function UserMessage({ text }) {
  return e(Box, { marginLeft: 2, marginTop: 1 },
    e(Text, { color: colors.cyan, bold: true }, "you"),
    e(Text, { color: colors.gray }, " > "),
    e(Text, { color: colors.white }, text)
  );
}
