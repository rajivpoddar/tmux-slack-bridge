/**
 * SQLite database for tracking Slack messages, threads, and replies.
 *
 * Schema:
 * - messages: Every message forwarded through the bridge (inbound from Slack,
 *   outbound to Slack)
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
// Test override: set DB_PATH env to use a different database file (e.g. :memory: or temp path)
const DB_PATH = process.env.DB_PATH || join(__dirname, "bridge.db");

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

    -- Thread ownership: routes all thread replies to the pane that owns the thread
    CREATE TABLE IF NOT EXISTS thread_owners (
      channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      target_pane TEXT NOT NULL,
      owner_bot_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (channel_id, thread_ts)
    );
  `);

  // All legacy migrations run as one transaction so an interruption cannot
  // expose a partially migrated schema, partial dedup, or stale thread counts.
  const migrateLegacy = _db.transaction(() => {
    // Legacy databases predate the direction column; migrate before any index
    // or outbound write touches it.
    const messageColumns = _db.prepare("PRAGMA table_info(messages)").all() as Array<{
      name: string;
    }>;
    if (!messageColumns.some((column) => column.name === "direction")) {
      _db.exec(`
        ALTER TABLE messages
        ADD COLUMN direction TEXT NOT NULL DEFAULT 'inbound'
          CHECK(direction IN ('inbound', 'outbound'))
      `);
    }
    _db.exec(
      "CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction)"
    );

    // Dedup migration (2026-08-11 duplicate-injection fix): older databases
    // predate the unique (channel_id, ts) contract and contain duplicate rows
    // written by the check-then-insert race (socket vs poll / dual instances).
    // Keep the earliest row per (channel_id, ts), then enforce uniqueness so
    // `INSERT OR IGNORE` can act as the atomic claim going forward.
    const duplicateRows = _db
      .prepare(
        `SELECT COUNT(*) AS c FROM (
           SELECT 1 FROM messages GROUP BY channel_id, ts HAVING COUNT(*) > 1
         )`
      )
      .get() as { c: number };
    if (duplicateRows.c > 0) {
      const removed = _db
        .prepare(
          `DELETE FROM messages
           WHERE id NOT IN (SELECT MIN(id) FROM messages GROUP BY channel_id, ts)`
        )
        .run();
      console.warn(
        `[db] dedup migration removed ${removed.changes} duplicate message row(s)`
      );
      // Recompute thread counts from the surviving message rows so the
      // message_count metadata cannot retain a pre-dedup inflated value.
      _db.prepare(`
        UPDATE threads
        SET message_count = (
          SELECT COUNT(*) FROM messages m
          WHERE m.channel_id = threads.channel_id
            AND COALESCE(m.thread_ts, m.ts) = threads.thread_ts
        )
      `).run();
    }
    _db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_channel_ts ON messages(channel_id, ts)"
    );
  });
  migrateLegacy();

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
}): boolean {
  const db = getDb();

  // Atomic claim: INSERT OR IGNORE + the unique (channel_id, ts) index means
  // exactly one caller wins per Slack message. `changes === 1` is the claim;
  // a second socket/poll/instance handler for the same message loses here
  // instead of after a SELECT race. The thread upsert only runs on a claim so
  // duplicate deliveries never double-count thread activity.
  const insert = db.prepare(`
    INSERT OR IGNORE INTO messages (ts, thread_ts, channel_id, channel_type, user_id, user_name, body, has_images, has_snippets)
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
  if (insert.changes !== 1) return false;

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

  return true;
}

/**
 * Record a verified outbound message after Slack has accepted chat.postMessage.
 */
export function recordOutboundMessage(params: {
  ts: string;
  threadTs: string | null;
  channelId: string;
  channelType: "dm" | "channel";
  userId: string;
  userName: string;
  body: string;
}): boolean {
  const db = getDb();
  const insertOutbound = db.transaction((): boolean => {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO messages
        (ts, thread_ts, channel_id, channel_type, user_id, user_name, direction, body, has_images, has_snippets)
      VALUES (?, ?, ?, ?, ?, ?, 'outbound', ?, 0, 0)
    `).run(
      params.ts,
      params.threadTs,
      params.channelId,
      params.channelType,
      params.userId,
      params.userName,
      params.body
    );

    if (insert.changes !== 1) return false;
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
    return true;
  });
  if (insertOutbound()) return true;
  // Idempotent replay of the same Slack message identity is still a verified
  // success when the existing row is already the normalized outbound record.
  const existing = db
    .prepare(
      "SELECT direction FROM messages WHERE channel_id = ? AND ts = ? LIMIT 1"
    )
    .get(params.channelId, params.ts);
  if (!existing) return false;
  if (existing.direction === "outbound") {
    const row = db
      .prepare(
        `SELECT channel_type, thread_ts, user_id, user_name, body
         FROM messages WHERE channel_id = ? AND ts = ? LIMIT 1`
      )
      .get(params.channelId, params.ts) as
      | {
          channel_type: string;
          thread_ts: string | null;
          user_id: string;
          user_name: string;
          body: string;
        }
      | undefined;
    if (!row) return false;
    return (
      row.channel_type === params.channelType &&
      (row.thread_ts ?? null) === (params.threadTs ?? null) &&
      row.user_id === params.userId &&
      row.user_name === params.userName &&
      row.body === params.body
    );
  }
  // A concurrent inbound/poll handler recorded the same Slack message first.
  // Promote it to the verified outbound record atomically; the inbound claim
  // cannot win this update after the row was already persisted.
  const promoted = db
    .prepare(
      `UPDATE messages
       SET direction = 'outbound', channel_type = ?, thread_ts = ?,
           user_id = ?, user_name = ?, body = ?
       WHERE channel_id = ? AND ts = ? AND direction = 'inbound'`
    )
    .run(
      params.channelType,
      params.threadTs,
      params.userId,
      params.userName,
      params.body,
      params.channelId,
      params.ts
    );
  return promoted.changes === 1;
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
  direction: string;
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
    SELECT ts, thread_ts, channel_id, channel_type, direction, user_name, body, created_at
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
  direction: string;
  user_name: string;
  body: string;
  created_at: string;
}> {
  const db = getDb();

  if (channelId) {
    return db.prepare(`
      SELECT ts, channel_id, direction, user_name, body, created_at
      FROM messages
      WHERE thread_ts = ? AND channel_id = ?
      ORDER BY created_at ASC
    `).all(threadTs, channelId) as any[];
  }

  return db.prepare(`
    SELECT ts, channel_id, direction, user_name, body, created_at
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
 * Record thread ownership — which pane owns this thread.
 * Called when: (1) MoP routes a message to a slot, (2) a bot posts a new thread.
 * Uses INSERT OR IGNORE — first writer wins (thread creator owns it).
 */
export function setThreadOwner(channelId: string, threadTs: string, targetPane: string, ownerBotId?: string) {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO thread_owners (channel_id, thread_ts, target_pane, owner_bot_id)
    VALUES (?, ?, ?, ?)
  `).run(channelId, threadTs, targetPane, ownerBotId || null);
}

/**
 * Look up who owns a thread. Returns the target pane address (e.g. "0:0.1") or null.
 */
export function getThreadOwner(channelId: string, threadTs: string): string | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT target_pane FROM thread_owners WHERE channel_id = ? AND thread_ts = ?"
  ).get(channelId, threadTs) as { target_pane: string } | undefined;
  return row?.target_pane || null;
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
