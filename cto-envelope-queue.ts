import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { formatCtoWakeMessage } from "./cto-wake-delivery.ts";

export type CtoEnvelopeBuild = {
  key: string;
  tuple: Record<string, unknown>;
  sourceEvidence: Record<string, unknown>;
  verification: Record<string, unknown>;
  previousThreadMessage: Record<string, unknown> | null;
  attachments: unknown[];
  sopPath: string;
};

export function buildCtoDurableEnvelope(input: CtoEnvelopeBuild): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    queued_at: new Date().toISOString(),
    delivery_status: "pending",
    sop_path: input.sopPath,
    fingerprint: `cto-slack-relay:slack_socket_mode:${input.key}`,
    dedup_key: input.key,
    source: "slack_socket_mode",
    class: "CTO_SLACK_RELAY_EVENT",
    exact_tuple: input.tuple,
    source_evidence: input.sourceEvidence,
    live_verification: input.verification,
    previous_thread_message: input.previousThreadMessage,
    attachments: input.attachments,
    closure_condition: "The frozen destination task accepts the exact routed wake",
  };
  envelope.wake_text = formatCtoWakeMessage(envelope);
  return envelope;
}

export function appendCtoDurableEnvelope(path: string, envelope: Record<string, unknown>): void {
  appendFileSync(path, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function hasDurableEnvelopeKey(path: string, key: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const raw = readFileSync(path, "utf8");
    const candidates: unknown[] = [];
    try {
      candidates.push(JSON.parse(raw));
    } catch {
      for (const line of raw.split("\n").filter(Boolean)) {
        try { candidates.push(JSON.parse(line)); } catch { /* ignore one malformed row */ }
      }
    }
    for (const candidate of candidates) {
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        const record = candidate as Record<string, unknown>;
        if (record.dedup_key === key) return true;
        if (Array.isArray(record.events) && record.events.some((item) => item && typeof item === "object" && (item as Record<string, unknown>).dedup_key === key)) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}
