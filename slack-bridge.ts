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

import { App } from "@slack/bolt";
import type { GenericMessageEvent } from "@slack/types";
import { type WebClient } from "@slack/web-api";
import { execSync } from "child_process";
import { writeFileSync, readFileSync, existsSync, appendFileSync } from "fs";
import { recordMessage, setThreadOwner, getThreadOwner, getDb, closeDb } from "./db.ts";

// Channel log files — shared read-only feeds for all slots / PM
const CHANNEL_LOG_FILE = "/tmp/heydonna-dev-channel.log";
const HEYDONNA_DEV_CHANNEL = "C0ALZJHGE49";
const FEEDBACK_LOG_FILE = "/tmp/heydonna-feedback-channel.log";
const HEYDONNA_FEEDBACK_CHANNEL = "C0AGWPQFKHA";

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

const POLL_INTERVAL_MS = Number(process.env.SLACK_HISTORY_POLL_INTERVAL_MS || 30000);
const POLL_LOOKBACK_SECONDS = Number(process.env.SLACK_HISTORY_POLL_LOOKBACK_SECONDS || 300);
let lastEventAt = Date.now();
let pollInFlight = false;
let pollTimer: NodeJS.Timeout | null = null;

function messageKey(channel: string, ts: string): string {
  return `${channel}:${ts}`;
}

const seenMessages = new Set<string>();

function wasRecorded(channel: string, ts: string): boolean {
  if (seenMessages.has(messageKey(channel, ts))) return true;
  try {
    const row = getDb()
      .prepare("SELECT 1 FROM messages WHERE channel_id = ? AND ts = ? LIMIT 1")
      .get(channel, ts);
    if (row) {
      seenMessages.add(messageKey(channel, ts));
      return true;
    }
  } catch (err: any) {
    log(`⚠️ DB duplicate-check error for ${channel}/${ts}: ${err.message}`);
  }
  return false;
}

function markSeen(channel: string, ts: string) {
  seenMessages.add(messageKey(channel, ts));
  if (seenMessages.size > 5000) {
    for (const key of seenMessages) {
      seenMessages.delete(key);
      if (seenMessages.size <= 4000) break;
    }
  }
}

function latestRecordedTs(channel: string): string | null {
  try {
    const row = getDb()
      .prepare("SELECT ts FROM messages WHERE channel_id = ? ORDER BY CAST(ts AS REAL) DESC LIMIT 1")
      .get(channel) as { ts?: string | null } | undefined;
    return row?.ts || null;
  } catch (err: any) {
    log(`⚠️ DB latest-ts error for ${channel}: ${err.message}`);
    return null;
  }
}

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
// Our team bot user IDs — messages from these bots are "self" messages.
// We allow them through (ignoreSelf: false) but only route to panes when
// they contain @mentions or @channel (to enable PM broadcasting).
const OWN_BOT_USER_IDS = new Set([
  "U0ALEAYCAUT",  // Dhruva PM
  "U0AMETSAHC0",  // Rohini SD
  "U0ALE8Z8X2P",  // Hasta QA
  "U0AMEUQ8DR6",  // Ashwini JD
  "U0AMEUZPQ5N",  // Chitra QA
]);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN!,
  // Allow our own bot's messages through — handler at line 321 filters
  // self-messages that don't contain routable @mentions. Required for
  // PM health check pings (Dhruva PM bot @mentioning slot bots).
  ignoreSelf: false,
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
        (file as any).plain_text ||
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
function sendToPane(text: string, target?: string) {
  const pane = target || TMUX_TARGET;
  const escaped = shellEscape(text);
  execSync(
    `tmux send-keys -t ${pane} -l ${escaped} && sleep 0.5 && tmux send-keys -t ${pane} Enter`,
    { timeout: 5000 }
  );
}

// PR-merge auto-cleanup REMOVED 2026-05-11 18:50 IST per Rajiv directive
// (thread `1778505655.944859`): *"the slack bridge is still injecting
// /cleanup-pr into pm pane after every merge. it's not needed anymore.
// remove it."* CP #13 + pm-context-injector.sh's `[PR_MERGED_DETECTED]`
// system-reminder is now the sole canonical trigger for the cleanup-pr
// skill on merge. Prior gradual removal (commit 3809949 2026-05-09)
// commented out the call site; this removes the function + the supporting
// regex constants entirely so a stale watch-mode daemon cannot resurrect
// the inject. See git history (3809949 + this commit) for archaeology.

// Our bot user ID — used to distinguish our @mentions from other bots' @mentions
const OUR_BOT_USER_ID = "U0ALEAYCAUT";

// Bot user ID → tmux pane address mapping for thread ownership inference
const BOT_TO_PANE: Record<string, string> = {
  "U0ALEAYCAUT": "0:0.0",  // Dhruva PM
  "U0AMETSAHC0": "0:0.1",  // Rohini SD (slot 1)
  "U0ALE8Z8X2P": "0:0.2",  // Hasta QA (slot 2)
  "U0AMEUQ8DR6": "0:0.3",  // Ashwini JD (slot 3)
  "U0AMEUZPQ5N": "0:0.4",  // Chitra QA (slot 4)
};

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
async function handleSlackMessage(
  message: GenericMessageEvent,
  client: WebClient,
  source: "socket" | "poll" = "socket"
): Promise<boolean> {
  const msg = message as GenericMessageEvent;
  if (!msg.text && !msg.files) return false;
  if (!SLACK_CHANNELS.has(msg.channel)) return false;

  // 1. DB duplicate check first
  if (wasRecorded(msg.channel, msg.ts)) {
    log(`↩️ Skipped duplicate ${source} message ${msg.channel}/${msg.ts}`);
    return false;
  }

  const text = msg.text || "";

  // Self-message guard: prevent infinite forwarding loops.
  // - PM bot (U0ALEAYCAUT) messages → only forward if they have @mentions (prevents PM→PM loop)
  // - Slot bots (Rohini, Hasta, Ashwini, Chitra) → ALWAYS forward to PM
  //   These are status updates, QA reports, etc. that the PM needs to see.
  //   Rajiv directive (2026-03-22): "whenever a dev/qa posts on heydonna-dev channel,
  //   the slack bridge should forward it to the PM"
  // - Non-team bot messages → only forward in BOT_ALLOWED_CHANNELS
  if ("bot_id" in msg && msg.bot_id) {
    if (!BOT_ALLOWED_CHANNELS.has(msg.channel)) {
      markSeen(msg.channel, msg.ts);
      return false;
    }
    const isPmBot = msg.user === "U0ALEAYCAUT";  // Dhruva PM
    const isSlotBot = msg.user && OWN_BOT_USER_IDS.has(msg.user) && !isPmBot;
    if (isPmBot) {
      // PM bot → only forward if has @mentions or @channel (prevents PM→PM loop)
      const hasRoutableContent = /<@U0(AMETSAHC0|ALE8Z8X2P|AMEUQ8DR6|AMEUZPQ5N)>/.test(text)
        || /<!channel>|<!here>/.test(text);
      if (!hasRoutableContent) {
        markSeen(msg.channel, msg.ts);
        return false;
      }
    }
    // Slot bots → fall through (always forwarded to PM pane)
  }

  // Note: Previously filtered messages @mentioning non-bot users (lines 266-269).
  // Removed because it dropped ALL messages with @mentions (including human users
  // like @Abilaasha, @Rajiv), not just bot mentions. The SLACK_CHANNELS filter
  // on line 258 already limits which channels are forwarded — no secondary filter needed.

  // Bot/app messages (e.g., HeyDonna Alerts) have bot_id but no user field.
  // Extract name from bot_profile or username, and use bot_id as userId fallback.
  const isBotMessage = "bot_id" in msg && msg.bot_id && !msg.user;
  const effectiveUserId = msg.user || (msg as any).bot_id || "unknown_bot";
  const userName = isBotMessage
    ? ((msg as any).bot_profile?.name || (msg as any).username || `bot:${(msg as any).bot_id}`)
    : await getUserName(client, msg.user);
  const time = formatTimestamp(msg.ts);

  log(`📩 Received ${source} from ${userName} at ${time}: ${text}`);

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

    // Record in SQLite — use effectiveUserId for bot messages (bot_id fallback)
    try {
      recordMessage({
        ts: msg.ts,
        threadTs: isThreaded ? msg.thread_ts! : null,
        channelId: msg.channel,
        channelType: isDM ? "dm" : "channel",
        userId: effectiveUserId,
        userName,
        body: text,
        hasImages: imagePaths.length > 0,
        hasSnippets: snippets.length > 0,
      });
      markSeen(msg.channel, msg.ts);
    } catch (dbErr: any) {
      log(`⚠️ DB record error: ${dbErr.message}`);
    }

    // Append to shared channel log files (slots / PM can read anytime)
    if (msg.channel === HEYDONNA_DEV_CHANNEL) {
      try {
        const logLine = `[${time}] ${userName}: ${text}\n`;
        appendFileSync(CHANNEL_LOG_FILE, logLine);
      } catch {}
    } else if (msg.channel === HEYDONNA_FEEDBACK_CHANNEL) {
      try {
        const threadMarker = isThreaded ? ` (thread ${msg.thread_ts})` : "";
        const logLine = `[${time}] ${userName}${threadMarker}: ${text}\n`;
        appendFileSync(FEEDBACK_LOG_FILE, logLine);
      } catch {}
    }

    // Route via MoP for @mention-based per-slot delivery
    // For channel messages with @mentions, MoP routes to the mentioned slot(s)
    // For DMs or messages without slot mentions, sends directly to PM pane
    const hasSlotMentions = !isDM && (/<@U0(AMETSAHC0|ALE8Z8X2P|AMEUQ8DR6|AMEUZPQ5N)>/.test(text) || /<!channel>|<!here>/.test(text));
    if (hasSlotMentions) {
      const routed = await routeViaMoP(text, fullMessage, msg.channel);
      if (routed) {
        // MoP routed successfully — record thread ownership for first slot mentioned
        const slotMatch = text.match(/<@(U0(?:AMETSAHC0|ALE8Z8X2P|AMEUQ8DR6|AMEUZPQ5N))>/);
        if (slotMatch && BOT_TO_PANE[slotMatch[1]]) {
          setThreadOwner(msg.channel, threadTs!, BOT_TO_PANE[slotMatch[1]], slotMatch[1]);
          log(`📌 Thread ${threadTs} owned by pane ${BOT_TO_PANE[slotMatch[1]]}`);
        }
      } else {
        // Fallback: send to PM pane directly
        sendToPane(fullMessage);
        log(`✅ Forwarded to ${TMUX_TARGET} (MoP fallback)`);
      }
    } else {
      // Check thread ownership — route replies to the thread owner's pane
      const threadOwnerPane = isThreaded && msg.thread_ts
        ? getThreadOwner(msg.channel, msg.thread_ts)
        : null;

      if (threadOwnerPane && threadOwnerPane !== TMUX_TARGET) {
        // Route to thread owner pane AND PM pane (PM always gets a copy)
        sendToPane(fullMessage, threadOwnerPane);
        sendToPane(fullMessage);
        log(`✅ Forwarded to ${threadOwnerPane} (thread owner) + ${TMUX_TARGET} (PM copy)`);
      } else {
        sendToPane(fullMessage);
        log(`✅ Forwarded to ${TMUX_TARGET}`);
      }
    }

    // PR-merge /cleanup-pr inject REMOVED — see top-of-file comment block.
    // Sole canonical trigger is pm-context-injector.sh `[PR_MERGED_DETECTED]`.
  } catch (err: any) {
    log(`❌ tmux error: ${err.message}`);
  }
  return true;
}

app.message(async ({ message, client }) => {
  lastEventAt = Date.now();
  await handleSlackMessage(message as GenericMessageEvent, client, "socket");
});

// --- Self-Message Router ---
// Bolt's app.message() silently drops the bot's own messages (no ignoreSelf override).
// Use a raw 'message' event to catch our own bot messages that need @channel/@mention routing.
app.event("message", async ({ event, client }) => {
  const msg = event as any;
  // Only handle messages from our own bots that Bolt's app.message() dropped
  if (!("bot_id" in msg) || !msg.bot_id) return;
  if (!msg.user || !OWN_BOT_USER_IDS.has(msg.user)) return;
  if (!SLACK_CHANNELS.has(msg.channel)) return;

  const text = msg.text || "";
  // Only route if message has @mentions or @channel — prevents infinite loops
  const hasRoutableContent = /<@U0(AMETSAHC0|ALE8Z8X2P|AMEUQ8DR6|AMEUZPQ5N)>/.test(text)
    || /<!channel>|<!here>/.test(text);
  if (!hasRoutableContent) return;

  log(`📩 [self-route] Own bot message with routing: ${text.slice(0, 100)}`);

  // Record thread ownership — if a bot starts or replies in a thread, that bot's pane owns it
  const threadTs = msg.thread_ts || msg.ts;
  const botPane = BOT_TO_PANE[msg.user];
  if (botPane) {
    setThreadOwner(msg.channel, threadTs, botPane, msg.user);
    log(`📌 [self-route] Thread ${threadTs} owned by ${botPane} (${msg.user})`);
  }

  // Route via MoP for @mention-based delivery
  const userName = await getUserName(client, msg.user);
  const time = formatTimestamp(msg.ts);
  const fullMessage = `# slack-channel ${msg.channel} in thread ${threadTs} | ${userName} | ${time}\n${text}`;

  try {
    const routed = await routeViaMoP(text, fullMessage, msg.channel);
    if (routed) {
      log(`✅ [self-route] Routed via MoP`);
    } else {
      log(`⚠️ [self-route] MoP routing failed — skipping (self-messages don't go to PM pane)`);
    }
  } catch (err: any) {
    log(`❌ [self-route] Error: ${err.message}`);
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

async function pollSlackHistory(client: WebClient) {
  if (pollInFlight) return;
  pollInFlight = true;

  try {
    for (const channel of SLACK_CHANNELS) {
      const latestTs = latestRecordedTs(channel);
      const oldest = latestTs || String(Math.floor(Date.now() / 1000) - POLL_LOOKBACK_SECONDS);
      const result = await client.conversations.history({
        channel,
        oldest,
        inclusive: false,
        limit: 50,
      });

      const messages = (result.messages || [])
        .filter((m: any) => m.ts && (m.text || m.files))
        .sort((a: any, b: any) => Number(a.ts) - Number(b.ts));

      let handled = 0;
      for (const raw of messages) {
        const msg = { ...raw, channel } as unknown as GenericMessageEvent;
        if (wasRecorded(channel, msg.ts)) continue;
        if (await handleSlackMessage(msg, client, "poll")) {
          handled += 1;
        }
      }

      if (handled > 0) {
        log(`🧭 Poll recovered ${handled} message(s) from ${channel}`);
      }
    }
  } catch (err: any) {
    log(`⚠️ Slack history poll error: ${err.data?.error || err.message}`);
  } finally {
    pollInFlight = false;
  }
}

function startHistoryPoller(client: WebClient) {
  if (!Number.isFinite(POLL_INTERVAL_MS) || POLL_INTERVAL_MS <= 0) {
    log("🧭 Slack history poller disabled");
    return;
  }

  log(`🧭 Slack history poller every ${Math.round(POLL_INTERVAL_MS / 1000)}s`);
  pollTimer = setInterval(() => {
    const secondsSinceEvent = Math.round((Date.now() - lastEventAt) / 1000);
    log(`💓 Bridge heartbeat: ${secondsSinceEvent}s since last socket event`);
    void pollSlackHistory(client);
  }, POLL_INTERVAL_MS);
  pollTimer.ref();

  void pollSlackHistory(client);
}

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

process.on("unhandledRejection", (err: any) => {
  log(`❌ Unhandled rejection: ${err?.stack || err?.message || err}`);
});

process.on("uncaughtException", (err: any) => {
  log(`❌ Uncaught exception: ${err?.stack || err?.message || err}`);
  closeDb();
  process.exit(1);
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
  startHistoryPoller(app.client);
})();

// --- Test exports ---
export { wasRecorded, markSeen, latestRecordedTs };
export type { GenericMessageEvent };
