import { describe, expect, test } from "vitest";

import {
  HEYDONNA_CI_BOT_ID,
  HEYDONNA_CI_BOT_USER_ID,
  HEYDONNA_DEV_CHANNEL_ID,
  slackIngressEventType,
} from "./cto-ingress-policy.ts";

const dev = (overrides: Record<string, unknown> = {}) => ({
  channel: HEYDONNA_DEV_CHANNEL_ID,
  channel_type: "channel",
  user: "U_HUMAN",
  ...overrides,
});

const workflowBot = (overrides: Record<string, unknown> = {}) =>
  dev({
    user: HEYDONNA_CI_BOT_USER_ID,
    bot_id: HEYDONNA_CI_BOT_ID,
    subtype: "bot_message",
    ...overrides,
  });

const runLink = " — <https://github.com/heydonna-app/heydonna-app/actions/runs/12345|View run>";

describe("CTO Slack ingress subscription policy", () => {
  test("admits human and bot messages with an explicit current CTO mention", () => {
    expect(slackIngressEventType(dev({ text: "<@U0BNFGX2UAX> please inspect" }), "message")).toBe(
      "message.channel",
    );
    expect(
      slackIngressEventType(
        dev({ user: HEYDONNA_CI_BOT_USER_ID, bot_id: HEYDONNA_CI_BOT_ID, text: "<@U0BNFGX2UAX> CI failed" }),
        "message",
      ),
    ).toBe("message.channel");
  });

  test("accepts a rendered rich-text user mention in the current message", () => {
    expect(
      slackIngressEventType(
        dev({
          blocks: [
            {
              type: "rich_text",
              elements: [{ type: "rich_text_section", elements: [{ type: "user", user_id: "U0BNFGX2UAX" }] }],
            },
          ],
        }),
        "message",
      ),
    ).toBe("message.channel");
  });

  test("ignores unmentioned, PM-only, quoted, and code-only channel messages", () => {
    for (const text of [
      "ordinary CI alert",
      "<@U_PM> please handle",
      "> <@U0BNFGX2UAX> prior request",
      "`<@U0BNFGX2UAX>`",
      "```<@U0BNFGX2UAX>```",
    ]) {
      expect(slackIngressEventType(dev({ text }), "message")).toBeNull();
    }
  });

  test("ignores a CTO mention that exists only in a quoted block", () => {
    expect(
      slackIngressEventType(
        dev({ blocks: [{ type: "rich_text_quote", elements: [{ type: "user", user_id: "U0BNFGX2UAX" }] }] }),
        "message",
      ),
    ).toBeNull();
  });

  test("applies the current-message gate to app_mention source events", () => {
    expect(slackIngressEventType(dev({ text: "ordinary reply" }), "app_mention")).toBeNull();
    expect(slackIngressEventType(dev({ text: "> <@U0BNFGX2UAX> quoted" }), "app_mention")).toBeNull();
    expect(slackIngressEventType(dev({ text: "<@U0BNFGX2UAX> current" }), "app_mention")).toBe(
      "app_mention",
    );
  });

  test("does not treat preformatted or code-styled literal blocks as mentions", () => {
    for (const blocks of [
      [{ type: "rich_text", elements: [{ type: "rich_text_preformatted", elements: [{ type: "text", text: "<@U0BNFGX2UAX>" }] }] }],
      [{ type: "section", text: { type: "mrkdwn", text: "<@U0BNFGX2UAX>", style: { code: true } } }],
      [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "<@U0BNFGX2UAX>" }] }] }],
    ]) {
      expect(slackIngressEventType(dev({ blocks }), "message")).toBeNull();
    }
  });

  test("ignores thread replies without a current CTO mention", () => {
    expect(slackIngressEventType(dev({ thread_ts: "1788844489.947899", text: "follow-up" }), "message")).toBeNull();
  });

  test("preserves DMs, app_mention events, and explicit unrelated channel routes", () => {
    expect(slackIngressEventType({ channel: "D1", channel_type: "im", text: "hello" }, "message")).toBe(
      "message.im",
    );
    expect(slackIngressEventType({ channel: "C_OTHER", channel_type: "group", text: "hello" }, "message")).toBe(
      "message.group",
    );
    expect(slackIngressEventType(dev({ text: "<@U0BNFGX2UAX> direct" }), "app_mention")).toBe("app_mention");
  });

  test("keeps malformed events rejected", () => {
    expect(slackIngressEventType({}, "message")).toBeNull();
  });

  test("admits only the existing trusted workflow terminal templates", () => {
    const terminals = [
      `:white_check_mark: *CI + E2E* success on \`main\`${runLink}`,
      `:x: *CI failed* on \`fix/example\`${runLink}`,
      `:x: *E2E Smoke Tests failed* on \`fix/example\`${runLink}`,
      `:white_check_mark: *E2E Capture* success (full) on \`fix/example\`${runLink}`,
      `:x: *E2E Capture* failure (full) on \`fix/example\`${runLink}`,
    ];
    for (const text of terminals) {
      expect(slackIngressEventType(workflowBot({ text }), "message")).toBe("message.channel");
      expect(slackIngressEventType(workflowBot({ text }), "app_mention")).toBe("app_mention");
    }
    expect(
      slackIngressEventType(
        workflowBot({ user: undefined, text: terminals[1] }),
        "message",
      ),
    ).toBe("message.channel");
  });

  test("recognizes a rendered workflow terminal block", () => {
    expect(
      slackIngressEventType(
        workflowBot({
          text: "",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: `:x: *CI failed* on \`main\`${runLink}` } }],
        }),
        "message",
      ),
    ).toBe("message.channel");
    expect(
      slackIngressEventType(
        workflowBot({
          text: "",
          blocks: [{
            type: "rich_text",
            elements: [{
              type: "rich_text_section",
              elements: [
                { type: "text", text: ":x: *E2E Smoke Tests failed* on `main`" },
                { type: "text", text: runLink },
              ],
            }],
          }],
        }),
        "message",
      ),
    ).toBe("message.channel");
  });

  test("does not make ordinary, forged, quoted, or code-only bot text eligible", () => {
    const ordinary = [
      "CI failed — inspect this later",
      `> :x: *CI failed* on \`main\`${runLink}`,
      `\`:x: *CI failed* on \`main\`${runLink}\``,
    ];
    for (const text of ordinary) {
      expect(slackIngressEventType(workflowBot({ text }), "message")).toBeNull();
    }
    expect(
      slackIngressEventType(
        dev({ user: "U_HUMAN", bot_id: HEYDONNA_CI_BOT_ID, text: `:x: *CI failed* on \`main\`${runLink}` }),
        "message",
      ),
    ).toBeNull();
    expect(
      slackIngressEventType(
        dev({ user: HEYDONNA_CI_BOT_USER_ID, bot_id: "B_FORGED", text: `:x: *CI failed* on \`main\`${runLink}` }),
        "message",
      ),
    ).toBeNull();
  });

  test("requires the complete terminal shape, not a status keyword alone", () => {
    expect(slackIngressEventType(workflowBot({ text: ":x: *CI failed* on `main`" }), "message")).toBeNull();
    expect(slackIngressEventType(workflowBot({ text: `:white_check_mark: *CI + E2E* success on \`main\`${runLink.replace("12345", "")}` }), "message")).toBeNull();
  });
});
