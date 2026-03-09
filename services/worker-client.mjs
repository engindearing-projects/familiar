// Familiar Worker Client — helper to talk to a remote worker node
//
// Usage:
//   import { delegateToWorker, checkWorkerHealth, sendReflection } from "./worker-client.mjs";

import { resolve, dirname } from "path";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(__dirname, "..");

// Load worker URL and auth token from config/env
let WORKER_URL = process.env.WORKER_URL || "";
let AUTH_TOKEN = process.env.WORKER_AUTH_TOKEN || "";

try {
  const configFile = resolve(PROJECT_DIR, "config/familiar.json");
  if (existsSync(configFile)) {
    const config = JSON.parse(readFileSync(configFile, "utf-8"));
    if (!WORKER_URL && config.worker?.url) WORKER_URL = config.worker.url;
  }
} catch {}

try {
  const envFile = resolve(PROJECT_DIR, "config/.env");
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf-8").split("\n")) {
      const [key, ...rest] = line.split("=");
      const val = rest.join("=").trim().replace(/^["']|["']$/g, "");
      if (key.trim() === "WORKER_AUTH_TOKEN" && !AUTH_TOKEN) AUTH_TOKEN = val;
      if (key.trim() === "FAMILIAR_GATEWAY_TOKEN" && !AUTH_TOKEN) AUTH_TOKEN = val;
}
  }
} catch {}

if (!WORKER_URL) {
  throw new Error("WORKER_URL environment variable is required");
}

const headers = () => ({
  "Content-Type": "application/json",
  ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
});

async function delegateToWorker(handName, params = {}) {
  const res = await fetch(`${WORKER_URL}/task/run`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ hand: handName, params }),
    signal: AbortSignal.timeout(10000),
  });
  return res.json();
}

async function getTaskStatus(taskId) {
  const res = await fetch(`${WORKER_URL}/task/status/${taskId}`, {
    headers: headers(),
    signal: AbortSignal.timeout(5000),
  });
  return res.json();
}

async function checkWorkerHealth() {
  const res = await fetch(`${WORKER_URL}/health`, {
    signal: AbortSignal.timeout(5000),
  });
  return res.json();
}

async function sendReflection(reflection) {
  const res = await fetch(`${WORKER_URL}/peer/reflect`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(reflection),
    signal: AbortSignal.timeout(10000),
  });
  return res.json();
}

async function requestEvaluation(work) {
  const res = await fetch(`${WORKER_URL}/peer/evaluate`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(work),
    signal: AbortSignal.timeout(10000),
  });
  return res.json();
}

async function getFeedback() {
  const res = await fetch(`${WORKER_URL}/peer/feedback`, {
    headers: headers(),
    signal: AbortSignal.timeout(5000),
  });
  return res.json();
}

export {
  delegateToWorker,
  getTaskStatus,
  checkWorkerHealth,
  sendReflection,
  requestEvaluation,
  getFeedback,
  WORKER_URL,
};
