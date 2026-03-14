/**
 * SQLite database for tracking Slack messages, threads, and replies.
 *
 * Schema:
 * - messages: Every message forwarded through the bridge (inbound from Slack)
 * - threads: Thread-level metadata (topic, status, message count)
 *
 * Used by:
 * - slack-bridge.ts (writes on every forwarded message)
 * - mcp-server.ts (reads for PM queries)
 */

import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "bridge.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  // Create tables if they don't exist
  _db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      thread_ts TEXT,
      channel_id TEXT NOT NULL,
      channel_type TEXT NOT NULL CHECK(channel_type IN ('dm', 'channel', 'mention')),
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'inbound' CHECK(direction IN ('inbound', 'outbound')),
      body TEXT NOT NULL,
      has_images INTEGER NOT NULL DEFAULT 0,
      has_snippets INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_ts);
    CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);

    CREATE TABLE IF NOT EXISTS threads (
      thread_ts TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      topic TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'resolved', 'stale')),
      started_by TEXT,
      started_by_name TEXT,
      first_message TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      last_activity TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (thread_ts, channel_id)
    );

    CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status);
    CREATE INDEX IF NOT EXISTS idx_threads_activity ON threads(last_activity);
  `);

  return _db;
}

/**
 * Record an inbound message from Slack.
 */
export function recordMessage(params: {
  ts: string;
  threadTs: string | null;
  channelId: string;
  channelType: "dm" | "channel" | "mention";
  userId: string;
  userName: string;
  body: string;
  hasImages: boolean;
  hasSnippets: boolean;
}) {
  const db = getDb();

  // Insert the message
  db.prepare(`
    INSERT INTO messages (ts, thread_ts, channel_id, channel_type, user_id, user_name, body, has_images, has_snippets)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.ts,
    params.threadTs,
    params.channelId,
    params.channelType,
    params.userId,
    params.userName,
    params.body,
    params.hasImages ? 1 : 0,
    params.hasSnippets ? 1 : 0
  );

  // Upsert the thread
  const effectiveThreadTs = params.threadTs || params.ts;
  const existing = db.prepare(
    "SELECT message_count FROM threads WHERE thread_ts = ? AND channel_id = ?"
  ).get(effectiveThreadTs, params.channelId) as { message_count: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE threads
      SET message_count = message_count + 1,
          last_activity = datetime('now'),
          status = 'active'
      WHERE thread_ts = ? AND channel_id = ?
    `).run(effectiveThreadTs, params.channelId);
  } else {
    db.prepare(`
      INSERT INTO threads (thread_ts, channel_id, started_by, started_by_name, first_message, message_count)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(
      effectiveThreadTs,
      params.channelId,
      params.userId,
      params.userName,
      params.body.slice(0, 200)
    );
  }
}

/**
 * Search messages by keyword.
 */
export function searchMessages(params: {
  query?: string;
  channelId?: string;
  userId?: string;
  limit?: number;
  since?: string; // ISO date string
}): Array<{
  ts: string;
  thread_ts: string | null;
  channel_id: string;
  channel_type: string;
  user_name: string;
  body: string;
  created_at: string;
}> {
  const db = getDb();
  const conditions: string[] = [];
  const args: any[] = [];

  if (params.query) {
    conditions.push("body LIKE ?");
    args.push(`%${params.query}%`);
  }
  if (params.channelId) {
    conditions.push("channel_id = ?");
    args.push(params.channelId);
  }
  if (params.userId) {
    conditions.push("(user_id = ? OR user_name LIKE ?)");
    args.push(params.userId, `%${params.userId}%`);
  }
  if (params.since) {
    conditions.push("created_at >= ?");
    args.push(params.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit || 20;

  return db.prepare(`
    SELECT ts, thread_ts, channel_id, channel_type, user_name, body, created_at
    FROM messages
    ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...args, limit) as any[];
}

/**
 * List threads by status or recency.
 */
export function listThreads(params: {
  status?: "active" | "resolved" | "stale";
  channelId?: string;
  limit?: number;
  since?: string;
}): Array<{
  thread_ts: string;
  channel_id: string;
  topic: string | null;
  status: string;
  started_by_name: string | null;
  first_message: string | null;
  message_count: number;
  last_activity: string;
  created_at: string;
}> {
  const db = getDb();
  const conditions: string[] = [];
  const args: any[] = [];

  if (params.status) {
    conditions.push("status = ?");
    args.push(params.status);
  }
  if (params.channelId) {
    conditions.push("channel_id = ?");
    args.push(params.channelId);
  }
  if (params.since) {
    conditions.push("last_activity >= ?");
    args.push(params.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit || 20;

  return db.prepare(`
    SELECT thread_ts, channel_id, topic, status, started_by_name, first_message,
           message_count, last_activity, created_at
    FROM threads
    ${where}
    ORDER BY last_activity DESC
    LIMIT ?
  `).all(...args, limit) as any[];
}

/**
 * Get all messages in a thread.
 */
export function getThreadMessages(threadTs: string, channelId?: string): Array<{
  ts: string;
  channel_id: string;
  user_name: string;
  body: string;
  created_at: string;
}> {
  const db = getDb();

  if (channelId) {
    return db.prepare(`
      SELECT ts, channel_id, user_name, body, created_at
      FROM messages
      WHERE thread_ts = ? AND channel_id = ?
      ORDER BY created_at ASC
    `).all(threadTs, channelId) as any[];
  }

  return db.prepare(`
    SELECT ts, channel_id, user_name, body, created_at
    FROM messages
    WHERE thread_ts = ?
    ORDER BY created_at ASC
  `).all(threadTs) as any[];
}

/**
 * Update a thread's topic or status.
 */
export function updateThread(
  threadTs: string,
  channelId: string,
  updates: { topic?: string; status?: "active" | "resolved" | "stale" }
) {
  const db = getDb();
  const sets: string[] = [];
  const args: any[] = [];

  if (updates.topic !== undefined) {
    sets.push("topic = ?");
    args.push(updates.topic);
  }
  if (updates.status !== undefined) {
    sets.push("status = ?");
    args.push(updates.status);
  }

  if (sets.length === 0) return;

  args.push(threadTs, channelId);
  db.prepare(`
    UPDATE threads SET ${sets.join(", ")} WHERE thread_ts = ? AND channel_id = ?
  `).run(...args);
}

/**
 * Get message statistics.
 */
export function getStats(since?: string): {
  totalMessages: number;
  totalThreads: number;
  activeThreads: number;
  messagesByChannel: Array<{ channel_id: string; count: number }>;
  messagesByUser: Array<{ user_name: string; count: number }>;
} {
  const db = getDb();
  const sinceClause = since ? "WHERE created_at >= ?" : "";
  const sinceArgs = since ? [since] : [];

  const totalMessages = (db.prepare(
    `SELECT COUNT(*) as count FROM messages ${sinceClause}`
  ).get(...sinceArgs) as any).count;

  const totalThreads = (db.prepare(
    `SELECT COUNT(*) as count FROM threads ${sinceClause}`
  ).get(...sinceArgs) as any).count;

  const activeThreads = (db.prepare(
    "SELECT COUNT(*) as count FROM threads WHERE status = 'active'"
  ).get() as any).count;

  const messagesByChannel = db.prepare(`
    SELECT channel_id, COUNT(*) as count FROM messages ${sinceClause}
    GROUP BY channel_id ORDER BY count DESC LIMIT 10
  `).all(...sinceArgs) as any[];

  const messagesByUser = db.prepare(`
    SELECT user_name, COUNT(*) as count FROM messages ${sinceClause}
    GROUP BY user_name ORDER BY count DESC LIMIT 10
  `).all(...sinceArgs) as any[];

  return { totalMessages, totalThreads, activeThreads, messagesByChannel, messagesByUser };
}

/**
 * Close the database connection.
 */
export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
