import { useState, useEffect, useCallback, useRef } from "react";
import { extractAndStore } from "../../lib/extract-observations.js";
import { extractSuggestions, stripSuggestions } from "../lib/extract-suggestions.js";
import { summarizeThought } from "../lib/summarize-thought.js";

const ACTIVITY_URL = `http://localhost:${process.env.ACTIVITY_PORT || 18790}`;
const MAX_QUEUE = 10;

function logActivityQuiet(role, content, sessionKey = "familiar:cli:main") {
  fetch(`${ACTIVITY_URL}/activity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ platform: "cli", session_key: sessionKey, role, content }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

let msgCounter = 0;

/**
 * Bridge: GatewayClient EventEmitter → React state.
 *
 * Returns { messages, streamText, busy, connected, error, sendMessage, toolStage, lastMeta, queueLength }
 */
export function useGateway(gw, sessionKey, coachMode = false) {
  const [messages, setMessages] = useState([]);
  const [streamText, setStreamText] = useState("");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(gw?.connected ?? false);
  const [error, setError] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [toolStage, setToolStage] = useState(null);
  const [toolEvents, setToolEvents] = useState([]);
  const [lastMeta, setLastMeta] = useState(null);
  const [queueLength, setQueueLength] = useState(0);

  // Input queue — messages typed while busy
  const queueRef = useRef([]);
  const drainQueueRef = useRef(null);

  // Track accumulated text for delta diffing (same approach as repl.mjs)
  const accumulatedRef = useRef("");
  const lastUserMsgRef = useRef("");
  const responseStartRef = useRef(null);
  const finalCountRef = useRef(0);
  const thinkingRef = useRef(false);
  const hadProgressRef = useRef(false);

  // Subscribe to gateway events
  useEffect(() => {
    if (!gw) return;

    setConnected(gw.connected);

    function onAgent(payload) {
      if (payload.sessionKey !== sessionKey) return;

      const data = payload.data || {};
      const stream = payload.stream;

      // Lifecycle errors
      if (stream === "lifecycle") {
        if (data.phase === "error") {
          setError(data.message || "Agent error");
          setBusy(false);
          setToolStage(null);
          thinkingRef.current = false;
        }
        return;
      }

      // Thinking lifecycle — explicit start/end from gateway
      if (stream === "thinking") {
        if (data.phase === "start") {
          thinkingRef.current = true;
          setToolStage("thinking");
        } else if (data.phase === "end") {
          thinkingRef.current = false;
          // Don't clear toolStage here — let tool events or text arrival handle it
        }
        return;
      }

      // Tool events — extract tool name for context-aware spinner + file activity
      if (stream === "tool" || data.tool || data.phase === "tool_start") {
        const toolName = data.name || data.tool || data.toolName || "";
        const filePath = data.input?.file_path || data.input?.path
          || data.tool?.input?.file_path || data.tool?.input?.path || null;
        const phase = data.phase || (toolName ? "tool_start" : "unknown");

        if (toolName) {
          setToolStage(toolName);
          setToolEvents((prev) => [...prev, { toolName, filePath, timestamp: Date.now(), phase }]);
        }
        if (data.phase === "tool_end" || data.phase === "tool_complete") {
          setToolStage(null);
        }
        return;
      }

      // Assistant text stream
      if (stream === "assistant") {
        const fullText = data.text || data.content || "";
        const delta = data.delta || "";
        if (!fullText && !delta) return;

        // Clear tool stage when text starts flowing (thinking already ended via lifecycle)
        if (!thinkingRef.current) setToolStage(null);

        // Compute new accumulated text (mirrors repl.mjs logic)
        let newAccumulated = accumulatedRef.current;
        if (delta && fullText) {
          newAccumulated = fullText;
        } else if (delta) {
          newAccumulated = accumulatedRef.current + delta;
        } else {
          newAccumulated = fullText;
        }

        accumulatedRef.current = newAccumulated;
        setStreamText(newAccumulated);
      }
    }

    function onChat(payload) {
      if (payload.sessionKey !== sessionKey) return;

      // Progress messages (e.g. fallback notices) — show as system messages
      if (payload.state === "progress") {
        hadProgressRef.current = true;
        const content = payload.message?.content;
        if (content) {
          setMessages((prev) => [
            ...prev,
            { id: `p-${++msgCounter}`, role: "system", text: content },
          ]);
        }
        return;
      }

      if (payload.state === "final") {
        // Extract final text — prefer streamed text, fall back to message content
        let finalText = accumulatedRef.current;

        if (!finalText && payload.message?.content) {
          const content = payload.message.content;
          if (typeof content === "string") {
            finalText = content;
          } else if (Array.isArray(content)) {
            finalText = content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("\n");
          }
        }

        if (finalText) {
          // Extract and strip suggestions before displaying
          const chips = extractSuggestions(finalText);
          const cleanText = chips.length > 0 ? stripSuggestions(finalText) : finalText;
          setSuggestions(chips);

          // Determine role: continuation/progress messages are "thought", primary responses are "assistant"
          const isThought = finalCountRef.current > 0 || hadProgressRef.current;
          const role = isThought ? "thought" : "assistant";
          finalCountRef.current++;

          const msgId = `a-${++msgCounter}`;

          if (role === "thought") {
            // Summarize via Ollama BEFORE adding to Static messages
            // (Ink's Static component only renders items once)
            summarizeThought(cleanText).then((summary) => {
              setMessages((prev) => [
                ...prev,
                { id: msgId, role, text: summary },
              ]);
            }).catch(() => {
              // Graceful fallback — show truncated original instead of nothing
              setMessages((prev) => [
                ...prev,
                { id: msgId, role, text: cleanText.slice(0, 120) + (cleanText.length > 120 ? "..." : "") },
              ]);
            });
          } else {
            setMessages((prev) => [
              ...prev,
              { id: msgId, role, text: cleanText },
            ]);
          }
        }

        // Extract response metadata (model + duration)
        const model = payload.message?.model || payload.data?.model || null;
        const durationMs = responseStartRef.current
          ? Date.now() - responseStartRef.current
          : null;
        setLastMeta({ model, durationMs });

        // Fire-and-forget observation extraction
        const userText = lastUserMsgRef.current;
        if (userText && finalText) {
          setTimeout(() => extractAndStore(userText, finalText, "tui"), 0);
          // Log both messages to activity server
          logActivityQuiet("user", userText);
          logActivityQuiet("assistant", finalText);
        }

        setStreamText("");
        accumulatedRef.current = "";
        setToolStage(null);
        setError(null);
        responseStartRef.current = null;
        thinkingRef.current = false;

        // If queue has items, drain next WITHOUT setting busy=false
        // (prevents auto-continuation from firing during the gap)
        if (queueRef.current.length > 0 && drainQueueRef.current) {
          drainQueueRef.current();
        } else {
          setBusy(false);
        }
      }

      if (payload.state === "error") {
        setError(payload.errorMessage || "Unknown error");
        setStreamText("");
        accumulatedRef.current = "";
        setToolStage(null);
        responseStartRef.current = null;
        thinkingRef.current = false;

        if (queueRef.current.length > 0 && drainQueueRef.current) {
          drainQueueRef.current();
        } else {
          setBusy(false);
        }
      }
    }

    function onDisconnected() {
      setConnected(false);
      setError("Reconnecting to gateway...");
      setBusy(false);
      setToolStage(null);
    }

    function onReconnecting({ attempt, delay }) {
      const secs = Math.round(delay / 1000);
      setError(`Reconnecting (attempt ${attempt}, ${secs}s)...`);
    }

    function onReconnected() {
      setConnected(true);
      setError(null);
      // Drain any queued messages after reconnect
      if (queueRef.current.length > 0 && drainQueueRef.current) {
        drainQueueRef.current();
      }
    }

    function onError(err) {
      setError(err?.message || String(err));
    }

    gw.on("agent", onAgent);
    gw.on("chat", onChat);
    gw.on("disconnected", onDisconnected);
    gw.on("reconnecting", onReconnecting);
    gw.on("reconnected", onReconnected);
    gw.on("error", onError);

    return () => {
      gw.off("agent", onAgent);
      gw.off("chat", onChat);
      gw.off("disconnected", onDisconnected);
      gw.off("reconnecting", onReconnecting);
      gw.off("reconnected", onReconnected);
      gw.off("error", onError);
    };
  }, [gw, sessionKey]);

  // Core send — dispatches to gateway. skipHistory=true when draining queue (message already shown)
  const sendMessageDirect = useCallback(
    async (text, { skipHistory = false } = {}) => {
      if (!text) return;

      setError(null);
      setBusy(true);
      accumulatedRef.current = "";
      setStreamText("");
      setSuggestions([]);
      setToolStage(null);
      setToolEvents([]);
      lastUserMsgRef.current = text;
      responseStartRef.current = Date.now();
      finalCountRef.current = 0;
      thinkingRef.current = false;
      hadProgressRef.current = false;

      if (!skipHistory) {
        setMessages((prev) => [
          ...prev,
          { id: `u-${++msgCounter}`, role: "user", text },
        ]);
      }

      try {
        let messageToSend = text;

        if (coachMode) {
          messageToSend =
            "[Coaching mode ON. Be warm, patient, encouraging. Explain in plain language first, use analogies. End with SUGGESTIONS: [\"cmd1\", \"cmd2\", ...]]\n\n" +
            messageToSend;
        }

        await gw.chat(sessionKey, messageToSend);
      } catch (err) {
        setError(err.message);
        setBusy(false);
        setToolStage(null);
        responseStartRef.current = null;
      }
    },
    [gw, sessionKey, coachMode]
  );

  // Drain next queued message after a response completes
  const drainQueue = useCallback(() => {
    if (queueRef.current.length === 0) return;
    const next = queueRef.current.shift();
    setQueueLength(queueRef.current.length);

    // Promote the queued message role from "queued" to "user" in history
    setMessages((prev) =>
      prev.map((m) =>
        m.id === next.msgId ? { ...m, role: "user" } : m
      )
    );

    // Send directly — message is already in the history list
    // No delay needed since we never set busy=false during drain
    sendMessageDirect(next.text, { skipHistory: true });
  }, [sendMessageDirect]);

  // Keep ref in sync so the effect closure always calls the latest version
  drainQueueRef.current = drainQueue;

  // Public send — queues if busy
  const sendMessage = useCallback(
    (text) => {
      if (!text) return;

      if (!busy) {
        sendMessageDirect(text);
        return;
      }

      // Queue is full — drop with system message
      if (queueRef.current.length >= MAX_QUEUE) {
        setMessages((prev) => [
          ...prev,
          { id: `s-${++msgCounter}`, role: "system", text: `Queue full (${MAX_QUEUE}) — message dropped` },
        ]);
        return;
      }

      // Add to queue
      const msgId = `q-${++msgCounter}`;
      queueRef.current.push({ text, msgId });
      setQueueLength(queueRef.current.length);

      // Show queued message in history
      setMessages((prev) => [
        ...prev,
        { id: msgId, role: "queued", text },
      ]);
    },
    [busy, sendMessageDirect]
  );

  return { messages, setMessages, streamText, setStreamText, busy, connected, error, sendMessage, suggestions, setSuggestions, toolStage, toolEvents, lastMeta, queueLength };
}
