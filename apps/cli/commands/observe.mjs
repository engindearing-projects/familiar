// observe command — write an observation to the memory DB from CLI/cron.
//
// Usage:
//   familiar observe "task_update" "Finished API integration" --project myapp --tag api
//   familiar observe note "Quick thought about the scheduler"
//
// Designed to be called by cron jobs, scripts, or directly.

import chalk from "chalk";
import { addObservation, getStats } from "../lib/memory-db.js";

const VALID_TYPES = [
  "task_update",
  "decision",
  "blocker",
  "insight",
  "note",
  "standup",
  "observation",
];

const HELP = `
  ${chalk.bold("familiar observe")} — save an observation to memory

  ${chalk.cyan("Usage:")}
    familiar observe [type] <summary> [options]

  ${chalk.cyan("Types:")}
    ${VALID_TYPES.join(", ")}
    (default: note)

  ${chalk.cyan("Options:")}
    --project <name>    Associate with a project
    --tag <tag>         Add a tag (repeatable)
    --details <text>    Additional details
    --source <name>     Source identifier (default: cli)
    --json              Output JSON result
    -h, --help          Show this help

  ${chalk.cyan("Examples:")}
    familiar observe "Merged PR #42 — Quest API integration"
    familiar observe task_update "PROJ-42 complete" --project myapp --tag api
    familiar observe blocker "Waiting on IAM creds from devops" --project myapp
`;

export async function run({ args = [] } = {}) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }

  const jsonOut = args.includes("--json");
  const filteredArgs = args.filter((a) => a !== "--json");

  // Parse flags
  let project = null;
  let details = null;
  let source = "cli";
  const tags = [];
  const positional = [];

  let i = 0;
  while (i < filteredArgs.length) {
    const a = filteredArgs[i];
    if (a === "--project" && filteredArgs[i + 1]) {
      project = filteredArgs[++i];
    } else if (a === "--tag" && filteredArgs[i + 1]) {
      tags.push(filteredArgs[++i]);
    } else if (a === "--details" && filteredArgs[i + 1]) {
      details = filteredArgs[++i];
    } else if (a === "--source" && filteredArgs[i + 1]) {
      source = filteredArgs[++i];
    } else if (!a.startsWith("--")) {
      positional.push(a);
    }
    i++;
  }

  // Determine type and summary from positional args
  let type = "note";
  let summary;

  if (positional.length === 0) {
    console.error(chalk.red("Error: summary is required."));
    console.log(HELP);
    process.exit(1);
  }

  if (positional.length === 1) {
    // Just a summary, use default type
    summary = positional[0];
  } else if (VALID_TYPES.includes(positional[0].toLowerCase())) {
    // First arg is a type
    type = positional[0].toLowerCase();
    summary = positional.slice(1).join(" ");
  } else {
    // All positional args = summary
    summary = positional.join(" ");
  }

  if (!summary || summary.trim().length === 0) {
    console.error(chalk.red("Error: summary cannot be empty."));
    process.exit(1);
  }

  try {
    const id = addObservation({
      type,
      summary: summary.trim(),
      details: details || null,
      tags: tags.length > 0 ? tags : null,
      project: project || null,
      source,
    });

    if (jsonOut) {
      console.log(JSON.stringify({ id, type, summary, project, tags, source }));
    } else {
      console.log(
        chalk.green("✓") +
        chalk.gray(` [${id}]`) +
        ` ${chalk.bold(type)}: ${summary}` +
        (project ? chalk.cyan(` [${project}]`) : "")
      );
    }

    process.exit(0);
  } catch (err) {
    if (jsonOut) {
      console.log(JSON.stringify({ error: err.message }));
    } else {
      console.error(chalk.red(`Failed to save observation: ${err.message}`));
    }
    process.exit(1);
  }
}
