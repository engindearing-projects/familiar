// familiar stop — stop all services and confirm.

import chalk from "chalk";
import { stopAllServices, checkServiceRunning, getServiceDefs } from "../lib/services.js";

export async function run({ args } = {}) {
  console.log();
  console.log(chalk.bold("  Stopping Familiar services..."));
  console.log();

  const results = stopAllServices();

  for (const r of results) {
    if (r.ok) {
      console.log(chalk.green(`  \u2713 ${r.displayName} stopped`));
    } else {
      console.log(chalk.red(`  \u2717 ${r.displayName}: ${r.error}`));
    }
  }

  // Verify they're actually stopped
  console.log();
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const defs = getServiceDefs();
  let allStopped = true;

  for (const def of defs) {
    const { running, pid } = checkServiceRunning(def.label);
    if (running) {
      console.log(chalk.yellow(`  \u26A0 ${def.displayName} still running (pid ${pid})`));
      allStopped = false;
    }
  }

  if (allStopped) {
    console.log(chalk.green("  All services stopped."));
  } else {
    console.log(chalk.yellow("  Some services may still be shutting down."));
  }

  console.log();
}
