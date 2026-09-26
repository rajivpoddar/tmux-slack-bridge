import { describe, expect, test } from "vitest";

import {
  HEYDONNA_ALERTS_WEBHOOK_BOT_ID,
  HEYDONNA_CI_BOT_ID,
  HEYDONNA_CI_BOT_USER_ID,
  HEYDONNA_DEV_ALERTS_WEBHOOK_BOT_ID,
  HEYDONNA_DEV_CHANNEL_ID,
  isTrustedSlackAlert,
  slackIngressEventType,
} from "./cto-ingress-policy.ts";

const dev = (overrides: Record<string, unknown> = {}) => ({
  channel: HEYDONNA_DEV_CHANNEL_ID,
  channel_type: "channel",
  user: "U_HUMAN",
  ...overrides,
});

const alertsBot = (overrides: Record<string, unknown> = {}) =>
  dev({
    user: HEYDONNA_CI_BOT_USER_ID,
    bot_id: HEYDONNA_CI_BOT_ID,
    subtype: "bot_message",
    ...overrides,
  });

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

  test("admits all new messages from the verified Slack Alerts bot", () => {
    expect(
      slackIngressEventType(
        alertsBot({ text: "queued, in progress, or any other alert" }),
        "message",
      ),
    ).toBe("message.channel");
    expect(
      slackIngressEventType(
        alertsBot({
          text: "",
          blocks: [{
            type: "section",
            text: { type: "mrkdwn", text: "arbitrary rendered alert" },
          }],
        }),
        "message",
      ),
    ).toBe("message.channel");
    expect(slackIngressEventType(alertsBot({ text: "plain alert" }), "app_mention")).toBe("app_mention");
    expect(slackIngressEventType(alertsBot({ user: undefined, text: "bot_message without user field" }), "message")).toBe(
      "message.channel",
    );
  });

  test("requires the verified sender identity, not display text or a spoofed bot id", () => {
    expect(
      slackIngressEventType(
        dev({ user: "U_HUMAN", bot_id: HEYDONNA_CI_BOT_ID, text: "Slack Alerts: CI failed" }),
        "message",
      ),
    ).toBeNull();
    expect(
      slackIngressEventType(
        dev({ user: HEYDONNA_CI_BOT_USER_ID, bot_id: "B_FORGED", text: "Slack Alerts: CI failed" }),
        "message",
      ),
    ).toBeNull();
    expect(
      slackIngressEventType(
        dev({ user: "U_HUMAN", username: "Slack Alerts", text: "CI passed" }),
        "message",
      ),
    ).toBeNull();
  });

  // Live shape of a HeyDonna Alerts incoming-webhook post (e.g. C0AEY9CEC4D
  // ts 1790400553.328709 "Editor readonly lockout"): subtype bot_message,
  // webhook bot_id, no user field. Each webhook has its own bot_id: the old
  // #heydonna-alerts webhook B0AHQ6BK7F1 and the new #heydonna-dev webhook
  // B0C4LE7DLUW (both app A0AHQ6WMKF1, bots.info user_id null).
  const webhookAlert = (
    overrides: Record<string, unknown> = {},
    botId: string = HEYDONNA_ALERTS_WEBHOOK_BOT_ID,
  ) => {
    const event: Record<string, unknown> = dev({
      bot_id: botId,
      subtype: "bot_message",
      text: ":red_circle: *Editor readonly lockout*",
      ...overrides,
    });
    if (!("user" in overrides)) delete event.user;
    return event;
  };

  for (const [label, botId] of [
    ["old alerts webhook", HEYDONNA_ALERTS_WEBHOOK_BOT_ID],
    ["new dev webhook", HEYDONNA_DEV_ALERTS_WEBHOOK_BOT_ID],
  ] as const) {
    test(`admits ${label} (${botId}) posts on #heydonna-dev without a CTO mention`, () => {
      expect(isTrustedSlackAlert(webhookAlert({}, botId))).toBe(true);
      expect(slackIngressEventType(webhookAlert({}, botId), "message")).toBe("message.channel");
      expect(
        slackIngressEventType(
          webhookAlert({
            text: "",
            blocks: [{ type: "section", text: { type: "mrkdwn", text: "Critical failure" } }],
          }, botId),
          "message",
        ),
      ).toBe("message.channel");
    });

    test(`rejects ${label} (${botId}) when a user field is present`, () => {
      for (const user of ["U_HUMAN", HEYDONNA_CI_BOT_USER_ID, "U0BNFGX2UAX"]) {
        expect(isTrustedSlackAlert(webhookAlert({ user }, botId))).toBe(false);
        expect(slackIngressEventType(webhookAlert({ user }, botId), "message")).toBeNull();
      }
    });

    test(`scopes ${label} (${botId}) trust to #heydonna-dev only`, () => {
      for (const channel of ["C0AEY9CEC4D", "C_OTHER", "D_SOMEDM"]) {
        expect(isTrustedSlackAlert(webhookAlert({ channel }, botId))).toBe(false);
      }
    });
  }

  test("keeps the CI bot tuple unchanged and does not cross-bind users", () => {
    expect(isTrustedSlackAlert(alertsBot())).toBe(true);
    expect(isTrustedSlackAlert(alertsBot({ user: undefined }))).toBe(true);
    expect(isTrustedSlackAlert(alertsBot({ user: "U_HUMAN" }))).toBe(false);
    expect(isTrustedSlackAlert(alertsBot({ channel: "C_OTHER" }))).toBe(false);
  });

  test("an unrelated bot on #heydonna-dev without a CTO mention is dropped", () => {
    expect(
      slackIngressEventType(
        webhookAlert({ bot_id: "B_UNRELATED", text: "HeyDonna Alerts: Editor readonly lockout" }),
        "message",
      ),
    ).toBeNull();
    expect(
      slackIngressEventType(
        webhookAlert({ bot_id: "B_UNRELATED", username: "HeyDonna Alerts" }),
        "message",
      ),
    ).toBeNull();
  });
});
