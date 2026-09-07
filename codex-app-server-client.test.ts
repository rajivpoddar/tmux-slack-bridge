import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { describe, expect, test } from "vitest";
import {
  CodexAppServerClient,
  stableClientUserMessageId,
  type AppServerSpawnChild,
} from "./codex-app-server-client.ts";

function fakeChild(
  onRequest: (request: Record<string, unknown>, child: FakeChild) => void,
): FakeChild {
  const child = new FakeChild();
  const lines = createInterface({ input: child.stdin });
  lines.on("line", (line) => onRequest(JSON.parse(line) as Record<string, unknown>, child));
  return child;
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;

  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.emit("close", 0, null);
    return true;
  }

  send(message: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

describe("Codex app-server transport", () => {
  test("queues the destination task and returns immediately after queue acceptance", async () => {
    const methods: string[] = [];
    let child!: FakeChild;
    const spawnChild: AppServerSpawnChild = (() => {
      child = fakeChild((request, current) => {
        if (request.method !== "initialized") methods.push(String(request.method));
        if (request.method === "initialize") {
          current.send({ id: request.id, result: {} });
        } else if (request.method === "thread/queue/add") {
          const clientUserMessageId = stableClientUserMessageId("C1:1");
          expect(request.params).toMatchObject({
            threadId: "destination-1",
            input: [{ type: "text", text: "SOP path: /tmp/hey-sop.md\n\nsource", text_elements: [] }],
            clientUserMessageId,
          });
          current.send({
            id: request.id,
            result: {
              queuedSubmission: {
                id: "submission-1",
                input: [],
                clientUserMessageId,
              },
            },
          });
        } else if (request.method === "thread/queue/start") {
          current.send({ id: request.id, result: {} });
        }
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    }) as unknown as AppServerSpawnChild;

    const client = new CodexAppServerClient({ spawnChild });
    const result = await client.deliver({
      destinationThreadId: "destination-1",
      routedWakeText: "SOP path: /tmp/hey-sop.md\n\nsource",
      dedupKey: "C1:1",
    });

    expect(result).toEqual({
      status: "delivered",
      threadId: "destination-1",
      queuedSubmissionId: "submission-1",
      clientUserMessageId: stableClientUserMessageId("C1:1"),
      startAccepted: true,
    });
    expect(methods).toEqual(["initialize", "thread/queue/add", "thread/queue/start"]);
    client.stop();
  });

  test("returns durable queued acceptance without fallback when queue/start is unavailable", async () => {
    let child!: FakeChild;
    const spawnChild: AppServerSpawnChild = (() => {
      child = fakeChild((request, current) => {
        if (request.method === "initialize") current.send({ id: request.id, result: {} });
        if (request.method === "thread/queue/add") {
          current.send({ id: request.id, result: { queuedSubmission: { id: "submission-queued", clientUserMessageId: stableClientUserMessageId("queued:1") } } });
        }
        if (request.method === "thread/queue/start") {
          current.send({ id: request.id, error: { code: -32000, message: "thread-busy" } });
        }
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    }) as unknown as AppServerSpawnChild;
    const client = new CodexAppServerClient({ spawnChild });
    const result = await client.deliver({ destinationThreadId: "destination-queued", routedWakeText: "queued wake", dedupKey: "queued:1" });
    expect(result).toEqual({ status: "queued", detail: "app-server-thread-busy", threadId: "destination-queued", queuedSubmissionId: "submission-queued", clientUserMessageId: stableClientUserMessageId("queued:1") });
    client.stop();
  });

  test("fails closed when turn acceptance becomes uncertain", async () => {
    let child!: FakeChild;
    const spawnChild: AppServerSpawnChild = (() => {
      child = fakeChild((request, current) => {
        if (request.method === "initialize") current.send({ id: request.id, result: {} });
        if (request.method === "thread/queue/add") {
          current.kill();
        }
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    }) as unknown as AppServerSpawnChild;

    const client = new CodexAppServerClient({ spawnChild });
    const result = await client.deliver({
      destinationThreadId: "destination-2",
      routedWakeText: "SOP path: /tmp/godavari-sop.md\n\nsource",
      dedupKey: "C2:2",
    });

    expect(result).toMatchObject({ status: "uncertain", threadId: "destination-2" });
    client.stop();
  });

  test("fails definitely without creating a task when the destination is missing", async () => {
    const methods: string[] = [];
    const spawnChild: AppServerSpawnChild = (() => {
      const child = fakeChild((request, current) => {
        if (request.method !== "initialized") methods.push(String(request.method));
        if (request.method === "initialize") current.send({ id: request.id, result: {} });
        if (request.method === "thread/queue/add") {
          current.send({ id: request.id, error: { code: -32000, message: "thread-not-found" } });
        }
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    }) as unknown as AppServerSpawnChild;

    const client = new CodexAppServerClient({ spawnChild });
    const result = await client.deliver({
      destinationThreadId: "missing-destination",
      routedWakeText: "exact wake",
      dedupKey: "missing:1",
    });

    expect(result).toMatchObject({ status: "unavailable", detail: "app-server-thread-not-found" });
    expect(methods).toEqual(["initialize", "thread/queue/add"]);
    client.stop();
  });

  test("derives a stable UUID-shaped idempotency key without exposing message text", () => {
    expect(stableClientUserMessageId("D1:123.456")).toBe(
      stableClientUserMessageId("D1:123.456"),
    );
    expect(stableClientUserMessageId("D1:123.456")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(stableClientUserMessageId("D1:123.456")).not.toContain("123.456");
  });
});
