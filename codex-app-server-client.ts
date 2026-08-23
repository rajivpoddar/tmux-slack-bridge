import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";

const DEFAULT_COMMAND = "codex";
const DEFAULT_ARGS = ["app-server", "--stdio"];
const START_ATTEMPTS = 2;
const REQUEST_TIMEOUT_MS = 20_000;
const TURN_TIMEOUT_MS = 15 * 60_000;

export type AppServerDeliveryRequest = {
  project: "heydonna" | "superproofer";
  cwd: string;
  destinationThreadId: string;
  consumerSopPath: string;
  routedWakeText: string;
};

export type AppServerDeliveryResult =
  | { status: "delivered"; threadId: string; turnId: string; terminal: Record<string, unknown> }
  | { status: "pending"; detail: string }
  | { status: "unavailable"; detail: string }
  | { status: "uncertain"; detail: string; threadId: string; turnId?: string };

type JsonRpcMessage = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
  method?: string;
  params?: Record<string, unknown>;
};

type AppServerChild = ChildProcessWithoutNullStreams;
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
  private readonly completionWaiters = new Map<
    string,
    { resolve: (turn: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
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
    let threadId = "";
    let turnId = "";
    let turnStartAttempted = false;
    let turnAccepted = false;
    try {
      await this.ensureStarted();
      const threadResponse = await this.request("thread/start", {
        cwd: request.cwd,
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        threadSource: `cto-slack-relay:${request.project}`,
        developerInstructions: [
          `Follow the consumer SOP at ${request.consumerSopPath}.`,
          `This relay must deliver the routed wake to destination task ${request.destinationThreadId}.`,
          "Use codex_app__send_message_to_thread exactly once with hostId=local and the destination threadId.",
          "Send the complete routed wake text as the prompt; do not reinterpret or summarize it.",
          "Do not post to Slack and do not acknowledge the source event yourself.",
          "After the app tool returns an accepted receipt, emit RELAY_DELIVERY_ACCEPTED with the tool receipt.",
          "If the app tool fails or is uncertain, emit RELAY_DELIVERY_FAILED and do not claim acceptance.",
        ].join("\n"),
      });
      threadId = readNestedId(threadResponse.result, "thread");
      if (!threadId) throw new Error("thread-start-response-missing-thread-id");

      const completion = this.waitForCompletion(threadId);
      turnStartAttempted = true;
      const turnResponse = await this.request("turn/start", {
        threadId,
        approvalPolicy: "never",
        input: [{ type: "text", text: request.routedWakeText }],
      });
      turnId = readNestedId(turnResponse.result, "turn");
      if (!turnId) throw new Error("turn-start-response-missing-turn-id");
      turnAccepted = true;

      const terminal = await completion;
      const status = terminal.status;
      if (status === "completed" && JSON.stringify(terminal).includes("RELAY_DELIVERY_ACCEPTED")) {
        return { status: "delivered", threadId, turnId, terminal };
      }
      if (status === "failed" || status === "interrupted") {
        return { status: "uncertain", threadId, turnId, detail: `turn-${String(status)}` };
      }
      return { status: "uncertain", threadId, turnId, detail: "terminal-delivery-marker-missing" };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (turnAccepted) return { status: "uncertain", threadId, turnId, detail };
      if (turnStartAttempted) return { status: "uncertain", threadId, detail };
      if (threadId) return { status: "pending", detail };
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
      capabilities: {},
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

  private waitForCompletion(threadId: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.completionWaiters.delete(threadId);
        reject(new Error("app-server-turn-timeout"));
      }, TURN_TIMEOUT_MS);
      this.completionWaiters.set(threadId, { resolve, reject, timer });
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
        pending.reject(new Error(`app-server-${message.error.message ?? "request-failed"}`));
      } else {
        pending.resolve(message);
      }
      return;
    }
    if (message.method !== "turn/completed") return;
    const threadId = String(message.params?.threadId ?? "");
    const turn = message.params?.turn;
    if (!threadId || !turn || typeof turn !== "object" || Array.isArray(turn)) return;
    const waiter = this.completionWaiters.get(threadId);
    if (!waiter) return;
    this.completionWaiters.delete(threadId);
    clearTimeout(waiter.timer);
    waiter.resolve(turn as Record<string, unknown>);
  }

  private failTransport(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(normalized);
      this.pendingRequests.delete(id);
    }
    for (const [threadId, waiter] of this.completionWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(normalized);
      this.completionWaiters.delete(threadId);
    }
    this.initialized = false;
    if (this.child?.killed || this.child?.exitCode !== null) this.child = null;
  }
}

function readNestedId(result: Record<string, unknown> | undefined, field: string): string {
  const value = result?.[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" ? id : "";
}
