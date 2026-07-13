// Webview editor-tab host for Project Steersman. Mirrors the Mandrake/Nomeda
// createWebviewPanel singleton pattern (reveal-not-duplicate, CSP + nonce HTML shell,
// onDidReceiveMessage dispatcher, state push on manager changes, serializer revive).
// The front-end assets (media/panel.css, media/panel.js) render everything inside
// #app; this file owns only the shell + the host<->webview message protocol.

const vscode = require('vscode');
const crypto = require('crypto');
const { CapabilityConfig } = require('./capability-config');

const VIEW_TYPE = 'projectSteersmanPanel';
// GitHub repo backing the Settings "check for updates" badge; the webview can't fetch
// external URLs under CSP, so the host does the GitHub release lookup on its behalf.
const REPO = 'lxRbckl/Project-Steersman';

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
    // Editor-tab icon shown in the tab strip for this panel.
    this._panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'icon.png');
    // Shared, hoisted capability config (one window = one in-memory, per-instance config);
    // the extension host owns it so HTTP /capabilities reads the same instance the Settings
    // handlers below mutate. Falls back to a fresh one only if a caller omits it.
    this._config = deps.capabilityConfig || new CapabilityConfig();
    // Bookmarks store (Phase 1) + the hook that re-injects the live in-page bars after a
    // Settings-editor mutation; both are optional so the panel still works feature-off.
    this._bookmarks = deps.bookmarksStore || null;
    this._refreshBars = deps.refreshBookmarkBars || null;
    // Extensions store (Phase 1) + the hook that re-applies the live in-page extensions after a
    // Settings-editor mutation; both optional so the panel still works feature-off.
    this._extensions = deps.extensionsStore || null;
    this._refreshExtensions = deps.refreshExtensions || null;
    // Best-effort favicon fetcher (Phase 3); optional so bookmarks still work without it.
    this._favicons = deps.faviconFetcher || null;
    // Loopback auth token the HTTP API now requires; included in the copy-prompt so manual/
    // direct HTTP driving still works. Local/ephemeral only — never written to a log line.
    this._token = deps.token || null;
    // Current extension version (package.json), pushed into state so the Settings badge
    // can render it and the checkForUpdate handler has a local version to compare against.
    this._version = deps.version || null;
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
        // Point the example curl at the actually-bound port (a 2nd instance may be on 3789+),
        // matching the port the prompt body uses; fall back to 3788 only if getPort is unset.
        const authPort = this._getPort ? this._getPort() : 3788;
        const authNote = this._token
          ? '\n\n---\n\nAUTH: every request to the local HTTP API must send the header ' +
            '`x-steersman-token: ' + this._token + '` — e.g. ' +
            '`curl -H "x-steersman-token: ' + this._token + '" http://localhost:' + authPort + '/url`.'
          : '';
        const prompt = this._config.compose() + '\n\n---\n\n' + this._manager.buildPrompt(msg.id, this._config) + authNote;
        await vscode.env.clipboard.writeText(prompt);
        this._post({ type: 'copied', id: msg.id });
        break;
      }
      case 'copyFleetPrompt': {
        // Fleet-scoped sibling of copyPrompt: same composed role debrief + capability
        // rules + auth note, but the action guide covers the WHOLE surface (manage/create/
        // drive any window) instead of one baked-in window — buildFleetPrompt takes no id.
        // Point the example curl at the actually-bound port (a 2nd instance may be on 3789+),
        // matching the port the prompt body uses; fall back to 3788 only if getPort is unset.
        const authPort = this._getPort ? this._getPort() : 3788;
        const authNote = this._token
          ? '\n\n---\n\nAUTH: every request to the local HTTP API must send the header ' +
            '`x-steersman-token: ' + this._token + '` — e.g. ' +
            '`curl -H "x-steersman-token: ' + this._token + '" http://localhost:' + authPort + '/url`.'
          : '';
        const prompt = this._config.compose() + '\n\n---\n\n' + this._manager.buildFleetPrompt(this._config) + authNote;
        await vscode.env.clipboard.writeText(prompt);
        // Same 'copied' postback shape the per-session copy uses; id:'fleet' sentinel tells
        // the webview it was the fleet button that flashed (no per-window instance applies).
        this._post({ type: 'copied', id: 'fleet' });
        break;
      }
      case 'copyText': {
        // Generic clipboard write for static webview-authored text (e.g. the Extensions "copy agent
        // briefing" button). Reuses the same vscode.env.clipboard path as copyPrompt; echoes a
        // 'copied' postback carrying the webview-supplied flash sentinel so the right button flashes.
        await vscode.env.clipboard.writeText(String(msg.text || ''));
        this._post({ type: 'copied', id: msg.flash || 'text' });
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
      case 'setAutopilot':
        // Flip a window's autopilot posture (wheel toggle): true = agents may drive it,
        // false = MANUAL/human-only (HTTP server 403s agent calls). setAutopilot fires
        // onDidChangeSessions -> _postState re-runs -> the wheel updates. Guarded; never throws.
        try {
          if (this._manager) this._manager.setAutopilot(msg.id, !!msg.enabled);
        } catch (e) {
          this._log.appendLine('[Panel] setAutopilot ' + (msg && msg.id) + ' failed: ' + (e && e.message ? e.message : e));
        }
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
      case 'deleteScript':
        // Operator action (Settings Scripts table): unlink the .js from the central dir.
        // deleteScript is idempotent (a missing file is a no-op), but a bad name can still
        // throw SCRIPT_NOT_FOUND — either way we re-push fresh state so the table + every
        // window's dropdown re-scan the central dir and drop the removed script.
        try {
          if (this._scriptRunner) this._scriptRunner.deleteScript(msg.name);
        } catch (e) {
          this._log.appendLine('[Panel] deleteScript ' + (msg && msg.name) + ' failed: ' + (e && e.message ? e.message : e));
        }
        this._postState();
        break;
      case 'getBookmarks':
        this._postBookmarks();
        break;
      case 'setBookmarksBarEnabled':
        // Flip the persisted global flag, re-run injection/removal across every live tab,
        // then repost the tree so the webview's toggle reflects the new state; guarded
        // no-op (never a throw) when the bookmarks store is off.
        if (this._bookmarks) {
          try {
            this._bookmarks.setBarEnabled(!!msg.enabled);
            if (this._refreshBars) await this._refreshBars();
          } catch (e) {
            this._log.appendLine('[Panel] setBookmarksBarEnabled failed: ' + (e && e.message ? e.message : e));
          }
          this._postBookmarks();
        }
        break;
      case 'addBookmark': {
        let created = null;
        await this._mutateBookmarks(() => {
          if (this._isDangerousBookmarkUrl(msg.url)) return;
          created = this._bookmarks.addBookmark(msg.parentId, { title: msg.title, url: msg.url });
        });
        // Fire-and-forget: the tree above already reposted with the new bookmark, so the
        // favicon just fills in whenever the fetch resolves (never blocks the add).
        if (created && created.id) this._fetchFavicon(created.id, msg.url);
        break;
      }
      case 'addFolder':
        await this._mutateBookmarks(() => this._bookmarks.addFolder(msg.parentId, msg.name));
        break;
      case 'removeBookmark':
        await this._mutateBookmarks(() => this._bookmarks.remove(msg.id));
        break;
      case 'renameBookmark':
        await this._mutateBookmarks(() => this._bookmarks.rename(msg.id, msg.name));
        break;
      case 'moveBookmark':
        await this._mutateBookmarks(() => this._bookmarks.move(msg.id, msg.newParentId, msg.index));
        break;
      case 'updateBookmark': {
        const fields = msg.fields || {};
        await this._mutateBookmarks(() => {
          if (fields.url !== undefined && this._isDangerousBookmarkUrl(fields.url)) return;
          this._bookmarks.update(msg.id, fields);
        });
        // Same fire-and-forget favicon refresh as addBookmark, only when the url actually changed.
        if (fields.url !== undefined && !this._isDangerousBookmarkUrl(fields.url)) {
          this._fetchFavicon(msg.id, fields.url);
        }
        break;
      }
      case 'getExtensions':
        this._postExtensions();
        break;
      case 'setExtensionsEnabled':
        // Flip the persisted master kill-switch, re-apply across every live tab, then repost the
        // list so the webview's master toggle reflects the new state; guarded no-op (never a
        // throw) when the extensions store is off.
        if (this._extensions) {
          try {
            this._extensions.setExtensionsEnabled(!!msg.enabled);
            if (this._refreshExtensions) await this._refreshExtensions();
          } catch (e) {
            this._log.appendLine('[Panel] setExtensionsEnabled failed: ' + (e && e.message ? e.message : e));
          }
          this._postExtensions();
        }
        break;
      case 'addExtension': {
        // Authoritative JS syntax guard (the webview's own new Function check is inert under the
        // panel CSP). A parse error in a main-world body would break the shared bootstrap for every
        // main extension, so we refuse to persist it and bounce the error + the operator's values
        // back to re-open the form.
        const addErr = this._jsSyntaxError(msg.js);
        if (addErr) {
          this._postExtensionError(addErr, null, {
            name: msg.name, js: msg.js, css: msg.css, matches: msg.matches,
            runAt: msg.runAt, world: msg.world, hideFromAgent: msg.hideFromAgent,
          });
          break;
        }
        await this._mutateExtensions(() =>
          this._extensions.add({
            name: msg.name,
            js: msg.js,
            css: msg.css,
            matches: msg.matches,
            runAt: msg.runAt,
            world: msg.world,
            hideFromAgent: msg.hideFromAgent,
          })
        );
        break;
      }
      case 'updateExtension': {
        const uf = msg.fields || {};
        const updErr = this._jsSyntaxError(uf.js);
        if (updErr) {
          this._postExtensionError(updErr, msg.id, uf);
          break;
        }
        await this._mutateExtensions(() => this._extensions.update(msg.id, uf));
        break;
      }
      case 'toggleExtension':
        await this._mutateExtensions(() => this._extensions.toggle(msg.id, !!msg.enabled));
        break;
      case 'removeExtension':
        await this._mutateExtensions(() => this._extensions.remove(msg.id));
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
      case 'checkForUpdate':
        await this._checkForUpdate();
        break;
      default:
        this._log.appendLine('[Panel] unhandled message: ' + type);
        break;
    }
  }

  // Fetch the latest GitHub release for REPO and post an updateStatus verdict back to the
  // webview. Host-side only (the webview can't reach api.github.com under its CSP). Bounded
  // by a 6s AbortController timeout; every failure mode (network error, timeout, non-2xx,
  // no releases yet, malformed body) is caught and reported as a short error string instead
  // of throwing, so a flaky connection never breaks the Settings panel.
  async _checkForUpdate() {
    const current = this._version || '0.0.0';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'project-steersman' },
        signal: controller.signal,
      });
      if (res.status === 404) {
        this._post({ type: 'updateStatus', current, error: 'no releases found' });
        return;
      }
      if (!res.ok) {
        this._log.appendLine('[Panel] checkForUpdate: GitHub returned ' + res.status);
        this._post({ type: 'updateStatus', current, error: 'check failed' });
        return;
      }
      // Parsing/shape failures here (bad JSON, missing tag_name) are a bad API response,
      // not a network problem — report 'check failed', not 'offline'.
      let data, latest;
      try {
        data = await res.json();
        const tag = typeof data.tag_name === 'string' ? data.tag_name : '';
        latest = tag.replace(/^v/, '').trim();
      } catch (e) {
        this._log.appendLine('[Panel] checkForUpdate: malformed response body: ' + (e && e.message ? e.message : e));
        this._post({ type: 'updateStatus', current, error: 'check failed' });
        return;
      }
      // Reject anything that isn't a plain dotted-numeric version (e.g. 'nightly',
      // 'release-1') before comparing, so a bad tag never renders a garbage verdict.
      if (!/^\d+(\.\d+)*$/.test(latest)) {
        this._post({ type: 'updateStatus', current, error: 'check failed' });
        return;
      }
      const releasesUrl = data.html_url || `https://github.com/${REPO}/releases`;
      const cmp = this._compareSemver(latest, current);
      this._post({
        type: 'updateStatus',
        current,
        latest,
        upToDate: cmp <= 0,
        updateAvailable: cmp > 0,
        releasesUrl,
      });
    } catch (e) {
      this._log.appendLine('[Panel] checkForUpdate failed: ' + (e && e.message ? e.message : e));
      this._post({ type: 'updateStatus', current, error: 'offline' });
    } finally {
      clearTimeout(timer);
    }
  }

  // Numeric, part-by-part semver compare (missing trailing parts treated as 0). Returns a
  // positive number when a > b, negative when a < b, 0 when equal — plain ints, never NaN,
  // since a non-numeric part just falls back to 0.
  _compareSemver(a, b) {
    const pa = String(a).split('.');
    const pb = String(b).split('.');
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const na = parseInt(pa[i], 10) || 0;
      const nb = parseInt(pb[i], 10) || 0;
      if (na !== nb) return na - nb;
    }
    return 0;
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

    // 2. Make the session's exact browser tab the ACTIVE editor in that group.
    //    Focusing the group alone only lands on whichever sibling tab was already
    //    active (with two browser tabs open, that's the OTHER one), and a bare
    //    openEditorAtIndex can silently no-op on an editor-browser (webview) tab — which
    //    is why "Focus" appeared to do nothing when another browser tab was in front.
    //    _activateTabInGroup verifies the switch actually took and, if not, cycles the
    //    group's editors until our tab wins.
    if (located && column) {
      const activated = await this._activateTabInGroup(column, located.tab);
      if (activated) {
        revealed = true;
        this._log.appendLine('[Panel] focusSession ' + id + ': activated browser tab in viewColumn ' + column);
      } else {
        this._log.appendLine('[Panel] focusSession ' + id + ': could not make browser tab active in viewColumn ' + column + '; group-focus only');
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

  // True when `tab` is currently the active editor of its group. Matched by object
  // IDENTITY only, never by label: every editor-browser tab carries the same debug
  // session label ("Project Steersman"), so a label match here would treat a sibling
  // browser tab as "already active" and skip the switch — the very bug we're fixing.
  // VS Code keeps a Tab's object stable for its lifetime, so identity is the reliable
  // signal. Never throws.
  _isTabActive(tab) {
    if (!tab) return false;
    try {
      const groups = (vscode.window.tabGroups && vscode.window.tabGroups.all) || [];
      for (const g of groups) {
        if (g.activeTab === tab) return true;
      }
    } catch (e) {
      this._log.appendLine('[Panel] isTabActive error: ' + (e && e.message ? e.message : e));
    }
    return false;
  }

  // Re-read the live editor group for a viewColumn (VS Code hands back fresh group
  // snapshots, so we re-fetch after each focus/switch command). null if none matches.
  _groupForColumn(column) {
    const groups = (vscode.window.tabGroups && vscode.window.tabGroups.all) || [];
    for (const g of groups) {
      if (g.viewColumn === column) return g;
    }
    return null;
  }

  // Make `targetTab` the ACTIVE editor within its group. Focuses the group first (so the
  // switch commands act on the right one), then tries the direct index command (no
  // intermediate tabs flash) — and because openEditorAtIndex can no-op on an
  // editor-browser webview tab, falls back to cycling nextEditorInGroup, which reliably
  // re-activates ANY editor type, until the live group's active tab IS our target.
  // Bounded by the group's tab count; verified via object identity; never throws.
  async _activateTabInGroup(column, targetTab) {
    try {
      if (typeof this._focusEditorGroupByColumn === 'function') {
        await this._focusEditorGroupByColumn(column);
      }
      if (this._isTabActive(targetTab)) return true;

      // Direct jump by index when the tab sits where we located it and within range.
      const g0 = this._groupForColumn(column);
      if (g0) {
        const idx = g0.tabs.indexOf(targetTab);
        const cmd = idx >= 0 ? ProjectSteersmanPanel._OPEN_AT_INDEX_COMMANDS[idx] : null;
        if (cmd) {
          await vscode.commands.executeCommand(cmd);
          if (this._isTabActive(targetTab)) return true;
        }
      }

      // Fallback: step through the (focused) group's editors until ours is the active
      // one. nextEditorInGroup switches the active editor for any tab type, so this lands
      // on the browser tab even when the index command leaves it untouched.
      const g = this._groupForColumn(column);
      const steps = g ? g.tabs.length : 0;
      for (let i = 0; i < steps; i++) {
        await vscode.commands.executeCommand('workbench.action.nextEditorInGroup');
        if (this._isTabActive(targetTab)) return true;
      }
    } catch (e) {
      this._log.appendLine('[Panel] activateTabInGroup error: ' + (e && e.message ? e.message : e));
    }
    return this._isTabActive(targetTab);
  }

  // ---- State push (host -> webview) ----

  // Push session roster + the saved-script list to the webview. Each session entry is
  // augmented (additively) with its activity (carrying activity.script = the last run's
  // {name,status,...}|null) and its agentActive flag (so the webview can pulse the status
  // dot orange while an agent is actively driving that tab) so the webview can render the
  // per-row dropdown + status.
  _postState() {
    if (!this._panel) return;
    const port = this._getPort ? this._getPort() : null;
    const sessions = this._manager.list().map((s) => {
      const full = this._manager.get(s.id);
      return {
        ...s,
        activity: full ? this._manager.activityOf(full) : null,
      };
    });
    const scripts = this._scriptRunner ? this._scriptRunner.listScripts() : [];
    const coverUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'cover.png')).toString();
    this._post({ type: 'state', sessions, port: port == null ? null : port, scripts, version: this._version || null, coverUri });
  }

  // Public re-push hook for external triggers (e.g. the central-scripts fs.watch in
  // extension.js): re-scan and post fresh state so the script table + dropdowns update when
  // another instance adds/deletes a script. Guarded no-op once the panel is disposed.
  refresh() {
    this._postState();
  }

  // Push the current capability settings (composedPreview recomputed fresh) to the webview.
  _postSettings() {
    this._post({ type: 'settings', settings: this._config.getState() });
  }

  // Push the current bookmark tree + the persisted bar-enabled flag to the webview; an
  // empty tree and enabled:true when the store is off (feature-off is a no-op, never a throw).
  _postBookmarks() {
    this._post({
      type: 'bookmarks',
      tree: this._bookmarks ? this._bookmarks.getTree() : { children: [] },
      barEnabled: this._bookmarks ? this._bookmarks.getBarEnabled() : false,
    });
  }

  // True for a bookmark url whose scheme could run script on click (javascript:/vbscript:,
  // checked case-insensitively after trimming) — a bookmark must never be a code-exec vector.
  _isDangerousBookmarkUrl(url) {
    const trimmed = typeof url === 'string' ? url.trim().toLowerCase() : '';
    return trimmed.startsWith('javascript:') || trimmed.startsWith('vbscript:');
  }

  // Run a bookmark mutation against this._bookmarks (guarded no-op when the store is off),
  // then refresh the live in-page bars and push the fresh tree back to the webview. Errors
  // are logged, never thrown, so a failed edit still leaves the UI showing a consistent tree.
  async _mutateBookmarks(fn) {
    if (!this._bookmarks) return;
    // Count bookmarks (folder-inclusive) before and after the mutation so we can auto-enable the
    // bar the moment the user adds their FIRST bookmark. Only the exact 0→≥1 transition flips the
    // flag — adding another while already ≥1 never re-enables a bar the user turned off (the guard
    // is transition-based, not "any add"). Delete-to-empty needs no write here: getBarEnabled()
    // already reads false whenever the count is 0.
    let before = 0;
    try { before = this._bookmarks.countBookmarks(); } catch { before = 0; }
    try {
      fn();
    } catch (e) {
      this._log.appendLine('[Panel] bookmark mutation failed: ' + (e && e.message ? e.message : e));
    }
    let after = before;
    try { after = this._bookmarks.countBookmarks(); } catch { after = before; }
    if (before === 0 && after >= 1) {
      // First bookmark just landed — persist enabled BEFORE refreshing so the injection pass and
      // the reposted checkbox both see the bar as on. Awaited so the stored flag is settled first.
      try {
        await this._bookmarks.setBarEnabled(true);
      } catch (e) {
        this._log.appendLine('[Panel] auto-enable bookmarks bar failed: ' + (e && e.message ? e.message : e));
      }
    }
    try {
      if (this._refreshBars) await this._refreshBars();
    } catch (e) {
      this._log.appendLine('[Panel] refreshBookmarkBars failed: ' + (e && e.message ? e.message : e));
    }
    this._postBookmarks();
  }

  // Push the current extensions list + the persisted master-enable flag to the webview; an empty
  // list and enabled:true when the store is off (feature-off is a no-op, never a throw).
  _postExtensions() {
    this._post({
      type: 'extensions',
      items: this._extensions ? this._extensions.list() : [],
      extensionsEnabled: this._extensions ? this._extensions.getExtensionsEnabled() : true,
    });
  }

  // Parse-check a JS body in the Node host (no CSP here, unlike the webview, so new Function
  // actually parses). Returns a SyntaxError message when the body fails to PARSE, else null. This
  // is a PARSE guard, NOT a sandbox: only SyntaxError blocks — any other unexpected error is logged
  // and treated as "no error" so it can never block a legitimate save. Empty/non-string body -> null.
  _jsSyntaxError(js) {
    if (typeof js !== 'string' || !js.trim()) return null;
    try {
      new Function(js); // eslint-disable-line no-new-func
      return null;
    } catch (e) {
      if (e instanceof SyntaxError) return e.message || 'invalid JavaScript';
      this._log.appendLine('[Panel] extension JS syntax check unexpected error (allowing save): ' + (e && e.message ? e.message : e));
      return null;
    }
  }

  // Bounce a failed add/update back to the webview so the form re-opens with the operator's typed
  // values + an inline error (the optimistic close-on-submit is reconciled by re-opening). `id` is
  // null for an add, the extension id for an update. `values` carries the fields the form needs to
  // repopulate (matches is the array the webview joins back to one-per-line).
  _postExtensionError(message, id, values) {
    const v = values || {};
    this._post({
      type: 'extensionError',
      error: 'JS syntax error: ' + message,
      id: id || null,
      name: v.name,
      js: v.js,
      css: v.css,
      matches: v.matches,
      runAt: v.runAt,
      world: v.world,
      hideFromAgent: v.hideFromAgent,
    });
  }

  // Run an extension mutation against this._extensions (guarded no-op when the store is off), then
  // re-apply the live in-page extensions and push the fresh list back to the webview. Mirrors
  // _mutateBookmarks: errors are logged, never thrown, so a failed edit still leaves the UI showing
  // a consistent list.
  async _mutateExtensions(fn) {
    if (!this._extensions) return;
    try {
      fn();
    } catch (e) {
      this._log.appendLine('[Panel] extension mutation failed: ' + (e && e.message ? e.message : e));
    }
    try {
      if (this._refreshExtensions) await this._refreshExtensions();
    } catch (e) {
      this._log.appendLine('[Panel] refreshExtensions failed: ' + (e && e.message ? e.message : e));
    }
    this._postExtensions();
  }

  // Fire-and-forget favicon fetch for a bookmark that was just added/re-pointed: never awaited
  // by the caller, so a slow or failing fetch can't block the add/update response. Once (if) it
  // resolves with a data-URI we merge it in, refresh the live bars, and repost the tree so the
  // icon appears; a missing fetcher, dangerous url, null result, or thrown error are all no-ops.
  _fetchFavicon(id, url) {
    if (!this._favicons || !id || this._isDangerousBookmarkUrl(url)) return;
    this._favicons.fetch(url).then((dataUri) => {
      if (!dataUri) return;
      this._bookmarks.update(id, { favicon: dataUri });
      if (this._refreshBars) this._refreshBars();
      this._postBookmarks();
    }).catch(() => {});
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
