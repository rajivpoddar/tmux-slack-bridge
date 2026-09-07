export const SUPERPROOFER_CHANNEL_ID = "C09TYQC1DEF";
export const HEYDONNA_DEV_CHANNEL_ID = "C0ALZJHGE49";
export const HEYDONNA_CI_BOT_USER_ID = "U0AJZTN7SM6";
export const HEYDONNA_CI_BOT_ID = "B0AJ3HSC2PQ";

export type SlackIngressCandidate = {
  channel?: string;
  channel_type?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
};

export type SlackIngressEventType =
  | "message.im"
  | "message.group"
  | "message.channel"
  | "app_mention";

/**
 * Decide only whether the Socket Mode event belongs in the durable relay.
 * This is subscription policy, not final task routing.
 */
export function slackIngressEventType(
  event: SlackIngressCandidate,
  source: "message" | "app_mention",
): SlackIngressEventType | null {
  if (source === "app_mention") return "app_mention";
  if (event.channel === SUPERPROOFER_CHANNEL_ID) return "message.group";
  if (event.channel_type === "im") return "message.im";
  // Every otherwise-unmatched message visible to the CTO app enters the
  // durable router. Its default route is CTO Decisions; explicit channel/DM
  // routes still win. Origin policy separately excludes self/system events.
  if (event.channel) {
    return event.channel_type === "group" ? "message.group" : "message.channel";
  }
  return null;
}
