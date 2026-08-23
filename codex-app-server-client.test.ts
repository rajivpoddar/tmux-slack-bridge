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
  test("resumes the destination task and returns immediately after turn acceptance", async () => {
    const methods: string[] = [];
    let child!: FakeChild;
    const spawnChild: AppServerSpawnChild = (() => {
      child = fakeChild((request, current) => {
        if (request.method !== "initialized") methods.push(String(request.method));
        if (request.method === "initialize") {
          current.send({ id: request.id, result: {} });
        } else if (request.method === "thread/resume") {
          expect(request.params).toEqual({ threadId: "destination-1" });
          current.send({ id: request.id, result: { thread: { id: "destination-1" } } });
        } else if (request.method === "turn/start") {
          expect(request.params).toMatchObject({
            threadId: "destination-1",
            input: [{ type: "text", text: "SOP path: /tmp/hey-sop.md\n\nsource" }],
          });
          current.send({ id: request.id, result: { turn: { id: "turn-1" } } });
        }
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    }) as unknown as AppServerSpawnChild;

    const client = new CodexAppServerClient({ spawnChild });
    const result = await client.deliver({
      destinationThreadId: "destination-1",
      routedWakeText: "SOP path: /tmp/hey-sop.md\n\nsource",
    });

    expect(result).toEqual({ status: "delivered", threadId: "destination-1", turnId: "turn-1" });
    expect(methods).toEqual(["initialize", "thread/resume", "turn/start"]);
    client.stop();
  });

  test("fails closed when turn acceptance becomes uncertain", async () => {
    let child!: FakeChild;
    const spawnChild: AppServerSpawnChild = (() => {
      child = fakeChild((request, current) => {
        if (request.method === "initialize") current.send({ id: request.id, result: {} });
        if (request.method === "thread/resume") {
          current.send({ id: request.id, result: { thread: { id: "destination-2" } } });
        }
        if (request.method === "turn/start") {
          current.kill();
        }
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    }) as unknown as AppServerSpawnChild;

    const client = new CodexAppServerClient({ spawnChild });
    const result = await client.deliver({
      destinationThreadId: "destination-2",
      routedWakeText: "SOP path: /tmp/godavari-sop.md\n\nsource",
    });

    expect(result).toMatchObject({ status: "uncertain", threadId: "destination-2" });
    client.stop();
  });

  test("does not start a new task when the destination cannot be resumed", async () => {
    const methods: string[] = [];
    const spawnChild: AppServerSpawnChild = (() => {
      const child = fakeChild((request, current) => {
        if (request.method !== "initialized") methods.push(String(request.method));
        if (request.method === "initialize") current.send({ id: request.id, result: {} });
        if (request.method === "thread/resume") {
          current.send({ id: request.id, error: { code: -32000, message: "thread-not-found" } });
        }
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    }) as unknown as AppServerSpawnChild;

    const client = new CodexAppServerClient({ spawnChild });
    const result = await client.deliver({
      destinationThreadId: "missing-destination",
      routedWakeText: "exact wake",
    });

    expect(result).toMatchObject({ status: "unavailable", detail: "app-server-thread-not-found" });
    expect(methods).toEqual(["initialize", "thread/resume"]);
    client.stop();
  });
});
