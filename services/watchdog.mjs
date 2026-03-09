#!/usr/bin/env bun
// Familiar Watchdog — self-healing service monitor
//
// Checks all com.familiar.* services, restarts crashed ones,
// hits health endpoints, and logs status. Designed to run as
// a launchd interval service (every 5 minutes).

import { execSync } from "child_process";
const DOMAIN_TARGET = `gui/${process.getuid()}`;

function log(msg) {
  const ts = new Date().toISOString();
  const line = `${ts} ${msg}`;
  // stdout goes to the same log file via launchd — only write once
  console.log(line);
}

function exec(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 10_000 }).trim();
  } catch (e) {
    return e.stderr || e.message || "";
  }
}

// Services that should always be running (KeepAlive=true)
const KEEP_ALIVE_SERVICES = [
  "com.familiar.gateway",
  "com.familiar.claude-proxy",
  "com.familiar.ollama-proxy",
  "com.familiar.activity-sync",
  "com.familiar.tunnel",
  "com.familiar.telegram-bridge",
  "com.familiar.hands-scheduler",
  "com.familiar.caffeinate",
];

// Services that run on a schedule (don't force-restart)
const SCHEDULED_SERVICES = [
  "com.familiar.telegram-push",
];

// Health endpoints to probe (only services with a /health route)
const HEALTH_ENDPOINTS = {
  "com.familiar.claude-proxy": "http://127.0.0.1:18791/health",
  "com.familiar.gateway": "http://127.0.0.1:18789/health",
  "com.familiar.activity-sync": "http://127.0.0.1:18790/health",
};

function getServiceStatus() {
  const raw = exec("launchctl list 2>/dev/null");
  const services = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\S+)\s+(\S+)\s+(com\.familiar\.\S+)/);
    if (match) {
      services[match[3]] = {
        pid: match[1] === "-" ? null : parseInt(match[1]),
        exitCode: parseInt(match[2]),
      };
    }
  }
  return services;
}

async function checkHealth(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

function restartService(label) {
  log(`[RESTART] ${label} — attempting kickstart`);
  // kickstart forces a restart even if the service is in a throttled state
  const result = exec(`launchctl kickstart -k ${DOMAIN_TARGET}/${label} 2>&1`);
  if (result) log(`  result: ${result}`);
}

async function run() {
  log("[watchdog] health check starting");
  const statuses = getServiceStatus();
  let problems = 0;
  let restarts = 0;

  // Check keep-alive services
  for (const svc of KEEP_ALIVE_SERVICES) {
    const s = statuses[svc];
    if (!s) {
      log(`[MISSING] ${svc} — not registered with launchd`);
      problems++;
      continue;
    }

    if (!s.pid) {
      log(`[DOWN] ${svc} — no PID, last exit ${s.exitCode}`);
      restartService(svc);
      problems++;
      restarts++;
      continue;
    }

    // Service has a PID — check if it's actually responding
    const healthUrl = HEALTH_ENDPOINTS[svc];
    if (healthUrl) {
      const h = await checkHealth(healthUrl);
      if (!h.ok) {
        log(`[UNHEALTHY] ${svc} (PID ${s.pid}) — ${healthUrl} returned ${h.status}${h.error ? ` (${h.error})` : ""}`);
        restartService(svc);
        problems++;
        restarts++;
        continue;
      }
    }

    // Check for bad exit codes from previous crash
    if (s.exitCode !== 0 && s.exitCode !== -15) {
      log(`[WARN] ${svc} (PID ${s.pid}) — running but last exit was ${s.exitCode}`);
    }
  }

  // Check scheduled services (just log, don't restart)
  for (const svc of SCHEDULED_SERVICES) {
    const s = statuses[svc];
    if (!s) {
      log(`[MISSING] ${svc} — not registered with launchd`);
      problems++;
    } else if (s.exitCode !== 0 && !s.pid) {
      log(`[WARN] ${svc} — last run exited ${s.exitCode} (scheduled, not restarting)`);
      problems++;
    }
  }

  if (problems === 0) {
    log(`[watchdog] all services healthy`);
  } else {
    log(`[watchdog] ${problems} problem(s) found, ${restarts} restart(s) attempted`);
  }
}

run().catch((e) => {
  log(`[watchdog] fatal: ${e.message}`);
  process.exit(1);
});
