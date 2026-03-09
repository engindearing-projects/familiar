#!/usr/bin/env bun

// Familiar-Coder Agentic Tool Loop
// Parses <tool_call> blocks from model output, executes tools, feeds results
// back, and repeats until the model gives a final answer or hits limits.
//
// Trace collection: successful runs get saved to trainer/data/traces/ in the
// same format as the existing tool-collector.mjs for Forge training.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { getToolSchemaText, executeTool } from "./tools.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(__dirname, "..");
const TRACES_DIR = resolve(PROJECT_DIR, "trainer", "data", "traces");

// ── SOUL.md Identity Cache ───────────────────────────────────────────────────
// Try to find a SOUL.md in any sandbox directory
const SOUL_PATH = (() => {
  const sandboxDir = resolve(PROJECT_DIR, "config", "sandboxes");
  try {
    const entries = readdirSync(sandboxDir);
    for (const entry of entries) {
      const candidate = resolve(sandboxDir, entry, "SOUL.md");
      if (existsSync(candidate)) return candidate;
    }
  } catch {}
  return resolve(sandboxDir, "SOUL.md"); // fallback, may not exist
})();
const SOUL_CACHE_TTL = 300_000; // 5 min
let _soulCache = { text: null, at: 0 };

export function getSoulContent() {
  if (_soulCache.text !== null && Date.now() - _soulCache.at < SOUL_CACHE_TTL) {
    return _soulCache.text;
  }
  try {
    if (existsSync(SOUL_PATH)) {
      const raw = readFileSync(SOUL_PATH, "utf8").trim();
      _soulCache = { text: raw, at: Date.now() };
      return raw;
    }
  } catch { /* ignore */ }
  _soulCache = { text: "", at: Date.now() };
  return "";
}

const DEFAULT_MODEL = "familiar-coder:latest";
const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MAX_TOOL_CALLS = 25;
const DEFAULT_TIMEOUT_MS = 120_000;
const OLLAMA_URL = "http://localhost:11434";

// ── Gemini backend for tool loop ────────────────────────────────────────────
const GEMINI_API_KEY = (() => {
  try {
    const envFile = resolve(PROJECT_DIR, "config", ".env");
    if (existsSync(envFile)) {
      const raw = readFileSync(envFile, "utf8");
      return raw.match(/GEMINI_API_KEY=(.+)/)?.[1]?.trim() || null;
    }
  } catch {}
  return process.env.GEMINI_API_KEY || null;
})();
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/**
 * Call Gemini with the same messages interface as callOllama.
 * Converts messages array → Gemini contents format.
 */
async function callGemini(messages, _model, temperature) {
  if (!GEMINI_API_KEY) throw new Error("No Gemini API key");
  const contents = [];
  let systemText = "";
  for (const msg of messages) {
    if (msg.role === "system") {
      systemText += (systemText ? "\n" : "") + msg.content;
    } else if (msg.role === "user") {
      contents.push({ role: "user", parts: [{ text: msg.content }] });
    } else if (msg.role === "assistant") {
      contents.push({ role: "model", parts: [{ text: msg.content }] });
    }
  }
  const body = {
    contents,
    generationConfig: { temperature: temperature ?? 0.5, maxOutputTokens: 16384 },
  };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };

  const resp = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error(`Gemini ${resp.status}: ${err.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// ── Tool Call Parsing ───────────────────────────────────────────────────────

// Match <tool_call>...</tool_call> XML tags
const TOOL_CALL_XML_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
// Match ```json or ```bash code blocks containing tool call JSON
const TOOL_CALL_CODE_RE = /```(?:json|bash|tool)?\s*\n?\s*(\{[\s\S]*?"name"\s*:[\s\S]*?\})\s*\n?\s*```/g;
// Match bare JSON with "name" and "arguments" keys (last resort)
const TOOL_CALL_BARE_RE = /(?:^|\n)\s*(\{"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[^}]*\}\s*\})/gm;

/**
 * Attempt to convert single-quoted JSON strings to double-quoted.
 * Handles the common case where small models output Python-style strings.
 * This is best-effort — won't handle all edge cases but catches the common pattern.
 */
function fixSingleQuotedJson(str) {
  // State machine: walk through chars, swap unescaped single quotes to double quotes
  // while handling already-existing double quotes inside single-quoted values
  let result = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const prev = i > 0 ? str[i - 1] : "";
    if (ch === "'" && !inDouble && prev !== "\\") {
      // Swap single quote → double quote
      result += '"';
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && prev !== "\\") {
      result += '"';
      inDouble = !inDouble;
    } else if (ch === '"' && inSingle && prev !== "\\") {
      // Double quote inside single-quoted string → escape it
      result += '\\"';
    } else {
      result += ch;
    }
  }
  return result;
}

/**
 * Parse tool calls from model output text.
 * Handles multiple formats the model might use:
 * 1. <tool_call>{...}</tool_call> (preferred)
 * 2. ```json\n{...}\n``` or ```bash\n{...}\n``` (common fallback)
 * 3. Bare JSON with "name" + "arguments" keys (last resort)
 */
export function parseToolCalls(text) {
  const toolCalls = [];
  let reasoning = text;

  function tryParse(jsonStr, fullMatch) {
    const trimmed = jsonStr.trim();
    // Try strict JSON first, then attempt to fix single-quoted strings
    // (common with small models that mix Python/JS style)
    for (const candidate of [trimmed, fixSingleQuotedJson(trimmed)]) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed.name && typeof parsed.name === "string") {
          toolCalls.push({
            name: parsed.name,
            arguments: parsed.arguments || {},
          });
          reasoning = reasoning.replace(fullMatch, "").trim();
          return true;
        }
      } catch {
        // Try next candidate
      }
    }
    return false;
  }

  // Try XML tags first (preferred format)
  let match;
  TOOL_CALL_XML_RE.lastIndex = 0;
  while ((match = TOOL_CALL_XML_RE.exec(text)) !== null) {
    tryParse(match[1], match[0]);
  }

  // If no XML tags found, try code blocks
  if (toolCalls.length === 0) {
    TOOL_CALL_CODE_RE.lastIndex = 0;
    while ((match = TOOL_CALL_CODE_RE.exec(text)) !== null) {
      tryParse(match[1], match[0]);
    }
  }

  // If still nothing, try bare JSON
  if (toolCalls.length === 0) {
    TOOL_CALL_BARE_RE.lastIndex = 0;
    while ((match = TOOL_CALL_BARE_RE.exec(text)) !== null) {
      tryParse(match[1], match[1]);
    }
  }

  // Last resort: find any {"name":..."arguments":... structure (handles truncated
  // code blocks where the closing ``` was cut off by token limit)
  if (toolCalls.length === 0) {
    const lastBrace = text.lastIndexOf('{"name"');
    if (lastBrace !== -1) {
      let candidate = text.slice(lastBrace);
      // Try to balance braces — if truncated, close them
      let depth = 0;
      let end = 0;
      for (let i = 0; i < candidate.length; i++) {
        if (candidate[i] === "{") depth++;
        else if (candidate[i] === "}") depth--;
        if (depth === 0) { end = i + 1; break; }
      }
      if (end > 0) {
        tryParse(candidate.slice(0, end), candidate.slice(0, end));
      } else {
        // Truncated — try closing unclosed braces
        candidate += "}".repeat(depth);
        tryParse(candidate, text.slice(lastBrace));
      }
    }
  }

  return { reasoning, toolCalls };
}

// ── RAG Integration ─────────────────────────────────────────────────────────

let _ragSearch = null;

async function getRagContext(query) {
  if (!_ragSearch) {
    try {
      const mod = await import("../brain/rag/index.mjs");
      // Use graph-boosted hybrid search: vector similarity + knowledge graph traversal
      _ragSearch = mod.graphSearch;
    } catch {
      return ""; // RAG not available
    }
  }

  try {
    const results = await _ragSearch(query, 3, { minScore: 0.4 });
    if (results.length === 0) return "";

    // Emit RAG event (lazy import to avoid circular deps)
    const hasGraph = results.some(r => r.graphBoosted);
    import("./proxy-events.mjs").then(({ emitProxyEvent }) => {
      emitProxyEvent("rag", { chunks: results.length, graphBoosted: hasGraph });
    }).catch(() => {});

    return results.map(r => {
      const tag = r.graphBoosted ? " [graph]" : "";
      const src = r.source ? ` (${r.source})` : "";
      return `${r.text.slice(0, 400)}${tag}${src}`;
    }).join("\n---\n");
  } catch {
    return "";
  }
}

// ── System Prompt Builder ───────────────────────────────────────────────────

export async function buildToolSystemPrompt(additionalContext = "", userPrompt = "") {
  const toolSchemas = getToolSchemaText();

  const home = process.env.HOME || "/tmp";
  const user = process.env.USER || "user";

  // Query RAG for relevant knowledge
  let ragSection = "";
  if (userPrompt) {
    const ragContext = await getRagContext(userPrompt);
    if (ragContext) {
      ragSection = `\n## Things I Know\n${ragContext}\n`;
    }
  }

  // Inject SOUL.md identity
  const soulContent = getSoulContent();
  const identitySection = soulContent
    ? `\n## Identity\n${soulContent}\n`
    : "";

  const parts = [
    `You are Familiar, a persistent AI assistant from familiar.run — an expert coding assistant and PC manager with tool access.`,
    `You are running on ${user}'s Mac. Home directory: ${home}`,
    `Common paths: Desktop=${home}/Desktop, Downloads=${home}/Downloads, Documents=${home}/Documents`,
    ``,
    `Be concise — 1-3 sentences for simple questions, longer for complex tasks.`,
    `If the question is about general knowledge (concepts, how-to, explanations), answer directly without tools.`,
    `If the question involves the local system (files, battery, processes, disk, apps), ALWAYS use tools — never guess or use stale info.`,
    `Never fabricate file contents, system info, or tool results.`,
    ``,
    `## Using Tools`,
    `To use a tool, output:`,
    `<tool_call>`,
    `{"name": "tool_name", "arguments": {"key": "value"}}`,
    `</tool_call>`,
    ``,
    `You'll receive results in <tool_result> blocks. Use them to continue working.`,
    `When you have enough information, respond with plain text (no tool_call tags).`,
    `You can make multiple tool calls in one response.`,
    ``,
    `When the user asks you to DO something on the system, use tools. Don't write scripts for the user to run — execute directly. Don't guess at file contents — use read_file. For knowledge questions, respond directly.`,
    ``,
    `## Examples`,
    ``,
    `### Listing files`,
    `User: What files are in the scripts directory?`,
    ``,
    `Assistant: Let me check.`,
    ``,
    `<tool_call>`,
    `{"name": "bash", "arguments": {"command": "ls -la ~/familiar/services/"}}`,
    `</tool_call>`,
    ``,
    `[After receiving the tool result, you summarize the findings in plain text.]`,
    ``,
    `### Editing a file (read → edit pattern)`,
    `User: Change the port from 3000 to 8080 in server.js`,
    ``,
    `Assistant: Let me read the file first.`,
    ``,
    `<tool_call>`,
    `{"name": "read_file", "arguments": {"path": "/home/user/project/server.js"}}`,
    `</tool_call>`,
    ``,
    `[After seeing the file contents, make a targeted edit:]`,
    ``,
    `<tool_call>`,
    `{"name": "edit_file", "arguments": {"path": "/home/user/project/server.js", "old_string": "const port = 3000;", "new_string": "const port = 8080;"}}`,
    `</tool_call>`,
    ``,
    `## Available Tools`,
    ``,
    toolSchemas,
    ``,
    `## How to Edit Code`,
    `- ALWAYS read_file first to see the exact current content before editing.`,
    `- Use edit_file for targeted changes (preferred over write_file for existing files).`,
    `- Only use write_file for creating new files or complete rewrites.`,
    `- Include enough surrounding context in old_string to make it unique in the file.`,
    `- If edit_file says "N matches found", add more surrounding lines to old_string.`,
    `- Copy old_string exactly from read_file output — whitespace and indentation matter.`,
    ``,
    `## How to Work`,
    `- ALWAYS use tools to answer questions. Never fabricate output or guess.`,
    `- READ files before making changes. Don't guess at contents.`,
    `- For coding tasks: read the code, understand context, then modify.`,
    `- Break complex tasks into steps. Use tools iteratively.`,
    `- If a command fails, read the error and try a different approach.`,
    `- Store important decisions and findings in memory.`,
    ``,
    `## Computer Tools`,
    `If "Computer Tools (via familiar-daemon)" are listed above, you can directly:`,
    `- Take screenshots (screenshot_screen, screenshot_region)`,
    `- Read screen text via OCR (ocr_screen, ocr_region)`,
    `- Control windows (window_list, window_focus, window_move, window_resize)`,
    `- Control apps (app_launch, app_quit, app_list)`,
    `- Simulate input (input_key, input_type, input_mouse_click, input_hotkey)`,
    `- Read/write clipboard (clipboard_read, clipboard_write)`,
    `- Get system info (system_info, system_processes, network_info, audio_get_volume)`,
    `- Read accessibility tree (ax_read_tree, ax_focused_element, ax_click)`,
    `- Automate browser (browser_open, browser_tabs, browser_active_tab)`,
    `- Search files system-wide via Spotlight (file_search — use for "find files about X", searching by name/content/kind)`,
    `- List directory contents with sizes (file_list — use for "what's in this folder")`,
    `- Get file metadata (file_metadata — creation date, size, kind)`,
    `- Manage files (file_copy, file_move, file_trash, file_reveal, file_mkdir)`,
    `Use these tools directly — do NOT tell the user to do it manually.`,
    ``,
    `**Prefer daemon tools over core tools for PC tasks:**`,
    `- "find files about X" → file_search (Spotlight, fast, system-wide) NOT grep/glob`,
    `- "what's in this folder" → file_list (shows sizes/dates) NOT bash ls`,
    `- "what apps are open" → app_list NOT bash ps`,
    `- "what's my battery/CPU/RAM" → system_info NOT bash commands`,
    ``,
    `## Jira Tools`,
    `If "Jira Tools" are listed above, you can directly query and manage Jira.`,
    `IMPORTANT: For ANY question about Jira tickets, sprints, boards, or projects — use jira_* tools. NEVER use file_search, read_file, or bash to look for Jira data locally.`,
    ``,
    `**Example: "What are my Jira tickets?"**`,
    `<tool_call>`,
    `{"name": "jira_search", "arguments": {"jql": "assignee = currentUser() AND status != Done ORDER BY updated DESC", "limit": 10}}`,
    `</tool_call>`,
    ``,
    `**Example: "Show me PORT-12"**`,
    `<tool_call>`,
    `{"name": "jira_get_issue", "arguments": {"issue_key": "PORT-12"}}`,
    `</tool_call>`,
    ``,
    `Key Jira tools:`,
    `- jira_search — JQL search (e.g. "assignee = currentUser()", "project = PORT AND sprint in openSprints()")`,
    `- jira_get_issue — get ticket details by key`,
    `- jira_get_all_projects — list all projects`,
    `- jira_get_agile_boards — list boards`,
    `- jira_get_sprints_from_board — list sprints on a board`,
    `- jira_get_sprint_issues — get issues in a sprint`,
    `- jira_update_issue, jira_add_comment, jira_transition_issue — modify tickets`,
    ``,
    `## Phone Calls`,
    `You can make phone calls on behalf of the user using the phone_call tool.`,
    `Use this when the user asks you to call someone — a hotel, doctor's office, restaurant, business, etc.`,
    `The call is handled by an AI voice agent that converses naturally, then returns a full transcript.`,
    ``,
    `**Example: "Call the Hilton and ask about group rates"**`,
    `<tool_call>`,
    `{"name": "phone_call", "arguments": {"number": "+12125551234", "task": "Ask about group rates for 10 rooms on March 15-17", "context": "This is the Hilton Garden Inn on 6th Ave, NYC"}}`,
    `</tool_call>`,
    ``,
    `Tips:`,
    `- Number must be E.164 format (+1XXXXXXXXXX for US)`,
    `- Be specific in the task — the voice agent needs clear instructions`,
    `- Add context so the agent sounds informed`,
    `- The call blocks until done (up to 5 min) and returns the full transcript`,
    `- Only 1 call at a time`,
    ``,
    `## Daily Status / Todo List`,
    `When the user asks "what's my todo list", "what needs my attention", "what's on my plate", or similar:`,
    `Gather from ALL of these sources and compile a unified summary:`,
    ``,
    `1. **Jira** — search for open tickets assigned to currentUser() (status != Done)`,
    `2. **GitHub** — check open PRs the user authored or is requested to review`,
    `3. **Slack** — check recent messages in key channels for threads that need a response:`,
    `   - Grant has TWO Slack identities. Both represent him — treat tags to either as pinging Grant:`,
    `     - U0A3F8BTM89 — Grant's personal Slack account ("Grant Wylie")`,
    `     - U0AEBP9DFK5 — Grant's AI bot account ("J" / "J-AI", app ID A0AFCDVLT7A)`,
    `   - Scan accessible channels (#devops C05LSEMPMDG, and any others) for:`,
    `     - Messages that @mention <@U0A3F8BTM89> OR <@U0AEBP9DFK5>`,
    `     - Thread replies on messages posted by U0AEBP9DFK5 (people responding to Grant's bot posts)`,
    `     - Thread replies on messages posted by U0A3F8BTM89 (people responding to Grant directly)`,
    `   - For each thread with replies, check if the LAST reply is from someone other than Grant — if so, Grant needs to respond`,
    `   - Flag: unanswered questions, pending requests, blockers, or anything waiting on Grant`,
    `   - Note: Bot lacks groups:history scope — private channels (#project-patient-portal, #tech-hos-works) cannot be read`,
    `4. **Memory** — check recent observations for blockers or pending items`,
    ``,
    `Prioritize by urgency: blockers > unanswered Slack threads > open PRs > Jira tickets > admin tasks`,
    `Always surface Slack threads where someone is waiting on Grant's response.`,
    ``,
    `## Be Curious & Resourceful`,
    `When given a task, explore first:`,
    `- Check what files exist before making assumptions`,
    `- Read related files to understand context`,
    `- Look at memory for relevant past decisions`,
    `- If you find something interesting or unexpected, mention it`,
    ``,
    `IMPORTANT: Before saying "I can't do that" or "I don't have access to that":`,
    `1. Call list_tools to check ALL your capabilities — you may have tools you forgot about`,
    `2. Use bash or grep to explore the codebase for relevant utilities, scripts, or APIs`,
    `3. Check if there's a service, daemon tool, or MCP tool that can help`,
    `4. Use telegram_history to recall past conversations for context`,
    `Never give up and ask the user for help without first exhausting your own tools.`,
  ];

  // Inject SOUL.md identity
  if (identitySection) {
    parts.push(identitySection);
  }

  // Inject RAG knowledge
  if (ragSection) {
    parts.push(ragSection);
  }

  if (additionalContext) {
    parts.push("", "## Additional Context", additionalContext);
  }

  return parts.join("\n");
}

// ── Ollama API ──────────────────────────────────────────────────────────────
// Uses /api/chat so the Modelfile TEMPLATE formats messages correctly
// (ChatML with <|im_start|>/<|im_end|> tags, thinking disabled).
// Falls back to /api/generate with raw prompt for models without a chat template.

function messagesToPrompt(messages) {
  const parts = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      parts.push(msg.content);
    } else if (msg.role === "user") {
      parts.push(`\nUser: ${msg.content}`);
    } else if (msg.role === "assistant") {
      parts.push(`\nAssistant: ${msg.content}`);
    }
  }
  parts.push("\nAssistant:");
  return parts.join("\n");
}

async function callOllama(messages, model, temperature) {
  // Try /api/chat first (works with models that have a TEMPLATE)
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: {
          num_predict: 8192,
          temperature: temperature ?? 0.7,
        },
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (resp.ok) {
      const data = await resp.json();
      return data.message?.content || "";
    }
  } catch {
    // Fall through to generate endpoint
  }

  // Fallback: /api/generate with raw prompt
  const prompt = messagesToPrompt(messages);
  const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      raw: true,
      stream: false,
      options: {
        num_predict: 8192,
        temperature: temperature ?? 0.7,
      },
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Ollama error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  return data.response || "";
}

// ── Tool Loop ───────────────────────────────────────────────────────────────

/**
 * Run the agentic tool loop.
 *
 * @param {object} opts
 * @param {string} opts.prompt - The user's message
 * @param {string} [opts.systemPrompt] - Additional system prompt context
 * @param {string} [opts.model] - Ollama model name (default: familiar-coder:latest)
 * @param {string} [opts.backend] - LLM backend: "ollama" (default) or "gemini"
 * @param {number} [opts.temperature] - Sampling temperature (default: 0.7)
 * @param {number} [opts.maxIterations] - Max loop iterations (default: 10)
 * @param {number} [opts.maxToolCalls] - Max total tool calls (default: 25)
 * @param {number} [opts.timeoutMs] - Total timeout (default: 120000)
 * @param {string} [opts.cwd] - Working directory for tools
 * @param {Array<{role: string, content: string}>} [opts.history] - Conversation history to prepend
 *
 * @returns {Promise<{response, toolCalls, iterations, totalDurationMs, trace, finishReason}>}
 */
export async function runToolLoop(opts) {
  const {
    prompt,
    systemPrompt = "",
    model = DEFAULT_MODEL,
    backend = "ollama",
    temperature,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    maxToolCalls = DEFAULT_MAX_TOOL_CALLS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cwd,
    history,
    onToolCall,
  } = opts;

  const startTime = Date.now();
  const deadline = startTime + timeoutMs;
  const toolContext = { cwd: cwd || resolve(PROJECT_DIR, "workspace") };

  // Select model call function based on backend
  const callModel = backend === "gemini" ? callGemini : callOllama;

  // Build messages (with RAG context from user prompt)
  const systemText = await buildToolSystemPrompt(systemPrompt, prompt);
  const messages = [{ role: "system", content: systemText }];
  if (history?.length > 0) messages.push(...history);
  messages.push({ role: "user", content: prompt });

  // Trace collection
  const trace = {
    toolCalls: [],
    iterations: 0,
  };

  let totalToolCalls = 0;
  let finalResponse = "";
  let finishReason = "complete";

  for (let i = 0; i < maxIterations; i++) {
    trace.iterations = i + 1;

    // Check timeout
    if (Date.now() >= deadline) {
      finishReason = "timeout";
      break;
    }

    // Call the model
    let modelOutput;
    try {
      modelOutput = await callModel(messages, model, temperature);
    } catch (err) {
      finishReason = "error";
      finalResponse = `Model error: ${err.message}`;
      break;
    }

    if (!modelOutput || modelOutput.trim().length === 0) {
      finishReason = "empty_response";
      break;
    }

    // Parse for tool calls
    const { reasoning, toolCalls } = parseToolCalls(modelOutput);

    // No tool calls → accept as final answer (model decided tools aren't needed)
    if (toolCalls.length === 0) {
      finalResponse = modelOutput;
      finishReason = "complete";
      break;
    }

    // Check tool call limit
    if (totalToolCalls + toolCalls.length > maxToolCalls) {
      // Return what we have with the reasoning
      finalResponse = reasoning || modelOutput;
      finishReason = "tool_limit";
      break;
    }

    // Add assistant message to conversation
    messages.push({ role: "assistant", content: modelOutput });

    // Execute each tool call and build results
    const resultParts = [];
    for (const tc of toolCalls) {
      totalToolCalls++;

      if (onToolCall) onToolCall(tc.name, tc.arguments);
      const execResult = await executeTool(tc.name, tc.arguments, toolContext);
      trace.toolCalls.push({
        name: tc.name,
        arguments: tc.arguments,
        ok: execResult.ok,
        result: execResult.result,
        durationMs: execResult.durationMs,
      });

      resultParts.push(
        `<tool_result name="${tc.name}">\n${execResult.result}\n</tool_result>`
      );

      // Check timeout between tool calls
      if (Date.now() >= deadline) {
        finishReason = "timeout";
        break;
      }
    }

    if (finishReason === "timeout") break;

    // Feed results back to the model
    messages.push({ role: "user", content: resultParts.join("\n\n") });

    // If this was the last iteration, note it
    if (i === maxIterations - 1) {
      finishReason = "max_iterations";
      // Give the model one more chance to respond without tools
      try {
        modelOutput = await callModel(messages, model, temperature);
        finalResponse = modelOutput;
      } catch {
        finalResponse = reasoning || "Reached maximum iterations.";
      }
    }
  }

  const totalDurationMs = Date.now() - startTime;

  // Collect trace for Forge training (fire-and-forget)
  saveTrace({
    prompt,
    response: finalResponse,
    trace,
    finishReason,
    totalDurationMs,
    model,
  });

  // Strip Qwen3 <think> tags from response (thinking mode leakage)
  finalResponse = stripThinkTags(finalResponse);

  return {
    response: finalResponse,
    toolCalls: trace.toolCalls,
    iterations: trace.iterations,
    totalDurationMs,
    trace,
    finishReason,
  };
}

/** Strip <think>...</think> blocks from Qwen3 output */
function stripThinkTags(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
}

// ── Trace Collection ────────────────────────────────────────────────────────

function hashPrompt(prompt) {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

function saveTrace({ prompt, response, trace, finishReason, totalDurationMs, model }) {
  try {
    // Only save traces worth training on
    if (finishReason !== "complete") return;
    if (trace.toolCalls.length === 0) return;
    if (!response || response.length < 50) return;
    if (trace.iterations >= 8) return; // too many iterations = probably confused

    if (!existsSync(TRACES_DIR)) {
      mkdirSync(TRACES_DIR, { recursive: true });
    }

    const date = new Date().toISOString().slice(0, 10);
    const tracePath = resolve(TRACES_DIR, `${date}-agent.jsonl`);

    // Build training-format messages
    const traceMessages = [
      { role: "user", content: prompt },
    ];

    // Reconstruct the conversation from tool calls
    for (const tc of trace.toolCalls) {
      traceMessages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: `call_${randomUUID().slice(0, 8)}`,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }],
      });
      traceMessages.push({
        role: "tool",
        tool_call_id: traceMessages[traceMessages.length - 1].tool_calls[0].id,
        content: (tc.result || "").slice(0, 4000),
      });
    }

    // Final response
    if (response) {
      traceMessages.push({ role: "assistant", content: response });
    }

    const record = {
      id: `trace_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      timestamp: new Date().toISOString(),
      prompt_hash: hashPrompt(prompt),
      prompt,
      trace: traceMessages,
      metadata: {
        type: "agent_loop",
        source: "familiar-coder",
        model,
        tools_used: [...new Set(trace.toolCalls.map(tc => tc.name))],
        num_tool_calls: trace.toolCalls.length,
        num_messages: traceMessages.length,
        iterations: trace.iterations,
        finish_reason: finishReason,
        duration_ms: totalDurationMs,
      },
    };

    appendFileSync(tracePath, JSON.stringify(record) + "\n");
    console.log(
      `[Forge Agent] Trace saved — ${trace.toolCalls.length} tool calls, ` +
      `${trace.iterations} iterations, ${totalDurationMs}ms`
    );
  } catch (err) {
    console.error("[Forge Agent] Trace save failed:", err.message);
  }
}
