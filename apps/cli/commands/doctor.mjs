// familiar doctor — full diagnostic checklist with optional self-healing.

import chalk from "chalk";
import { existsSync, readFileSync, mkdirSync } from "fs";
import { runAllChecks } from "../lib/prereqs.js";
import { getAllServicesStatus, restartService, getServiceDefs } from "../lib/services.js";
import { allDirs, findConfig, logsDir } from "../lib/paths.js";
import { rotateLogs, cleanOldLogs, getLogStats, formatBytes } from "../lib/log-rotation.js";

const PASS = chalk.green("  \u2713");
const FAIL = chalk.red("  \u2717");
const WARN = chalk.yellow("  \u26A0");

function pass(msg) {
  console.log(`${PASS} ${msg}`);
}
function fail(msg) {
  console.log(`${FAIL} ${msg}`);
}
function warn(msg) {
  console.log(`${WARN} ${msg}`);
}

export async function run({ args } = {}) {
  const flags = new Set(args || []);
  const doFix = flags.has("--fix");
  const doCleanLogs = flags.has("--clean-logs");

  let issues = 0;
  let warnings = 0;
  let fixed = 0;

  console.log();
  console.log(chalk.bold("  Familiar Doctor"));
  console.log();

  // ── 1. Prerequisites ──────────────────────────────
  console.log(chalk.cyan("  Prerequisites"));
  const checks = runAllChecks();

  // Platform
  if (checks.platform.supported) {
    pass(`Platform: macOS ${checks.platform.version || ""}`);
  } else {
    fail(`Platform: ${checks.platform.platform} (only macOS supported)`);
    issues++;
  }

  // Required tools
  const requiredTools = [
    { check: checks.bun, required: true },
    { check: checks.brew, required: false },
    { check: checks.gateway, required: true },
    { check: checks.claude, required: false },
    { check: checks.ollama, required: false },
  ];

  for (const { check, required } of requiredTools) {
    if (check.installed) {
      pass(`${check.name}: ${check.version || "installed"}`);
    } else if (required) {
      fail(`${check.name}: not found`);
      issues++;
    } else {
      warn(`${check.name}: not found (optional)`);
      warnings++;
    }
  }

  console.log();

  // ── 2. Services ────────────────────────────────────
  console.log(chalk.cyan("  Services"));
  const statuses = await getAllServicesStatus();

  for (const s of statuses) {
    if (s.running && s.healthy) {
      pass(`${s.displayName}: running (pid ${s.pid}, ${s.latencyMs}ms)`);
    } else if (s.running && !s.healthy) {
      warn(`${s.displayName}: running but unhealthy (pid ${s.pid})`);
      warnings++;
      if (doFix && s.managed) {
        try {
          console.log(chalk.dim(`    -> Restarting ${s.displayName}...`));
          restartService(s.label);
          console.log(chalk.dim(`    -> Restarted.`));
          fixed++;
        } catch (e) {
          console.log(chalk.dim(`    -> Failed: ${e.message}`));
        }
      }
    } else {
      fail(`${s.displayName}: stopped`);
      issues++;
      if (doFix && s.managed) {
        try {
          console.log(chalk.dim(`    -> Starting ${s.displayName}...`));
          restartService(s.label);
          console.log(chalk.dim(`    -> Started.`));
          fixed++;
        } catch (e) {
          console.log(chalk.dim(`    -> Failed: ${e.message}`));
        }
      }
    }
  }

  console.log();

  // ── 3. Configuration ───────────────────────────────
  console.log(chalk.cyan("  Configuration"));
  const configPath = findConfig();

  if (configPath) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      JSON.parse(raw);
      pass(`Config: ${configPath}`);
    } catch (e) {
      fail(`Config: ${configPath} (invalid JSON: ${e.message})`);
      issues++;
    }
  } else {
    fail("Config: no gateway config found (familiar.json)");
    issues++;
  }

  console.log();

  // ── 4. Directories ─────────────────────────────────
  console.log(chalk.cyan("  Directories"));
  const dirs = allDirs();
  let missingDirs = 0;

  for (const dir of dirs) {
    if (existsSync(dir)) {
      pass(dir);
    } else {
      fail(`${dir} (missing)`);
      missingDirs++;
      issues++;
      if (doFix) {
        try {
          mkdirSync(dir, { recursive: true });
          console.log(chalk.dim(`    -> Created.`));
          fixed++;
        } catch (e) {
          console.log(chalk.dim(`    -> Failed: ${e.message}`));
        }
      }
    }
  }

  console.log();

  // ── 5. Logs ────────────────────────────────────────
  console.log(chalk.cyan("  Logs"));
  const logs = logsDir();
  const logStats = getLogStats(logs);

  console.log(`  ${chalk.dim("Total size:")} ${formatBytes(logStats.totalSize)}`);
  console.log(`  ${chalk.dim("File count:")} ${logStats.fileCount}`);
  if (logStats.oldestFile) {
    console.log(`  ${chalk.dim("Oldest:")} ${logStats.oldestFile}`);
  }
  if (logStats.newestFile) {
    console.log(`  ${chalk.dim("Newest:")} ${logStats.newestFile}`);
  }

  const ONE_HUNDRED_MB = 100 * 1024 * 1024;
  if (logStats.totalSize > ONE_HUNDRED_MB) {
    warn(`Logs exceed 100MB (${formatBytes(logStats.totalSize)})`);
    warnings++;
    if (doFix) {
      console.log(chalk.dim("    -> Rotating large logs..."));
      const rotated = rotateLogs(logs);
      if (rotated.length) {
        console.log(chalk.dim(`    -> Rotated ${rotated.length} file(s).`));
        fixed++;
      }
      console.log(chalk.dim("    -> Cleaning old archives..."));
      const cleaned = cleanOldLogs(logs, 7);
      if (cleaned.length) {
        console.log(chalk.dim(`    -> Removed ${cleaned.length} old archive(s).`));
        fixed++;
      }
    }
  } else if (logStats.totalSize > TEN_MB_THRESHOLD()) {
    pass(`Log size OK (${formatBytes(logStats.totalSize)})`);
  } else {
    pass(`Log size OK (${formatBytes(logStats.totalSize)})`);
  }

  // Explicit --clean-logs flag
  if (doCleanLogs) {
    console.log();
    console.log(chalk.cyan("  Log Cleanup"));
    const rotated = rotateLogs(logs);
    if (rotated.length) {
      console.log(`  Rotated ${rotated.length} file(s):`);
      for (const r of rotated) {
        console.log(chalk.dim(`    ${r.file} -> ${r.archiveName} (was ${formatBytes(r.originalSize)})`));
      }
    }
    const cleaned = cleanOldLogs(logs, 3); // aggressive: 3 days
    if (cleaned.length) {
      console.log(`  Removed ${cleaned.length} old archive(s):`);
      for (const c of cleaned) {
        console.log(chalk.dim(`    ${c.file} (${c.age} days old)`));
      }
    }
    if (!rotated.length && !cleaned.length) {
      pass("No logs to clean up.");
    }
  }

  console.log();

  // ── Summary ────────────────────────────────────────
  console.log(chalk.bold("  Summary"));
  if (issues === 0 && warnings === 0) {
    console.log(chalk.green("  Everything looks good."));
  } else {
    if (issues > 0) console.log(chalk.red(`  ${issues} issue(s) found.`));
    if (warnings > 0) console.log(chalk.yellow(`  ${warnings} warning(s).`));
    if (doFix && fixed > 0) console.log(chalk.green(`  ${fixed} item(s) auto-fixed.`));
    if (!doFix && issues > 0) {
      console.log(chalk.dim("  Run with --fix to attempt auto-repair."));
    }
  }

  console.log();
}

function TEN_MB_THRESHOLD() {
  return 10 * 1024 * 1024;
}
