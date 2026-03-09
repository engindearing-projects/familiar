import React, { useRef, useState, useEffect } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { colors, NO_COLOR } from "../lib/theme.js";
import { renderMarkdownSafe } from "../lib/markdown.js";

const e = React.createElement;

const THROTTLE_MS = 100;

// Friendly labels for tool names shown in the spinner
const TOOL_LABELS = {
  thinking: "Thinking",
  claude: "Working with Claude",
  gemini: "Working with Gemini",
  Read: "Reading",
  Grep: "Searching",
  Glob: "Finding files",
  Bash: "Running command",
  Edit: "Editing",
  Write: "Writing",
  WebFetch: "Fetching URL",
  WebSearch: "Searching web",
  mcp__atlassian__jira_search: "Searching Jira",
  mcp__atlassian__jira_get_issue: "Loading ticket",
  mcp__slack__slack_post_message: "Posting to Slack",
  mcp__slack__slack_get_channel_history: "Reading Slack",
  mcp__figma__get_screenshot: "Getting Figma screenshot",
};

function getToolLabel(toolName) {
  if (!toolName) return null;
  if (TOOL_LABELS[toolName]) return TOOL_LABELS[toolName];
  // Try prefix match for MCP tools
  for (const [key, label] of Object.entries(TOOL_LABELS)) {
    if (toolName.startsWith(key)) return label;
  }
  // Fallback: humanize the tool name
  const cleaned = toolName.replace(/^mcp__\w+__/, "").replace(/_/g, " ");
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// Fun idle phrases that cycle while waiting for first token
// Big pool so it stays fresh — shuffled per session
const PHRASE_POOL = [
  "thinking",
  "doing stuff",
  "brewing thoughts",
  "on it",
  "cooking",
  "noodling",
  "figuring it out",
  "crunching",
  "working on it",
  "spinning up",
  "pondering",
  "wiring things up",
  "one sec",
  "loading brain",
  "assembling bytes",
  "revving up",
  "hmm",
  "lemme think",
  "hold on",
  "chewing on it",
  "brb",
  "processing",
  "context loading",
  "deep in thought",
  "reading the room",
  "warming up",
  "parsing reality",
  "connecting dots",
  "almost ready",
  "hang tight",
  "tuning in",
  "calibrating",
  "digging in",
  "scanning",
  "compiling thoughts",
  "engaging brain",
  "let me cook",
  "running the numbers",
  "checking notes",
  "mapping it out",
];

// Fisher-Yates shuffle — fresh order each session
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Shuffle once at import time so each session gets a different order
const IDLE_PHRASES = shuffle(PHRASE_POOL);

/** Cycle through shuffled phrases sequentially */
function nextPhrase(currentIdx) {
  return (currentIdx + 1) % IDLE_PHRASES.length;
}

export function StreamingMessage({ text, busy, toolStage, dynamicStatus, continuing }) {
  const [rendered, setRendered] = useState("");
  const timerRef = useRef(null);
  const latestTextRef = useRef("");

  // Idle phrase cycling
  const [phraseIdx, setPhraseIdx] = useState(0);
  const phraseTimerRef = useRef(null);

  // Track latest text in ref for throttle callback
  latestTextRef.current = text;

  // Cycle idle phrases every 2s while busy and no text
  useEffect(() => {
    if (busy && !text && !toolStage) {
      phraseTimerRef.current = setInterval(() => {
        setPhraseIdx((prev) => nextPhrase(prev));
      }, 2000);
      return () => clearInterval(phraseTimerRef.current);
    }
    // Reset phrase on new request
    if (!busy) {
      setPhraseIdx(0);
    }
    return () => {
      if (phraseTimerRef.current) clearInterval(phraseTimerRef.current);
    };
  }, [busy, text, toolStage]);

  useEffect(() => {
    if (!text) {
      setRendered("");
      return;
    }

    // Throttle: only re-render markdown every THROTTLE_MS
    if (!timerRef.current) {
      // Render immediately on first text
      setRendered(renderMarkdownSafe(text));
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        // Render the latest text when the throttle expires
        setRendered(renderMarkdownSafe(latestTextRef.current));
      }, THROTTLE_MS);
    }
  }, [text]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  // Continuing indicator — shown between responses when auto-continuation is pending
  if (continuing && !busy && !text) {
    return e(Box, { flexDirection: "column", marginLeft: 2, marginTop: 1 },
      e(Text, { color: colors.yellow, italic: true },
        "continuing in a moment... (type to cancel)"
      )
    );
  }

  // Not busy and no text — render nothing
  if (!busy && !text) return null;

  // Busy but still waiting for first token — show animated spinner + phrase
  if (busy && !text) {
    const toolLabel = getToolLabel(toolStage);
    const label = dynamicStatus || toolLabel || IDLE_PHRASES[phraseIdx];
    const isIdle = !dynamicStatus && !toolLabel;

    const spinner = NO_COLOR
      ? e(Text, { color: colors.cyan }, "...")
      : e(Text, { color: colors.cyan }, e(Spinner, { type: "arc" }));

    return e(Box, { flexDirection: "column", marginLeft: 2, marginTop: 1 },
      e(Box, null,
        e(Text, { color: colors.cyanDim, bold: true }, "familiar "),
        spinner,
      ),
      e(Text, { color: isIdle ? colors.gray : colors.green, italic: isIdle },
        `  ${label}`
      )
    );
  }

  // Streaming text arrived
  return e(Box, { flexDirection: "column", marginLeft: 2, marginTop: 1 },
    e(Box, null,
      e(Text, { color: colors.cyanDim, bold: true }, "familiar"),
      e(Text, { color: colors.gray }, " "),
      busy
        ? (NO_COLOR
            ? e(Text, { color: colors.cyan }, "...")
            : e(Text, { color: colors.cyan }, e(Spinner, { type: "arc" })))
        : null
    ),
    e(Text, null, rendered || text)
  );
}
