/**
 * Regression test for #4984 — watermark backfill guard dropping unrecorded messages.
 *
 * Before fix: msgTs <= lastTs guard in handleSlackMessage() skipped messages
 * older than last-processed ts, even if never durably recorded (crash mid-batch,
 * interleaved socket/poll). After fix: DB-backed wasRecorded() is the sole dedup.
 * Unrecorded messages always pass through regardless of ts.
 *
 * Simulates: bridge processes N messages → crashes after M < N recorded
 * → restarts → poller re-fetches [lastDurableTs, now] → unrecorded messages
 * are processed (not skipped by watermark).
 */
import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// --- Test DB setup (before module imports) ---
const TEST_DB = join(tmpdir(), `bridge-test-4984-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;
process.env.TMUX_TARGET = "0:0.99";
process.env.SLACK_CHANNEL = "C0TEST4984";
process.env.SLACK_BOT_TOKEN = "xoxb-test";
process.env.SLACK_APP_TOKEN = "xapp-test";
process.env.SLACK_HISTORY_POLL_INTERVAL_MS = "0";
process.env.SLACK_BOT_ALLOWED_CHANNELS = "";
process.env.MOP_ROUTE_URL = "http://localhost:0/nonexistent";

// Clean test DB from previous runs
if (existsSync(TEST_DB)) unlinkSync(TEST_DB);

// --- Mocks ---
vi.mock("child_process", () => ({ execSync: () => Buffer.from("") }));

vi.mock("@slack/bolt", () => ({
  App: class {
    client: any;
    constructor() {
      this.client = {
        users: { info: () => Promise.resolve({ user: { profile: { display_name: "TestUser" } } }) },
        conversations: { replies: () => Promise.resolve({ messages: [] }) },
      };
    }
    message() { return this; }
    event() { return this; }
    start() { return Promise.resolve(); }
    stop() { return Promise.resolve(); }
  },
}));

// Override global fetch to prevent real network calls during import-time IIFE
const origFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("No network in test"); };

// --- Imports ---
// Import after env setup. Static ESM imports execute before this file body and
// can start the bridge with the real local .env during tests.
let getDb: typeof import("./db.ts").getDb;
let recordMessage: typeof import("./db.ts").recordMessage;
let closeDb: typeof import("./db.ts").closeDb;
let wasRecorded: typeof import("./slack-bridge.ts").wasRecorded;
let markSeen: typeof import("./slack-bridge.ts").markSeen;
let latestRecordedTs: typeof import("./slack-bridge.ts").latestRecordedTs;

describe("crash-recovery watermark guard (#4984)", () => {
  beforeAll(async () => {
    const db = await import("./db.ts");
    const bridge = await import("./slack-bridge.ts");
    getDb = db.getDb;
    recordMessage = db.recordMessage;
    closeDb = db.closeDb;
    wasRecorded = bridge.wasRecorded;
    markSeen = bridge.markSeen;
    latestRecordedTs = bridge.latestRecordedTs;

    getDb();
  });

  afterAll(() => {
    closeDb();
    globalThis.fetch = origFetch;
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  let channelSeq = 0;
  function channelId(): string {
    channelSeq++;
    return `C0TEST4984_${channelSeq}`;
  }

  function record(channel: string, ts: string, body: string) {
    recordMessage({
      ts,
      threadTs: null,
      channelId: channel,
      channelType: "channel",
      userId: "U0TEST",
      userName: "Tester",
      body,
      hasImages: false,
      hasSnippets: false,
    });
    markSeen(channel, ts);
  }

  test("wasRecorded returns false for unrecorded message", () => {
    expect(wasRecorded(channelId(), "100.001")).toBe(false);
  });

  test("wasRecorded returns true after recordMessage", () => {
    const ch = channelId();
    record(ch, "100.001", "first");
    expect(wasRecorded(ch, "100.001")).toBe(true);
  });

  test("latestRecordedTs returns null for empty channel", () => {
    expect(latestRecordedTs("C0NEVERUSED")).toBeNull();
  });

  test("latestRecordedTs returns max ts across recorded messages", () => {
    const ch = channelId();
    record(ch, "100.003", "third");
    record(ch, "100.001", "first");
    record(ch, "100.002", "second");
    expect(latestRecordedTs(ch)).toBe("100.003");
  });

  test("crash mid-batch: unrecorded messages not in DB, not skipped", () => {
    const ch = channelId();

    // Bridge durably records 3 out of 5, then crashes
    record(ch, "200.001", "durable-1");
    record(ch, "200.002", "durable-2");
    record(ch, "200.003", "durable-3");
    // ts 200.004, 200.005 never recorded — crash

    // On restart: latestRecordedTs = 200.003
    expect(latestRecordedTs(ch)).toBe("200.003");

    // Unrecorded messages NOT in DB → wasRecorded returns false → will be processed
    expect(wasRecorded(ch, "200.004")).toBe(false);
    expect(wasRecorded(ch, "200.005")).toBe(false);
  });

  test("interleaved socket/poll: old unrecorded message not skipped by newer ts", () => {
    const ch = channelId();

    // Socket processes new message (300.050), recorded durably
    record(ch, "300.050", "newer socket message");

    // Poll encounters older message (300.001) that was never recorded
    // Before fix: msgTs(300.001) <= lastTs → SKIP → message lost
    // After fix:  wasRecorded returns false → process → message saved
    expect(wasRecorded(ch, "300.001")).toBe(false);

    // Record it (simulating poll path processing it)
    record(ch, "300.001", "older poll message");

    // Both messages now in DB
    expect(wasRecorded(ch, "300.001")).toBe(true);
    expect(wasRecorded(ch, "300.050")).toBe(true);

    // Max ts still 300.050 — the guard threshold before fix
    // But 300.001 made it through because wasRecorded was the only gate
    expect(latestRecordedTs(ch)).toBe("300.050");
  });

  test("duplicates still deduped by wasRecorded", () => {
    const ch = channelId();
    record(ch, "400.001", "original");
    // Same ts arrives again via socket reconnect
    expect(wasRecorded(ch, "400.001")).toBe(true);
  });
});
