import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { colors } from "../lib/theme.js";

const e = React.createElement;

function formatDate(dateStr) {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

function formatRelative(dateStr) {
  if (!dateStr) return "";
  try {
    const now = Date.now();
    const d = new Date(dateStr).getTime();
    const diffMs = now - d;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } catch {
    return "";
  }
}

/**
 * SessionList overlay component.
 *
 * Props:
 *   sessions: array — list of session objects from gateway
 *   currentSessionId: string|null — currently active session ID
 *   onSelect: (sessionId) => void — switch to selected session
 *   onClose: () => void — close the overlay
 *   onFork: (sessionId) => void — fork selected session
 *   onArchive: (sessionId) => void — archive selected session
 *   loading: boolean
 */
export function SessionList({ sessions, currentSessionId, onSelect, onClose, onFork, onArchive, loading }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const maxVisible = Math.min(sessions.length, 15);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (key.return) {
      const session = sessions[selectedIndex];
      if (session) {
        onClose();
        onSelect(session.id);
      }
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(sessions.length - 1, i + 1));
      return;
    }

    // 'f' to fork
    if (input === "f") {
      const session = sessions[selectedIndex];
      if (session && onFork) {
        onFork(session.id);
      }
      return;
    }

    // 'a' to archive
    if (input === "a") {
      const session = sessions[selectedIndex];
      if (session && onArchive) {
        onArchive(session.id);
      }
      return;
    }
  });

  if (loading) {
    return e(Box, {
      borderStyle: "round",
      borderColor: colors.primary,
      paddingX: 1,
      marginX: 2,
      marginY: 1,
    },
      e(Text, { color: colors.textMuted }, "Loading sessions...")
    );
  }

  const visibleStart = Math.max(0, selectedIndex - maxVisible + 1);
  const visibleItems = sessions.slice(visibleStart, visibleStart + maxVisible);

  return e(Box, {
    flexDirection: "column",
    borderStyle: "round",
    borderColor: colors.primary,
    paddingX: 1,
    marginX: 2,
    marginY: 1,
  },
    // Header
    e(Box, { marginBottom: 1 },
      e(Text, { color: colors.primary, bold: true }, "Sessions"),
      e(Text, { color: colors.textMuted }, "  enter=switch  f=fork  a=archive  esc=close")
    ),
    // Session list
    sessions.length === 0
      ? e(Text, { color: colors.textMuted }, "No sessions yet. Use /session new to create one.")
      : null,
    ...visibleItems.map((session, i) => {
      const isSelected = visibleStart + i === selectedIndex;
      const isCurrent = session.id === currentSessionId;
      const indicator = isSelected ? "\u25B6 " : "  ";
      const currentMarker = isCurrent ? " *" : "";
      const titleColor = isSelected ? colors.primary : colors.text;
      const msgCount = session.message_count || 0;

      return e(Box, { key: session.id },
        e(Text, { color: isSelected ? colors.primary : colors.textMuted }, indicator),
        e(Text, { color: titleColor, bold: isSelected },
          `${session.title || "Untitled"}${currentMarker}`
        ),
        e(Text, { color: colors.textMuted }, `  ${msgCount} msgs`),
        e(Text, { color: colors.textDim }, `  ${formatRelative(session.updated)}`)
      );
    }),
    // Footer
    sessions.length > maxVisible
      ? e(Box, { marginTop: 1 },
          e(Text, { color: colors.textMuted }, `  ${sessions.length} sessions (showing ${maxVisible})`)
        )
      : null
  );
}
