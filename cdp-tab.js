// One integrated-browser tab's CDP connection. Supports two transports:
//   - connectToBrowserTab(tab)   proposed `browser` API (BrowserTab.startCDPSession)
//   - connectToSession(session)  debug-session fallback (requestCDPProxy -> WebSocket)
// Both converge on the same bootstrap: attach to the page target, enable domains.
//
// Distilled from thimo/vscode-integrated-browser-mcp (MIT). Trimmed to the MVP
// surface: navigate/eval/text/click/type/screenshot/url. No console/network
// buffers, title prefixes, child-session capture, or reconnect yet.

const vscode = require('vscode');
const dns = require('dns');
const { hostMatches } = require('./match-pattern');
let WebSocket = null;
try {
  WebSocket = require('ws');
} catch {
  // Only needed for the debug-session (websocket) fallback path.
}

const BROWSER_SESSION_TYPES = ['pwa-editor-browser', 'editor-browser', 'pwa-chrome', 'chrome'];

// Host<->page BRIDGE (B1). A `bridge:true` extension runs in a dedicated isolated world named
// BRIDGE_WORLD_PREFIX + <extId>, where a single named binding (BRIDGE_BINDING) is exposed. The
// page-side runtime calls that binding; the host derives the extension id from the TRUSTED
// contextId->extId map (never the page payload) and services the call (B1: steersman.storage.*).
const BRIDGE_BINDING = '__steersman_bridge';
const BRIDGE_WORLD_PREFIX = 'steersman_ext_';

// Bridge fetch (B2) caps. Timeout is the host ceiling (a smaller options.timeoutMs is honoured);
// size cap aborts an oversized response body.
const FETCH_TIMEOUT_CAP = 30000;
const FETCH_SIZE_CAP = 5 * 1024 * 1024; // 5 MB

// Cap for the rolling console/network ring buffers (entries beyond this are shifted off the front).
const BUFFER_CAP = 200;

class CDPTab {
  constructor(log) {
    this.log = log;
    this.ws = null;
    this._browserTabSession = null;
    this._browserTab = null;
    this._session = null;
    this.transport = null;
    this._pageSessionId = null;
    this._browserSessionId = null;
    this._lastKnownUrl = '';
    this.requestId = 0;
    this.pending = new Map();
    this.disposables = [];
    this.state = 'disconnected';
    // Optional callback fired when the tab drops (transport closed or disconnect()).
    // The SessionManager wires this to reflect a dead session in the tree.
    this.onDisconnect = null;
    // Optional callback returning the current bookmark tree ({children:[...]}). Set by the
    // SessionManager at creation; when unset (feature off) the bar is simply not injected.
    this.getBookmarks = null;
    // Optional callback returning the global "show bookmarks bar" flag (boolean). Set by the
    // SessionManager; when unset the bar defaults to injecting (backward-compatible).
    this.getBarEnabled = null;
    // Optional callback returning the active extensions to inject (array of records; already
    // gated by the master flag + per-extension enabled). Set by the SessionManager; when unset
    // (feature off) nothing is injected. All record fields are honoured now: matches (URL filter),
    // js + runAt, css, world (main/isolated registration split), and hideFromAgent (drives the
    // agent-read strip in getDomStripped/getTextStripped).
    this.getExtensions = null;
    // Identifiers of THIS tab's current Page.addScriptToEvaluateOnNewDocument registrations for the
    // extensions bootstrap, so a config change can remove the old registrations before adding new
    // ones. Phase 4 splits by execution world: the MAIN-world registration carries every
    // extension's CSS plus the main-world JS bodies; the ISOLATED-world registration (added with a
    // worldName) carries only the isolated-world JS bodies. null when nothing is registered.
    this._extScriptId = null;
    this._extScriptIdIsolated = null;
    // Bridge (B1) — host<->page bridge transport state for THIS tab (reset per CDPTab instance).
    // getBridge returns the shared BridgeStore (set by the SessionManager, like getExtensions). The
    // maps/set track per-extension isolated-world registrations and the TRUSTED contextId->extId
    // attribution built from Runtime.executionContextCreated.
    this.getBridge = null;
    this._bridgeScriptIds = new Map(); // extId -> Page.addScriptToEvaluateOnNewDocument identifier
    this._bridgeBindings = new Set();  // extIds we've Runtime.addBinding'd (once per tab)
    this._bridgeCtxToExt = new Map();  // executionContextId -> extId (trusted attribution)
    // Whether we've currently forced Page.setBypassCSP(true) on THIS tab (Phase 3). We only turn it
    // on when at least one active extension carries CSS (an injected <style> element can be blocked
    // by a page's style-src CSP), and turn it back off when the last CSS-bearing extension is gone,
    // so pages that don't need it keep their own CSP intact. Tracked per-tab so we don't thrash the
    // CDP call on every refresh.
    this._extCssBypass = false;
    // Rolling capture buffers (Feature 1): console + network, each a ring of <= BUFFER_CAP entries.
    this._console = [];
    this._consoleSeq = 0;
    this._network = [];
    this._networkSeq = 0;
    // Correlates Network.requestWillBeSent -> response/failure by requestId (bounded, insertion-ordered).
    this._netByReqId = new Map();
    // Baseline line-set for getChanges() (Feature 2); null until the first snapshot is taken.
    this._lastChangesText = null;
  }

  _emitDisconnect() {
    if (this.onDisconnect) {
      try {
        this.onDisconnect();
      } catch {}
    }
  }

  get url() {
    return (this._browserTab && this._browserTab.url) || this._lastKnownUrl || '';
  }

  // ---- transport: proposed browser API ----
  async connectToBrowserTab(tab) {
    this.log.appendLine(`[CDP] connectToBrowserTab (${tab.url})`);
    this._browserTab = tab;
    this.transport = 'browserTab';
    this.state = 'connecting';
    const session = await tab.startCDPSession();
    this._browserTabSession = session;
    this.disposables.push(
      session.onDidReceiveMessage((msg) => this.handleMessage(msg)),
      session.onDidClose(() => {
        this._browserTabSession = null;
        this.rejectAllPending(new Error('CDP session closed'));
        this.state = 'disconnected';
        this._emitDisconnect();
      })
    );
    await this.bootstrap(false);
    this.state = 'connected';
    this.log.appendLine('[CDP] connected (browserTab)');
  }

  // ---- transport: debug-session fallback ----
  async connectToSession(session) {
    this.log.appendLine(`[CDP] connectToSession (${session.name})`);
    this._session = session;
    this.transport = 'websocket';
    this.state = 'connecting';
    const proxy = await session.customRequest('requestCDPProxy');
    const wsUrl = `ws://${proxy.host}:${proxy.port}${proxy.path || ''}`;
    this.log.appendLine(`[CDP] ws -> ${wsUrl}`);
    await this.connectWebSocket(wsUrl);
  }

  connectWebSocket(url) {
    return new Promise((resolve, reject) => {
      if (!WebSocket) return reject(new Error("'ws' module not available for debug-session path"));
      const ws = new WebSocket(url);
      let settled = false;
      ws.on('open', async () => {
        this.ws = ws;
        settled = true;
        try {
          await this.bootstrap(true);
          this.state = 'connected';
          this.log.appendLine('[CDP] connected (websocket)');
          resolve();
        } catch (e) {
          this.state = 'disconnected';
          reject(e);
        }
      });
      ws.on('message', (data) => {
        try {
          this.handleMessage(JSON.parse(data.toString()));
        } catch (e) {
          this.log.appendLine('[CDP] message parse error: ' + e.message);
        }
      });
      ws.on('close', () => {
        this.ws = null;
        this.rejectAllPending(new Error('WebSocket closed'));
        this.state = 'disconnected';
        this._emitDisconnect();
      });
      ws.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }

  // ---- shared bootstrap ----
  async bootstrap(isWebsocket) {
    if (isWebsocket) {
      // js-debug's CDP proxy only forwards events the client subscribes to.
      await this.send(
        'JsDebug.subscribe',
        { events: ['Runtime.*', 'Network.*', 'Target.*', 'Page.*', 'Browser.*'] },
        { sessionId: null }
      ).catch((e) => this.log.appendLine('[CDP] JsDebug.subscribe failed: ' + e.message));
    }
    await this.establishPageSession();
    await this.enableDomains();
    // The page is already loaded at connect time; inject the bar once now. No-ops if the
    // getBookmarks callback hasn't been wired yet (the SessionManager triggers the real
    // first injection right after it sets the callback).
    this._reinjectBookmarks();
    // Same idea for extensions: run the active set against the already-loaded page. No-ops until
    // the SessionManager wires getExtensions (it triggers the real first injection after that).
    // The bridge world registrations (B1) ride along inside injectExtensions/_reinjectExtensions.
    this._reinjectExtensions();
  }

  async establishPageSession() {
    let browserSessionId;
    try {
      const r = await this.send('Target.attachToBrowserTarget', undefined, { sessionId: null });
      browserSessionId = r && r.sessionId;
    } catch (e) {
      // Older VS Code proxies auto-route; fall back to implicit routing.
      this.log.appendLine(`[CDP] attachToBrowserTarget failed (${e.message}); implicit routing`);
      return;
    }
    if (!browserSessionId) return;
    this._browserSessionId = browserSessionId;
    const targets = await this.send('Target.getTargets', undefined, { sessionId: browserSessionId });
    const pages = ((targets && targets.targetInfos) || []).filter((t) => t.type === 'page');
    if (!pages.length) {
      this.log.appendLine('[CDP] no page target found');
      return;
    }
    const page = pages[0];
    const attach = await this.send(
      'Target.attachToTarget',
      { targetId: page.targetId, flatten: true },
      { sessionId: browserSessionId }
    );
    if (attach && attach.sessionId) {
      this._pageSessionId = attach.sessionId;
      this._lastKnownUrl = page.url || '';
      this.log.appendLine(`[CDP] page session ${attach.sessionId} (${page.url || page.targetId})`);
    }
  }

  async enableDomains() {
    await Promise.all([
      this.send('Runtime.enable').catch(() => {}),
      this.send('Page.enable').catch(() => {}),
      this.send('DOM.enable').catch(() => {}),
      this.send('Network.enable').catch(() => {}),
    ]);
  }

  handleMessage(msg) {
    if (!msg) return;
    // Bridge (B1): maintain the contextId->extId map + service bindingCalled from bridge worlds.
    if (msg.method) { this._onBridgeEvent(msg); }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
        else p.resolve(msg.result);
      }
    } else if (msg.method === 'Page.frameNavigated') {
      const f = msg.params && msg.params.frame;
      // MAIN frame only (subframes carry a parentId). frameNavigated fires at navigation COMMIT —
      // the new document exists with readyState=loading, before the page's JS renders its UI. We
      // re-run the same extensions live-apply used on loadEventFired here so the declutter <style>
      // lands during readyState=loading (before the native toolbar renders), rather than only at
      // load-complete. The document-start addScriptToEvaluateOnNewDocument registration is silently
      // ineffective over the js-debug editor-browser CDP proxy (CSS was measured absent all through
      // loading/interactive/complete), so this early live-apply is the reliable early-CSS path. The
      // reconcile live-apply is idempotent (CSS replace-in-place), so it's safe to run here even if
      // the new document's context is momentarily bare, and again at DOMContentLoaded/load below.
      if (f && f.url && !f.parentId) {
        this._lastKnownUrl = f.url;
        this._reinjectExtensions();
      }
    } else if (msg.method === 'Page.domContentEventFired') {
      // Early belt-and-suspenders: DOMContentLoaded is still before load-complete and covers the
      // rare case where the new main-world execution context wasn't yet ready at frameNavigated
      // (Runtime.evaluate would have no-op'd). Re-asserting the (idempotent) extensions live-apply
      // here keeps the declutter CSS present well before loadEventFired's final safety-net reinject.
      this._reinjectExtensions();
    } else if (msg.method === 'Page.loadEventFired') {
      // A load replaces the document and drops our host node — re-inject the bar.
      this._reinjectBookmarks();
      // Belt-and-suspenders: the document-start bootstrap (registered before the initial navigate)
      // is now the primary injection path, so this re-apply is a safety net that re-runs the same
      // _reinjectExtensions() (live-apply) path that refreshEnhanceJira/refreshExtensions use on
      // every completed load, re-asserting the active extension/EnhanceJira set. It is idempotent
      // (CSS replace-in-place, main-world JS designed to re-run cleanly) so re-applying on loads
      // the document-start bootstrap already handled is harmless.
      this._reinjectExtensions();
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      try {
        const params = msg.params || {};
        const args = Array.isArray(params.args) ? params.args : [];
        const text = args.map((a) => this._remoteObjToText(a)).join(' ');
        this._pushConsole({
          seq: ++this._consoleSeq,
          type: params.type || 'log',
          text: text.length > 2000 ? text.slice(0, 2000) : text,
          ts: params.timestamp || null,
        });
      } catch {}
    } else if (msg.method === 'Runtime.exceptionThrown') {
      try {
        const params = msg.params || {};
        const det = params.exceptionDetails || {};
        let text = (det.exception && det.exception.description) || det.text || 'exception';
        text = String(text);
        this._pushConsole({
          seq: ++this._consoleSeq,
          type: 'error',
          text: text.length > 2000 ? text.slice(0, 2000) : text,
          ts: params.timestamp || null,
        });
      } catch {}
    } else if (msg.method === 'Network.requestWillBeSent') {
      try {
        const params = msg.params || {};
        this._netByReqId.set(params.requestId, {
          method: params.request && params.request.method,
          url: params.request && params.request.url,
          ts: params.timestamp || null,
        });
        // Bound the correlation map (Map preserves insertion order — evict the oldest key).
        if (this._netByReqId.size > 500) {
          const oldest = this._netByReqId.keys().next().value;
          this._netByReqId.delete(oldest);
        }
      } catch {}
    } else if (msg.method === 'Network.responseReceived') {
      try {
        const params = msg.params || {};
        const stored = this._netByReqId.get(params.requestId) || {};
        const resp = params.response || {};
        this._pushNetwork({
          seq: ++this._networkSeq,
          method: stored.method,
          url: stored.url || resp.url,
          status: resp.status,
          mimeType: resp.mimeType,
          failed: false,
          ts: params.timestamp || null,
        });
        this._netByReqId.delete(params.requestId);
      } catch {}
    } else if (msg.method === 'Network.loadingFailed') {
      try {
        const params = msg.params || {};
        const stored = this._netByReqId.get(params.requestId) || {};
        this._pushNetwork({
          seq: ++this._networkSeq,
          method: stored.method,
          url: stored.url,
          status: null,
          failed: true,
          errorText: params.errorText || 'failed',
          canceled: !!params.canceled,
          ts: params.timestamp || null,
        });
        this._netByReqId.delete(params.requestId);
      } catch {}
    }
  }

  // Flatten a CDP RemoteObject to a compact display string for the console buffer.
  _remoteObjToText(a) {
    if (!a) return '';
    if (a.value !== undefined) {
      if (typeof a.value === 'string') return a.value;
      try {
        return JSON.stringify(a.value);
      } catch {
        return String(a.value);
      }
    }
    if (a.description !== undefined) return String(a.description);
    if (a.unserializableValue !== undefined) return String(a.unserializableValue);
    return String(a.type || '');
  }

  // Push a console entry and trim the ring buffer to BUFFER_CAP (oldest shifted off).
  _pushConsole(entry) {
    this._console.push(entry);
    if (this._console.length > BUFFER_CAP) this._console.shift();
  }

  // Push a network entry and trim the ring buffer to BUFFER_CAP (oldest shifted off).
  _pushNetwork(entry) {
    this._network.push(entry);
    if (this._network.length > BUFFER_CAP) this._network.shift();
  }

  send(method, params, opts = {}) {
    return new Promise((resolve, reject) => {
      const wsOpen = this.ws && this.ws.readyState === WebSocket.OPEN;
      const tabOpen = this._browserTabSession !== null;
      if (!wsOpen && !tabOpen) return reject(new Error('CDP not connected'));
      const id = ++this.requestId;
      const timeoutMs = opts.timeoutMs || 30000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP request timed out (${method})`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const envelope = { id, method, params: params || {} };
      const sessionId = opts.sessionId === undefined ? this._pageSessionId : opts.sessionId;
      if (sessionId) envelope.sessionId = sessionId;
      if (this._browserTabSession) {
        this._browserTabSession.sendMessage(envelope).then(undefined, (err) => {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        });
      } else {
        this.ws.send(JSON.stringify(envelope));
      }
    });
  }

  // ---- high-level actions ----
  async navigate(url) {
    await this.send('Page.navigate', { url });
    this._lastKnownUrl = url;
    return this.url;
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r && r.exceptionDetails) {
      const ex = r.exceptionDetails;
      throw new Error((ex.exception && ex.exception.description) || ex.text || 'evaluate failed');
    }
    return r && r.result ? r.result.value : undefined;
  }

  async getText(selector) {
    const expr = selector
      ? `(document.querySelector(${JSON.stringify(selector)}) || {}).innerText || ''`
      : `document.body ? document.body.innerText : ''`;
    return this.evaluate(expr);
  }

  // Read every cookie the browser holds via CDP (Network domain already enabled in
  // enableDomains). Returns the raw cookie array (empty on a missing/odd response).
  async getCookies() {
    const r = await this.send('Network.getAllCookies');
    return (r && r.cookies) || [];
  }

  // Write cookies into the browser via CDP (Network domain already enabled). This is
  // browser-context-wide (whole window's jar), not scoped to this tab. No-ops on an empty
  // batch; lets the caller catch (a bad entry can reject the batch). Never log cookie data.
  async setCookies(cookieParams) {
    if (!Array.isArray(cookieParams) || !cookieParams.length) return;
    await this.send('Network.setCookies', { cookies: cookieParams });
  }

  // Wipe every cookie the browser holds via CDP (Network domain already enabled). This is
  // browser-context-wide (whole window's jar) — a true sign-out of every site. Never log cookie data.
  async clearBrowserCookies() {
    await this.send('Network.clearBrowserCookies');
  }

  // ---- bookmarks bar (injected UI, kept out of agent reads) ----

  // Inject (idempotently) a Chrome-style bookmarks strip into the page. The whole bar lives
  // in a shadow root under a single host div (#__steersman_bookmarks_bar) so page CSS can't
  // touch it and it can't leak into the page; the ONLY page mutation is appending that host
  // to <html>. The tree crosses into the page via JSON.stringify (never raw interpolation).
  // Bookmarks navigate on click; folders toggle a shadow-root dropdown of their children.
  // Swallows its own errors and no-ops on an empty tree — never throws.
  async injectBookmarksBar(tree) {
    // Faint-black backing behind each bookmark/folder chip so text stays readable over the
    // blurred bar. Change this hex to recolor the chips (and the folder dropdown, which reuses it).
    const BOOKMARK_CHIP_COLOR = '#1c1c1c';
    // Off-black, translucent bar background (keeps the frosted blur but reads dark instead of light).
    const BAR_BG = 'rgba(20,20,20,0.6)';
    // Shared with .menuItem below: the dropdown lives on the shadow ROOT (a sibling of .bar,
    // not a descendant — see folderEl()), so it can't inherit .bar's font by cascade; without
    // this explicit re-application .menuItem falls back to the page's inherited font-size and
    // renders visibly larger than the bar's own chips.
    const BAR_FONT = "13px/1.2 -apple-system,'Segoe UI',Roboto,sans-serif";
    const data = JSON.stringify(tree && Array.isArray(tree.children) ? tree : { children: [] });
    const css =
      '.bar{position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;align-items:center;' +
      // Side padding matches the ~4px gap that align-items:center already leaves above/below the
      // 24px chips inside this 32px (border-box) strip, so the first chip's top/left/right insets read as equal.
      'gap:2px;height:32px;padding:0 4px;background:' + BAR_BG + ';' +
      'backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-bottom:1px solid rgba(255,255,255,0.12);' +
      'font:' + BAR_FONT + ';color:#e8eaed;box-sizing:border-box;' +
      // Keep horizontal scroll functional (wheel/drag still work when bookmarks overflow the
      // strip) but hide the native scrollbar track — on about:blank's first paint Chromium
      // renders the classic (non-overlay) scrollbar for a beat, showing as a second gray strip
      // under the bar; scrollbar-width/::-webkit-scrollbar suppress it on every page uniformly.
      'overflow-x:auto;overflow-y:hidden;scrollbar-width:none;}' +
      '.bar::-webkit-scrollbar{display:none;height:0;}' +
      '.item,.folderBtn{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;' +
      'border:0;background:' + BOOKMARK_CHIP_COLOR + ';border-radius:4px;cursor:pointer;color:#e8eaed;font:inherit;' +
      'white-space:nowrap;}' +
      '.item:hover,.folderBtn:hover{background:#333333;}' +
      '.favicon{width:16px;height:16px;border-radius:3px;background:#c0c4c9;flex:0 0 auto;' +
      'display:inline-block;object-fit:contain;}' +
      // faviconEl() reuses the .favicon class for both the no-favicon placeholder (a <span>,
      // which wants the #c0c4c9 swatch above) and the real <img> once a favicon loads; without
      // this override the img inherited that same light swatch as its background, showing as a
      // light halo behind any favicon PNG with transparent padding. img.favicon is more specific
      // than .favicon alone, so this wins and leaves real favicons sitting on the dark chip.
      'img.favicon{background:transparent;}' +
      '.title{max-width:180px;overflow:hidden;text-overflow:ellipsis;color:#e8eaed;}' +
      '.folder{position:relative;}' +
      '.menu{position:fixed;min-width:180px;background:' + BOOKMARK_CHIP_COLOR + ';' +
      'border:1px solid rgba(255,255,255,0.12);color:#e8eaed;' +
      'border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.2);padding:4px;z-index:2147483647;}' +
      // Flex row (favicon + title) mirroring .item's layout/gap/height/padding so dropdown rows
      // are the same size as the top-level bar chips (not just aligned the same way); the font
      // is re-applied explicitly (see BAR_FONT above) since .menu sits outside .bar and can't
      // inherit its font-size by cascade. Truncation lives on .title (below) rather than here,
      // since ellipsis on a flex container doesn't clip its children's overflow.
      '.menuItem{display:flex;align-items:center;gap:6px;height:24px;padding:0 8px;border-radius:4px;' +
      'cursor:pointer;white-space:nowrap;max-width:280px;color:#e8eaed;font:' + BAR_FONT + ';}' +
      '.menuItem:hover{background:#333333;}';
    const expr =
      `(function(tree){try{` +
      `var HOST='__steersman_bookmarks_bar';` +
      `var old=document.getElementById(HOST);if(old)old.remove();` +
      `var host=document.createElement('div');host.id=HOST;` +
      `var root=host.attachShadow({mode:'open'});` +
      `var style=document.createElement('style');style.textContent=${JSON.stringify(css)};root.appendChild(style);` +
      `var bar=document.createElement('div');bar.className='bar';` +
      `function faviconEl(node){if(node.favicon){var img=document.createElement('img');img.className='favicon';img.src=node.favicon;return img;}` +
      `var s=document.createElement('span');s.className='favicon';return s;}` +
      `function bookmarkEl(node){var it=document.createElement('div');it.className='item';it.title=node.url||'';` +
      `it.appendChild(faviconEl(node));var t=document.createElement('span');t.className='title';t.textContent=node.title||node.url||'';` +
      `it.appendChild(t);it.addEventListener('click',function(){if(node.url)location.assign(node.url);});return it;}` +
      `function folderEl(node){var wrap=document.createElement('div');wrap.className='folder';` +
      `var btn=document.createElement('button');btn.className='folderBtn';btn.textContent=(node.name||'Folder')+' ▾';` +
      `var menu=document.createElement('div');menu.className='menu';menu.style.display='none';` +
      // Same faviconEl(node) helper the top-level bar items use, so dropdown rows show
      // favicon + title just like .item chips (falls back to the .favicon placeholder span
      // when child.favicon is absent).
      `(node.children||[]).forEach(function(child){var mi=document.createElement('div');mi.className='menuItem';` +
      `mi.appendChild(faviconEl(child));var ct=document.createElement('span');ct.className='title';` +
      `ct.textContent=child.title||child.name||child.url||'';mi.appendChild(ct);` +
      `if(child.type!=='folder'&&child.url){mi.title=child.url;mi.addEventListener('click',function(){location.assign(child.url);});}` +
      `menu.appendChild(mi);});` +
      // The menu lives on the shadow ROOT (sibling of .bar), not inside it, so the bar's
      // overflow-x:auto/overflow-y:hidden can't clip the dropdown below the 32px strip. It's
      // position:fixed and placed at the button's viewport rect on open; opening one folder
      // closes any other open menu.
      `btn.addEventListener('click',function(e){e.stopPropagation();var isOpen=menu.style.display!=='none';` +
      `Array.prototype.forEach.call(root.querySelectorAll('.menu'),function(m){m.style.display='none';});` +
      `if(!isOpen){var r=btn.getBoundingClientRect();menu.style.left=r.left+'px';menu.style.top=(r.bottom+2)+'px';menu.style.display='block';}});` +
      `wrap.appendChild(btn);root.appendChild(menu);return wrap;}` +
      `(tree.children||[]).forEach(function(node){bar.appendChild(node.type==='folder'?folderEl(node):bookmarkEl(node));});` +
      `root.appendChild(bar);document.documentElement.appendChild(host);` +
      // Push the page down by the bar height (32px) so the bar STACKS above content instead of
      // overlaying it. A transform on <body> makes it a containing block for its position:fixed
      // descendants, so even a site's own fixed top header shifts down with the rest. The host
      // is on <html> (a sibling of body, OUTSIDE the transform) so the bar stays pinned at top:0.
      // Idempotent: translateY is set to an absolute value, never additive, so re-injection can't
      // stack the offset. LIMITATION: revertible, but may interact oddly with sites that already
      // transform <body> or rely on certain sticky/fixed layouts.
      `if(document.body){document.body.style.transform='translateY(32px)';` +
      `document.body.style.transformOrigin='top left';document.body.setAttribute('data-steersman-shifted','1');}` +
      `}catch(e){}})(${data})`;
    try {
      await this.evaluate(expr);
    } catch {}
  }

  // Remove any injected bookmarks-bar host (#__steersman_bookmarks_bar) from the page AND undo
  // the body shift (transform/transformOrigin/data-steersman-shifted) that pushed the page down,
  // restoring the page to normal. Both mutations are no-ops when absent. Swallows its own errors
  // and no-ops when disconnected — never throws.
  async removeBookmarksBar() {
    try {
      await this.evaluate(
        `(function(){try{var el=document.getElementById('__steersman_bookmarks_bar');if(el)el.remove();` +
          `if(document.body){document.body.style.transform='';document.body.style.transformOrigin='';` +
          `document.body.removeAttribute('data-steersman-shifted');}}catch(e){}})()`
      );
    } catch {}
  }

  // Fire-and-forget re-injection of the current tree (used on load events and after connect).
  // Respects the global "show bookmarks bar" flag via the SessionManager-supplied
  // getBarEnabled callback: when it's set and returns false we REMOVE any stale bar instead of
  // injecting; when unset we inject (backward-compatible). Reads the tree via getBookmarks; if
  // it's unset or throws we skip rather than error out.
  _reinjectBookmarks() {
    let enabled = true;
    try {
      if (this.getBarEnabled) enabled = !!this.getBarEnabled();
    } catch {
      enabled = true;
    }
    if (!enabled) {
      this.removeBookmarksBar().catch(() => {});
      return;
    }
    let tree = null;
    try {
      tree = this.getBookmarks ? this.getBookmarks() : null;
    } catch {
      tree = null;
    }
    if (!tree) return;
    this.injectBookmarksBar(tree).catch(() => {});
  }

  // Build the single page-bootstrap expression for the active extensions (Phase 2 + 3).
  //
  // The bootstrap carries the per-extension METADATA (id + matches + runAt + css) as JSON — the
  // same "stringify data into an IIFE" trick the bookmarks bar uses for its tree. Two important
  // distinctions in how the two payloads are carried:
  //   • JS bodies are inlined as RAW functions (NOT eval'd), so — run via
  //     Page.addScriptToEvaluateOnNewDocument or Runtime.evaluate — they execute in the page's main
  //     world and bypass the page CSP even on strict-CSP sites. CAVEAT (unchanged from P2): because
  //     bodies are inlined raw, a SYNTAX error in one body fails the whole bootstrap parse; operator
  //     bodies are expected to be valid JS.
  //   • CSS is carried purely as a STRING in META (JSON data, never code), so it adds no parse
  //     hazard. It's applied by inserting a <style id="__steersman_ext_css_<id>"> element.
  //
  // At run time the bootstrap URL-filters each extension against `location.href` with an embedded
  // port of match-pattern.js. For a match it applies the CSS immediately (as early as possible,
  // regardless of runAt — an injected <style> at document-start lands even before <head> exists,
  // via a documentElement fallback), then runs the JS body per runAt: immediately for
  // 'document_start', else deferred to DOMContentLoaded ('document_idle') — or immediately when the
  // document is already past loading (the live-apply case). Each JS body runs in its own try/catch.
  //
  // `reconcile` (live-apply only): first REMOVE any of our `__steersman_ext_css_*` <style> nodes
  // whose ext-id is not in the currently-active-AND-matching-AND-has-css set, so disabling/deleting/
  // unmatching an extension (or flipping the master off) strips its CSS from the LIVE document
  // without a reload. Fresh documents (the registration path) have nothing to remove, so they skip
  // this. NOTE: only injected CSS nodes are live-revertible — a JS body's DOM side-effects that
  // already ran cannot be undone (that remains the sole un-revert gap).
  //
  // WORLD SPLIT (Phase 4): `opts.world` selects which bootstrap this is.
  //   • 'main'     — carries EVERY applicable extension's CSS (CSS is world-independent; a <style>
  //                  node inserted from either world affects the shared DOM) plus the JS bodies of
  //                  main-world extensions. This is the only path that touches CSS + reconcile.
  //   • 'isolated' — carries ONLY the JS bodies of isolated-world extensions (no CSS, no reconcile);
  //                  registered with a worldName so it runs in a JS-isolated world that can't touch
  //                  or collide with the page's own globals.
  // Returns null for the registration path (opts.reconcile false) when this world has nothing to
  // run. The reconcile (live-apply) path — only used for 'main' — ALWAYS returns an expression, even
  // for an empty set, so stale CSS still gets cleaned up when the last extension goes away.
  _buildExtensionsBootstrap(list, opts) {
    opts = opts || {};
    const world = opts.world === 'isolated' ? 'isolated' : 'main';
    const reconcile = !!opts.reconcile && world === 'main';
    const items = Array.isArray(list) ? list : [];
    const hasJs = (e) => e && typeof e.js === 'string' && e.js.trim();
    const hasCss = (e) => e && typeof e.css === 'string' && e.css.trim();
    const worldOf = (e) => (e && e.world === 'isolated' ? 'isolated' : 'main');
    // Bridge (B1): a bridge extension's JS runs in its OWN per-ext isolated world (see
    // _syncBridgeWorlds), never in these shared main/isolated bootstraps — so exclude its body here.
    // Its CSS is still carried by the main bootstrap (CSS is world-independent, centralised there).
    const isBridge = (e) => !!(e && e.bridge);
    // Main bootstrap: anything with CSS (any world) OR a non-bridge main-world JS body. Isolated
    // bootstrap: only non-bridge isolated-world JS bodies.
    const applicable =
      world === 'main'
        ? items.filter((e) => hasCss(e) || (hasJs(e) && worldOf(e) === 'main' && !isBridge(e)))
        : items.filter((e) => hasJs(e) && worldOf(e) === 'isolated' && !isBridge(e));
    if (!applicable.length && !opts.reconcile) return null;
    const meta = JSON.stringify(
      applicable.map((e) => ({
        id: e.id || '?',
        matches: Array.isArray(e.matches) ? e.matches : [],
        runAt: e.runAt === 'document_start' ? 'document_start' : 'document_idle',
        // CSS is applied only by the main bootstrap (world-independent, but centralised there so
        // the reconcile sees the full set); the isolated bootstrap never carries CSS.
        css: world === 'main' && hasCss(e) ? e.css : '',
      }))
    );
    // Bodies correlated to META by index; a slot is null unless the extension's JS belongs to THIS
    // world (so the main bootstrap gets null for isolated extensions' bodies, and vice-versa, while
    // still carrying their CSS via META above when this is the main bootstrap).
    const bodies = applicable
      .map((e) => (hasJs(e) && worldOf(e) === world && !isBridge(e) ? '(function(steersman){\n' + e.js + '\n})' : 'null'))
      .join(',');
    const matcher = this._extMatcherJs();
    // Idempotent CSS injection: stable per-ext id, replace-in-place. Falls back to documentElement
    // when <head> doesn't exist yet (document-start), so CSS lands as early as possible.
    const cssHelper =
      'var __sm_pfx="__steersman_ext_css_";' +
      'function __sm_css(id,css){var eid=__sm_pfx+id;var el=document.getElementById(eid);' +
      'if(!el){el=document.createElement("style");el.id=eid;(document.head||document.documentElement).appendChild(el);}' +
      'if(el.textContent!==css)el.textContent=css;}';
    // Live-apply reconcile: drop our CSS nodes whose ext-id is no longer wanted (removes disabled/
    // deleted/unmatched/master-off styling from the live doc). Skipped on the registration path.
    const reconcilePass = reconcile
      ? 'var __sm_want={};META.forEach(function(m){if(m.css&&__sm_matches(m.matches,location.href))__sm_want[m.id]=1;});' +
        'Array.prototype.forEach.call(document.querySelectorAll(\'style[id^="__steersman_ext_css_"]\'),' +
        'function(el){if(!__sm_want[el.id.slice(__sm_pfx.length)])el.remove();});'
      : '';
    return (
      '(function(){try{' +
      'var META=' + meta + ';var BODIES=[' + bodies + '];' +
      matcher +
      cssHelper +
      // Marker helper handed to each JS body as its `steersman` argument: `id` is the extension's
      // own id, and `mark(node)` tags a node the body creates with data-steersman-ext=<id> so a
      // hideFromAgent extension's injected nodes can be stripped from agent reads (see
      // getDomStripped/getTextStripped). Best-effort: only nodes the author marks (plus the CSS
      // style node) are strippable — arbitrary DOM mutations can't be reverted.
      'function __sm_help(id){return{id:id,mark:function(n){try{if(n&&n.setAttribute)n.setAttribute("data-steersman-ext",id);}catch(e){}return n;}};}' +
      'function __sm_run(i){try{BODIES[i](__sm_help(META[i].id));}catch(e){try{console.error("[Steersman extension "+META[i].id+"]",e);}catch(_){}}}' +
      reconcilePass +
      'META.forEach(function(m,i){if(!__sm_matches(m.matches,location.href))return;' +
      'if(m.css)__sm_css(m.id,m.css);' +
      'if(!BODIES[i])return;' +
      'if(m.runAt==="document_start"){__sm_run(i);}' +
      'else if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",function(){__sm_run(i);});}' +
      'else{__sm_run(i);}});' +
      '}catch(e){}})()'
    );
  }

  // (Re)apply the active extensions to THIS tab (Phase 2–4). Steps:
  //   1. CSP bypass (Phase 3) — force Page.setBypassCSP(true) ONLY when some active extension carries
  //      CSS (an injected <style> can be blocked by a page's style-src CSP), and back to false when
  //      the last CSS-bearing extension is gone, so pages that don't need it keep their own CSP. Set
  //      BEFORE the live-apply below so the <style> insert isn't refused. The CDP request only fires
  //      when the state actually flips (no thrashing).
  //   2. Registration for FUTURE documents — remove the previous registrations and add fresh ones,
  //      so every navigation runs the current set at document-start (URL-filtered in-page). Phase 4
  //      splits this by world: a MAIN-world registration (CSS + main JS) and, when any isolated-world
  //      JS exists, a second registration added with worldName so it runs in a JS-isolated world.
  //   3. Live-apply + reconcile on the CURRENT document via Runtime.evaluate (MAIN world only), so
  //      enabling/editing takes effect (and disabling/removing strips CSS) without a reload. Runs
  //      even for an empty set, so the last extension's CSS is cleaned up. LIMITATION: isolated-world
  //      JS is NOT live-applied (Runtime.evaluate targets the main world) — an isolated extension's
  //      JS takes effect on the NEXT navigation via its document-start registration; its CSS, handled
  //      by the main bootstrap, still applies/reverts live.
  // Swallows its own transport/CDP errors and no-ops when disconnected — never throws.
  async injectExtensions(list) {
    const items = Array.isArray(list) ? list : [];
    // 1. CSP bypass — only flip when the "any CSS-bearing extension?" answer changes.
    const needBypass = items.some((e) => e && typeof e.css === 'string' && e.css.trim());
    if (needBypass !== this._extCssBypass) {
      try {
        await this.send('Page.setBypassCSP', { enabled: needBypass });
        this._extCssBypass = needBypass;
      } catch {}
    }
    // 2. Registrations for future documents — MAIN (CSS + main JS) and ISOLATED (isolated JS only).
    const mainExpr = this._buildExtensionsBootstrap(items, { world: 'main', reconcile: false });
    const isoExpr = this._buildExtensionsBootstrap(items, { world: 'isolated', reconcile: false });
    try {
      if (this._extScriptId) {
        await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this._extScriptId });
        this._extScriptId = null;
      }
    } catch {}
    try {
      if (this._extScriptIdIsolated) {
        await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this._extScriptIdIsolated });
        this._extScriptIdIsolated = null;
      }
    } catch {}
    if (mainExpr) {
      try {
        const r = await this.send('Page.addScriptToEvaluateOnNewDocument', { source: mainExpr });
        this._extScriptId = r && r.identifier ? r.identifier : null;
      } catch {}
    }
    if (isoExpr) {
      try {
        const r = await this.send('Page.addScriptToEvaluateOnNewDocument', {
          source: isoExpr,
          worldName: 'steersman_isolated',
        });
        this._extScriptIdIsolated = r && r.identifier ? r.identifier : null;
      } catch {}
    }
    // 3. Live-apply + reconcile on the current document (MAIN world; always — even empty, to strip
    //    stale CSS). Isolated JS is intentionally not live-applied (see LIMITATION above).
    const liveExpr = this._buildExtensionsBootstrap(items, { world: 'main', reconcile: true });
    if (liveExpr) {
      try {
        await this.evaluate(liveExpr);
      } catch {}
    }
    // 4. Bridge (B1): (re)register a dedicated isolated world + binding for each bridge extension.
    //    Their JS runs there (not in the shared bootstraps above), on the NEXT navigation.
    await this._syncBridgeWorlds(items);
  }

  // Fire-and-forget (re)registration of the active extensions, called from bootstrap() after
  // connect. Reads the active set via the SessionManager-supplied getExtensions callback; if it's
  // unset (feature off / not yet wired) we no-op. The SessionManager also calls injectExtensions
  // directly right after it wires the callback, so the first real registration happens there.
  _reinjectExtensions() {
    let items = null;
    try {
      items = this.getExtensions ? this.getExtensions() : null;
    } catch {
      items = null;
    }
    if (!items) return;
    this.injectExtensions(items).catch(() => {});
  }

  // ── Host<->page BRIDGE (B1) ───────────────────────────────────────────────────────────
  // Supersedes the B0 spike. Transport: a `bridge:true` extension runs in its own isolated world
  // (BRIDGE_WORLD_PREFIX + extId) where BRIDGE_BINDING is exposed; the page-side runtime posts
  // {rid,op,args} through the binding, the host services it (B1: steersman.storage.*) and delivers
  // the reply back into the same world via __steersman_bridge_resolve. Trusted attribution: the
  // extId comes from the contextId->extId map, never the page payload.

  // Self-contained port of match-pattern.js's matchesUrl, as an in-page JS string. Shared by the
  // shared extension bootstrap AND the per-ext bridge bootstrap (keep in sync with match-pattern.js).
  _extMatcherJs() {
    return (
      'function __sm_glob(g){var r="^";for(var i=0;i<g.length;i++){var c=g[i];' +
      'r+=(c==="*")?".*":c.replace(/[.*+?^${}()|[\\]\\\\]/g,"\\\\$&");}return new RegExp(r+"$");}' +
      'function __sm_host(ph,uh){if(ph==="*")return true;' +
      'if(ph.indexOf("*.")===0){var b=ph.slice(2);return uh===b||uh.slice(-(b.length+1))==="."+b;}return uh===ph;}' +
      'function __sm_parse(p){if(typeof p!=="string")return null;p=p.trim();if(!p)return null;' +
      'if(p==="<all_urls>")return{allUrls:true};var s=p.indexOf("://");if(s===-1)return null;' +
      'var sc=p.slice(0,s);if(!/^(\\*|https?|file|ftp)$/.test(sc))return null;var rest=p.slice(s+3);' +
      'var sl=rest.indexOf("/");if(sl===-1)return null;var h=rest.slice(0,sl),pa=rest.slice(sl);' +
      'if(pa[0]!=="/")return null;if(sc==="file"){if(h!=="")return null;}else{if(h==="")return null;' +
      'if(h!=="*"){if(h.indexOf("*.")===0){var bb=h.slice(2);if(!bb||bb.indexOf("*")!==-1)return null;}' +
      'else if(h.indexOf("*")!==-1)return null;}}return{allUrls:false,scheme:sc,host:h,path:pa};}' +
      'function __sm_single(pr,u){if(!pr)return false;var sc=u.protocol.replace(/:$/,"");' +
      'if(pr.allUrls)return["http","https","file","ftp"].indexOf(sc)!==-1;' +
      'if(pr.scheme==="*"){if(sc!=="http"&&sc!=="https")return false;}else if(pr.scheme!==sc)return false;' +
      'if(sc!=="file"&&!__sm_host(pr.host,u.hostname))return false;' +
      'return __sm_glob(pr.path).test(u.pathname+u.search);}' +
      'function __sm_matches(pats,url){if(!Array.isArray(pats)||!pats.length)return false;var u;' +
      'try{u=new URL(url);}catch(e){return false;}for(var i=0;i<pats.length;i++){' +
      'var pr=__sm_parse(pats[i]);if(pr&&__sm_single(pr,u))return true;}return false;}'
    );
  }

  // Build the document-start source for ONE bridge extension's isolated world: the page-side bridge
  // runtime (__sm_call/__steersman_bridge_resolve), the `steersman` object (mark + storage now;
  // fetch/secrets stubbed to reject until B2/B3), then the extension's own JS body (URL-filtered,
  // respecting runAt). The body is inlined raw (same CSP-bypass + syntax caveat as other extensions;
  // the host-side syntax guard in panel.js already blocks unparseable saves).
  _buildBridgeBootstrap(ext) {
    const idJson = JSON.stringify(String(ext.id || '?'));
    const matchesJson = JSON.stringify(Array.isArray(ext.matches) ? ext.matches : []);
    const runAtJson = JSON.stringify(ext.runAt === 'document_start' ? 'document_start' : 'document_idle');
    const body = typeof ext.js === 'string' ? ext.js : '';
    return (
      '(function(){try{' +
      // Page-side bridge runtime.
      'var __sm_seq=0;var __sm_pending={};' +
      'function __sm_call(op,args,timeout){return new Promise(function(resolve,reject){' +
      'var rid=++__sm_seq;var t=setTimeout(function(){if(__sm_pending[rid]){delete __sm_pending[rid];' +
      'reject({type:"timeout",message:"bridge call timed out"});}},timeout||10000);' +
      '__sm_pending[rid]={resolve:resolve,reject:reject,timer:t};' +
      'try{window.' + BRIDGE_BINDING + '(JSON.stringify({rid:rid,op:op,args:args}));}' +
      'catch(e){clearTimeout(t);delete __sm_pending[rid];reject({type:"host",message:"bridge unavailable: "+(e&&e.message)});}});}' +
      'window.__steersman_bridge_resolve=function(rid,reply){var p=__sm_pending[rid];if(!p)return;' +
      'clearTimeout(p.timer);delete __sm_pending[rid];' +
      'if(reply&&reply.ok){p.resolve(reply.value);}else{p.reject((reply&&reply.error)||{type:"host",message:"bridge error"});}};' +
      // The `steersman` object handed to the bridge body.
      'var steersman={id:' + idJson + ',' +
      'mark:function(n){try{if(n&&n.setAttribute)n.setAttribute("data-steersman-ext",' + idJson + ');}catch(e){}return n;},' +
      'storage:{' +
      'get:function(key){return __sm_call("storage.get",{key:String(key)});},' +
      'set:function(key,value){return __sm_call("storage.set",{key:String(key),value:value});},' +
      'remove:function(key){return __sm_call("storage.remove",{key:String(key)});},' +
      'keys:function(){return __sm_call("storage.keys",{});}' +
      '},' +
      // Bridge fetch (B2): proxied cross-origin fetch. Resolves to a Response-like object; res.ok is
      // computed page-side (a 404 resolves with ok:false, like real fetch). Rejects only on typed
      // transport/guard errors (blocked/timeout/toobig/host/network). Page-side call timeout is set
      // a little beyond the host cap so the host's own timeout error wins.
      'fetch:function(url,options){options=options||{};' +
      'var __to=((typeof options.timeoutMs==="number"&&options.timeoutMs>0)?options.timeoutMs:30000)+3000;' +
      'return __sm_call("fetch",{url:String(url),options:options},__to).then(function(v){var st=v.status;' +
      'return {ok:(st>=200&&st<300),status:st,statusText:v.statusText||"",headers:v.headers||{},body:v.body,' +
      'json:function(){return Promise.resolve(v.body?JSON.parse(v.body):null);},' +
      'text:function(){return Promise.resolve(v.body||"");}};});},' +
      // Secrets (B3): OS-keychain-backed via SecretStorage host-side; values never touch page JS
      // beyond what the module itself set/get. Prefer options.auth (below) so tokens never enter JS.
      'secrets:{' +
      'get:function(key){return __sm_call("secrets.get",{key:String(key)});},' +
      'set:function(key,value){return __sm_call("secrets.set",{key:String(key),value:String(value)});},' +
      'remove:function(key){return __sm_call("secrets.remove",{key:String(key)});}' +
      '}' +
      '};' +
      // URL filter + run the body per runAt.
      this._extMatcherJs() +
      'var __sm_matchesList=' + matchesJson + ';var __sm_runAt=' + runAtJson + ';' +
      'function __sm_runbody(){try{(function(steersman){\n' + body + '\n})(steersman);}' +
      'catch(e){try{console.error("[Steersman bridge ext "+' + idJson + '+"]",e);}catch(_){}}}' +
      'if(__sm_matches(__sm_matchesList,location.href)){' +
      'if(__sm_runAt==="document_start"){__sm_runbody();}' +
      'else if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",__sm_runbody);}' +
      'else{__sm_runbody();}}' +
      '}catch(e){}})()'
    );
  }

  // Reconcile the per-extension bridge worlds for THIS tab against the active set. For each
  // enabled+active `bridge:true` extension with a JS body: ensure its binding is registered (once
  // per tab) and (re)register its per-ext-world document-start script. Extensions that are no longer
  // bridge/active have their world registration removed (the leftover binding is harmless — its
  // world is no longer created, so the binding is never exposed). Runs from injectExtensions, so it
  // rides every refresh. LIMITATION: like isolated-world JS, a bridge body takes effect on the NEXT
  // navigation (its world only exists from document-start onward), not live on the current page; its
  // CSS still applies live via the main bootstrap. Swallows CDP errors; never throws.
  async _syncBridgeWorlds(items) {
    const list = Array.isArray(items) ? items : [];
    const hasJs = (e) => e && typeof e.js === 'string' && e.js.trim();
    const bridgeList = list.filter((e) => e && e.bridge && e.id && hasJs(e));
    const wanted = new Set(bridgeList.map((e) => e.id));

    // Drop world registrations for extensions no longer bridge/active.
    for (const [extId, identifier] of Array.from(this._bridgeScriptIds.entries())) {
      if (!wanted.has(extId)) {
        try { await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }); } catch {}
        this._bridgeScriptIds.delete(extId);
      }
    }

    // (Re)register each wanted bridge extension's world.
    for (const ext of bridgeList) {
      const world = BRIDGE_WORLD_PREFIX + ext.id;
      // Bind once per tab per world name. FALLBACK SIGNAL: if the proxy rejects executionContextName
      // bindings, this logs — that's the "named-world bridge unsupported" outcome (B1 = transport proof).
      if (!this._bridgeBindings.has(ext.id)) {
        try {
          await this.send('Runtime.addBinding', { name: BRIDGE_BINDING, executionContextName: world });
          this._bridgeBindings.add(ext.id);
        } catch (e) {
          this.log.appendLine('[Bridge] FALLBACK SIGNAL: addBinding(executionContextName="' + world + '") REJECTED by proxy: ' + (e && e.message ? e.message : e) + ' — named-world bridge unsupported on this transport.');
        }
      }
      // Replace the per-ext-world document-start script (body/matches/runAt may have changed).
      const prev = this._bridgeScriptIds.get(ext.id);
      if (prev) {
        try { await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: prev }); } catch {}
        this._bridgeScriptIds.delete(ext.id);
      }
      try {
        const r = await this.send('Page.addScriptToEvaluateOnNewDocument', {
          source: this._buildBridgeBootstrap(ext),
          worldName: world,
        });
        if (r && r.identifier) this._bridgeScriptIds.set(ext.id, r.identifier);
      } catch (e) {
        this.log.appendLine('[Bridge] register world failed for ' + world + ': ' + (e && e.message ? e.message : e));
      }
    }
  }

  // Maintain the TRUSTED contextId->extId map from execution-context lifecycle events, and route a
  // bridge binding call. Called from handleMessage for every event (guarded on msg.method).
  _onBridgeEvent(msg) {
    try {
      const p = msg.params || {};
      if (msg.method === 'Runtime.executionContextCreated') {
        const ctx = p.context || {};
        if (typeof ctx.name === 'string' && ctx.name.indexOf(BRIDGE_WORLD_PREFIX) === 0) {
          this._bridgeCtxToExt.set(ctx.id, ctx.name.slice(BRIDGE_WORLD_PREFIX.length));
        }
      } else if (msg.method === 'Runtime.executionContextDestroyed') {
        if (p.executionContextId != null) this._bridgeCtxToExt.delete(p.executionContextId);
      } else if (msg.method === 'Runtime.executionContextsCleared') {
        this._bridgeCtxToExt.clear();
      } else if (msg.method === 'Runtime.bindingCalled') {
        if (p.name === BRIDGE_BINDING) this._onBridgeCall(p.executionContextId, p.payload);
      }
    } catch (e) {
      try { this.log.appendLine('[Bridge] event error: ' + (e && e.message ? e.message : e)); } catch (_) {}
    }
  }

  // Service one page->host bridge call. extId is TRUSTED (from the contextId map, not the payload).
  _onBridgeCall(ctxId, payload) {
    const extId = this._bridgeCtxToExt.get(ctxId);
    let parsed = null;
    try { parsed = JSON.parse(payload); } catch { parsed = null; }
    const rid = parsed ? parsed.rid : undefined;
    if (!extId) {
      if (rid != null) this._resolveInContext(ctxId, rid, { ok: false, error: { type: 'host', message: 'unknown bridge context' } });
      return;
    }
    if (!parsed || rid == null || typeof parsed.op !== 'string') {
      if (rid != null) this._resolveInContext(ctxId, rid, { ok: false, error: { type: 'host', message: 'malformed bridge call' } });
      return;
    }
    // _handleBridgeCall may return a value (storage) or a Promise (fetch); Promise.resolve unwraps
    // both, and a thrown/rejected error becomes a clean host error rather than a hang.
    Promise.resolve()
      .then(() => this._handleBridgeCall(extId, parsed.op, parsed.args || {}))
      .then((reply) => this._resolveInContext(ctxId, rid, reply))
      .catch((e) => this._resolveInContext(ctxId, rid, { ok: false, error: { type: 'host', message: (e && e.message) ? e.message : 'bridge failed' } }));
  }

  // Op router: storage.* (B1, sync) + fetch (B2, async Promise). Anything else -> clean host error.
  _handleBridgeCall(extId, op, args) {
    if (op === 'fetch') return this._bridgeFetch(extId, args || {});
    const store = this.getBridge ? this.getBridge() : null;
    if (!store) return { ok: false, error: { type: 'host', message: 'bridge storage unavailable' } };
    try {
      if (op === 'storage.get') return { ok: true, value: store.get(extId, args.key) };
      if (op === 'storage.set') { store.set(extId, args.key, args.value); return { ok: true, value: true }; }
      if (op === 'storage.remove') { store.remove(extId, args.key); return { ok: true, value: true }; }
      if (op === 'storage.keys') return { ok: true, value: store.keys(extId) };
      // Secrets (B3) — async (SecretStorage); the extId is trusted. NEVER log a secret value.
      if (op === 'secrets.get') return store.getSecret(extId, args.key).then((v) => ({ ok: true, value: v }));
      if (op === 'secrets.set') return store.setSecret(extId, args.key, args.value).then(() => ({ ok: true, value: true }));
      if (op === 'secrets.remove') return store.removeSecret(extId, args.key).then(() => ({ ok: true, value: true }));
      return { ok: false, error: { type: 'host', message: 'unsupported op' } };
    } catch (e) {
      return { ok: false, error: { type: 'host', message: (e && e.message) ? e.message : 'bridge op failed' } };
    }
  }

  // ── Bridge fetch (B2) — a cross-origin fetch proxied by the trusted host. Guards run BEFORE the
  // request: http(s)-only scheme, per-extension host allowlist (bridgeHosts), and an SSRF check that
  // rejects loopback/link-local/private resolved IPs (blocks Steersman's own localhost:3788 control
  // API). Redirects are NOT auto-followed (see _bridgeFetch). NEVER-LOG: this path logs at most
  // {extId, method, host, status} — never options.headers/body or the response body (they can carry
  // Authorization tokens). Returns { ok:true, value:{status,statusText,headers,body} } or a typed
  // error { ok:false, error:{type,message} }.
  async _bridgeFetch(extId, args) {
    const rawUrl = args && typeof args.url === 'string' ? args.url : '';
    const options = (args && args.options && typeof args.options === 'object') ? args.options : {};

    // Guard 1 — parse + scheme allowlist (http/https only).
    let u;
    try { u = new URL(rawUrl); } catch { return { ok: false, error: { type: 'blocked', message: 'invalid url' } }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, error: { type: 'blocked', message: 'scheme not allowed: ' + u.protocol } };
    }

    // Guard 2 — per-extension host allowlist (bridgeHosts from the TRUSTED extId's record). Empty ⇒
    // fail-safe block. Host-glob (*.domain.com) reused from match-pattern.js for consistency.
    const rec = this._bridgeExtRecord(extId);
    const hosts = rec && Array.isArray(rec.bridgeHosts) ? rec.bridgeHosts : [];
    if (!hosts.length || !hosts.some((hp) => hostMatches(hp, u.hostname))) {
      return { ok: false, error: { type: 'blocked', message: 'host not in bridgeHosts: ' + u.hostname } };
    }

    // Guard 3 — SSRF: resolve the host and reject loopback/link-local/private ranges (blocks
    // localhost:3788 and other internal services) even if the allowlist names them.
    // RESIDUAL (B3 accepted): global fetch re-resolves the host itself, so a DNS-rebinding attacker
    // could serve a public IP here and a private IP to the connection. Fully closing it needs an
    // IP-pinning undici dispatcher (connect.lookup) with SNI=hostname — but undici is not require-able
    // in this runtime (not a dependency; `Agent` isn't global) and an untested TLS pin is riskier than
    // this small window, so we keep resolve-and-reject-private and document the residual (see report).
    const ssrf = await this._ssrfCheck(u.hostname);
    if (!ssrf.ok) {
      return { ok: false, error: { type: 'blocked', message: 'blocked non-public address: ' + (ssrf.ip || u.hostname) } };
    }

    // Host-side auth attachment (B3): when options.auth is present the HOST reads the secret and
    // builds the Authorization header, so the token never enters page JS. Host-side auth WINS — any
    // caller-supplied Authorization in options.headers is dropped when options.auth is set.
    // NEVER-LOG: the secret and the built header are never logged.
    let authHeader = null;
    if (options.auth && typeof options.auth === 'object') {
      if (options.auth.type === 'basic') {
        const store = this.getBridge ? this.getBridge() : null;
        if (!store) return { ok: false, error: { type: 'host', message: 'secret storage unavailable' } };
        let secret;
        try { secret = await store.getSecret(extId, options.auth.secretRef); } catch (_) { secret = undefined; }
        if (secret == null) {
          return { ok: false, error: { type: 'host', message: 'secret not found: ' + String(options.auth.secretRef) } };
        }
        const user = options.auth.username != null ? String(options.auth.username) : '';
        authHeader = 'Basic ' + Buffer.from(user + ':' + secret).toString('base64');
      } else {
        return { ok: false, error: { type: 'host', message: 'unsupported auth type: ' + String(options.auth.type) } };
      }
    }
    // Session-cookie attachment (B4): when options.sessionCookies is true AND the TRUSTED record
    // opts in with bridgeSessionCookies===true, the HOST reads the browser's live cookies for the
    // target origin (incl. HttpOnly) via CDP and attaches them as a Cookie header, so a same-user
    // authenticated API (e.g. Bitbucket) can be called with no stored token. GATE: the record flag
    // is the security boundary — without it a set sessionCookies is silently ignored (never attach).
    // Independent of options.auth: if both are set, both headers are applied. NEVER-LOG: cookie
    // names/values and the Cookie header are never logged; a failure logs host-only and proceeds
    // unauthenticated (never throws).
    let cookieHeader = null;
    if (options.sessionCookies === true) {
      if (rec && rec.bridgeSessionCookies === true) {
        try {
          const r = await this.send('Network.getCookies', { urls: [u.origin] });
          const cookies = (r && Array.isArray(r.cookies)) ? r.cookies : [];
          const pairs = cookies
            .filter((c) => c && typeof c.name === 'string')
            .map((c) => c.name + '=' + (c.value != null ? c.value : ''));
          if (pairs.length) cookieHeader = pairs.join('; ');
        } catch (_) {
          this.log.appendLine('[Bridge] session-cookie lookup failed ext=' + extId + ' host=' + u.hostname);
        }
      } else {
        this.log.appendLine('[Bridge] sessionCookies requested but record not opted in ext=' + extId + ' host=' + u.hostname);
      }
    }
    const outHeaders = this._buildFetchHeaders(options.headers, authHeader, cookieHeader);

    const method = (options.method != null ? String(options.method) : 'GET') || 'GET';
    const timeoutMs = Math.min(
      FETCH_TIMEOUT_CAP,
      typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : FETCH_TIMEOUT_CAP
    );
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch (_) {} }, timeoutMs);

    let res;
    try {
      res = await fetch(u.href, {
        method,
        headers: Object.keys(outHeaders).length ? outHeaders : undefined,
        body: options.body != null ? options.body : undefined,
        // Redirects are NOT auto-followed: undici would re-request without re-applying our
        // allowlist/SSRF guards (a redirect-based SSRF bypass). 'manual' yields an opaqueredirect
        // (status 0), surfaced below as a typed 'blocked' error. (Following-with-revalidation is a
        // future enhancement; global fetch's manual mode hides Location, so it can't be done here.)
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') return { ok: false, error: { type: 'timeout', message: 'request timed out' } };
      this.log.appendLine('[Bridge] fetch network error ext=' + extId + ' host=' + u.hostname);
      return { ok: false, error: { type: 'network', message: (e && e.message) ? e.message : 'network error' } };
    }

    if (res.status === 0 || res.type === 'opaqueredirect') {
      clearTimeout(timer);
      this.log.appendLine('[Bridge] fetch ext=' + extId + ' ' + method + ' host=' + u.hostname + ' -> redirect (not followed)');
      return { ok: false, error: { type: 'blocked', message: 'redirect not followed (B2 does not auto-follow redirects; request the final URL)' } };
    }

    // Early size reject via Content-Length (the streaming cap below is the real guard).
    const clen = parseInt(res.headers.get('content-length') || '', 10);
    if (Number.isFinite(clen) && clen > FETCH_SIZE_CAP) {
      clearTimeout(timer);
      try { controller.abort(); } catch (_) {}
      return { ok: false, error: { type: 'toobig', message: 'response exceeds size cap' } };
    }

    let body;
    try {
      body = await this._readCappedText(res, controller);
    } catch (e) {
      clearTimeout(timer);
      if (e && e.__toobig) return { ok: false, error: { type: 'toobig', message: 'response exceeds size cap' } };
      if (e && e.name === 'AbortError') return { ok: false, error: { type: 'timeout', message: 'request timed out' } };
      return { ok: false, error: { type: 'network', message: (e && e.message) ? e.message : 'body read error' } };
    }
    clearTimeout(timer);

    const headers = this._safelistHeaders(res.headers);
    // NEVER-LOG: host only (not the full URL/query), no headers/body.
    this.log.appendLine('[Bridge] fetch ext=' + extId + ' ' + method + ' host=' + u.hostname + ' -> ' + res.status);
    return { ok: true, value: { status: res.status, statusText: res.statusText || '', headers, body } };
  }

  // Look up the TRUSTED extId's active extension record (for bridgeHosts). Reads the active set the
  // SessionManager exposes via getExtensions (already master+enabled gated).
  _bridgeExtRecord(extId) {
    try {
      const list = this.getExtensions ? this.getExtensions() : null;
      if (Array.isArray(list)) return list.find((e) => e && e.id === extId) || null;
    } catch (_) {}
    return null;
  }

  // Merge caller headers with a host-built Authorization (B3) and/or Cookie (B4). When authHeader is
  // set, any caller-supplied Authorization (case-insensitive) is dropped so host-side auth always
  // wins; likewise when cookieHeader is set, any caller-supplied Cookie is dropped so the host's
  // session cookies always win. NEVER-LOG: the cookie header is never logged.
  _buildFetchHeaders(callerHeaders, authHeader, cookieHeader) {
    const out = {};
    if (callerHeaders && typeof callerHeaders === 'object') {
      for (const k of Object.keys(callerHeaders)) {
        if (authHeader && k.toLowerCase() === 'authorization') continue;
        if (cookieHeader && k.toLowerCase() === 'cookie') continue;
        out[k] = callerHeaders[k];
      }
    }
    if (authHeader) out['Authorization'] = authHeader;
    if (cookieHeader) out['Cookie'] = cookieHeader;
    return out;
  }

  // Only a tiny response-header safelist crosses back to the page — NEVER set-cookie.
  _safelistHeaders(headers) {
    const allow = ['content-type', 'content-length', 'etag', 'last-modified', 'link'];
    const out = {};
    try {
      for (const name of allow) {
        const v = headers.get(name);
        if (v != null) out[name] = v;
      }
    } catch (_) {}
    return out;
  }

  // Read the response body as UTF-8 text with a hard size cap, aborting if exceeded.
  async _readCappedText(res, controller) {
    const cap = FETCH_SIZE_CAP;
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        if (step.value) {
          total += step.value.length;
          if (total > cap) {
            try { controller.abort(); } catch (_) {}
            try { reader.cancel(); } catch (_) {}
            const err = new Error('too big'); err.__toobig = true; throw err;
          }
          chunks.push(Buffer.from(step.value));
        }
      }
      return Buffer.concat(chunks).toString('utf8');
    }
    const txt = await res.text();
    if (txt.length > cap) { const err = new Error('too big'); err.__toobig = true; throw err; }
    return txt;
  }

  // SSRF check: resolve the host to all IPs and reject if ANY is loopback/link-local/private (a
  // DNS-rebinding-conservative stance). A DNS failure fails safe (blocked). NOTE: because global
  // fetch re-resolves the host itself, there is a small residual DNS-rebinding window between this
  // check and the connection — acceptable for B2; a future pin-to-IP would close it.
  async _ssrfCheck(hostname) {
    let addrs;
    try {
      addrs = await dns.promises.lookup(hostname, { all: true });
    } catch (_) {
      return { ok: false, ip: hostname };
    }
    for (const a of addrs) {
      if (this._isPrivateIp(a.address, a.family)) return { ok: false, ip: a.address };
    }
    return { ok: true };
  }

  _isPrivateIp(ip, family) {
    if (!ip) return true; // fail-safe
    const s = String(ip).toLowerCase();
    if (family === 6 || s.indexOf(':') !== -1) {
      if (s === '::1' || s === '::') return true;                 // loopback / unspecified
      const m = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);          // IPv4-mapped
      if (m) return this._isPrivateIp4(m[1]);
      if (s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) return true; // link-local fe80::/10
      if (s.startsWith('fc') || s.startsWith('fd')) return true;  // unique-local fc00::/7
      return false;
    }
    return this._isPrivateIp4(s);
  }

  _isPrivateIp4(ip) {
    const p = String(ip).split('.').map((n) => parseInt(n, 10));
    if (p.length !== 4 || p.some((n) => !(n >= 0 && n <= 255))) return true; // malformed -> fail-safe
    const a = p[0], b = p[1];
    if (a === 0) return true;                       // 0.0.0.0/8 "this host"
    if (a === 127) return true;                     // loopback
    if (a === 10) return true;                      // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true;        // private
    if (a === 169 && b === 254) return true;        // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a >= 224) return true;                      // multicast/reserved
    return false;
  }

  // Deliver a reply back into the EXACT isolated world that made the call (resolves its pending
  // promise). rid + reply are JSON-embedded; contextId targets the bridge world.
  async _resolveInContext(ctxId, rid, reply) {
    try {
      await this.send('Runtime.evaluate', {
        expression: '__steersman_bridge_resolve(' + JSON.stringify(rid) + ',' + JSON.stringify(reply) + ')',
        contextId: ctxId,
        returnByValue: true,
      });
    } catch (e) {
      try { this.log.appendLine('[Bridge] resolve failed (ctx=' + ctxId + ', rid=' + rid + '): ' + (e && e.message ? e.message : e)); } catch (_) {}
    }
  }

  // Ids of the currently-active extensions marked hideFromAgent (Phase 4). Read from the
  // SessionManager-supplied getExtensions callback (the active set, so master-off/disabled
  // extensions aren't considered). Used by the read-strip paths below to hide an extension's
  // injected nodes from agent reads. BEST-EFFORT scope: only an extension's own CSS <style> node
  // and any nodes its JS explicitly tagged (via the `steersman.mark(node)` helper →
  // data-steersman-ext=<id>) are strippable; arbitrary DOM mutations a body made cannot be reverted
  // (the same limitation class as JS-side-effect irreversibility).
  _hiddenExtIds() {
    let items = null;
    try {
      items = this.getExtensions ? this.getExtensions() : null;
    } catch {
      items = null;
    }
    if (!Array.isArray(items)) return [];
    return items.filter((e) => e && e.hideFromAgent && e.id).map((e) => e.id);
  }

  // DOM read for agents: the page's outerHTML with the bookmarks-bar host removed AND the injected
  // body shift neutralized. We clone documentElement and, on the CLONE only, strip
  // #__steersman_bookmarks_bar and clear the transform/transformOrigin inline styles plus the
  // data-steersman-shifted attribute on <body> so the returned DOM shows the page without our
  // offset; the live bar and live body are untouched. Shadow content is already excluded from
  // outerHTML, so the returned markup is exactly the page's own DOM and nothing of ours. Phase 4:
  // for each hideFromAgent extension we also strip its own `#__steersman_ext_css_<id>` style node
  // and any `[data-steersman-ext="<id>"]`-tagged nodes from the clone (visible extensions leave
  // reads untouched).
  async getDomStripped() {
    const hidden = JSON.stringify(this._hiddenExtIds());
    return this.evaluate(
      `(function(){var c=document.documentElement.cloneNode(true);` +
        `var b=c.querySelector('#__steersman_bookmarks_bar');if(b)b.remove();` +
        `var bd=c.querySelector('body');if(bd){bd.style.transform='';bd.style.transformOrigin='';` +
        `bd.removeAttribute('data-steersman-shifted');if(!bd.getAttribute('style'))bd.removeAttribute('style');}` +
        `try{(${hidden}).forEach(function(id){var s=c.querySelector('#__steersman_ext_css_'+id);if(s)s.remove();` +
        `Array.prototype.forEach.call(c.querySelectorAll('[data-steersman-ext="'+id+'"]'),function(n){n.remove();});});}catch(e){}` +
        `return c.outerHTML;})()`
    );
  }

  // Text read for agents, guaranteed free of the bookmarks bar. The bar host lives on <html>
  // (outside <body>) and all its UI renders inside a shadow root, so it never contributes to
  // innerText; every text read still funnels through here so a bar-free read is the DEFAULT.
  // When no extension is hideFromAgent we read LIVE innerText (a detached clone's innerText degrades
  // to textContent per spec, losing fidelity), defensively returning '' if the selector targets the
  // bar host. When some extension IS hidden we read from a CLONE with its tagged nodes removed
  // (best-effort; a hidden extension's CSS never affects innerText anyway) — accepting the minor
  // clone-innerText fidelity cost only on the paths that actually need stripping.
  async getTextStripped(selector) {
    const hidden = this._hiddenExtIds();
    if (!hidden.length) {
      const expr = selector
        ? `(function(){var el=document.querySelector(${JSON.stringify(selector)});` +
          `if(!el||el.id==='__steersman_bookmarks_bar')return '';return el.innerText||'';})()`
        : `document.body ? document.body.innerText : ''`;
      return this.evaluate(expr);
    }
    const H = JSON.stringify(hidden);
    const strip = `(${H}).forEach(function(id){Array.prototype.forEach.call(c.querySelectorAll('[data-steersman-ext="'+id+'"]'),function(n){n.remove();});var s=c.querySelector('#__steersman_ext_css_'+id);if(s)s.remove();});`;
    const expr = selector
      ? `(function(){var el=document.querySelector(${JSON.stringify(selector)});` +
        `if(!el||el.id==='__steersman_bookmarks_bar')return '';var c=el.cloneNode(true);try{${strip}}catch(e){}` +
        `return c.innerText||c.textContent||'';})()`
      : `(function(){if(!document.body)return '';var c=document.body.cloneNode(true);try{${strip}}catch(e){}` +
        `return c.innerText||c.textContent||'';})()`;
    return this.evaluate(expr);
  }

  async click(selector) {
    const ok = await this.evaluate(
      `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.click();return true;})()`
    );
    if (!ok) throw new Error(`No element matches selector: ${selector}`);
  }

  async type(selector, text) {
    const ok = await this.evaluate(
      `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;` +
        `el.focus();el.value=${JSON.stringify(text)};` +
        `el.dispatchEvent(new Event('input',{bubbles:true}));` +
        `el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`
    );
    if (!ok) throw new Error(`No element matches selector: ${selector}`);
  }

  // Scroll the page: to a selector (into view), to top/bottom, or by an (x,y) delta
  // (defaulting a null y to one viewport height). Args go through JSON.stringify; no
  // raw agent JS reaches the page. Returns the resting scroll offset.
  async scroll({ x, y, selector, to } = {}) {
    if (selector) {
      const ok = await this.evaluate(
        `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;` +
          `el.scrollIntoView({behavior:'instant',block:'center'});return true;})()`
      );
      if (!ok) return { ok: false, error: 'no element for selector' };
    } else if (to === 'bottom') {
      await this.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    } else if (to === 'top') {
      await this.evaluate('window.scrollTo(0, 0)');
    } else {
      await this.evaluate(
        `window.scrollBy(${JSON.stringify(x || 0)}, ${JSON.stringify(y != null ? y : 0)} || window.innerHeight)`
      );
    }
    return this.evaluate('({scrolledTo:{x:window.scrollX,y:window.scrollY}})');
  }

  // Dispatch a keydown+keyup for `key` on the active element (focusing `selector` first
  // if given). `key` is JSON.stringify'd into the controlled template — never raw JS.
  async press({ key, selector } = {}) {
    if (selector) {
      const found = await this.evaluate(
        `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.focus();return true;})()`
      );
      if (!found) return { ok: false, error: 'no element for selector' };
    }
    await this.evaluate(
      `(function(){var k=${JSON.stringify(key)};var el=document.activeElement||document.body;` +
        `var opts={key:k,bubbles:true,cancelable:true};` +
        `el.dispatchEvent(new KeyboardEvent('keydown',opts));` +
        `el.dispatchEvent(new KeyboardEvent('keyup',opts));})()`
    );
    return { ok: true, key };
  }

  // Dispatch mouseover/mouseenter/mousemove on the matched element (selector via
  // JSON.stringify). Missing selector reports {ok:false} rather than throwing.
  async hover({ selector } = {}) {
    const ok = await this.evaluate(
      `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;` +
        `var opts={bubbles:true,cancelable:true};` +
        `el.dispatchEvent(new MouseEvent('mouseover',opts));` +
        `el.dispatchEvent(new MouseEvent('mouseenter',opts));` +
        `el.dispatchEvent(new MouseEvent('mousemove',opts));return true;})()`
    );
    if (!ok) return { ok: false, error: 'no element for selector' };
    return { ok: true };
  }

  // Wait (in-page, controlled poll) until a selector appears or the document finishes
  // loading, bounded by `timeout` ms. Resolves {ok:true,waited} or {ok:false,timedOut}.
  async waitFor({ selector, until, timeout } = {}) {
    const ms = Number(timeout) > 0 ? Number(timeout) : 5000;
    const cond = selector
      ? `!!document.querySelector(${JSON.stringify(selector)})`
      : `document.readyState==='complete'`;
    return this.evaluate(
      `(function(){return new Promise(function(resolve){var start=Date.now();var deadline=start+${JSON.stringify(ms)};` +
        `(function poll(){if(${cond})return resolve({ok:true,waited:Date.now()-start});` +
        `if(Date.now()>=deadline)return resolve({ok:false,timedOut:true,waited:Date.now()-start});` +
        `setTimeout(poll,50);})();});})()`
    );
  }

  async screenshot() {
    const r = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
    return r && r.data; // base64 jpeg
  }

  // Ask the page target to bring itself to the foreground. Supplements the VS Code
  // editor-group focus done on "Focus"; may be a no-op for the integrated browser
  // transport, so callers should treat failure as non-fatal.
  async bringToFront() {
    await this.send('Page.bringToFront');
  }

  async currentUrl() {
    try {
      return await this.evaluate('location.href');
    } catch {
      return this.url;
    }
  }

  // ---- capture readers (Feature 1) ----

  // Return the last `limit` console entries in chronological order (oldest-of-slice first).
  // limit clamps to [1,200], default 50. Entries are plain {seq,type,text,ts} objects.
  getConsole(limit) {
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    return this._console.slice(-n).map((e) => ({ seq: e.seq, type: e.type, text: e.text, ts: e.ts }));
  }

  // Return the last `limit` network entries in chronological order (oldest-of-slice first).
  // When failedOnly is truthy the source is filtered to failed requests first. limit clamps
  // to [1,200], default 50. Entries are returned as pushed.
  getNetwork(limit, failedOnly) {
    const source = failedOnly ? this._network.filter((e) => e.failed) : this._network;
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    return source.slice(-n);
  }

  // ---- DOM-diff "what changed" (Feature 2) ----

  // Compare the current visible (bar-free) page text against the previous snapshot. The first
  // call has no baseline: it stores the current lines and returns them as `added` with
  // baseline:true. Subsequent calls return a multiset line diff (added/removed) vs the prior
  // snapshot and re-baseline to the current lines. added/removed cap at 200 (truncated flag set).
  async getChanges() {
    const text = await this.getTextStripped();
    const lines = String(text || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    if (this._lastChangesText === null) {
      this._lastChangesText = lines;
      const capped = lines.slice(0, 200);
      return { baseline: true, added: capped, removed: [], truncated: capped.length < lines.length };
    }

    const before = new Map();
    for (const l of this._lastChangesText) before.set(l, (before.get(l) || 0) + 1);
    const now = new Map();
    for (const l of lines) now.set(l, (now.get(l) || 0) + 1);

    const added = [];
    for (const [line, count] of now) {
      const delta = count - (before.get(line) || 0);
      for (let i = 0; i < delta; i++) added.push(line);
    }
    const removed = [];
    for (const [line, count] of before) {
      const delta = count - (now.get(line) || 0);
      for (let i = 0; i < delta; i++) removed.push(line);
    }

    this._lastChangesText = lines;
    const truncated = added.length > 200 || removed.length > 200;
    return { baseline: false, added: added.slice(0, 200), removed: removed.slice(0, 200), truncated };
  }

  // ---- find-by-description resolver (Feature 3) ----

  // Resolve a natural-language `query` to up to `limit` (clamped [1,25], default 8) on-page
  // elements, scored by how well each element's accessible name / role / attributes match the
  // query tokens. Excludes the bookmarks bar host and its subtree, and invisible elements.
  // Returns { matches: [{selector,text,role,tag,rect:{x,y,w,h},score}, ...] } (empty on failure).
  async findElements(query, limit) {
    const cap = Math.max(1, Math.min(25, Number(limit) || 8));
    const expr =
      `(function(query, cap){try{` +
      `var q=String(query||'').toLowerCase();` +
      `var tokens=q.split(/\\s+/).filter(Boolean);` +
      `var bar=document.getElementById('__steersman_bookmarks_bar');` +
      `function esc(s){if(window.CSS&&CSS.escape)return CSS.escape(s);return String(s).replace(/[^a-zA-Z0-9_-]/g,function(ch){return '\\\\'+ch;});}` +
      `function visible(el){var r=el.getBoundingClientRect();if(r.width===0&&r.height===0)return false;` +
      `var cs=window.getComputedStyle(el);if(!cs)return true;if(cs.display==='none'||cs.visibility==='hidden')return false;return true;}` +
      `function accName(el){var cand=[el.getAttribute('aria-label'),el.getAttribute('title'),el.getAttribute('placeholder'),` +
      `((el.tagName==='INPUT'||el.tagName==='BUTTON')?el.value:''),el.getAttribute('alt'),(el.innerText||el.textContent||'')];` +
      `for(var i=0;i<cand.length;i++){var c=cand[i];if(c!=null){c=String(c).trim();if(c)return c.slice(0,120);}}return '';}` +
      `function selectorFor(el){` +
      `if(el.id&&/^[A-Za-z][\\w-]*$/.test(el.id)){var s='#'+esc(el.id);if(document.querySelectorAll(s).length===1)return s;}` +
      `var tag=el.tagName.toLowerCase();var attrs=['data-testid','name','aria-label'];` +
      `for(var i=0;i<attrs.length;i++){var v=el.getAttribute(attrs[i]);if(v){var sel=tag+'['+attrs[i]+'=\"'+String(v).replace(/\"/g,'\\\\\"')+'\"]';` +
      `if(document.querySelectorAll(sel).length===1)return sel;}}` +
      `var parts=[];var cur=el;var depth=0;while(cur&&cur.nodeType===1&&depth<5){` +
      `var ct=cur.tagName.toLowerCase();var k=1;var sib=cur;while((sib=sib.previousElementSibling)){if(sib.tagName===cur.tagName)k++;}` +
      `parts.unshift(ct+':nth-of-type('+k+')');` +
      `if(cur!==el&&cur.id&&/^[A-Za-z][\\w-]*$/.test(cur.id)){parts[0]='#'+esc(cur.id);return parts.join(' > ');}` +
      `cur=cur.parentElement;depth++;}return parts.join(' > ');}` +
      `var sel='a,button,input,textarea,select,[role],[onclick],label,summary,h1,h2,h3,[aria-label],[placeholder],[title]';` +
      `var nodes=document.querySelectorAll(sel);var scored=[];` +
      `for(var i=0;i<nodes.length;i++){var el=nodes[i];` +
      `if(bar&&(el===bar||bar.contains(el)))continue;` +
      `if(!visible(el))continue;` +
      `var name=accName(el);var role=el.getAttribute('role')||el.tagName.toLowerCase();` +
      `var nameL=name.toLowerCase();` +
      `var meta=[role,el.tagName.toLowerCase(),el.id||'',el.getAttribute('name')||'',el.getAttribute('placeholder')||''].join(' ').toLowerCase();` +
      `var score=0;` +
      `for(var t=0;t<tokens.length;t++){var tok=tokens[t];` +
      `var wordRe=new RegExp('(^|\\\\W)'+tok.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&')+'(\\\\W|$)');` +
      `if(wordRe.test(nameL))score+=3;else if(nameL.indexOf(tok)!==-1)score+=2;` +
      `if(meta.indexOf(tok)!==-1)score+=1;}` +
      `if(q&&nameL.indexOf(q)!==-1)score+=2;` +
      `if(score<=0)continue;` +
      `scored.push({el:el,name:name,role:role,tag:el.tagName.toLowerCase(),score:score});}` +
      `scored.sort(function(a,b){return b.score-a.score;});scored=scored.slice(0,cap);` +
      `return scored.map(function(s){var r=s.el.getBoundingClientRect();` +
      `return {selector:selectorFor(s.el),text:s.name,role:s.role,tag:s.tag,` +
      `rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},score:s.score};});` +
      `}catch(e){return [];}})(${JSON.stringify(query)}, ${JSON.stringify(cap)})`;
    try {
      const matches = await this.evaluate(expr);
      return { matches: Array.isArray(matches) ? matches : [] };
    } catch {
      return { matches: [] };
    }
  }

  rejectAllPending(err) {
    this.pending.forEach((p) => p.reject(err));
    this.pending.clear();
  }

  async disconnect() {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    if (this._browserTabSession) {
      try { await this._browserTabSession.close(); } catch {}
      this._browserTabSession = null;
    }
    this._browserTab = null;
    this._session = null;
    this._pageSessionId = null;
    this._browserSessionId = null;
    this.rejectAllPending(new Error('Disconnected'));
    this.state = 'disconnected';
    this._emitDisconnect();
  }
}

module.exports = { CDPTab, BROWSER_SESSION_TYPES };
