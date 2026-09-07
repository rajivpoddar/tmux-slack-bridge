import { describe, expect, test } from "vitest";

import { formatCtoWakeMessage } from "./cto-wake-delivery.ts";

describe("CTO wake delivery", () => {
  test("renders the SOP pointer and complete Slack details as readable text", () => {
    const envelope = {
      sop_path: "/Users/rajiv/.codex/monitors/cto-slack-relay/WAKE_SOP.md",
      fingerprint: "cto-dm:slack_socket_mode:C123:123.456",
      dedup_key: "C123:123.456",
      class: "CTO_DM",
      action_kind: "CTO_DECISION_CONSUMPTION",
      required_skill: "verify decision, then exact PM transition",
      authority: "RAJIV_DECISION",
      exact_tuple: {
        channel: "C123",
        ts: "123.456",
        thread_ts: "120.000",
        user: "U123",
        bot_id: "B123",
        subtype: null,
        text: "preserve this exactly\nincluding line breaks",
      },
      source_evidence: {
        transport: "slack_bolt_socket_mode",
        slack_event_type: "app_mention",
        slack_event_id: "Ev123",
        slack_event_time: 123,
        team_id: "T123",
        channel_type: null,
      },
      live_verification: {
        attempted: true,
        ok: true,
        message_count: 16,
        parent_found: true,
        event_found: true,
        response_metadata_present: false,
      },
      previous_thread_message: {
        ts: "122.999",
        user: "U999",
        bot_id: null,
        text: "previous line one\nprevious line two",
      },
      terminal_action: "quote durable decision and require one canonical PM transition",
      closure_condition: "CTO task records and handles the wake",
    };

    expect(formatCtoWakeMessage(envelope)).toBe(
      [
        "SOP path: /Users/rajiv/.codex/monitors/cto-slack-relay/WAKE_SOP.md",
        "",
        "Slack message",
        "Channel: C123",
        "Message timestamp: 123.456",
        "Thread timestamp: 120.000",
        "User ID: U123",
        "Bot ID: B123",
        "Subtype: none",
        "",
        "Previous thread message",
        "Message timestamp: 122.999",
        "User ID: U999",
        "Bot ID: none",
        "> previous line one",
        "> previous line two",
        "",
        "Current message:",
        "preserve this exactly",
        "including line breaks",
        "",
        "Slack source",
        "Transport: slack_bolt_socket_mode",
        "Event type: app_mention",
        "Event ID: Ev123",
        "Event time: 123",
        "Team ID: T123",
        "Channel type: none",
        "",
        "Live Slack verification",
        "Attempted: true",
        "OK: true",
        "Message count: 16",
        "Parent found: true",
        "Event found: true",
        "Response metadata present: false",
        "Error: none",
      ].join("\n"),
    );
  });

  test("does not expose internal routing judgments", () => {
    const message = formatCtoWakeMessage({
      sop_path: "/tmp/WAKE_SOP.md",
      action_kind: "CTO_DECISION_CONSUMPTION",
      authority: "RAJIV_DECISION",
      exact_tuple: { channel: "C1", ts: "1", thread_ts: null, user: "U1", text: "hello" },
      source_evidence: {},
      live_verification: {},
    });

    expect(message).not.toContain("CTO_DECISION_CONSUMPTION");
    expect(message).not.toContain("RAJIV_DECISION");
    expect(message).not.toContain("{");
  });

  test("marks missing thread context without dropping the current message", () => {
    const message = formatCtoWakeMessage({
      sop_path: "/tmp/WAKE_SOP.md",
      exact_tuple: {
        channel: "C1",
        ts: "2",
        thread_ts: "1",
        user: "U1",
        text: "current",
      },
      source_evidence: {},
      live_verification: { attempted: true, ok: false },
      previous_thread_message: null,
    });

    expect(message).toContain("Previous thread message\nUnavailable: true");
    expect(message).toContain("Current message:\ncurrent");
  });

  test("fails closed when Slack detail containers are absent", () => {
    expect(() => formatCtoWakeMessage({ sop_path: "/tmp/WAKE_SOP.md" })).toThrow(
      "wake-field-invalid:exact_tuple",
    );
  });
});
