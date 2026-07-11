# Project Steersman

Expose **VS Code's built-in integrated browser** (the `editor-browser` introduced in
VS Code 1.112) to Claude Code and other agents, via a local HTTP API and an MCP server.

Unlike a separate-Chromium approach, this drives the *real* integrated browser tab —
your session cookies, your localhost dev server, your DevTools — no second window, no
screencast mirror.

## Architecture

```
Claude Code ──MCP (stdio)──▶ mcp-server.js ──HTTP──▶ extension.js ──CDP (ws)──▶ integrated browser tab
                             (thin client)           (inside VS Code)            (a real VS Code editor tab)
```

- **extension.js** — runs inside VS Code. Opens the integrated browser via an
  `editor-browser` debug session, obtains a CDP proxy from `vscode-js-debug`
  (`extension.js-debug.requestCDPProxy`), opens a WebSocket to it, and speaks raw CDP.
  Exposes a local HTTP API (default `localhost:3788`).
- **mcp-server.js** — a standalone stdio MCP server launched by Claude Code. It is a
  thin client that translates MCP tool calls into HTTP requests to the extension.
  Auto-registered in `~/.claude.json`.

Why the split: only in-process extension code can reach the integrated browser's CDP.
The MCP server can't do it directly, so it goes through the extension's HTTP API. This
also means the HTTP API is independently testable with `curl` before any MCP wiring.

## Connection paths to the browser

1. **Debug-session path (default, works on stable VS Code 1.112+):**
   start an `editor-browser` debug session, then `requestCDPProxy` → WebSocket → CDP.
2. **Proposed-API path (optional, later):** `vscode.window.openBrowserTab`, enabled with
   `code --enable-proposed-api=<publisher>.project-steersman`. Cleaner multiplexed
   CDP, but may require Insiders. Not the foundation.

## HTTP API

Every request must send the header `x-steersman-token: <token>` and a loopback `Host`
(non-loopback hosts are rejected, DNS-rebinding defense). Each session is addressed by its
`instance` id (`win-1`, `win-2`, …) — query string for GET, JSON body for POST; POST bodies
default to the most-recently-created connected window when `instance` is omitted.

Most endpoints are **operator-gated** by a capability toggled in the panel: when a
capability is disabled the endpoint returns **HTTP 403** (`{"error":"capability disabled"}`).
The observation/wait endpoints (`GET /windows`, `GET /window`, `GET /url`, `POST /wait`)
carry no gate and are always available (behind host + token). Sensitive endpoints and their
gating capability: `POST /navigate` (`navigate`), `GET /text` (`read`), `POST /click` ·
`/type` · `/scroll` · `/press` · `/hover` (`interact`), `GET /screenshot` (`screenshot`),
`POST /eval` (`eval`), `POST /windows` (`create_window`), `POST /window/close`
(`close_window`), `GET /scripts` · `POST /script/run` (`run_script`). `GET /health` and
`GET /capabilities` are also served (host + token, no capability gate).

**Live API reference** — the full, capability-filtered endpoint listing (request shapes and
examples, reflecting exactly the currently-enabled capabilities) is served as markdown at:

- `GET /docs/tab` — reference for driving a single window.
- `GET /docs/fleet` — reference for managing all windows (enumerate, create, drive any).

The `/docs/*` routes stay behind the loopback `Host` check but are **exempt from the token +
capability gates** (they are how an agent discovers the API, so requiring the token would be a
chicken-and-egg). Every *other* request needs the `x-steersman-token` header.

The panel's **Copy prompt** button produces a short natural-language driving guide (role +
bootstrap) that points the agent at `/docs/tab` (or `/docs/fleet`) for the full endpoint
reference, with the token header pre-filled.

## Status

Phases 1–2 written (CDP bridge + HTTP API), pending first F5 test. Phase 3 (MCP
wrapper + `~/.claude.json` registration) not started. See `PLAN.md` for build order
and `CLAUDE.md` for how to drive/test it.

### First test (F5)

1. `npm install` (done — only `ws`).
2. `code C:\Users\aarbuckle\Project-Steersman`, press **F5** → Extension
   Development Host window opens (this auto-enables the proposed `browser` API).
3. In that window: `Ctrl+Shift+P` → **Project Steersman: Open Panel**.
   Expect an integrated browser tab to appear.
4. From a terminal, drive it:
   ```
   curl -X POST localhost:3788/navigate -H "content-type: application/json" -d "{\"url\":\"https://example.com\"}"
   curl localhost:3788/url
   ```
5. Check the **Output → "Project Steersman"** channel for `[CDP] connected (...)`
   and which transport was used (browserTab vs websocket).
