#!/usr/bin/env bun

// Ollama Capture Proxy — transparent proxy that forwards requests to Ollama
// and captures prompt/response pairs for the Forge training pipeline.
//
// Sits between OpenCode (or any client) and Ollama:
//   Client → :11435 (proxy) → :11434 (Ollama)
//
// Captured pairs are written to trainer/data/raw/ as JSONL (same format as collector.mjs).
//
// Usage:
//   bun scripts/ollama-proxy.mjs
//   OLLAMA_PROXY_PORT=11435 bun scripts/ollama-proxy.mjs

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, appendFileSync } from "fs";
import { randomUUID, createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROXY_PORT = parseInt(process.env.OLLAMA_PROXY_PORT || "11435", 10);
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const RAW_DIR = resolve(__dirname, "..", "trainer", "data", "raw");

if (!existsSync(RAW_DIR)) {
  mkdirSync(RAW_DIR, { recursive: true });
}

function hashPrompt(prompt) {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

function todayFile() {
  const date = new Date().toISOString().slice(0, 10);
  return resolve(RAW_DIR, `opencode-${date}.jsonl`);
}

// Extract the user prompt from various Ollama API formats
function extractPrompt(body) {
  // /v1/chat/completions format (OpenAI-compatible, used by OpenCode)
  if (body.messages) {
    const userMsgs = body.messages.filter((m) => m.role === "user");
    return userMsgs.length > 0 ? userMsgs[userMsgs.length - 1].content : null;
  }
  // /api/chat format
  if (body.prompt) return body.prompt;
  return null;
}

// Extract the response text from various Ollama API response formats
function extractResponse(data) {
  // /v1/chat/completions format
  if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
  // /api/chat format
  if (data.message?.content) return data.message.content;
  // /api/generate format
  if (data.response) return data.response;
  return null;
}

// Paths worth capturing (chat completions and chat endpoints)
const CAPTURE_PATHS = new Set([
  "/v1/chat/completions",
  "/api/chat",
  "/api/generate",
]);

let pairsToday = 0;

const server = Bun.serve({
  port: PROXY_PORT,
  hostname: "127.0.0.1",

  async fetch(req) {
    const url = new URL(req.url);
    const targetUrl = `${OLLAMA_URL}${url.pathname}${url.search}`;

    // Non-POST or non-capture paths: just proxy through
    if (req.method !== "POST" || !CAPTURE_PATHS.has(url.pathname)) {
      try {
        const resp = await fetch(targetUrl, {
          method: req.method,
          headers: req.headers,
          body: req.method !== "GET" && req.method !== "HEAD" ? await req.blob() : undefined,
          signal: AbortSignal.timeout(180_000),
        });
        return new Response(resp.body, {
          status: resp.status,
          headers: resp.headers,
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 502 });
      }
    }

    // Capture path: read body, forward, capture pair
    const start = Date.now();
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
    }

    const prompt = extractPrompt(body);
    const model = body.model || "unknown";

    try {
      const resp = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });

      const responseData = await resp.json();
      const responseText = extractResponse(responseData);
      const durationMs = Date.now() - start;

      // Write the pair to Forge pipeline (non-blocking)
      if (prompt && responseText && responseText.length > 20) {
        try {
          const pair = {
            id: `opencode_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
            timestamp: new Date().toISOString(),
            prompt,
            prompt_hash: hashPrompt(prompt),
            source: "opencode-proxy",
            primary_model: model,
            local_response: responseText,
            local_duration_ms: durationMs,
            local_model: model,
          };
          appendFileSync(todayFile(), JSON.stringify(pair) + "\n");
          pairsToday++;
          if (pairsToday % 10 === 1) {
            console.log(`[proxy] Captured pair #${pairsToday}: model=${model} prompt=${prompt.slice(0, 60)}...`);
          }
        } catch (writeErr) {
          console.error("[proxy] Write error:", writeErr.message);
        }
      }

      return Response.json(responseData, { status: resp.status });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 502 });
    }
  },
});

console.log(`Ollama Capture Proxy v1.0`);
console.log(`  listening: 127.0.0.1:${PROXY_PORT}`);
console.log(`  upstream:  ${OLLAMA_URL}`);
console.log(`  output:    ${RAW_DIR}/opencode-*.jsonl`);
console.log("");
console.log("Proxied paths: /v1/chat/completions, /api/chat, /api/generate");
console.log("All other requests forwarded transparently.");
console.log("");
