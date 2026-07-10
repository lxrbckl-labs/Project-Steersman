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

    // Pre-routing security gate (order: host -> token -> route -> capability). A failed
    // earlier check short-circuits. Neither branch ever echoes the token.
    if (!isAllowedHost(req.headers.host)) {
      return send(403, { error: 'forbidden host' });
    }
    if (!tokensMatch(req.headers['x-steersman-token'], token)) {
      return send(401, { error: 'unauthorized' });
    }

    let u;
    try {
      u = new URL(req.url, 'http://localhost');
    } catch {
      return send(400, { error: 'bad url' });
    }
    const p = u.pathname;

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
          const w = await manager.window(instance);
          if (!w) return send(404, { error: 'instance not found', instance });
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
          try {
            const out = await runner.runScript(instance, name);
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
          return send(200, { instance: session.id, text: await tab.getText(q('selector') || undefined) });
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
