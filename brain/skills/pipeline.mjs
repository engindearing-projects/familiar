#!/usr/bin/env bun

// Skill Installation Pipeline
// Discovers, validates, installs, activates, and uninstalls skills from templates.
//
// Usage:
//   bun brain/skills/pipeline.mjs list                 — list all installed skills
//   bun brain/skills/pipeline.mjs templates             — list available templates
//   bun brain/skills/pipeline.mjs install <name>        — install a skill from template
//   bun brain/skills/pipeline.mjs activate <name>       — mark skill as active (approved)
//   bun brain/skills/pipeline.mjs deactivate <name>     — mark skill as sandboxed (unapproved)
//   bun brain/skills/pipeline.mjs uninstall <name>      — remove skill and deregister
//   bun brain/skills/pipeline.mjs validate <name>       — validate a template without installing
//   bun brain/skills/pipeline.mjs install-all           — install all available templates

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join, basename } from "node:path";

const SKILLS_DIR = resolve(import.meta.dir);
const TEMPLATES_DIR = resolve(SKILLS_DIR, "templates");
const REGISTRY_PATH = resolve(SKILLS_DIR, "registry.json");

// ── Registry Helpers ────────────────────────────────────────────────────────

function loadRegistry() {
  try {
    if (existsSync(REGISTRY_PATH)) {
      return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
    }
  } catch { /* corrupt registry, start fresh */ }
  return { skills: [], lastUpdated: null };
}

function saveRegistry(registry) {
  registry.lastUpdated = new Date().toISOString();
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

// ── Template Discovery ──────────────────────────────────────────────────────

/**
 * Scan the templates directory and return all valid template manifests.
 * Each template is a JSON file with at minimum: name, description, source.code
 */
export function discoverTemplates() {
  if (!existsSync(TEMPLATES_DIR)) return [];

  const files = readdirSync(TEMPLATES_DIR).filter(f => f.endsWith(".json"));
  const templates = [];

  for (const file of files) {
    try {
      const raw = readFileSync(resolve(TEMPLATES_DIR, file), "utf-8");
      const template = JSON.parse(raw);
      template._file = file;
      templates.push(template);
    } catch (err) {
      console.warn(`[pipeline] Skipping ${file}: ${err.message}`);
    }
  }

  return templates;
}

// ── Template Validation ─────────────────────────────────────────────────────

/**
 * Validate a template manifest. Returns { valid, errors }.
 */
export function validateTemplate(template) {
  const errors = [];

  if (!template.name || typeof template.name !== "string") {
    errors.push("Missing or invalid 'name' (must be a non-empty string)");
  } else if (!/^[a-z][a-z0-9_]*$/.test(template.name)) {
    errors.push(`Invalid name '${template.name}' — must be lowercase alphanumeric with underscores, starting with a letter`);
  }

  if (!template.description || typeof template.description !== "string") {
    errors.push("Missing or invalid 'description'");
  }

  if (!template.source?.code || typeof template.source.code !== "string") {
    errors.push("Missing 'source.code' — template must include the skill source code");
  }

  if (template.source?.code) {
    const code = template.source.code;
    if (!code.includes("export const name")) {
      errors.push("Source code missing 'export const name'");
    }
    if (!code.includes("export async function execute")) {
      errors.push("Source code missing 'export async function execute'");
    }

    // Check for potentially unsafe operations
    const unsafePatterns = [
      { pattern: /process\.exit/g, reason: "process.exit calls" },
      { pattern: /child_process.*spawn/g, reason: "spawn (use execSync instead)" },
      { pattern: /eval\s*\(/g, reason: "eval() calls" },
      { pattern: /Function\s*\(/g, reason: "Function() constructor" },
    ];

    for (const { pattern, reason } of unsafePatterns) {
      if (pattern.test(code)) {
        errors.push(`Source code contains unsafe pattern: ${reason}`);
      }
    }
  }

  // Validate dependencies — for now, only allow empty deps (no npm)
  if (template.dependencies && template.dependencies.length > 0) {
    errors.push("External dependencies are not supported — skills must use only Node.js built-ins");
  }

  // Validate sandbox config if present
  if (template.sandbox) {
    const allowed = ["allowNetwork", "allowFileWrite", "allowShell", "maxExecutionMs"];
    for (const key of Object.keys(template.sandbox)) {
      if (!allowed.includes(key)) {
        errors.push(`Unknown sandbox option: '${key}'`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Skill Testing (Sandbox) ─────────────────────────────────────────────────

/**
 * Test-execute a skill in a sandbox. Imports the module and calls execute()
 * with empty/default args, wrapped in a timeout. Returns { ok, error, durationMs }.
 */
export async function testSkill(name) {
  const skillDir = resolve(SKILLS_DIR, name);
  const entryPoint = resolve(skillDir, "index.mjs");

  if (!existsSync(entryPoint)) {
    return { ok: false, error: `Skill module not found: ${entryPoint}`, durationMs: 0 };
  }

  const start = Date.now();
  try {
    // Dynamic import with cache-busting for upgrades
    const mod = await import(`${entryPoint}?t=${Date.now()}`);

    if (typeof mod.execute !== "function") {
      return { ok: false, error: "Module missing execute() function", durationMs: Date.now() - start };
    }

    // Read manifest for timeout config
    let maxMs = 5000;
    try {
      const manifest = JSON.parse(readFileSync(resolve(skillDir, "manifest.json"), "utf-8"));
      if (manifest.sandbox?.maxExecutionMs) maxMs = Math.min(manifest.sandbox.maxExecutionMs, 10000);
    } catch { /* use default */ }

    // Run execute() with empty args, race against timeout
    const result = await Promise.race([
      mod.execute({}),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${maxMs}ms`)), maxMs)),
    ]);

    return { ok: true, error: null, durationMs: Date.now() - start, result: String(result).slice(0, 200) };
  } catch (err) {
    return { ok: false, error: err.message, durationMs: Date.now() - start };
  }
}

// ── Execution Metrics ───────────────────────────────────────────────────────

/**
 * Record a skill execution run in the registry (call count, error count, avg duration).
 */
export function recordSkillRun(name, { ok, durationMs, error }) {
  const registry = loadRegistry();
  const skill = registry.skills.find(s => s.name === name);
  if (!skill) return;

  // Initialize metrics if missing
  if (!skill.metrics) {
    skill.metrics = { callCount: 0, errorCount: 0, totalDurationMs: 0, consecutiveErrors: 0, lastCalled: null };
  }

  skill.metrics.callCount++;
  skill.metrics.totalDurationMs += durationMs || 0;
  skill.metrics.lastCalled = new Date().toISOString();

  if (ok) {
    skill.metrics.consecutiveErrors = 0;
  } else {
    skill.metrics.errorCount++;
    skill.metrics.consecutiveErrors++;
    skill.metrics.lastError = error || "unknown";
  }

  saveRegistry(registry);
  return skill.metrics;
}

/**
 * Get metrics for a skill. Returns null if skill not found.
 */
export function getSkillMetrics(name) {
  const registry = loadRegistry();
  const skill = registry.skills.find(s => s.name === name);
  if (!skill) return null;
  return skill.metrics || { callCount: 0, errorCount: 0, totalDurationMs: 0, consecutiveErrors: 0 };
}

// ── Skill Installation ──────────────────────────────────────────────────────

/**
 * Install a skill from a template. Writes the module to the skills directory
 * and registers it in registry.json. Installed as sandboxed (unapproved) by default.
 * Runs a sandbox test after install — auto-uninstalls on failure.
 *
 * Returns { ok, message, skill? }
 */
export async function installSkill(template) {
  // Validate first
  const validation = validateTemplate(template);
  if (!validation.valid) {
    return { ok: false, message: `Validation failed:\n  - ${validation.errors.join("\n  - ")}` };
  }

  const registry = loadRegistry();
  const existing = registry.skills.find(s => s.name === template.name);
  if (existing) {
    return { ok: false, message: `Skill '${template.name}' is already installed (installed at ${existing.installedAt})` };
  }

  // Create skill directory and write the module
  const skillDir = resolve(SKILLS_DIR, template.name);
  mkdirSync(skillDir, { recursive: true });

  const entryPoint = template.entryPoint || "index.mjs";
  writeFileSync(resolve(skillDir, entryPoint), template.source.code);

  // Write a local manifest for reference
  const manifest = {
    name: template.name,
    version: template.version || "1.0.0",
    description: template.description,
    author: template.author || "unknown",
    parameters: template.parameters || {},
    sandbox: template.sandbox || {},
    tags: template.tags || [],
    installedAt: new Date().toISOString(),
    installedFrom: template._file || "api",
  };
  writeFileSync(resolve(skillDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // Register in registry.json
  registry.skills.push({
    name: template.name,
    description: template.description,
    parameters: template.parameters || {},
    approved: false,
    installedAt: manifest.installedAt,
    version: manifest.version,
    tags: manifest.tags,
  });
  saveRegistry(registry);

  // Sandbox test — verify the skill can load and execute without crashing
  const test = await testSkill(template.name);
  if (!test.ok) {
    // Auto-uninstall broken skill
    uninstallSkill(template.name);
    return {
      ok: false,
      message: `Installed skill '${template.name}' but sandbox test failed: ${test.error} — auto-uninstalled`,
    };
  }

  return {
    ok: true,
    message: `Installed skill '${template.name}' (sandboxed, test passed in ${test.durationMs}ms — run 'activate ${template.name}' to approve)`,
    skill: manifest,
  };
}

// ── Skill Activation ────────────────────────────────────────────────────────

/**
 * Mark a skill as active (approved), making it available to the tool loop.
 */
export function activateSkill(name) {
  const registry = loadRegistry();
  const skill = registry.skills.find(s => s.name === name);

  if (!skill) {
    return { ok: false, message: `Skill '${name}' is not installed` };
  }

  if (skill.approved) {
    return { ok: false, message: `Skill '${name}' is already active` };
  }

  skill.approved = true;
  skill.activatedAt = new Date().toISOString();
  saveRegistry(registry);

  return { ok: true, message: `Activated skill '${name}' — now available in the tool loop` };
}

/**
 * Mark a skill as sandboxed (unapproved).
 */
export function deactivateSkill(name) {
  const registry = loadRegistry();
  const skill = registry.skills.find(s => s.name === name);

  if (!skill) {
    return { ok: false, message: `Skill '${name}' is not installed` };
  }

  if (!skill.approved) {
    return { ok: false, message: `Skill '${name}' is already sandboxed` };
  }

  skill.approved = false;
  delete skill.activatedAt;
  saveRegistry(registry);

  return { ok: true, message: `Deactivated skill '${name}' — now sandboxed` };
}

// ── Skill Uninstallation ────────────────────────────────────────────────────

/**
 * Remove a skill: delete its directory and deregister from registry.json.
 */
export function uninstallSkill(name) {
  const registry = loadRegistry();
  const idx = registry.skills.findIndex(s => s.name === name);

  if (idx === -1) {
    return { ok: false, message: `Skill '${name}' is not installed` };
  }

  // Remove from registry
  registry.skills.splice(idx, 1);
  saveRegistry(registry);

  // Remove the skill directory
  const skillDir = resolve(SKILLS_DIR, name);
  if (existsSync(skillDir)) {
    rmSync(skillDir, { recursive: true, force: true });
  }

  return { ok: true, message: `Uninstalled skill '${name}'` };
}

// ── Skill Upgrade ───────────────────────────────────────────────────────────

/**
 * Upgrade an existing skill with a new template. Backs up old code, writes new,
 * runs testSkill, rolls back on failure. Preserves approval status and metrics.
 *
 * Returns { ok, message }
 */
export async function upgradeSkill(template) {
  const validation = validateTemplate(template);
  if (!validation.valid) {
    return { ok: false, message: `Validation failed:\n  - ${validation.errors.join("\n  - ")}` };
  }

  const registry = loadRegistry();
  const skill = registry.skills.find(s => s.name === template.name);
  if (!skill) {
    return { ok: false, message: `Skill '${template.name}' is not installed — use install instead` };
  }

  const skillDir = resolve(SKILLS_DIR, template.name);
  const entryPoint = template.entryPoint || "index.mjs";
  const modulePath = resolve(skillDir, entryPoint);

  // Back up old code
  let oldCode = null;
  try {
    if (existsSync(modulePath)) {
      oldCode = readFileSync(modulePath, "utf-8");
    }
  } catch { /* no backup available */ }

  // Write new code
  writeFileSync(modulePath, template.source.code);

  // Update manifest
  const manifestPath = resolve(skillDir, "manifest.json");
  try {
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf-8")) : {};
    manifest.version = template.version || manifest.version || "1.0.0";
    manifest.description = template.description;
    manifest.sandbox = template.sandbox || manifest.sandbox || {};
    manifest.upgradedAt = new Date().toISOString();
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  } catch { /* manifest update optional */ }

  // Test the new code
  const testResult = await testSkill(template.name);
  if (!testResult.ok) {
    // Roll back
    if (oldCode) {
      writeFileSync(modulePath, oldCode);
    }
    return { ok: false, message: `Upgrade failed test: ${testResult.error} — rolled back` };
  }

  // Update registry entry (preserve approval + metrics)
  skill.version = template.version || skill.version;
  skill.description = template.description;
  skill.upgradedAt = new Date().toISOString();
  saveRegistry(registry);

  return { ok: true, message: `Upgraded skill '${template.name}' to v${skill.version} (test passed in ${testResult.durationMs}ms)` };
}

// ── List Installed ──────────────────────────────────────────────────────────

/**
 * List all installed skills with their status.
 */
export function listInstalled() {
  const registry = loadRegistry();
  return registry.skills.map(s => ({
    name: s.name,
    description: s.description,
    status: s.approved ? "active" : "sandboxed",
    version: s.version || "1.0.0",
    installedAt: s.installedAt,
    activatedAt: s.activatedAt || null,
    tags: s.tags || [],
  }));
}

// ── Find Template by Name ───────────────────────────────────────────────────

/**
 * Find a template by skill name from the templates directory.
 */
export function findTemplate(name) {
  const templates = discoverTemplates();
  return templates.find(t => t.name === name) || null;
}

// ── Install from Template by Name ───────────────────────────────────────────

/**
 * Convenience: find a template by name and install it.
 */
export async function installFromTemplate(name) {
  const template = findTemplate(name);
  if (!template) {
    const available = discoverTemplates().map(t => t.name);
    return {
      ok: false,
      message: `Template '${name}' not found. Available: ${available.join(", ") || "(none)"}`,
    };
  }
  return installSkill(template);
}

// ── Install All Templates ───────────────────────────────────────────────────

/**
 * Install all available templates that are not already installed.
 */
export async function installAllTemplates() {
  const templates = discoverTemplates();
  const results = [];

  for (const template of templates) {
    const result = await installSkill(template);
    results.push({ name: template.name, ...result });
  }

  return results;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
Skill Installation Pipeline

Usage:
  bun brain/skills/pipeline.mjs <command> [args]

Commands:
  list                  List all installed skills
  templates             List available templates
  install <name>        Install a skill from a template
  install-all           Install all available templates
  activate <name>       Approve a skill for use in the tool loop
  deactivate <name>     Sandbox a skill (disable without removing)
  uninstall <name>      Remove a skill entirely
  validate <name>       Validate a template without installing
  test <name>           Sandbox-test a skill (import + execute with empty args)
  metrics <name>        Show execution metrics for a skill
`.trim());
}

async function cli() {
  const args = process.argv.slice(2);
  const command = args[0];
  const target = args[1];

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  switch (command) {
    case "list": {
      const skills = listInstalled();
      if (skills.length === 0) {
        console.log("No skills installed. Run 'templates' to see what's available.");
        return;
      }
      console.log(`Installed skills (${skills.length}):\n`);
      for (const s of skills) {
        const status = s.status === "active" ? "[active]" : "[sandboxed]";
        const tags = s.tags.length > 0 ? ` (${s.tags.join(", ")})` : "";
        console.log(`  ${status} ${s.name} v${s.version} — ${s.description}${tags}`);
        console.log(`           installed: ${s.installedAt}${s.activatedAt ? `, activated: ${s.activatedAt}` : ""}`);
      }
      break;
    }

    case "templates": {
      const templates = discoverTemplates();
      if (templates.length === 0) {
        console.log("No templates found in brain/skills/templates/");
        return;
      }
      const registry = loadRegistry();
      const installed = new Set(registry.skills.map(s => s.name));

      console.log(`Available templates (${templates.length}):\n`);
      for (const t of templates) {
        const tag = installed.has(t.name) ? " [installed]" : "";
        const tags = t.tags?.length > 0 ? ` (${t.tags.join(", ")})` : "";
        console.log(`  ${t.name} v${t.version || "1.0.0"}${tag} — ${t.description}${tags}`);
      }
      break;
    }

    case "install": {
      if (!target) {
        console.error("Usage: install <name>");
        process.exit(1);
      }
      const result = await installFromTemplate(target);
      console.log(result.message);
      if (!result.ok) process.exit(1);
      break;
    }

    case "install-all": {
      const results = await installAllTemplates();
      for (const r of results) {
        const icon = r.ok ? "+" : "-";
        console.log(`  [${icon}] ${r.name}: ${r.message}`);
      }
      const installed = results.filter(r => r.ok).length;
      console.log(`\n${installed}/${results.length} templates installed.`);
      break;
    }

    case "activate": {
      if (!target) {
        console.error("Usage: activate <name>");
        process.exit(1);
      }
      const result = activateSkill(target);
      console.log(result.message);
      if (!result.ok) process.exit(1);
      break;
    }

    case "deactivate": {
      if (!target) {
        console.error("Usage: deactivate <name>");
        process.exit(1);
      }
      const result = deactivateSkill(target);
      console.log(result.message);
      if (!result.ok) process.exit(1);
      break;
    }

    case "uninstall": {
      if (!target) {
        console.error("Usage: uninstall <name>");
        process.exit(1);
      }
      const result = uninstallSkill(target);
      console.log(result.message);
      if (!result.ok) process.exit(1);
      break;
    }

    case "validate": {
      if (!target) {
        console.error("Usage: validate <name>");
        process.exit(1);
      }
      const template = findTemplate(target);
      if (!template) {
        console.error(`Template '${target}' not found`);
        process.exit(1);
      }
      const result = validateTemplate(template);
      if (result.valid) {
        console.log(`Template '${target}' is valid.`);
      } else {
        console.log(`Template '${target}' has errors:`);
        for (const err of result.errors) {
          console.log(`  - ${err}`);
        }
        process.exit(1);
      }
      break;
    }

    case "test": {
      if (!target) {
        console.error("Usage: test <name>");
        process.exit(1);
      }
      const result = await testSkill(target);
      if (result.ok) {
        console.log(`Skill '${target}' passed sandbox test (${result.durationMs}ms)`);
        if (result.result) console.log(`  Output: ${result.result}`);
      } else {
        console.error(`Skill '${target}' failed sandbox test: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case "metrics": {
      if (!target) {
        console.error("Usage: metrics <name>");
        process.exit(1);
      }
      const m = getSkillMetrics(target);
      if (!m) {
        console.error(`Skill '${target}' not found`);
        process.exit(1);
      }
      const avgMs = m.callCount > 0 ? (m.totalDurationMs / m.callCount).toFixed(0) : 0;
      const errorRate = m.callCount > 0 ? ((m.errorCount / m.callCount) * 100).toFixed(1) : 0;
      console.log(`Metrics for '${target}':`);
      console.log(`  Calls: ${m.callCount}`);
      console.log(`  Errors: ${m.errorCount} (${errorRate}%)`);
      console.log(`  Avg duration: ${avgMs}ms`);
      console.log(`  Consecutive errors: ${m.consecutiveErrors}`);
      if (m.lastCalled) console.log(`  Last called: ${m.lastCalled}`);
      if (m.lastError) console.log(`  Last error: ${m.lastError}`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

// Run CLI if executed directly
const isMain = process.argv[1]?.endsWith("pipeline.mjs");
if (isMain) {
  cli().catch(err => {
    console.error(`[pipeline] Fatal: ${err.message}`);
    process.exit(1);
  });
}
