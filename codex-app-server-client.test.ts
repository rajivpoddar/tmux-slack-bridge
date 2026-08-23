import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { describe, expect, test } from "vitest";
import {
  CodexAppServerClient,
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
  test("initializes, starts one ephemeral thread, starts one turn, and requires downstream acceptance", async () => {
    const methods: string[] = [];
    let child!: FakeChild;
    const spawnChild: AppServerSpawnChild = (() => {
      child = fakeChild((request, current) => {
        if (request.method !== "initialized") methods.push(String(request.method));
        if (request.method === "initialize") {
          current.send({ id: request.id, result: {} });
        } else if (request.method === "thread/start") {
          expect(request.params).toMatchObject({ ephemeral: true, cwd: "/tmp/heydonna" });
          current.send({ id: request.id, result: { thread: { id: "thread-1" } } });
        } else if (request.method === "turn/start") {
          current.send({ id: request.id, result: { turn: { id: "turn-1" } } });
          current.send({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: {
                id: "turn-1",
                status: "completed",
                items: [{
                  text: 'RELAY_WAKE_CONSUMED {"key":"C1:1","fingerprint":"fp-1","slack_reply_ts":"2.0","slack_suppressed":false}',
                }],
              },
            },
          });
        }
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    }) as unknown as AppServerSpawnChild;

    const client = new CodexAppServerClient({ spawnChild });
    const result = await client.deliver({
      project: "heydonna",
      cwd: "/tmp/heydonna",
      destinationThreadId: "destination-1",
      consumerSopPath: "/tmp/hey-sop.md",
      routedWakeText: "SOP path: /tmp/hey-sop.md\n\nsource",
      receiptKey: "C1:1",
      fingerprint: "fp-1",
    });

    expect(result).toMatchObject({ status: "delivered", threadId: "thread-1", turnId: "turn-1" });
    expect(result).toMatchObject({
      wakeReceipt: {
        key: "C1:1",
        fingerprint: "fp-1",
        slack_reply_ts: "2.0",
        slack_suppressed: false,
      },
    });
    expect(methods).toEqual(["initialize", "thread/start", "turn/start"]);
    client.stop();
  });

  test("does not fall back after a turn was accepted but the child dies", async () => {
    let child!: FakeChild;
    const spawnChild: AppServerSpawnChild = (() => {
      child = fakeChild((request, current) => {
        if (request.method === "initialize") current.send({ id: request.id, result: {} });
        if (request.method === "thread/start") {
          current.send({ id: request.id, result: { thread: { id: "thread-2" } } });
        }
        if (request.method === "turn/start") {
          current.send({ id: request.id, result: { turn: { id: "turn-2" } } });
          current.kill();
        }
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    }) as unknown as AppServerSpawnChild;

    const client = new CodexAppServerClient({ spawnChild });
    const result = await client.deliver({
      project: "superproofer",
      cwd: "/tmp/superproofer",
      destinationThreadId: "destination-2",
      consumerSopPath: "/tmp/godavari-sop.md",
      routedWakeText: "SOP path: /tmp/godavari-sop.md\n\nsource",
      receiptKey: "C2:2",
      fingerprint: "fp-2",
    });

    expect(result).toMatchObject({ status: "uncertain", threadId: "thread-2", turnId: "turn-2" });
    client.stop();
  });
});
