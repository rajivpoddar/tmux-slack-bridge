/**
 * tmux-slack-bridge — Two-way relay between Slack DMs and a tmux pane.
 *
 * Connects via Slack Socket Mode (WebSocket) and forwards incoming DM messages
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
import { writeFileSync } from "fs";

// --- Configuration ---
const SLACK_CHANNEL = process.env.SLACK_CHANNEL || "D0ADL956AJH";
const TMUX_TARGET = process.env.TMUX_TARGET || "0:0.0";

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

// --- Message Handler ---
app.message(async ({ message, client }) => {
  const msg = message as GenericMessageEvent;
  if (!msg.text && !msg.files) return;
  if (msg.channel !== SLACK_CHANNEL) return;
  if ("bot_id" in msg && msg.bot_id) return;

  const text = msg.text || "";
  const userName = await getUserName(client, msg.user);
  const time = formatTimestamp(msg.ts);

  log(`📩 Received from ${userName} at ${time}: ${text}`);

  try {
    const parts: string[] = [];

    // 1. Header with user and timestamp
    parts.push(
      `[slack] message from ${userName} at ${time}. reply back on slack dm.`
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
    sendToPane(fullMessage);
    log(`✅ Forwarded to ${TMUX_TARGET}`);
  } catch (err: any) {
    log(`❌ tmux error: ${err.message}`);
  }
});

// --- Lifecycle ---
process.on("SIGINT", async () => {
  log("🛑 Shutting down...");
  await app.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  log("🛑 Shutting down (SIGTERM)...");
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
  log(`   Slack channel: ${SLACK_CHANNEL}`);
  log(`   tmux target:   ${TMUX_TARGET}`);
})();
