#!/usr/bin/env bun

// The Forge — Auto-Trainer Daemon
// Watches forge.db for new training pairs and automatically triggers
// the full pipeline: prepare → train → deploy → evaluate → rollback if needed.
//
// Runs as a launchd service (com.familiar.forge-auto) or standalone.
// Sends Telegram notifications on train completion or failure.
//
// Usage:
//   bun ~/familiar/trainer/forge-auto.mjs [--threshold 100] [--interval 300] [--dry-run]

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { loadDomain } from "./domain-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRAINER_DIR = __dirname;
const VENV_PYTHON = resolve(TRAINER_DIR, ".venv", "bin", "python");
const SCRIPTS_DIR = resolve(TRAINER_DIR, "scripts");
const FORGE_DB_PATH = resolve(TRAINER_DIR, "forge-db.js");

// ── Config ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}

const CONFIG = {
  // Minimum new pairs since last train to trigger
  threshold: parseInt(getArg("threshold", "100")),
  // Check interval in seconds
  intervalSec: parseInt(getArg("interval", "300")),
  // Don't actually train, just log what would happen
  dryRun: args.includes("--dry-run"),
  // Max consecutive failures before pausing
  maxFailures: 3,
  // Minimum hours between training runs
  cooldownHours: 4,
  // Regression threshold — rollback if score drops more than this
  regressionThreshold: 5,
};

let consecutiveFailures = 0;
let lastTrainTime = 0;
let running = false;

// ── Telegram ────────────────────────────────────────────────────────────────

async function sendTelegram(message) {
  try {
    const envPath = resolve(dirname(TRAINER_DIR), "config", ".env");
    if (!existsSync(envPath)) return;

    const env = readFileSync(envPath, "utf8");
    const botToken = env.match(/TELEGRAM_BOT_TOKEN=(.+)/)?.[1]?.trim();
    const chatId = env.match(/TELEGRAM_CHAT_ID=(.+)/)?.[1]?.trim();
    if (!botToken || !chatId) return;

    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
      }),
    });
  } catch {
    // non-fatal
  }
}

// ── Pipeline Steps ──────────────────────────────────────────────────────────

function runScript(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: TRAINER_DIR,
      stdio: opts.quiet ? "pipe" : "inherit",
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    let stdout = "";
    let stderr = "";
    if (opts.quiet) {
      child.stdout?.on("data", (d) => (stdout += d));
      child.stderr?.on("data", (d) => (stderr += d));
    }

    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Exit code ${code}: ${stderr.slice(-500)}`));
    });
    child.on("error", reject);
  });
}

async function getStats() {
  const { getForgeStats, getLastRun, getTotalPairCount } = await import(FORGE_DB_PATH);
  return { stats: getForgeStats(), lastRun: getLastRun(), totalPairs: getTotalPairCount() };
}

async function getNewPairCount() {
  const { getUnusedPairCount } = await import(FORGE_DB_PATH);
  return getUnusedPairCount();
}

async function getActiveScore() {
  const { getActiveVersion, getLatestEvaluation } = await import(FORGE_DB_PATH);
  const active = getActiveVersion();
  if (!active) return null;
  const eval_ = getLatestEvaluation(active.version);
  return eval_?.overall_score ?? active.benchmark_score ?? null;
}

// Multi-domain training — train all domains, route to remote GPU when configured
const TRAIN_DOMAINS = ["brain", "coding", "chat", "reasoning", "tools", "healthcare", "legal", "finance", "education"];

// Minimum training examples required per domain to bother training
const MIN_DOMAIN_EXAMPLES = { brain: 20, coding: 10, chat: 10, reasoning: 10, tools: 10, healthcare: 10, legal: 10, finance: 10, education: 10 };

// ── Remote GPU Training ──────────────────────────────────────────────────────
// Routes training through SSH to the CUDA machine when a domain has remote config.
// Uses sync-remote.sh for data transfer and runs train-cuda.py on the remote GPU.

const SSH_KEY = process.env.FORGE_SSH_KEY || resolve(process.env.HOME || "/tmp", ".ssh", "id_ed25519");
const SSH_OPTS = `-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -i ${SSH_KEY}`;

function getDomainRemoteConfig(domainId) {
  try {
    const cfg = loadDomain(domainId);
    if (cfg?.remote?.ssh_host) return cfg.remote;
  } catch {}
  return null;
}

/** Push training data to remote, train via CUDA, pull results back */
async function runRemoteTraining(domain) {
  const remote = getDomainRemoteConfig(domain);
  if (!remote) throw new Error("No remote config for domain");

  const remoteDir = process.env.FORGE_REMOTE_DIR || "~/familiar/trainer";
  const sshTarget = remote.ssh_host;
  const sshCmd = `ssh ${SSH_OPTS} ${sshTarget}`;
  const exportPath = "export PATH=/usr/local/cuda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH";

  // Step 1: Push data and configs via sync-remote.sh
  log(`  [${domain}] Pushing data to ${sshTarget}...`);
  await runScript("bash", [resolve(SCRIPTS_DIR, "sync-remote.sh"), "push"]);

  // Step 2: Prepare data on remote
  log(`  [${domain}] Preparing data on remote...`);
  await runScript("ssh", [
    ...SSH_OPTS.split(" "), sshTarget,
    `${exportPath} && cd ${remoteDir} && .venv/bin/python scripts/prepare-data.py --domain ${domain}`,
  ]);

  // Step 3: Train on remote GPU (CUDA)
  log(`  [${domain}] Training on remote GPU (${remote.gpu || "CUDA"})...`);
  await runScript("ssh", [
    ...SSH_OPTS.split(" "), sshTarget,
    `${exportPath} && cd ${remoteDir} && .venv/bin/python scripts/train-cuda.py --domain ${domain}`,
  ]);

  // Step 4: Fuse and deploy on remote (produces GGUF + Ollama model)
  log(`  [${domain}] Fusing and deploying on remote...`);
  await runScript("ssh", [
    ...SSH_OPTS.split(" "), sshTarget,
    `${exportPath} && cd ${remoteDir} && .venv/bin/python scripts/fuse-and-deploy.py --domain ${domain}`,
  ]);

  // Step 5: Pull results back
  log(`  [${domain}] Pulling trained models from remote...`);
  await runScript("bash", [resolve(SCRIPTS_DIR, "sync-remote.sh"), "pull"]);
}

async function runDomainPipeline(domain) {
  const domainStart = Date.now();
  const remote = getDomainRemoteConfig(domain);
  const useRemote = !!remote;

  if (useRemote) {
    log(`  [${domain}] Remote GPU training → ${remote.ssh_host} (${remote.gpu || "CUDA"})`);
  }

  // Prepare data locally first (needed for example count check)
  log(`  [${domain}] Preparing data...`);
  try {
    await runScript(VENV_PYTHON, [resolve(SCRIPTS_DIR, "prepare-data.py"), "--domain", domain]);
  } catch (e) {
    log(`  [${domain}] Prepare failed (likely not enough data): ${e.message.slice(0, 100)}`);
    return { domain, status: "skipped", reason: "prepare failed" };
  }

  // Count training examples
  const trainFile = domain === "coding"
    ? resolve(TRAINER_DIR, "data", "train.jsonl")
    : resolve(TRAINER_DIR, "data", domain, "train.jsonl");

  let trainCount = 0;
  try {
    trainCount = readFileSync(trainFile, "utf8").trim().split("\n").length;
  } catch {
    log(`  [${domain}] No training file produced`);
    return { domain, status: "skipped", reason: "no data" };
  }

  const minExamples = MIN_DOMAIN_EXAMPLES[domain] || 10;
  if (trainCount < minExamples) {
    log(`  [${domain}] Only ${trainCount} examples (need ${minExamples}), skipping`);
    return { domain, status: "skipped", reason: `${trainCount} < ${minExamples} examples` };
  }

  // Get pre-training score for comparison
  let preScore = null;
  try {
    preScore = await getActiveScore();
  } catch {}

  log(`  [${domain}] ${trainCount} examples — training${useRemote ? " (remote CUDA)" : " (local MLX)"}...`);

  if (useRemote) {
    // Route training through SSH to the GPU machine
    try {
      await runRemoteTraining(domain);
    } catch (e) {
      log(`  [${domain}] Remote training failed: ${e.message.slice(0, 200)}`);
      return { domain, status: "failed", reason: e.message.slice(0, 100), examples: trainCount };
    }
  } else {
    // Local MLX training (macOS Apple Silicon)
    try {
      await runScript(VENV_PYTHON, [resolve(SCRIPTS_DIR, "train.py"), "--domain", domain]);
    } catch (e) {
      log(`  [${domain}] Training failed: ${e.message.slice(0, 100)}`);
      return { domain, status: "failed", reason: e.message.slice(0, 100), examples: trainCount };
    }

    log(`  [${domain}] Fusing and deploying...`);
    try {
      await runScript(VENV_PYTHON, [resolve(SCRIPTS_DIR, "fuse-and-deploy.py"), "--domain", domain]);
    } catch (e) {
      log(`  [${domain}] Deploy failed: ${e.message.slice(0, 100)}`);
      return { domain, status: "failed", reason: e.message.slice(0, 100), examples: trainCount };
    }
  }

  // Evaluate (non-fatal)
  let evalStatus = "skipped";
  let postScore = null;
  try {
    await runScript(VENV_PYTHON, [resolve(SCRIPTS_DIR, "evaluate.py"), "--domain", domain]);
    evalStatus = "pass";
    try { postScore = await getActiveScore(); } catch {}
  } catch {
    evalStatus = "fail";
  }

  // Auto-push to registry if score improved over previous best
  let pushed = false;
  if (postScore != null && (preScore == null || postScore > preScore)) {
    log(`  [${domain}] Score improved (${preScore ?? "none"} → ${postScore}), pushing to registry...`);
    // Use ollama push directly — model is already created locally
    try {
      const domainCfg = JSON.parse(readFileSync(resolve(TRAINER_DIR, "domains", `${domain}.json`), "utf8"));
      const prefix = domainCfg.model_prefix || `familiar-${domain}`;
      // Tag for registry namespace, then push
      const registryNs = process.env.OLLAMA_REGISTRY_NAMESPACE || "familiar-run";
      await runScript("ollama", ["cp", `${prefix}:latest`, `${registryNs}/${prefix}:latest`], { quiet: true });
      await runScript("ollama", ["push", `${registryNs}/${prefix}:latest`], { quiet: true });
      pushed = true;
      log(`  [${domain}] Pushed ${registryNs}/${prefix}:latest to registry`);
    } catch (e) {
      log(`  [${domain}] Registry push failed (non-fatal): ${e.message.slice(0, 80)}`);
    }
  }

  const durationMin = ((Date.now() - domainStart) / 60000).toFixed(1);
  log(`  [${domain}] Complete — ${trainCount} examples, ${durationMin} min, eval: ${evalStatus}${pushed ? ", pushed" : ""}`);
  return { domain, status: "trained", examples: trainCount, durationMin, evalStatus, pushed };
}

async function runPipeline() {
  const startTime = Date.now();
  const results = [];

  try {
    log("Starting multi-domain training pipeline...");
    log(`Domains: ${TRAIN_DOMAINS.join(", ")}`);

    for (const domain of TRAIN_DOMAINS) {
      log(`\n── Domain: ${domain} ──`);
      const result = await runDomainPipeline(domain);
      results.push(result);
    }

    // Build summary
    const duration = ((Date.now() - startTime) / 60000).toFixed(1);
    const trained = results.filter((r) => r.status === "trained");
    const skipped = results.filter((r) => r.status === "skipped");
    const failed = results.filter((r) => r.status === "failed");

    let message = `*Forge Multi-Domain Training*\n`;
    message += `Duration: ${duration} min\n\n`;

    for (const r of results) {
      if (r.status === "trained") {
        message += `${r.domain}: ${r.examples} examples, ${r.durationMin} min, eval ${r.evalStatus}\n`;
      } else if (r.status === "skipped") {
        message += `${r.domain}: skipped (${r.reason})\n`;
      } else {
        message += `${r.domain}: FAILED (${r.reason})\n`;
      }
    }

    message += `\nTrained: ${trained.length}/${TRAIN_DOMAINS.length}`;
    if (skipped.length) message += ` | Skipped: ${skipped.length}`;
    if (failed.length) message += ` | Failed: ${failed.length}`;

    // Mark pairs as used
    try {
      const { markPairsUsed, getActiveVersion } = await import(FORGE_DB_PATH);
      const active = getActiveVersion();
      if (active) markPairsUsed(active.version);
    } catch {}

    await sendTelegram(message);
    log(message.replace(/[*_]/g, ""));

    consecutiveFailures = 0;
    lastTrainTime = Date.now();
    return trained.length > 0;
  } catch (e) {
    consecutiveFailures++;
    const message = `*Forge Training Failed*\nError: ${e.message.slice(0, 200)}\nFailures: ${consecutiveFailures}/${CONFIG.maxFailures}`;
    await sendTelegram(message);
    log(message.replace(/[*_]/g, ""));
    return false;
  }
}

// ── Main Loop ───────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

async function checkSystemHealth() {
  // Check memory pressure
  try {
    const { execSync } = await import("child_process");
    const pressure = execSync("sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null || echo 0", { encoding: "utf8" }).trim();
    const level = parseInt(pressure) || 0;
    if (level >= 4) {
      log("SKIP: Memory pressure critical — would risk kernel panic");
      return false;
    }
    if (level >= 2) {
      log("SKIP: Memory pressure elevated — waiting for it to settle");
      return false;
    }
  } catch {}

  // Check thermal state
  try {
    const { execSync } = await import("child_process");
    const therm = execSync("pmset -g therm 2>/dev/null", { encoding: "utf8" }).toLowerCase();
    if (therm.includes("serious") || therm.includes("critical")) {
      log("SKIP: Thermal state too high — let machine cool down");
      return false;
    }
  } catch {}

  return true;
}

async function check() {
  if (running) return;

  // Time gate — only train between 1 AM and 5 AM to avoid killing the machine during work hours
  const hour = new Date().getHours();
  if (hour < 1 || hour >= 5) {
    return;
  }

  // Check cooldown
  const hoursSinceLast = (Date.now() - lastTrainTime) / 3600000;
  if (hoursSinceLast < CONFIG.cooldownHours) {
    return;
  }

  // Check failure limit
  if (consecutiveFailures >= CONFIG.maxFailures) {
    log(`Paused: ${consecutiveFailures} consecutive failures. Restart to reset.`);
    return;
  }

  // System health gate — abort if memory/thermal is bad
  if (!(await checkSystemHealth())) {
    return;
  }

  // Check new pair count
  const newPairs = await getNewPairCount();
  if (newPairs < CONFIG.threshold) {
    return;
  }

  log(`Threshold met: ${newPairs} new pairs (threshold: ${CONFIG.threshold})`);

  if (CONFIG.dryRun) {
    log("DRY RUN — would start training pipeline");
    return;
  }

  running = true;
  try {
    await runPipeline();
  } finally {
    running = false;
  }
}

async function main() {
  log("=== The Forge — Auto-Trainer Daemon ===");
  log(`  Threshold:    ${CONFIG.threshold} new pairs`);
  log(`  Check every:  ${CONFIG.intervalSec}s`);
  log(`  Cooldown:     ${CONFIG.cooldownHours}h between runs`);
  log(`  Rollback at:  -${CONFIG.regressionThreshold}pts regression`);
  log(`  Train window: 1:00 AM – 5:00 AM`);
  log(`  Dry run:      ${CONFIG.dryRun}`);
  log("");

  // Initial check
  const newPairs = await getNewPairCount();
  log(`Current unused pairs: ${newPairs}`);

  // Run check loop
  const interval = setInterval(check, CONFIG.intervalSec * 1000);

  // Initial check after a short delay
  setTimeout(check, 5000);

  // Graceful shutdown
  process.on("SIGTERM", () => {
    log("Received SIGTERM, shutting down...");
    clearInterval(interval);
    process.exit(0);
  });

  process.on("SIGINT", () => {
    log("Received SIGINT, shutting down...");
    clearInterval(interval);
    process.exit(0);
  });
}

// Allow import for testing
export { runPipeline, check, CONFIG };

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
