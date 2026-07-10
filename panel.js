// Webview editor-tab host for Project Steersman. Mirrors the Mandrake/Nomeda
// createWebviewPanel singleton pattern (reveal-not-duplicate, CSP + nonce HTML shell,
// onDidReceiveMessage dispatcher, state push on manager changes, serializer revive).
// The front-end assets (media/panel.css, media/panel.js) render everything inside
// #app; this file owns only the shell + the host<->webview message protocol.

const vscode = require('vscode');
const crypto = require('crypto');
const { CapabilityConfig } = require('./capability-config');

const VIEW_TYPE = 'projectSteersmanPanel';

class ProjectSteersmanPanel {
  // deps: { manager, scriptRunner, getPort: () => number|null, log, extensionUri,
  //         focusEditorGroupByColumn: async (viewColumn) => void }
  // Open the panel, revealing the existing singleton if one is already open.
  static createOrShow(deps) {
    const column = (vscode.window.activeTextEditor && vscode.window.activeTextEditor.viewColumn) || vscode.ViewColumn.Active;
    if (ProjectSteersmanPanel.current) {
      ProjectSteersmanPanel.current._panel.reveal(column);
      return ProjectSteersmanPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'Project Steersman',
      column,
      ProjectSteersmanPanel._webviewOptions(deps.extensionUri)
    );
    ProjectSteersmanPanel.current = new ProjectSteersmanPanel(panel, deps);
    return ProjectSteersmanPanel.current;
  }

  // Rehydrate a panel restored by the serializer after a window reload, reusing the
  // same singleton/wiring as a fresh open. Dedups if one is already live.
  static revive(panel, deps) {
    if (ProjectSteersmanPanel.current) {
      panel.dispose();
      ProjectSteersmanPanel.current._panel.reveal();
      return ProjectSteersmanPanel.current;
    }
    panel.webview.options = ProjectSteersmanPanel._webviewOptions(deps.extensionUri);
    ProjectSteersmanPanel.current = new ProjectSteersmanPanel(panel, deps);
    return ProjectSteersmanPanel.current;
  }

  // Shared webview options; retainContextWhenHidden keeps the DOM/JS alive while backgrounded.
  static _webviewOptions(extensionUri) {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    };
  }

  constructor(panel, deps) {
    this._panel = panel;
    this._manager = deps.manager;
    this._scriptRunner = deps.scriptRunner;
    this._getPort = deps.getPort;
    this._log = deps.log;
    this._extensionUri = deps.extensionUri;
    this._focusEditorGroupByColumn = deps.focusEditorGroupByColumn;
    // Shared, hoisted capability config (one window = one in-memory, per-instance config);
    // the extension host owns it so HTTP /capabilities reads the same instance the Settings
    // handlers below mutate. Falls back to a fresh one only if a caller omits it.
    this._config = deps.capabilityConfig || new CapabilityConfig();
    // Loopback auth token the HTTP API now requires; included in the copy-prompt so manual/
    // direct HTTP driving still works. Local/ephemeral only — never written to a log line.
    this._token = deps.token || null;
    this._disposed = false;
    this._disposables = [];

    this._panel.webview.html = this._getHtml(this._panel.webview);

    this._panel.webview.onDidReceiveMessage(
      (msg) => this._handleMessage(msg),
      undefined,
      this._disposables
    );

    // Repaint when the tab becomes visible again (retained context can miss updates).
    this._panel.onDidChangeViewState(
      () => {
        if (this._panel.visible) this._postState();
      },
      undefined,
      this._disposables
    );

    // Push fresh state on every session-set change while the panel is alive.
    this._disposables.push(
      this._manager.onDidChangeSessions(() => this._postState())
    );

    this._panel.onDidDispose(() => this._dispose(), undefined, this._disposables);
  }

  // ---- Message handling (webview -> host) ----

  async _handleMessage(msg) {
    const type = msg && msg.type;
    switch (type) {
      case 'ready':
        this._postState();
        break;
      case 'newSession':
        // create() never throws; a failed launch lands as a 'failed' row.
        await this._manager.create();
        break;
      case 'copyPrompt': {
        // Lead the copied prompt with the composed role debrief + capability rules, then
        // the existing per-window action instructions (prepend only — nothing is removed).
        // Every request to the local HTTP API now requires the loopback auth header; note
        // it (with a curl example) so a human driving the API directly can authenticate.
        const authNote = this._token
          ? '\n\n---\n\nAUTH: every request to the local HTTP API must send the header ' +
            '`x-steersman-token: ' + this._token + '` — e.g. ' +
            '`curl -H "x-steersman-token: ' + this._token + '" http://localhost:3788/url`.'
          : '';
        const prompt = this._config.compose() + '\n\n---\n\n' + this._manager.buildPrompt(msg.id) + authNote;
        await vscode.env.clipboard.writeText(prompt);
        this._post({ type: 'copied', id: msg.id });
        break;
      }
      case 'getSettings':
        this._postSettings();
        break;
      case 'setInstruction':
        this._config.setInstruction(msg.value);
        this._postSettings();
        break;
      case 'setCapabilityEnabled':
        this._config.setCapabilityEnabled(msg.id, msg.enabled);
        this._postSettings();
        break;
      case 'setCapabilityInstruction':
        this._config.setCapabilityInstruction(msg.id, msg.value);
        this._postSettings();
        break;
      case 'focusSession':
        await this._focusSession(msg.id);
        break;
      case 'closeSession':
        await this._manager.close(msg.id);
        break;
      case 'runScript':
        // Operator action (NOT gated by the run_script capability — that only gates
        // Claude's MCP tool). A script that itself throws is recorded as status:'error'
        // by the runner; a pre-flight failure (unknown instance, not connected, missing
        // script) throws here — either way we re-push fresh state so the row updates.
        try {
          if (this._scriptRunner) await this._scriptRunner.runScript(msg.instance, msg.name);
        } catch (e) {
          this._log.appendLine('[Panel] runScript ' + msg.instance + '/' + msg.name + ' failed: ' + (e && e.message ? e.message : e));
        }
        this._postState();
        break;
      case 'openExternal': {
        let parsed;
        try { parsed = new URL(msg.url); }
        catch { this._log.appendLine('[Panel] openExternal: invalid URL rejected: ' + msg.url); break; }
        if (parsed.protocol !== 'https:') {
          this._log.appendLine('[Panel] openExternal: non-https scheme rejected: ' + msg.url);
          break;
        }
        await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      }
      default:
        this._log.appendLine('[Panel] unhandled message: ' + type);
        break;
    }
  }

  // Ordinal "activate the Nth tab in the active group" commands, indexed by (tabIndex).
  // VS Code ships these for the first nine tabs, which covers any realistic layout.
  static get _OPEN_AT_INDEX_COMMANDS() {
    return [
      'workbench.action.openEditorAtIndex1',
      'workbench.action.openEditorAtIndex2',
      'workbench.action.openEditorAtIndex3',
      'workbench.action.openEditorAtIndex4',
      'workbench.action.openEditorAtIndex5',
      'workbench.action.openEditorAtIndex6',
      'workbench.action.openEditorAtIndex7',
      'workbench.action.openEditorAtIndex8',
      'workbench.action.openEditorAtIndex9',
    ];
  }

  // Find the session's captured browser tab among the live tab groups. Prefers object
  // identity, then falls back to matching the captured label (searching the stored
  // viewColumn's group first). Returns { tab, group } or null if it can't be found
  // (e.g. the tab was closed). Never throws.
  _locateBrowserTab(s) {
    try {
      const groups = (vscode.window.tabGroups && vscode.window.tabGroups.all) || [];
      const stored = s.editorTab;
      if (stored) {
        for (const g of groups) {
          for (const t of g.tabs) {
            if (t === stored) return { tab: t, group: g };
          }
        }
      }
      const label = stored && stored.label;
      if (label) {
        const col = s.viewColumn;
        const ordered = col ? groups.slice().sort((a, b) => (a.viewColumn === col ? -1 : 0) - (b.viewColumn === col ? -1 : 0)) : groups;
        for (const g of ordered) {
          for (const t of g.tabs) {
            if (t.label === label) return { tab: t, group: g };
          }
        }
      }
    } catch (e) {
      this._log.appendLine('[Panel] locateBrowserTab error: ' + (e && e.message ? e.message : e));
    }
    return null;
  }

  // Reveal a session's integrated-browser editor tab. Primary path: locate the captured
  // browser tab, focus its editor group by viewColumn, then activate that exact tab by
  // its index within the group (openEditorAtIndex<i+1>). Supplement with a CDP
  // Page.bringToFront. Everything is best-effort and never throws out of here; if the tab
  // can't be found we fall back to group-focus, and finally to an info message.
  async _focusSession(id) {
    const s = this._manager.get(id);
    if (!s) {
      this._log.appendLine('[Panel] focusSession: session ' + id + ' no longer exists');
      vscode.window.showWarningMessage('Project Steersman: session ' + id + ' no longer exists.');
      return;
    }

    let revealed = false;
    const located = this._locateBrowserTab(s);
    const column =
      (located && located.group && located.group.viewColumn) ||
      s.viewColumn ||
      (s.tab && s.tab.viewColumn) ||
      null;

    // 1. Focus the editor group the browser tab lives in.
    if (column && typeof this._focusEditorGroupByColumn === 'function') {
      try {
        await this._focusEditorGroupByColumn(column);
        revealed = true;
      } catch (e) {
        this._log.appendLine('[Panel] focusSession ' + id + ': focusing editor group failed: ' + (e && e.message ? e.message : e));
      }
    } else {
      this._log.appendLine('[Panel] focusSession ' + id + ': no stored viewColumn to focus (tab may have never opened or dropped)');
    }

    // 2. Activate the specific browser tab within that group (the group's active tab
    //    may be some other editor). openEditorAtIndex acts on the just-focused group.
    if (located && column) {
      const idx = located.group.tabs.indexOf(located.tab);
      const cmd = ProjectSteersmanPanel._OPEN_AT_INDEX_COMMANDS[idx];
      if (cmd) {
        try {
          await vscode.commands.executeCommand(cmd);
          revealed = true;
          this._log.appendLine('[Panel] focusSession ' + id + ': focused group viewColumn ' + column + ', activated tab index ' + idx);
        } catch (e) {
          this._log.appendLine('[Panel] focusSession ' + id + ': openEditorAtIndex(' + idx + ') failed: ' + (e && e.message ? e.message : e));
        }
      } else {
        this._log.appendLine('[Panel] focusSession ' + id + ': tab index ' + idx + ' out of openEditorAtIndex range; group-focus only');
      }
    } else {
      this._log.appendLine('[Panel] focusSession ' + id + ': tab not found, group-focus only');
    }

    // 3. Supplement: ask the page target to bring itself to the foreground.
    if (s.tab && typeof s.tab.bringToFront === 'function') {
      try {
        await s.tab.bringToFront();
        this._log.appendLine('[Panel] focusSession ' + id + ': Page.bringToFront sent');
      } catch (e) {
        this._log.appendLine('[Panel] focusSession ' + id + ': Page.bringToFront failed: ' + (e && e.message ? e.message : e));
      }
    }

    // 4. Fallback: if we could not reveal the tab, at least surface its URL/state.
    if (!revealed) {
      const url = (s.tab && s.tab.url) || s.url || 'about:blank';
      this._log.appendLine('[Panel] focusSession ' + id + ': could not reveal tab; showing info fallback');
      vscode.window.showInformationMessage('Session ' + id + ' [' + s.state + '] — ' + url);
    }
  }

  // ---- State push (host -> webview) ----

  // Push session roster + the saved-script list to the webview. Each session entry is
  // augmented (additively) with its activity (carrying activity.script = the last run's
  // {name,status,...}|null) so the webview can render the per-row dropdown + status.
  _postState() {
    if (!this._panel) return;
    const port = this._getPort ? this._getPort() : null;
    const sessions = this._manager.list().map((s) => {
      const full = this._manager.get(s.id);
      return { ...s, activity: full ? this._manager.activityOf(full) : null };
    });
    const scripts = this._scriptRunner ? this._scriptRunner.listScripts() : [];
    this._post({ type: 'state', sessions, port: port == null ? null : port, scripts });
  }

  // Push the current capability settings (composedPreview recomputed fresh) to the webview.
  _postSettings() {
    this._post({ type: 'settings', settings: this._config.getState() });
  }

  _post(message) {
    if (this._disposed) return;
    this._panel.webview.postMessage(message);
  }

  _dispose() {
    this._disposed = true;
    ProjectSteersmanPanel.current = undefined;
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }

  // ---- HTML shell ----

  _getHtml(webview) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'panel.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'panel.css'));
    const csp =
      `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Project Steersman</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

ProjectSteersmanPanel.viewType = VIEW_TYPE;
ProjectSteersmanPanel.current = undefined;

module.exports = { ProjectSteersmanPanel };
