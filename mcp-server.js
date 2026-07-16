// Standalone stdio MCP server: a thin client that turns MCP tool calls into HTTP
// requests against the Project Steersman extension's local API (localhost:3788). It
// fetches /capabilities on startup, uses the composed capability prompt as the MCP
// `instructions`, and registers only the tools whose capability the operator enabled.
//
// CommonJS to match the rest of the repo. `@modelcontextprotocol/sdk` (>=1.x) is
// dual-published (its package `exports` expose a CJS build under the `require`
// condition), so `require('@modelcontextprotocol/sdk/...')` resolves cleanly. The
// low-level `Server` API is used deliberately so tools can carry raw JSON Schema
// `inputSchema` without pulling in a zod dependency (which `McpServer` would need).
//
// IMPORTANT: stdout is the MCP transport — everything logged goes to stderr ONLY.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const HOST = '127.0.0.1';

// stderr-only logger (never stdout — see file header). Never pass the auth token here.
function log(msg) {
  process.stderr.write('[MCP] ' + msg + '\n');
}

// Strip a trailing path separator (but not from a bare root like "/" or "C:\") so
// comparisons below aren't fooled by a stray trailing slash.
function stripTrailingSep(p) {
  if (p.length > 1 && (p.endsWith(path.sep) || p.endsWith('/'))) {
    return p.slice(0, -1);
  }
  return p;
}

// Does `cwd` match `workspace` (equal, or one nested inside the other)? Both are assumed
// already path.resolve()'d and trailing-sep-stripped.
function workspaceMatchesCwd(workspace, cwd) {
  if (workspace === cwd) return true;
  if (cwd.startsWith(workspace + path.sep)) return true;
  if (workspace.startsWith(cwd + path.sep)) return true;
  return false;
}

// Resolve the extension's HTTP port + loopback auth token from the shared instance
// registry that extension.js writes (~/.project-steersman/instances/<id>.json, each
// { port, workspace, pid, token }). Resolution order:
//   1. STEERSMAN_PORT env set -> pick the entry whose port matches (explicit override);
//      if set but no entry matches, fall through to the env-based fallback (step 4).
//   2. Workspace match -> among registry entries, pick the one whose `workspace` best
//      matches this process's cwd (exact match, cwd nested in workspace, or workspace
//      nested in cwd), preferring the longest/most-specific workspace path on ties.
//   3. Exactly one registered instance -> use it.
//   4. Fallback -> STEERSMAN_PORT/STEERSMAN_TOKEN env vars, else default port 3788/no token.
// Never throws — a missing token just means calls will 401 and surface as tool errors.
function resolveInstance() {
  const dir = path.join(os.homedir(), '.project-steersman', 'instances');
  const envPort = process.env.STEERSMAN_PORT ? Number(process.env.STEERSMAN_PORT) : null;
  let entries = [];
  try {
    entries = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter((e) => e && e.port != null);
  } catch {
    entries = [];
  }

  let chosen = null;

  // 1. Explicit STEERSMAN_PORT override.
  if (envPort != null) {
    chosen = entries.find((e) => Number(e.port) === envPort) || null;
  }

  // 2. Workspace match against this process's own cwd.
  if (!chosen && envPort == null) {
    let cwd = null;
    try {
      cwd = stripTrailingSep(path.resolve(process.cwd()));
    } catch {
      cwd = null;
    }
    if (cwd) {
      let best = null;
      for (const e of entries) {
        if (!e.workspace) continue;
        let ws;
        try {
          ws = stripTrailingSep(path.resolve(String(e.workspace)));
        } catch {
          continue;
        }
        if (workspaceMatchesCwd(ws, cwd)) {
          if (!best || ws.length > best.ws.length) best = { entry: e, ws };
        }
      }
      if (best) chosen = best.entry;
    }
  }

  // 3. Exactly one registered instance.
  if (!chosen && envPort == null && entries.length === 1) {
    chosen = entries[0];
  }

  // 4. Env/default fallback.
  const port = chosen && chosen.port != null ? chosen.port : envPort != null ? envPort : 3788;
  const token = (chosen && chosen.token) || process.env.STEERSMAN_TOKEN || null;

  if (chosen) {
    log('targeting instance on port ' + port + ' (workspace ' + (chosen.workspace || '?') + ')');
  }

  return { port, token };
}

const { port: PORT, token: TOKEN } = resolveInstance();
if (!TOKEN) {
  log('no Steersman auth token found — is the extension running? tools will fail with 401');
}

// One HTTP round-trip to the extension. Resolves { status, json } for any response
// (including non-2xx); rejects only on a transport-level failure (e.g. refused).
function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const headers = {};
    if (TOKEN) headers['x-steersman-token'] = TOKEN;
    if (data) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(data);
    }
    const req = http.request({ host: HOST, port: PORT, path, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let json;
        try {
          json = b ? JSON.parse(b) : {};
        } catch {
          json = { raw: b };
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Build a query string from defined (non-null) params.
function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') u.set(k, String(v));
  }
  const s = u.toString();
  return s ? '?' + s : '';
}

// Tool catalogue. `cap` is the /capabilities id that gates the tool (null = always on).
// `call(args)` returns the HTTP request to make; `transform` optionally post-processes
// the successful JSON before it is returned to the model.
const INSTANCE_PROP = { instance: { type: 'string', description: 'Target window/instance id.' } };

function makeTools(readEnabled) {
  return [
    {
      name: 'list_windows',
      cap: null,
      description: 'List all open integrated-browser windows and their current state.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => ({ method: 'GET', path: '/windows' }),
    },
    {
      name: 'get_window',
      cap: null,
      description:
        'Get one window\'s detailed state (url, title, activity, and DOM when read access is granted).',
      inputSchema: {
        type: 'object',
        properties: { ...INSTANCE_PROP },
        required: ['instance'],
        additionalProperties: false,
      },
      call: (a) => ({ method: 'GET', path: '/window' + qs({ instance: a.instance }) }),
      // Observation is always allowed, but DOM depth respects the `read` capability.
      transform: (json) => {
        if (!readEnabled && json && typeof json === 'object' && 'dom' in json) {
          const { dom, ...rest } = json;
          return rest;
        }
        return json;
      },
    },
    {
      name: 'navigate',
      cap: 'navigate',
      description: 'Navigate a window to a URL.',
      inputSchema: {
        type: 'object',
        properties: {
          ...INSTANCE_PROP,
          url: { type: 'string', description: 'Destination URL.' },
        },
        required: ['instance', 'url'],
        additionalProperties: false,
      },
      call: (a) => ({ method: 'POST', path: '/navigate', body: { instance: a.instance, url: a.url } }),
    },
    {
      name: 'read_text',
      cap: 'read',
      description: 'Read the visible text of a window, optionally scoped to a CSS selector.',
      inputSchema: {
        type: 'object',
        properties: {
          ...INSTANCE_PROP,
          selector: { type: 'string', description: 'Optional CSS selector to scope the text.' },
        },
        required: ['instance'],
        additionalProperties: false,
      },
      call: (a) => ({ method: 'GET', path: '/text' + qs({ instance: a.instance, selector: a.selector }) }),
    },
    {
      name: 'read_console',
      cap: 'inspect',
      description: 'Read recent console output (logs, warnings, errors) from a window to debug page behavior.',
      inputSchema: {
        type: 'object',
        properties: { ...INSTANCE_PROP, limit: { type: 'number', description: 'Max entries to return (default 50, max 200).' } },
        required: ['instance'],
        additionalProperties: false,
      },
      call: (a) => ({ method: 'GET', path: '/console' + qs({ instance: a.instance, limit: a.limit }) }),
    },
    {
      name: 'read_network',
      cap: 'inspect',
      description: 'Read recent network activity (requests, responses, failures) for a window. Set failed=true for only failed requests.',
      inputSchema: {
        type: 'object',
        properties: {
          ...INSTANCE_PROP,
          limit: { type: 'number', description: 'Max entries (default 50, max 200).' },
          failed: { type: 'boolean', description: 'Only failed requests when true.' },
        },
        required: ['instance'],
        additionalProperties: false,
      },
      call: (a) => ({ method: 'GET', path: '/network' + qs({ instance: a.instance, limit: a.limit, failed: a.failed ? 1 : null }) }),
    },
    {
      name: 'page_changes',
      cap: 'read',
      description:
        'Return what visible text was added/removed since the last page_changes call for this window — call it right ' +
        'after an action (click/navigate/type) to see the effect without re-reading the whole page.',
      inputSchema: {
        type: 'object',
        properties: { ...INSTANCE_PROP },
        required: ['instance'],
        additionalProperties: false,
      },
      call: (a) => ({ method: 'GET', path: '/changes' + qs({ instance: a.instance }) }),
    },
    {
      name: 'find_element',
      cap: 'read',
      description:
        'Locate elements on a page by a natural-language description (e.g. "the blue Sign In button"). Returns ' +
        'candidate elements with a CSS selector, visible text, role, and on-screen rectangle; choose the best ' +
        'selector to click or type into.',
      inputSchema: {
        type: 'object',
        properties: {
          ...INSTANCE_PROP,
          query: { type: 'string', description: 'Natural-language description of the element to find.' },
          limit: { type: 'number', description: 'Max candidates (default 8, max 25).' },
        },
        required: ['instance', 'query'],
        additionalProperties: false,
      },
      call: (a) => ({ method: 'GET', path: '/find' + qs({ instance: a.instance, query: a.query, limit: a.limit }) }),
    },
    {
      name: 'click',
      cap: 'interact',
      description: 'Click the first element matching a CSS selector.',
      inputSchema: {
        type: 'object',
        properties: {
          ...INSTANCE_PROP,
          selector: { type: 'string', description: 'CSS selector of the element to click.' },
        },
        required: ['instance', 'selector'],
        additionalProperties: false,
      },
      call: (a) => ({ method: 'POST', path: '/click', body: { instance: a.instance, selector: a.selector } }),
    },
    {
      name: 'type_text',
      cap: 'interact',
      description: 'Type text into the field matching a CSS selector.',
      inputSchema: {
        type: 'object',
        properties: {
          ...INSTANCE_PROP,
          selector: { type: 'string', description: 'CSS selector of the field.' },
          text: { type: 'string', description: 'Text to type.' },
        },
        required: ['instance', 'selector', 'text'],
        additionalProperties: false,
      },
      call: (a) => ({
        method: 'POST',
        path: '/type',
        body: { instance: a.instance, selector: a.selector, text: a.text },
      }),
    },
    {
      name: 'screenshot',
      cap: 'screenshot',
      description: 'Capture a screenshot of a window (returns an image).',
      inputSchema: {
        type: 'object',
        properties: { ...INSTANCE_PROP },
        required: ['instance'],
        additionalProperties: false,
      },
      call: (a) => ({ method: 'GET', path: '/screenshot' + qs({ instance: a.instance }) }),
      // Build a full MCP result (image content block) instead of the default text-JSON
      // wrapping, so the base64 JPEG renders as an image rather than an opaque string.
      transform: (json) => {
        const b64 = json && json.base64;
        if (!b64) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Screenshot response was missing base64 image data.' }],
          };
        }
        const format = (json && json.format) || 'jpeg';
        const mimeType = format.indexOf('/') >= 0 ? format : 'image/' + format;
        return { content: [{ type: 'image', data: b64, mimeType }] };
      },
    },
    {
      name: 'eval',
      cap: 'eval',
      description: 'Evaluate arbitrary JavaScript in a window\'s page context and return the result.',
      inputSchema: {
        type: 'object',
        properties: {
          ...INSTANCE_PROP,
          js: { type: 'string', description: 'JavaScript expression to evaluate.' },
        },
        required: ['instance', 'js'],
        additionalProperties: false,
      },
      call: (a) => ({ method: 'POST', path: '/eval', body: { instance: a.instance, js: a.js } }),
    },
    {
      name: 'create_window',
      cap: 'create_window',
      description: 'Open a new integrated-browser window and return its id.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => ({ method: 'POST', path: '/windows', body: {} }),
    },
    {
      name: 'close_window',
      cap: 'close_window',
      description: 'Close an integrated-browser window.',
      inputSchema: {
        type: 'object',
        properties: { ...INSTANCE_PROP },
        required: ['instance'],
        additionalProperties: false,
      },
      call: (a) => ({ method: 'POST', path: '/window/close', body: { instance: a.instance } }),
    },
    {
      name: 'list_scripts',
      cap: 'run_script',
      description: 'List the named automations available to run_script.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => ({ method: 'GET', path: '/scripts' }),
    },
    {
      name: 'run_script',
      cap: 'run_script',
      description:
        'Run a named automation against a window and return its result. If the automation itself ' +
        'throws, this still succeeds at the tool level and returns {ok:false, status:"error", ' +
        'error}; only a missing automation/instance or a disconnected window is reported as a tool error.',
      inputSchema: {
        type: 'object',
        properties: {
          ...INSTANCE_PROP,
          name: { type: 'string', description: 'Name of the automation to run.' },
        },
        required: ['instance', 'name'],
        additionalProperties: false,
      },
      call: (a) => ({ method: 'POST', path: '/script/run', body: { instance: a.instance, name: a.name } }),
    },
    {
      name: 'scroll',
      cap: 'interact',
      description: "Scroll the page, either by a pixel offset (x/y), to a selector, or to 'top'/'bottom'.",
      inputSchema: {
        type: 'object',
        properties: {
          ...INSTANCE_PROP,
          x: { type: 'number', description: 'Horizontal scroll offset in pixels.' },
          y: { type: 'number', description: 'Vertical scroll offset in pixels.' },
          selector: { type: 'string', description: 'CSS selector to scroll into view.' },
          to: { type: 'string', enum: ['top', 'bottom'], description: "Scroll to 'top' or 'bottom' of the page." },
        },
        required: ['instance'],
        additionalProperties: false,
      },
      call: (a) => ({
        method: 'POST',
        path: '/scroll',
        body: { instance: a.instance, x: a.x, y: a.y, selector: a.selector, to: a.to },
      }),
    },
    {
      name: 'press_key',
      cap: 'interact',
      description: 'Press a key (Enter, Tab, ArrowDown, etc.), optionally focusing a selector first.',
      inputSchema: {
        type: 'object',
        properties: {
          ...INSTANCE_PROP,
          key: { type: 'string', description: "Key to press, e.g. 'Enter', 'Tab', 'ArrowDown'." },
          selector: { type: 'string', description: 'Optional CSS selector to focus before pressing the key.' },
        },
        required: ['instance', 'key'],
        additionalProperties: false,
      },
      call: (a) => ({
        method: 'POST',
        path: '/press',
        body: { instance: a.instance, key: a.key, selector: a.selector },
      }),
    },
    {
      name: 'hover',
      cap: 'interact',
      description: 'Hover the first element matching a CSS selector.',
      inputSchema: {
        type: 'object',
        properties: {
          ...INSTANCE_PROP,
          selector: { type: 'string', description: 'CSS selector of the element to hover.' },
        },
        required: ['instance', 'selector'],
        additionalProperties: false,
      },
      call: (a) => ({ method: 'POST', path: '/hover', body: { instance: a.instance, selector: a.selector } }),
    },
    {
      name: 'wait_for',
      cap: null,
      description:
        "Wait for a selector to appear or the page to finish loading ('load'), bounded by an " +
        'optional timeout in milliseconds.',
      inputSchema: {
        type: 'object',
        properties: {
          ...INSTANCE_PROP,
          selector: { type: 'string', description: 'CSS selector to wait for.' },
          until: { type: 'string', enum: ['load'], description: "Wait for the page 'load' event instead of a selector." },
          timeout: { type: 'number', description: 'Maximum time to wait, in milliseconds.' },
        },
        required: ['instance'],
        additionalProperties: false,
      },
      call: (a) => ({
        method: 'POST',
        path: '/wait',
        body: { instance: a.instance, selector: a.selector, until: a.until, timeout: a.timeout },
      }),
    },
  ];
}

// Static resource catalogue: the two capability-filtered markdown API references the
// extension serves token-exempt at GET /docs/fleet and GET /docs/tab.
const RESOURCES = [
  {
    uri: 'steersman://docs/fleet',
    name: 'Steersman Fleet API',
    description: 'API reference for managing all Project Steersman browser windows',
    mimeType: 'text/markdown',
    path: '/docs/fleet',
  },
  {
    uri: 'steersman://docs/tab',
    name: 'Steersman Tab API',
    description: 'API reference for driving a single browser window',
    mimeType: 'text/markdown',
    path: '/docs/tab',
  },
];
const RESOURCES_BY_URI = new Map(RESOURCES.map((r) => [r.uri, r]));

// Fetch /capabilities: returns { enabled:Set<id>, instructions:string }. On any failure
// we degrade gracefully — no enabled caps (observation-only) and a fallback instruction.
const FALLBACK_INSTRUCTIONS =
  'You are driving VS Code integrated-browser windows via the Project Steersman MCP server. ' +
  'The extension is not reporting capabilities right now, so only window observation tools ' +
  '(list_windows, get_window) are available.';

async function loadCapabilities() {
  try {
    const { status, json } = await apiRequest('GET', '/capabilities');
    if (status < 200 || status >= 300 || !json || !Array.isArray(json.capabilities)) {
      log('GET /capabilities returned status ' + status + '; degrading to observation-only.');
      return { enabled: new Set(), instructions: FALLBACK_INSTRUCTIONS };
    }
    const enabled = new Set(json.capabilities.filter((c) => c && c.enabled).map((c) => c.id));
    const instructions =
      typeof json.composedPreview === 'string' && json.composedPreview
        ? json.composedPreview
        : FALLBACK_INSTRUCTIONS;
    return { enabled, instructions };
  } catch (e) {
    log('extension not reachable (' + e.message + '); degrading to observation-only.');
    return { enabled: new Set(), instructions: FALLBACK_INSTRUCTIONS };
  }
}

async function main() {
  const { enabled, instructions } = await loadCapabilities();
  const readEnabled = enabled.has('read');

  // Register the two always-on observation tools plus any tool whose capability is enabled.
  const tools = makeTools(readEnabled).filter((t) => t.cap === null || enabled.has(t.cap));
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  log('registering tools: ' + tools.map((t) => t.name).join(', '));

  // The composed capability prompt is delivered to the client's model via `instructions`.
  const server = new Server(
    { name: 'project-steersman', version: '0.5.6' },
    { capabilities: { tools: {}, resources: {} }, instructions }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = toolsByName.get(req.params.name);
    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: 'Unknown tool: ' + req.params.name }] };
    }
    const args = req.params.arguments || {};
    try {
      const { method, path, body } = tool.call(args);
      const { status, json } = await apiRequest(method, path, body);
      if (status < 200 || status >= 300) {
        const detail = json && json.error ? json.error : JSON.stringify(json);
        return {
          isError: true,
          content: [{ type: 'text', text: 'HTTP ' + status + ' from ' + path + ': ' + detail }],
        };
      }
      const result = tool.transform ? tool.transform(json) : json;
      // A transform may return a full MCP result envelope (e.g. screenshot's image content
      // block) instead of plain data to be stringified — pass those through as-is.
      if (result && typeof result === 'object' && Array.isArray(result.content)) {
        return result;
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      // A single failed call (e.g. extension down mid-session) must not crash the server.
      return {
        isError: true,
        content: [{ type: 'text', text: tool.name + ' failed: ' + e.message }],
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCES.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const resource = RESOURCES_BY_URI.get(req.params.uri);
    if (!resource) {
      throw new Error('Unknown resource: ' + req.params.uri);
    }
    try {
      const { status, json } = await apiRequest('GET', resource.path);
      if (status < 200 || status >= 300) {
        const detail = json && json.error ? json.error : JSON.stringify(json);
        return {
          contents: [
            {
              uri: resource.uri,
              mimeType: 'text/plain',
              text: 'HTTP ' + status + ' from ' + resource.path + ': ' + detail,
            },
          ],
        };
      }
      // /docs/* responds with raw markdown, which apiRequest's JSON.parse attempt fails on
      // and falls back to { raw: body } for — unwrap that back to the plain markdown text.
      const text = json && typeof json === 'object' && 'raw' in json ? json.raw : JSON.stringify(json);
      return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text }] };
    } catch (e) {
      // Extension unreachable — surface a readable error as the resource body rather than
      // throwing, so a client can still see why the doc is unavailable.
      return {
        contents: [
          { uri: resource.uri, mimeType: 'text/plain', text: 'Failed to fetch ' + resource.path + ': ' + e.message },
        ],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('connected on stdio (extension port ' + PORT + ').');
}

main().catch((e) => {
  log('fatal: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
