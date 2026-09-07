function requireRecord(
  envelope: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const value = envelope[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`wake-field-invalid:${field}`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  record: Record<string, unknown>,
  field: string,
  scope: string,
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new Error(`wake-field-invalid:${scope}.${field}`);
  }
  return value;
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new Error("wake-field-value-is-not-text");
}

function renderFields(
  record: Record<string, unknown>,
  fields: ReadonlyArray<readonly [key: string, label: string]>,
): string[] {
  return fields.map(([key, label]) => `${label}: ${renderValue(record[key])}`);
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function renderQuote(value: unknown): string[] {
  const text = typeof value === "string" && value.length > 0 ? value : "[no text]";
  return text.split("\n").map((line) => `> ${line}`);
}

function renderAttachments(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  const lines = ["", "Image attachments"];
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("wake-field-invalid:attachments");
    }
    const attachment = raw as Record<string, unknown>;
    lines.push(`Attachment ${index + 1}`);
    lines.push(`File ID: ${renderValue(attachment.file_id)}`);
    lines.push(`Name: ${renderValue(attachment.name)}`);
    lines.push(`MIME type: ${renderValue(attachment.mimetype)}`);
    lines.push(`Size: ${renderValue(attachment.size)}`);
    lines.push(`Status: ${renderValue(attachment.status)}`);
    lines.push(`SHA-256: ${renderValue(attachment.sha256)}`);
    lines.push(`Local path: ${renderValue(attachment.path)}`);
    if (attachment.reason !== undefined) lines.push(`Reason: ${renderValue(attachment.reason)}`);
  }
  return lines;
}

/**
 * Render only the current SOP pointer and source Slack details. The ingress
 * bridge does not choose a final task. The monitor later replaces only this
 * SOP pointer after applying its routing SOP.
 */
export function formatCtoWakeMessage(envelope: Record<string, unknown>): string {
  const sopPath = requireString(envelope, "sop_path", "envelope");
  const tuple = requireRecord(envelope, "exact_tuple");
  const source = requireRecord(envelope, "source_evidence");
  const verification = requireRecord(envelope, "live_verification");
  const message = requireString(tuple, "text", "exact_tuple");
  const isThreaded = typeof tuple.thread_ts === "string" && tuple.thread_ts.length > 0;
  const previousMessage = optionalRecord(envelope.previous_thread_message);
  const previousMessageLines = isThreaded
    ? previousMessage
      ? [
          "",
          "Previous thread message",
          ...renderFields(previousMessage, [
            ["ts", "Message timestamp"],
            ["user", "User ID"],
            ["bot_id", "Bot ID"],
          ]),
          ...renderQuote(previousMessage.text),
        ]
      : ["", "Previous thread message", "Unavailable: true"]
    : [];

  return [
    `SOP path: ${sopPath}`,
    "",
    "Slack message",
    ...renderFields(tuple, [
      ["channel", "Channel"],
      ["ts", "Message timestamp"],
      ["thread_ts", "Thread timestamp"],
      ["user", "User ID"],
      ["bot_id", "Bot ID"],
      ["subtype", "Subtype"],
    ]),
    ...previousMessageLines,
    "",
    "Current message:",
    message || "[no text]",
    ...renderAttachments(envelope.attachments),
    "",
    "Slack source",
    ...renderFields(source, [
      ["transport", "Transport"],
      ["slack_event_type", "Event type"],
      ["slack_event_id", "Event ID"],
      ["slack_event_time", "Event time"],
      ["team_id", "Team ID"],
      ["channel_type", "Channel type"],
    ]),
    "",
    "Live Slack verification",
    ...renderFields(verification, [
      ["attempted", "Attempted"],
      ["ok", "OK"],
      ["message_count", "Message count"],
      ["parent_found", "Parent found"],
      ["event_found", "Event found"],
      ["response_metadata_present", "Response metadata present"],
      ["error", "Error"],
    ]),
  ].join("\n");
}
