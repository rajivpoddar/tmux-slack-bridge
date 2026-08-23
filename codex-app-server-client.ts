import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";

const DEFAULT_COMMAND = "/Applications/ChatGPT.app/Contents/Resources/codex";
const DEFAULT_ARGS = ["app-server", "--stdio"];
const START_ATTEMPTS = 2;
const REQUEST_TIMEOUT_MS = 20_000;

export type AppServerDeliveryRequest = {
  destinationThreadId: string;
  routedWakeText: string;
  dedupKey: string;
};

export type AppServerDeliveryResult =
  | {
      status: "delivered";
      threadId: string;
      queuedSubmissionId: string;
      clientUserMessageId: string;
    }
  | { status: "unavailable"; detail: string }
  | {
      status: "uncertain";
      detail: string;
      threadId: string;
      clientUserMessageId: string;
    };

type JsonRpcMessage = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
  method?: string;
  params?: Record<string, unknown>;
};

type AppServerChild = ChildProcessWithoutNullStreams;
class AppServerRpcError extends Error {}

export type AppServerSpawnChild = (
  command: string,
  args: string[],
  options: { stdio: ["pipe", "pipe", "pipe"] },
) => AppServerChild;

export class CodexAppServerClient {
  private readonly spawnChild: AppServerSpawnChild;
  private readonly command: string;
  private readonly args: string[];
  private child: AppServerChild | null = null;
  private initialized = false;
  private startPromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<
    number,
    { resolve: (message: JsonRpcMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(options: {
    command?: string;
    args?: string[];
    spawnChild?: AppServerSpawnChild;
  } = {}) {
    this.command = options.command ?? DEFAULT_COMMAND;
    this.args = options.args ?? DEFAULT_ARGS;
    this.spawnChild = options.spawnChild ?? ((command, args, spawnOptions) =>
      spawn(command, args, spawnOptions));
  }

  async deliver(request: AppServerDeliveryRequest): Promise<AppServerDeliveryResult> {
    const threadId = request.destinationThreadId;
    const clientUserMessageId = stableClientUserMessageId(request.dedupKey);
    let queueAddAttempted = false;
    try {
      await this.ensureStarted();
      queueAddAttempted = true;
      const queueResponse = await this.request("thread/queue/add", {
        threadId,
        input: [{ type: "text", text: request.routedWakeText, text_elements: [] }],
        clientUserMessageId,
      });
      const queuedSubmission = readNestedRecord(queueResponse.result, "queuedSubmission");
      const queuedSubmissionId = readString(queuedSubmission, "id");
      const returnedClientUserMessageId = readString(queuedSubmission, "clientUserMessageId");
      if (!queuedSubmissionId) throw new Error("thread-queue-add-response-missing-submission-id");
      if (returnedClientUserMessageId !== clientUserMessageId) {
        throw new Error("thread-queue-add-response-mismatched-client-message-id");
      }
      return { status: "delivered", threadId, queuedSubmissionId, clientUserMessageId };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof AppServerRpcError) return { status: "unavailable", detail };
      if (queueAddAttempted) {
        return { status: "uncertain", threadId, clientUserMessageId, detail };
      }
      return { status: "unavailable", detail };
    }
  }

  stop(): void {
    this.failTransport(new Error("app-server-client-stopped"));
    if (this.child && !this.child.killed) this.child.kill("SIGTERM");
    this.child = null;
    this.initialized = false;
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.initialized) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startWithBoundedRestart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startWithBoundedRestart(): Promise<void> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
      try {
        await this.startChild();
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.stop();
      }
    }
    throw lastError ?? new Error("app-server-start-failed");
  }

  private async startChild(): Promise<void> {
    const child = this.spawnChild(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.initialized = false;
    const reader = createInterface({ input: child.stdout });
    reader.on("line", (line) => this.handleLine(line));
    child.stderr.resume();
    child.once("error", (error) => this.failTransport(error));
    child.once("close", (code, signal) => {
      this.failTransport(new Error(`app-server-exited code=${String(code)} signal=${String(signal)}`));
    });
    await this.request("initialize", {
      clientInfo: { name: "cto-bridge", version: "1.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.write({ jsonrpc: "2.0", method: "initialized", params: {} });
    this.initialized = true;
  }

  private request(method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`app-server-request-timeout method=${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(message: Record<string, unknown>): void {
    const stdin = this.child?.stdin as Writable | undefined;
    if (!stdin || stdin.destroyed) throw new Error("app-server-stdin-unavailable");
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;
      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new AppServerRpcError(`app-server-${message.error.message ?? "request-failed"}`));
      } else {
        pending.resolve(message);
      }
      return;
    }
  }

  private failTransport(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(normalized);
      this.pendingRequests.delete(id);
    }
    this.initialized = false;
    if (this.child?.killed || this.child?.exitCode !== null) this.child = null;
  }
}

function readNestedRecord(
  result: Record<string, unknown> | undefined,
  field: string,
): Record<string, unknown> {
  const value = result?.[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readString(value: Record<string, unknown>, field: string): string {
  return typeof value[field] === "string" ? value[field] : "";
}

export function stableClientUserMessageId(dedupKey: string): string {
  const bytes = createHash("sha256").update(`cto-slack-bridge:${dedupKey}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
