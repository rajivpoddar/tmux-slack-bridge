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

SLACK_PAYLOAD=$(python3 - <<'PYEOF'
import json, sys, os, time, subprocess

PENDING_FILE = '/tmp/slack-bridge-last-inject.json'

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

LOCK_FILE = PENDING_FILE + '.lock'
deadline = time.time() + 1.5
lock_fd = None
def owner_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except Exception:
        return False
while time.time() < deadline:
    try:
        lock_fd = os.open(LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(lock_fd, str(os.getpid()).encode())
        break
    except FileExistsError:
        try:
            with open(LOCK_FILE) as f:
                owner = int((f.read().strip() or '0'))
            if owner > 0 and not owner_alive(owner):
                os.remove(LOCK_FILE)
                continue
        except (ValueError, OSError):
            pass
        time.sleep(0.025)
if lock_fd is None:
    sys.exit(1)

try:
    raw = json.load(open(PENDING_FILE))
    queue = raw if isinstance(raw, list) else [raw]
    if len(queue) == 0:
        os.remove(PENDING_FILE)
        sys.exit(1)
    if not isinstance(queue[0], dict):
        sys.exit(1)
    ctx = queue.pop(0)  # Pop oldest, but commit only after verified success
    channel = ctx.get('channel', '')
    thread_ts = ctx.get('thread_ts', '')
    if not channel or not thread_ts:
        sys.exit(1)

    def commit_removal():
        if queue:
            with open(PENDING_FILE, 'w') as f:
                json.dump(queue, f)
        else:
            os.remove(PENDING_FILE)

    # Already replied via MCP or direct API this turn?
    for line in lines[-50:]:
        try:
            obj = json.loads(line.strip())
            for block in obj.get('message', {}).get('content', []):
                if block.get('type') == 'tool_use':
                    tool_name = block.get('name', '')
                    if 'add_message' in tool_name or 'send_message' in tool_name:
                        commit_removal()
                        sys.exit(0)
                    if tool_name == 'Bash':
                        cmd = block.get('input', {}).get('command', '')
                        if 'chat.postMessage' in cmd and thread_ts in cmd:
                            commit_removal()
                            sys.exit(0)
        except Exception:
            pass

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
        commit_removal()
        sys.exit(1)

    _converter = os.path.expanduser('~/.claude/skills/slack-markdown/scripts/md-to-mrkdwn.py')
    try:
        _result = subprocess.run(
            ['python3', _converter],
            input=last_text, capture_output=True, text=True, timeout=5
        )
        converted_text = _result.stdout if _result.returncode == 0 else last_text
    except Exception:
        converted_text = last_text

    payload = {
        'channel': channel,
        'thread_ts': thread_ts,
        'text': converted_text[:3000],
    }

    bridge_dir = os.path.expanduser('~/Downloads/projects/tmux-slack-bridge')
    npx_candidate = os.path.expanduser('~/.nvm/versions/node/v22.13.1/bin/npx')
    npx_bin = npx_candidate if os.path.isfile(npx_candidate) and os.access(npx_candidate, os.X_OK) else 'npx'
    try:
        proc = subprocess.run(
            [npx_bin, '--no-install', 'tsx', 'scripts/post-and-record-slack-reply.ts'],
            input=json.dumps(payload), capture_output=True, text=True, timeout=60,
            cwd=bridge_dir, env=os.environ.copy()
        )
        ok = proc.returncode == 0
    except Exception:
        ok = False

    if ok:
        commit_removal()
    else:
        queue.insert(0, ctx)
        with open(PENDING_FILE, 'w') as f:
            json.dump(queue, f)
    sys.exit(0 if ok else 1)
finally:
    os.close(lock_fd)
    try:
        os.remove(LOCK_FILE)
    except OSError:
        pass
PYEOF
)

# Queue commit/restore is already handled under the lock. Keep the hook exit
# neutral so a transient post failure does not surface as a Claude error.
exit 0
