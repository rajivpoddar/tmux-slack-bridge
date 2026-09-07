/**
 * IPC targets the always-loaded Slack-monitor task, not a final consumer task.
 * Keep only a short registration-race window; the durable queue and heartbeat
 * are the retry path and cannot be blocked for five seconds per Slack event.
 */
export const IPC_OWNER_DISCOVERY_ATTEMPTS = 3;
export const IPC_OWNER_DISCOVERY_RETRY_DELAY_SECONDS = 0.1;
export const IPC_DELIVERY_MODE = "start";

export function ipcOwnerDiscoveryArgs(): string[] {
  return [
    "--mode",
    IPC_DELIVERY_MODE,
    "--discovery-attempts",
    String(IPC_OWNER_DISCOVERY_ATTEMPTS),
    "--discovery-retry-delay-seconds",
    String(IPC_OWNER_DISCOVERY_RETRY_DELAY_SECONDS),
  ];
}
