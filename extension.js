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

let log;
let manager = null;
// One saved-script runner per activation; scans <workspaceRoot>/scripts/ and runs a
// chosen script against a session's tab. Shared by the HTTP server and the panel.
let scriptRunner = null;
// One capability config per activation (one VS Code window). Shared, in-memory: the
// panel's Settings handlers mutate it and the HTTP /capabilities endpoint reads it.
let capabilityConfig = null;
let extensionUri = null;
let httpServer = null;
let statusBarItem = null;
let actualPort = null;
let startingServer = null;
// Loopback auth token generated once per activation; the HTTP server requires it on every
// request and it is published into the instance-registry entry so the MCP server can read it.
let apiToken = null;

const INSTANCES_DIR = path.join(os.homedir(), '.project-steersman', 'instances');
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

  // Status bar opens the webview editor tab (the sessions UI now lives there, not the Activity Bar).
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'projectSteersman.openPanel';
  statusBarItem.show();

  capabilityConfig = new CapabilityConfig();
  apiToken = crypto.randomBytes(32).toString('hex');

  manager = new SessionManager({
    log,
    createTab,
    getPort: () => actualPort,
    getStartUrl: () => vscode.workspace.getConfiguration('projectSteersman').get('startUrl', 'about:blank'),
  });
  scriptRunner = new ScriptRunner({ manager, getScriptsDir, log });

  context.subscriptions.push(manager.onDidChangeSessions(updateStatus));
  updateStatus();

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

// Best-effort: make the ACTIVE editor group something OTHER than the Steersman
// panel's own column before we launch, so the editor-browser debug session (which
// opens in whatever group is active at startDebugging time) lands beside the panel
// instead of covering it. Preference order:
//   1. Reuse an existing editor group that isn't the panel's.
//   2. Otherwise split a fresh empty group to the RIGHT of the panel's group.
// The panel is left in its own column, visible. Any failure degrades silently to
// VS Code's default placement (browser opens wherever) rather than aborting launch.
async function arrangeBrowserPlacement() {
  try {
    const panel = ProjectSteersmanPanel.current && ProjectSteersmanPanel.current._panel;
    const panelColumn = panel && panel.viewColumn;
    if (!panelColumn) {
      log.appendLine('[Bridge] placement: no visible Steersman panel column; using default editor group');
      return;
    }
    const tabGroups = vscode.window.tabGroups;
    const groups = (tabGroups && tabGroups.all) || [];
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

// Resolve <workspaceRoot>/scripts/ once per call. workspaceRoot is the first open
// workspace folder; with no folder open we fall back to the extension's own directory so
// scanning still resolves somewhere sane. The folder is never created here — a missing
// one simply yields an empty script list (Claude creates it per its capability rule).
function getScriptsDir() {
  const root =
    (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri.fsPath) ||
    (extensionUri && extensionUri.fsPath) ||
    process.cwd();
  return path.join(root, 'scripts');
}

// Shared deps handed to the webview panel (fresh-open and serializer-revive both use it).
function panelDeps() {
  return { manager, scriptRunner, getPort: () => actualPort, log, extensionUri, focusEditorGroupByColumn, capabilityConfig, token: apiToken };
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
    const id = crypto.createHash('md5').update(workspace).digest('hex').slice(0, 12);
    instanceFile = path.join(INSTANCES_DIR, `${id}.json`);
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

function deactivate() {
  return stopServer();
}

module.exports = { activate, deactivate };
