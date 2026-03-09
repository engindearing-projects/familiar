import { useState, useEffect, useCallback } from "react";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { getThemeName, setTheme, onThemeChange, listThemes } from "../lib/theme.js";

const HOME = process.env.HOME || "/tmp";
const FAMILIAR_HOME = process.env.FAMILIAR_HOME || process.env.COZYTERM_HOME || process.env.ENGIE_HOME || join(HOME, ".familiar");
const CONFIG_PATH = join(FAMILIAR_HOME, "config.json");

/**
 * Save theme choice to ~/.familiar/config.json (merges with existing config).
 */
function persistTheme(name) {
  try {
    let config = {};
    if (existsSync(CONFIG_PATH)) {
      config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    }
    config.theme = name;
    const dir = dirname(CONFIG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  } catch {
    // Non-critical — theme still works for this session
  }
}

/**
 * Theme hook — reads/writes active theme, triggers re-render on change.
 *
 * Returns { themeName, switchTheme(name), availableThemes }
 */
export function useTheme() {
  const [themeName, setThemeName] = useState(getThemeName);

  useEffect(() => {
    return onThemeChange((name) => {
      setThemeName(name);
    });
  }, []);

  const switchTheme = useCallback((name) => {
    const ok = setTheme(name);
    if (ok) {
      persistTheme(name);
    }
    return ok;
  }, []);

  const availableThemes = listThemes();

  return { themeName, switchTheme, availableThemes };
}
