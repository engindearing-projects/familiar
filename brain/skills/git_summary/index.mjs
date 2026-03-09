import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const name = "git_summary";
export const description = "Summarize git repository status — branch, recent commits, uncommitted changes, stash count.";
export const parameters = {
  path: { type: "string", description: "Path to the git repository" },
  commitCount: { type: "number", description: "Number of recent commits to show (default: 5)" }
};

function git(cmd, cwd) {
  return execSync(`git ${cmd}`, {
    cwd,
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString().trim();
}

export async function execute(args) {
  const repoPath = resolve(args?.path || process.cwd());
  const count = args?.commitCount || 5;

  if (!existsSync(resolve(repoPath, ".git"))) {
    return `Not a git repository: ${repoPath}`;
  }

  const parts = [];

  try {
    const branch = git("branch --show-current", repoPath);
    parts.push(`Branch: ${branch || "(detached HEAD)"}`);
  } catch { parts.push("Branch: unknown"); }

  try {
    const status = git("status --short", repoPath);
    const lines = status ? status.split("\n") : [];
    parts.push(`Changes: ${lines.length} file(s) modified`);
    if (lines.length > 0 && lines.length <= 10) {
      parts.push(lines.map(l => `  ${l}`).join("\n"));
    }
  } catch { parts.push("Changes: unknown"); }

  try {
    const log = git(`log --oneline -${count}`, repoPath);
    parts.push(`Recent commits:\n${log}`);
  } catch { parts.push("Commits: none or error"); }

  try {
    const stash = git("stash list", repoPath);
    const stashCount = stash ? stash.split("\n").length : 0;
    if (stashCount > 0) parts.push(`Stashes: ${stashCount}`);
  } catch { /* no stash */ }

  return parts.join("\n\n");
}
