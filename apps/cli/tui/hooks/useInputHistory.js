import { useState, useCallback, useRef } from "react";

/**
 * Input history with up/down arrow recall.
 *
 * Returns { value, setValue, onSubmit, handleKey }
 *
 * - value: current input string
 * - setValue: manual setter (for TextInput onChange)
 * - onSubmit(text): call when input is submitted, pushes to history
 * - handleKey: pass to useInput for arrow key handling
 */
export function useInputHistory(submitCallback, maxHistory = 50) {
  const [value, setValue] = useState("");
  const historyRef = useRef([]);
  const indexRef = useRef(-1);
  const draftRef = useRef("");

  const onSubmit = useCallback(
    (text) => {
      if (!text.trim()) return;

      // Push to history (avoid consecutive duplicates)
      const history = historyRef.current;
      if (history[history.length - 1] !== text) {
        history.push(text);
        if (history.length > maxHistory) history.shift();
      }

      indexRef.current = -1;
      draftRef.current = "";
      setValue("");

      submitCallback(text.trim());
    },
    [submitCallback, maxHistory]
  );

  const handleKey = useCallback(
    (_input, key) => {
      const history = historyRef.current;
      if (!history.length) return;

      if (key.upArrow) {
        if (indexRef.current === -1) {
          // Save current input as draft
          draftRef.current = value;
          indexRef.current = history.length - 1;
        } else if (indexRef.current > 0) {
          indexRef.current--;
        }
        setValue(history[indexRef.current] || "");
      }

      if (key.downArrow) {
        if (indexRef.current === -1) return;
        if (indexRef.current < history.length - 1) {
          indexRef.current++;
          setValue(history[indexRef.current]);
        } else {
          // Back to draft
          indexRef.current = -1;
          setValue(draftRef.current);
        }
      }
    },
    [value]
  );

  return { value, setValue, onSubmit, handleKey };
}
