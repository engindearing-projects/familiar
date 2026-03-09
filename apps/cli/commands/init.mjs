// Setup wizard command — `familiar init`
// Renders the full interactive wizard TUI for first-time setup or re-run.

import React from "react";
import { render } from "ink";
import { WizardApp } from "../tui/WizardApp.js";

const e = React.createElement;

/**
 * Run the setup wizard.
 * @param {{ args?: string[] }} opts
 */
export async function run({ args = [] } = {}) {
  // --reset flag clears saved init state so the wizard starts fresh
  if (args.includes("--reset")) {
    const { initStatePath } = await import("../lib/paths.js");
    const { existsSync, unlinkSync } = await import("fs");
    const p = initStatePath();
    if (existsSync(p)) {
      unlinkSync(p);
    }
  }

  const { waitUntilExit } = render(e(WizardApp));
  await waitUntilExit();

  // Auto-launch the chat TUI after wizard completes
  // Brief pause to let the gateway finish restarting with the new token
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const { run: startChat } = await import("./chat.mjs");
    await startChat({});
  } catch (err) {
    // If chat fails to launch (e.g. gateway not ready), just exit gracefully
    console.log("Tip: run `familiar` to start chatting.");
  }
}
