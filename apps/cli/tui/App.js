import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, useApp, useInput } from "ink";
import { Banner } from "./components/Banner.js";
import { MessageHistory } from "./components/MessageHistory.js";
import { StreamingMessage } from "./components/StreamingMessage.js";
import { ActivityTree } from "./components/ActivityTree.js";
import { SuggestionChips } from "./components/SuggestionChips.js";
import { ErrorBanner } from "./components/ErrorBanner.js";
import { StatusBar } from "./components/StatusBar.js";
import { TaskPanel } from "./components/TaskPanel.js";
import { InputPrompt } from "./components/InputPrompt.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { SessionList } from "./components/SessionList.js";
import { useGateway } from "./hooks/useGateway.js";
import { useInputHistory } from "./hooks/useInputHistory.js";
import { useSlashCommands } from "./hooks/useSlashCommands.js";
import { useServiceHealth } from "./hooks/useServiceHealth.js";
import { useFileActivity } from "./hooks/useFileActivity.js";
import { useAutoContinuation } from "./hooks/useAutoContinuation.js";
import { useBackgroundPolling } from "./hooks/useBackgroundPolling.js";
import { useKeybindings } from "./hooks/useKeybindings.js";
import { useTheme } from "./hooks/useTheme.js";
import { useSessionManager } from "./hooks/useSessionManager.js";
import { createStatusCycler } from "./lib/dynamic-status.js";
import { listThemes, setTheme } from "./lib/theme.js";

const e = React.createElement;

export function App({ gateway, sessionKey, initialCoachMode = false }) {
  const app = useApp();
  const [coachMode, setCoachMode] = useState(initialCoachMode);
  const [dynamicStatus, setDynamicStatus] = useState(null);
  const [showTasks, setShowTasks] = useState(false);
  const [showOverlay, setShowOverlay] = useState(null); // null | "palette" | "sessions"

  const { themeName, switchTheme, availableThemes } = useTheme();
  const sessionMgr = useSessionManager(gateway);

  const { messages, setMessages, streamText, setStreamText, busy, connected, error, sendMessage, suggestions, setSuggestions, toolStage, toolEvents, lastMeta, queueLength } =
    useGateway(gateway, sessionKey, coachMode);

  const { services } = useServiceHealth(connected);

  // File activity tracking (fs.watch + gateway tool events)
  const { files, summary, isCollapsed } = useFileActivity({ busy, toolEvents, watchRoot: process.cwd() });

  // Auto-continuation — watches busy transitions, sends follow-up prompts
  const { continuing, cancel: cancelContinuation, resetSuppression } = useAutoContinuation({ busy, queueLength, sendMessage });

  // Background polling — surfaces blockers, stale todos as system messages
  useBackgroundPolling({ connected, busy, setMessages });

  // Dynamic status messages from local Ollama
  const statusCyclerRef = useRef(createStatusCycler());
  const lastQueryRef = useRef("");

  useEffect(() => {
    const cycler = statusCyclerRef.current;
    if (busy && lastQueryRef.current) {
      cycler.start(lastQueryRef.current);
    }
    if (!busy) {
      cycler.stop();
      setDynamicStatus(null);
    }
  }, [busy]);

  // Poll the cycler for current message while busy
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => {
      const msg = statusCyclerRef.current.current();
      setDynamicStatus(msg);
    }, 500);
    return () => clearInterval(id);
  }, [busy]);

  // Auto-save messages to current persistent session
  const prevMessageCountRef = useRef(0);
  useEffect(() => {
    if (!sessionMgr.currentSession?.id) return;
    const newMsgs = messages.slice(prevMessageCountRef.current);
    prevMessageCountRef.current = messages.length;
    for (const msg of newMsgs) {
      if (msg.role === "user" || msg.role === "assistant") {
        sessionMgr.saveMessage(sessionMgr.currentSession.id, { role: msg.role, text: msg.text });
      }
    }
  }, [messages.length, sessionMgr.currentSession?.id]);

  const { handleCommand } = useSlashCommands({
    gateway,
    app,
    setMessages,
    setStreamText,
    sendMessage,
    sessionKey,
    services,
    coachMode,
    setCoachMode,
    switchTheme,
    themeName,
    availableThemes,
    showOverlay,
    setShowOverlay,
    sessionMgr,
  });

  const handleSubmit = useCallback(
    async (text) => {
      setSuggestions([]);
      lastQueryRef.current = text;
      // User explicitly submitted — re-enable auto-continuation for this new chain
      resetSuppression();
      const handled = await handleCommand(text);
      if (handled) return;
      sendMessage(text);
    },
    [handleCommand, sendMessage, setSuggestions, resetSuppression]
  );

  const { value, setValue, onSubmit, handleKey } = useInputHistory(handleSubmit);

  const handleSuggestionSelect = useCallback(
    (text) => {
      setSuggestions([]);
      setValue(text);
    },
    [setSuggestions, setValue]
  );

  // Cancel auto-continuation when user types anything — even while response is in-flight.
  // This suppresses the entire chain until the user explicitly submits again.
  const handleChange = useCallback(
    (newValue) => {
      cancelContinuation();
      setValue(newValue);
    },
    [cancelContinuation, setValue]
  );

  // Arrow key history navigation
  useInput(handleKey);

  // Keybinding action map
  const keybindActions = useCallback(() => ({
    toggle_tasks: () => setShowTasks((v) => !v),
    command_palette: () => setShowOverlay((v) => v === "palette" ? null : "palette"),
    theme_switch: () => {
      // Cycle to next theme
      const names = listThemes();
      const idx = names.indexOf(themeName);
      const next = names[(idx + 1) % names.length];
      switchTheme(next);
    },
    clear: () => {
      setMessages([]);
      setStreamText("");
    },
    cancel_quit: () => {
      if (showOverlay) {
        setShowOverlay(null);
      } else if (busy) {
        // Already handled by ink's default ctrl+c
      } else {
        gateway.disconnect();
        app.exit();
      }
    },
    close_overlay: () => setShowOverlay(null),
    quit: () => {
      gateway.disconnect();
      app.exit();
    },
    list_sessions: () => {
      sessionMgr.refreshSessions();
      setShowOverlay((v) => v === "sessions" ? null : "sessions");
    },
    new_session: () => handleCommand("/session new"),
    fork_session: () => {
      if (sessionMgr.currentSession?.id) {
        handleCommand("/session fork");
      }
    },
  }), [themeName, switchTheme, showOverlay, busy, gateway, app, setMessages, setStreamText, handleCommand, sessionMgr]);

  const { leaderPending } = useKeybindings(keybindActions(), {
    isActive: !showOverlay,
  });

  // Command palette execute handler
  const handlePaletteExecute = useCallback((action) => {
    if (action.startsWith("__keybind__")) {
      const keybindAction = action.slice("__keybind__".length);
      const actions = keybindActions();
      if (actions[keybindAction]) actions[keybindAction]();
      return;
    }
    // Slash commands — run through handleCommand
    if (action.startsWith("/")) {
      handleCommand(action);
      return;
    }
  }, [keybindActions, handleCommand]);

  // Session switch handler
  const handleSessionSelect = useCallback(async (sessionId) => {
    const session = await sessionMgr.switchSession(sessionId);
    if (session) {
      // Load messages from the session
      const msgs = await sessionMgr.getMessages(sessionId);
      const formatted = msgs.map((m, i) => ({
        id: `restored-${i}`,
        role: m.role,
        text: m.text,
      }));
      setMessages(formatted);
      prevMessageCountRef.current = formatted.length;
    }
  }, [sessionMgr, setMessages]);

  const sessionTitle = sessionMgr.currentSession?.title;

  return e(Box, { flexDirection: "column" },
    e(Banner, { files, summary, isCollapsed }),
    showTasks && e(TaskPanel, { busy, toolStage, toolEvents }),
    // Command palette overlay
    showOverlay === "palette" && e(CommandPalette, {
      onClose: () => setShowOverlay(null),
      onExecute: handlePaletteExecute,
      availableThemes,
      themeName,
    }),
    // Session list overlay
    showOverlay === "sessions" && e(SessionList, {
      sessions: sessionMgr.sessions,
      currentSessionId: sessionMgr.currentSession?.id,
      onSelect: handleSessionSelect,
      onClose: () => setShowOverlay(null),
      onFork: (id) => sessionMgr.forkSession(id),
      onArchive: (id) => sessionMgr.archiveSession(id),
      loading: sessionMgr.loading,
    }),
    e(MessageHistory, { messages }),
    e(ActivityTree, { files, busy, isCollapsed, summary }),
    e(StreamingMessage, { text: streamText, busy, toolStage, dynamicStatus, continuing }),
    e(SuggestionChips, { suggestions, onSelect: handleSuggestionSelect }),
    e(ErrorBanner, { error }),
    e(StatusBar, { services, session: sessionTitle || sessionKey, lastMeta, leaderPending, themeName }),
    !showOverlay && e(InputPrompt, {
      value,
      onChange: handleChange,
      onSubmit,
      busy,
      queueLength,
    })
  );
}
