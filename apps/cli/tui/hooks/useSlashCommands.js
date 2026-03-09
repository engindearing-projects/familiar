import { useCallback } from "react";
import { searchMemory, addObservation } from "./useMemory.js";
import { formatBindings } from "../lib/keybindings.js";

let sysMsgCounter = 0;

function sysMsg(text) {
  return { id: `sys-${++sysMsgCounter}`, role: "system", text };
}

const HELP_TEXT = [
  "Available commands:",
  "  /help              Show this help",
  "  /clear             Clear message history",
  "  /session [cmd]     Session management (new, list, fork, rename, archive)",
  "  /status            Show service health",
  "  /memory [query]    Search memory (no query = show recent)",
  "  /observe <text>    Save an observation to memory",
  "  /todo [add|done]   Manage todo items (shift+tab to view panel)",
  "  /forge [cmd]       Training pipeline (status, train, eval, data)",
  "  /coach             Toggle coaching mode",
  "  /explain [concept] Get a friendly explanation",
  "  /suggest           Get next-step suggestions",
  "  /theme [name]      Switch theme (no args = list themes)",
  "  /keybinds          Show keybinding reference",
  "  /diff              Show git diff of working directory",
  "  /mobile            Show mobile access setup",
  "  /quit              Exit (/exit, /q also work)",
].join("\n");

/**
 * Format a list of observations into a readable system message.
 */
function formatObservations(rows, label = "Recent memory") {
  if (!rows || rows.length === 0) {
    return `${label}: (empty)`;
  }
  const lines = rows.map((r) => {
    const ts = new Date(r.timestamp).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const project = r.project ? ` [${r.project}]` : "";
    const type = r.type ? ` (${r.type})` : "";
    return `  ${ts}${project}${type} — ${r.summary}`;
  });
  return `${label}:\n${lines.join("\n")}`;
}

/**
 * Slash command handler hook.
 *
 * Returns { handleCommand(text) -> bool } — returns true if the input was a slash command.
 */
export function useSlashCommands({ gateway, app, setMessages, setStreamText, sendMessage, sessionKey, services, coachMode, setCoachMode, switchTheme, themeName, availableThemes, showOverlay, setShowOverlay, sessionMgr }) {
  const handleCommand = useCallback(
    async (text) => {
      const trimmed = text.trim();
      const lower = trimmed.toLowerCase();

      if (!trimmed.startsWith("/")) return false;

      // /quit, /exit, /q
      if (lower === "/quit" || lower === "/exit" || lower === "/q") {
        gateway.disconnect();
        app.exit();
        return true;
      }

      // /clear
      if (lower === "/clear") {
        setMessages([]);
        setStreamText("");
        return true;
      }

      // /session [subcommand]
      if (lower === "/session" || lower.startsWith("/session ")) {
        const sessionArgs = trimmed.slice("/session".length).trim();
        const sessionLower = sessionArgs.toLowerCase();

        // /session (no args) — show current session info
        if (!sessionArgs) {
          const current = sessionMgr?.currentSession;
          if (current) {
            setMessages((prev) => [...prev, sysMsg(`Session: ${current.title} (${current.id})\nKey: ${sessionKey}`)]);
          } else {
            setMessages((prev) => [...prev, sysMsg(`Session key: ${sessionKey}\nNo persistent session active. Use /session new to create one.`)]);
          }
          return true;
        }

        // /session new [title]
        if (sessionLower === "new" || sessionLower.startsWith("new ")) {
          const title = sessionArgs.slice("new".length).trim() || undefined;
          if (sessionMgr) {
            const session = await sessionMgr.createSession(title);
            if (session) {
              setMessages([]);
              setStreamText("");
              setMessages((prev) => [...prev, sysMsg(`New session created: ${session.title} (${session.id})`)]);
            } else {
              setMessages((prev) => [...prev, sysMsg("Failed to create session. Is the gateway connected?")]);
            }
          }
          return true;
        }

        // /session list
        if (sessionLower === "list") {
          if (setShowOverlay) {
            if (sessionMgr) sessionMgr.refreshSessions();
            setShowOverlay("sessions");
          }
          return true;
        }

        // /session fork [title]
        if (sessionLower === "fork" || sessionLower.startsWith("fork ")) {
          const title = sessionArgs.slice("fork".length).trim() || undefined;
          if (sessionMgr?.currentSession?.id) {
            const forked = await sessionMgr.forkSession(sessionMgr.currentSession.id, title);
            if (forked) {
              setMessages((prev) => [...prev, sysMsg(`Forked session: ${forked.title} (${forked.id}) from ${sessionMgr.currentSession.id}`)]);
            }
          } else {
            setMessages((prev) => [...prev, sysMsg("No active session to fork. Use /session new first.")]);
          }
          return true;
        }

        // /session rename <title>
        if (sessionLower.startsWith("rename ")) {
          const title = sessionArgs.slice("rename ".length).trim();
          if (!title) {
            setMessages((prev) => [...prev, sysMsg("Usage: /session rename <title>")]);
            return true;
          }
          if (sessionMgr?.currentSession?.id) {
            await sessionMgr.renameSession(sessionMgr.currentSession.id, title);
            setMessages((prev) => [...prev, sysMsg(`Session renamed to: ${title}`)]);
          } else {
            setMessages((prev) => [...prev, sysMsg("No active session. Use /session new first.")]);
          }
          return true;
        }

        // /session archive
        if (sessionLower === "archive") {
          if (sessionMgr?.currentSession?.id) {
            await sessionMgr.archiveSession(sessionMgr.currentSession.id);
            setMessages((prev) => [...prev, sysMsg("Session archived.")]);
          } else {
            setMessages((prev) => [...prev, sysMsg("No active session to archive.")]);
          }
          return true;
        }

        // Unknown /session subcommand
        setMessages((prev) => [...prev, sysMsg("Usage: /session, /session new [title], /session list, /session fork [title], /session rename <title>, /session archive")]);
        return true;
      }

      // /help
      if (lower === "/help") {
        setMessages((prev) => [...prev, sysMsg(HELP_TEXT)]);
        return true;
      }

      // /theme [name]
      if (lower === "/theme" || lower.startsWith("/theme ")) {
        const name = trimmed.slice("/theme".length).trim();
        if (!name) {
          // List available themes
          const list = (availableThemes || []).map((t) => {
            const marker = t === themeName ? " (active)" : "";
            return `  ${t}${marker}`;
          });
          setMessages((prev) => [...prev, sysMsg(`Available themes:\n${list.join("\n")}`)]);
          return true;
        }
        if (switchTheme) {
          const ok = switchTheme(name);
          if (ok) {
            setMessages((prev) => [...prev, sysMsg(`Theme switched to: ${name}`)]);
          } else {
            setMessages((prev) => [...prev, sysMsg(`Unknown theme: "${name}". Type /theme to see available themes.`)]);
          }
        }
        return true;
      }

      // /keybinds
      if (lower === "/keybinds" || lower === "/keybind" || lower === "/keys") {
        setMessages((prev) => [...prev, sysMsg(formatBindings())]);
        return true;
      }

      // /diff — show git diff of working directory
      if (lower === "/diff") {
        try {
          const { execSync } = await import("child_process");
          const diff = execSync("git diff", {
            cwd: process.cwd(),
            encoding: "utf-8",
            timeout: 5000,
          }).trim();
          if (!diff) {
            // Check staged changes too
            const staged = execSync("git diff --staged", {
              cwd: process.cwd(),
              encoding: "utf-8",
              timeout: 5000,
            }).trim();
            if (staged) {
              setMessages((prev) => [...prev, { id: `sys-${++sysMsgCounter}`, role: "assistant", text: staged }]);
            } else {
              setMessages((prev) => [...prev, sysMsg("No changes in working directory.")]);
            }
          } else {
            // Send as assistant message so DiffView renders it
            setMessages((prev) => [...prev, { id: `sys-${++sysMsgCounter}`, role: "assistant", text: diff }]);
          }
        } catch (err) {
          setMessages((prev) => [...prev, sysMsg(`Git diff error: ${err.message}`)]);
        }
        return true;
      }

      // /coach — toggle coaching mode
      if (lower === "/coach") {
        const newMode = !coachMode;
        setCoachMode(newMode);
        setMessages((prev) => [
          ...prev,
          sysMsg(newMode
            ? "Coaching mode ON — Familiar will give warmer explanations with suggestions."
            : "Coaching mode OFF — back to standard mode."
          ),
        ]);
        return true;
      }

      // /explain [concept] — request a friendly explanation
      if (lower === "/explain" || lower.startsWith("/explain ")) {
        const concept = trimmed.slice("/explain".length).trim();
        if (!concept) {
          setMessages((prev) => [...prev, sysMsg("Usage: /explain <concept or command>")]);
          return true;
        }
        const wrapped =
          `[Coaching mode: explain this in a warm, friendly way. Use plain language first, then show the technical details. Use analogies where helpful. End with SUGGESTIONS: ["cmd1", "cmd2", ...]]\n\nExplain: ${concept}`;
        sendMessage(wrapped);
        return true;
      }

      // /suggest — request contextual next-step suggestions
      if (lower === "/suggest") {
        const wrapped =
          `[Based on our conversation so far, suggest 3-5 useful next steps or commands I could try. Format your response with SUGGESTIONS: ["cmd1", "cmd2", ...] at the end.]`;
        sendMessage(wrapped);
        return true;
      }

      // /status
      if (lower === "/status") {
        const lines = services.map((s) => {
          const dot = s.healthy ? "\u25CF" : "\u25CB";
          const status = s.healthy ? "healthy" : "down";
          return `  ${dot} ${s.name}: ${status}`;
        });
        setMessages((prev) => [
          ...prev,
          sysMsg(`Service health:\n${lines.join("\n")}`),
        ]);
        return true;
      }

      // /memory [query]
      if (lower === "/memory" || lower.startsWith("/memory ")) {
        const query = trimmed.slice("/memory".length).trim();

        // Optimistic loading message
        const loadingId = `sys-${++sysMsgCounter}`;
        setMessages((prev) => [
          ...prev,
          { id: loadingId, role: "system", text: query ? `Searching memory for: "${query}"...` : "Loading recent memory..." },
        ]);

        try {
          let rows;
          if (query) {
            rows = await searchMemory(query, { limit: 10 });
            setMessages((prev) =>
              prev.map((m) =>
                m.id === loadingId
                  ? sysMsg(formatObservations(rows, `Memory search: "${query}"`))
                  : m
              )
            );
          } else {
            // Load recent without FTS
            const mem = await import("../../lib/memory-db.js").catch(() => null);
            if (mem) {
              const db = mem.getDb();
              rows = db
                .prepare(
                  `SELECT id, type, timestamp, project, summary, tags
                   FROM observations
                   ORDER BY timestamp DESC
                   LIMIT 10`
                )
                .all()
                .map((r) => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : [] }));
            } else {
              rows = [];
            }
            setMessages((prev) =>
              prev.map((m) =>
                m.id === loadingId ? sysMsg(formatObservations(rows, "Recent memory")) : m
              )
            );
          }
        } catch (err) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === loadingId
                ? sysMsg(`Memory error: ${err.message}`)
                : m
            )
          );
        }

        return true;
      }

      // /observe <text>
      if (lower.startsWith("/observe ")) {
        const observeText = trimmed.slice("/observe ".length).trim();
        if (!observeText) {
          setMessages((prev) => [...prev, sysMsg("Usage: /observe <summary text>")]);
          return true;
        }

        try {
          const id = await addObservation({
            type: "note",
            summary: observeText,
            source: "cli",
          });
          setMessages((prev) => [...prev, sysMsg(`Saved observation: ${id}`)]);
        } catch (err) {
          setMessages((prev) => [...prev, sysMsg(`Failed to save: ${err.message}`)]);
        }

        return true;
      }

      // /todo [add|done]
      if (lower === "/todo" || lower.startsWith("/todo ")) {
        const todoArgs = trimmed.slice("/todo".length).trim();

        // /todo (no args) — list all todos
        if (!todoArgs) {
          try {
            const mem = await import("../../lib/memory-db.js").catch(() => null);
            if (!mem) {
              setMessages((prev) => [...prev, sysMsg("Memory DB not available")]);
              return true;
            }
            const todos = mem.getByType("todo", 20);
            if (todos.length === 0) {
              setMessages((prev) => [...prev, sysMsg("No todos. Use /todo add <text> to create one.")]);
            } else {
              const lines = todos.map((t) => `  \u2610 ${t.summary}  (${t.id})`);
              setMessages((prev) => [...prev, sysMsg(`Todos:\n${lines.join("\n")}`)]);
            }
          } catch (err) {
            setMessages((prev) => [...prev, sysMsg(`Todo error: ${err.message}`)]);
          }
          return true;
        }

        // /todo add <text>
        if (todoArgs.startsWith("add ")) {
          const text = todoArgs.slice("add ".length).trim();
          if (!text) {
            setMessages((prev) => [...prev, sysMsg("Usage: /todo add <text>")]);
            return true;
          }
          try {
            const id = await addObservation({ type: "todo", summary: text, source: "cli" });
            setMessages((prev) => [...prev, sysMsg(`Added todo: ${text}  (${id})`)]);
          } catch (err) {
            setMessages((prev) => [...prev, sysMsg(`Failed to add todo: ${err.message}`)]);
          }
          return true;
        }

        // /todo done <id>
        if (todoArgs.startsWith("done ")) {
          const id = todoArgs.slice("done ".length).trim();
          if (!id) {
            setMessages((prev) => [...prev, sysMsg("Usage: /todo done <id>")]);
            return true;
          }
          try {
            const mem = await import("../../lib/memory-db.js").catch(() => null);
            if (!mem) {
              setMessages((prev) => [...prev, sysMsg("Memory DB not available")]);
              return true;
            }
            const deleted = mem.deleteObservation(id);
            if (deleted) {
              setMessages((prev) => [...prev, sysMsg(`Done: removed ${id}`)]);
            } else {
              setMessages((prev) => [...prev, sysMsg(`Not found: ${id}`)]);
            }
          } catch (err) {
            setMessages((prev) => [...prev, sysMsg(`Todo error: ${err.message}`)]);
          }
          return true;
        }

        // Unknown /todo subcommand
        setMessages((prev) => [...prev, sysMsg("Usage: /todo, /todo add <text>, /todo done <id>")]);
        return true;
      }

      // /forge [cmd]
      if (lower === "/forge" || lower.startsWith("/forge ")) {
        const forgeArgs = trimmed.slice("/forge".length).trim();
        const forgeCmd = forgeArgs || "status";
        setMessages((prev) => [
          ...prev,
          sysMsg(`Running forge ${forgeCmd}...`),
        ]);

        try {
          const forgeCli = await import("../../../trainer/forge-cli.mjs").catch(() => null);
          if (forgeCli) {
            // Capture console output
            const origLog = console.log;
            let output = [];
            console.log = (...args) => output.push(args.join(" "));
            try {
              await forgeCli.run({ args: forgeCmd.split(/\s+/) });
            } finally {
              console.log = origLog;
            }
            setMessages((prev) => [
              ...prev,
              sysMsg(output.join("\n") || "Done."),
            ]);
          } else {
            setMessages((prev) => [
              ...prev,
              sysMsg("Forge not available. Run: bash ~/familiar/trainer/setup.sh"),
            ]);
          }
        } catch (err) {
          setMessages((prev) => [
            ...prev,
            sysMsg(`Forge error: ${err.message}`),
          ]);
        }
        return true;
      }

      // /mobile — show mobile access instructions
      if (lower === "/mobile") {
        const { hostname: getHostname } = await import("os");
        const hostname = getHostname();
        const mobileText = [
          "Mobile access via Mosh/SSH:",
          "",
          "1. Start a tmux session on this Mac:",
          `   bash ~/familiar/services/start-tui-session.sh`,
          "",
          "2. From iPhone (Blink Shell or similar):",
          `   mosh ${hostname} -- tmux attach -t familiar`,
          "",
          "3. Or via plain SSH:",
          `   ssh ${hostname} -t 'tmux attach -t familiar'`,
          "",
          "Tips:",
          "  - Mosh handles spotty connections better than SSH",
          "  - Blink Shell (iOS) has native Mosh support",
          "  - The tmux session persists even if you disconnect",
        ].join("\n");
        setMessages((prev) => [...prev, sysMsg(mobileText)]);
        return true;
      }

      // Unknown slash command
      setMessages((prev) => [
        ...prev,
        sysMsg(`Unknown command: ${trimmed}. Type /help for available commands.`),
      ]);
      return true;
    },
    [gateway, app, setMessages, setStreamText, sendMessage, sessionKey, services, coachMode, setCoachMode, switchTheme, themeName, availableThemes, sessionMgr]
  );

  return { handleCommand };
}
