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
} = require('@modelcontextprotocol/sdk/types.js');

const HOST = '127.0.0.1';

// stderr-only logger (never stdout — see file header). Never pass the auth token here.
function log(msg) {
  process.stderr.write('[MCP] ' + msg + '\n');
}

// Resolve the extension's HTTP port + loopback auth token from the shared instance
// registry that extension.js writes (~/.project-steersman/instances/<id>.json, each
// { port, workspace, pid, token }). Resolution: if STEERSMAN_PORT is set, pick the entry
// whose port matches; else if exactly one instance is registered, use it; else fall back
// to the STEERSMAN_PORT/STEERSMAN_TOKEN env vars. Never throws — a missing token just
// means calls will 401 and surface as tool errors.
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
  if (envPort != null) {
    chosen = entries.find((e) => Number(e.port) === envPort) || null;
  } else if (entries.length === 1) {
    chosen = entries[0];
  }
  const port = chosen && chosen.port != null ? chosen.port : envPort != null ? envPort : 3788;
  const token = (chosen && chosen.token) || process.env.STEERSMAN_TOKEN || null;
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
      description: 'List the named scripts available to run_script.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => ({ method: 'GET', path: '/scripts' }),
    },
    {
      name: 'run_script',
      cap: 'run_script',
      description:
        'Run a named script against a window and return its result. If the script itself ' +
        'throws, this still succeeds at the tool level and returns {ok:false, status:"error", ' +
        'error}; only a missing script/instance or a disconnected window is reported as a tool error.',
      inputSchema: {
        type: 'object',
        properties: {
          ...INSTANCE_PROP,
          name: { type: 'string', description: 'Name of the script to run.' },
        },
        required: ['instance', 'name'],
        additionalProperties: false,
      },
      call: (a) => ({ method: 'POST', path: '/script/run', body: { instance: a.instance, name: a.name } }),
    },
  ];
}

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
    { name: 'project-steersman', version: '0.0.1' },
    { capabilities: { tools: {} }, instructions }
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('connected on stdio (extension port ' + PORT + ').');
}

main().catch((e) => {
  log('fatal: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
