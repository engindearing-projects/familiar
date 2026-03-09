// Familiar TUI theme — semantic colors, branding
// 9-token schema: primary, primaryDim, accent, warning, error, text, textMuted, textDim, surface

import { existsSync, readFileSync, readdirSync, mkdirSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME || "/tmp";
const FAMILIAR_HOME = process.env.FAMILIAR_HOME || process.env.COZYTERM_HOME || process.env.ENGIE_HOME || join(HOME, ".familiar");
const THEMES_DIR = join(FAMILIAR_HOME, "themes");
const CONFIG_PATH = join(FAMILIAR_HOME, "config.json");

// Built-in theme presets
export const themes = {
  familiar: {
    primary: "#06b6d4",      // cyan — branding, active elements
    primaryDim: "#0891b2",   // dimmer cyan — labels
    accent: "#22c55e",       // green — success, healthy
    warning: "#eab308",      // yellow — warnings, unread
    error: "#ef4444",        // red — errors, unhealthy
    text: "#f9fafb",         // white — primary text
    textMuted: "#6b7280",    // gray — secondary text
    textDim: "#374151",      // dark gray — borders, separators
    surface: "#1f2937",      // dark bg for cards/panels
  },
  catppuccin: {
    primary: "#89b4fa",
    primaryDim: "#74c7ec",
    accent: "#a6e3a1",
    warning: "#f9e2af",
    error: "#f38ba8",
    text: "#cdd6f4",
    textMuted: "#6c7086",
    textDim: "#45475a",
    surface: "#1e1e2e",
  },
  dracula: {
    primary: "#bd93f9",
    primaryDim: "#6272a4",
    accent: "#50fa7b",
    warning: "#f1fa8c",
    error: "#ff5555",
    text: "#f8f8f2",
    textMuted: "#6272a4",
    textDim: "#44475a",
    surface: "#282a36",
  },
  nord: {
    primary: "#88c0d0",
    primaryDim: "#81a1c1",
    accent: "#a3be8c",
    warning: "#ebcb8b",
    error: "#bf616a",
    text: "#eceff4",
    textMuted: "#7b88a1",
    textDim: "#434c5e",
    surface: "#2e3440",
  },
  "tokyo-night": {
    primary: "#7aa2f7",
    primaryDim: "#7dcfff",
    accent: "#9ece6a",
    warning: "#e0af68",
    error: "#f7768e",
    text: "#c0caf5",
    textMuted: "#565f89",
    textDim: "#3b4261",
    surface: "#1a1b26",
  },
  gruvbox: {
    primary: "#83a598",
    primaryDim: "#458588",
    accent: "#b8bb26",
    warning: "#fabd2f",
    error: "#fb4934",
    text: "#ebdbb2",
    textMuted: "#928374",
    textDim: "#504945",
    surface: "#282828",
  },
  solarized: {
    primary: "#268bd2",
    primaryDim: "#2aa198",
    accent: "#859900",
    warning: "#b58900",
    error: "#dc322f",
    text: "#839496",
    textMuted: "#586e75",
    textDim: "#073642",
    surface: "#002b36",
  },
  "rose-pine": {
    primary: "#c4a7e7",
    primaryDim: "#9ccfd8",
    accent: "#31748f",
    warning: "#f6c177",
    error: "#eb6f92",
    text: "#e0def4",
    textMuted: "#6e6a86",
    textDim: "#26233a",
    surface: "#191724",
  },
  "one-dark": {
    primary: "#61afef",
    primaryDim: "#56b6c2",
    accent: "#98c379",
    warning: "#e5c07b",
    error: "#e06c75",
    text: "#abb2bf",
    textMuted: "#5c6370",
    textDim: "#3e4451",
    surface: "#282c34",
  },
  monokai: {
    primary: "#66d9ef",
    primaryDim: "#a6e22e",
    accent: "#a6e22e",
    warning: "#e6db74",
    error: "#f92672",
    text: "#f8f8f2",
    textMuted: "#75715e",
    textDim: "#49483e",
    surface: "#272822",
  },
  "github-dark": {
    primary: "#58a6ff",
    primaryDim: "#79c0ff",
    accent: "#3fb950",
    warning: "#d29922",
    error: "#f85149",
    text: "#c9d1d9",
    textMuted: "#8b949e",
    textDim: "#30363d",
    surface: "#0d1117",
  },
};

// Keep "default" as alias for "familiar"
themes.default = themes.familiar;

/**
 * Load custom themes from ~/.familiar/themes/*.json
 * Each file should export the 9-token schema.
 */
function loadCustomThemes() {
  if (!existsSync(THEMES_DIR)) return;
  try {
    const files = readdirSync(THEMES_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = readFileSync(join(THEMES_DIR, file), "utf-8");
        const parsed = JSON.parse(raw);
        const name = file.replace(/\.json$/, "");
        // Validate: must have at least primary + text
        if (parsed.primary && parsed.text) {
          // Merge with familiar defaults for any missing tokens
          themes[name] = { ...themes.familiar, ...parsed };
        }
      } catch {
        // Skip invalid theme files
      }
    }
  } catch {
    // Skip if directory can't be read
  }
}

loadCustomThemes();

/**
 * Read saved theme from ~/.familiar/config.json
 */
function getSavedTheme() {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, "utf-8");
      const config = JSON.parse(raw);
      return config.theme || null;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

/**
 * Resolve active theme name from env var or config file.
 * Priority: FAMILIAR_THEME env > ENGIE_THEME env > config.json > "familiar"
 */
function resolveThemeName() {
  return process.env.FAMILIAR_THEME || process.env.ENGIE_THEME || getSavedTheme() || "familiar";
}

// Active theme — mutable for runtime switching
let _activeThemeName = resolveThemeName();
let _activeTheme = themes[_activeThemeName] || themes.familiar;

// Theme change listeners (for re-render triggers)
const _listeners = new Set();

export function getThemeName() {
  return _activeThemeName;
}

export function getTheme() {
  return _activeTheme;
}

/**
 * Switch the active theme at runtime.
 * Returns true if switched, false if theme not found.
 */
export function setTheme(name) {
  const t = themes[name];
  if (!t) return false;
  _activeThemeName = name;
  _activeTheme = t;
  // Rebuild colors proxy
  _rebuildColors();
  // Notify listeners
  for (const fn of _listeners) fn(name);
  return true;
}

export function onThemeChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * List all available theme names (built-in + custom).
 */
export function listThemes() {
  return Object.keys(themes).filter((k) => k !== "default");
}

// --- Backward-compat colors object ---
// Uses a Proxy so color values always reflect the active theme

function _buildColors() {
  return {
    cyan: _activeTheme.primary,
    cyanDim: _activeTheme.primaryDim,
    gray: _activeTheme.textMuted,
    grayDim: _activeTheme.textDim,
    white: _activeTheme.text,
    red: _activeTheme.error,
    yellow: _activeTheme.warning,
    green: _activeTheme.accent,
    // Semantic aliases (new code should prefer these)
    primary: _activeTheme.primary,
    primaryDim: _activeTheme.primaryDim,
    accent: _activeTheme.accent,
    warning: _activeTheme.warning,
    error: _activeTheme.error,
    text: _activeTheme.text,
    textMuted: _activeTheme.textMuted,
    textDim: _activeTheme.textDim,
    surface: _activeTheme.surface,
  };
}

let _colorsCache = _buildColors();

function _rebuildColors() {
  const fresh = _buildColors();
  // Mutate in-place so existing imports see updates
  for (const key of Object.keys(fresh)) {
    _colorsCache[key] = fresh[key];
  }
}

export const colors = _colorsCache;

// Active theme export (reads through to mutable state)
export const theme = new Proxy({}, {
  get(_, prop) {
    return _activeTheme[prop];
  },
});

// Environment detection
export const NO_COLOR = !!process.env.NO_COLOR || process.env.TERM === "dumb";
export const NARROW = (process.stdout.columns || 80) < 60;

export const VERSION = "1.0.0";

/**
 * Time-of-day greeting.
 * Morning (5-12), Afternoon (12-17), Evening (17-21), Night (21-5)
 */
export function getGreetingTime() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return "Morning";
  if (hour >= 12 && hour < 17) return "Afternoon";
  if (hour >= 17 && hour < 21) return "Evening";
  return "Night";
}
