#!/bin/bash
# PM pane Stop hook — auto-relay last response to Slack when PM didn't reply via MCP.
#
# How it works:
#   1. slack-bridge writes /tmp/slack-bridge-last-inject.json (channel + thread_ts) before
#      injecting each incoming Slack message to the PM pane.
#   2. This Stop hook fires when the PM finishes responding.
#   3. If PM already called mcp__slack__conversations_add_message in this turn → skip.
#   4. Otherwise, post the last assistant message text to the Slack thread.
#   5. Delete the pending file.
#
# Stdin JSON from Claude Code: { "session_id": "...", "stop_hook_active": ..., "cwd": "..." }

PENDING_FILE="/tmp/slack-bridge-last-inject.json"

# Fast-exit: no pending Slack message to reply to
[ -f "$PENDING_FILE" ] || exit 0

# Read hook input
INPUT=$(cat)

# CRITICAL: Prevent infinite loop — stop hooks can fire recursively
STOP_HOOK_ACTIVE=$(echo "$INPUT" | python3 -c \
  "import json,sys; d=json.load(sys.stdin); print(d.get('stop_hook_active', False))" 2>/dev/null)
if [ "$STOP_HOOK_ACTIVE" = "True" ] || [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

# Extract session context
SESSION_ID=$(echo "$INPUT" | python3 -c \
  "import json,sys; d=json.load(sys.stdin); print(d.get('session_id', ''))" 2>/dev/null)
CWD=$(echo "$INPUT" | python3 -c \
  "import json,sys; d=json.load(sys.stdin); print(d.get('cwd', ''))" 2>/dev/null)

[ -z "$SESSION_ID" ] || [ -z "$CWD" ] && exit 0

# Find JSONL session file
PROJECT_DIR_NAME=$(echo "$CWD" | sed 's|^/||; s|/|-|g')
JSONL="$HOME/.claude/projects/-${PROJECT_DIR_NAME}/${SESSION_ID}.jsonl"
[ -f "$JSONL" ] || exit 0

# Use Python to do all the heavy lifting: check if already replied + build payload.
# Doing this in one Python call avoids shell escaping issues with message text.
export SESSION_ID CWD

CURL_PAYLOAD=$(python3 - <<'PYEOF'
import json, sys, os

PENDING_FILE = '/tmp/slack-bridge-last-inject.json'

# Load pending context
try:
    ctx = json.load(open(PENDING_FILE))
    channel = ctx.get('channel', '')
    thread_ts = ctx.get('thread_ts', '')
    if not channel or not thread_ts:
        sys.exit(1)
except Exception:
    sys.exit(1)

# Find JSONL
session_id = os.environ.get('SESSION_ID', '')
cwd = os.environ.get('CWD', '')
if not session_id or not cwd:
    sys.exit(1)

project_dir = cwd.lstrip('/').replace('/', '-')
home = os.path.expanduser('~')
jsonl_path = f"{home}/.claude/projects/-{project_dir}/{session_id}.jsonl"

try:
    with open(jsonl_path) as f:
        lines = f.readlines()
except Exception:
    sys.exit(1)

# Check if this turn already called Slack conversations_add_message
# Scan last 50 lines (one full turn with tool calls)
for line in lines[-50:]:
    try:
        obj = json.loads(line.strip())
        for block in obj.get('message', {}).get('content', []):
            if (block.get('type') == 'tool_use' and
                    'add_message' in block.get('name', '')):
                sys.exit(0)  # Already replied — no auto-post needed
    except Exception:
        pass

# Find the last assistant text message
last_text = ''
for line in lines:
    try:
        obj = json.loads(line.strip())
        if obj.get('type') == 'assistant':
            texts = [
                b['text']
                for b in obj.get('message', {}).get('content', [])
                if b.get('type') == 'text' and b.get('text', '').strip()
            ]
            if texts:
                last_text = '\n'.join(texts)
    except Exception:
        pass

if not last_text.strip():
    sys.exit(1)

# Output JSON payload for curl
payload = {
    'channel': channel,
    'thread_ts': thread_ts,
    'text': last_text[:3000],
}
print(json.dumps(payload))
PYEOF
)

EXIT_CODE=$?

# Exit code 0 from Python means "already replied" (sys.exit(0) in the check above)
# Exit code 1 means "not replied, no payload" — clean up and exit
# If we got a payload (non-empty CURL_PAYLOAD), post it

if [ $EXIT_CODE -ne 0 ] || [ -z "$CURL_PAYLOAD" ]; then
  rm -f "$PENDING_FILE"
  exit 0
fi

# Load Slack bot token from bridge .env
BRIDGE_ENV="$HOME/Downloads/projects/tmux-slack-bridge/.env"
SLACK_TOKEN=""
if [ -f "$BRIDGE_ENV" ]; then
  SLACK_TOKEN=$(grep "^SLACK_BOT_TOKEN=" "$BRIDGE_ENV" | cut -d= -f2- | tr -d '"' | tr -d "'")
fi

if [ -z "$SLACK_TOKEN" ]; then
  rm -f "$PENDING_FILE"
  exit 0
fi

# Post to Slack
curl -s -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $SLACK_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$CURL_PAYLOAD" > /dev/null 2>&1

rm -f "$PENDING_FILE"
exit 0
