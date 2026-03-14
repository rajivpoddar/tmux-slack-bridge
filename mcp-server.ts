/**
 * MCP Server for the tmux-slack-bridge SQLite database.
 *
 * Provides tools for querying Slack message history, threads, and stats
 * from the bridge's SQLite database. Runs as a stdio MCP server.
 *
 * Tools:
 * - bridge_search_messages: Search messages by keyword, user, channel, date
 * - bridge_list_threads: List threads by status or recency
 * - bridge_get_thread: Get all messages in a specific thread
 * - bridge_get_stats: Get message/thread statistics
 * - bridge_update_thread: Update thread topic or status
 *
 * Usage:
 *   tsx mcp-server.ts
 *
 * Claude Code config (~/.claude/settings.json):
 *   "mcpServers": {
 *     "slack-bridge": {
 *       "command": "tsx",
 *       "args": ["mcp-server.ts"],
 *       "cwd": "/Users/rajiv/Downloads/projects/tmux-slack-bridge"
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  searchMessages,
  listThreads,
  getThreadMessages,
  getStats,
  updateThread,
  closeDb,
} from "./db.ts";

const server = new McpServer({
  name: "slack-bridge",
  version: "1.0.0",
});

// --- Tools ---

server.tool(
  "bridge_search_messages",
  "Search Slack messages tracked by the bridge. Filter by keyword, user, channel, or date range.",
  {
    query: z.string().optional().describe("Keyword to search in message body"),
    user: z.string().optional().describe("User ID or name to filter by"),
    channel_id: z.string().optional().describe("Channel ID to filter by"),
    since: z.string().optional().describe("ISO date — only messages after this date (e.g. '2026-03-09')"),
    limit: z.number().optional().default(20).describe("Max results (default 20)"),
  },
  async (params) => {
    const results = searchMessages({
      query: params.query,
      userId: params.user,
      channelId: params.channel_id,
      since: params.since,
      limit: params.limit,
    });

    if (results.length === 0) {
      return { content: [{ type: "text", text: "No messages found matching criteria." }] };
    }

    const formatted = results.map((m) =>
      `[${m.created_at}] ${m.user_name} (${m.channel_type} ${m.channel_id})${m.thread_ts ? ` thread:${m.thread_ts}` : ""}:\n${m.body}`
    ).join("\n\n---\n\n");

    return {
      content: [{ type: "text", text: `Found ${results.length} message(s):\n\n${formatted}` }],
    };
  }
);

server.tool(
  "bridge_list_threads",
  "List Slack threads tracked by the bridge. Filter by status (active/resolved/stale), channel, or date.",
  {
    status: z.enum(["active", "resolved", "stale"]).optional().describe("Thread status filter"),
    channel_id: z.string().optional().describe("Channel ID filter"),
    since: z.string().optional().describe("ISO date — only threads active after this date"),
    limit: z.number().optional().default(20).describe("Max results (default 20)"),
  },
  async (params) => {
    const threads = listThreads({
      status: params.status,
      channelId: params.channel_id,
      since: params.since,
      limit: params.limit,
    });

    if (threads.length === 0) {
      return { content: [{ type: "text", text: "No threads found matching criteria." }] };
    }

    const formatted = threads.map((t) =>
      `Thread ${t.thread_ts} (${t.channel_id}) — ${t.status}\n` +
      `  Started by: ${t.started_by_name || "unknown"}\n` +
      `  Topic: ${t.topic || "(none)"}\n` +
      `  Messages: ${t.message_count}\n` +
      `  First: ${t.first_message || "(empty)"}\n` +
      `  Last activity: ${t.last_activity}`
    ).join("\n\n");

    return {
      content: [{ type: "text", text: `Found ${threads.length} thread(s):\n\n${formatted}` }],
    };
  }
);

server.tool(
  "bridge_get_thread",
  "Get all messages in a specific Slack thread.",
  {
    thread_ts: z.string().describe("Thread timestamp (e.g. '1773036028.558669')"),
    channel_id: z.string().optional().describe("Channel ID (optional — narrows search)"),
  },
  async (params) => {
    const messages = getThreadMessages(params.thread_ts, params.channel_id);

    if (messages.length === 0) {
      return { content: [{ type: "text", text: `No messages found in thread ${params.thread_ts}.` }] };
    }

    const formatted = messages.map((m) =>
      `[${m.created_at}] ${m.user_name}:\n${m.body}`
    ).join("\n\n");

    return {
      content: [{
        type: "text",
        text: `Thread ${params.thread_ts} — ${messages.length} message(s):\n\n${formatted}`,
      }],
    };
  }
);

server.tool(
  "bridge_get_stats",
  "Get message and thread statistics from the bridge database.",
  {
    since: z.string().optional().describe("ISO date — stats since this date (e.g. '2026-03-09')"),
  },
  async (params) => {
    const stats = getStats(params.since);

    const channelLines = stats.messagesByChannel
      .map((c) => `  ${c.channel_id}: ${c.count}`)
      .join("\n");

    const userLines = stats.messagesByUser
      .map((u) => `  ${u.user_name}: ${u.count}`)
      .join("\n");

    const text = [
      `Total messages: ${stats.totalMessages}`,
      `Total threads: ${stats.totalThreads}`,
      `Active threads: ${stats.activeThreads}`,
      "",
      "Messages by channel:",
      channelLines || "  (none)",
      "",
      "Messages by user:",
      userLines || "  (none)",
    ].join("\n");

    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "bridge_update_thread",
  "Update a thread's topic or status (e.g. mark as resolved).",
  {
    thread_ts: z.string().describe("Thread timestamp"),
    channel_id: z.string().describe("Channel ID"),
    topic: z.string().optional().describe("Set thread topic"),
    status: z.enum(["active", "resolved", "stale"]).optional().describe("Set thread status"),
  },
  async (params) => {
    updateThread(params.thread_ts, params.channel_id, {
      topic: params.topic,
      status: params.status,
    });

    return {
      content: [{
        type: "text",
        text: `Thread ${params.thread_ts} updated.${params.topic ? ` Topic: "${params.topic}"` : ""}${params.status ? ` Status: ${params.status}` : ""}`,
      }],
    };
  }
);

// --- Start ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

process.on("SIGINT", () => {
  closeDb();
  process.exit(0);
});

main().catch((err) => {
  console.error("MCP server error:", err);
  closeDb();
  process.exit(1);
});
