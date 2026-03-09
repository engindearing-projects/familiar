#!/usr/bin/env bun
// Post-session summary for a git repo.
// Generates a lightweight summary and stores it in Familiar's memory DB,
// plus logs to the activity server so Telegram can push it.

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, basename } from "path";
import { addObservation } from "../apps/cli/lib/memory-db.js";
import { memoryDir } from "../apps/cli/lib/paths.js";

function run(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function safeRun(cmd) {
  try {
    return run(cmd);
  } catch {
    return "";
  }
}

const repoPath = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const repoName = basename(repoPath);

// Ensure memory dir exists
const memDir = memoryDir();
if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });

const statePath = resolve(memDir, "last-summary.json");
let state = {};
if (existsSync(statePath)) {
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    state = {};
  }
}

const head = safeRun(`git -C "${repoPath}" rev-parse HEAD`);
if (!head) {
  console.error(`Not a git repo: ${repoPath}`);
  process.exit(1);
}

const last = state[repoPath] || "";
const range = last ? `${last}..${head}` : "HEAD~5..HEAD";

const commitsRaw = safeRun(`git -C "${repoPath}" log --oneline ${range}`);
const commits = commitsRaw ? commitsRaw.split("\n") : [];

const filesRaw = safeRun(`git -C "${repoPath}" diff --name-only ${range}`);
const files = filesRaw ? filesRaw.split("\n").filter(Boolean) : [];

const statusRaw = safeRun(`git -C "${repoPath}" status --short`);
const statusLines = statusRaw ? statusRaw.split("\n") : [];

const summaryParts = [];
summaryParts.push(`Auto summary for ${repoName}`);
summaryParts.push(`${commits.length} commit${commits.length === 1 ? "" : "s"}`);
summaryParts.push(`${files.length} file${files.length === 1 ? "" : "s"} changed`);
const summary = summaryParts.join(" • ");

const detailsLines = [];
if (commits.length > 0) {
  detailsLines.push("Commits:");
  detailsLines.push(...commits.slice(0, 20).map((c) => `- ${c}`));
  if (commits.length > 20) detailsLines.push(`- ...and ${commits.length - 20} more`);
}
if (files.length > 0) {
  detailsLines.push("");
  detailsLines.push("Files:");
  detailsLines.push(...files.slice(0, 30).map((f) => `- ${f}`));
  if (files.length > 30) detailsLines.push(`- ...and ${files.length - 30} more`);
}
if (statusLines.length > 0) {
  detailsLines.push("");
  detailsLines.push("Working tree:");
  detailsLines.push(...statusLines.map((s) => `- ${s}`));
}

const details = detailsLines.join("\n");

const obs = {
  type: "code_change",
  project: repoName,
  summary,
  details,
  tags: ["auto-summary", repoName],
  source: "post-session",
};

const id = addObservation(obs);
console.log(`Stored observation ${id}: ${summary}`);

// Log to activity server so Telegram can pick it up.
const ACTIVITY_URL = process.env.ACTIVITY_URL || "http://localhost:18790";
try {
  const res = await fetch(`${ACTIVITY_URL}/activity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      platform: "telegram",
      session_key: `repo:${repoName}`,
      role: "assistant",
      content: summary + (details ? `\n\n${details}` : ""),
      metadata: { repo: repoPath, range },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("Activity log failed:", err);
  }
} catch (err) {
  console.error("Activity log error:", err.message);
}

// Update checkpoint
state[repoPath] = head;
writeFileSync(statePath, JSON.stringify(state, null, 2));
