import React from "react";
import { Box, Text } from "ink";
import { colors } from "../lib/theme.js";

const e = React.createElement;

function formatDuration(ms) {
  if (!ms) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatModel(model) {
  if (!model) return null;
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("opus")) return "opus";
  if (model.includes("haiku")) return "haiku";
  if (model.includes("familiar")) return model.split("/").pop();
  if (model.includes("familiar-coder")) return "familiar-coder";
  if (model.includes("glm") && model.includes("flash")) return "glm-flash";
  if (model.startsWith("qwen2.5")) return "qwen2.5";
  if (model.includes("llama")) return model.split("/").pop();
  return model.length > 20 ? model.slice(0, 20) : model;
}

export const StatusBar = React.memo(function StatusBar({ services, session, lastMeta, leaderPending, themeName }) {
  const dots = (services || []).map((svc) => {
    const dotColor = svc.healthy ? colors.green : colors.red;
    return e(React.Fragment, { key: svc.name },
      e(Text, { color: dotColor }, "\u25CF"),
      e(Text, { color: colors.grayDim }, ` ${svc.name}  `)
    );
  });

  const metaParts = [];
  if (lastMeta?.model) {
    metaParts.push(formatModel(lastMeta.model));
  }
  if (lastMeta?.durationMs) {
    metaParts.push(formatDuration(lastMeta.durationMs));
  }
  const metaStr = metaParts.length > 0 ? metaParts.join(" \u00B7 ") : null;

  return e(Box, { marginLeft: 2, marginTop: 1 },
    // Leader key indicator
    leaderPending
      ? e(Text, { color: colors.warning, bold: true }, "C-x... ")
      : null,
    ...dots,
    e(Text, { color: colors.grayDim }, "\u2502  "),
    e(Text, { color: colors.grayDim }, session || ""),
    metaStr ? e(Text, { color: colors.grayDim }, "  \u2502  ") : null,
    metaStr ? e(Text, { color: colors.gray }, metaStr) : null,
    // Theme indicator
    themeName && themeName !== "familiar"
      ? e(Text, { color: colors.grayDim }, `  \u2502  ${themeName}`)
      : null
  );
});
