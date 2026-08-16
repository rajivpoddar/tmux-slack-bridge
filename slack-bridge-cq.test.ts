/**
 * Regression tests for the busy-aware PM-pane submit-key repair.
 *
 * Rajiv directive (thread 1786901176.352869): "repair the slack bridge".
 * PM-pane delivery must submit with Enter when PM is confirmed idle, and with
 * C-q (OMP follow-up queue) when PM is busy OR the busy signal is unknown, so
 * automated messages queue rather than steer/interleave. Dev-slot delivery
 * stays Enter/steering unchanged.
 */
import { describe, test, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { execSync } from "child_process";

process.env.TMUX_TARGET = "0:0.0";
process.env.SLACK_CHANNEL = "C0TESTCQ";
process.env.SLACK_BOT_TOKEN = "xoxb-test";
process.env.SLACK_APP_TOKEN = "xapp-test";
process.env.SLACK_HISTORY_POLL_INTERVAL_MS = "0";
process.env.SLACK_BOT_ALLOWED_CHANNELS = "";
process.env.MOP_ROUTE_URL = "http://localhost:0/nonexistent";
process.env.MOP_PM_STATUS_URL = "http://localhost:0/pm-status";

vi.mock("child_process", () => ({ execSync: vi.fn(() => Buffer.from("")) }));
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

const origFetch = globalThis.fetch;
let sendToPane: (text: string, target?: string) => Promise<void>;
let resolveSubmitKey: (pane: string, pmBusy: boolean | null) => "Enter" | "C-q";
let pmBusyState: () => Promise<boolean | null>;

beforeAll(async () => {
  const bridge = await import("./slack-bridge.ts");
  sendToPane = bridge.sendToPane;
  resolveSubmitKey = bridge.resolveSubmitKey;
  pmBusyState = bridge.pmBusyState;
});

afterAll(() => {
  globalThis.fetch = origFetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  vi.mocked(execSync).mockClear();
});

function fetchReturning(body: unknown, ok = true) {
  globalThis.fetch = (async () => ({ ok, json: async () => body })) as typeof fetch;
}

describe("resolveSubmitKey", () => {
  test("dev-slot pane always Enter regardless of PM busy state", () => {
    expect(resolveSubmitKey("0:0.1", true)).toBe("Enter");
    expect(resolveSubmitKey("0:0.2", false)).toBe("Enter");
    expect(resolveSubmitKey("0:0.3", null)).toBe("Enter");
    expect(resolveSubmitKey("0:0.4", true)).toBe("Enter");
  });

  test("PM pane idle -> Enter", () => {
    expect(resolveSubmitKey("0:0.0", false)).toBe("Enter");
  });

  test("PM pane busy -> C-q", () => {
    expect(resolveSubmitKey("0:0.0", true)).toBe("C-q");
  });

  test("PM pane unknown/error -> C-q (fail closed to queue)", () => {
    expect(resolveSubmitKey("0:0.0", null)).toBe("C-q");
  });
});

describe("pmBusyState", () => {
  test("returns true when MoP reports pm_busy=true", async () => {
    fetchReturning({ pm_busy: true });
    expect(await pmBusyState()).toBe(true);
  });

  test("returns false when MoP reports pm_busy=false", async () => {
    fetchReturning({ pm_busy: false });
    expect(await pmBusyState()).toBe(false);
  });

  test("returns null on HTTP error", async () => {
    fetchReturning({}, false);
    expect(await pmBusyState()).toBeNull();
  });

  test("returns null on malformed body", async () => {
    fetchReturning({ pm_busy: "yes" });
    expect(await pmBusyState()).toBeNull();
  });

  test("returns null on network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    expect(await pmBusyState()).toBeNull();
  });
});

describe("sendToPane busy-aware delivery", () => {
  test("PM busy -> command submits with C-q", async () => {
    fetchReturning({ pm_busy: true });
    await sendToPane("# probe busy", "0:0.0");
    const cmd = vi.mocked(execSync).mock.calls[0]![0] as string;
    expect(cmd).toContain("tmux send-keys -t 0:0.0");
    expect(cmd).toContain("C-q");
    expect(cmd).toContain("-l");
  });

  test("PM idle -> command submits with Enter", async () => {
    fetchReturning({ pm_busy: false });
    await sendToPane("# probe idle", "0:0.0");
    const cmd = vi.mocked(execSync).mock.calls[0]![0] as string;
    expect(cmd).toContain("Enter");
    expect(cmd).not.toContain("C-q");
  });

  test("PM unknown/error -> command submits with C-q", async () => {
    globalThis.fetch = (async () => {
      throw new Error("mop down");
    }) as typeof fetch;
    await sendToPane("# probe unknown", "0:0.0");
    const cmd = vi.mocked(execSync).mock.calls[0]![0] as string;
    expect(cmd).toContain("C-q");
  });

  test("dev slot -> command submits with Enter even when PM busy", async () => {
    fetchReturning({ pm_busy: true });
    await sendToPane("# probe slot1", "0:0.1");
    const cmd = vi.mocked(execSync).mock.calls[0]![0] as string;
    expect(cmd).toContain("tmux send-keys -t 0:0.1");
    expect(cmd).toContain("Enter");
    expect(cmd).not.toContain("C-q");
  });
});
