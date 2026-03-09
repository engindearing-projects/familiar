import { useEffect, useRef } from "react";
import { getByType } from "../../lib/memory-db.js";
import { getRecentItems, countByStatus } from "../../../../shared/work-queue.js";

const POLL_INTERVAL = 60_000; // 60 seconds
const FIRST_POLL_DELAY = 10_000; // 10 seconds after mount
const BLOCKER_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours
const STALE_TODO_MS = 24 * 60 * 60 * 1000; // 24 hours
const DAEMON_CATCHUP_HOURS = 12;

let sysCounter = 0;

/**
 * Background polling hook — periodically checks local memory DB for items
 * that need attention and surfaces them as system messages.
 *
 * Checks (all local SQLite, fast):
 *   - New blockers (created in last 2 hours, not yet seen)
 *   - Stale todos (open > 24h, max 1 reminder per poll)
 *   - Recent decisions/task_updates that might need follow-up
 *   - Daemon catch-up summary (first poll only)
 *
 * Only polls when connected and not busy.
 */
export function useBackgroundPolling({ connected, busy, setMessages }) {
  const seenIdsRef = useRef(new Set());
  const timerRef = useRef(null);
  const firstPollRef = useRef(null);
  const daemonCatchupDoneRef = useRef(false);

  useEffect(() => {
    if (!connected) return;

    function poll() {
      // Skip if busy — don't clutter the UI during active conversation
      if (busy) return;

      const surfaced = [];

      // 0. Daemon catch-up (first poll only)
      if (!daemonCatchupDoneRef.current) {
        daemonCatchupDoneRef.current = true;
        try {
          const recent = getRecentItems(DAEMON_CATCHUP_HOURS, 100);
          if (recent.length > 0) {
            const counts = countByStatus();
            const investigated = recent.filter((i) => ["done", "error"].includes(i.status)).length;
            const executed = recent.filter((i) => i.status === "done" && i.execution_result && i.execution_result !== "No action needed").length;
            const pendingApproval = counts.proposed || 0;

            const parts = [];
            if (investigated > 0) parts.push(`investigated ${investigated} item${investigated !== 1 ? "s" : ""}`);
            if (executed > 0) parts.push(`executed ${executed}`);
            if (pendingApproval > 0) parts.push(`${pendingApproval} pending approval`);

            if (parts.length > 0) {
              surfaced.push(`[daemon] While you were away: ${parts.join(", ")}`);
            }
          }
        } catch { /* daemon DB may not exist yet */ }
      }

      // 1. Recent blockers (created in last 2 hours)
      try {
        const blockers = getByType("blocker", 10);
        const cutoff = new Date(Date.now() - BLOCKER_WINDOW_MS).toISOString();
        for (const b of blockers) {
          if (b.timestamp >= cutoff && !seenIdsRef.current.has(b.id)) {
            seenIdsRef.current.add(b.id);
            surfaced.push(`[blocker] ${b.summary}`);
          }
        }
      } catch { /* db not available */ }

      // 2. Stale todos (open > 24h, max 1 per poll)
      try {
        const todos = getByType("todo", 20);
        const staleCutoff = new Date(Date.now() - STALE_TODO_MS).toISOString();
        for (const t of todos) {
          if (t.timestamp < staleCutoff && !seenIdsRef.current.has(t.id)) {
            seenIdsRef.current.add(t.id);
            const age = timeAgeDays(t.timestamp);
            surfaced.push(`[stale todo] ${t.summary} (${age})`);
            break; // max 1 stale todo per poll
          }
        }
      } catch { /* db not available */ }

      // 3. Recent decisions/task_updates (last 2 hours, not yet seen)
      try {
        const decisions = getByType("decision", 5);
        const cutoff = new Date(Date.now() - BLOCKER_WINDOW_MS).toISOString();
        for (const d of decisions) {
          if (d.timestamp >= cutoff && !seenIdsRef.current.has(d.id)) {
            seenIdsRef.current.add(d.id);
            surfaced.push(`[decision] ${d.summary}`);
          }
        }
      } catch { /* db not available */ }

      // Surface as system messages
      if (surfaced.length > 0) {
        setMessages((prev) => [
          ...prev,
          ...surfaced.map((text) => ({
            id: `bg-${++sysCounter}`,
            role: "system",
            text,
          })),
        ]);
      }
    }

    // First poll after short delay
    firstPollRef.current = setTimeout(poll, FIRST_POLL_DELAY);

    // Subsequent polls at regular interval
    timerRef.current = setInterval(poll, POLL_INTERVAL);

    return () => {
      if (firstPollRef.current) clearTimeout(firstPollRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [connected, busy, setMessages]);
}

function timeAgeDays(isoStr) {
  const days = Math.floor((Date.now() - new Date(isoStr).getTime()) / (24 * 60 * 60 * 1000));
  if (days === 1) return "1 day old";
  return `${days} days old`;
}
