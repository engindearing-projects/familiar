#!/usr/bin/env bun

// Project Resolver — maps natural language to project directories.
// Reads config/projects.json (cached 60s) and scores messages against
// known project names, aliases, and Jira prefixes.
//
// Usage:
//   import { resolveProject, listProjects } from "./project-resolver.mjs";
//   const match = resolveProject("fix the login bug in my-app");
//   // → { name: "my-app", dir: "/Users/.../my-app", confidence: 0.9 }

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

const PROJECT_DIR = resolve(dirname(new URL(import.meta.url).pathname), "..");
const REGISTRY_PATH = resolve(PROJECT_DIR, "config", "projects.json");
const HOME = process.env.HOME || "/tmp";
const CACHE_TTL_MS = 60_000;

let _cache = { data: null, at: 0 };

function expandHome(p) {
  if (p.startsWith("~/")) return resolve(HOME, p.slice(2));
  if (p === "~") return HOME;
  return p;
}

/**
 * Load the project registry from config/projects.json.
 * Cached for 60 seconds.
 */
export function loadRegistry() {
  if (_cache.data && Date.now() - _cache.at < CACHE_TTL_MS) {
    return _cache.data;
  }

  if (!existsSync(REGISTRY_PATH)) {
    console.warn("[project-resolver] config/projects.json not found");
    return { projects: [], defaultDir: HOME };
  }

  try {
    const raw = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
    const data = {
      projects: (raw.projects || []).map((p) => ({
        ...p,
        dir: expandHome(p.dir),
        aliases: (p.aliases || []).map((a) => a.toLowerCase()),
      })),
      defaultDir: expandHome(raw.defaultDir || "~/familiar"),
    };
    _cache = { data, at: Date.now() };
    return data;
  } catch (err) {
    console.error("[project-resolver] Failed to load registry:", err.message);
    return { projects: [], defaultDir: HOME };
  }
}

/**
 * Resolve a project directory from a natural language message.
 * Returns { name, dir, confidence } or null if no match.
 *
 * Scoring order:
 * 1. Jira prefix match (e.g. "PORT-12") → confidence 1.0
 * 2. Alias substring match → confidence 0.6–0.9 (longer alias = higher)
 * 3. Project name match → confidence 0.7
 */
export function resolveProject(message) {
  const registry = loadRegistry();
  if (!registry.projects.length) return null;

  const lower = message.toLowerCase();
  let best = null;

  for (const project of registry.projects) {
    let score = 0;
    let matchType = "";

    // 1. Jira prefix match (highest priority)
    if (project.jiraPrefix) {
      const jiraRe = new RegExp(`\\b${project.jiraPrefix}-\\d+`, "i");
      if (jiraRe.test(message)) {
        score = 1.0;
        matchType = "jira";
      }
    }

    // 2. Alias match
    if (score < 1.0) {
      for (const alias of project.aliases) {
        if (lower.includes(alias)) {
          // Longer aliases are more specific → higher confidence
          const aliasScore = 0.6 + Math.min(0.3, alias.length / 30);
          if (aliasScore > score) {
            score = aliasScore;
            matchType = "alias";
          }
        }
      }
    }

    // 3. Project name match
    if (score === 0 && lower.includes(project.name.toLowerCase())) {
      score = 0.7;
      matchType = "name";
    }

    if (score > 0 && (!best || score > best.confidence)) {
      best = {
        name: project.name,
        dir: project.dir,
        confidence: score,
        matchType,
      };
    }
  }

  // Only return if confidence is meaningful
  if (best && best.confidence >= 0.4) {
    return best;
  }

  return null;
}

/**
 * Get the default project directory (fallback when no match).
 */
export function getDefaultDir() {
  return loadRegistry().defaultDir;
}

/**
 * List all known project names for user-facing prompts.
 */
export function listProjects() {
  return loadRegistry().projects.map((p) => ({
    name: p.name,
    dir: p.dir,
  }));
}
