// Step progress list for the setup wizard.
// Renders all steps with their current status.

import React from "react";
import { Box } from "ink";
import { ProgressStep } from "./ProgressStep.js";

const e = React.createElement;

/**
 * @typedef {object} StepDef
 * @property {string} id - Step identifier
 * @property {string} label - Display label
 * @property {"done"|"active"|"pending"|"failed"|"skipped"} status
 * @property {string} [detail] - Optional detail text
 */

/**
 * Render a vertical list of steps with status icons.
 * @param {{ steps: StepDef[] }} props
 */
export function StepList({ steps }) {
  return e(Box, { flexDirection: "column", marginTop: 1 },
    ...steps.map((step) =>
      e(ProgressStep, {
        key: step.id,
        status: step.status,
        label: step.label,
        detail: step.detail,
      })
    )
  );
}
