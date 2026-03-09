// Shared constants — used by CLI, TUI, and mobile app.

export const VERSION = "0.5.0";

export const DEFAULT_GATEWAY_PORT = 18789;
export const DEFAULT_PROXY_PORT = 18791;
export const DEFAULT_ACTIVITY_PORT = 18790;
export const DEFAULT_OLLAMA_PORT = 11434;

export const SESSION_KEY = "familiar:cli:main";
export const DAEMON_SESSION_KEY = "familiar:daemon:main";
export const PLANNER_SESSION_KEY = "familiar:planner:main";
export const MOBILE_SESSION_KEY = "familiar:mobile:main";

export const SERVICE_NAMES = {
  gateway: "com.familiar.gateway",
  claudeProxy: "com.familiar.claude-proxy",
  activitySync: "com.familiar.activity-sync",
  telegramPush: "com.familiar.telegram-push",
  daemon: "com.familiar.daemon",
  ollama: "homebrew.mxcl.ollama",
};

export const HEALTH_URLS = {
  claudeProxy: `http://localhost:${DEFAULT_PROXY_PORT}/health`,
  activitySync: `http://localhost:${DEFAULT_ACTIVITY_PORT}/health`,
  ollama: `http://localhost:${DEFAULT_OLLAMA_PORT}/api/tags`,
};

// Gateway WebSocket client identity
export const CLIENT_ID = "familiar-ui";
export const CLIENT_VERSION = "1.0.0";
export const PROTOCOL_VERSION = 3;


export const CONNECT_TIMEOUT_MS = 15_000;
export const REQUEST_TIMEOUT_MS = 10_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
export const DAEMON_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes between daemon actions

// Observation types for the memory system
export const OBSERVATION_TYPES = [
  "task_update",
  "code_change",
  "decision",
  "blocker",
  "preference",
  "insight",
  "chat_exchange",
];

// Observation sources
export const OBSERVATION_SOURCES = [
  "jira_cron",
  "chat",
  "cli-oneshot",
  "tui",
  "mcp",
  "code_review",
  "manual",
  "mobile",
];
