// Multi-instance session manager. Each session wraps one CDPTab (an independent
// integrated-browser CDP connection) and carries a never-reused id (win-1, win-2, ...).
// The Activity Bar panel (SessionTreeProvider) consumes list()/onDidChangeSessions;
// the HTTP server routes actions to a session's tab by id.

const vscode = require('vscode');

class SessionManager {
  // ctx: { log, createTab: async (startUrl) => connected CDPTab,
  //        getPort: () => number|null, getStartUrl: () => string }
  constructor(ctx) {
    this.log = ctx.log;
    this.createTab = ctx.createTab;
    this.getPort = ctx.getPort;
    this.getStartUrl = ctx.getStartUrl;
    this._counter = 0;
    // id -> { id, state, url, tab, viewColumn, editorTab, script } (insertion order = FIFO).
    // viewColumn/editorTab record the integrated-browser editor tab's placement so the
    // panel's "Focus" can reveal it; they persist even after a tab drops.
    this._sessions = new Map();
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeSessions = this._emitter.event;
  }

  _fire() {
    this._emitter.fire();
  }

  _urlOf(s) {
    if (s.tab && s.tab.url) return s.tab.url;
    return s.url || 'about:blank';
  }

  // Best-effort document.title read; '' when the tab isn't connected or the eval fails.
  async _fetchTitle(s) {
    if (!s || !s.tab || s.state !== 'connected') return '';
    try {
      const t = await s.tab.evaluate('document.title');
      return typeof t === 'string' ? t : '';
    } catch {
      return '';
    }
  }

  // Refresh and cache one session's document.title (best-effort). Called after
  // navigations so the roster reflects the new page promptly.
  async refreshTitle(s) {
    if (s && s.tab && s.state === 'connected') s.title = await this._fetchTitle(s);
  }

  // Per-session activity snapshot. page carries the current url + cached title; script
  // reflects the last saved-script run stamped onto the session by the ScriptRunner
  // ({name,status,...}), or null if none has run.
  activityOf(s) {
    return { page: { url: this._urlOf(s), title: (s && s.title) || '' }, script: (s && s.script) || null };
  }

  // Public snapshot for the tree / health, oldest first.
  list() {
    return Array.from(this._sessions.values()).map((s) => ({
      id: s.id,
      state: s.state,
      url: this._urlOf(s),
    }));
  }

  // Enriched roster for GET /windows: refreshes each connected session's cached title
  // (one document.title evaluate per connected tab, run in parallel) then maps to wire shape.
  async windows() {
    await Promise.all(
      Array.from(this._sessions.values()).map(async (s) => {
        if (s.tab && s.state === 'connected') s.title = await this._fetchTitle(s);
      })
    );
    return Array.from(this._sessions.values()).map((s) => ({
      id: s.id,
      state: s.state,
      url: this._urlOf(s),
      title: s.title || '',
      activity: this.activityOf(s),
    }));
  }

  // Enriched view of one session for GET /window, including the page DOM (null when the
  // session isn't connected). Refreshes the cached title first. null if id is unknown.
  async window(id) {
    const s = this._sessions.get(id);
    if (!s) return null;
    if (s.tab && s.state === 'connected') s.title = await this._fetchTitle(s);
    let dom = null;
    if (s.tab && s.state === 'connected') {
      try {
        dom = await s.tab.evaluate('document.documentElement.outerHTML');
      } catch {
        dom = null;
      }
    }
    return {
      id: s.id,
      state: s.state,
      url: this._urlOf(s),
      title: s.title || '',
      activity: this.activityOf(s),
      dom,
    };
  }

  get(id) {
    return this._sessions.get(id);
  }

  // Most-recently-created connected session (HTTP default routing).
  latestConnected() {
    let found;
    for (const s of this._sessions.values()) {
      if (s.state === 'connected' && s.tab) found = s;
    }
    return found;
  }

  // Allocate a new session and connect its tab. Never throws: failures land as a
  // 'failed' row plus an error message so the panel's "+" click can't crash.
  async create() {
    const id = `win-${++this._counter}`;
    const session = { id, state: 'connecting', url: 'about:blank', title: '', tab: null, viewColumn: null, editorTab: null, script: null };
    this._sessions.set(id, session);
    this._fire();

    const startUrl = this.getStartUrl ? this.getStartUrl() : 'about:blank';
    try {
      const tab = await this.createTab(startUrl);
      // Closed mid-connect: dispose the freshly-connected tab and stay out.
      if (!this._sessions.has(id)) {
        try { await tab.disconnect(); } catch {}
        return session;
      }
      session.tab = tab;
      session.state = 'connected';
      session.url = tab.url || startUrl || 'about:blank';
      // Seed the cached title (best-effort; the page may still be loading, '' is fine).
      session.title = await this._fetchTitle(session);
      // Carry the editor-tab placement captured at launch (see extension.beginBrowserTabCapture)
      // onto the session so it survives an eventual tab disconnect.
      session.viewColumn = tab.viewColumn || null;
      session.editorTab = tab.editorTab || null;
      // Reflect an unexpected transport drop back into the session state.
      tab.onDisconnect = () => this._handleTabDisconnect(id);
      this._fire();
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      this.log.appendLine('[Manager] session ' + id + ' failed: ' + msg);
      // If it was closed mid-connect, stay quiet — the row is already gone.
      if (this._sessions.has(id)) {
        session.state = 'failed';
        this._fire();
        vscode.window.showErrorMessage('Project Steersman: session ' + id + ' failed: ' + msg);
      }
    }
    return session;
  }

  // Called when a live tab's CDP transport drops. Ignored for sessions already
  // removed via close() (their state is intentional, not a surprise disconnect).
  _handleTabDisconnect(id) {
    const s = this._sessions.get(id);
    if (!s || s.state === 'disconnected') return;
    s.state = 'disconnected';
    s.tab = null;
    this._fire();
  }

  async close(id) {
    const s = this._sessions.get(id);
    if (!s) return;
    this._sessions.delete(id);
    this._fire();
    if (s.tab) {
      try {
        await s.tab.disconnect();
      } catch (e) {
        this.log.appendLine('[Manager] disconnect ' + id + ' error: ' + (e && e.message ? e.message : e));
      }
    }
  }

  async closeAll() {
    const ids = Array.from(this._sessions.keys());
    for (const id of ids) {
      await this.close(id);
    }
  }

  // Ready-to-paste Claude prompt describing how to drive this session's HTTP API.
  buildPrompt(id) {
    const s = this._sessions.get(id);
    const port = (this.getPort && this.getPort()) || 3788;
    const url = s ? this._urlOf(s) : 'about:blank';
    return (
      'Drive integrated browser session `' + id + '` via its local HTTP API at ' +
      'http://localhost:' + port + '. Include "instance": "' + id + '" in every request. ' +
      'Actions: POST /navigate {instance,url}; POST /click {instance,selector}; ' +
      'POST /type {instance,selector,text}; GET /text?instance=' + id + '&selector=<sel>; ' +
      'POST /eval {instance,js}; GET /screenshot?instance=' + id + '; ' +
      'GET /url?instance=' + id + '. Current URL: ' + url + '.'
    );
  }
}

module.exports = { SessionManager };
