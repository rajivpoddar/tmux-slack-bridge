import { readFileSync } from "fs";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
import {
  persistVerifiedOutboundSlackMessage,
  type SlackPostPayload,
  type SlackPostResponse,
} from "./record-outbound-slack-message.ts";
import { closeDb } from "../db.ts";

export function readSlackBotToken(envPath = join(process.cwd(), ".env")): string | null {
  let raw = "";
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return null;
  }

  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^SLACK_BOT_TOKEN=(.*)$/);
    if (!match) continue;
    return match[1].trim().replace(/^['"]|['"]$/g, "") || null;
  }
  return null;
}

export function readPayloadFromStdin(): SlackPostPayload | null {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(raw);
    return payload && typeof payload === "object" ? (payload as SlackPostPayload) : null;
  } catch {
    return null;
  }
}

export async function postSlackMessage(
  payload: SlackPostPayload,
  token: string
): Promise<SlackPostResponse> {
  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    return body && typeof body === "object" ? (body as SlackPostResponse) : { ok: false };
  } catch {
    return { ok: false };
  }
}

export async function postAndRecordSlackReply(
  payload: SlackPostPayload,
  token: string
): Promise<boolean> {
  const response = await postSlackMessage(payload, token);
  return persistVerifiedOutboundSlackMessage(payload, response);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const payload = readPayloadFromStdin();
  const token = readSlackBotToken();

  if (payload && token) {
    try {
      await postAndRecordSlackReply(payload, token);
    } finally {
      closeDb();
    }
  }
}
