// Keybinding system — leader key sequences + direct bindings
// User overrides from ~/.familiar/keybindings.json (partial merge with defaults)

import { existsSync, readFileSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME || "/tmp";
const FAMILIAR_HOME = process.env.FAMILIAR_HOME || process.env.COZYTERM_HOME || process.env.ENGIE_HOME || join(HOME, ".familiar");
const KEYBINDINGS_PATH = join(FAMILIAR_HOME, "keybindings.json");

// Default keybinding map
// Leader key sequences use "leader+" prefix (leader = ctrl+x)
// Direct keys use the key name directly
export const DEFAULT_BINDINGS = {
  // Leader sequences (ctrl+x then key)
  "leader+n": "new_session",
  "leader+l": "list_sessions",
  "leader+t": "theme_switch",
  "leader+m": "model_switch",
  "leader+k": "command_palette",
  "leader+q": "quit",
  "leader+e": "export_session",
  "leader+f": "fork_session",
  "leader+d": "toggle_diff_view",

  // Direct keys
  "shift+tab": "toggle_tasks",
  "pageup": "scroll_up",
  "pagedown": "scroll_down",
  "ctrl+l": "clear",
  "ctrl+c": "cancel_quit",
  "escape": "close_overlay",
};

// Human-readable descriptions for each action
export const ACTION_DESCRIPTIONS = {
  new_session: "Create a new session",
  list_sessions: "List all sessions",
  theme_switch: "Switch color theme",
  model_switch: "Switch AI model",
  command_palette: "Open command palette",
  quit: "Quit Familiar",
  export_session: "Export session to file",
  fork_session: "Fork current session",
  toggle_diff_view: "Toggle diff display mode",
  toggle_tasks: "Toggle task panel",
  scroll_up: "Scroll messages up",
  scroll_down: "Scroll messages down",
  clear: "Clear message history",
  cancel_quit: "Cancel or quit",
  close_overlay: "Close overlay/popup",
};

/**
 * Load user overrides from ~/.familiar/keybindings.json
 * Format: { "leader+t": "theme_switch", "ctrl+k": "command_palette" }
 */
function loadUserBindings() {
  try {
    if (existsSync(KEYBINDINGS_PATH)) {
      const raw = readFileSync(KEYBINDINGS_PATH, "utf-8");
      return JSON.parse(raw);
    }
  } catch {
    // Ignore parse errors
  }
  return {};
}

/**
 * Get merged keybindings (defaults + user overrides).
 * User overrides take precedence.
 */
export function getBindings() {
  const userBindings = loadUserBindings();
  return { ...DEFAULT_BINDINGS, ...userBindings };
}

/**
 * Get action for a given key combo string.
 */
export function getAction(keyCombo) {
  const bindings = getBindings();
  return bindings[keyCombo] || null;
}

/**
 * Get all bindings grouped by type (leader vs direct).
 */
export function getBindingsGrouped() {
  const bindings = getBindings();
  const leader = {};
  const direct = {};
  for (const [key, action] of Object.entries(bindings)) {
    if (key.startsWith("leader+")) {
      leader[key] = action;
    } else {
      direct[key] = action;
    }
  }
  return { leader, direct };
}

/**
 * Format keybindings as a displayable string.
 */
export function formatBindings() {
  const bindings = getBindings();
  const lines = ["Keybindings (leader = ctrl+x):", ""];

  const leaderBindings = [];
  const directBindings = [];

  for (const [key, action] of Object.entries(bindings)) {
    const desc = ACTION_DESCRIPTIONS[action] || action;
    const formatted = `  ${key.padEnd(16)} ${desc}`;
    if (key.startsWith("leader+")) {
      leaderBindings.push(formatted);
    } else {
      directBindings.push(formatted);
    }
  }

  if (leaderBindings.length) {
    lines.push("Leader sequences (ctrl+x, then):");
    lines.push(...leaderBindings);
    lines.push("");
  }

  if (directBindings.length) {
    lines.push("Direct keys:");
    lines.push(...directBindings);
  }

  return lines.join("\n");
}

// Leader key timeout in ms
export const LEADER_TIMEOUT = 500;
