import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

const BRIDGE_SOURCE = readFileSync(new URL("./cto-bridge.ts", import.meta.url), "utf8");
const APP_SERVER_SOURCE = readFileSync(new URL("./codex-app-server-client.ts", import.meta.url), "utf8");
const ROUTER_SOP_PATH = "/Users/rajiv/.codex/monitors/cto-slack-relay/WAKE_SOP.md";
const SNAPSHOT_HELPER = "/Users/rajiv/.claude/scripts/cto-relay-snapshot.py";
const AUTOMATION_PATH =
  "/Users/rajiv/.codex/automations/heydonna-cto-slack-relay-backup/automation.toml";
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("CTO Slack relay architecture", () => {
  test("keeps route classification out of the Socket Mode bridge", () => {
    expect(BRIDGE_SOURCE).toContain('SLACK_MONITOR_THREAD_ID = "019fd9df-23ad-7500-8b3e-53ce9341a140"');
    expect(BRIDGE_SOURCE).not.toContain("target_thread_id");
    expect(BRIDGE_SOURCE).not.toContain("target_model");
    expect(BRIDGE_SOURCE).not.toContain("target_effort");
    expect(BRIDGE_SOURCE).toContain("/monitors/cto-slack-relay/WAKE_SOP.md");
    expect(BRIDGE_SOURCE).not.toContain("resolveSlackThreadRoute");
  });

  test("publishes the durable event before it wakes the monitor and never acks that first hop", () => {
    expect(BRIDGE_SOURCE.indexOf("publishPendingEnvelope(durableEnvelope)")).toBeLessThan(
      BRIDGE_SOURCE.lastIndexOf("requestAppServerDrain();"),
    );
    expect(BRIDGE_SOURCE).not.toContain("acknowledgeWake(");
    expect(BRIDGE_SOURCE).toContain("MONITOR_TRIGGER_RECEIPTS_FILE");
  });

  test("uses the supported app-server queue without creating or resuming a task", () => {
    expect(BRIDGE_SOURCE).toContain("CodexAppServerClient");
    expect(APP_SERVER_SOURCE).toContain('this.request("thread/queue/add"');
    expect(APP_SERVER_SOURCE).not.toContain('this.request("thread/resume"');
    expect(APP_SERVER_SOURCE).not.toContain('this.request("turn/start"');
    expect(APP_SERVER_SOURCE).not.toContain('this.request("thread/start"');
    expect(APP_SERVER_SOURCE).not.toContain("ephemeral: true");
    expect(APP_SERVER_SOURCE).toContain("stableClientUserMessageId");
    expect(APP_SERVER_SOURCE).toContain("/Applications/ChatGPT.app/Contents/Resources/codex");
    expect(APP_SERVER_SOURCE).not.toContain("waitForCompletion");
    expect(APP_SERVER_SOURCE).not.toContain("turn/completed");
    expect(BRIDGE_SOURCE).toContain('updateClaim("renew"');
    expect(BRIDGE_SOURCE).toContain('updateClaim("release"');
    expect(BRIDGE_SOURCE).toContain("claim_owner");
    expect(BRIDGE_SOURCE).toContain("codex_desktop_ipc_fallback");
    expect(BRIDGE_SOURCE).toContain("APP_SERVER_DELIVERY_RECEIPTS_FILE");
    expect(BRIDGE_SOURCE).not.toContain("no-client-found");
    expect(BRIDGE_SOURCE).toContain("pending.sort(compareSourceOrder)");
    expect(BRIDGE_SOURCE).toContain("appServerDrainRequested = true");
    expect(BRIDGE_SOURCE).toContain('"--output",\n      snapshotFile');
    expect(BRIDGE_SOURCE).toContain("unlinkSync(snapshotFile)");
    expect(BRIDGE_SOURCE).not.toContain('readJsonFile("/tmp/cto-slack-relay-snapshot.json"');
    expect(BRIDGE_SOURCE).not.toContain("verifyConsumerTerminal");
  });

  test("puts the complete two-bucket route table in the monitor SOP", () => {
    const sop = readFileSync(ROUTER_SOP_PATH, "utf8");
    expect(sop).toContain("exact_tuple.channel == C09TYQC1DEF");
    expect(sop).toContain("this is Superproofer");
    expect(sop).toContain("every qualifying bridge event is HeyDonna");
    expect(sop).toContain("codex_app__send_message_to_thread");
    expect(sop).toContain("Do not post to Slack from the router");
    expect(sop).toContain("<!-- CTO_SLACK_ROUTE_TABLE_V1");
    expect(sop).toContain("CTO_SLACK_ROUTE_TABLE_END -->");
  });

  test("makes both heartbeat and IPC routing consume the frozen machine route", () => {
    const automation = readFileSync(AUTOMATION_PATH, "utf8");
    expect(automation).toContain(
      "cto-relay-snapshot.py --limit 1 --route-sop /Users/rajiv/.codex/monitors/cto-slack-relay/WAKE_SOP.md",
    );
    expect(automation).toContain("event.relay_route.destination_thread_id");
    expect(automation).toContain("event.routed_wake_text");
    expect(BRIDGE_SOURCE).toContain("cto-relay-snapshot.py --key ${key} --limit 1 --route-sop");
    expect(BRIDGE_SOURCE).toContain("event.relay_route.destination_thread_id");
    expect(BRIDGE_SOURCE).toContain("event.routed_wake_text");
    expect(BRIDGE_SOURCE).toContain(
      "If it exits nonzero, stop: do not read, deliver, or acknowledge any snapshot.",
    );
  });

  test("leases a queued event so an IPC trigger and heartbeat cannot claim it together", () => {
    const directory = mkdtempSync(join(tmpdir(), "cto-relay-test-"));
    temporaryDirectories.push(directory);
    const eventsFile = join(directory, "events.json");
    const ackFile = join(directory, "ack.json");
    const claimsFile = join(directory, "claims.json");
    const lockFile = join(directory, "relay.lock");
    const outputFile = join(directory, "snapshot.json");
    const heartbeatFile = join(directory, "heartbeat");
    writeFileSync(
      eventsFile,
      JSON.stringify({
        events: [
          {
            dedup_key: "C1:1",
            fingerprint: "relay:C1:1",
            sop_path: ROUTER_SOP_PATH,
            exact_tuple: { channel: "C0ALZJHGE49", ts: "1", text: "one" },
            wake_text: `SOP path: ${ROUTER_SOP_PATH}\n\none`,
          },
          {
            dedup_key: "C2:2",
            fingerprint: "relay:C2:2",
            sop_path: ROUTER_SOP_PATH,
            exact_tuple: { channel: "C09TYQC1DEF", ts: "2", text: "two" },
            wake_text: `SOP path: ${ROUTER_SOP_PATH}\n\ntwo`,
          },
        ],
      }),
    );
    writeFileSync(ackFile, JSON.stringify({ handled: [] }));

    const common = [
      SNAPSHOT_HELPER,
      "--events-file", eventsFile,
      "--ack-file", ackFile,
      "--claims-file", claimsFile,
      "--lock-file", lockFile,
      "--output", outputFile,
      "--heartbeat-file", heartbeatFile,
      "--limit", "1",
      "--route-sop", ROUTER_SOP_PATH,
    ];
    execFileSync("python3", [...common, "--key", "C1:1"]);
    expect(JSON.parse(readFileSync(outputFile, "utf8"))).toMatchObject([
      { dedup_key: "C1:1" },
    ]);

    execFileSync("python3", [...common, "--key", "C1:1"]);
    expect(JSON.parse(readFileSync(outputFile, "utf8"))).toEqual([]);

    execFileSync("python3", common);
    expect(JSON.parse(readFileSync(outputFile, "utf8"))).toMatchObject([
      { dedup_key: "C2:2" },
    ]);
  });

  test("renews and releases an active claim without touching the snapshot", () => {
    const directory = mkdtempSync(join(tmpdir(), "cto-relay-lease-test-"));
    temporaryDirectories.push(directory);
    const eventsFile = join(directory, "events.json");
    const ackFile = join(directory, "ack.json");
    const claimsFile = join(directory, "claims.json");
    const lockFile = join(directory, "relay.lock");
    const outputFile = join(directory, "snapshot.json");
    const heartbeatFile = join(directory, "heartbeat");
    writeFileSync(
      eventsFile,
      JSON.stringify({
        events: [{
          dedup_key: "C1:1",
          fingerprint: "relay:C1:1",
          sop_path: ROUTER_SOP_PATH,
          wake_text: `SOP path: ${ROUTER_SOP_PATH}\n\none`,
          exact_tuple: { channel: "C1", ts: "1", text: "one" },
        }],
      }),
    );
    writeFileSync(ackFile, JSON.stringify({ handled: [] }));

    const common = [
      SNAPSHOT_HELPER,
      "--events-file", eventsFile,
      "--ack-file", ackFile,
      "--claims-file", claimsFile,
      "--lock-file", lockFile,
      "--output", outputFile,
      "--heartbeat-file", heartbeatFile,
      "--limit", "1",
      "--route-sop", ROUTER_SOP_PATH,
    ];
    execFileSync("python3", [...common, "--key", "C1:1"]);
    const snapshotBefore = readFileSync(outputFile, "utf8");
    const claim = JSON.parse(readFileSync(claimsFile, "utf8"))["C1:1"];
    const before = claim.expires_at_epoch;
    expect(() => execFileSync("python3", [...common, "--renew-key", "C1:1", "--claim-owner", "stale-owner"])).toThrow();
    execFileSync("python3", [...common, "--renew-key", "C1:1", "--claim-owner", claim.owner, "--claim-ttl-seconds", "300"]);
    const after = JSON.parse(readFileSync(claimsFile, "utf8"))["C1:1"].expires_at_epoch;
    expect(after).toBeGreaterThan(before);
    execFileSync("python3", [...common, "--release-key", "C1:1", "--claim-owner", claim.owner]);
    expect(JSON.parse(readFileSync(claimsFile, "utf8"))).not.toHaveProperty("C1:1");
    expect(readFileSync(outputFile, "utf8")).toBe(snapshotBefore);
  });
});
