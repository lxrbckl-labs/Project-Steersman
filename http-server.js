// Minimal HTTP API over Node's built-in http (no express dependency).
// Every action endpoint resolves a session (by `instance` id, or defaults to the
// most-recently-created connected one) and maps to a CDP-backed action on its tab.
// Sessions are user-created via the Project Steersman panel; HTTP never launches one.

const http = require('http');
const crypto = require('crypto');

// Sensitive route -> the capability id that must be enabled for it to run. Observation
// routes (/health, /capabilities, /url, GET /windows, /scripts, GET /window) carry no
// entry and stay open (still behind host + token). GET /window strips its dom field
// separately when `read` is off. Keyed by "METHOD /path".
const ROUTE_CAPABILITY = {
  'POST /navigate': 'navigate',
  'GET /text': 'read',
  'POST /click': 'interact',
  'POST /type': 'interact',
  'POST /scroll': 'interact',
  'POST /press': 'interact',
  'POST /hover': 'interact',
  'POST /eval': 'eval',
  'GET /screenshot': 'screenshot',
  'POST /windows': 'create_window',
  'POST /window/close': 'close_window',
  'POST /script/run': 'run_script',
};

// Anti-DNS-rebinding: accept only a Host header whose hostname is a loopback name (any
// port, or none). A browser page that resolved an attacker domain to 127.0.0.1 still
// carries the attacker domain in Host and is rejected; a legit fetch('http://localhost:PORT')
// sends "localhost:PORT" and passes.
function isAllowedHost(hostHeader) {
  if (!hostHeader) return false;
  const host = String(hostHeader);
  let hostname;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    hostname = end >= 0 ? host.slice(0, end + 1) : host;
  } else {
    const colon = host.indexOf(':');
    hostname = colon >= 0 ? host.slice(0, colon) : host;
  }
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

// Constant-time token compare. Unequal lengths (or a missing/typed-wrong value) are a
// mismatch without reaching timingSafeEqual (which throws on length mismatch).
function tokensMatch(provided, expected) {
  if (!expected || typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// True only when a capability with the given id exists and is enabled in the shared config.
// A missing config denies (safe default) — the route stays 403 until the operator opts in.
function isCapEnabled(config, id) {
  if (!config) return false;
  const caps = (config.getState() && config.getState().capabilities) || [];
  const c = caps.find((x) => x && x.id === id);
  return !!(c && c.enabled);
}

function readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function listenWithFallback(server, startPort, attempts = 10) {
  return new Promise((resolve, reject) => {
    let port = startPort;
    let tries = 0;
    const cleanup = () => {
      server.removeListener('error', onError);
      server.removeListener('listening', onListen);
    };
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && tries < attempts) {
        tries++;
        port++;
        server.listen(port, '127.0.0.1');
      } else {
        cleanup();
        reject(err);
      }
    };
    const onListen = () => {
      cleanup();
      resolve(port);
    };
    server.on('error', onError);
    server.on('listening', onListen);
    server.listen(port, '127.0.0.1');
  });
}

async function startHttpServer(preferredPort, ctx) {
  const { manager, log, config, runner, token } = ctx;

  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    // Text send path (used for the /docs/* markdown reference, which isn't JSON).
    const sendText = (code, text, contentType) => {
      res.writeHead(code, { 'content-type': contentType || 'text/plain; charset=utf-8' });
      res.end(text);
    };

    // Pre-routing security gate (order: host -> token -> route -> capability). A failed
    // earlier check short-circuits. Neither branch ever echoes the token.
    if (!isAllowedHost(req.headers.host)) {
      return send(403, { error: 'forbidden host' });
    }

    let u;
    try {
      u = new URL(req.url, 'http://localhost');
    } catch {
      return send(400, { error: 'bad url' });
    }
    const p = u.pathname;

    // Docs allowlist: the capability-filtered API reference the agent fetches to LEARN the
    // API. Requiring the token here would be a chicken-and-egg (the doc is how it discovers
    // the header), so /docs/* bypasses the token AND capability gates — but stays behind the
    // Host (loopback) check above, so only local pages can read it. Non-sensitive text only.
    if (p === '/docs/tab' || p === '/docs/fleet') {
      const kind = p === '/docs/fleet' ? 'fleet' : 'tab';
      return sendText(200, manager.buildApiDoc(kind, config), 'text/markdown; charset=utf-8');
    }

    if (!tokensMatch(req.headers['x-steersman-token'], token)) {
      return send(401, { error: 'unauthorized' });
    }

    // Server-side capability enforcement (defense-in-depth): a sensitive route whose
    // capability is disabled is rejected before it can touch a session. Observation routes
    // carry no map entry and pass through.
    const requiredCap = ROUTE_CAPABILITY[req.method + ' ' + p];
    if (requiredCap && !isCapEnabled(config, requiredCap)) {
      return send(403, { error: 'capability disabled', capability: requiredCap });
    }

    // Health check never launches or requires a session.
    if (p === '/health') {
      return send(200, {
        ok: true,
        sessions: manager.list().map((s) => ({ id: s.id, state: s.state, url: s.url })),
      });
    }

    // Roster / config / lifecycle endpoints for the MCP server. These sit BEFORE the
    // action gate below: they don't require a connected session (GET /window returns
    // dom:null for a dropped tab, close tears down whatever's there, create makes a new one).
    if (
      p === '/capabilities' || p === '/windows' || p === '/window' || p === '/window/close' ||
      p === '/scripts' || p === '/script/run'
    ) {
      try {
        const body = req.method === 'POST' ? await readJson(req) : {};
        const instance = body.instance != null ? body.instance : u.searchParams.get('instance');
        if (p === '/capabilities' && req.method === 'GET') {
          return send(200, config ? config.getState() : { error: 'no capability config' });
        }
        if (p === '/windows' && req.method === 'GET') {
          return send(200, { windows: await manager.windows() });
        }
        if (p === '/windows' && req.method === 'POST') {
          const s = await manager.create();
          return send(200, { ok: true, id: s.id });
        }
        if (p === '/window' && req.method === 'GET') {
          // Manual-mode guard FIRST: a window with autopilot OFF is human-only, so an agent may
          // not even read it — 403 before manager.window() does any CDP title eval / DOM read.
          // Guard on the raw instance id; isAutopilot fails open on an unknown id, so a truly
          // unknown instance falls through to window() and still 404s below. GET /windows (the
          // fleet list) stays open so the manual window still shows up there.
          if (instance != null && instance !== '' && manager.isAutopilot(instance) === false) {
            return send(403, { error: 'window under manual control', instance });
          }
          const w = await manager.window(instance);
          if (!w) return send(404, { error: 'instance not found', instance });
          // Reading one window is agent activity against that specific session — mark it
          // (w.id is the resolved instance), but only when connected: a disconnected/connecting
          // tab shouldn't flash its dot orange just because an agent polled it. Fleet list
          // /windows stays unmarked.
          if (w.id && w.state === 'connected') manager.markAgentActivity(w.id);
          // Observation is always allowed, but DOM depth respects `read` (mirror the MCP
          // dom-strip): omit the dom field entirely when read is off.
          if (!isCapEnabled(config, 'read') && w && typeof w === 'object' && 'dom' in w) {
            const { dom, ...rest } = w;
            return send(200, rest);
          }
          return send(200, w);
        }
        if (p === '/window/close' && req.method === 'POST') {
          if (!manager.get(instance)) return send(404, { error: 'instance not found', instance });
          // Manual-mode guard: an agent may not close a human-only window (autopilot OFF) —
          // 403 and leave it open. The operator still closes it via the panel (which drives the
          // host directly, not this route). Fail-open on unknown id (already 404'd above).
          if (manager.isAutopilot(instance) === false) {
            return send(403, { error: 'window under manual control', instance });
          }
          await manager.close(instance);
          return send(200, { ok: true, id: instance });
        }
        if (p === '/scripts' && req.method === 'GET') {
          return send(200, { scripts: runner ? runner.listScripts() : [] });
        }
        if (p === '/script/run' && req.method === 'POST') {
          if (!runner) return send(500, { error: 'no script runner' });
          const name = body.name != null ? body.name : u.searchParams.get('name');
          if (!name) return send(400, { error: 'name required' });
          // Manual-mode guard: resolve the concrete target (explicit instance, else the
          // latest-connected default the runner would pick) and reject if that window is
          // human-only, so a saved script can't drive a manual window. Fail-open on unknown id.
          const runId = instance != null && instance !== ''
            ? instance
            : (manager.latestConnected() && manager.latestConnected().id);
          if (runId && manager.isAutopilot(runId) === false) {
            return send(403, { error: 'window under manual control', instance: runId });
          }
          try {
            const out = await runner.runScript(instance, name);
            // A saved script ran against a concrete session — mark it agent-active (out.instance
            // is the id the runner acted on, even when `instance` defaulted). Applies whether the
            // script succeeded or errored, since either way it drove the tab.
            if (out && out.instance) manager.markAgentActivity(out.instance);
            // A script that threw ran but errored: distinguish it (ok:false) from a 4xx.
            if (out.status === 'error') {
              return send(200, { ok: false, instance: out.instance, name: out.name, status: 'error', error: out.error });
            }
            return send(200, { ok: true, instance: out.instance, name: out.name, status: out.status, result: out.result });
          } catch (e) {
            // Tagged pre-flight failures map to 4xx; anything else bubbles to the 500 below.
            if (e.code === 'NOT_CONNECTED') return send(409, { error: e.message, instance, name });
            if (e.code === 'INSTANCE_NOT_FOUND' || e.code === 'SCRIPT_NOT_FOUND') {
              return send(404, { error: e.message, instance, name });
            }
            throw e;
          }
        }
        return send(404, { error: 'not found', path: p });
      } catch (e) {
        log.appendLine('[HTTP] ' + p + ' error: ' + e.message);
        return send(500, { error: e.message });
      }
    }

    try {
      const body = req.method === 'POST' ? await readJson(req) : {};
      const q = (k) => (body[k] != null ? body[k] : u.searchParams.get(k));

      // ---- resolve the target session (Option A routing) ----
      const instanceId = q('instance');
      let session;
      if (instanceId != null && instanceId !== '') {
        session = manager.get(instanceId);
        if (!session) return send(404, { error: 'instance not found', instance: instanceId });
      } else {
        session = manager.latestConnected();
        if (!session) {
          return send(409, { error: 'no sessions; create one in the Project Steersman panel' });
        }
      }

      const tab = session.tab;
      if (!tab || session.state !== 'connected') {
        return send(409, { error: 'session not connected', instance: session.id, state: session.state });
      }

      // Shared manual-mode guard for the per-instance agent endpoints below
      // (navigate/click/type/eval/screenshot/scroll/press/hover/text/url/wait): a window with
      // autopilot OFF is human-only, so reject the agent action/read (403) before we mark or
      // touch it — only the operator's panel drives that window. Fail-open on unknown id
      // (isAutopilot defaults true), so normal windows are unaffected. Sits after host+token
      // auth (an unauthed caller already got 401) and alongside the capability gate above.
      if (manager.isAutopilot(session.id) === false) {
        return send(403, { error: 'window under manual control', instance: session.id });
      }

      // Shared mark point for the per-instance agent-driving/reading endpoints below
      // (navigate/click/type/eval/screenshot/scroll/press/hover/text/url/wait): this is
      // where they resolve their concrete session (explicit `instance` or latest-connected),
      // so one call keeps that session's agent-active dot lit. Guarded no-op on unknown id.
      if (session && session.id) manager.markAgentActivity(session.id);

      switch (p) {
        case '/navigate': {
          const url = q('url');
          if (!url) return send(400, { error: 'url required' });
          await tab.navigate(url);
          await manager.refreshTitle(session);
          return send(200, { ok: true, instance: session.id, url: await tab.currentUrl() });
        }
        case '/url':
          return send(200, { instance: session.id, url: await tab.currentUrl() });
        case '/text':
          // Stripped read: a text pull never includes the injected bookmarks bar.
          return send(200, { instance: session.id, text: await tab.getTextStripped(q('selector') || undefined) });
        case '/click': {
          const sel = q('selector');
          if (!sel) return send(400, { error: 'selector required' });
          await tab.click(sel);
          return send(200, { ok: true, instance: session.id });
        }
        case '/type': {
          const sel = q('selector');
          if (!sel) return send(400, { error: 'selector required' });
          await tab.type(sel, q('text') || '');
          return send(200, { ok: true, instance: session.id });
        }
        case '/scroll': {
          const to = q('to');
          const x = q('x'), y = q('y');
          return send(200, { ok: true, instance: session.id, result: await tab.scroll({
            x: x != null ? Number(x) : undefined,
            y: y != null ? Number(y) : undefined,
            selector: q('selector') || undefined,
            to: to || undefined,
          }) });
        }
        case '/press': {
          const key = q('key');
          if (!key) return send(400, { error: 'key required' });
          return send(200, { instance: session.id, result: await tab.press({ key, selector: q('selector') || undefined }) });
        }
        case '/hover': {
          const sel = q('selector');
          if (!sel) return send(400, { error: 'selector required' });
          return send(200, { instance: session.id, result: await tab.hover({ selector: sel }) });
        }
        case '/wait': {
          const timeout = q('timeout');
          return send(200, { instance: session.id, result: await tab.waitFor({
            selector: q('selector') || undefined,
            until: q('until') || undefined,
            timeout: timeout != null ? Number(timeout) : undefined,
          }) });
        }
        case '/eval': {
          const js = q('js') || q('expression');
          if (!js) return send(400, { error: 'js required' });
          return send(200, { instance: session.id, result: await tab.evaluate(js) });
        }
        case '/screenshot':
          return send(200, { instance: session.id, format: 'jpeg', base64: await tab.screenshot() });
        default:
          return send(404, { error: 'not found', path: p });
      }
    } catch (e) {
      log.appendLine('[HTTP] ' + p + ' error: ' + e.message);
      return send(500, { error: e.message });
    }
  });

  const port = await listenWithFallback(server, preferredPort);
  return {
    port,
    close: () => new Promise((r) => server.close(r)),
  };
}

module.exports = { startHttpServer };
