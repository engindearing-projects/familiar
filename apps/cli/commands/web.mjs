// `familiar web` — opens the web UI in the default browser, pre-authenticated.
// Reads the gateway token from config/.env and passes it via URL params.

import { resolve, dirname } from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import chalk from "chalk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "../../config/.env");
const DEFAULT_HOST = "localhost";
const DEFAULT_GW_PORT = "18789";
const DEFAULT_WEB_PORT = "5173";

function readToken() {
  try {
    const env = readFileSync(ENV_PATH, "utf-8");
    const match = env.match(/^(?:FAMILIAR|COZYTERM)_GATEWAY_TOKEN=(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

export async function run({ args = [] } = {}) {
  const webPort = args[0] || DEFAULT_WEB_PORT;
  const token = readToken();

  if (!token) {
    console.error(chalk.red("Could not read gateway token from config/.env"));
    console.log(chalk.gray(`Expected at: ${ENV_PATH}`));
    process.exit(1);
  }

  const url = `http://${DEFAULT_HOST}:${webPort}/?host=${DEFAULT_HOST}&port=${DEFAULT_GW_PORT}&token=${token}`;

  console.log(chalk.cyan("Opening Familiar web UI..."));
  console.log(chalk.gray(`Gateway: ${DEFAULT_HOST}:${DEFAULT_GW_PORT}`));

  // Use Bun's native shell to open browser
  const proc = Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;

  console.log(chalk.green("Opened in browser. Token auto-applied."));
}
