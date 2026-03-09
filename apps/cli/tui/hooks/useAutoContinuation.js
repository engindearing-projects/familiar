import { useState, useEffect, useCallback, useRef } from "react";
import { evaluateTriggers } from "../../../../shared/trigger-cascade.js";

const DELAY_MS = 3000;
const MAX_DEPTH = 3;

// Auto-continuation is disabled by default — it sends blocker/todo prompts to the
// model which derails casual conversation. Enable with FAMILIAR_AUTO_CONTINUE=1.
const ENABLED = !!process.env.FAMILIAR_AUTO_CONTINUE;

/**
 * Auto-continuation hook — after a response completes and the queue is empty,
 * wait 3s then build a smart continuation prompt from local context.
 *
 * Trigger cascade (first match wins):
 *   1. Open todos
 *   2. Blockers
 *   3. HANDOFF.md
 *   4. Stale Jira tickets (via task_update observations)
 *   5. Repo health (PR observations)
 *   6. Proactive suggestions (recent context)
 *
 * Cancels if user types anything during the delay.
 * Suppresses entirely if user types while auto-continue response is in-flight.
 * Max depth of 3 per user message chain.
 */
export function useAutoContinuation({ busy, queueLength, sendMessage }) {
  const [continuing, setContinuing] = useState(false);
  const timerRef = useRef(null);
  const depthRef = useRef(0);
  const prevBusyRef = useRef(busy);
  const hasInteractedRef = useRef(false);
  const autoContinuingRef = useRef(false);
  // Suppressed = user typed something, stop auto-continuing until they explicitly submit again
  const suppressedRef = useRef(false);

  // Cancel pending timer + suppress further auto-continuations in this chain
  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setContinuing(false);
    suppressedRef.current = true;
    depthRef.current = 0;
  }, []);

  // Called when user explicitly submits a new message — re-enables auto-continuation
  const resetSuppression = useCallback(() => {
    suppressedRef.current = false;
    depthRef.current = 0;
  }, []);

  // Track busy transitions
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = busy;

    // Track that at least one exchange has happened
    if (wasBusy && !busy) {
      hasInteractedRef.current = true;
    }

    // Clear the auto-continuing flag once the send has started
    if (busy && autoContinuingRef.current) {
      autoContinuingRef.current = false;
    }

    // Not the right transition for starting continuation
    if (busy || !wasBusy) return;

    // Guards
    if (!ENABLED) return;
    if (!hasInteractedRef.current) return;
    if (suppressedRef.current) return;
    if (queueLength > 0) return;
    if (depthRef.current >= MAX_DEPTH) return;

    // Start countdown
    setContinuing(true);

    timerRef.current = setTimeout(() => {
      timerRef.current = null;

      const result = evaluateTriggers();
      if (!result) {
        setContinuing(false);
        return;
      }

      depthRef.current++;
      autoContinuingRef.current = true;
      setContinuing(false);
      sendMessage(`[auto-continue] ${result.prompt}`);
    }, DELAY_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [busy, queueLength, sendMessage]);

  return { continuing, cancel, resetSuppression };
}
