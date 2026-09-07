import { describe, expect, test } from "vitest";

import { eventOriginIgnoreReason } from "./cto-event-policy.ts";

describe("CTO Slack event origin policy", () => {
  test("allows a human-authored message", () => {
    expect(eventOriginIgnoreReason({ user: "U_HUMAN" }, "U_CTO")).toBeNull();
  });

  test("allows human file shares but not bot file shares", () => {
    expect(eventOriginIgnoreReason({ user: "U_HUMAN", subtype: "file_share" }, "U_CTO")).toBeNull();
    expect(eventOriginIgnoreReason({ user: "U_BOT", bot_id: "B_BOT", subtype: "file_share" }, "U_CTO")).toBe("unsupported-subtype");
  });

  test("allows a bot-authored app mention", () => {
    expect(
      eventOriginIgnoreReason(
        { user: "U_PM", bot_id: "B_PM" },
        "U_CTO",
      ),
    ).toBeNull();
  });

  test("allows the legacy bot_message subtype", () => {
    expect(
      eventOriginIgnoreReason(
        { user: "U_PM", bot_id: "B_PM", subtype: "bot_message" },
        "U_CTO",
      ),
    ).toBeNull();
  });

  test("rejects the CTO app's own bot message", () => {
    expect(
      eventOriginIgnoreReason(
        { user: "U_CTO", bot_id: "B_CTO" },
        "U_CTO",
      ),
    ).toBe("app-self");
  });

  test("rejects message lifecycle subtypes", () => {
    expect(
      eventOriginIgnoreReason(
        { user: "U_PM", bot_id: "B_PM", subtype: "message_changed" },
        "U_CTO",
      ),
    ).toBe("unsupported-subtype");
  });
});
