// Chat command — interactive TUI or one-shot query.
// Extracted from the original CLI entry point.

import { readFileSync } from "fs";
import chalk from "chalk";
import { GatewayClient } from "../src/gateway.mjs";
import { findConfig } from "../lib/paths.js";
import { extractAndStore } from "../lib/extract-observations.js";
import { injectContext } from "../lib/memory-context.js";

/**
 * Run chat mode.
 * @param {{ oneshot: string|null, sessionKey: string }} opts
 */
export async function run({ oneshot = null, sessionKey = "familiar:cli:main", coach = false } = {}) {
  const configPath = findConfig();
  if (!configPath) {
    console.error(chalk.red("Could not find gateway config."));
    console.error(chalk.gray("Run `familiar init` to set up, or set FAMILIAR_CONFIG."));
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    console.error(chalk.red(`Failed to read config: ${err.message}`));
    process.exit(1);
  }

  const port = config.gateway?.port ?? 18789;
  const token = config.gateway?.auth?.token;
  if (!token) {
    console.error(chalk.red("No gateway auth token found in config."));
    process.exit(1);
  }

  const gw = new GatewayClient({ port, token });

  try {
    await gw.connect();
  } catch (err) {
    console.error(chalk.red(`Failed to connect to gateway: ${err.message}`));
    console.error(chalk.gray("Is the gateway running? Try `familiar status` or `familiar doctor`."));
    process.exit(1);
  }

  // One-shot mode
  if (oneshot) {
    let result = "";
    let done = false;

    gw.on("agent", (payload) => {
      if (payload.stream === "assistant") {
        const text = payload.data?.text || payload.data?.content || "";
        const delta = payload.data?.delta || "";
        if (text) {
          const newContent = text.slice(result.length);
          if (newContent) process.stdout.write(newContent);
          result = text;
        } else if (delta) {
          process.stdout.write(delta);
          result += delta;
        }
      }
    });

    gw.on("chat", (payload) => {
      if (payload?.state === "final" || payload?.state === "error") {
        if (payload?.state === "error") {
          process.stderr.write(chalk.red(`\nError: ${payload.errorMessage || "Unknown"}\n`));
        }
        // Extract observations before exiting
        if (payload?.state === "final") {
          try { extractAndStore(oneshot, result, "cli-oneshot"); } catch {}
        }
        process.stdout.write("\n");
        done = true;
        gw.disconnect();
        process.exit(payload?.state === "error" ? 1 : 0);
      }
    });

    try {
      await gw.chat(sessionKey, oneshot);
    } catch (err) {
      console.error(chalk.red(err.message));
      gw.disconnect();
      process.exit(1);
    }

    // Safety timeout
    setTimeout(() => {
      if (!done) {
        process.stderr.write(chalk.yellow("\nTimed out waiting for response.\n"));
        gw.disconnect();
        process.exit(1);
      }
    }, 300000);
    return;
  }

  // Interactive TUI mode
  const React = await import("react");
  const { render } = await import("ink");
  const { App } = await import("../tui/App.js");
  const e = React.createElement;

  const { waitUntilExit } = render(e(App, { gateway: gw, sessionKey, initialCoachMode: coach }));

  await waitUntilExit();
  gw.disconnect();
  process.exit(0);
}
