#!/bin/bash
# setup.sh — Install/uninstall the pm-reply-to-slack Stop hook.
#
# Auto-detects the target project from TMUX_TARGET in .env:
# reads the pane's current path via tmux, then installs the hook
# into that project's .claude/settings.json.
#
# Usage:
#   ./setup.sh              # Install (auto-detects project from TMUX_TARGET)
#   ./setup.sh --uninstall  # Remove the Stop hook
#
# Prerequisites: jq, tmux running with target pane active

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_SCRIPT="$SCRIPT_DIR/scripts/reply-to-slack.sh"
HOOK_CMD="bash $HOOK_SCRIPT"

UNINSTALL=false
for arg in "$@"; do
  [ "$arg" = "--uninstall" ] && UNINSTALL=true
done

# --- Preflight ---
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required (brew install jq)" >&2
  exit 1
fi

if ! command -v tmux &>/dev/null; then
  echo "ERROR: tmux is required" >&2
  exit 1
fi

# --- Load TMUX_TARGET from .env ---
ENV_FILE="$SCRIPT_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env not found at $ENV_FILE" >&2
  exit 1
fi

TMUX_TARGET=$(grep "^TMUX_TARGET=" "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
if [ -z "$TMUX_TARGET" ]; then
  echo "ERROR: TMUX_TARGET not set in .env" >&2
  exit 1
fi

# --- Detect project from pane's current path ---
PANE_PATH=$(tmux display-message -t "$TMUX_TARGET" -p '#{pane_current_path}' 2>/dev/null || true)
if [ -z "$PANE_PATH" ]; then
  echo "ERROR: Could not get path from pane $TMUX_TARGET — is tmux running?" >&2
  exit 1
fi

SETTINGS="$PANE_PATH/.claude/settings.json"

echo "Target pane:  $TMUX_TARGET"
echo "Project path: $PANE_PATH"
echo "Settings:     $SETTINGS"

# --- Install or uninstall ---
mkdir -p "$PANE_PATH/.claude"
if [ ! -f "$SETTINGS" ]; then
  echo '{}' > "$SETTINGS"
fi

if ! jq . "$SETTINGS" > /dev/null 2>&1; then
  echo "ERROR: $SETTINGS is not valid JSON" >&2
  exit 1
fi

TMP=$(mktemp)

if [ "$UNINSTALL" = "true" ]; then
  jq 'del(.hooks.Stop)' "$SETTINGS" > "$TMP"
  if jq . "$TMP" > /dev/null 2>&1; then
    mv "$TMP" "$SETTINGS"
    echo "✅ Stop hook removed"
  else
    rm -f "$TMP"
    echo "ERROR: Failed to update settings.json" >&2
    exit 1
  fi
else
  if [ ! -f "$HOOK_SCRIPT" ]; then
    echo "ERROR: Hook script not found: $HOOK_SCRIPT" >&2
    exit 1
  fi
  jq --arg cmd "$HOOK_CMD" '
    .hooks.Stop = [{
      "hooks": [{
        "type": "command",
        "command": $cmd,
        "timeout": 15
      }]
    }]
  ' "$SETTINGS" > "$TMP"

  if jq . "$TMP" > /dev/null 2>&1; then
    mv "$TMP" "$SETTINGS"
    echo "✅ Stop hook installed"
    echo "   Command: $HOOK_CMD"
    echo ""
    echo "Restart Claude Code in the project to activate the hook."
  else
    rm -f "$TMP"
    echo "ERROR: Failed to update settings.json" >&2
    exit 1
  fi
fi
