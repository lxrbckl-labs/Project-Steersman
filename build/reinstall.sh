#!/usr/bin/env bash
# One command to package Project Steersman into a .vsix and install it into VS Code.
set -euo pipefail

# Resolve repo root from this script's own location so it works regardless of cwd.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[reinstall] repo root: $ROOT"

# --- Preflight: required tools -----------------------------------------------
# Note: in some shells `code` and/or `npm` only resolve inside a login shell
# (nvm/PATH setup lives in .bashrc/.profile, not picked up by non-login shells).
# If `code` (or `npm`/`npx`) isn't found, try re-running this script via:
#   bash -lc "$ROOT/build/reinstall.sh"
for tool in node npm npx code unzip; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[reinstall] ERROR: required tool '$tool' not found on PATH." >&2
    echo "[reinstall]        try: bash -lc \"$ROOT/build/reinstall.sh\" (login shell may pick up nvm/PATH)" >&2
    exit 1
  fi
done
echo "[reinstall] preflight OK: node, npm, npx, code, unzip all found"

# --- Install deps -------------------------------------------------------------
# Needed both so `vsce package` can read the manifest cleanly and so the
# separately-run mcp-server.js has its SDK (@modelcontextprotocol/sdk) present.
echo "[reinstall] npm install..."
npm install

# --- Clean prior builds ---------------------------------------------------
echo "[reinstall] removing prior .vsix builds..."
rm -f project-steersman-*.vsix

VERSION="$(node -p "require('./package.json').version")"
echo "[reinstall] packaging project-steersman version $VERSION..."

# --allow-missing-repository / --skip-license suppress interactive prompts
# vsce would otherwise raise for a repo with no git remote and no LICENSE file.
# No --no-dependencies here: prod deps (ws) must ship for cdp-tab.js's
# `require('ws')` to work; vsce prunes devDependencies (the MCP SDK) on its own.
npx --yes @vscode/vsce package --allow-missing-repository --skip-license

VSIX="$(ls -t project-steersman-*.vsix | head -1)"
echo "[reinstall] built: $VSIX"

# --- Entry-point sanity check -------------------------------------------------
# package.json "main" is "./extension.js"; vsce stores repo files under an
# "extension/" prefix inside the vsix, so the packaged path is extension/extension.js.
# If that's missing, something is badly wrong with .vscodeignore/packaging -
# never install a vsix that can't even load its own entry point.
if ! unzip -l "$VSIX" | grep -q "extension/extension.js"; then
  echo "[reinstall] ERROR: packaged vsix is missing the entry point — aborting install" >&2
  exit 1
fi
echo "[reinstall] entry-point check OK: extension/extension.js present in $VSIX"

# --- Install -------------------------------------------------------------
echo "[reinstall] installing into VS Code (--force overwrites any prior install)..."
code --install-extension "$VSIX" --force

echo "[reinstall] done."
echo "[reinstall] vsix: $ROOT/$VSIX"
echo "[reinstall]"
echo "[reinstall] One-time MCP registration (after the extension + a connected window are up):"
echo "[reinstall]   claude mcp add steersman -- node \"$ROOT/mcp-server.js\""
echo "[reinstall]   (set STEERSMAN_PORT if the HTTP API isn't on the default 3788)"
echo "[reinstall]"
echo "[reinstall] Settings projectSteersman.autoOpenPanel / autoLaunchWindow control auto-startup."
