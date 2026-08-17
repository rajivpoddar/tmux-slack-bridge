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
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// --- Test DB setup (before module imports) ---
const TEST_DB = join(tmpdir(), `bridge-test-4984-${Date.now()}.db`);
const TEST_QUEUE = join(tmpdir(), `bridge-test-queue-${Date.now()}.json`);
process.env.DB_PATH = TEST_DB;
process.env.BRIDGE_REPLY_CONTEXT_QUEUE_FILE = TEST_QUEUE;
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
let recordOutboundMessage: typeof import("./db.ts").recordOutboundMessage;
let closeDb: typeof import("./db.ts").closeDb;
let wasRecorded: typeof import("./slack-bridge.ts").wasRecorded;
let markSeen: typeof import("./slack-bridge.ts").markSeen;
let latestRecordedTs: typeof import("./slack-bridge.ts").latestRecordedTs;
let appendReplyContextQueue: typeof import("./slack-bridge.ts").appendReplyContextQueue;
let removeReplyContextQueue: typeof import("./slack-bridge.ts").removeReplyContextQueue;
let pollSlackHistory: typeof import("./slack-bridge.ts").pollSlackHistory;

describe("crash-recovery watermark guard (#4984)", () => {
  beforeAll(async () => {
    const db = await import("./db.ts");
    const bridge = await import("./slack-bridge.ts");
    getDb = db.getDb;
    recordMessage = db.recordMessage;
    recordOutboundMessage = db.recordOutboundMessage;
    closeDb = db.closeDb;
    wasRecorded = bridge.wasRecorded;
    markSeen = bridge.markSeen;
    latestRecordedTs = bridge.latestRecordedTs;
    appendReplyContextQueue = bridge.appendReplyContextQueue;
    removeReplyContextQueue = bridge.removeReplyContextQueue;
    pollSlackHistory = bridge.pollSlackHistory;

    getDb();
  });

  afterAll(() => {
    closeDb();
    globalThis.fetch = origFetch;
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    if (existsSync(`${TEST_DB}-shm`)) unlinkSync(`${TEST_DB}-shm`);
    if (existsSync(`${TEST_DB}-wal`)) unlinkSync(`${TEST_DB}-wal`);
    if (existsSync(TEST_QUEUE)) unlinkSync(TEST_QUEUE);
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

  test("latestRecordedTs ignores outbound rows so poller watermark stays inbound", () => {
    const ch = channelId();
    record(ch, "150.001", "inbound");
    recordOutboundMessage({
      ts: "150.999",
      threadTs: "150.001",
      channelId: ch,
      channelType: "channel",
      userId: "U0BRIDGE",
      userName: "Bridge Bot",
      body: "outbound reply",
    });

    expect(latestRecordedTs(ch)).toBe("150.001");
  });

  test("pollSlackHistory paginates past recorded outbound rows to recover inbound", async () => {
    const ch = "C0TEST4984";
    record(ch, "800.000000", "poll anchor");

    const outboundMessages = Array.from({ length: 50 }, (_, i) => {
      const ts = `900.${String(i + 1).padStart(6, "0")}`;
      recordOutboundMessage({
        ts,
        threadTs: "800.000000",
        channelId: ch,
        channelType: "channel",
        userId: "U0BRIDGE",
        userName: "Bridge Bot",
        body: `recorded outbound ${i + 1}`,
      });
      return { ts, text: `recorded outbound ${i + 1}`, user: "U0BRIDGE" };
    });

    const history = vi
      .fn()
      .mockResolvedValueOnce({
        messages: outboundMessages,
        response_metadata: { next_cursor: "page-2" },
      })
      .mockResolvedValueOnce({
        messages: [
          {
            ts: "850.000000",
            text: "unrecorded inbound behind outbound page",
            user: "U0TEST",
          },
        ],
        response_metadata: { next_cursor: "" },
      });
    const client = {
      users: {
        info: vi.fn().mockResolvedValue({
          user: { profile: { display_name: "Poll Tester" } },
        }),
      },
      conversations: {
        history,
        replies: vi.fn().mockResolvedValue({ messages: [] }),
      },
    };

    await pollSlackHistory(client as any);

    expect(history).toHaveBeenCalledTimes(2);
    expect(history.mock.calls[0]?.[0]).not.toHaveProperty("cursor");
    expect(history.mock.calls[1]?.[0]).toMatchObject({ cursor: "page-2" });
    expect(wasRecorded(ch, "850.000000")).toBe(true);
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

  test("appendReplyContextQueue records reply targets without changing routing state", () => {
    const queueFile = join(tmpdir(), `bridge-reply-context-${Date.now()}.json`);
    try {
      expect(appendReplyContextQueue("C0QUEUE", "700.001", "700.009", queueFile)).toBe(true);
      const queue = JSON.parse(readFileSync(queueFile, "utf8"));
      expect(queue).toEqual([
        { channel: "C0QUEUE", thread_ts: "700.001", ts: "700.009" },
      ]);
    } finally {
      if (existsSync(queueFile)) unlinkSync(queueFile);
    }
  });

  test("appendReplyContextQueue dedupes by message identity", () => {
    const queueFile = join(tmpdir(), `bridge-reply-context-${Date.now()}.json`);
    try {
      expect(appendReplyContextQueue("C0QUEUE", "700.001", "700.009", queueFile)).toBe(true);
      expect(appendReplyContextQueue("C0QUEUE", "700.001", "700.009", queueFile)).toBe(true);
      expect(appendReplyContextQueue("C0QUEUE", "700.001", "700.010", queueFile)).toBe(true);
      const queue = JSON.parse(readFileSync(queueFile, "utf8"));
      expect(queue).toHaveLength(2);
    } finally {
      if (existsSync(queueFile)) unlinkSync(queueFile);
    }
  });

  test("removeReplyContextQueue removes exactly the lost claim identity", () => {
    const queueFile = join(tmpdir(), `bridge-reply-context-${Date.now()}.json`);
    try {
      appendReplyContextQueue("C0QUEUE", "700.001", "700.009", queueFile);
      appendReplyContextQueue("C0QUEUE", "700.002", "700.010", queueFile);
      expect(removeReplyContextQueue("C0QUEUE", "700.009", queueFile)).toBe(true);
      const queue = JSON.parse(readFileSync(queueFile, "utf8"));
      expect(queue).toEqual([
        { channel: "C0QUEUE", thread_ts: "700.002", ts: "700.010" },
      ]);
    } finally {
      if (existsSync(queueFile)) unlinkSync(queueFile);
    }
  });

  test("appendReplyContextQueue is best-effort on write failure", () => {
    const queueDir = mkdtempSync(join(tmpdir(), "bridge-reply-context-dir-"));
    try {
      expect(appendReplyContextQueue("C0QUEUE", "700.002", "700.011", queueDir)).toBe(false);
    } finally {
      rmSync(queueDir, { recursive: true, force: true });
    }
  });

  test("recordMessage atomically claims a (channel, ts) exactly once", () => {
    const ch = channelId();
    const first = recordMessage({
      ts: "500.001",
      threadTs: null,
      channelId: ch,
      channelType: "channel",
      userId: "U0TEST",
      userName: "Tester",
      body: "claim-1",
      hasImages: false,
      hasSnippets: false,
    });
    // A concurrent socket/poll handler that both passed wasRecorded() races
    // here; the loser must get false and therefore must not forward.
    const second = recordMessage({
      ts: "500.001",
      threadTs: null,
      channelId: ch,
      channelType: "channel",
      userId: "U0TEST",
      userName: "Tester",
      body: "claim-2-duplicate",
      hasImages: false,
      hasSnippets: false,
    });
    // A different message is a fresh claim.
    const third = recordMessage({
      ts: "500.002",
      threadTs: null,
      channelId: ch,
      channelType: "channel",
      userId: "U0TEST",
      userName: "Tester",
      body: "claim-3",
      hasImages: false,
      hasSnippets: false,
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(third).toBe(true);
  });
});
