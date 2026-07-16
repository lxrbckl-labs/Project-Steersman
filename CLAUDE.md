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

## Updating the extension (self-update)

The Settings panel's update button performs a local, git-based reinstall: it runs `build/reinstall.sh` under `bash -lc`, which executes `git pull --ff-only`, `vsce package`, and `code --install-extension` using your ambient git credentials — no PAT required, so the private repo is transparent.

**First-time bootstrap on a fresh clone:** the installed vsix cannot deliver its own first copy, so bootstrap once manually:
```bash
bash -lc "<clone>/build/reinstall.sh --local"
```

The `--local` flag skips git and packages the current working tree; `unzip` is optional (only performs a vsix sanity check if present).

**Optional setting:** `projectSteersman.repoPath` (User `settings.json` only — workspace `.vscode/settings.json` may not reach the extension host even after reload). On WSL-remote setups, use the Windows-side User settings (`AppData/Roaming/Code/User/settings.json`), which do reach the WSL-remote extension. It is no longer required when the Project-Steersman clone is your open workspace folder — the extension auto-detects it (verified via `.git` plus a `package.json` whose `name` is `project-steersman`), so a vsix install driving its own repo works with no setting. Set `repoPath` only when you run the extension from a *different* workspace (a vsix install with some other folder open, so neither the workspace nor the install path — `~/.vscode-server/extensions/...`, which has `extension.js` but no `.git` — is the clone). This follows the same pattern as `ghola.repoPath`.

## Versioning

Every change ships as a version bump. After making **any** change, bump the version across the following locations before committing:

1. `package.json` — the top-level `version` field
2. `package-lock.json` — both the top-level `version` field and the root `packages[""].version` field
3. `mcp-server.js` — the MCP `Server` metadata version field

That is 4 locations across 3 files and **must stay in sync** for the release automation to work correctly.

Committing a version change triggers the `.githooks/post-commit` release hook, which builds the vsix, installs it locally, and creates a git tag (`vX.Y.Z`). Running `git push` (with `push.followTags` set) sends both the commit and the tag to the remote.

**Flow:** make change → bump version across mirrors → commit → push.
