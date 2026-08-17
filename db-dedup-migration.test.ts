/**
 * Regression test for the 2026-08-11 duplicate-injection fix.
 *
 * Simulates an existing database that predates the unique (channel_id, ts)
 * contract: duplicate rows exist from the check-then-insert race. Opening it
 * through db.ts must dedupe (keep the earliest row), create the unique index,
 * and make recordMessage() atomically claim each (channel_id, ts) exactly once.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_DB = join(tmpdir(), `bridge-test-dedup-migration-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

// Dynamic imports only: static ESM imports are hoisted above the env
// assignment and would open the real bridge.db instead of the test file.
let getDb: typeof import("./db.ts").getDb;
let recordMessage: typeof import("./db.ts").recordMessage;
let closeDb: typeof import("./db.ts").closeDb;

describe("legacy duplicate-row migration", () => {
  beforeAll(async () => {
    // Build the pre-fix schema WITHOUT the unique index, then insert
    // duplicate rows exactly like the old race produced.
    const raw = new Database(TEST_DB);
    raw.exec(`
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
    `);
    raw
      .prepare(
        `INSERT INTO messages (ts, thread_ts, channel_id, channel_type, user_id, user_name, body, has_images, has_snippets)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("600.001", null, "C0DEDUP", "channel", "U0TEST", "Tester", "dup-a", 0, 0);
    raw
      .prepare(
        `INSERT INTO messages (ts, thread_ts, channel_id, channel_type, user_id, user_name, body, has_images, has_snippets)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("600.001", null, "C0DEDUP", "channel", "U0TEST", "Tester", "dup-b", 0, 0);
    raw
      .prepare(
        `INSERT INTO messages (ts, thread_ts, channel_id, channel_type, user_id, user_name, body, has_images, has_snippets)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("600.001", null, "C0DEDUP", "channel", "U0TEST", "Tester", "dup-c", 0, 0);
    raw.close();

    const dbModule = await import("./db.ts");
    getDb = dbModule.getDb;
    recordMessage = dbModule.recordMessage;
    closeDb = dbModule.closeDb;
  });

  afterAll(() => {
    closeDb();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    if (existsSync(`${TEST_DB}-shm`)) unlinkSync(`${TEST_DB}-shm`);
    if (existsSync(`${TEST_DB}-wal`)) unlinkSync(`${TEST_DB}-wal`);
  });

  test("getDb dedupes legacy rows and enforces uniqueness", () => {
    const db = getDb();

    const rows = db
      .prepare(
        "SELECT COUNT(*) AS c FROM messages WHERE channel_id = 'C0DEDUP' AND ts = '600.001'"
      )
      .get() as { c: number };
    expect(rows.c).toBe(1);

    const index = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uq_messages_channel_ts'"
      )
      .get();
    expect(index).toBeTruthy();
  });

  test("recordMessage returns false for a replayed (channel, ts) after migration", () => {
    const first = recordMessage({
      ts: "600.002",
      threadTs: null,
      channelId: "C0DEDUP",
      channelType: "channel",
      userId: "U0TEST",
      userName: "Tester",
      body: "fresh",
      hasImages: false,
      hasSnippets: false,
    });
    const replayed = recordMessage({
      ts: "600.002",
      threadTs: null,
      channelId: "C0DEDUP",
      channelType: "channel",
      userId: "U0TEST",
      userName: "Tester",
      body: "replay",
      hasImages: false,
      hasSnippets: false,
    });
    expect(first).toBe(true);
    expect(replayed).toBe(false);
  });
});
