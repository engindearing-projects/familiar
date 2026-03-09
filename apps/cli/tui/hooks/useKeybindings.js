import { useState, useCallback, useRef, useEffect } from "react";
import { useInput } from "ink";
import { getBindings, LEADER_TIMEOUT } from "../lib/keybindings.js";

/**
 * Keybinding hook — handles leader key sequences and direct bindings.
 *
 * @param {Object} actionMap - Map of action names to handler functions
 *   e.g. { command_palette: () => setShowPalette(true), quit: () => app.exit() }
 * @param {Object} opts
 * @param {boolean} opts.isActive - Whether keybindings are active (false when overlay is open, etc.)
 *
 * Returns { leaderPending } — true when waiting for second key in leader sequence
 */
export function useKeybindings(actionMap, { isActive = true } = {}) {
  const [leaderPending, setLeaderPending] = useState(false);
  const leaderTimerRef = useRef(null);
  const bindingsRef = useRef(getBindings());

  // Clear leader timeout on unmount
  useEffect(() => {
    return () => {
      if (leaderTimerRef.current) clearTimeout(leaderTimerRef.current);
    };
  }, []);

  const handleInput = useCallback(
    (input, key) => {
      const bindings = bindingsRef.current;

      // Build key combo string from ink's key object
      const combo = buildCombo(input, key);
      if (!combo) return;

      // If leader is pending, check leader+key combos
      if (leaderPending) {
        setLeaderPending(false);
        if (leaderTimerRef.current) {
          clearTimeout(leaderTimerRef.current);
          leaderTimerRef.current = null;
        }

        const leaderCombo = `leader+${combo}`;
        const action = bindings[leaderCombo];
        if (action && actionMap[action]) {
          actionMap[action]();
          return;
        }
        // No match after leader — ignore
        return;
      }

      // Check for leader key press (ctrl+x)
      if (key.ctrl && input === "x") {
        setLeaderPending(true);
        leaderTimerRef.current = setTimeout(() => {
          setLeaderPending(false);
          leaderTimerRef.current = null;
        }, LEADER_TIMEOUT);
        return;
      }

      // Check direct bindings
      const action = bindings[combo];
      if (action && actionMap[action]) {
        actionMap[action]();
      }
    },
    [actionMap, leaderPending]
  );

  useInput(handleInput, { isActive });

  return { leaderPending };
}

/**
 * Build a key combo string from ink's useInput args.
 * e.g. "ctrl+l", "shift+tab", "escape", "n", "pageup"
 */
function buildCombo(input, key) {
  // Special keys
  if (key.escape) return "escape";
  if (key.pageUp) return "pageup";
  if (key.pageDown) return "pagedown";
  if (key.tab && key.shift) return "shift+tab";
  if (key.tab) return "tab";

  // ctrl+key
  if (key.ctrl && input) return `ctrl+${input}`;

  // Regular character input
  if (input && !key.ctrl && !key.meta) return input;

  return null;
}
