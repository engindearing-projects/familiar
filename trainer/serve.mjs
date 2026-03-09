#!/usr/bin/env bun

// The Forge — Model Serving API
// Authenticated proxy to Ollama for external access.
// Lets select devs hit your trained model over the network.
//
// Usage:
//   bun trainer/serve.mjs                          # default port 18793
//   bun trainer/serve.mjs --port 8080              # custom port
//   FORGE_API_KEYS=key1,key2 bun trainer/serve.mjs # set API keys
//
// Auth: Bearer token in Authorization header (matches FORGE_API_KEYS env var)
// OpenAI-compatible: POST /v1/chat/completions

import { existsSync, readFileSync, appendFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { getActiveDomain, loadDomain, getOllamaUrl } from "./domain-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = resolve(__dirname, "logs");

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

// ── CLI args ──────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "18793" },
    host: { type: "string", default: "0.0.0.0" },
  },
  strict: false,
});

const PORT = parseInt(args.port) || 18793;
const HOST = args.host || "0.0.0.0";

// ── API Key Auth ──────────────────────────────────────────────────────────

function loadApiKeys() {
  // From environment
  const envKeys = process.env.FORGE_API_KEYS;
  if (envKeys) {
    return new Set(envKeys.split(",").map((k) => k.trim()).filter(Boolean));
  }

  // From file
  const keyFile = resolve(__dirname, "api-keys.txt");
  if (existsSync(keyFile)) {
    const lines = readFileSync(keyFile, "utf8").split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    return new Set(lines);
  }

  return new Set();
}

const API_KEYS = loadApiKeys();
const AUTH_REQUIRED = API_KEYS.size > 0;

function checkAuth(req) {
  if (!AUTH_REQUIRED) return true;

  const auth = req.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) {
    return API_KEYS.has(auth.slice(7));
  }
  // Also check x-api-key header
  const apiKey = req.headers.get("x-api-key") || "";
  return API_KEYS.has(apiKey);
}

// ── Rate Limiting ─────────────────────────────────────────────────────────

const rateLimiter = new Map(); // key -> { count, resetAt }
const RATE_LIMIT = 60; // requests per minute
const RATE_WINDOW = 60_000; // 1 minute

function checkRateLimit(key) {
  const now = Date.now();
  let entry = rateLimiter.get(key);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW };
    rateLimiter.set(key, entry);
  }

  entry.count++;
  return entry.count <= RATE_LIMIT;
}

// ── Usage Tracking ────────────────────────────────────────────────────────

function logUsage(req, domain, model, durationMs, promptLength, responseLength) {
  const date = new Date().toISOString().slice(0, 10);
  const logFile = resolve(LOG_DIR, `serve-${date}.jsonl`);
  const entry = {
    timestamp: new Date().toISOString(),
    ip: req.headers.get("x-forwarded-for") || "unknown",
    domain: domain,
    model: model,
    duration_ms: durationMs,
    prompt_length: promptLength,
    response_length: responseLength,
  };
  appendFileSync(logFile, JSON.stringify(entry) + "\n");
}

// ── Ollama Proxy ──────────────────────────────────────────────────────────

async function proxyToOllama(messages, model, options = {}, ollamaUrl = "http://localhost:11434") {
  const resp = await fetch(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: {
        temperature: options.temperature,
        top_p: options.top_p,
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    throw new Error(`Ollama returned ${resp.status}: ${await resp.text()}`);
  }

  return resp.json();
}

// ── HTTP Server ───────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  hostname: HOST,

  async fetch(req) {
    const url = new URL(req.url);

    // CORS
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
        },
      });
    }

    const corsHeaders = { "Access-Control-Allow-Origin": "*" };

    // Health check (no auth required)
    if (url.pathname === "/health") {
      const domain = getActiveDomain();
      const ollamaUrl = getOllamaUrl(domain);
      return Response.json({
        status: "ok",
        domain: domain.id,
        model: `${domain.model_prefix}:latest`,
        ollama_url: ollamaUrl,
        remote_gpu: domain.remote?.gpu || null,
        auth_required: AUTH_REQUIRED,
        uptime: Math.round(process.uptime()),
      }, { headers: corsHeaders });
    }

    // List available domains (no auth required)
    if (url.pathname === "/v1/domains") {
      const { listDomains } = await import("./domain-config.mjs");
      return Response.json({ domains: listDomains() }, { headers: corsHeaders });
    }

    // Auth check for all other routes
    if (!checkAuth(req)) {
      return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    // Rate limit
    const clientKey = req.headers.get("authorization") || req.headers.get("x-api-key") || "anon";
    if (!checkRateLimit(clientKey)) {
      return Response.json({ error: "Rate limit exceeded" }, { status: 429, headers: corsHeaders });
    }

    // OpenAI-compatible chat completions
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      try {
        const body = await req.json();
        const messages = body.messages || [];

        // Determine domain — from request body or active domain
        let domain;
        if (body.domain) {
          domain = loadDomain(body.domain);
        } else {
          domain = getActiveDomain();
        }

        // Use requested model or domain default
        const model = body.model || `${domain.model_prefix}:latest`;

        // Inject system prompt if not already present
        if (!messages.some((m) => m.role === "system")) {
          messages.unshift({ role: "system", content: domain.system_prompt });
        }

        // Resolve Ollama endpoint — remote GPU if domain config specifies one
        const ollamaUrl = getOllamaUrl(domain);

        const start = Date.now();
        const result = await proxyToOllama(messages, model, {
          temperature: body.temperature ?? domain.ollama?.temperature,
          top_p: body.top_p ?? domain.ollama?.top_p,
        }, ollamaUrl);
        const durationMs = Date.now() - start;

        const responseContent = result.message?.content || "";

        // Log usage
        const promptText = messages.map((m) => m.content).join(" ");
        logUsage(req, domain.id, model, durationMs, promptText.length, responseContent.length);

        // Return OpenAI-compatible format
        return Response.json({
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: model,
          domain: domain.id,
          choices: [{
            index: 0,
            message: { role: "assistant", content: responseContent },
            finish_reason: "stop",
          }],
          usage: {
            prompt_tokens: result.prompt_eval_count || 0,
            completion_tokens: result.eval_count || 0,
            total_tokens: (result.prompt_eval_count || 0) + (result.eval_count || 0),
          },
        }, { headers: corsHeaders });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
      }
    }

    // List available models
    if (url.pathname === "/v1/models") {
      try {
        const ollamaUrl = getOllamaUrl(getActiveDomain());
        const resp = await fetch(`${ollamaUrl}/api/tags`);
        const data = await resp.json();
        const models = (data.models || []).map((m) => ({
          id: m.name,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "forge",
        }));
        return Response.json({ object: "list", data: models }, { headers: corsHeaders });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
  },
});

const _activeDomain = getActiveDomain();
const _ollamaUrl = getOllamaUrl(_activeDomain);
console.log(`\n  The Forge — Serving API`);
console.log(`  Listening:  http://${HOST}:${PORT}`);
console.log(`  Auth:       ${AUTH_REQUIRED ? `required (${API_KEYS.size} keys loaded)` : "disabled (set FORGE_API_KEYS or create api-keys.txt)"}`);
console.log(`  Domain:     ${_activeDomain.name} (${_activeDomain.id})`);
console.log(`  Model:      ${_activeDomain.model_prefix}:latest`);
console.log(`  Ollama:     ${_ollamaUrl}${_activeDomain.remote?.gpu ? ` (${_activeDomain.remote.gpu})` : ""}`);
console.log(`  Endpoints:`);
console.log(`    GET  /health               — status check`);
console.log(`    GET  /v1/domains           — list available domains`);
console.log(`    GET  /v1/models            — list Ollama models`);
console.log(`    POST /v1/chat/completions  — OpenAI-compatible chat`);
console.log(`\n  Compatible with any OpenAI SDK — just point base_url here.\n`);
