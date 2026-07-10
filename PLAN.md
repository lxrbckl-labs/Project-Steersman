# Build plan — Project Steersman

Build order is chosen so each layer is testable before the next is added. The hard,
novel part (CDP bridge) is isolated and tackled first behind a tiny test surface.

## Phase 0 — Scaffold ✅
- package.json, README, PLAN, CLAUDE.md, .vscode/launch.json, .gitignore.

## Phase 1 — CDP bridge (the load-bearing part) ✅ written (needs F5 test)
- `cdp-tab.js`: primary path = proposed `browser` API (`openBrowserTab` +
  `BrowserTab.startCDPSession`); fallback = `editor-browser` debug session +
  `requestCDPProxy` WebSocket. Shared bootstrap: `Target.attachToBrowserTarget` →
  `getTargets` → `attachToTarget{flatten}` → enable `Runtime`/`Page`/`DOM`.
- **Test:** F5 → "Open Browser + Connect CDP" → integrated tab appears + navigates.

## Phase 2 — HTTP API ✅ written (needs F5 test)
- Built-in `http` server (default 3788, increments if taken) exposing
  `navigate, url, text, click, type, eval, screenshot`, plus `/health`.
- **Test:** `curl` each endpoint; watch the integrated tab react.

## Phase 3 — MCP wrapper
- `mcp-server.js`: stdio MCP server, thin client over the HTTP API.
- Auto-register in `~/.claude.json`; discover the active window/port via an instances file.
- **Test:** from Claude Code, call `browser_navigate` etc.

## Phase 4 — Robustness / niceties
- Reconnect if the debug session dies; multiple tabs; status command; teardown on deactivate.
- Later (optional): proposed-API path via `vscode.window.openBrowserTab`.

## Known risks / to verify at runtime
- Exact `requestCDPProxy` return shape and WebSocket handshake.
- Whether `editor-browser` is the correct debug `type` and its required config fields.
- Whether a target attach (`Target.attachToTarget` + flatten) is needed vs. the proxy
  giving a page-scoped session directly.
