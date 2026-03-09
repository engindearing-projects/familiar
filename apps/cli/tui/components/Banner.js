import React, { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import { colors, VERSION, NO_COLOR } from "../lib/theme.js";

const ACTIVITY_URL = `http://localhost:${process.env.ACTIVITY_PORT || 18790}`;

const e = React.createElement;

const STATIC_TIPS = [
  "/memory to search past context",
  "/observe to save a quick note",
  "/status for service health",
  "shift+tab for task panel",
  "/help for all commands",
];

function buildFileSummary(summary) {
  if (!summary || !summary.totalFiles) return null;
  const dirs = summary.directories.length > 0
    ? summary.directories.slice(0, 4).join(" ")
    : "";
  const suffix = summary.directories.length > 4
    ? ` +${summary.directories.length - 4} more`
    : "";
  return `\u270E ${summary.totalFiles} file${summary.totalFiles !== 1 ? "s" : ""} \u00B7 ${dirs}${suffix}`;
}

function buildTips() {
  return [...STATIC_TIPS];
}

export const Banner = React.memo(function Banner({ files, summary, isCollapsed }) {
  const [tipIdx, setTipIdx] = useState(0);
  const [unreadInfo, setUnreadInfo] = useState(null);
  const tipsRef = useRef(buildTips());

  // Tips: rotate every 30s
  useEffect(() => {
    const id = setInterval(() => {
      setTipIdx((i) => (i + 1) % tipsRef.current.length);
    }, 30000);
    return () => clearInterval(id);
  }, []);

  // Fetch unread from activity server on mount, auto-mark-read
  useEffect(() => {
    fetch(`${ACTIVITY_URL}/unread?platform=cli`, { signal: AbortSignal.timeout(3000) })
      .then((r) => r.json())
      .then((data) => {
        if (data.unreadCount > 0) {
          const platforms = [...new Set(data.latest.map((i) => i.platform))];
          setUnreadInfo(`${data.unreadCount} update${data.unreadCount !== 1 ? "s" : ""} from ${platforms.join(", ")}`);
          // Auto-mark-read after display
          const maxId = Math.max(...data.latest.map((i) => i.id));
          fetch(`${ACTIVITY_URL}/cursor`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ platform: "cli", last_seen_id: maxId }),
            signal: AbortSignal.timeout(3000),
          }).catch(() => {});
        }
      })
      .catch(() => {});
  }, []);

  const cwd = process.cwd().replace(process.env.HOME || "", "~");
  const fileLine = buildFileSummary(summary);
  const tip = tipsRef.current[tipIdx % tipsRef.current.length];

  if (NO_COLOR) {
    return e(Box, { flexDirection: "column", marginBottom: 1 },
      e(Box, null,
        e(Text, null, "familiar"),
        e(Text, null, ` \u00B7 v${VERSION}`)
      ),
      e(Text, null, cwd),
      fileLine && e(Text, null, `  ${fileLine}`),
      unreadInfo && e(Text, null, `  > ${unreadInfo}`),
      e(Text, null, `  tip: ${tip}`)
    );
  }

  return e(Box, { flexDirection: "column", marginBottom: 1 },
    e(Box, null,
      e(Text, { color: colors.cyan, bold: true }, "familiar"),
      e(Text, { color: colors.gray }, ` \u00B7 v${VERSION}`)
    ),
    e(Text, { color: colors.grayDim }, cwd),
    fileLine && e(Text, { color: colors.green }, `  ${fileLine}`),
    unreadInfo && e(Text, { color: colors.yellow }, `  \u21B3 ${unreadInfo}`),
    e(Text, { color: colors.gray }, `  tip: ${tip}`)
  );
});
