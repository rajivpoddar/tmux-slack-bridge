import { readFileSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { closeDb, recordOutboundMessage } from "../db.ts";

export type SlackPostPayload = {
  channel?: unknown;
  thread_ts?: unknown;
  text?: unknown;
};

export type SlackPostResponse = {
  ok?: unknown;
  channel?: unknown;
  ts?: unknown;
  message?: {
    user?: unknown;
    bot_id?: unknown;
    username?: unknown;
  };
};

export function channelType(channel: string): "dm" | "channel" {
  return channel.startsWith("D") ? "dm" : "channel";
}

export function outboundRecordFromSlackPost(
  payload: SlackPostPayload,
  response: SlackPostResponse
):
  | {
      ts: string;
      threadTs: string | null;
      channelId: string;
      channelType: "dm" | "channel";
      userId: string;
      userName: string;
      body: string;
    }
  | null {
  if (response.ok !== true) return null;
  if (typeof response.ts !== "string" || response.ts.length === 0) return null;
  if (typeof payload.text !== "string" || payload.text.trim().length === 0) return null;

  const channel =
    typeof response.channel === "string" && response.channel.length > 0
      ? response.channel
      : payload.channel;
  if (typeof channel !== "string" || channel.length === 0) return null;

  const threadTs =
    typeof payload.thread_ts === "string" && payload.thread_ts.length > 0
      ? payload.thread_ts
      : null;

  const userId =
    typeof response.message?.user === "string" && response.message.user.length > 0
      ? response.message.user
      : typeof response.message?.bot_id === "string" && response.message.bot_id.length > 0
        ? response.message.bot_id
        : "slack-bridge";

  const userName =
    typeof response.message?.username === "string" && response.message.username.length > 0
      ? response.message.username
      : "Slack Bridge";

  return {
    ts: response.ts,
    threadTs,
    channelId: channel,
    channelType: channelType(channel),
    userId,
    userName,
    body: payload.text,
  };
}

export function persistVerifiedOutboundSlackMessage(
  payload: SlackPostPayload,
  response: SlackPostResponse
): boolean {
  const record = outboundRecordFromSlackPost(payload, response);
  if (!record) return false;
  return recordOutboundMessage(record);
}

function parseJson(raw: string | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseStdin(): { payload: unknown; response: unknown } | null {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return null;
  }
  const [payloadRaw, responseRaw] = raw.split(/\r?\n/, 2);
  const payload = parseJson(payloadRaw);
  const response = parseJson(responseRaw);
  return payload && response ? { payload, response } : null;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const parsed = parseStdin();

  if (parsed) {
    try {
      const persisted = persistVerifiedOutboundSlackMessage(
        parsed.payload as SlackPostPayload,
        parsed.response as SlackPostResponse
      );
      if (!persisted) process.exit(2);
    } finally {
      closeDb();
    }
  }
}
