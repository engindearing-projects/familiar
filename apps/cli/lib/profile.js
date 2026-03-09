// User profile management for Familiar.
// Stores user info, preferences, and work patterns as JSON files in ~/.familiar/profile/.
// All reads handle missing files gracefully; all writes ensure the directory exists.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { userInfo } from "os";
import { profileDir } from "./paths.js";

// Lazy reference to memory-db — resolved on first use to avoid import errors
// if the DB hasn't been set up yet (e.g., first run before `familiar init`).
let _memoryDb = null;
function getMemoryDb() {
  if (_memoryDb) return _memoryDb;
  try {
    _memoryDb = require("./memory-db.js");
    return _memoryDb;
  } catch {
    return null;
  }
}

// File paths for each profile section
const FILES = {
  user: () => join(profileDir(), "user.json"),
  preferences: () => join(profileDir(), "preferences.json"),
  patterns: () => join(profileDir(), "patterns.json"),
};

/**
 * Safely read and parse a JSON file. Returns fallback on any error.
 */
function readJson(filePath, fallback = {}) {
  try {
    if (!existsSync(filePath)) return fallback;
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Write an object as formatted JSON. Ensures the parent directory exists.
 */
function writeJson(filePath, data) {
  const dir = profileDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/**
 * Read the user profile (user.json).
 * Returns {} if the file doesn't exist.
 *
 * @returns {{ name?, role?, org?, email?, workHours?, channels?, timezone? }}
 */
export function readProfile() {
  return readJson(FILES.user());
}

/**
 * Write (merge) data into a profile section.
 * Existing keys not in `data` are preserved.
 *
 * @param {"user" | "preferences" | "patterns"} section
 * @param {object} data - Fields to merge into the existing file.
 */
export function writeProfile(section, data) {
  const fileFn = FILES[section];
  if (!fileFn) {
    throw new Error(`Unknown profile section: ${section}. Use "user", "preferences", or "patterns".`);
  }

  const filePath = fileFn();
  const existing = readJson(filePath);
  const merged = { ...existing, ...data };
  writeJson(filePath, merged);
}

/**
 * Get the user's display name.
 * Priority: profile name > OS username > "there"
 *
 * @returns {string}
 */
export function getUserName() {
  const profile = readProfile();
  if (profile.name) return profile.name;

  try {
    const info = userInfo();
    if (info.username) return info.username;
  } catch {
    // userInfo() can throw on some systems
  }

  return "there";
}

/**
 * Record a work pattern event (session start/end, query, etc.).
 * Builds up a patterns.json file over time for context awareness.
 *
 * @param {{ type: "session_start" | "session_end" | "query", timestamp?, metadata? }} event
 */
export function updatePattern(event) {
  const filePath = FILES.patterns();
  const patterns = readJson(filePath, {
    activeHours: {},
    frequentQueries: [],
    sessionLengths: [],
  });

  const ts = event.timestamp || new Date().toISOString();
  const hour = new Date(ts).getHours().toString();

  // Track active hours — increment count for the current hour
  if (!patterns.activeHours) patterns.activeHours = {};
  patterns.activeHours[hour] = (patterns.activeHours[hour] || 0) + 1;

  if (event.type === "session_start") {
    // Store the start time so we can compute duration on session_end
    patterns._lastSessionStart = ts;
  }

  if (event.type === "session_end" && patterns._lastSessionStart) {
    const startMs = new Date(patterns._lastSessionStart).getTime();
    const endMs = new Date(ts).getTime();
    const durationMin = Math.round((endMs - startMs) / 60000);

    if (!patterns.sessionLengths) patterns.sessionLengths = [];
    patterns.sessionLengths.push(durationMin);

    // Keep last 100 session lengths
    if (patterns.sessionLengths.length > 100) {
      patterns.sessionLengths = patterns.sessionLengths.slice(-100);
    }

    delete patterns._lastSessionStart;
  }

  if (event.type === "query" && event.metadata?.query) {
    if (!patterns.frequentQueries) patterns.frequentQueries = [];
    patterns.frequentQueries.push({
      query: event.metadata.query,
      timestamp: ts,
    });

    // Keep last 200 queries
    if (patterns.frequentQueries.length > 200) {
      patterns.frequentQueries = patterns.frequentQueries.slice(-200);
    }
  }

  writeJson(filePath, patterns);
}

/**
 * Get today's context — greeting, recent observations, and work patterns.
 * Queries memory-db for recent observations if the DB is available.
 *
 * @returns {{ greeting: string, recentObs: Array, upcomingDeadlines: Array }}
 */
export function getContext() {
  const name = getUserName();
  const hour = new Date().getHours();

  let timeOfDay;
  if (hour < 12) timeOfDay = "morning";
  else if (hour < 17) timeOfDay = "afternoon";
  else timeOfDay = "evening";

  const greeting = `Good ${timeOfDay}, ${name}`;

  let recentObs = [];
  let upcomingDeadlines = [];
  let todayCount = 0;

  const memDb = getMemoryDb();
  if (memDb) {
    try {
      recentObs = memDb.getRecentAll(5);
    } catch {
      // Memory DB not available yet — fine on first run
    }

    try {
      todayCount = memDb.getTodayCount();
    } catch {
      // DB not ready
    }

    try {
      upcomingDeadlines = memDb.search("deadline", { type: "task_update", limit: 5 });
    } catch {
      // No search results or DB not ready
    }
  }

  return {
    greeting,
    recentObs,
    upcomingDeadlines,
    todayCount,
  };
}

/**
 * Get the familiar's display name.
 * Priority: preferences.familiarName > "Familiar"
 *
 * @returns {string}
 */
export function getFamiliarName() {
  return getPreference("familiarName", "Familiar");
}

/**
 * Read a specific preference with a fallback value.
 *
 * @param {string} key - Preference key to look up.
 * @param {*} fallback - Default value if the preference doesn't exist.
 * @returns {*} The preference value or fallback.
 */
export function getPreference(key, fallback) {
  const prefs = readJson(FILES.preferences());
  if (prefs[key] !== undefined) {
    // Preferences are stored as { value, updatedAt, source } objects
    // but can also be plain values for simplicity
    const entry = prefs[key];
    if (entry && typeof entry === "object" && "value" in entry) {
      return entry.value;
    }
    return entry;
  }
  return fallback;
}

/**
 * Set a preference with timestamp and source tracking.
 *
 * @param {string} key - Preference key.
 * @param {*} value - Preference value.
 * @param {"manual" | "chat" | "inferred"} source - How this preference was learned.
 */
export function setPreference(key, value, source = "manual") {
  const filePath = FILES.preferences();
  const prefs = readJson(filePath);

  prefs[key] = {
    value,
    updatedAt: new Date().toISOString(),
    source,
  };

  writeJson(filePath, prefs);
}
