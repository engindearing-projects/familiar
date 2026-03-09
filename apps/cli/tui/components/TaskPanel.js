import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { colors, NO_COLOR } from "../lib/theme.js";

const e = React.createElement;

/**
 * Load memory-db lazily — same pattern as useMemory.js.
 */
let memoryModule = null;
async function loadMemory() {
  if (memoryModule) return memoryModule;
  try {
    memoryModule = await import("../../lib/memory-db.js");
    return memoryModule;
  } catch {
    return null;
  }
}

/**
 * TaskPanel — collapsible contextual panel showing:
 * 1. Active tool calls (when busy)
 * 2. User-managed todos
 * 3. Recent observations
 *
 * Props:
 *   busy       — whether the agent is currently working
 *   toolStage  — current tool stage label (e.g. "reading file")
 *   toolEvents — array of recent tool events from gateway
 */
export function TaskPanel({ busy, toolStage, toolEvents }) {
  const [todos, setTodos] = useState([]);
  const [recent, setRecent] = useState([]);

  // Fetch todos + recent observations on mount and periodically
  useEffect(() => {
    let cancelled = false;

    async function fetch() {
      const mem = await loadMemory();
      if (!mem || cancelled) return;
      try {
        setTodos(mem.getByType("todo", 10));
        setRecent(mem.getRecentAll(5));
      } catch {
        // silently ignore — panel is non-critical
      }
    }

    fetch();
    const id = setInterval(fetch, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const hasTools = busy && toolEvents && toolEvents.length > 0;
  const hasTodos = todos.length > 0;
  const hasRecent = recent.length > 0;
  const hasContent = hasTools || hasTodos || hasRecent;

  const borderColor = NO_COLOR ? undefined : colors.grayDim;
  const headerColor = NO_COLOR ? undefined : colors.cyan;
  const activeColor = NO_COLOR ? undefined : colors.green;
  const todoColor = NO_COLOR ? undefined : colors.white;
  const dimColor = NO_COLOR ? undefined : colors.gray;
  const dimmerColor = NO_COLOR ? undefined : colors.grayDim;

  const sections = [];

  // Active tool calls
  if (hasTools) {
    const label = toolStage || "working";
    sections.push(
      e(Text, { key: "tool", color: activeColor }, `  \u25CF ${label}`)
    );
    sections.push(e(Text, { key: "tool-gap" }, ""));
  }

  // Todos
  if (hasTodos) {
    for (const t of todos) {
      sections.push(
        e(Box, { key: `todo-${t.id}` },
          e(Text, { color: todoColor }, `  \u2610 ${t.summary}`),
          e(Text, { color: dimmerColor }, `  ${t.id}`)
        )
      );
    }
    sections.push(e(Text, { key: "todo-gap" }, ""));
  }

  // Recent observations
  if (hasRecent) {
    sections.push(
      e(Text, { key: "recent-hdr", color: dimColor }, "  recent:")
    );
    for (const r of recent) {
      const typeLabel = r.type || "note";
      sections.push(
        e(Text, { key: `rec-${r.id}`, color: dimColor },
          `    ${typeLabel} \u00B7 ${r.summary}`
        )
      );
    }
  }

  // Empty state
  if (!hasContent) {
    sections.push(
      e(Text, { key: "empty", color: dimColor }, "  no active tasks")
    );
  }

  return e(Box, {
      flexDirection: "column",
      borderStyle: "round",
      borderColor,
      paddingLeft: 1,
      paddingRight: 1,
      marginBottom: 1,
    },
    e(Text, { color: headerColor, bold: true }, "tasks"),
    ...sections,
    e(Text, { color: dimmerColor }, `${"".padEnd(30)}shift+tab close`)
  );
}
