// Destructive command detection for coaching mode inline warnings.
// Complementary to the existing PreToolUse hooks — these show friendly
// warnings in the TUI rather than blocking execution.

const PATTERNS = [
  { re: /\brm\s+(-[a-z]*r[a-z]*\s+|.*-rf\b)/, warning: "Recursive delete — this removes files permanently" },
  { re: /\bsudo\s+rm\b/, warning: "Deleting files as root — be very careful" },
  { re: /\bmkfs\b/, warning: "This formats a disk — all data will be lost" },
  { re: /\bdd\s+.*of=/, warning: "dd writes raw data to a device — can overwrite your disk" },
  { re: /\bchmod\s+777\b/, warning: "chmod 777 makes files world-writable — security risk" },
  { re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, warning: "This is a fork bomb — it will crash your system" },
  { re: /\bkill\s+-9\b/, warning: "kill -9 forces a process to stop immediately — no cleanup" },
  { re: /\bcurl\b.*\|\s*\bbash\b/, warning: "Piping curl to bash runs remote code — verify the source first" },
  { re: /\bwget\b.*\|\s*\bbash\b/, warning: "Piping wget to bash runs remote code — verify the source first" },
  { re: /\bgit\s+push\s+--force\b/, warning: "Force push overwrites remote history — others may lose work" },
  { re: /\bgit\s+reset\s+--hard\b/, warning: "Hard reset discards all uncommitted changes" },
  { re: /\bgit\s+clean\s+-[a-z]*f/, warning: "git clean -f permanently deletes untracked files" },
  { re: /\b>\s*\/dev\/sd[a-z]/, warning: "Writing directly to a block device — data loss risk" },
  { re: /\bdrop\s+(table|database)\b/i, warning: "This permanently deletes database objects" },
  { re: /\btruncate\s+table\b/i, warning: "This removes all rows from the table" },
];

/**
 * Check a text string for destructive command patterns.
 * @param {string} text
 * @returns {{ dangerous: boolean, warning: string }}
 */
export function checkCommand(text) {
  for (const { re, warning } of PATTERNS) {
    if (re.test(text)) {
      return { dangerous: true, warning };
    }
  }
  return { dangerous: false, warning: "" };
}
