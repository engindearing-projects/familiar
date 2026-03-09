import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { colors } from "../lib/theme.js";
import { getBindings, ACTION_DESCRIPTIONS } from "../lib/keybindings.js";

const e = React.createElement;

/**
 * Build the full command list from slash commands + keybinding actions + custom commands.
 */
function buildCommandList({ availableThemes, themeName }) {
  const commands = [];

  // Slash commands
  const slashCommands = [
    { name: "/help", description: "Show help text", category: "Navigation" },
    { name: "/clear", description: "Clear message history", category: "Navigation" },
    { name: "/session", description: "Show current session key", category: "Session" },
    { name: "/status", description: "Show service health", category: "Navigation" },
    { name: "/memory", description: "Search memory database", category: "Tools" },
    { name: "/observe", description: "Save observation to memory", category: "Tools" },
    { name: "/todo", description: "Manage todo items", category: "Tools" },
    { name: "/forge", description: "Training pipeline controls", category: "Forge" },
    { name: "/coach", description: "Toggle coaching mode", category: "Navigation" },
    { name: "/explain", description: "Get a friendly explanation", category: "Navigation" },
    { name: "/suggest", description: "Get next-step suggestions", category: "Navigation" },
    { name: "/theme", description: "Switch color theme", category: "Theme" },
    { name: "/keybinds", description: "Show keybinding reference", category: "Navigation" },
    { name: "/diff", description: "Show git diff of working directory", category: "Tools" },
    { name: "/mobile", description: "Show mobile access setup", category: "Navigation" },
    { name: "/quit", description: "Exit Familiar", category: "Navigation" },
  ];

  for (const cmd of slashCommands) {
    commands.push({ ...cmd, action: cmd.name });
  }

  // Theme presets as individual commands
  if (availableThemes) {
    for (const t of availableThemes) {
      commands.push({
        name: `Theme: ${t}`,
        description: t === themeName ? "(active)" : "Switch to this theme",
        category: "Theme",
        action: `/theme ${t}`,
      });
    }
  }

  // Keybinding actions
  const bindings = getBindings();
  for (const [key, action] of Object.entries(bindings)) {
    const desc = ACTION_DESCRIPTIONS[action] || action;
    commands.push({
      name: `${desc} [${key}]`,
      description: `Keybind: ${key}`,
      category: "Keybind",
      action: `__keybind__${action}`,
    });
  }

  return commands;
}

/**
 * Simple fuzzy substring match. Returns true if all query chars appear in order.
 */
function fuzzyMatch(query, text) {
  if (!query) return true;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();

  // First try simple includes
  if (lower.includes(q)) return true;

  // Then try subsequence match
  let qi = 0;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

/**
 * Score fuzzy match (higher = better). Returns -1 for no match.
 */
function fuzzyScore(query, text) {
  if (!query) return 0;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();

  // Exact prefix match is highest score
  if (lower.startsWith(q)) return 100;
  // Contains match
  if (lower.includes(q)) return 50;

  // Subsequence match — score by how close together the chars are
  let qi = 0;
  let score = 0;
  let lastMatch = -1;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) {
      // Bonus for consecutive matches
      if (lastMatch === i - 1) score += 5;
      score += 1;
      lastMatch = i;
      qi++;
    }
  }
  return qi === q.length ? score : -1;
}

/**
 * CommandPalette overlay component.
 *
 * Props:
 *   onClose: () => void — close the palette
 *   onExecute: (action: string) => void — execute a command action
 *   availableThemes: string[] — theme names for theme commands
 *   themeName: string — current theme name
 */
export function CommandPalette({ onClose, onExecute, availableThemes, themeName }) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const allCommands = useMemo(
    () => buildCommandList({ availableThemes, themeName }),
    [availableThemes, themeName]
  );

  const filtered = useMemo(() => {
    if (!query) return allCommands;
    return allCommands
      .map((cmd) => ({
        ...cmd,
        score: Math.max(fuzzyScore(query, cmd.name), fuzzyScore(query, cmd.description), fuzzyScore(query, cmd.category)),
      }))
      .filter((cmd) => cmd.score >= 0)
      .sort((a, b) => b.score - a.score);
  }, [allCommands, query]);

  // Max items to display
  const maxVisible = Math.min(filtered.length, 12);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (key.return) {
      const cmd = filtered[selectedIndex];
      if (cmd) {
        onClose();
        onExecute(cmd.action);
      }
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(filtered.length - 1, i + 1));
      return;
    }

    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setSelectedIndex(0);
      return;
    }

    // Regular character input
    if (input && !key.ctrl && !key.meta && !key.shift) {
      setQuery((q) => q + input);
      setSelectedIndex(0);
    }
  });

  // Build visible items
  const visibleStart = Math.max(0, selectedIndex - maxVisible + 1);
  const visibleItems = filtered.slice(visibleStart, visibleStart + maxVisible);

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
      e(Text, { color: colors.primary, bold: true }, "Command Palette"),
      e(Text, { color: colors.textMuted }, "  (esc to close)")
    ),
    // Search input
    e(Box, { marginBottom: 1 },
      e(Text, { color: colors.primary }, "> "),
      e(Text, null, query),
      e(Text, { color: colors.textMuted }, "\u2588") // Cursor block
    ),
    // Results
    ...visibleItems.map((cmd, i) => {
      const isSelected = visibleStart + i === selectedIndex;
      const nameColor = isSelected ? colors.primary : colors.text;
      const descColor = isSelected ? colors.primaryDim : colors.textMuted;
      const indicator = isSelected ? "\u25B6 " : "  ";
      const catLabel = cmd.category ? `[${cmd.category}]` : "";

      return e(Box, { key: cmd.name + cmd.action },
        e(Text, { color: isSelected ? colors.primary : colors.textMuted }, indicator),
        e(Text, { color: nameColor, bold: isSelected }, cmd.name),
        e(Text, { color: descColor }, `  ${cmd.description}`),
        e(Text, { color: colors.textDim }, `  ${catLabel}`)
      );
    }),
    // Footer count
    filtered.length > maxVisible
      ? e(Box, { marginTop: 1 },
          e(Text, { color: colors.textMuted }, `  ${filtered.length} commands (showing ${maxVisible})`)
        )
      : null
  );
}
