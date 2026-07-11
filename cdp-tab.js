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
    // Optional callback returning the current bookmark tree ({children:[...]}). Set by the
    // SessionManager at creation; when unset (feature off) the bar is simply not injected.
    this.getBookmarks = null;
    // Optional callback returning the global "show bookmarks bar" flag (boolean). Set by the
    // SessionManager; when unset the bar defaults to injecting (backward-compatible).
    this.getBarEnabled = null;
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
    } else if (msg.method === 'Page.loadEventFired') {
      // A load replaces the document and drops our host node — re-inject the bar.
      this._reinjectBookmarks();
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

  // DOM read for agents: the page's outerHTML with the bookmarks-bar host removed AND the injected
  // body shift neutralized. We clone documentElement and, on the CLONE only, strip
  // #__steersman_bookmarks_bar and clear the transform/transformOrigin inline styles plus the
  // data-steersman-shifted attribute on <body> so the returned DOM shows the page without our
  // offset; the live bar and live body are untouched. Shadow content is already excluded from
  // outerHTML, so the returned markup is exactly the page's own DOM and nothing of ours.
  async getDomStripped() {
    return this.evaluate(
      `(function(){var c=document.documentElement.cloneNode(true);` +
        `var b=c.querySelector('#__steersman_bookmarks_bar');if(b)b.remove();` +
        `var bd=c.querySelector('body');if(bd){bd.style.transform='';bd.style.transformOrigin='';` +
        `bd.removeAttribute('data-steersman-shifted');if(!bd.getAttribute('style'))bd.removeAttribute('style');}` +
        `return c.outerHTML;})()`
    );
  }

  // Text read for agents, guaranteed free of the bookmarks bar. The bar host lives on <html>
  // (outside <body>) and all its UI renders inside a shadow root, so it never contributes to
  // innerText; every text read still funnels through here so a bar-free read is the DEFAULT.
  // We read LIVE innerText (a detached clone's innerText degrades to textContent per spec,
  // losing fidelity) and defensively return '' if the selector targets the bar host itself.
  async getTextStripped(selector) {
    const expr = selector
      ? `(function(){var el=document.querySelector(${JSON.stringify(selector)});` +
        `if(!el||el.id==='__steersman_bookmarks_bar')return '';return el.innerText||'';})()`
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
