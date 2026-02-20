#!/bin/bash
# setup.sh — Install the pm-reply-to-slack Stop hook into a Claude Code project.
#
# Adds a Stop hook to the target project's .claude/settings.json that auto-relays
# PM pane responses back to Slack when Claude doesn't reply via MCP directly.
#
# Usage:
#   ./setup.sh                                  # Install into ~/Downloads/projects/heydonna-app
#   ./setup.sh /path/to/project                 # Install into a specific project
#   ./setup.sh --uninstall [/path/to/project]   # Remove the Stop hook
#
# Prerequisites: jq

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_CMD="bash $SCRIPT_DIR/scripts/pm-reply-to-slack.sh"
DEFAULT_TARGET="$HOME/Downloads/projects/heydonna-app"

UNINSTALL=false
TARGET=""

for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=true ;;
    *) TARGET="$arg" ;;
  esac
done

TARGET="${TARGET:-$DEFAULT_TARGET}"
SETTINGS="$TARGET/.claude/settings.json"

# Validate
if [ ! -d "$TARGET" ]; then
  echo "ERROR: Project directory not found: $TARGET" >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required (brew install jq)" >&2
  exit 1
fi

# Create .claude dir and settings.json if they don't exist
mkdir -p "$TARGET/.claude"
if [ ! -f "$SETTINGS" ]; then
  echo '{}' > "$SETTINGS"
  echo "Created $SETTINGS"
fi

# Validate existing settings.json
if ! jq . "$SETTINGS" > /dev/null 2>&1; then
  echo "ERROR: $SETTINGS is not valid JSON" >&2
  exit 1
fi

TMP=$(mktemp)

if [ "$UNINSTALL" = "true" ]; then
  # Remove Stop hook
  jq 'del(.hooks.Stop)' "$SETTINGS" > "$TMP"
  if jq . "$TMP" > /dev/null 2>&1; then
    mv "$TMP" "$SETTINGS"
    echo "✅ Stop hook removed from $SETTINGS"
  else
    rm -f "$TMP"
    echo "ERROR: Failed to update settings.json" >&2
    exit 1
  fi
else
  # Add/replace Stop hook
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
    echo "   Project:  $TARGET"
    echo "   Settings: $SETTINGS"
    echo "   Command:  $HOOK_CMD"
    echo ""
    echo "Restart Claude Code in the project to activate the hook."
  else
    rm -f "$TMP"
    echo "ERROR: Failed to update settings.json" >&2
    exit 1
  fi
fi
