export type SlackThreadMessage = {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
};

export type PreviousThreadMessage = {
  ts: string;
  user: string | null;
  bot_id: string | null;
  text: string;
};

function compareSlackTimestamps(left: string, right: string): number {
  const [leftSeconds, leftFraction = ""] = left.split(".", 2);
  const [rightSeconds, rightFraction = ""] = right.split(".", 2);
  const secondsDifference = BigInt(leftSeconds) - BigInt(rightSeconds);
  if (secondsDifference !== 0n) return secondsDifference < 0n ? -1 : 1;

  const width = Math.max(leftFraction.length, rightFraction.length);
  const normalizedLeft = leftFraction.padEnd(width, "0");
  const normalizedRight = rightFraction.padEnd(width, "0");
  return normalizedLeft.localeCompare(normalizedRight);
}

/** Return the message immediately before currentTs, independent of API order. */
export function findPreviousThreadMessage(
  messages: SlackThreadMessage[],
  currentTs: string,
): PreviousThreadMessage | null {
  let previous: SlackThreadMessage | null = null;
  for (const message of messages) {
    if (!message.ts || compareSlackTimestamps(message.ts, currentTs) >= 0) continue;
    if (!previous?.ts || compareSlackTimestamps(message.ts, previous.ts) > 0) {
      previous = message;
    }
  }
  if (!previous?.ts) return null;
  return {
    ts: previous.ts,
    user: previous.user ?? null,
    bot_id: previous.bot_id ?? null,
    text: previous.text ?? "",
  };
}
