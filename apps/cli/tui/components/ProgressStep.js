// Individual step rendering for the setup wizard.
// Shows icon + label + optional detail, with spinner for active steps.

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { colors } from "../lib/theme.js";

const e = React.createElement;

// Status icons
const ICONS = {
  done: { char: "\u2713", color: colors.green },     // checkmark
  active: { char: "\u25CF", color: colors.cyan },     // filled circle
  pending: { char: "\u25CB", color: colors.grayDim }, // empty circle
  failed: { char: "\u2717", color: colors.red },      // x mark
  skipped: { char: "\u2500", color: colors.grayDim }, // dash
};

/**
 * @param {{ status: "done"|"active"|"pending"|"failed"|"skipped", label: string, detail?: string }} props
 */
export function ProgressStep({ status, label, detail }) {
  const icon = ICONS[status] || ICONS.pending;
  const labelColor =
    status === "done" ? colors.green :
    status === "active" ? colors.white :
    status === "failed" ? colors.red :
    colors.grayDim;

  return e(Box, { marginLeft: 2 },
    status === "active"
      ? e(Text, { color: colors.cyan }, e(Spinner, { type: "dots" }))
      : e(Text, { color: icon.color }, icon.char),
    e(Text, null, " "),
    e(Text, { color: labelColor }, label),
    detail
      ? e(Text, { color: colors.gray }, `  ${detail}`)
      : null
  );
}
