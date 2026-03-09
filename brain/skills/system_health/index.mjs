import { execSync } from "node:child_process";

export const name = "system_health";
export const description = "Check system health — CPU load, memory usage, disk space, and uptime.";
export const parameters = {
  verbose: { type: "boolean", description: "Include per-disk and per-CPU breakdown" }
};

export async function execute(args) {
  const verbose = args?.verbose || false;
  const parts = [];

  try {
    const uptime = execSync("uptime", { timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
    parts.push(`Uptime: ${uptime}`);
  } catch (e) {
    parts.push(`Uptime: error (${e.message})`);
  }

  try {
    const mem = execSync("vm_stat | head -5", { timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
    parts.push(`Memory:\n${mem}`);
  } catch (e) {
    parts.push(`Memory: error (${e.message})`);
  }

  try {
    const dfFlag = verbose ? "" : "-h /";
    const disk = execSync(`df -h ${dfFlag}`, { timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
    parts.push(`Disk:\n${disk}`);
  } catch (e) {
    parts.push(`Disk: error (${e.message})`);
  }

  return parts.join("\n\n");
}
