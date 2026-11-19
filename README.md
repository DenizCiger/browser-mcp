# browser-mcp

Browser use for Claude (Code and Desktop) over MCP, built for sites behind a login.

- **One real Chrome, persistent profile** (`~/.local/share/browser-mcp/profile`). The first
  server process starts it detached with a localhost-only DevTools port (9333); every other
  process (Claude Code, Claude Desktop, parallel sessions) connects to the same browser, so
  logins are shared and survive sessions.
- **`fill_login` from Bitwarden.** When a site logs you out, the agent calls `fill_login`.
  The server picks the matching Bitwarden item (`bw list items --url`, preferring items
  saved for the exact host), asks you in a local zenity dialog, then fills and submits the
  form itself. Passwords and TOTP codes never appear in tool output.
- **Self-unlocking vault.** The master password is asked once in a local dialog and kept in
  the Secret Service keyring (gnome-keyring), together with the current session key. After a
  reboot or `bw lock` the server unlocks on its own.

## Tools

`navigate` · `snapshot` (text outline with `[eN]` refs) · `get_text` · `click` · `type`
(refuses password / one-time-code / card fields) · `select_option` · `press_key` · `scroll`
· `wait_for` · `screenshot` · `tabs` · `fill_login`

## Setup

```sh
npm install
claude mcp add browser -s user -- /usr/bin/node "$PWD/src/index.ts"
```

Claude Desktop (`~/.config/Claude/claude_desktop_config.json`):

```json
"mcpServers": {
  "browser": { "command": "/usr/bin/node", "args": ["/home/deniz/dev/hobby/ai/browser-mcp/src/index.ts"] }
}
```

Requirements: Node ≥ 23 (runs the TypeScript directly), Chrome/Chromium, `bw` (logged in
once with `bw login`), `zenity`, `secret-tool`.

### Environment variables

| Variable | Default |
| --- | --- |
| `BROWSER_MCP_PROFILE` | `~/.local/share/browser-mcp/profile` |
| `BROWSER_MCP_PORT` | `9333` |
| `BROWSER_MCP_HEADLESS` | off (a visible window, so you can solve CAPTCHAs / 2FA) |
| `BROWSER_MCP_CHROME` | first of google-chrome-stable, chromium, … |
| `BROWSER_MCP_BW`, `BROWSER_MCP_ZENITY` | `bw`, `zenity` |

## Security notes

- Secrets stay inside the server process, but anything running as your user (including an
  agent with a shell) could still read the keyring or drive Chrome through the DevTools
  port. The design keeps secrets out of the agent's context; it is not a sandbox.
- Every fill needs your click in the dialog, which names the site and the Bitwarden item and
  warns when the item is not saved for that site. Credentials are never filled over plain
  http (except localhost).
- To forget the stored master password:
  `secret-tool clear service browser-mcp key bw-master`

## Dev helpers

- `node scripts/call.ts navigate '{"url":"…"}' snapshot '{}'` – call tools from the shell
- `scripts/stop-browser.sh` – stop the shared Chrome
- `npm run check` – type-check
- Chrome's output: `~/.local/share/browser-mcp/chrome.log`
