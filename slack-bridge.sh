#!/bin/bash
# tmux-slack-bridge — start/stop/status daemon wrapper.
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
LAUNCHD_LABEL="${SLACK_BRIDGE_LAUNCHD_LABEL:-com.heydonna.slack-bridge}"

# Load .env if it exists
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

pid_file_pid() {
  if [ ! -f "$PID_FILE" ]; then
    return 0
  fi

  local pid
  pid=$(tr -d '[:space:]' < "$PID_FILE" 2>/dev/null || true)
  if [[ "$pid" =~ ^[0-9]+$ ]]; then
    echo "$pid"
  fi
}

is_pid_running() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

launchd_target() {
  echo "gui/$(id -u)/$LAUNCHD_LABEL"
}

launchd_pid() {
  launchctl list 2>/dev/null | awk -v label="$LAUNCHD_LABEL" '$3 == label {print $1; exit}'
}

launchd_loaded() {
  launchctl list 2>/dev/null | awk -v label="$LAUNCHD_LABEL" '$3 == label {found=1} END {exit found ? 0 : 1}'
}

launchd_running() {
  local pid
  pid="$(launchd_pid)"
  is_pid_running "$pid"
}

discover_bridge_pids() {
  ps -axo pid=,command= | while read -r pid command; do
    case "$command" in
      *"slack-bridge.ts"*|*"npm run start"*) ;;
      *) continue ;;
    esac

    local cwd
    cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
    if [ "$cwd" = "$SCRIPT_DIR" ] && is_pid_running "$pid"; then
      echo "$pid"
    fi
  done
}

join_bridge_pids() {
  discover_bridge_pids | tr '\n' ' ' | sed 's/[[:space:]]*$//'
}

repair_pid_file() {
  local pids="$1"
  local first_pid="${pids%% *}"
  if [ -n "$first_pid" ]; then
    printf "%s\n" "$first_pid" > "$PID_FILE"
  fi
}

bridge_pgids() {
  for pid in $1; do
    ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]'
  done | awk 'NF' | sort -u
}

kill_bridge_groups() {
  local pids="$1"
  local signal="${2:-TERM}"
  local pgid

  for pgid in $(bridge_pgids "$pids"); do
    kill "-$signal" "-$pgid" 2>/dev/null || true
  done
}

start() {
  if launchd_loaded; then
    if launchd_running; then
      local pids
      pids="$(join_bridge_pids)"
      [ -n "$pids" ] && repair_pid_file "$pids"
      echo "⚠️  Bridge already running via launchd $LAUNCHD_LABEL (PID $(launchd_pid))"
      return 1
    fi

    launchctl kickstart "$(launchd_target)"
    sleep 1
    echo "✅ Bridge started via launchd $LAUNCHD_LABEL"
    return 0
  fi

  local running_pids
  running_pids="$(join_bridge_pids)"
  if [ -n "$running_pids" ]; then
    repair_pid_file "$running_pids"
    echo "⚠️  Bridge already running (PID(s) $running_pids)"
    return 1
  fi

  local pid
  pid="$(pid_file_pid)"
  if is_pid_running "$pid"; then
    echo "⚠️  Bridge already running (PID $pid)"
    return 1
  fi
  rm -f "$PID_FILE"

  # Check tmux is running
  if ! tmux list-sessions >/dev/null 2>&1; then
    echo "❌ tmux is not running. Start a tmux session first."
    return 1
  fi

  if [ -z "${SLACK_BOT_TOKEN:-}" ] || [ -z "${SLACK_APP_TOKEN:-}" ]; then
    echo "❌ SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set"
    echo "   Add them to $ENV_FILE or export before starting"
    return 1
  fi

  cd "$SCRIPT_DIR"
  BRIDGE_SCRIPT_DIR="$SCRIPT_DIR" BRIDGE_LOG_FILE="$LOG_FILE" BRIDGE_PID_FILE="$PID_FILE" python3 - <<'PY'
import os
import subprocess

cwd = os.environ["BRIDGE_SCRIPT_DIR"]
log_path = os.environ["BRIDGE_LOG_FILE"]
pid_path = os.environ["BRIDGE_PID_FILE"]

log = open(log_path, "ab", buffering=0)
process = subprocess.Popen(
    ["npx", "tsx", "slack-bridge.ts"],
    cwd=cwd,
    env=os.environ.copy(),
    stdin=subprocess.DEVNULL,
    stdout=log,
    stderr=log,
    start_new_session=True,
)

with open(pid_path, "w") as pid_file:
    pid_file.write(f"{process.pid}\n")
PY
  echo "✅ Bridge started (PID $(cat "$PID_FILE"))"
  echo "   Logs: $LOG_FILE"
}

stop() {
  if launchd_loaded; then
    launchctl kill SIGTERM "$(launchd_target)" 2>/dev/null || true
    sleep 1
    if launchd_running; then
      echo "⚠️  Bridge launchd service is still running/restarted (PID $(launchd_pid)); use launchctl bootout to unload it"
    else
      rm -f "$PID_FILE"
      echo "✅ Bridge stopped via launchd $LAUNCHD_LABEL"
    fi
    return 0
  fi

  local pids
  pids="$(join_bridge_pids)"

  local pid
  pid="$(pid_file_pid)"
  if [ -z "$pids" ] && is_pid_running "$pid"; then
    pids="$pid"
  fi

  if [ -n "$pids" ]; then
    kill_bridge_groups "$pids" TERM
    sleep 1

    local still_running
    still_running="$(join_bridge_pids)"
    if [ -n "$still_running" ]; then
      echo "⚠️  Bridge still running after SIGTERM (PID(s) $still_running); sending SIGKILL"
      kill_bridge_groups "$still_running" KILL
    fi

    rm -f "$PID_FILE"
    echo "✅ Bridge stopped (PID(s) $pids)"
  else
    rm -f "$PID_FILE"
    echo "⚠️  No running bridge process found"
  fi
}

status() {
  local pids
  pids="$(join_bridge_pids)"

  local pid
  pid="$(pid_file_pid)"
  if [ -z "$pids" ] && is_pid_running "$pid"; then
    pids="$pid"
  fi

  if launchd_loaded && launchd_running; then
    [ -n "$pids" ] && repair_pid_file "$pids"
    echo "✅ Running via launchd $LAUNCHD_LABEL (PID $(launchd_pid); bridge PID(s) ${pids:-unknown})"
  elif [ -n "$pids" ]; then
    repair_pid_file "$pids"
    echo "✅ Running (PID(s) $pids)"
  elif launchd_loaded; then
    rm -f "$PID_FILE"
    echo "⏹  Launchd service loaded but not running: $LAUNCHD_LABEL"
  else
    rm -f "$PID_FILE"
    echo "⏹  Stopped"
  fi
  echo ""
  echo "Recent logs:"
  tail -10 "$LOG_FILE" 2>/dev/null || echo "  (no logs yet)"
}

case "${1:-help}" in
  start)   start ;;
  stop)    stop ;;
  restart)
    if launchd_loaded; then
      launchctl kickstart -k "$(launchd_target)"
      sleep 1
      status
    else
      stop; sleep 1; start
    fi
    ;;
  status)  status ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac
