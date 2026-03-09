// Unified theme — shared across CLI TUI and mobile app.
// Mobile imports these values into React Native StyleSheets.
// CLI TUI uses them as hex colors for Ink's color prop.

export const colors = {
  // Backgrounds (mobile only — terminal uses its own bg)
  bg: "#0f172a",           // slate-900
  bgLight: "#1e293b",      // slate-800
  bgLighter: "#334155",    // slate-700

  // Primary
  cyan: "#06b6d4",
  cyanDim: "#0891b2",

  // Text
  white: "#f9fafb",
  gray: "#94a3b8",         // slate-400 (mobile secondary text)
  grayMid: "#6b7280",      // gray-500 (TUI secondary)
  grayDim: "#64748b",      // slate-500 (placeholders)
  grayDimmer: "#374151",   // gray-800 (TUI dimmed)

  // Status
  green: "#22c55e",
  yellow: "#eab308",
  red: "#ef4444",

  // Code blocks (mobile)
  codeBg: "#1e293b",
  codeBorder: "#334155",
};

// Service health dot display
export const HEALTH_COLORS = {
  healthy: colors.green,
  unhealthy: colors.red,
  degraded: colors.yellow,
  unknown: colors.grayDim,
};
