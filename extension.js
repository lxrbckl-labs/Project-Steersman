const vscode = require('vscode');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { CDPTab, BROWSER_SESSION_TYPES } = require('./cdp-tab');
const { startHttpServer } = require('./http-server');
const { SessionManager } = require('./session-manager');
const { ProjectSteersmanPanel } = require('./panel');
const { CapabilityConfig } = require('./capability-config');
const { ScriptRunner } = require('./script-runner');
const { BookmarksStore } = require('./bookmarks-store');
const { ExtensionsStore } = require('./extensions-store');
const { BridgeStore } = require('./bridge-store');
const { FaviconFetcher } = require('./favicon-fetcher');

let log;
let manager = null;
// One saved-script runner per activation; scans the central scripts dir and runs a
// chosen script against a session's tab. Shared by the HTTP server and the panel.
let scriptRunner = null;
// One capability config per activation (one VS Code window). Shared, in-memory: the
// panel's Settings handlers mutate it and the HTTP /capabilities endpoint reads it.
let capabilityConfig = null;
// Global bookmark tree (folders + bookmarks), persisted in globalState so it is shared
// across all windows. The session layer injects it as an in-page bar; Phase 2's UI edits it.
let bookmarks = null;
// Global list of userscript-style "extensions" (auto-injected page modifiers), persisted in
// globalState so it is shared across all windows. The session layer injects each active one on
// page load; the panel's Settings UI (Phase 1) does operator-only CRUD.
let extensions = null;
// Bridge (B1): per-extension KV store shared across windows (globalState-backed). Threaded into the
// SessionManager (tabs service bridge storage calls) and the panel deps like the other stores.
let bridge = null;
// One favicon fetcher per activation: resolves a bookmark's favicon to a data: URI (Node-side,
// so the in-page bar's img-src CSP never sees a live cross-origin request). Shared by the panel
// (fetch-on-add) and the activation backfill below.
let favicons = null;
// This extension's package.json version, read once at activation and pushed into panel
// state so the Settings "check for updates" badge can render the current version.
let version = null;
let extensionUri = null;
let httpServer = null;
let statusBarItem = null;
let actualPort = null;
let startingServer = null;
// Loopback auth token generated once per activation; the HTTP server requires it on every
// request and it is published into the instance-registry entry so the MCP server can read it.
let apiToken = null;

const INSTANCES_DIR = path.join(os.homedir(), '.project-steersman', 'instances');
// Central saved-scripts dir, a sibling of the instance registry under ~/.project-steersman.
// Shared by ALL windows/instances (replaces the old per-workspace <root>/scripts/ path), so
// a script created in one VS Code window is visible and runnable from every other.
const SCRIPTS_DIR = path.join(os.homedir(), '.project-steersman', 'scripts');
let instanceFile = null;

function hasProposedBrowserApi() {
  return typeof vscode.window.openBrowserTab === 'function';
}

function isBrowserSession(s) {
  return BROWSER_SESSION_TYPES.includes(s.type);
}

function activate(context) {
  log = vscode.window.createOutputChannel('Project Steersman');
  extensionUri = context.extensionUri;
  version = context.extension.packageJSON.version;

  // Status bar opens the webview editor tab (the sessions UI now lives there, not the Activity Bar).
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'projectSteersman.openPanel';
  statusBarItem.show();

  capabilityConfig = new CapabilityConfig();
  bookmarks = new BookmarksStore(context.globalState);
  extensions = new ExtensionsStore(context.globalState);
  // Bridge (B1): per-extension KV store backed by globalState; context.secrets is passed for the
  // (later) B3 SecretStorage tier so its construction doesn't change then.
  bridge = new BridgeStore(context.globalState, context.secrets);
  favicons = new FaviconFetcher();
  apiToken = crypto.randomBytes(32).toString('hex');

  // Clear registry entries left behind by extension hosts that crashed without unregistering.
  pruneStaleInstances();

  manager = new SessionManager({
    log,
    createTab,
    getPort: () => actualPort,
    getStartUrl: () => vscode.workspace.getConfiguration('projectSteersman').get('startUrl', 'about:blank'),
    bookmarksStore: bookmarks,
    extensionsStore: extensions,
    bridgeStore: bridge,
  });
  scriptRunner = new ScriptRunner({
    manager,
    getScriptsDir,
    // Deps the Python-subprocess path needs to point a script at this instance's HTTP API.
    // Guarded reads so a not-yet-assigned port/token never breaks construction (the .js path
    // does not use them). The token travels to the subprocess via env only, never logged.
    getPort: () => actualPort,
    getToken: () => apiToken,
    getPython: () =>
      vscode.workspace.getConfiguration('projectSteersman').get('pythonPath', 'python3'),
    log,
  });
  // Make the central scripts dir exist up front so the panel table + dropdown work and
  // Claude has somewhere to write scripts even before any exist.
  ensureScriptsDir();
  // Best-effort live cross-instance refresh: when a script is added/deleted in the central
  // dir (by THIS window's delete handler or ANOTHER instance), re-push the open panel's
  // state so its script table + dropdowns update without a manual reopen. Debounced ~200ms.
  watchScriptsDir(context);

  context.subscriptions.push(manager.onDidChangeSessions(updateStatus));
  updateStatus();

  // Remove a session when the user closes its integrated-browser editor tab, but NOT when they
  // merely MOVE it to another editor group. A close and a move BOTH surface the captured Tab
  // (session.editorTab) in onDidChangeTabs' `closed` array, so we distinguish them by ORPHAN
  // DETECTION against the LIVE tab set rather than by pairing within the event: every editor-browser
  // tab shares one label/viewType, so an in-event pairing couldn't tell a moved tab's reappearance
  // from an unrelated sibling that merely re-activated (closing the active tab re-activates a
  // sibling, which then lands in `changed`). Instead, for the closing sessions we scan every
  // currently-open editor-browser tab and subtract the ones still owned (by identity ===) by a
  // session that ISN'T closing: what's left are ORPHANS — live browser tabs with no owning session.
  // A genuine close leaves NO orphan (a re-activated sibling is still owned by its own open session);
  // a move leaves exactly ONE orphan (the moved tab's fresh Tab object, since its session still
  // points at the now-removed old one). We repoint a closing session onto a claimed orphan
  // (manager.updateEditorTab — keep the session, so it stays in the panel and Focus/close keep
  // working); only a session that claims NO orphan is genuinely closed (manager.close tears down its
  // CDPTab and fires onDidChangeSessions so the panel drops the row). orphan-count == move-count, so
  // a pure multi-close never spuriously keeps a session, and a real close with a sibling re-activating
  // in the same event still removes the closed session. A transient CDP drop leaves the tab open and
  // is handled separately by _handleTabDisconnect, so a dropped-but-open session is never removed
  // here. Guarded end to end: an unavailable API, a non-match, or any error is a silent no-op.
  const tabGroups = vscode.window.tabGroups;
  if (tabGroups && typeof tabGroups.onDidChangeTabs === 'function') {
    context.subscriptions.push(
      tabGroups.onDidChangeTabs((e) => {
        try {
          // Closed tabs that map to a live session, each with its session's old placement column.
          const closing = [];
          for (const tab of (e.closed || [])) {
            const id = manager.sessionIdForEditorTab(tab);
            if (!id) continue;
            const s = manager.get(id);
            closing.push({ sessionId: id, oldColumn: (s && s.viewColumn) || null });
          }
          if (!closing.length) return;

          // Input-identity keys of the just-closed browser tabs. Every editor-browser tab shares
          // one viewType, so these keys recognise any OTHER live browser tab (see isLiveBrowserTab).
          const browserKeys = new Set((e.closed || []).map((t) => tabInputKey(t)));

          // Every editor-browser tab currently open across all groups (excludes our own panel).
          const liveBrowserTabs = [];
          for (const group of (tabGroups.all || [])) {
            for (const t of (group.tabs || [])) {
              if (isLiveBrowserTab(t, browserKeys)) liveBrowserTabs.push(t);
            }
          }

          // Tabs still owned (by identity) by a session that is NOT closing — "accounted for".
          const closingIds = new Set(closing.map((c) => c.sessionId));
          const accounted = [];
          for (const w of manager.list()) {
            if (closingIds.has(w.id)) continue;
            const s = manager.get(w.id);
            if (s && s.editorTab) accounted.push(s.editorTab);
          }

          // Orphans = live browser tabs with no owning (non-closing) session: a move drops exactly
          // one (the moved tab's fresh object); a genuine close (even with a sibling re-activating)
          // drops none, because the sibling is still accounted for by its own open session.
          const orphans = liveBrowserTabs.filter((t) => !accounted.some((a) => a === t));

          for (const { sessionId, oldColumn } of closing) {
            const moved = claimOrphan(orphans, oldColumn);
            if (moved) {
              log.appendLine(
                '[Bridge] browser tab moved (viewColumn ' + ((moved.group && moved.group.viewColumn) || '?') +
                '); keeping session ' + sessionId + ', repointing its tab reference'
              );
              manager.updateEditorTab(sessionId, moved);
              continue;
            }
            log.appendLine('[Bridge] browser tab closed; removing session ' + sessionId);
            manager.close(sessionId).catch((err) =>
              log.appendLine('[Bridge] close on tab-close failed: ' + (err && err.message ? err.message : err))
            );
          }
        } catch (err) {
          log.appendLine('[Bridge] onDidChangeTabs handler error: ' + (err && err.message ? err.message : err));
        }
      })
    );
  }

  context.subscriptions.push(
    log,
    statusBarItem,
    vscode.commands.registerCommand('projectSteersman.openPanel', () => openPanel()),
    vscode.commands.registerCommand('projectSteersman.startServer', () => startServer()),
    vscode.commands.registerCommand('projectSteersman.stopServer', () => stopServer()),
    vscode.commands.registerCommand('projectSteersman.status', showStatus),
    // Restore an open Project Steersman panel (and rewire it) after a window reload.
    vscode.window.registerWebviewPanelSerializer(ProjectSteersmanPanel.viewType, {
      async deserializeWebviewPanel(panel) {
        ProjectSteersmanPanel.revive(panel, panelDeps());
      },
    })
  );

  const cfg = vscode.workspace.getConfiguration('projectSteersman');
  log.appendLine(`[Bridge] activate | proposed browser API: ${hasProposedBrowserApi()}`);
  if (cfg.get('autoStartServer', true)) {
    startServer().catch((e) => log.appendLine('[Bridge] autostart failed: ' + e.message));
  }

  // Opt-in auto-open/auto-launch (both default false): reuse the same openPanel command
  // path and the same manager.create() the panel's "+" triggers — no duplicated logic.
  // Both are best-effort so a headless/no-workspace activation never throws out of activate().
  if (cfg.get('autoOpenPanel', false)) {
    openPanel().catch((e) => log.appendLine('[Bridge] autoOpenPanel failed: ' + (e && e.message ? e.message : e)));
  }
  if (cfg.get('autoLaunchWindow', false)) {
    manager.create().catch((e) => log.appendLine('[Bridge] autoLaunchWindow failed: ' + (e && e.message ? e.message : e)));
  }

  // Best-effort background backfill: fill in favicons for any bookmark that doesn't have one
  // yet (freshly seeded, or added before this feature existed). Fire-and-forget - never
  // awaited here - so a slow or failing favicon service can never delay or break activation.
  backfillFavicons().catch((e) => log.appendLine('[Bridge] backfillFavicons failed: ' + (e && e.message ? e.message : e)));
}

// Walk the whole bookmark tree once and fetch a favicon for every bookmark that doesn't have
// one yet, persisting each hit through the store and refreshing any open bookmark bars once at
// the end. Sequential (one host at a time) so a burst of bookmarks at startup doesn't hammer
// the favicon service; every per-bookmark failure is swallowed (favicons.fetch() itself never
// throws) so one bad URL can never stop the rest of the walk or destabilize activation.
async function backfillFavicons() {
  if (!bookmarks || !favicons) return;
  const pending = collectMissingFavicons(bookmarks.getTree());
  if (!pending.length) return;
  let changed = false;
  for (const node of pending) {
    try {
      const dataUri = await favicons.fetch(node.url);
      if (dataUri) {
        bookmarks.update(node.id, { favicon: dataUri });
        changed = true;
      }
    } catch (e) {
      log.appendLine('[Bridge] favicon backfill failed for ' + node.url + ': ' + (e && e.message ? e.message : e));
    }
  }
  if (changed && manager) manager.refreshBookmarkBars();
}

// Recursively collect every bookmark node (not folders) with a missing/empty favicon.
function collectMissingFavicons(node, out = []) {
  for (const child of (node && node.children) || []) {
    if (child.type === 'folder') collectMissingFavicons(child, out);
    else if (child.type === 'bookmark' && !child.favicon) out.push(child);
  }
  return out;
}

// Factory used by the session manager: open one integrated-browser tab, CDP-connect
// it, and apply the initial navigation. Returns a connected CDPTab.
async function createTab(startUrl) {
  // Watch for the browser's editor tab to open BEFORE launching it, so we catch the
  // onDidChangeTabs 'opened' event reliably instead of racing an activeTabGroup snapshot.
  const capture = beginBrowserTabCapture();
  let t;
  try {
    t = await connectProposedOrDebug(startUrl);
  } catch (e) {
    if (capture.dispose) capture.dispose();
    throw e;
  }
  // Record which editor group (and tab) the browser landed in so the panel's "Focus"
  // can bring it back to the front later.
  await finalizeBrowserTabCapture(capture, t);
  if (startUrl && startUrl !== 'about:blank') {
    try {
      await t.navigate(startUrl);
    } catch (e) {
      log.appendLine('[Bridge] initial navigate failed: ' + e.message);
    }
  }
  return t;
}

async function connectProposedOrDebug(startUrl) {
  if (hasProposedBrowserApi()) {
    try {
      log.appendLine('[Bridge] opening via proposed browser API');
      const bt = await vscode.window.openBrowserTab('about:blank', {});
      const t = new CDPTab(log);
      await t.connectToBrowserTab(bt);
      return t;
    } catch (e) {
      log.appendLine('[Bridge] proposed path failed (' + e.message + '); falling back to debug session');
    }
  }
  return launchViaDebug(startUrl);
}

// Ordinal "focus Nth editor group" commands, indexed by (viewColumn - 1). VS Code
// only ships these up to the eighth group, which is plenty for our layout.
const FOCUS_GROUP_COMMANDS = [
  'workbench.action.focusFirstEditorGroup',
  'workbench.action.focusSecondEditorGroup',
  'workbench.action.focusThirdEditorGroup',
  'workbench.action.focusFourthEditorGroup',
  'workbench.action.focusFifthEditorGroup',
  'workbench.action.focusSixthEditorGroup',
  'workbench.action.focusSeventhEditorGroup',
  'workbench.action.focusEighthEditorGroup',
];

async function focusEditorGroupByColumn(column) {
  const cmd = FOCUS_GROUP_COMMANDS[column - 1];
  if (cmd) await vscode.commands.executeCommand(cmd);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A tab is "ours" (the Steersman webview panel) if its input is a webview whose
// viewType carries our panel's viewType — VS Code prefixes it (e.g.
// "mainThreadWebview-projectSteersmanPanel"), so match by substring.
function isSteersmanPanelTab(tab) {
  const vt = tab && tab.input && tab.input.viewType;
  return typeof vt === 'string' && vt.indexOf(ProjectSteersmanPanel.viewType) !== -1;
}

// Human-readable description of a Tab.input for logging (editor-browser tabs may be a
// webview, a custom input, or an unknown/undefined input depending on VS Code build).
function describeTabInput(input) {
  if (!input) return 'none';
  if (typeof input.viewType === 'string') return 'webview:' + input.viewType;
  return (input.constructor && input.constructor.name) || typeof input;
}

// Coarse identity key for a Tab's input. Every editor-browser tab shares one webview viewType,
// so all browser tabs map to the same key — which is exactly what the move/close decision
// (onDidChangeTabs) wants: it uses a just-closed browser tab's key to recognise the OTHER live
// browser tabs (isLiveBrowserTab), never to tell two live browser tabs apart.
function tabInputKey(tab) {
  const input = tab && tab.input;
  if (!input) return 'none';
  if (typeof input.viewType === 'string') return 'vt:' + input.viewType;
  return 'ctor:' + ((input.constructor && input.constructor.name) || typeof input);
}

// Is `tab` one of our integrated-browser editor tabs (and NOT the Steersman panel webview)?
// Recognised by its input key matching a known browser tab's key (browserKeys, seeded from the
// just-closed browser tabs in the same event): every editor-browser tab shares one viewType, so
// this positively identifies live browser tabs while reusing the existing tabInputKey/panel
// helpers rather than inventing a second, drift-prone heuristic.
function isLiveBrowserTab(tab, browserKeys) {
  if (!tab || isSteersmanPanelTab(tab)) return false;
  return browserKeys.has(tabInputKey(tab));
}

// Claim one orphan tab for a closing session, splicing it out so two moves in one event each take
// a DISTINCT orphan. Prefers an orphan whose new group column differs from the session's old column
// (the shape of a genuine move between groups); falls back to any remaining orphan. Returns null
// when the pool is empty — meaning this session was genuinely CLOSED, not moved.
function claimOrphan(orphans, oldColumn) {
  if (!orphans.length) return null;
  let idx = orphans.findIndex((o) => ((o.group && o.group.viewColumn) || null) !== oldColumn);
  if (idx === -1) idx = 0;
  return orphans.splice(idx, 1)[0];
}

// Begin watching for the editor-browser tab to open. Registering the onDidChangeTabs
// listener BEFORE the launch means we reliably see the tab in e.opened rather than
// racing an activeTabGroup snapshot taken after the async CDP handshake (which often
// caught the Steersman panel or a stale group instead). Returns a capture handle whose
// .promise resolves once a non-panel tab opens; finalizeBrowserTabCapture consumes it.
// Best-effort: if the tab API is unavailable it flags .unavailable for a snapshot fallback.
function beginBrowserTabCapture() {
  const cap = { tab: null, viewColumn: null, done: false, unavailable: false, dispose: null, promise: null };
  let resolve;
  cap.promise = new Promise((r) => { resolve = r; });
  try {
    const tabGroups = vscode.window.tabGroups;
    if (!tabGroups || typeof tabGroups.onDidChangeTabs !== 'function') {
      log.appendLine('[Bridge] capture: onDidChangeTabs unavailable; will fall back to activeTabGroup snapshot');
      cap.unavailable = true;
      resolve();
      return cap;
    }
    const listener = tabGroups.onDidChangeTabs((e) => {
      if (cap.done) return;
      for (const tab of (e.opened || [])) {
        if (isSteersmanPanelTab(tab)) continue; // never mistake our own panel for the browser
        cap.tab = tab;
        cap.viewColumn = (tab.group && tab.group.viewColumn) || null;
        cap.done = true;
        log.appendLine(
          '[Bridge] captured browser tab: viewColumn ' + cap.viewColumn +
          ' label "' + tab.label + '" inputType ' + describeTabInput(tab.input)
        );
        resolve();
        return;
      }
    });
    cap.dispose = () => { try { listener.dispose(); } catch {} };
  } catch (e) {
    log.appendLine('[Bridge] capture setup failed: ' + (e && e.message ? e.message : e) + '; falling back to snapshot');
    cap.unavailable = true;
    resolve();
  }
  return cap;
}

// Resolve the capture started before launch and stamp the browser tab's placement onto
// the CDPTab (the SessionManager copies these onto the session). The open event usually
// fires during startDebugging — well before connect returns — but we give it a short
// grace window in case it trails. Falls back to the old activeTabGroup snapshot if no
// new tab was seen or the tab API was unavailable. Best-effort: never throws.
async function finalizeBrowserTabCapture(cap, t) {
  try {
    if (cap.unavailable) {
      captureBrowserPlacementSnapshot(t);
      return;
    }
    if (!cap.done) {
      await Promise.race([cap.promise, delay(1500)]);
    }
    if (cap.dispose) cap.dispose();
    if (cap.tab) {
      t.editorTab = cap.tab;
      t.viewColumn = cap.viewColumn;
    } else {
      log.appendLine('[Bridge] capture: no new tab detected; falling back to activeTabGroup snapshot');
      captureBrowserPlacementSnapshot(t);
    }
  } catch (e) {
    log.appendLine('[Bridge] finalizeBrowserTabCapture failed: ' + (e && e.message ? e.message : e));
    if (cap && cap.dispose) cap.dispose();
  }
}

// Legacy fallback: right after a browser tab opens it is (usually) the active editor.
// Record its group/tab from the active tab group. Only used when the onDidChangeTabs
// capture is unavailable or saw nothing. Best-effort: never throws.
function captureBrowserPlacementSnapshot(t) {
  try {
    const group = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup;
    if (!group) {
      log.appendLine('[Bridge] capture snapshot: no active tab group to record');
      return;
    }
    t.viewColumn = group.viewColumn || null;
    t.editorTab = group.activeTab || null;
    log.appendLine(
      '[Bridge] capture snapshot: viewColumn ' + t.viewColumn +
      ' tab "' + (t.editorTab && t.editorTab.label) + '"'
    );
  } catch (e) {
    log.appendLine('[Bridge] capture snapshot failed: ' + (e && e.message ? e.message : e));
  }
}

// Best-effort: force an EDITOR GROUP to be the active view before we launch, so the
// editor-browser debug session — which opens relative to whatever view is active at
// startDebugging time — lands as a normal editor tab in an editor column and NOT in the
// sidebar/panel/aux area (the reported bug: if focus sits in a non-editor view, or the
// Steersman webview panel isn't the active editor, the browser inherits that location).
// Preference order:
//   1. When the panel's column is known: reuse an existing editor group that isn't the
//      panel's, else split a fresh empty group to the RIGHT of the panel's group.
//   2. When the panel's column is unknown (panel hidden -> viewColumn undefined, or not
//      open yet): still force a real editor group active — prefer one not showing our own
//      panel — so the browser never falls back to the sidebar. There is essentially always
//      at least one editor group; if somehow none, split a new one.
// The panel is left in its own column, visible. Any failure degrades silently to VS Code's
// default placement rather than aborting launch.
async function arrangeBrowserPlacement() {
  try {
    const tabGroups = vscode.window.tabGroups;
    const groups = (tabGroups && tabGroups.all) || [];
    const panel = ProjectSteersmanPanel.current && ProjectSteersmanPanel.current._panel;
    const panelColumn = panel && panel.viewColumn;

    if (panelColumn) {
      const others = groups.filter((g) => g.viewColumn && g.viewColumn !== panelColumn);
      if (others.length) {
        const target = others[0];
        log.appendLine(
          '[Bridge] placement: reusing existing editor group (viewColumn ' + target.viewColumn +
          ') beside panel (viewColumn ' + panelColumn + ')'
        );
        await focusEditorGroupByColumn(target.viewColumn);
        return;
      }
      // Only the panel's group is open: focus it so the split is relative to it, then
      // open a fresh empty group to its right for the browser to land in.
      log.appendLine('[Bridge] placement: no other editor group; splitting a new group right of panel (viewColumn ' + panelColumn + ')');
      if (typeof panel.reveal === 'function') panel.reveal(panelColumn, false);
      await vscode.commands.executeCommand('workbench.action.newGroupRight');
      return;
    }

    // No visible panel column: the editor-browser would otherwise open relative to the
    // current (possibly non-editor) active view. Force a real editor group active instead,
    // preferring one that isn't showing our own panel so we don't cover it.
    const editorGroup =
      groups.find((g) => g.viewColumn && !(g.tabs || []).some(isSteersmanPanelTab)) ||
      groups.find((g) => g.viewColumn) ||
      null;
    if (editorGroup) {
      log.appendLine('[Bridge] placement: no panel column; focusing editor group (viewColumn ' + editorGroup.viewColumn + ') to keep browser in the editor area');
      await focusEditorGroupByColumn(editorGroup.viewColumn);
      return;
    }
    log.appendLine('[Bridge] placement: no editor group available; creating one for the browser');
    await vscode.commands.executeCommand('workbench.action.newGroupRight');
  } catch (e) {
    log.appendLine('[Bridge] placement: arranging editor group failed (' + (e && e.message ? e.message : e) + '); using default placement');
  }
}

// Fallback: open an editor-browser debug session and bridge via requestCDPProxy.
function launchViaDebug(url) {
  return new Promise((resolve, reject) => {
    let disposable;
    let timer;
    const seenSessions = [];
    const childPromise = new Promise((res) => {
      timer = setTimeout(() => {
        log.appendLine('[Bridge] no matching child browser session after 15s (saw: [' + seenSessions.join(', ') + '])');
        disposable.dispose();
        res(null);
      }, 15000);
      disposable = vscode.debug.onDidStartDebugSession((s) => {
        seenSessions.push(s.type);
        const matched = isBrowserSession(s) && !!s.parentSession;
        log.appendLine('[Bridge] debug session started: type=' + s.type + ' parent=' + (s.parentSession?.name ?? 'none') + ' matched=' + matched);
        if (isBrowserSession(s) && s.parentSession) {
          clearTimeout(timer);
          disposable.dispose();
          res(s);
        }
      });
    });

    // Position the target editor group BEFORE launching (never rejects — it
    // catches internally and falls back to default placement), then start.
    arrangeBrowserPlacement()
      .then(() =>
        vscode.debug.startDebugging(
          undefined,
          {
            type: 'editor-browser',
            request: 'launch',
            name: 'Project Steersman',
            url,
            internalConsoleOptions: 'neverOpen',
          },
          {
            noDebug: true,
            suppressDebugToolbar: true,
            suppressDebugView: true,
            suppressDebugStatusbar: true,
          }
        )
      )
      .then(async (ok) => {
        log.appendLine('[Bridge] startDebugging(editor-browser) -> ' + ok);
        if (!ok) {
          clearTimeout(timer);
          disposable.dispose();
          const err = new Error('Failed to start editor-browser debug session');
          log.appendLine('[Bridge] launchViaDebug rejecting: ' + err.message);
          return reject(err);
        }
        const session = await childPromise;
        if (!session) {
          const err = new Error('No child browser debug session appeared (15s)');
          log.appendLine('[Bridge] launchViaDebug rejecting: ' + err.message);
          return reject(err);
        }
        const t = new CDPTab(log);
        await t.connectToSession(session);
        resolve(t);
      }, (err) => {
        log.appendLine('[Bridge] startDebugging(editor-browser) threw: ' + (err && err.message ? err.message : err));
        reject(err);
      });
  });
}

// Resolve the central scripts dir (~/.project-steersman/scripts/), shared across all
// windows/instances. This replaces the old per-workspace <root>/scripts/ path — no
// migration of old per-project scripts is done. The dir is created once on activation
// (ensureScriptsDir), so listing/running resolve against a folder that always exists.
function getScriptsDir() {
  return SCRIPTS_DIR;
}

// Best-effort create of the central scripts dir. Guarded — a failure (permissions, etc.)
// is logged and swallowed so it never blocks activation; listing simply yields [] until
// the dir exists.
function ensureScriptsDir() {
  try {
    fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
  } catch (e) {
    if (log) log.appendLine('[Scripts] could not create ' + SCRIPTS_DIR + ': ' + (e && e.message ? e.message : e));
  }
}

// Watch the central scripts dir and re-push the open panel's state on any change, so a
// script added/deleted by this OR another instance updates live windows. Best-effort:
// fs.watch is unsupported on some platforms/filesystems and can throw — any failure is
// swallowed so it never blocks activation. Change events are debounced (~200ms) to collapse
// the burst a single add/delete can emit, then routed through the panel's public refresh().
function watchScriptsDir(context) {
  let timer = null;
  try {
    const watcher = fs.watch(SCRIPTS_DIR, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        try {
          if (ProjectSteersmanPanel.current) ProjectSteersmanPanel.current.refresh();
        } catch { /* panel gone / mid-dispose — ignore */ }
      }, 200);
    });
    context.subscriptions.push({
      dispose() {
        if (timer) clearTimeout(timer);
        try { watcher.close(); } catch { /* already closed */ }
      },
    });
  } catch (e) {
    if (log) log.appendLine('[Scripts] fs.watch unavailable on ' + SCRIPTS_DIR + ': ' + (e && e.message ? e.message : e));
  }
}

// Shared deps handed to the webview panel (fresh-open and serializer-revive both use it).
function panelDeps() {
  return {
    manager,
    scriptRunner,
    getPort: () => actualPort,
    log,
    extensionUri,
    focusEditorGroupByColumn,
    capabilityConfig,
    bookmarksStore: bookmarks,
    extensionsStore: extensions,
    bridgeStore: bridge,
    // Lets the panel fetch a data-URI favicon (Node-side) when a bookmark is added.
    faviconFetcher: favicons,
    // Lets the panel re-inject the live in-page bookmarks bar after a Settings-editor edit.
    refreshBookmarkBars: () => manager.refreshBookmarkBars(),
    // Lets the panel re-apply the live in-page extensions after a Settings-editor edit.
    refreshExtensions: () => manager.refreshExtensions(),
    token: apiToken,
    // Current package.json version; the panel pushes it into state for the update-check badge.
    version,
  };
}

// Open (or reveal) the webview editor tab that drives sessions. Ensure the HTTP server
// is up first so buildPrompt() reports a real port; the panel still opens if that fails.
async function openPanel() {
  try {
    await startServer();
  } catch (e) {
    log.appendLine('[Bridge] openPanel: server start failed: ' + e.message);
    vscode.window.showErrorMessage('Project Steersman: could not start HTTP server: ' + e.message);
  }
  ProjectSteersmanPanel.createOrShow(panelDeps());
}

// Guarded so autostart and a fast "+" click can't both pass the check and bind
// two servers — concurrent callers await the same in-flight start.
async function startServer() {
  if (httpServer) return;
  if (startingServer) return startingServer;
  startingServer = (async () => {
    const cfg = vscode.workspace.getConfiguration('projectSteersman');
    const port = cfg.get('httpPort', 3788);
    httpServer = await startHttpServer(port, { manager, log, config: capabilityConfig, runner: scriptRunner, token: apiToken });
    actualPort = httpServer.port;
    log.appendLine('[Bridge] HTTP server listening on 127.0.0.1:' + actualPort);
    await registerInstance(actualPort);
    updateStatus();
  })();
  try {
    await startingServer;
  } finally {
    startingServer = null;
  }
}

async function stopServer() {
  if (manager) {
    await manager.closeAll();
  }
  if (httpServer) {
    await httpServer.close();
    httpServer = null;
  }
  await unregisterInstance();
  actualPort = null;
  updateStatus();
}

function updateStatus() {
  if (!statusBarItem) return;
  const sessions = manager ? manager.list() : [];
  const connected = sessions.filter((s) => s.state === 'connected').length;
  const server = httpServer ? ':' + actualPort : 'off';
  statusBarItem.text = `$(browser) Project Steersman ${server}${sessions.length ? ' ' + connected + '/' + sessions.length : ''}`;
  statusBarItem.tooltip = 'Project Steersman — click to open the browser panel';
}

function showStatus() {
  const sessions = manager ? manager.list() : [];
  const summary = sessions.map((s) => s.id + ':' + s.state).join(', ') || 'none';
  vscode.window.showInformationMessage(
    `HTTP: ${actualPort || 'off'} | sessions: ${sessions.length} (${summary}) | proposed API: ${hasProposedBrowserApi()}`
  );
}

async function registerInstance(port) {
  try {
    fs.mkdirSync(INSTANCES_DIR, { recursive: true });
    const workspace = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri.fsPath) || `pid-${process.pid}`;
    // Key the file by PID (unique per extension-host window) so two windows on the SAME
    // workspace write DISTINCT files and never overwrite/unregister each other's entry.
    instanceFile = path.join(INSTANCES_DIR, `${process.pid}.json`);
    fs.writeFileSync(instanceFile, JSON.stringify({ port, workspace, pid: process.pid, token: apiToken }, null, 2));
    log.appendLine('[Bridge] registered instance ' + instanceFile);
  } catch (e) {
    log.appendLine('[Bridge] registerInstance failed: ' + e.message);
  }
}

async function unregisterInstance() {
  if (instanceFile) {
    try {
      fs.unlinkSync(instanceFile);
    } catch {}
    instanceFile = null;
  }
}

// Best-effort sweep of crash-leftover entries: drop any file whose owning PID is no longer
// alive. `process.kill(pid, 0)` sends no signal — it only probes existence: ESRCH means the
// process is gone (prune it); EPERM means it exists but isn't ours (alive — keep). Fully
// guarded so a bad file, a race, or a permissions quirk never throws or blocks activation.
function pruneStaleInstances() {
  try {
    fs.mkdirSync(INSTANCES_DIR, { recursive: true });
    for (const name of fs.readdirSync(INSTANCES_DIR)) {
      if (!name.endsWith('.json')) continue;
      const p = path.join(INSTANCES_DIR, name);
      let entry;
      try {
        entry = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        continue; // unparseable — leave it alone
      }
      if (!entry || typeof entry.pid !== 'number') continue;
      let dead = false;
      try {
        process.kill(entry.pid, 0);
      } catch (e) {
        if (e.code === 'ESRCH') dead = true; // gone; EPERM => alive-but-not-ours, keep
      }
      if (dead) {
        try {
          fs.unlinkSync(p);
        } catch {}
      }
    }
  } catch (e) {
    log.appendLine('[Bridge] pruneStaleInstances failed: ' + e.message);
  }
}

function deactivate() {
  return stopServer();
}

module.exports = { activate, deactivate };
