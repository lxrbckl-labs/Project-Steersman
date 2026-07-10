# Project Steersman — dev & driving guide

This extension exposes VS Code's **built-in integrated browser** to agents over an HTTP
API (and, later, MCP). One integrated browser tab; the extension holds its CDP session.

## Architecture (see README for the diagram)

- `extension.js` runs inside VS Code, owns the CDP connection to the integrated browser,
  and serves the HTTP API on `localhost:3788`.
- `mcp-server.js` (Phase 3) is a separate stdio process that turns MCP tool calls into
  HTTP calls to the extension.

## Running it (dev)

1. `npm install` in this folder.
2. Open the folder in VS Code, press **F5** ("Run Project Steersman"). A second
   VS Code window (Extension Development Host) opens with the extension loaded.
3. In that window: `Ctrl+Shift+P` → **Project Steersman: Open Panel**.
   The integrated browser tab should appear and load `startUrl`.

## Testing the HTTP API (Phase 2)

```bash
curl -X POST localhost:3788/navigate -H "content-type: application/json" -d "{\"url\":\"https://example.com\"}"
curl "localhost:3788/text"
curl "localhost:3788/url"
curl -X POST localhost:3788/eval -H "content-type: application/json" -d "{\"js\":\"document.title\"}"
```

Watch the integrated browser tab react in the Extension Development Host window.

## Notes / gotchas (fill in as we learn them at runtime)

- The integrated browser is driven through VS Code's debug machinery, NOT a raw port.
  We open an `editor-browser` debug session, then request js-debug's CDP proxy and speak
  CDP over a WebSocket. Exact API shapes are being verified against the reference repo.
- This depends on `ms-vscode.js-debug` (declared in package.json extensionDependencies).
- Requires VS Code 1.112+ (integrated browser + editor-browser debug type).
