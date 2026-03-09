import React from "react";
import { Box, Text } from "ink";
import { colors } from "../lib/theme.js";

const e = React.createElement;

export function ErrorBanner({ error }) {
  if (!error) return null;

  return e(Box, { marginLeft: 2, marginTop: 1 },
    e(Text, { color: colors.red, bold: true }, "\u2716 "),
    e(Text, { color: colors.red }, error)
  );
}
