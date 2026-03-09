#!/usr/bin/env bun

// Familiar Monitor — Live terminal dashboard for dev observability.
// Shows file activity, service health, inter-service comms, and hands status.
// Usage: bun services/monitor.mjs

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(__dirname, "..");

// ── Load env ────────────────────────────────────────────────────────────────

function loadEnv() {
  try {
    const raw = readFileSync(resolve(PROJECT_DIR, "config", ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.+)/);
      if (m) process.env[m[1]] = process.env[m[1]] || m[2].trim();
    }
  } catch {}
}
loadEnv();

const GATEWAY_URL = process.env.GATEWAY_URL || "ws://localhost:18789";
const GATEWAY_TOKEN = process.env.FAMILIAR_GATEWAY_TOKEN || process.env.COZYTERM_GATEWAY_TOKEN || "";
const ACTIVITY_URL = process.env.ACTIVITY_URL || "http://localhost:18790";
const PROXY_URL = process.env.PROXY_URL || "http://127.0.0.1:18791";

// ── ANSI helpers ────────────────────────────────────────────────────────────

const CSI = "\x1b[";
const c = {
  reset: `${CSI}0m`,  bold: `${CSI}1m`,  dim: `${CSI}2m`,  italic: `${CSI}3m`,
  red: `${CSI}31m`,    green: `${CSI}32m`, yellow: `${CSI}33m`,
  blue: `${CSI}34m`,   magenta: `${CSI}35m`, cyan: `${CSI}36m`,
  white: `${CSI}37m`,  gray: `${CSI}90m`,
  bgGray: `${CSI}48;5;236m`, bgDark: `${CSI}48;5;234m`,
};

function hideCursor() { process.stdout.write(`${CSI}?25l`); }
function showCursor() { process.stdout.write(`${CSI}?25h`); }

// ── Dashboard State ─────────────────────────────────────────────────────────

let health = null;
let hands = [];
let liveEvents = [];
let fileOps = [];              // Claude Code file operations from PostToolUse hook
let fileStats = { read: 0, write: 0, edit: 0, glob: 0, grep: 0, bash: 0, agent: 0 };
let forgeStats = null;
let cronJobs = [];
let proxyStats = { sessions: {}, events: [] };
let serviceHealth = {};        // launchd service pids + status
let interServiceLog = [];      // inter-service communication log
let wsConnected = false;
let lastRefresh = null;
let reqId = 1;
const pendingCallbacks = new Map();

const MAX_EVENTS = 20;
const MAX_FILE_OPS = 25;
const MAX_IPC_LOG = 15;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinIdx = 0;

// ── Familiar services to monitor ────────────────────────────────────────────

const SERVICES = [
  { id: "com.familiar.gateway",        label: "gateway",       port: 18789, desc: "WS hub" },
  { id: "com.familiar.claude-proxy",   label: "claude-proxy",  port: 18791, desc: "LLM proxy" },
  { id: "com.familiar.tunnel",         label: "tunnel",        port: null,  desc: "CF tunnel" },
  { id: "com.familiar.ollama-proxy",   label: "ollama-proxy",  port: 11435, desc: "Ollama proxy" },
  { id: "com.familiar.activity-sync",  label: "activity",      port: 18790, desc: "Activity log" },
  { id: "com.familiar.telegram-bridge",label: "telegram",      port: null,  desc: "Telegram bot" },
  { id: "com.familiar.forge-auto",     label: "forge-auto",    port: null,  desc: "Auto-trainer" },
  { id: "com.familiar.forge-mine",     label: "forge-mine",    port: null,  desc: "Ground truth" },
  { id: "com.familiar.learner",        label: "learner",       port: null,  desc: "Daily learning" },
  { id: "com.familiar.telegram-push",  label: "tg-push",       port: null,  desc: "Push notifier" },
  { id: "com.familiar.caffeinate",     label: "caffeinate",    port: null,  desc: "Prevent sleep" },
];

// ── Time formatting ─────────────────────────────────────────────────────────

function timeAgo(ts) {
  if (!ts) return "never";
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 0) return "now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m a`;
  return `${Math.floor(h / 24)}d ago`;
}

function timeAgoShort(ts) {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 0) return "now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

function fmtUptime(secs) {
  if (!secs) return "-";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function pad(str, len, right = false) {
  const s = String(str).slice(0, len);
  return right ? s.padStart(len) : s.padEnd(len);
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function nowTime() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ── Tool icons and labels ───────────────────────────────────────────────────

function toolIcon(tool) {
  switch (tool) {
    case "read":   return `${c.blue}R${c.reset}`;
    case "write":  return `${c.green}W${c.reset}`;
    case "edit":   return `${c.yellow}E${c.reset}`;
    case "glob":   return `${c.magenta}G${c.reset}`;
    case "grep":   return `${c.magenta}?${c.reset}`;
    case "bash":   return `${c.cyan}$${c.reset}`;
    case "agent":  return `${c.cyan}@${c.reset}`;
    case "delete": return `${c.red}D${c.reset}`;
    default:       return `${c.gray}.${c.reset}`;
  }
}

function toolLabel(tool) {
  switch (tool) {
    case "read":   return `${c.blue}read${c.reset}`;
    case "write":  return `${c.green}write${c.reset}`;
    case "edit":   return `${c.yellow}edit${c.reset}`;
    case "glob":   return `${c.magenta}glob${c.reset}`;
    case "grep":   return `${c.magenta}grep${c.reset}`;
    case "bash":   return `${c.cyan}bash${c.reset}`;
    case "agent":  return `${c.cyan}agent${c.reset}`;
    default:       return `${c.gray}${tool}${c.reset}`;
  }
}

// ── Gateway WebSocket ───────────────────────────────────────────────────────

let ws = null;

function send(method, params = {}) {
  return new Promise((res, rej) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return rej(new Error("disconnected"));
    const id = `m${reqId++}`;
    pendingCallbacks.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
    setTimeout(() => { if (pendingCallbacks.has(id)) { pendingCallbacks.delete(id); rej(new Error("timeout")); } }, 10000);
  });
}

function connectGateway() {
  try { ws = new WebSocket(GATEWAY_URL); } catch {
    wsConnected = false;
    setTimeout(connectGateway, 5000);
    return;
  }

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    // Auth handshake
    if (msg.type === "event" && msg.event === "connect.challenge") {
      ws.send(JSON.stringify({
        type: "req", id: `m${reqId++}`, method: "connect",
        params: { client: { id: "familiar-ui", version: "monitor-3.0" }, auth: { token: GATEWAY_TOKEN } },
      }));
      return;
    }

    // Responses
    if (msg.type === "res") {
      if (msg.ok && msg.payload?.server) { wsConnected = true; refreshData(); }
      const cb = pendingCallbacks.get(msg.id);
      if (cb) { pendingCallbacks.delete(msg.id); msg.ok ? cb.resolve(msg.payload) : cb.reject(new Error(msg.error?.message)); }
      return;
    }

    // Live events
    if (msg.type === "event") {
      // Claude Code file operations from PostToolUse hook
      if (msg.event === "claude.tool_use" && msg.payload) {
        const op = msg.payload;
        fileOps.unshift(op);
        if (fileOps.length > MAX_FILE_OPS) fileOps.length = MAX_FILE_OPS;
        // Update running totals
        const t = op.tool || "other";
        if (t in fileStats) fileStats[t]++;
        render();
        return;
      }

      // Track inter-service communication
      const ipc = extractIPC(msg);
      if (ipc) {
        interServiceLog.unshift(ipc);
        if (interServiceLog.length > MAX_IPC_LOG) interServiceLog.length = MAX_IPC_LOG;
      }

      // Dashboard events
      const evt = formatEvent(msg);
      if (evt) {
        liveEvents.unshift(evt);
        if (liveEvents.length > MAX_EVENTS) liveEvents.length = MAX_EVENTS;
        render();
      }
    }
  };

  ws.onclose = () => { wsConnected = false; pendingCallbacks.clear(); setTimeout(connectGateway, 3000); };
  ws.onerror = () => { wsConnected = false; };
}

// ── Inter-service communication extraction ──────────────────────────────────

function extractIPC(msg) {
  const evt = msg.event || "";
  const p = msg.payload || {};
  const now = nowTime();

  // Proxy routing to backends (proxy → claude/ollama/forge)
  if (evt === "proxy.route") {
    return { time: now, from: "proxy", to: p.backend || "?", detail: `score=${(p.score ?? 0).toFixed(2)}`, color: c.cyan };
  }
  if (evt === "proxy.invoke") {
    return { time: now, from: "proxy", to: p.model || "claude", detail: `${((p.duration || 0) / 1000).toFixed(1)}s $${(p.cost || 0).toFixed(4)}`, color: c.green };
  }
  if (evt === "proxy.fallback") {
    return { time: now, from: p.from || "?", to: p.to || "?", detail: "fallback", color: c.yellow };
  }
  if (evt === "proxy.rag") {
    return { time: now, from: "proxy", to: "rag-db", detail: `${p.chunks || 0} chunks${p.graphBoosted ? " [graph]" : ""}`, color: c.magenta };
  }
  if (evt === "proxy.toolloop") {
    return { time: now, from: "proxy", to: "tools", detail: `${p.iterations}i ${p.toolCount}t`, color: c.blue };
  }
  if (evt === "proxy.forge") {
    return { time: now, from: "proxy", to: "forge", detail: `${p.kind} len=${p.promptLength || 0}`, color: c.yellow };
  }

  // Hand events (gateway → hand runner)
  if (evt.startsWith("hand.")) {
    const action = evt.slice(5);
    const name = p.name || p.hand || "?";
    return { time: now, from: "gateway", to: `hand:${name}`, detail: action, color: c.magenta };
  }

  // Forge/training pipeline
  if (evt.includes("forge") || evt.includes("pair")) {
    return { time: now, from: "forge", to: "trainer", detail: evt, color: c.yellow };
  }

  // Chat routing (client → gateway → agent)
  if (evt === "chat") {
    const state = p.state || "";
    if (state === "final") return { time: now, from: "agent", to: "gateway", detail: "response complete", color: c.green };
  }

  return null;
}

function formatEvent(msg) {
  const now = nowTime();
  const evt = msg.event || "?";
  if (evt === "connect.challenge") return null;

  if (evt.startsWith("agent.")) {
    const sub = evt.slice(6);
    const tool = msg.payload?.tool || msg.payload?.toolName || "";
    if (sub === "tool_call") return { time: now, cat: "agent", icon: ">>", text: `tool: ${tool}`, color: c.yellow };
    if (sub === "status") return { time: now, cat: "agent", icon: "::", text: msg.payload?.status || sub, color: c.cyan };
    if (sub === "delta") return null;
    return { time: now, cat: "agent", icon: "--", text: sub, color: c.blue };
  }
  if (evt.startsWith("chat.")) {
    const sub = evt.slice(5);
    if (sub === "send") return { time: now, cat: "chat", icon: "->", text: `from ${msg.payload?.role || "?"}`, color: c.green };
    if (sub === "final") return { time: now, cat: "chat", icon: "ok", text: "response done", color: c.green };
    return { time: now, cat: "chat", icon: "..", text: `chat.${sub}`, color: c.green };
  }
  if (evt.startsWith("hand.")) {
    const name = msg.payload?.name || msg.payload?.hand || evt.slice(5);
    return { time: now, cat: "hand", icon: "##", text: name, color: c.magenta };
  }
  if (evt.includes("forge") || evt.includes("pair")) {
    return { time: now, cat: "forge", icon: "<>", text: evt, color: c.yellow };
  }
  if (evt.startsWith("proxy.")) {
    const p = msg.payload || {};
    const sub = evt.slice(6);
    if (sub === "route") return { time: now, cat: "proxy", icon: "~>", text: `route ${p.backend} score=${(p.score ?? 0).toFixed(2)}`, color: c.cyan };
    if (sub === "invoke") return { time: now, cat: "proxy", icon: "ok", text: `${p.model || "claude"} ${((p.duration || 0) / 1000).toFixed(1)}s $${(p.cost || 0).toFixed(4)}`, color: c.green };
    if (sub === "forge") return { time: now, cat: "proxy", icon: "<>", text: `forge.${p.kind}`, color: c.yellow };
    if (sub === "toolloop") return { time: now, cat: "proxy", icon: "[]", text: `toolloop ${p.iterations}i ${p.toolCount}t ${((p.duration || 0) / 1000).toFixed(1)}s`, color: c.blue };
    if (sub === "rag") return { time: now, cat: "proxy", icon: "**", text: `rag ${p.chunks}chunks`, color: c.magenta };
    if (sub === "fallback") return { time: now, cat: "proxy", icon: "!!", text: `${p.from} -> ${p.to}`, color: c.yellow };
    if (sub === "error") return { time: now, cat: "proxy", icon: "!!", text: `err: ${(p.message || "").slice(0, 40)}`, color: c.red };
    return null;
  }

  return { time: now, cat: "sys", icon: " .", text: evt, color: c.gray };
}

// ── Service Health (launchd) ────────────────────────────────────────────────

function checkServices() {
  try {
    const out = execSync("launchctl list 2>/dev/null", { encoding: "utf8", timeout: 3000 });
    const lines = out.split("\n");
    const newHealth = {};
    for (const svc of SERVICES) {
      const match = lines.find(l => l.includes(svc.id));
      if (match) {
        const parts = match.trim().split(/\s+/);
        const pid = parts[0] === "-" ? null : parseInt(parts[0]);
        const exitCode = parseInt(parts[1]) || 0;
        newHealth[svc.id] = { pid, exitCode, running: pid !== null && pid > 0 };
      } else {
        newHealth[svc.id] = { pid: null, exitCode: -1, running: false };
      }
    }
    serviceHealth = newHealth;
  } catch {
    // If launchctl fails, mark all unknown
    for (const svc of SERVICES) {
      if (!serviceHealth[svc.id]) serviceHealth[svc.id] = { pid: null, exitCode: -1, running: false };
    }
  }
}

// ── Proxy Stats ─────────────────────────────────────────────────────────────

async function fetchProxyStats() {
  try {
    const resp = await fetch(`${PROXY_URL}/proxy/events`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return;
    proxyStats = await resp.json();
  } catch {}
}

// ── Data Refresh ────────────────────────────────────────────────────────────

async function refreshData() {
  try {
    const [h, hm] = await Promise.all([
      send("health").catch(() => null),
      send("hand.metrics").catch(() => null),
    ]);
    if (h) health = h;
    if (hm) hands = hm.hands || hm || [];
    lastRefresh = new Date();
  } catch {}
  await Promise.all([fetchProxyStats(), fetchForgeStats(), fetchCronJobs()]);
  checkServices();
  render();
}

async function fetchForgeStats() {
  try {
    const out = execSync(
      `bun -e 'import{getForgeStats}from"${PROJECT_DIR}/trainer/forge-db.js";console.log(JSON.stringify(getForgeStats()))'`,
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }
    );
    forgeStats = JSON.parse(out.trim());
  } catch {}
}

async function fetchCronJobs() {
  try {
    const raw = readFileSync(resolve(PROJECT_DIR, "cron/jobs.json"), "utf8");
    const parsed = JSON.parse(raw);
    cronJobs = Array.isArray(parsed) ? parsed : Object.values(parsed);
  } catch {}
}

// ── Render ──────────────────────────────────────────────────────────────────

function statusIcon(status) {
  if (status === "active") return `${c.green}*${c.reset}`;
  if (status === "running") return `${c.cyan}${SPINNER[spinIdx % SPINNER.length]}${c.reset}`;
  if (status === "paused") return `${c.yellow}-${c.reset}`;
  if (status === "error") return `${c.red}x${c.reset}`;
  return `${c.gray}.${c.reset}`;
}

function render() {
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;
  const w = Math.min(cols - 2, 160);
  const spin = SPINNER[spinIdx % SPINNER.length];

  const buf = [];
  const ln = (s = "") => buf.push(s);

  // ═══════════════════════════════════════════════════════════════════════════
  // HEADER
  // ═══════════════════════════════════════════════════════════════════════════

  const conn = wsConnected ? `${c.green}*${c.reset}` : `${c.red}*${c.reset}`;
  const up = health ? fmtUptime(health.uptime) : "-";
  ln(`  ${c.bold}${c.cyan}FAMILIAR${c.reset} ${c.dim}Dev Monitor${c.reset}${" ".repeat(Math.max(1, w - 38))}${conn} ${c.dim}up ${up}${c.reset}`);
  ln(`  ${c.dim}${"─".repeat(w)}${c.reset}`);

  // ── System status line ──
  if (health) {
    const cl = health.claudeAvailable !== false ? `${c.green}*${c.reset}claude` : `${c.red}*${c.reset}claude`;
    const ol = health.ollamaAvailable ? `${c.green}*${c.reset}ollama` : `${c.red}*${c.reset}ollama`;
    const on = health.online ? `${c.green}*${c.reset}online` : `${c.yellow}*${c.reset}offline`;
    let sysLine = `  ${cl} ${ol} ${on} ${c.dim}sess:${c.reset}${health.activeSessions || 0} ${c.dim}clients:${c.reset}${health.connectedClients || 0}`;
    if (forgeStats) {
      const ver = forgeStats.activeVersion?.version || "?";
      const bench = forgeStats.activeVersion?.benchmark_score || "?";
      sysLine += `  ${c.dim}|${c.reset}  ${c.yellow}forge${c.reset} ${forgeStats.totalPairs}p ${c.dim}(${forgeStats.unusedPairs} new)${c.reset} ${c.dim}model:${c.reset}${ver} ${c.dim}bench:${c.reset}${bench}`;
    }
    ln(sysLine);
  } else {
    ln(`  ${c.dim}connecting...${c.reset}`);
  }

  // ── Cron + file ops summary line ──
  const cronLine = [];
  if (cronJobs.length > 0) {
    const enabled = cronJobs.filter(j => j.enabled !== false);
    const errJobs = enabled.filter(j => j.state?.lastStatus === "error");
    if (errJobs.length > 0) {
      const errNames = errJobs.map(j => (j.name || j.id || "?").slice(0, 12)).join(", ");
      cronLine.push(`${c.red}!${c.reset} cron: ${errJobs.length}/${enabled.length} failing ${c.red}${errNames}${c.reset}`);
    } else {
      cronLine.push(`${c.dim}cron: ${enabled.length} jobs ok${c.reset}`);
    }
  }
  // File operation totals
  const totalOps = Object.values(fileStats).reduce((a, b) => a + b, 0);
  if (totalOps > 0) {
    const parts = [];
    if (fileStats.read)  parts.push(`${c.blue}R${c.reset}:${fileStats.read}`);
    if (fileStats.write) parts.push(`${c.green}W${c.reset}:${fileStats.write}`);
    if (fileStats.edit)  parts.push(`${c.yellow}E${c.reset}:${fileStats.edit}`);
    if (fileStats.glob)  parts.push(`${c.magenta}G${c.reset}:${fileStats.glob}`);
    if (fileStats.grep)  parts.push(`${c.magenta}?${c.reset}:${fileStats.grep}`);
    if (fileStats.bash)  parts.push(`${c.cyan}$${c.reset}:${fileStats.bash}`);
    if (fileStats.agent) parts.push(`${c.cyan}@${c.reset}:${fileStats.agent}`);
    cronLine.push(`${c.dim}ops:${c.reset} ${parts.join(" ")} ${c.dim}(${totalOps} total)${c.reset}`);
  }
  if (cronLine.length > 0) ln(`  ${cronLine.join("  ${c.dim}|${c.reset}  ")}`);

  ln();

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN LAYOUT — Two rows of panels
  // ═══════════════════════════════════════════════════════════════════════════

  // Calculate available height: total rows - header (5-6 lines) - status bar (2 lines)
  const headerLines = buf.length;
  const availHeight = rows - headerLines - 2;
  const topHeight = Math.floor(availHeight * 0.55);
  const bottomHeight = availHeight - topHeight - 1; // -1 for separator

  // ── TOP ROW: File Activity (left, wide) | Events (right) ──
  const leftW = Math.floor(w * 0.55);
  const rightW = w - leftW - 3;

  // Build file activity column
  const fileLines = [];
  fileLines.push(`${c.bold}File Activity${c.reset} ${c.dim}(Claude Code tool use)${c.reset}`);
  if (fileOps.length === 0) {
    fileLines.push(`${c.dim}  waiting for tool use events...${c.reset}`);
  } else {
    for (const op of fileOps.slice(0, topHeight - 2)) {
      const icon = toolIcon(op.tool);
      let detail = "";
      if (op.path) {
        const parts = op.path.split("/");
        detail = parts.length > 2 ? parts.slice(-3).join("/") : op.path;
      } else if (op.pattern) {
        detail = `"${op.pattern}"`;
      } else if (op.cmd) {
        detail = `$ ${op.cmd}`;
      } else if (op.desc) {
        detail = op.desc;
      }
      const elapsed = op.ts ? `${c.dim}${timeAgoShort(op.ts)}${c.reset}` : "";
      const maxDetail = leftW - 10;
      fileLines.push(`  ${icon} ${pad(detail.slice(0, maxDetail), maxDetail)} ${elapsed}`);
    }
  }

  // Build events column
  const eventLines = [];
  eventLines.push(`${c.bold}Events${c.reset} ${c.dim}${spin}${c.reset}`);
  if (liveEvents.length === 0) {
    eventLines.push(`${c.dim}  listening...${c.reset}`);
  } else {
    for (const e of liveEvents.slice(0, topHeight - 2)) {
      const catTag = e.cat ? `${c.dim}${pad(e.cat, 6)}${c.reset}` : "";
      eventLines.push(`${c.dim}${e.time}${c.reset} ${e.color}${e.icon}${c.reset} ${catTag} ${e.color}${e.text.slice(0, rightW - 18)}${c.reset}`);
    }
  }

  // Merge top row columns
  const topMaxLines = Math.max(fileLines.length, eventLines.length, topHeight);
  for (let i = 0; i < Math.min(topMaxLines, topHeight); i++) {
    const left = fileLines[i] || "";
    const right = eventLines[i] || "";
    const leftPlain = stripAnsi(left);
    const gap = Math.max(2, leftW - leftPlain.length);
    ln(`  ${left}${" ".repeat(gap)}${c.dim}|${c.reset} ${right}`);
  }

  // ── Separator ──
  ln(`  ${c.dim}${"─".repeat(w)}${c.reset}`);

  // ── BOTTOM ROW: Hands + Services (left) | Inter-Service Comms (right) ──
  const bottomLeftW = Math.floor(w * 0.5);
  const bottomRightW = w - bottomLeftW - 3;

  // Build hands + services column
  const svcLines = [];
  svcLines.push(`${c.bold}Hands${c.reset}`);
  if (hands.length === 0) {
    svcLines.push(`${c.dim}  loading...${c.reset}`);
  } else {
    // Sort: running first, then active, then others
    const sorted = [...hands].sort((a, b) => {
      const order = { running: 0, active: 1, paused: 2, error: 3 };
      return (order[a.status] ?? 4) - (order[b.status] ?? 4);
    });
    for (const h of sorted) {
      const icon = statusIcon(h.status);
      const nm = pad(h.name, 14);
      const ago = pad(timeAgo(h.lastRun), 10);
      const runs = pad(String(h.runCount || 0), 3, true);
      svcLines.push(`  ${icon} ${c.bold}${nm}${c.reset} ${c.dim}${ago}${c.reset} ${runs}`);
    }
  }

  svcLines.push("");
  svcLines.push(`${c.bold}Services${c.reset} ${c.dim}(launchd)${c.reset}`);
  const runCount = Object.values(serviceHealth).filter(s => s.running).length;
  svcLines.push(`  ${c.dim}${runCount}/${SERVICES.length} running${c.reset}`);
  for (const svc of SERVICES) {
    const sh = serviceHealth[svc.id];
    if (!sh) continue;
    const icon = sh.running ? `${c.green}*${c.reset}` :
                 sh.exitCode === 0 ? `${c.yellow}-${c.reset}` : `${c.red}x${c.reset}`;
    const pid = sh.running ? `${c.dim}pid:${sh.pid}${c.reset}` : `${c.dim}down${c.reset}`;
    const portInfo = svc.port ? `${c.dim}:${svc.port}${c.reset}` : "";
    svcLines.push(`  ${icon} ${pad(svc.label, 13)} ${pid} ${portInfo}`);
  }

  // Build inter-service communication column
  const ipcLines = [];
  ipcLines.push(`${c.bold}Inter-Service${c.reset} ${c.dim}(comms)${c.reset}`);
  if (interServiceLog.length === 0) {
    ipcLines.push(`${c.dim}  no traffic yet...${c.reset}`);
  } else {
    for (const ipc of interServiceLog.slice(0, bottomHeight - 2)) {
      const arrow = `${ipc.color}${pad(ipc.from, 7)}${c.reset} ${c.dim}->${c.reset} ${ipc.color}${pad(ipc.to, 10)}${c.reset}`;
      ipcLines.push(`${c.dim}${ipc.time}${c.reset} ${arrow} ${c.dim}${ipc.detail.slice(0, bottomRightW - 28)}${c.reset}`);
    }
  }

  // Proxy sessions in the IPC column
  const sessions = proxyStats.sessions || {};
  const sessionKeys = Object.keys(sessions);
  if (sessionKeys.length > 0 && ipcLines.length < bottomHeight - 3) {
    ipcLines.push("");
    ipcLines.push(`${c.bold}Proxy Sessions${c.reset}`);
    for (const sk of sessionKeys.slice(-3)) {
      const s = sessions[sk];
      ipcLines.push(`  ${c.cyan}${pad(sk.slice(0, 12), 13)}${c.reset}${c.dim}req:${c.reset}${s.requests} ${c.dim}pairs:${c.reset}${s.pairs} ${c.dim}$${c.reset}${(s.cost || 0).toFixed(4)}`);
    }
  }

  // Merge bottom row columns
  const bottomMaxLines = Math.max(svcLines.length, ipcLines.length, bottomHeight);
  for (let i = 0; i < Math.min(bottomMaxLines, bottomHeight); i++) {
    const left = svcLines[i] || "";
    const right = ipcLines[i] || "";
    const leftPlain = stripAnsi(left);
    const gap = Math.max(2, bottomLeftW - leftPlain.length);
    ln(`  ${left}${" ".repeat(gap)}${c.dim}|${c.reset} ${right}`);
  }

  // Pad to fill screen
  while (buf.length < rows - 1) ln();

  // ── Status bar ──
  const refreshTime = lastRefresh ? lastRefresh.toLocaleTimeString("en-US", { hour12: false }) : "-";
  ln(`  ${c.dim}${refreshTime}  |  r=refresh  q=quit  ctrl-c=quit${c.reset}`);

  // Single write to prevent flicker
  process.stdout.write(`${CSI}H${CSI}2J${buf.join("\n")}\n`);
}

// ── Input handling ──────────────────────────────────────────────────────────

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (key) => {
    if (key === "\x03") { showCursor(); process.stdout.write(`${CSI}2J${CSI}H`); process.exit(0); }
    if (key === "q") { showCursor(); process.stdout.write(`${CSI}2J${CSI}H`); process.exit(0); }
    if (key === "r") refreshData();
    if (key === "c") { // Clear file op stats
      fileStats = { read: 0, write: 0, edit: 0, glob: 0, grep: 0, bash: 0, agent: 0 };
      fileOps = [];
      render();
    }
  });
}

process.on("SIGINT", () => { showCursor(); process.exit(0); });
process.on("SIGTERM", () => { showCursor(); process.exit(0); });

// ── Main ────────────────────────────────────────────────────────────────────

hideCursor();
render();
connectGateway();
checkServices();

// Data refresh every 15s
setInterval(() => { if (wsConnected) refreshData(); }, 15000);

// Service health check every 30s
setInterval(checkServices, 30000);

// Spinner tick every 1s
setInterval(() => { spinIdx++; render(); }, 1000);
