// useMemory — loads recent observations from the memory DB on mount.
// Provides warm-start context for the chat session.
// Designed for Bun runtime (bun:sqlite via memory-db.js).

import { useState, useEffect } from "react";

let memoryModule = null;

async function loadMemoryModule() {
  if (memoryModule) return memoryModule;
  try {
    memoryModule = await import("../../lib/memory-db.js");
    return memoryModule;
  } catch {
    return null;
  }
}

/**
 * Loads recent observations from memory-db for context display.
 *
 * @param {object} opts
 * @param {number} opts.limit - Max observations to load (default 5)
 * @param {string} [opts.project] - Optional project filter
 *
 * @returns {{ observations, stats, loading, error }}
 */
export function useMemory({ limit = 5, project } = {}) {
  const [observations, setObservations] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const mem = await loadMemoryModule();
        if (!mem || cancelled) return;

        // Pull recent context
        const rows = project
          ? mem.getRecentContext(project, limit)
          : mem.getByType("task_update", limit);

        // Also grab all recent (not just one type) if no project filter
        const recent = project
          ? rows
          : (() => {
              const db = mem.getDb();
              return db
                .prepare(
                  `SELECT id, type, timestamp, project, summary, tags, source
                   FROM observations
                   ORDER BY timestamp DESC
                   LIMIT ?`
                )
                .all(limit)
                .map((r) => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : [] }));
            })();

        if (cancelled) return;
        setObservations(recent);

        // Grab stats
        try {
          const s = mem.getStats();
          if (!cancelled) setStats(s);
        } catch {
          // stats are optional
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [limit, project]);

  return { observations, stats, loading, error };
}

/**
 * Search observations using FTS.
 * Returns a function you can call imperatively.
 */
export async function searchMemory(query, opts = {}) {
  const mem = await loadMemoryModule();
  if (!mem) return [];
  return mem.search(query, opts);
}

/**
 * Add an observation imperatively (for use in slash commands / cron).
 */
export async function addObservation(obs) {
  const mem = await loadMemoryModule();
  if (!mem) throw new Error("Memory DB not available");
  return mem.addObservation(obs);
}
