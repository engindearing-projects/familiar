import React from "react";
import { Box, Text } from "ink";
import { colors } from "../lib/theme.js";

const e = React.createElement;

export function SystemMessage({ text }) {
  return e(Box, { marginY: 0, marginLeft: 2 },
    e(Text, { color: colors.grayDim, dimColor: true }, text)
  );
}
