// familiar start — start all services and show status.

import chalk from "chalk";
import { startAllServices, getAllServicesStatus } from "../lib/services.js";

export async function run({ args } = {}) {
  console.log();
  console.log(chalk.bold("  Starting Familiar services..."));
  console.log();

  const results = startAllServices();

  for (const r of results) {
    if (r.ok) {
      console.log(chalk.green(`  \u2713 ${r.displayName}`));
    } else {
      console.log(chalk.red(`  \u2717 ${r.displayName}: ${r.error}`));
    }
  }

  // Wait a moment for services to initialize before checking health
  console.log();
  console.log(chalk.dim("  Waiting for services to initialize..."));
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Show status
  const statuses = await getAllServicesStatus();

  console.log();
  const nameW = 18;
  const statusW = 12;
  const healthW = 12;

  console.log(
    chalk.dim(
      "  " +
        "Service".padEnd(nameW) +
        "Status".padEnd(statusW) +
        "Health".padEnd(healthW)
    )
  );
  console.log(chalk.dim("  " + "-".repeat(nameW + statusW + healthW)));

  for (const s of statuses) {
    const status = s.running ? chalk.green("running") : chalk.red("stopped");
    const health = s.running
      ? s.healthy
        ? chalk.green("healthy")
        : chalk.yellow("pending")
      : chalk.dim("-");

    // Pad accounting for ANSI escape codes (roughly 10 extra chars per colored string)
    console.log(
      "  " +
        s.displayName.padEnd(nameW) +
        status.padEnd(statusW + 10) +
        health
    );
  }

  console.log();
}
