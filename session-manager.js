// Multi-instance session manager. Each session wraps one CDPTab (an independent
// integrated-browser CDP connection) and carries a never-reused id (win-1, win-2, ...).
// The Activity Bar panel (SessionTreeProvider) consumes list()/onDidChangeSessions;
// the HTTP server routes actions to a session's tab by id.

const vscode = require('vscode');

// Idle window after which an agent-active session decays back to inactive. Each agent HTTP
// action (markAgentActivity) re-arms this timer, so a burst keeps the panel's status dot
// orange and 10s of silence flips it back to green.
const ACTIVE_WINDOW_MS = 10000;

class SessionManager {
  // ctx: { log, createTab: async (startUrl) => connected CDPTab,
  //        getPort: () => number|null, getStartUrl: () => string,
  //        bookmarksStore?: { getTree: () => {children:[...]}, getBarEnabled: () => boolean } }
  // bookmarksStore is optional: when absent, the bookmarks-bar feature is simply off
  // (no injection ever happens) and every method still works.
  constructor(ctx) {
    this.log = ctx.log;
    this.createTab = ctx.createTab;
    this.getPort = ctx.getPort;
    this.getStartUrl = ctx.getStartUrl;
    this.bookmarksStore = ctx.bookmarksStore || null;
    this.extensionsStore = ctx.extensionsStore || null;
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

  // Mark a session as being actively driven by an agent (an agent HTTP action just hit it).
  // Sets _agentActive and, on a false->true transition, fires immediately so the panel's dot
  // turns orange at once; then (re)arms a per-session decay timer that flips it back after
  // ACTIVE_WINDOW_MS of silence (re-firing so the dot reverts to green). Repeated activity
  // keeps it active and resets the countdown. Unknown id is a guarded no-op; never throws.
  markAgentActivity(instance) {
    try {
      const s = this._sessions.get(instance);
      if (!s) return;
      const wasActive = !!s._agentActive;
      s._agentActive = true;
      if (!wasActive) this._fire();
      clearTimeout(s._agentTimer);
      s._agentTimer = setTimeout(() => {
        s._agentActive = false;
        this._fire();
      }, ACTIVE_WINDOW_MS);
    } catch {}
  }

  // Public snapshot for the tree / health, oldest first. agentActive flags a session an
  // agent is currently driving (see markAgentActivity) so the panel can pulse its status dot.
  list() {
    return Array.from(this._sessions.values()).map((s) => ({
      id: s.id,
      state: s.state,
      url: this._urlOf(s),
      agentActive: !!s._agentActive,
      // Per-window autopilot posture (default true) so the panel's wheel can render it; the
      // HTTP server reads the same flag (via isAutopilot) to reject agent calls when off.
      autopilot: s._autopilot !== false,
    }));
  }

  // Flip a window's autopilot posture. true = agents may drive it (default); false = MANUAL,
  // human-only (the HTTP server 403s agent calls against it). Fires onDidChangeSessions on a
  // real change so the panel's wheel updates live. Unknown id is a guarded no-op; never throws.
  setAutopilot(id, enabled) {
    const s = this._sessions.get(id);
    if (!s) return;
    const next = !!enabled;
    if (s._autopilot === next) return;
    s._autopilot = next;
    this._fire();
  }

  // Whether a window currently allows agent control. Fail-open: an unknown/unset id reads as
  // true (autopilot on) so a missed lookup never accidentally locks agents out of a window.
  isAutopilot(id) {
    const s = this._sessions.get(id);
    if (!s) return true;
    return s._autopilot !== false;
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
      // Manual-mode posture (same value as list()) so agents can see which windows are
      // human-only (autopilot false) and leave them alone.
      autopilot: s._autopilot !== false,
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
        // Stripped DOM: never exposes the injected #__steersman_bookmarks_bar host.
        dom = await s.tab.getDomStripped();
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
      // Manual-mode posture (same value as list()) so agents can see this window is human-only.
      autopilot: s._autopilot !== false,
      dom,
    };
  }

  get(id) {
    return this._sessions.get(id);
  }

  // Match a just-closed VS Code editor tab back to its session so the extension can drop a
  // session when the user closes its integrated-browser tab. Primary match is the exact Tab
  // reference captured at create() (VS Code keeps a tab's Tab object stable for its lifetime);
  // falls back to an unambiguous viewColumn+label match, and returns null on no/ambiguous match
  // so a mismatch is a safe no-op rather than removing the wrong session.
  sessionIdForEditorTab(tab) {
    if (!tab) return null;
    for (const s of this._sessions.values()) {
      if (s.editorTab && s.editorTab === tab) return s.id;
    }
    const col = (tab.group && tab.group.viewColumn) || null;
    const label = tab.label;
    const matches = [];
    for (const s of this._sessions.values()) {
      if (s.editorTab && s.editorTab.label === label && s.viewColumn === col) matches.push(s.id);
    }
    return matches.length === 1 ? matches[0] : null;
  }

  // Re-point a session at its integrated-browser tab after VS Code MOVED that tab to another
  // editor group. A drag between groups fires onDidChangeTabs with the old Tab in `closed`
  // (which the extension would otherwise treat as a close and remove the session) and a fresh
  // Tab in `opened`; the extension pairs them and calls this to swap in the new Tab. Updates
  // the stored editorTab/viewColumn (and mirrors them onto the live CDPTab) so the panel's
  // Focus/close keep targeting the right tab, then fires so the roster stays consistent.
  // Unknown id or a missing tab is a guarded no-op.
  updateEditorTab(id, tab) {
    const s = this._sessions.get(id);
    if (!s || !tab) return;
    s.editorTab = tab;
    s.viewColumn = (tab.group && tab.group.viewColumn) || s.viewColumn;
    if (s.tab) {
      s.tab.editorTab = tab;
      s.tab.viewColumn = s.viewColumn;
    }
    this._fire();
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
    // _autopilot true (default) = agents/Claude may drive this window; false = MANUAL/human-only
    // (the HTTP server rejects per-instance agent calls targeting it, panel controls still work).
    const session = { id, state: 'connecting', url: 'about:blank', title: '', tab: null, viewColumn: null, editorTab: null, script: null, _autopilot: true };
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
      // Wire the bookmarks bar (feature-flag: only when a store was provided). The tab
      // re-injects itself on every page load via getBookmarks, gated by getBarEnabled; we also
      // do the initial inject now — but only when the global "show bar" flag is on, otherwise
      // we remove any stale bar so a disabled flag stays honoured from the first page.
      if (this.bookmarksStore) {
        tab.getBookmarks = () => this.bookmarksStore.getTree();
        tab.getBarEnabled = () => this.bookmarksStore.getBarEnabled();
        try {
          if (this.bookmarksStore.getBarEnabled()) {
            await tab.injectBookmarksBar(this.bookmarksStore.getTree());
          } else {
            await tab.removeBookmarksBar();
          }
        } catch {}
      }
      // Wire extensions the same way (feature-flag: only when a store was provided). The tab
      // re-injects the active set on every page load via getExtensions; we also run the initial
      // injection now against the already-loaded page.
      if (this.extensionsStore) {
        tab.getExtensions = () => this.extensionsStore.getActive();
        try {
          await tab.injectExtensions(this.extensionsStore.getActive());
        } catch {}
      }
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
    // Agent driving is over once the tab drops: clear the decay timer and the flag so no
    // stray timer fires and the dot reverts.
    clearTimeout(s._agentTimer);
    s._agentActive = false;
    s.state = 'disconnected';
    s.tab = null;
    this._fire();
  }

  async close(id) {
    const s = this._sessions.get(id);
    if (!s) return;
    // Kill any pending agent-activity decay timer so it can't fire against a removed session.
    clearTimeout(s._agentTimer);
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

  // Reconcile every connected tab's bookmarks bar with current state. Phase 2's Settings CRUD
  // calls this after edits, and the Settings visibility toggle calls it after flipping the
  // flag: when the global "show bar" flag is OFF we REMOVE the bar from every window; when ON
  // we re-inject the current tree. Safe no-op when no store is wired; per-tab errors are
  // swallowed so one bad tab can't sink the rest.
  async refreshBookmarkBars() {
    if (!this.bookmarksStore) return;
    const enabled = this.bookmarksStore.getBarEnabled();
    const tree = enabled ? this.bookmarksStore.getTree() : null;
    await Promise.all(
      Array.from(this._sessions.values()).map(async (s) => {
        if (s.tab && s.state === 'connected') {
          try {
            if (enabled) await s.tab.injectBookmarksBar(tree);
            else await s.tab.removeBookmarksBar();
          } catch {}
        }
      })
    );
  }

  // Re-apply the active extensions across every connected tab. The panel's Settings handlers call
  // this after a mutation (add/edit/toggle/delete or the master flag flip) so a change lands on the
  // CURRENT documents immediately, not just on the next load. CSS and other injected/tagged nodes
  // revert LIVE on disable/delete/unmatch/master-off via the per-tab reconcile (see cdp-tab
  // injectExtensions); only a JS body's DOM side-effects that already ran can't be undone (they
  // stop on the next load, but their prior mutations persist). Isolated-world JS is not live-applied
  // either — it takes effect on the next navigation. Safe no-op when no store is wired; per-tab
  // errors are swallowed so one bad tab can't sink the rest.
  async refreshExtensions() {
    if (!this.extensionsStore) return;
    const items = this.extensionsStore.getActive();
    await Promise.all(
      Array.from(this._sessions.values()).map(async (s) => {
        if (s.tab && s.state === 'connected') {
          try {
            await s.tab.injectExtensions(items);
          } catch {}
        }
      })
    );
  }

  // Resolve the enabled-capability id set that filters buildPrompt's endpoint reference.
  // `config` is the shared CapabilityConfig (anything with getState()); when it's absent
  // (the current single-arg caller) we fall back to the default operator posture — every
  // capability except the risky, default-off `eval` — so the prompt stays sensible and
  // mostly complete until the caller threads the live config through.
  _enabledSet(config) {
    if (!config || typeof config.getState !== 'function') {
      return new Set(['create_window', 'close_window', 'navigate', 'read', 'inspect', 'screenshot', 'interact', 'run_script']);
    }
    const caps = (config.getState() && config.getState().capabilities) || [];
    return new Set(caps.filter((c) => c && c.enabled).map((c) => c.id));
  }

  // Capability-filtered ENDPOINT REFERENCE shared by buildPrompt (per-window) and
  // buildFleetPrompt (whole surface). `instance` is the id substituted into the GET
  // example query strings — a concrete id for the per-window prompt, a `<id>` placeholder
  // for the fleet prompt. The listing is filtered to the operator's ENABLED capabilities
  // (mirroring how the MCP server only exposes enabled tools and compose() omits disabled
  // rules); a disabled capability (e.g. eval when off) is omitted entirely. Returns the
  // joined reference text (no intro — each caller prepends its own).
  _endpointReference(config, instance) {
    const enabled = this._enabledSet(config);

    // Always-open endpoints (observation + wait) carry no capability gate server-side.
    const lines = [
      'ALWAYS AVAILABLE (observe + wait):',
      '- GET /windows — list open browser windows and their state.',
      '- GET /window?instance=' + instance + ' — one window\'s details (url, title, DOM).',
      '- GET /url?instance=' + instance + ' — the window\'s current URL.',
      '- POST /wait {instance,selector?,until?,timeout?} — wait for a selector or page condition.',
    ];

    // Per-capability endpoint groups, listed only when the capability is enabled — a
    // disabled capability (e.g. eval when off) is omitted entirely, matching compose().
    const groups = [
      ['navigate', 'NAVIGATE', ['- POST /navigate {instance,url} — load a URL in the window.']],
      ['read', 'READ', [
        '- GET /text?instance=' + instance + '&selector=<sel> — visible text (whole page if selector omitted).',
        '- GET /changes?instance=' + instance + ' — what visible text was added/removed since your last /changes call (call it after an action to see the effect).',
        '- GET /find?instance=' + instance + '&query=<description> — locate elements by a natural-language description; returns candidate CSS selectors with their text, role, and on-screen rect (you pick the best one to click/type).',
      ]],
      ['inspect', 'INSPECT (console/network)', [
        '- GET /console?instance=' + instance + '&limit=<n> — recent console logs/warnings/errors from the page (newest last).',
        '- GET /network?instance=' + instance + '&limit=<n>&failed=<0|1> — recent network requests (method, url, status); set failed=1 for only failed requests.',
      ]],
      ['interact', 'INTERACT', [
        '- POST /click {instance,selector} — click the element matching a CSS selector.',
        '- POST /type {instance,selector,text} — type text into a field.',
        "- POST /scroll {instance,x?,y?,selector?,to?} — scroll the page or an element (e.g. {instance,to:'bottom'} or {instance,y:1000}).",
        '- POST /press {instance,key,selector?} — press a key (optionally focusing selector first).',
        '- POST /hover {instance,selector} — hover the pointer over an element.',
      ]],
      ['screenshot', 'SCREENSHOT', ['- GET /screenshot?instance=' + instance + ' — capture the window as a base64 JPEG.']],
      ['eval', 'EVAL', ['- POST /eval {instance,js} — run arbitrary JavaScript in the page and return the result.']],
      ['create_window', 'CREATE WINDOWS', ['- POST /windows — open a new browser window (returns its new instance id).']],
      ['close_window', 'CLOSE WINDOWS', ['- POST /window/close {instance} — close a window.']],
      ['run_script', 'RUN SAVED AUTOMATIONS', [
        '- GET /scripts — list saved automations from the project scripts/ folder.',
        '- POST /script/run {instance,name} — run a saved automation against the window.',
      ]],
    ];
    for (const [capId, heading, endpoints] of groups) {
      if (!enabled.has(capId)) continue;
      lines.push('', heading + ':', ...endpoints);
    }

    return lines.join('\n');
  }

  // Capability-filtered API reference served over HTTP at /docs/tab and /docs/fleet (see
  // http-server), so the slimmed prompts can cite a URL instead of embedding the whole list.
  // `kind` is 'tab' (driving one window) or 'fleet' (managing all windows); both reuse
  // _endpointReference so the doc is filtered to the operator's ENABLED capabilities exactly
  // like the prompts. Uses the same port source as buildPrompt. Returns plain markdown text.
  buildApiDoc(kind, config) {
    const port = (this.getPort && this.getPort()) || 3788;
    const base = 'http://localhost:' + port;
    const fleet = kind === 'fleet';

    const header = [
      '# Project Steersman HTTP API — ' + (fleet ? 'fleet' : 'window') + ' reference',
      '',
      'Base URL: `' + base + '` (everything is loopback-only).',
      '',
      'Auth: every request requires the `x-steersman-token` header — use the token from the ' +
        'prompt that linked you here.',
      '',
      'Target a window by its `instance` id, e.g. `win-1` — pass it in the query string for ' +
        'GET requests and in the JSON body for POST requests.',
      '',
      'Only the endpoints listed below are enabled; calling a disabled one returns HTTP 403.',
      '',
      '**Manual windows:** a window whose `autopilot` is `false` (shown in the `GET /windows` ' +
        'list) is under manual human control. Do NOT navigate, click, type, eval, scroll, read, ' +
        'screenshot, run automations against, or close it — those calls return `403 window under ' +
        'manual control`. It appears in the window list so you know it exists; leave it alone.',
      '',
      '**Automations:** `GET /scripts` lists saved automations as `.js` or `.py`. A `.js` automation is ' +
        'evaluated inside the page. A `.py` automation runs as a HOST PROCESS that drives the tab ' +
        'via this API — it receives `STEERSMAN_URL`, `STEERSMAN_INSTANCE`, and ' +
        '`STEERSMAN_TOKEN` as env vars and must call the API itself to act. Running a `.js` ' +
        'automation requires the `run_script` capability; a `.py` automation requires `run_python`. ' +
        'Manual-mode windows reject automation runs either way.',
      '',
    ];

    const intro = fleet
      ? [
          '## Managing all windows',
          '',
          'You manage ALL Project Steersman browser windows in this VS Code window. Enumerate ' +
            'them with `GET /windows`, open new ones with `POST /windows` (returns the new ' +
            'instance id), and drive ANY window by passing its `instance` id to the action ' +
            'endpoints. If no windows exist yet, create one first with `POST /windows`.',
          '',
        ]
      : [
          '## Driving one window',
          '',
          'This reference drives a single browser window. Include its `instance` id (e.g. ' +
            '`win-1`) in every request, and send the `x-steersman-token` header on every call.',
          '',
        ];

    return (
      header.join('\n') +
      intro.join('\n') +
      '## Endpoints\n\n' +
      this._endpointReference(config, fleet ? '<id>' : 'win-1')
    );
  }

  // Ready-to-paste Claude prompt describing how to drive this session's HTTP API. The full
  // endpoint reference is NOT embedded here — it is served (capability-filtered) at
  // /docs/tab, which this prompt tells the agent to fetch. The token header value is NOT
  // emitted here either — the panel appends it (with a curl example) after this text.
  buildPrompt(id, config) {
    const port = (this.getPort && this.getPort()) || 3788;
    const base = 'http://localhost:' + port;

    return (
      'Drive integrated-browser window `' + id + '` via its local HTTP API at ' + base + '. ' +
      'Send the `x-steersman-token` header (included below) on every request. ' +
      '**Full endpoint reference: fetch `' + base + '/docs/tab`** (with that header). ' +
      'Target this window by instance id `' + id + '`.'
    );
  }

  // Ready-to-paste Claude prompt for driving the WHOLE Steersman surface (the "fleet"): the
  // agent manages ALL windows in this VS Code window — enumerate, create, and drive any of
  // them by `instance` id. Like buildPrompt, the endpoint list is NOT embedded — it is served
  // (capability-filtered) at /docs/fleet, which this prompt tells the agent to fetch. The
  // token header value is NOT emitted here — the panel appends it after this text.
  buildFleetPrompt(config) {
    const port = (this.getPort && this.getPort()) || 3788;
    const base = 'http://localhost:' + port;

    return (
      'You manage ALL Project Steersman browser windows via ' + base + '. ' +
      'Start with `GET /windows` to list them, create with `POST /windows`, and drive any ' +
      'window by its `instance` id. Send the `x-steersman-token` header (below) on every ' +
      'request. **Full endpoint reference: fetch `' + base + '/docs/fleet`**.'
    );
  }
}

module.exports = { SessionManager };
