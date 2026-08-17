import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import Database from "better-sqlite3";

const TEST_DB = join(tmpdir(), `bridge-outbound-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

if (existsSync(TEST_DB)) unlinkSync(TEST_DB);

let getDb: typeof import("./db.ts").getDb;
let recordMessage: typeof import("./db.ts").recordMessage;
let searchMessages: typeof import("./db.ts").searchMessages;
let closeDb: typeof import("./db.ts").closeDb;
let persistVerifiedOutboundSlackMessage:
  typeof import("./scripts/record-outbound-slack-message.ts").persistVerifiedOutboundSlackMessage;
let postAndRecordSlackReply:
  typeof import("./scripts/post-and-record-slack-reply.ts").postAndRecordSlackReply;

function countRows(body: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS c FROM messages WHERE body = ?")
    .get(body) as { c: number };
  return row.c;
}

describe("verified outbound Slack recording", () => {
  beforeAll(async () => {
    const recorder = await import("./scripts/record-outbound-slack-message.ts");
    const sender = await import("./scripts/post-and-record-slack-reply.ts");
    const db = await import("./db.ts");
    persistVerifiedOutboundSlackMessage = recorder.persistVerifiedOutboundSlackMessage;
    postAndRecordSlackReply = sender.postAndRecordSlackReply;
    getDb = db.getDb;
    recordMessage = db.recordMessage;
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
        thread_ts: "1786941665.403559",
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

  test("fresh outbound insert keeps thread message_count consistent", () => {
    const text = "bridge obligation 752 thread count";
    const ts = "1787000000.000005";
    const threadTs = "1786941665.403559";
    expect(
      persistVerifiedOutboundSlackMessage(
        { channel: "C0OUTBOUND", thread_ts: threadTs, text },
        {
          ok: true,
          channel: "C0OUTBOUND",
          ts,
          thread_ts: threadTs,
        }
      )
    ).toBe(true);
    const row = getDb()
      .prepare(
        "SELECT message_count FROM threads WHERE thread_ts = ? AND channel_id = ?"
      )
      .get(threadTs, "C0OUTBOUND") as { message_count: number } | undefined;
    expect(row).toBeTruthy();
    expect(row!.message_count).toBeGreaterThan(0);
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

  test("malformed ok:true Slack response persists zero rows", () => {
    const text = "bridge obligation 752 malformed success";
    const persisted = persistVerifiedOutboundSlackMessage(
      { channel: "C0OUTBOUND", thread_ts: "1786941665.403559", text },
      { ok: true, channel: "C0OUTBOUND" }
    );

    expect(persisted).toBe(false);
    expect(countRows(text)).toBe(0);
  });

  test("mismatched response channel persists zero rows", () => {
    const text = "bridge obligation 752 wrong channel";
    const persisted = persistVerifiedOutboundSlackMessage(
      { channel: "C0OUTBOUND", thread_ts: "1786941665.403559", text },
      {
        ok: true,
        channel: "C0OTHER",
        ts: "1787000000.000098",
      }
    );

    expect(persisted).toBe(false);
    expect(countRows(text)).toBe(0);
  });

  test("mismatched response thread persists zero rows", () => {
    const text = "bridge obligation 752 wrong thread";
    const persisted = persistVerifiedOutboundSlackMessage(
      { channel: "C0OUTBOUND", thread_ts: "1786941665.403559", text },
      {
        ok: true,
        channel: "C0OUTBOUND",
        ts: "1787000000.000097",
        message: { user: "U0BRIDGE", thread_ts: "1786941665.999999" },
      }
    );

    expect(persisted).toBe(false);
    expect(countRows(text)).toBe(0);
  });

  test("same Slack message identity is idempotent; distinct sends persist", () => {
    const text = "bridge obligation 752 idempotent replay";
    const payload = { channel: "C0OUTBOUND", thread_ts: "1786941665.403559", text };

    expect(
      persistVerifiedOutboundSlackMessage(payload, {
        ok: true,
        channel: "C0OUTBOUND",
        ts: "1787000000.000200",
        thread_ts: "1786941665.403559",
      })
    ).toBe(true);
    // Replaying the exact same Slack message (same channel/ts) is idempotent:
    // the row already exists and the replay is still a verified success.
    expect(
      persistVerifiedOutboundSlackMessage(payload, {
        ok: true,
        channel: "C0OUTBOUND",
        ts: "1787000000.000200",
        thread_ts: "1786941665.403559",
      })
    ).toBe(true);
    // A distinct Slack message with the same body is a different message and
    // must not be suppressed by a body-based delivery key.
    expect(
      persistVerifiedOutboundSlackMessage(payload, {
        ok: true,
        channel: "C0OUTBOUND",
        ts: "1787000000.000201",
        thread_ts: "1786941665.403559",
      })
    ).toBe(true);

    expect(countRows(text)).toBe(2);
  });

  test("same identity with mismatched outbound fields fails closed", () => {
    const text = "bridge obligation 752 mismatch replay";
    const ts = "1787000000.000203";
    const payload = { channel: "C0OUTBOUND", thread_ts: "1786941665.403559", text };
    expect(
      persistVerifiedOutboundSlackMessage(payload, {
        ok: true,
        channel: "C0OUTBOUND",
        ts,
        thread_ts: "1786941665.403559",
      })
    ).toBe(true);

    expect(
      persistVerifiedOutboundSlackMessage(
        { ...payload, thread_ts: "1786941665.999999" },
        {
        ok: true,
        channel: "C0OUTBOUND",
        ts,
        thread_ts: "1786941665.403559",
        }
      )
    ).toBe(false);
    expect(countRows(text)).toBe(1);
  });

  test("existing inbound row with the same identity is normalized to outbound", () => {
    const text = "bridge obligation 752 inbound-promoted";
    const ts = "1787000000.000202";
    recordMessage({
      ts,
      threadTs: "1786941665.403559",
      channelId: "C0OUTBOUND",
      channelType: "channel",
      userId: "U0INBOUND",
      userName: "Inbound Bot",
      body: "inbound-first",
      hasImages: false,
      hasSnippets: false,
    });

    expect(
      persistVerifiedOutboundSlackMessage(
        {
          channel: "C0OUTBOUND",
          thread_ts: "1786941665.403559",
          text,
        },
        {
          ok: true,
          channel: "C0OUTBOUND",
          ts,
          thread_ts: "1786941665.403559",
          message: { user: "U0BRIDGE", username: "Bridge Bot" },
        }
      )
    ).toBe(true);

    const row = getDb()
      .prepare(
        "SELECT direction, user_id, user_name, body FROM messages WHERE channel_id = ? AND ts = ?"
      )
      .get("C0OUTBOUND", ts) as any;
    expect(row).toMatchObject({
      direction: "outbound",
      user_id: "U0BRIDGE",
      user_name: "Bridge Bot",
      body: text,
    });
    expect(countRows(text)).toBe(1);
  });

  test("postAndRecordSlackReply CLI exits nonzero without a bridge token", () => {
    const cliDir = mkdtempSync(join(tmpdir(), "bridge-outbound-cli-token-"));
    const cliDb = join(tmpdir(), `bridge-outbound-cli-token-${Date.now()}.db`);
    const payload = JSON.stringify({
      channel: "C0OUTBOUND",
      thread_ts: "1786941665.403559",
      text: "bridge obligation 752 no token",
    });
    try {
      const result = spawnSync(
        "npx",
        [
          "--no-install",
          "tsx",
          resolve(process.cwd(), "scripts/post-and-record-slack-reply.ts"),
        ],
        {
          cwd: cliDir,
          env: { ...process.env, DB_PATH: cliDb },
          input: payload,
          encoding: "utf8",
        }
      );
      expect(result.status).toBe(2);
      expect(existsSync(cliDb)).toBe(false);
    } finally {
      rmSync(cliDir, { recursive: true, force: true });
      if (existsSync(cliDb)) unlinkSync(cliDb);
      if (existsSync(`${cliDb}-shm`)) unlinkSync(`${cliDb}-shm`);
      if (existsSync(`${cliDb}-wal`)) unlinkSync(`${cliDb}-wal`);
    }
  });

  test("CLI records from stdin without payload or response environment variables", () => {
    const cliDb = join(tmpdir(), `bridge-outbound-cli-${Date.now()}.db`);
    const text = "bridge obligation 752 stdin recorder";
    const payload = JSON.stringify({
      channel: "C0OUTBOUND",
      thread_ts: "1786941665.403559",
      text,
    });
    const response = JSON.stringify({
      ok: true,
      channel: "C0OUTBOUND",
      ts: "1787000000.000300",
      thread_ts: "1786941665.403559",
    });

    try {
      const result = spawnSync(
        "npx",
        ["--no-install", "tsx", "scripts/record-outbound-slack-message.ts"],
        {
          cwd: process.cwd(),
          env: { ...process.env, DB_PATH: cliDb },
          input: `${payload}\n${response}\n`,
          encoding: "utf8",
        }
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const raw = new Database(cliDb);
      const row = raw
        .prepare("SELECT direction, body FROM messages WHERE channel_id = ? AND ts = ?")
        .get("C0OUTBOUND", "1787000000.000300") as any;
      raw.close();

      expect(row).toMatchObject({ direction: "outbound", body: text });
    } finally {
      if (existsSync(cliDb)) unlinkSync(cliDb);
      if (existsSync(`${cliDb}-shm`)) unlinkSync(`${cliDb}-shm`);
      if (existsSync(`${cliDb}-wal`)) unlinkSync(`${cliDb}-wal`);
    }
  });

  test("postAndRecordSlackReply persists ok:true Slack responses", async () => {
    const text = "bridge obligation 752 helper ok";
    const payload = { channel: "C0OUTBOUND", thread_ts: "1786941665.403559", text };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      expect(init?.body).toBe(JSON.stringify(payload));
      return {
        json: async () => ({
          ok: true,
          channel: "C0OUTBOUND",
          ts: "1787000000.000400",
          thread_ts: "1786941665.403559",
        }),
      } as Response;
    }) as typeof fetch;

    try {
      expect(await postAndRecordSlackReply(payload, "xoxb-test-token")).toBe(true);
      expect(countRows(text)).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("postAndRecordSlackReply persists zero rows for ok:false Slack responses", async () => {
    const text = "bridge obligation 752 helper failed";
    const payload = { channel: "C0OUTBOUND", thread_ts: "1786941665.403559", text };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({
        json: async () => ({ ok: false, channel: "C0OUTBOUND", ts: "1787000000.000401" }),
      }) as Response) as typeof fetch;

    try {
      expect(await postAndRecordSlackReply(payload, "xoxb-test-token")).toBe(false);
      expect(countRows(text)).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Stop hook does not put Slack token or payload on process argv", () => {
    const hook = readFileSync("scripts/reply-to-slack.sh", "utf8");
    expect(hook).toContain("scripts/post-and-record-slack-reply.ts");
    expect(hook).toContain("PENDING_FILE + '.lock'");
    expect(hook).toContain("'id', 'channel', 'thread_ts', 'ts'");
    expect(hook).toContain("record_verified_payload");
    expect(hook).not.toContain("curl ");
    expect(hook).not.toContain("Authorization: Bearer");
    expect(hook).not.toContain("SLACK_TOKEN");
  });
});
