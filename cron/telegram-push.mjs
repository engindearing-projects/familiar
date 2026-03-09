#!/usr/bin/env bun
// Telegram push notifier — polls unread activity and sends a summary via Telegram Bot API.
// Run standalone: bun cron/telegram-push.mjs
// Or schedule via launchd every 30 minutes.

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "../config/familiar.json");
const ACTIVITY_URL = process.env.ACTIVITY_URL || "http://localhost:18790";

// Read bot token from gateway config (same source as gateway)
let BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
let CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN) {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    BOT_TOKEN = cfg.channels?.telegram?.botToken;
  } catch (e) {
    console.error("Failed to read gateway config:", e.message);
  }
}

// Default chat ID from paired Telegram DM session
if (!CHAT_ID) {
  const sessionPaths = [
    resolve(__dirname, "../config/agents/familiar/sessions/sessions.json"),
  ];
  for (const sessPath of sessionPaths) {
    if (CHAT_ID) break;
    try {
      if (!existsSync(sessPath)) continue;
      const sessions = JSON.parse(readFileSync(sessPath, "utf8"));
      for (const sess of Object.values(sessions)) {
        const from = sess.origin?.from;
        if (from?.startsWith("familiar:telegram:")) {
          CHAT_ID = from.split(":")[2];
        } else if (from?.startsWith("telegram:")) {
          CHAT_ID = from.split(":")[1];
          break;
        }
      }
    } catch {
      // Try next path
    }
  }
}

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("Could not resolve Telegram bot token or chat ID");
  console.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars, or ensure gateway config is set up");
  process.exit(1);
}

// Platforms to skip — CLI activity is already visible on screen
const SKIP_PLATFORMS = new Set(["cli"]);

async function main() {
  // Check unread activity for telegram platform
  const res = await fetch(`${ACTIVITY_URL}/unread?platform=telegram`, {
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    console.error(`Activity server returned ${res.status}`);
    process.exit(1);
  }

  const { unreadCount, latest } = await res.json();

  if (unreadCount === 0) {
    console.log("No unread activity for telegram");
    return;
  }

  // Filter out CLI and other skip-listed platforms — you already see those on screen
  const meaningful = latest.filter((i) => !SKIP_PLATFORMS.has(i.platform));

  // Always advance the cursor even if we skip everything
  const maxId = Math.max(...latest.map((i) => i.id));

  if (meaningful.length === 0) {
    console.log(`Skipped ${unreadCount} CLI-only updates`);
    await advanceCursor(maxId);
    return;
  }

  // Build concise summary — group by platform, one line each
  const esc = (s) => String(s).replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
  const byPlatform = {};
  for (const item of meaningful) {
    if (!byPlatform[item.platform]) byPlatform[item.platform] = [];
    byPlatform[item.platform].push(item);
  }

  const lines = [];
  for (const [platform, items] of Object.entries(byPlatform)) {
    // Show only assistant responses, skip user echo
    const responses = items.filter((i) => i.role === "assistant");
    if (responses.length === 0) continue;

    for (const item of responses.slice(0, 3)) {
      // Extract first meaningful line as summary, skip boilerplate
      const firstLine = item.content.split("\n").find((l) => l.trim().length > 10) || item.content;
      const preview = esc(firstLine.trim().slice(0, 120));
      lines.push(`• _${esc(platform)}_: ${preview}${firstLine.length > 120 ? "\\.\\.\\." : ""}`);
    }

    if (responses.length > 3) {
      lines.push(`  _\\+${esc(String(responses.length - 3))} more_`);
    }
  }

  if (lines.length === 0) {
    console.log("No meaningful updates to push");
    await advanceCursor(maxId);
    return;
  }

  const skipped = unreadCount - meaningful.length;
  const header = skipped > 0
    ? `*${esc(String(meaningful.length))} update${meaningful.length !== 1 ? "s" : ""}* \\(${esc(String(skipped))} cli skipped\\)`
    : `*${esc(String(meaningful.length))} update${meaningful.length !== 1 ? "s" : ""}*`;

  const text = [header, "", ...lines].join("\n");

  // Send via Telegram Bot API
  const sendRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "MarkdownV2",
      disable_notification: false,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!sendRes.ok) {
    const err = await sendRes.text();
    console.error("Telegram send failed:", err);
    process.exit(1);
  }

  console.log(`Sent ${meaningful.length} updates to Telegram (skipped ${skipped} CLI)`);
  await advanceCursor(maxId);
}

async function advanceCursor(maxId) {
  await fetch(`${ACTIVITY_URL}/cursor`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ platform: "telegram", last_seen_id: maxId }),
    signal: AbortSignal.timeout(3000),
  });
}

main().catch((err) => {
  console.error("telegram-push error:", err.message);
  process.exit(1);
});
