// familiar status — display service health table with chalk formatting.

import chalk from "chalk";
import { getAllServicesStatus } from "../lib/services.js";

/**
 * Format a PID for display.
 */
function fmtPid(pid) {
  return pid !== null ? String(pid) : "-";
}

/**
 * Format latency for display.
 */
function fmtLatency(latencyMs, healthy) {
  if (!healthy) return "-";
  return `${latencyMs}ms`;
}

/**
 * Format running/health status with color.
 */
function fmtStatus(running) {
  return running ? chalk.green("running") : chalk.red("stopped");
}

function fmtHealth(running, healthy) {
  if (!running) return chalk.dim("-");
  return healthy ? chalk.green("healthy") : chalk.red("unhealthy");
}

export async function run({ args } = {}) {
  console.log();
  console.log(chalk.bold("  Familiar Services"));
  console.log();

  const statuses = await getAllServicesStatus();

  // Column widths
  const nameW = 18;
  const statusW = 12;
  const healthW = 12;
  const pidW = 10;
  const latencyW = 10;

  // Header
  const header =
    "  " +
    "Service".padEnd(nameW) +
    "Status".padEnd(statusW) +
    "Health".padEnd(healthW) +
    "PID".padEnd(pidW) +
    "Latency".padEnd(latencyW);

  console.log(chalk.dim(header));
  console.log(chalk.dim("  " + "-".repeat(nameW + statusW + healthW + pidW + latencyW)));

  for (const s of statuses) {
    const line =
      "  " +
      s.displayName.padEnd(nameW) +
      fmtStatus(s.running).padEnd(statusW + 10) + // extra padding to account for ANSI codes
      fmtHealth(s.running, s.healthy).padEnd(healthW + 10) +
      fmtPid(s.pid).padEnd(pidW) +
      fmtLatency(s.latencyMs, s.healthy);

    console.log(line);
  }

  console.log();

  // Summary line
  const runCount = statuses.filter((s) => s.running).length;
  const healthyCount = statuses.filter((s) => s.healthy).length;
  const total = statuses.length;

  if (runCount === total && healthyCount === total) {
    console.log(chalk.green("  All services operational."));
  } else if (runCount === 0) {
    console.log(chalk.red("  All services stopped."));
  } else {
    console.log(
      chalk.yellow(`  ${runCount}/${total} running, ${healthyCount}/${total} healthy.`)
    );
  }

  console.log();
}
