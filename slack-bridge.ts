/**
 * Slack DM Bridge — Two-way relay between Slack DMs and Claude Code PM pane.
 *
 * Connects via Slack Socket Mode (WebSocket) and forwards incoming DM messages
 * to the PM's tmux pane (0:0.0) via `tmux send-keys`. Claude Code processes the
 * message naturally and replies via its Slack MCP tools.
 *
 * Features:
 * - Adds user name and timestamp to every forwarded message
 * - Quotes the last thread message when replying in a thread
 * - Includes code snippets/file attachments in the forwarded message
 *
 * Usage:
 *   SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... npm start
 *
 * Or via the wrapper:
 *   ./slack-bridge.sh start
 */

import { App, type GenericMessageEvent } from "@slack/bolt";
import { type WebClient } from "@slack/web-api";
import { execSync } from "child_process";

// --- Configuration ---
const PM_CHANNEL = process.env.PM_CHANNEL || "D0ADL956AJH"; // Rajiv's DM channel
const PM_PANE = process.env.PM_PANE || "0:0.0"; // PM tmux pane

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
async function getUserName(client: WebClient, userId: string): Promise<string> {
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
    // Find the message just before the current one in the thread
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
    // Code snippets and text files
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
      // Try to get content from preview or download
      const content =
        file.preview ||
        file.plain_text ||
        (file.url_private ? await fetchFileContent(client, file.url_private) : null);

      if (content) {
        const label = file.title || file.name || `snippet.${file.filetype}`;
        snippets.push(`[file: ${label}]\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\``);
      }
    }
  }

  return snippets;
}

/**
 * Download file content from Slack (authenticated).
 */
async function fetchFileContent(
  client: WebClient,
  url: string
): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      },
    });
    if (!response.ok) return null;
    const text = await response.text();
    return text.slice(0, 2000); // Cap at 2KB
  } catch {
    return null;
  }
}

/**
 * Send text to the PM tmux pane via send-keys.
 * Uses -l (literal) to prevent tmux from interpreting special characters.
 */
function sendToPane(text: string) {
  const escaped = shellEscape(text);
  execSync(
    `tmux send-keys -t ${PM_PANE} -l ${escaped} && sleep 0.3 && tmux send-keys -t ${PM_PANE} Enter`,
    { timeout: 5000 }
  );
}

// --- Message Handler ---
app.message(async ({ message, client }) => {
  // Only process text messages in the PM's DM channel
  const msg = message as GenericMessageEvent;
  if (!msg.text && !msg.files) return;
  if (msg.channel !== PM_CHANNEL) return;
  if ("bot_id" in msg && msg.bot_id) return; // Skip bot's own messages

  const text = msg.text || "";
  const userName = await getUserName(client, msg.user);
  const time = formatTimestamp(msg.ts);

  log(`📩 Received from ${userName} at ${time}: ${text}`);

  try {
    // Build the forwarded message
    const parts: string[] = [];

    // 1. Header with user and timestamp
    parts.push(`[slack] message from ${userName} at ${time}. reply back on slack dm.`);

    // 2. Thread context — quote last message if this is a threaded reply
    if (msg.thread_ts && msg.thread_ts !== msg.ts) {
      const lastThreadMsg = await getThreadContext(
        client,
        msg.channel,
        msg.thread_ts,
        msg.ts
      );
      if (lastThreadMsg) {
        // Truncate long quotes
        const quoted = lastThreadMsg.length > 200
          ? lastThreadMsg.slice(0, 200) + "..."
          : lastThreadMsg;
        parts.push(`> ${quoted.replace(/\n/g, "\n> ")}`);
      }
    }

    // 3. The actual message
    parts.push(text);

    // 4. Snippets / file attachments
    const snippets = await getSnippets(client, msg);
    if (snippets.length > 0) {
      parts.push(...snippets);
    }

    const fullMessage = parts.filter(Boolean).join("\n");
    sendToPane(fullMessage);
    log(`✅ Forwarded to PM pane ${PM_PANE}`);
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
  await app.start();
  log("🔗 Slack DM bridge running");
  log(`   Channel: ${PM_CHANNEL}`);
  log(`   PM Pane: ${PM_PANE}`);
})();
