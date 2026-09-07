import { mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { appendCtoDurableEnvelope, buildCtoDurableEnvelope, hasDurableEnvelopeKey } from "./cto-envelope-queue.ts";
import { materializeSlackImages } from "./cto-file-materialization.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

function fixture(files: Record<string, Uint8Array | { status: number; location?: string }>) {
  const root = mkdtempSync(join(tmpdir(), "cto-image-test-"));
  const client = {
    files: {
      info: async ({ file }: { file: string }) => ({
        ok: true,
        file: {
          id: file,
          name: `${file}.png`,
          mimetype: "image/png",
          url_private_download: `https://files.slack.com/files-pri/${file}`,
        },
      }),
    },
  };
  const fetchImpl = async (url: URL | RequestInfo, init?: RequestInit) => {
    expect(new URL(String(url)).hostname).toBe("files.slack.com");
    expect(init?.redirect).toBe("manual");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-test");
    const key = new URL(String(url)).pathname.split("/").pop() || "";
    const value = files[key];
    if (!value) return new Response("missing", { status: 404 });
    if ("status" in value) return new Response(null, { status: value.status, headers: value.location ? { location: value.location } : {} });
    return new Response(value, { status: 200, headers: { "content-type": "image/png", "content-length": String(value.byteLength) } });
  };
  return { root, client, fetchImpl };
}

describe("Slack image materialization through durable wake serialization", () => {
  test("saves multiple images, preserves image-only text, and queues absolute paths", async () => {
    const { root, client, fetchImpl } = fixture({ one: PNG, two: PNG });
    const attachments = await materializeSlackImages(
      [{ id: "one", name: "first.png", mimetype: "image/png" }, { id: "two", name: "second.png", mimetype: "image/png" }],
      "D1:1.2",
      { rootDir: root, client, token: "xoxb-test", fetchImpl },
    );
    expect(attachments).toHaveLength(2);
    expect(attachments.every((item) => item.status === "saved" && item.path?.startsWith(root))).toBe(true);
    const queue = join(root, "queue.jsonl");
    const envelope = buildCtoDurableEnvelope({
      key: "D1:1.2",
      tuple: { channel: "D1", ts: "1.2", thread_ts: null, user: "U1", bot_id: null, subtype: "file_share", text: "" },
      sourceEvidence: { subtype: "file_share" },
      verification: { attempted: true, ok: true },
      previousThreadMessage: null,
      attachments,
      sopPath: "/tmp/WAKE_SOP.md",
    });
    appendCtoDurableEnvelope(queue, envelope);
    expect(hasDurableEnvelopeKey(queue, "D1:1.2")).toBe(true);
    // A duplicate event observes the durable key before another materialization/append.
    expect(hasDurableEnvelopeKey(queue, "D1:1.2")).toBe(true);
    const serialized = JSON.parse(readFileSync(queue, "utf8"));
    expect(serialized.exact_tuple.text).toBe("");
    expect(serialized.wake_text).toContain("[no text]");
    expect(serialized.wake_text).toContain(attachments[0].path);
    expect(serialized.wake_text).not.toContain("xoxb-test");
    const textEnvelope = buildCtoDurableEnvelope({
      key: "D1:1.3",
      tuple: { channel: "D1", ts: "1.3", thread_ts: null, user: "U1", bot_id: null, subtype: "file_share", text: "trace this" },
      sourceEvidence: { subtype: "file_share" },
      verification: { attempted: true, ok: true },
      previousThreadMessage: null,
      attachments,
      sopPath: "/tmp/WAKE_SOP.md",
    });
    expect(textEnvelope.wake_text).toContain("trace this");
    expect(readdirSync(join(root, readdirSync(root).find((item) => item !== "queue.jsonl")!)).length).toBe(2);
  });

  test("deduplicated materialization is stable and unsafe/unsupported files preserve text", async () => {
    const { root, client, fetchImpl } = fixture({ one: PNG });
    const files = [{ id: "one", name: "../../secret.png", mimetype: "image/png" }];
    const first = await materializeSlackImages(files, "D1:2.3", { rootDir: root, client, token: "xoxb-test", fetchImpl });
    const second = await materializeSlackImages(files, "D1:2.3", { rootDir: root, client, token: "xoxb-test", fetchImpl });
    expect(second[0].path).toBe(first[0].path);
    const unsafe = await materializeSlackImages(
      [{ id: "bad", name: "x.png", mimetype: "image/png", url_private_download: "https://evil.example/x.png" }],
      "D1:2.4",
      { rootDir: root, client: { files: { info: async () => ({ ok: true, file: { id: "bad", name: "x.png", mimetype: "image/png", url_private_download: "https://evil.example/x.png" } }) } }, token: "xoxb-test", fetchImpl },
    );
    expect(unsafe[0].status).toBe("unavailable");
    expect(unsafe[0].reason).toBe("unsafe-url");
    const failureEnvelope = buildCtoDurableEnvelope({
      key: "D1:2.4",
      tuple: { channel: "D1", ts: "2.4", thread_ts: null, user: "U1", bot_id: null, subtype: "file_share", text: "keep this text" },
      sourceEvidence: { subtype: "file_share" },
      verification: { attempted: true, ok: true },
      previousThreadMessage: null,
      attachments: unsafe,
      sopPath: "/tmp/WAKE_SOP.md",
    });
    expect(failureEnvelope.wake_text).toContain("keep this text");
    expect(failureEnvelope.wake_text).toContain("unsafe-url");
    expect(failureEnvelope.wake_text).not.toContain("evil.example");
    const unsupported = await materializeSlackImages(
      [{ id: "doc", name: "x.pdf", mimetype: "application/pdf" }],
      "D1:2.5",
      { rootDir: root, client: { files: { info: async () => ({ ok: true, file: { id: "doc", name: "x.pdf", mimetype: "application/pdf" } }) } }, token: "xoxb-test", fetchImpl },
    );
    expect(unsupported[0].status).toBe("unsupported");
  });

  test("rejects symlink collision and oversized payload without exposing a path", async () => {
    const { root, client, fetchImpl } = fixture({ one: PNG });
    // A symlink in the eventual event directory is created after the first call
    // establishes the directory; the second call must not overwrite it.
    const first = await materializeSlackImages([{ id: "one", name: "one.png", mimetype: "image/png" }], "D1:3.4", { rootDir: root, client, token: "xoxb-test", fetchImpl });
    expect(first[0].path).toBeTruthy();
    const eventDirectory = first[0].path!.slice(0, first[0].path!.lastIndexOf("/"));
    const collision = join(eventDirectory, "02-one.png");
    symlinkSync("/etc/passwd", collision);
    const second = await materializeSlackImages([{ id: "one", name: "one.png", mimetype: "image/png" }, { id: "one", name: "one.png", mimetype: "image/png" }], "D1:3.4", { rootDir: root, client, token: "xoxb-test", fetchImpl });
    expect(second[1].status).toBe("unavailable");
    expect(second[1].path).toBeNull();
    const oversized = await materializeSlackImages([{ id: "one", name: "one.png", mimetype: "image/png" }], "D1:3.5", { rootDir: root, client, token: "xoxb-test", fetchImpl, maxBytes: 1 });
    expect(oversized[0].reason).toBe("oversize");
  });

  test("rejects a redirect that leaves the authenticated Slack origin", async () => {
    const { root, client } = fixture({ one: { status: 302, location: "https://evil.example/payload" } });
    const redirectingFetch = async () => new Response(null, { status: 302, headers: { location: "https://evil.example/payload" } });
    const result = await materializeSlackImages([{ id: "one", name: "one.png", mimetype: "image/png" }], "D1:4.5", { rootDir: root, client, token: "xoxb-test", fetchImpl: redirectingFetch });
    expect(result[0].status).toBe("unavailable");
    expect(result[0].reason).toBe("unsafe-url");
  });
});
