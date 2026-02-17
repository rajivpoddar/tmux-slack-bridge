#!/bin/bash
# Slack DM Bridge — start/stop/status daemon wrapper.
#
# Usage:
#   ./slack-bridge.sh start   # Start bridge in background
#   ./slack-bridge.sh stop    # Stop bridge
#   ./slack-bridge.sh restart # Restart bridge
#   ./slack-bridge.sh status  # Show status + recent logs
#
# Environment (set before starting, or add to .env):
#   SLACK_BOT_TOKEN  — xoxb-... bot token
#   SLACK_APP_TOKEN  — xapp-... app-level token (Socket Mode)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="/tmp/slack-bridge.pid"
LOG_FILE="/tmp/slack-bridge.log"
ENV_FILE="$SCRIPT_DIR/.env"

# Load .env if it exists
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

start() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "⚠️  Bridge already running (PID $(cat "$PID_FILE"))"
    return 1
  fi

  if [ -z "${SLACK_BOT_TOKEN:-}" ] || [ -z "${SLACK_APP_TOKEN:-}" ]; then
    echo "❌ SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set"
    echo "   Add them to $ENV_FILE or export before starting"
    return 1
  fi

  cd "$SCRIPT_DIR"
  npx tsx slack-bridge.ts >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  echo "✅ Bridge started (PID $(cat "$PID_FILE"))"
  echo "   Logs: $LOG_FILE"
}

stop() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      echo "✅ Bridge stopped (PID $pid)"
    else
      echo "⚠️  PID $pid not running"
    fi
    rm -f "$PID_FILE"
  else
    echo "⚠️  No PID file found"
  fi
}

status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "✅ Running (PID $(cat "$PID_FILE"))"
  else
    echo "⏹  Stopped"
  fi
  echo ""
  echo "Recent logs:"
  tail -10 "$LOG_FILE" 2>/dev/null || echo "  (no logs yet)"
}

case "${1:-help}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  status)  status ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac
