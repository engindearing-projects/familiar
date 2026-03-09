import { useState, useEffect, useRef } from "react";

const SERVICES = [
  { name: "gateway", url: null },                        // gateway health is the WS connection state
  { name: "claude", url: "http://localhost:18791/health" },
  { name: "ollama", url: "http://localhost:11434/api/tags" },
];

const POLL_INTERVAL = 30000; // 30 seconds

/**
 * Polls service health endpoints every 30s.
 *
 * Returns { services: [{ name, healthy }], loading }
 *
 * Gateway health is derived from the `connected` parameter (WS state),
 * not from an HTTP check.
 */
export function useServiceHealth(connected) {
  const [services, setServices] = useState(
    SERVICES.map((s) => ({ name: s.name, healthy: s.name === "gateway" ? connected : false }))
  );
  const [loading, setLoading] = useState(true);
  const timerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function checkHealth() {
      const results = await Promise.all(
        SERVICES.map(async (svc) => {
          // Gateway uses WS connection state
          if (svc.name === "gateway") {
            return { name: svc.name, healthy: connected };
          }
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const res = await fetch(svc.url, { signal: controller.signal });
            clearTimeout(timeout);
            return { name: svc.name, healthy: res.ok };
          } catch {
            return { name: svc.name, healthy: false };
          }
        })
      );

      if (!cancelled) {
        setServices(results);
        setLoading(false);
      }
    }

    // Initial check (non-blocking — doesn't delay TUI startup)
    checkHealth();

    // Poll every 30s
    timerRef.current = setInterval(checkHealth, POLL_INTERVAL);

    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [connected]);

  return { services, loading };
}
