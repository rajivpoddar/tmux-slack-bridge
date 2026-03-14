/**
 * tmux-slack-bridge — Two-way relay between Slack and a tmux pane.
 *
 * Connects via Slack Socket Mode (WebSocket) and forwards incoming messages
 * from configured channels (DMs, public/private channels) and @mentions
 * to a configurable tmux pane via `tmux send-keys`. The target pane (e.g. Claude
 * Code PM session) processes the message and replies via its own Slack tools.
 *
 * Features:
 * - Adds user name and timestamp to every forwarded message
 * - Quotes the last thread message when replying in a thread
 * - Includes code snippets and file attachments
 * - Configurable tmux target (window:pane address)
 *
 * Usage:
 *   cp .env.example .env  # Fill in tokens
 *   npm start
 *
 * Or via the wrapper:
 *   ./slack-bridge.sh start
 */

import { App, type GenericMessageEvent } from "@slack/bolt";
import { type WebClient } from "@slack/web-api";
import { execSync } from "child_process";
import { writeFileSync, readFileSync, existsSync, appendFileSync } from "fs";
import { recordMessage, closeDb } from "./db.ts";

// Channel log file — shared read-only feed for all slots
const CHANNEL_LOG_FILE = "/tmp/heydonna-dev-channel.log";
const HEYDONNA_DEV_CHANNEL = "C0ALZJHGE49";

// --- Configuration ---
// SLACK_CHANNEL supports comma-separated list: "D0ADL956AJH,C0AGWPQFKHA"
const SLACK_CHANNELS = new Set(
  (process.env.SLACK_CHANNEL || "").split(",").map((s) => s.trim()).filter(Boolean)
);
const TMUX_TARGET = process.env.TMUX_TARGET || "0:0.0";

// Channels where bot messages are allowed through (e.g. #heydonna-alerts)
// All other channels still filter out bot messages to prevent forwarding loops.
const BOT_ALLOWED_CHANNELS = new Set(
  (process.env.SLACK_BOT_ALLOWED_CHANNELS || "").split(",").map((s) => s.trim()).filter(Boolean)
);

// --- Preflight checks ---
function checkTmux(): boolean {
  try {
    execSync("tmux list-sessions", { timeout: 3000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function checkPane(target: string): boolean {
  try {
    execSync(`tmux display-message -t ${target} -p "#S:#I.#P"`, {
      timeout: 3000,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

// --- Slack App ---
const app = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN!,
});

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function formatTimestamp(ts: string): string {
  const date = new Date(parseFloat(ts) * 1000);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Resolve a Slack user ID to their display name.
 */
async function getUserName(
  client: WebClient,
  userId: string
): Promise<string> {
  try {
    const result = await client.users.info({ user: userId });
    return (
      result.user?.profile?.display_name ||
      result.user?.real_name ||
      result.user?.name ||
      userId
    );
  } catch {
    return userId;
  }
}

/**
 * Fetch the parent message of a thread to quote it.
 * For threaded replies, gets the last message before the current one.
 */
async function getThreadContext(
  client: WebClient,
  channel: string,
  threadTs: string,
  currentTs: string
): Promise<string | null> {
  try {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 20,
    });

    const messages = result.messages || [];
    let lastMessage: string | null = null;
    for (const msg of messages) {
      if (msg.ts === currentTs) break;
      if ("text" in msg && msg.text) {
        lastMessage = msg.text;
      }
    }
    return lastMessage;
  } catch {
    return null;
  }
}

/**
 * Extract code snippets from message files (Slack code snippets, text files).
 */
async function getSnippets(
  client: WebClient,
  message: GenericMessageEvent
): Promise<string[]> {
  const snippets: string[] = [];

  if (!message.files || message.files.length === 0) return snippets;

  for (const file of message.files) {
    if (
      file.filetype === "text" ||
      file.filetype === "javascript" ||
      file.filetype === "typescript" ||
      file.filetype === "python" ||
      file.filetype === "json" ||
      file.filetype === "yaml" ||
      file.filetype === "markdown" ||
      file.filetype === "shell" ||
      file.filetype === "post" ||
      file.mode === "snippet"
    ) {
      const content =
        file.preview ||
        file.plain_text ||
        (file.url_private
          ? await fetchFileContent(file.url_private)
          : null);

      if (content) {
        const label = file.title || file.name || `snippet.${file.filetype}`;
        snippets.push(
          `[file: ${label}]\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\``
        );
      }
    }
  }

  return snippets;
}

/**
 * Download file content from Slack (authenticated).
 */
async function fetchFileContent(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      },
    });
    if (!response.ok) return null;
    const text = await response.text();
    return text.slice(0, 2000);
  } catch {
    return null;
  }
}

/**
 * Download image files from Slack and save to /tmp.
 * Returns array of local file paths for Claude Code to read with the Read tool.
 */
async function downloadImages(
  message: GenericMessageEvent
): Promise<string[]> {
  const paths: string[] = [];

  if (!message.files || message.files.length === 0) return paths;

  for (const file of message.files) {
    const mimetype = file.mimetype || "";
    if (!mimetype.startsWith("image/")) continue;

    const downloadUrl = file.url_private_download || file.url_private;
    if (!downloadUrl) continue;

    try {
      const ext = file.filetype || mimetype.split("/")[1] || "png";
      const safeName = (file.name || `image.${ext}`).replace(/[^a-zA-Z0-9._-]/g, "_");
      const filename = `/tmp/slack-img-${Date.now()}-${safeName}`;

      const response = await fetch(downloadUrl, {
        headers: {
          Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        },
      });

      if (!response.ok) {
        log(`⚠️ Failed to download image ${safeName}: ${response.status}`);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(filename, buffer);
      log(`📎 Saved image: ${filename} (${buffer.length} bytes)`);
      paths.push(filename);
    } catch (err: any) {
      log(`⚠️ Image download error: ${err.message}`);
    }
  }

  return paths;
}

/**
 * Send text to the target tmux pane via send-keys.
 * Uses -l (literal) to prevent tmux from interpreting special characters.
 */
function sendToPane(text: string) {
  const escaped = shellEscape(text);
  execSync(
    `tmux send-keys -t ${TMUX_TARGET} -l ${escaped} && sleep 0.3 && tmux send-keys -t ${TMUX_TARGET} Enter`,
    { timeout: 5000 }
  );
}

// Our bot user ID — used to distinguish our @mentions from other bots' @mentions
const OUR_BOT_USER_ID = "U0ALEAYCAUT";

// MoP routing endpoint (for @mention-based per-slot routing)
const MOP_ROUTE_URL = process.env.MOP_ROUTE_URL || "http://localhost:3100/api/slack-route";

/**
 * Route a message via MoP for @mention-based per-slot delivery.
 * Falls back to direct tmux send if MoP is unavailable.
 */
async function routeViaMoP(rawText: string, formatted: string, channel: string): Promise<boolean> {
  try {
    const resp = await fetch(MOP_ROUTE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: rawText, formatted, channel }),
    });
    if (resp.ok) {
      const result = await resp.json() as { routed?: string[]; targets?: string[] };
      log(`🔀 MoP routed to ${(result.targets || []).join(", ")}`);
      return true;
    }
    log(`⚠️ MoP route failed: ${resp.status}`);
    return false;
  } catch {
    log(`⚠️ MoP unreachable — falling back to direct tmux`);
    return false;
  }
}

// --- Message Handler ---
app.message(async ({ message, client }) => {
  const msg = message as GenericMessageEvent;
  if (!msg.text && !msg.files) return;
  if (!SLACK_CHANNELS.has(msg.channel)) return;
  if ("bot_id" in msg && msg.bot_id && !BOT_ALLOWED_CHANNELS.has(msg.channel)) return;

  const text = msg.text || "";

  // Note: Previously filtered messages @mentioning non-bot users (lines 266-269).
  // Removed because it dropped ALL messages with @mentions (including human users
  // like @Abilaasha, @Rajiv), not just bot mentions. The SLACK_CHANNELS filter
  // on line 258 already limits which channels are forwarded — no secondary filter needed.
  const userName = await getUserName(client, msg.user);
  const time = formatTimestamp(msg.ts);

  log(`📩 Received from ${userName} at ${time}: ${text}`);

  try {
    const parts: string[] = [];

    // 1. Header with user and timestamp — all context in one bracket
    // Always include thread_ts so PM can reply in-thread for any message.
    // For top-level messages, thread_ts = msg.ts (the message's own ts becomes the thread anchor).
    // For threaded replies, thread_ts = msg.thread_ts (the parent message ts).
    const isThreaded = !!(msg.thread_ts && msg.thread_ts !== msg.ts);
    const threadTs = isThreaded ? msg.thread_ts : msg.ts;
    // Use "slack-dm" for DMs, "slack-channel" for public/private channels
    const isDM = msg.channel.startsWith("D");
    const prefix = isDM ? "slack-dm" : `slack-channel ${msg.channel}`;
    parts.push(
      `# ${prefix} in thread ${threadTs} | ${userName} | ${time}`
    );

    // 2. Thread context — quote last message if threaded reply
    if (msg.thread_ts && msg.thread_ts !== msg.ts) {
      const lastThreadMsg = await getThreadContext(
        client,
        msg.channel,
        msg.thread_ts,
        msg.ts
      );
      if (lastThreadMsg) {
        const quoted =
          lastThreadMsg.length > 200
            ? lastThreadMsg.slice(0, 200) + "..."
            : lastThreadMsg;
        parts.push(`> ${quoted.replace(/\n/g, "\n> ")}`);
      }
    }

    // 3. The actual message
    parts.push(text);

    // 4. Image attachments — download to /tmp for Claude Code to read
    const imagePaths = await downloadImages(msg);
    if (imagePaths.length > 0) {
      for (const path of imagePaths) {
        parts.push(`[attached image: ${path}]`);
      }
    }

    // 5. Snippets / file attachments
    const snippets = await getSnippets(client, msg);
    if (snippets.length > 0) {
      parts.push(...snippets);
    }

    const fullMessage = parts.filter(Boolean).join("\n");

    // Append to inject queue — channel + thread_ts of the forwarded message.
    // Uses a FIFO queue (array) so multiple rapid messages don't overwrite each other.
    // The Stop hook (reply-to-slack.sh) pops the oldest entry when replying.
    const QUEUE_FILE = "/tmp/slack-bridge-last-inject.json";
    const queue = existsSync(QUEUE_FILE)
      ? (() => { try { const d = JSON.parse(readFileSync(QUEUE_FILE, "utf8")); return Array.isArray(d) ? d : [d]; } catch { return []; } })()
      : [];
    queue.push({ channel: msg.channel, thread_ts: threadTs });
    writeFileSync(QUEUE_FILE, JSON.stringify(queue));

    // Record in SQLite
    try {
      recordMessage({
        ts: msg.ts,
        threadTs: isThreaded ? msg.thread_ts! : null,
        channelId: msg.channel,
        channelType: isDM ? "dm" : "channel",
        userId: msg.user,
        userName,
        body: text,
        hasImages: imagePaths.length > 0,
        hasSnippets: snippets.length > 0,
      });
    } catch (dbErr: any) {
      log(`⚠️ DB record error: ${dbErr.message}`);
    }

    // Append to shared channel log file (slots can read anytime)
    if (msg.channel === HEYDONNA_DEV_CHANNEL) {
      try {
        const logLine = `[${time}] ${userName}: ${text}\n`;
        appendFileSync(CHANNEL_LOG_FILE, logLine);
      } catch {}
    }

    // Route via MoP for @mention-based per-slot delivery
    // For channel messages with @mentions, MoP routes to the mentioned slot(s)
    // For DMs or messages without slot mentions, sends directly to PM pane
    const hasSlotMentions = !isDM && /<@U0(AMETSAHC0|ALE8Z8X2P|AMEUQ8DR6|AMEUZPQ5N)>/.test(text);
    if (hasSlotMentions) {
      const routed = await routeViaMoP(text, fullMessage, msg.channel);
      if (!routed) {
        // Fallback: send to PM pane directly
        sendToPane(fullMessage);
        log(`✅ Forwarded to ${TMUX_TARGET} (MoP fallback)`);
      }
    } else {
      sendToPane(fullMessage);
      log(`✅ Forwarded to ${TMUX_TARGET}`);
    }
  } catch (err: any) {
    log(`❌ tmux error: ${err.message}`);
  }
});

// --- @mention Handler ---
// Handles @HeyDonna PM mentions in any channel the bot is a member of.
// Unlike the message handler, this fires on app_mention events regardless of SLACK_CHANNELS.
app.event("app_mention", async ({ event, client }) => {
  // Skip if already handled by the message handler (DM channels)
  if (SLACK_CHANNELS.has(event.channel)) return;

  const text = event.text || "";
  const userName = await getUserName(client, event.user);
  const time = formatTimestamp(event.ts);

  log(`📩 @mention from ${userName} at ${time} in ${event.channel}: ${text}`);

  try {
    const parts: string[] = [];

    const isThreaded = !!(event.thread_ts && event.thread_ts !== event.ts);
    const threadTs = isThreaded ? event.thread_ts : event.ts;
    parts.push(
      `# slack-mention in ${event.channel} thread ${threadTs} | ${userName} | ${time}`
    );

    // Strip the bot @mention from the text for cleaner forwarding
    const cleanText = text.replace(/<@[A-Z0-9]+>/g, "").trim();
    if (cleanText) parts.push(cleanText);

    const fullMessage = parts.filter(Boolean).join("\n");

    const QUEUE_FILE = "/tmp/slack-bridge-last-inject.json";
    const queue = existsSync(QUEUE_FILE)
      ? (() => { try { const d = JSON.parse(readFileSync(QUEUE_FILE, "utf8")); return Array.isArray(d) ? d : [d]; } catch { return []; } })()
      : [];
    queue.push({ channel: event.channel, thread_ts: threadTs });
    writeFileSync(QUEUE_FILE, JSON.stringify(queue));

    // Record in SQLite
    try {
      recordMessage({
        ts: event.ts,
        threadTs: isThreaded ? event.thread_ts! : null,
        channelId: event.channel,
        channelType: "mention",
        userId: event.user,
        userName,
        body: cleanText,
        hasImages: false,
        hasSnippets: false,
      });
    } catch (dbErr: any) {
      log(`⚠️ DB record error: ${dbErr.message}`);
    }

    sendToPane(fullMessage);
    log(`✅ @mention forwarded to ${TMUX_TARGET}`);
  } catch (err: any) {
    log(`❌ tmux error: ${err.message}`);
  }
});

// --- Lifecycle ---
process.on("SIGINT", async () => {
  log("🛑 Shutting down...");
  closeDb();
  await app.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  log("🛑 Shutting down (SIGTERM)...");
  closeDb();
  await app.stop();
  process.exit(0);
});

(async () => {
  // Preflight: check tmux is running and target pane exists
  if (!checkTmux()) {
    console.error("❌ tmux is not running. Start a tmux session first.");
    process.exit(1);
  }
  if (!checkPane(TMUX_TARGET)) {
    console.error(
      `❌ tmux pane ${TMUX_TARGET} not found. Check TMUX_TARGET in .env`
    );
    process.exit(1);
  }

  await app.start();
  log("🔗 tmux-slack-bridge running");
  log(`   Slack channels: ${[...SLACK_CHANNELS].join(", ")}`);
  log(`   Bot-allowed:    ${BOT_ALLOWED_CHANNELS.size > 0 ? [...BOT_ALLOWED_CHANNELS].join(", ") : "(none)"}`);
  log(`   @mentions:      enabled (any channel bot is in)`);
  log(`   tmux target:    ${TMUX_TARGET}`);
})();
