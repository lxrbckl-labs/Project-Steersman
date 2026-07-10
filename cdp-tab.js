// One integrated-browser tab's CDP connection. Supports two transports:
//   - connectToBrowserTab(tab)   proposed `browser` API (BrowserTab.startCDPSession)
//   - connectToSession(session)  debug-session fallback (requestCDPProxy -> WebSocket)
// Both converge on the same bootstrap: attach to the page target, enable domains.
//
// Distilled from thimo/vscode-integrated-browser-mcp (MIT). Trimmed to the MVP
// surface: navigate/eval/text/click/type/screenshot/url. No console/network
// buffers, title prefixes, child-session capture, or reconnect yet.

const vscode = require('vscode');
let WebSocket = null;
try {
  WebSocket = require('ws');
} catch {
  // Only needed for the debug-session (websocket) fallback path.
}

const BROWSER_SESSION_TYPES = ['pwa-editor-browser', 'editor-browser', 'pwa-chrome', 'chrome'];

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
    ]);
  }

  handleMessage(msg) {
    if (!msg) return;
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
        else p.resolve(msg.result);
      }
    } else if (msg.method === 'Page.frameNavigated') {
      const f = msg.params && msg.params.frame;
      if (f && f.url && !f.parentId) this._lastKnownUrl = f.url;
    }
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
