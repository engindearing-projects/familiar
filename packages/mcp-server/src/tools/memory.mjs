// Standalone memory tools — work without the gateway.
// Uses bun:sqlite directly via ../db.mjs.

import { addObservation, search, getRecentAll, getStats, readProfile, readPreferences, dbPath } from "../db.mjs";

export const memoryTools = [
  {
    name: "familiar_observe",
    description: "Store a structured observation in Familiar's memory. Use this to record decisions, blockers, task updates, insights, and preferences discovered during work.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["task_update", "code_change", "decision", "blocker", "preference", "insight", "chat_exchange"],
          description: "Observation type",
        },
        summary: { type: "string", description: "Concise summary of the observation" },
        project: { type: "string", description: "Project name (e.g., 'myapp', 'familiar')" },
        details: { type: "string", description: "Additional details or context" },
        tags: { type: "array", items: { type: "string" }, description: "Tags for categorization (e.g., ticket IDs like 'PROJ-42')" },
      },
      required: ["type", "summary"],
    },
    handler({ type, summary, project, details, tags }) {
      try {
        const id = addObservation({ type, summary, project: project || null, details: details || null, tags: tags || [], source: "mcp" });
        return { content: [{ type: "text", text: `Observation stored: ${id}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  },

  {
    name: "familiar_memory_search",
    description: "Search Familiar's memory for past observations, decisions, blockers, and insights. Uses full-text search with optional filters.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (FTS5 syntax supported)" },
        type: {
          type: "string",
          enum: ["task_update", "code_change", "decision", "blocker", "preference", "insight", "chat_exchange"],
          description: "Filter by observation type",
        },
        project: { type: "string", description: "Filter by project name" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: ["query"],
    },
    handler({ query, type, project, limit }) {
      try {
        // Quote the query for FTS5 safety (hyphens are operators)
        const safeQuery = `"${query.replace(/"/g, '""')}"`;
        const opts = {};
        if (type) opts.type = type;
        if (project) opts.project = project;
        if (limit) opts.limit = limit;

        const results = search(safeQuery, opts);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  },

  {
    name: "familiar_memory_recent",
    description: "Get the most recent observations from Familiar's memory, across all projects.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of observations to return (default 10)" },
      },
    },
    handler({ limit }) {
      try {
        const results = getRecentAll(limit || 10);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  },

  {
    name: "familiar_memory_stats",
    description: "Get statistics about Familiar's memory: observation counts by type and project, database size.",
    inputSchema: { type: "object", properties: {} },
    handler() {
      try {
        const stats = getStats();
        return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  },

  {
    name: "familiar_memory_profile",
    description: "Read the user's profile and preferences. Use this to understand who you're talking to and how they prefer to work.",
    inputSchema: { type: "object", properties: {} },
    handler() {
      try {
        const profile = readProfile();
        const preferences = readPreferences();
        return { content: [{ type: "text", text: JSON.stringify({ profile, preferences }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  },
];
