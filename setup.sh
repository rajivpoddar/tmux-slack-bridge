#!/bin/bash
# setup.sh — Install the pm-reply-to-slack Stop hook into a Claude Code project.
#
# Adds a Stop hook to the target project's .claude/settings.json that auto-relays
# PM pane responses back to Slack when Claude doesn't reply via MCP directly.
#
# The hook script lives in the MoP plugin:
#   ~/.claude/plugins/cache/rajiv-plugins/master-of-panes/1.0.0/scripts/pm-reply-to-slack.sh
#
# Usage:
#   ./setup.sh /path/to/project                 # Install into a project
#   ./setup.sh --uninstall /path/to/project     # Remove the Stop hook
#
# Prerequisites: jq, master-of-panes plugin installed

set -euo pipefail

MOP_HOOK="$HOME/.claude/plugins/cache/rajiv-plugins/master-of-panes/1.0.0/scripts/pm-reply-to-slack.sh"
HOOK_CMD="bash $MOP_HOOK"

UNINSTALL=false
TARGET=""

for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=true ;;
    *) TARGET="$arg" ;;
  esac
done

if [ -z "$TARGET" ]; then
  echo "Usage: ./setup.sh /path/to/project" >&2
  echo "       ./setup.sh --uninstall /path/to/project" >&2
  exit 1
fi

SETTINGS="$TARGET/.claude/settings.json"

if [ ! -d "$TARGET" ]; then
  echo "ERROR: Project directory not found: $TARGET" >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required (brew install jq)" >&2
  exit 1
fi

if [ ! -f "$MOP_HOOK" ] && [ "$UNINSTALL" = "false" ]; then
  echo "ERROR: MoP hook not found: $MOP_HOOK" >&2
  echo "Install the master-of-panes plugin first." >&2
  exit 1
fi

mkdir -p "$TARGET/.claude"
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
    echo "✅ Stop hook removed from $SETTINGS"
  else
    rm -f "$TMP"
    echo "ERROR: Failed to update settings.json" >&2
    exit 1
  fi
else
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
