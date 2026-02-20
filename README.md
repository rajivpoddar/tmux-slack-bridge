# tmux-slack-bridge

Two-way relay between Slack DMs and a tmux pane running Claude Code.

Forwards incoming Slack DM messages to a configured tmux pane, and sends Claude Code's replies back to Slack automatically via a Claude Code `Stop` hook.

## How It Works

```
You (Slack DM) → bridge → tmux send-keys → Claude Code PM pane
Claude Code PM pane → Stop hook → reply-to-slack.sh → Slack DM thread
```

1. You send a DM to your Slack bot
2. The bridge forwards it to the configured tmux pane as keyboard input
3. Claude Code processes the message
4. When Claude Code finishes responding, the `Stop` hook captures the last reply and posts it back to your Slack thread

## Designed for Master of Panes

This bridge is designed to work alongside the [Master of Panes](https://github.com/rajivpoddar/master-of-panes) Claude Code plugin. MoP orchestrates parallel dev sessions across tmux panes; the bridge lets you remotely command the PM pane from Slack while away from the terminal.

**Typical setup:**
- MoP manages 1 PM pane + 4 dev panes
- The bridge points at the PM pane (`TMUX_TARGET=0:0.0`)
- You DM the bot from your phone → MoP's PM session receives and acts
- The Stop hook replies to your Slack thread automatically

The bridge works standalone too — it just forwards Slack DMs to any tmux pane.

## Prerequisites

- **tmux** running with a Claude Code session in the target pane
- **Node.js** 18+ (for running the bridge)
- **Slack App** with Socket Mode enabled (see setup below)
- **Slack MCP server** configured in Claude Code (required for Claude Code to send messages back independently — see note below)
- **Master of Panes** plugin (recommended) — [github.com/rajivpoddar/master-of-panes](https://github.com/rajivpoddar/master-of-panes)

## Slack App Setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**

2. Under **OAuth & Permissions** → **Scopes** → **Bot Token Scopes**, add:
   - `chat:write`
   - `im:history`
   - `im:read`
   - `im:write`

3. Under **Event Subscriptions**:
   - Enable Events
   - Subscribe to bot events: `message.im`

4. Under **Socket Mode**: enable Socket Mode, generate an **App-Level Token** (`xapp-...`) with `connections:write` scope

5. Install the app to your workspace → copy the **Bot Token** (`xoxb-...`)

6. DM your bot in Slack to open the conversation. Right-click the DM → **Copy link** to get the channel ID (`D0...`)

## Slack MCP Server (Required for Claude Code)

The bridge handles *incoming* messages (Slack → tmux). For Claude Code to send messages *proactively* (or reply from within its tools), it needs the Slack MCP server:

```bash
# Add to ~/.claude/claude_desktop_config.json or ~/.claude/mcp.json:
{
  "mcpServers": {
    "slack": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-slack"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-your-token",
        "SLACK_TEAM_ID": "T..."
      }
    }
  }
}
```

Without the MCP server, Claude Code can only reply via the `Stop` hook (automatic reply at end of each response). With it, Claude Code can also DM you proactively (CI notifications, escalations, etc.).

## Installation

```bash
git clone https://github.com/rajivpoddar/tmux-slack-bridge.git
cd tmux-slack-bridge
npm install
cp .env.example .env
```

Edit `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token      # From OAuth & Permissions
SLACK_APP_TOKEN=xapp-your-app-token      # From Socket Mode (connections:write scope)
SLACK_CHANNEL=D0123456789                # Your DM channel ID (right-click DM → Copy link)
TMUX_TARGET=0:0.0                        # tmux pane address (session:window.pane)
```

## Start the Bridge

```bash
./slack-bridge.sh start    # Start in background
./slack-bridge.sh status   # Check status + recent logs
./slack-bridge.sh stop     # Stop
./slack-bridge.sh restart  # Restart
```

Logs: `/tmp/slack-bridge.log`

## Install the Reply Hook

The `Stop` hook automatically sends Claude Code's last reply back to Slack when it finishes responding.

Run once per Claude Code project you want to use with the bridge:

```bash
./setup.sh
```

This reads `TMUX_TARGET` from `.env`, detects the project path from that pane, and installs a `Stop` hook into the project's `.claude/settings.json`. Restart Claude Code in the project to activate.

To remove:

```bash
./setup.sh --uninstall
```

## Usage

Once everything is running:

1. Send a DM to your Slack bot
2. The bridge forwards it to your tmux pane — Claude Code receives and processes it
3. When Claude Code finishes, the Stop hook posts the reply back to your Slack thread
4. You can reply in the thread — the bridge tracks thread context and includes the quoted parent message

## Troubleshooting

**Bridge not forwarding messages**: Check `TMUX_TARGET` is correct — run `tmux list-panes -a -F "#{session_name}:#{window_index}.#{pane_index}"` to list all panes.

**Stop hook not firing**: Restart Claude Code in the project after running `setup.sh`. Verify the hook is in `.claude/settings.json` under `hooks.Stop`.

**Replies not posting**: Check `SLACK_CHANNEL` is set to your DM channel ID (not a channel name). The hook uses `SLACK_BOT_TOKEN` from `.env`.

**Socket Mode errors**: Ensure your App-Level Token has `connections:write` scope and Socket Mode is enabled in your Slack app settings.
