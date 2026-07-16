#!/usr/bin/env bash
# One command to update-from-git (when needed), package Project Steersman into a
# .vsix, and install it into VS Code. Invoked by the Settings-panel update badge
# (webview `{type:'selfUpdate'}` -> panel.js `_runSelfUpdate`), which runs it under
# a `bash -lc` login shell so the operator's interactive PATH (nvm node/npm, vsce,
# the `code` CLI) is available — the extension-host PATH is not.
#
# Markers parsed by the host handler (panel.js):
#   ALREADY_UP_TO_DATE                                 -> installed already matches upstream; nothing to do
#   [steersman] Installed: project-steersman v<VER>    -> install succeeded, <VER> is the new version
# Any hard failure exits non-zero and the host offers a "Show Log".
#
# Flags:
#   --local   Skip ALL remote logic (no @{u} resolve, no fetch, no pull). Just
#             package + install the current working tree. Useful for dev/direct runs.
#   Legacy --skip-* flags are accepted as aliases so older invocations keep working.
set -euo pipefail

# Resolve repo root from this script's own location so it works regardless of cwd.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Parse flags. --local (or the legacy --skip-remote/--skip-pull aliases) turns off
# the whole git update path; everything else is ignored so unknown flags never abort.
LOCAL_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --local|--skip-remote|--skip-pull) LOCAL_ONLY=1 ;;
    *) ;;
  esac
done

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

# --- Update from git (skipped entirely with --local) --------------------------
# Bring the clone up to its upstream ONLY when it is actually behind, then let the
# package/install steps below rebuild from the freshened tree. Auth is the
# operator's ambient git credentials — no token, no GitHub REST API in this path,
# so the private repo is a non-issue. Every step is guarded so a network hiccup or
# a missing upstream fails loudly and cleanly, never half-updating the tree.
if [ "$LOCAL_ONLY" -eq 0 ]; then
  if ! command -v git >/dev/null 2>&1; then
    echo "[reinstall] ERROR: git not found on PATH (run with --local to skip the git update)" >&2
    exit 1
  fi

  # Resolve the upstream tracking ref (e.g. origin/main). Wrapped in `if` so
  # `set -e` does not abort when no upstream is configured.
  UPSTREAM=""
  if UPSTREAM_RESOLVED="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"; then
    UPSTREAM="$UPSTREAM_RESOLVED"
  fi
  if [ -z "$UPSTREAM" ]; then
    echo "[reinstall] ERROR: no upstream tracking branch configured (set one, or run with --local)" >&2
    exit 1
  fi

  # Fetch so the upstream ref reflects the remote. A failed fetch is fatal here —
  # without it the ahead/behind comparison below cannot be trusted.
  echo "[reinstall] git fetch ($UPSTREAM)..."
  if ! git fetch >/dev/null 2>&1; then
    echo "[reinstall] ERROR: git fetch failed (check network / remote / credentials)" >&2
    exit 1
  fi

  # Ahead/behind against upstream. `git rev-list --count --left-right @{u}...HEAD`
  # prints "<behind>\t<ahead>": commits in upstream not in HEAD, then vice-versa.
  BEHIND=0
  if COUNTS="$(git rev-list --count --left-right '@{u}...HEAD' 2>/dev/null)"; then
    BEHIND="$(printf '%s' "$COUNTS" | awk '{print $1}')"
  fi
  [ -n "$BEHIND" ] || BEHIND=0

  # REMOTE version: package.json version at the upstream ref, read without touching
  # the working tree. Used only to decide whether the *installed* extension is
  # already current (the ALREADY_UP_TO_DATE short-circuit below).
  REMOTE_VERSION=""
  if REMOTE_PKG="$(git show "$UPSTREAM:package.json" 2>/dev/null)"; then
    REMOTE_VERSION="$(printf '%s' "$REMOTE_PKG" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{process.stdout.write(String(JSON.parse(d).version||''))}catch(e){}})" 2>/dev/null || true)"
  fi

  # INSTALLED version: the version of the extension build currently loaded in VS
  # Code, passed in by the host handler (panel.js) via this env var. Empty on a
  # direct terminal run — that's fine; the gate below only short-circuits when it
  # is known AND matches remote.
  INSTALLED_VERSION="$(printf '%s' "${STEERSMAN_INSTALLED_VERSION:-}" | tr -d '[:space:]')"

  echo "[reinstall] installed=${INSTALLED_VERSION:-unknown} remote=${REMOTE_VERSION:-unknown} behind=$BEHIND upstream=$UPSTREAM"

  # Up-to-date short-circuit: only when we KNOW the installed version, it matches
  # the upstream version, and the clone is not behind. That is the true "nothing to
  # pull, nothing to install" case. When the installed version is unknown (direct
  # CLI run) we never short-circuit — running the script by hand means install.
  if [ -n "$INSTALLED_VERSION" ] && [ -n "$REMOTE_VERSION" ] && \
     [ "$INSTALLED_VERSION" = "$REMOTE_VERSION" ] && [ "$BEHIND" -eq 0 ]; then
    echo "ALREADY_UP_TO_DATE"
    echo "[reinstall] already up to date (installed v$INSTALLED_VERSION matches upstream) — nothing to install."
    exit 0
  fi

  # Pull gate: pull ONLY when the clone is behind upstream. A fast-forward-only pull
  # never creates a merge or rewrites local commits; if it can't fast-forward it
  # fails loudly rather than leaving the tree in a mixed state.
  if [ "$BEHIND" -gt 0 ]; then
    echo "[reinstall] clone is $BEHIND commit(s) behind $UPSTREAM — git pull --ff-only..."
    if ! git pull --ff-only >/dev/null 2>&1; then
      echo "[reinstall] ERROR: git pull --ff-only failed (resolve manually, or run with --local)" >&2
      exit 1
    fi
    echo "[reinstall] pulled up to $UPSTREAM"
  else
    echo "[reinstall] clone already at/ahead of $UPSTREAM — skipping pull, reinstalling current tree"
  fi
else
  echo "[reinstall] --local: skipping git update, packaging current working tree"
fi

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

# Parseable success marker the host handler (panel.js) greps for to report the
# installed version and offer a window reload. Keep this exact shape in sync with
# the /\[steersman\]\s+Installed:\s+project-steersman v(\S+)/i regex there.
echo "[steersman] Installed: project-steersman v$VERSION"

echo "[reinstall] done."
echo "[reinstall] vsix: $ROOT/$VSIX"
echo "[reinstall]"
echo "[reinstall] One-time MCP registration (after the extension + a connected window are up):"
echo "[reinstall]   claude mcp add steersman -- node \"$ROOT/mcp-server.js\""
echo "[reinstall]   (set STEERSMAN_PORT if the HTTP API isn't on the default 3788)"
echo "[reinstall]"
echo "[reinstall] Settings projectSteersman.autoOpenPanel / autoLaunchWindow control auto-startup."
