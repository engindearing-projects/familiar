#!/usr/bin/env bun

// Proxy Observability — fire-and-forget event emitter for the Claude Code proxy.
// Dual-sends each event to:
//   1. Activity server POST /activity (persisted, platform="proxy")
//   2. Gateway POST /internal/broadcast (real-time WS push to all clients)

const ACTIVITY_URL = process.env.ACTIVITY_URL || "http://localhost:18790";
const GATEWAY_URL = process.env.GATEWAY_HTTP_URL || "http://127.0.0.1:18789";

// ── Ring Buffer ──────────────────────────────────────────────────────────────

const MAX_EVENTS = 50;
const recentEvents = [];

// ── Per-Session Stats ────────────────────────────────────────────────────────

const sessionStats = new Map(); // sessionKey → { requests, pairs, comparisons, traces, cost, ragChunks }

function bumpStat(sessionKey, field, amount = 1) {
  if (!sessionKey) return;
  if (!sessionStats.has(sessionKey)) {
    sessionStats.set(sessionKey, { requests: 0, pairs: 0, comparisons: 0, traces: 0, cost: 0, ragChunks: 0 });
  }
  const s = sessionStats.get(sessionKey);
  s[field] = (s[field] || 0) + amount;
}

export function getSessionStats(key) {
  return sessionStats.get(key) || null;
}

export function getAllSessionStats() {
  const out = {};
  for (const [k, v] of sessionStats) out[k] = v;
  return out;
}

export function getRecentEvents() {
  return recentEvents;
}

// ── Emit ─────────────────────────────────────────────────────────────────────

export function emitProxyEvent(type, payload = {}) {
  const event = {
    type,
    ts: new Date().toISOString(),
    sessionKey: payload.sessionKey || "unknown",
    requestId: payload.requestId || "",
    ...payload,
  };

  // Push to ring buffer
  recentEvents.unshift(event);
  if (recentEvents.length > MAX_EVENTS) recentEvents.length = MAX_EVENTS;

  // Update session stats based on event type
  if (type === "request") bumpStat(event.sessionKey, "requests");
  if (type === "forge" && payload.kind === "pair") bumpStat(event.sessionKey, "pairs");
  if (type === "forge" && payload.kind === "comparison") bumpStat(event.sessionKey, "comparisons");
  if (type === "forge" && payload.kind === "trace") bumpStat(event.sessionKey, "traces");
  if (type === "invoke" && payload.cost) bumpStat(event.sessionKey, "cost", payload.cost);
  if (type === "rag") bumpStat(event.sessionKey, "ragChunks", payload.chunks || 0);

  // Fire-and-forget: send to activity server
  fetch(`${ACTIVITY_URL}/activity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      platform: "proxy",
      role: "system",
      content: `proxy.${type}: ${summarize(type, payload)}`,
      metadata: event,
    }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});

  // Fire-and-forget: broadcast via gateway
  fetch(`${GATEWAY_URL}/internal/broadcast`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: `proxy.${type}`, payload: event }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

// ── Summary text for activity log ────────────────────────────────────────────

function summarize(type, p) {
  switch (type) {
    case "request": return `msgs=${p.msgCount || 0} stream=${!!p.stream}`;
    case "route": return `→${p.backend} ${p.role || ""} score=${p.score ?? ""}`;
    case "session": return `${p.action || ""} ${p.sessionId?.slice(0, 8) || ""}`;
    case "invoke": return `${p.model || "claude"} ${((p.duration || 0) / 1000).toFixed(1)}s $${(p.cost || 0).toFixed(4)}`;
    case "toolloop": return `${p.iterations}iter ${p.toolCount}tools ${((p.duration || 0) / 1000).toFixed(1)}s ${p.finishReason || ""}`;
    case "forge": return `${p.kind} len=${p.promptLength || 0}`;
    case "fallback": return `${p.from}→${p.to} ${p.reason || ""}`;
    case "rag": return `${p.chunks}chunks${p.graphBoosted ? " [graph]" : ""}`;
    case "error": return p.message || "unknown";
    default: return JSON.stringify(p).slice(0, 80);
  }
}
