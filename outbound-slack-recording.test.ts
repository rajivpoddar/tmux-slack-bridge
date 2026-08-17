import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_DB = join(tmpdir(), `bridge-outbound-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

if (existsSync(TEST_DB)) unlinkSync(TEST_DB);

let getDb: typeof import("./db.ts").getDb;
let searchMessages: typeof import("./db.ts").searchMessages;
let closeDb: typeof import("./db.ts").closeDb;
let persistVerifiedOutboundSlackMessage:
  typeof import("./scripts/record-outbound-slack-message.ts").persistVerifiedOutboundSlackMessage;

function countRows(body: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS c FROM messages WHERE body = ?")
    .get(body) as { c: number };
  return row.c;
}

describe("verified outbound Slack recording", () => {
  beforeAll(async () => {
    const recorder = await import("./scripts/record-outbound-slack-message.ts");
    const db = await import("./db.ts");
    persistVerifiedOutboundSlackMessage = recorder.persistVerifiedOutboundSlackMessage;
    getDb = db.getDb;
    searchMessages = db.searchMessages;
    closeDb = db.closeDb;
    getDb();
  });

  afterAll(() => {
    closeDb();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    if (existsSync(`${TEST_DB}-shm`)) unlinkSync(`${TEST_DB}-shm`);
    if (existsSync(`${TEST_DB}-wal`)) unlinkSync(`${TEST_DB}-wal`);
  });

  test("successful verified Slack send persists one normalized outbound row", () => {
    const text = "bridge obligation 752 status reply stored";
    const persisted = persistVerifiedOutboundSlackMessage(
      { channel: "C0OUTBOUND", thread_ts: "1786941665.403559", text },
      {
        ok: true,
        channel: "C0OUTBOUND",
        ts: "1787000000.000001",
        message: { user: "U0BRIDGE", username: "Bridge Bot" },
      }
    );

    expect(persisted).toBe(true);
    const row = getDb()
      .prepare(
        `SELECT direction, channel_type, channel_id, thread_ts, user_id, user_name, body
         FROM messages WHERE channel_id = ? AND ts = ?`
      )
      .get("C0OUTBOUND", "1787000000.000001") as any;

    expect(row).toMatchObject({
      direction: "outbound",
      channel_type: "channel",
      channel_id: "C0OUTBOUND",
      thread_ts: "1786941665.403559",
      user_id: "U0BRIDGE",
      user_name: "Bridge Bot",
      body: text,
    });
  });

  test("closure query recognizes the stored status reply", () => {
    const found = searchMessages({
      query: "obligation 752 status reply",
      channelId: "C0OUTBOUND",
      limit: 5,
    });

    expect(found).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: "outbound",
          channel_id: "C0OUTBOUND",
          thread_ts: "1786941665.403559",
          body: "bridge obligation 752 status reply stored",
        }),
      ])
    );
  });

  test("failed Slack send persists zero rows", () => {
    const text = "bridge obligation 752 failed send must not persist";
    const persisted = persistVerifiedOutboundSlackMessage(
      { channel: "C0OUTBOUND", thread_ts: "1786941665.403559", text },
      { ok: false, channel: "C0OUTBOUND", ts: "1787000000.000099" }
    );

    expect(persisted).toBe(false);
    expect(countRows(text)).toBe(0);
  });

  test("retrying the exact same outbound message does not duplicate rows", () => {
    const text = "bridge obligation 752 idempotent replay";
    const payload = { channel: "C0OUTBOUND", thread_ts: "1786941665.403559", text };

    expect(
      persistVerifiedOutboundSlackMessage(payload, {
        ok: true,
        channel: "C0OUTBOUND",
        ts: "1787000000.000200",
      })
    ).toBe(true);
    expect(
      persistVerifiedOutboundSlackMessage(payload, {
        ok: true,
        channel: "C0OUTBOUND",
        ts: "1787000000.000200",
      })
    ).toBe(false);
    expect(
      persistVerifiedOutboundSlackMessage(payload, {
        ok: true,
        channel: "C0OUTBOUND",
        ts: "1787000000.000201",
      })
    ).toBe(false);

    expect(countRows(text)).toBe(1);
  });
});
