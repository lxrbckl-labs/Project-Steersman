// Saved-script runner. Scans <workspaceRoot>/scripts/ for top-level .js files and
// evaluates a chosen script's body in a session's page context (same CDP path as /eval),
// stamping a running -> done/error status onto the session so the roster (windows()/
// window()) and the panel can surface it.

const fs = require('fs');
const path = require('path');

// Cap on the stringified script result stored/returned, so a chatty script can't bloat
// the roster snapshot or the HTTP response.
const RESULT_MAX = 2048;

function stringifyResult(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function truncate(str) {
  return str.length > RESULT_MAX ? str.slice(0, RESULT_MAX) + '… [truncated]' : str;
}

// Tag an error with a code the HTTP layer maps to a status (404/409).
function tagged(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Whitelist for script names: letters, digits, dot, underscore, hyphen — no path
// separators (either OS's), no '..', no leading dot (blocks dotfiles). This is the
// first of two layers guarding against path traversal via a malicious/injected `name`.
const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;

function isSafeScriptName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.startsWith('.')) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  if (name.indexOf('\0') !== -1) return false;
  return SAFE_NAME_RE.test(name);
}

class ScriptRunner {
  // ctx: { manager, getScriptsDir: () => string|null, log }
  constructor(ctx) {
    this.manager = ctx.manager;
    this.getScriptsDir = ctx.getScriptsDir;
    this.log = ctx.log;
  }

  _dir() {
    return this.getScriptsDir ? this.getScriptsDir() : null;
  }

  // List the .js scripts directly in scripts/ as [{ name }] (name = filename sans .js),
  // sorted. A missing folder (or any read error) yields []; subdirectories and non-.js
  // files are ignored.
  listScripts() {
    const dir = this._dir();
    if (!dir) return [];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.js'))
      .map((e) => ({ name: e.name.slice(0, -3) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Run scripts/<name>.js against a session's tab. Throws tagged errors the HTTP layer
  // maps to 4xx: 'instance not found' (404), 'session not connected' (409), 'script not
  // found' (404). A throw from the script itself is NOT rethrown — it is recorded as
  // status:'error' and returned so the caller can report ok:false (the script did run).
  async runScript(instance, name) {
    const session = this.manager.get(instance);
    if (!session) throw tagged('instance not found', 'INSTANCE_NOT_FOUND');
    if (!session.tab || session.state !== 'connected') {
      throw tagged('session not connected', 'NOT_CONNECTED');
    }
    const dir = this._dir();
    if (!isSafeScriptName(name)) throw tagged('script not found', 'SCRIPT_NOT_FOUND');
    // Containment re-check: even with the whitelist above, belt-and-suspenders against
    // path traversal — confirm the resolved path still lands directly inside scriptsDir.
    const scriptsDir = path.resolve(dir || '');
    const resolved = path.resolve(scriptsDir, name + '.js');
    if (resolved !== path.resolve(scriptsDir, path.basename(resolved))) {
      throw tagged('script not found', 'SCRIPT_NOT_FOUND');
    }
    let content;
    try {
      content = fs.readFileSync(resolved, 'utf8');
    } catch {
      throw tagged('script not found', 'SCRIPT_NOT_FOUND');
    }

    const startedAt = Date.now();
    session.script = { name, status: 'running', startedAt };
    try {
      const result = truncate(stringifyResult(await session.tab.evaluate(content)));
      session.script = { name, status: 'done', startedAt, finishedAt: Date.now(), result };
      return { instance, name, status: 'done', result };
    } catch (e) {
      const error = truncate(e && e.message ? e.message : String(e));
      session.script = { name, status: 'error', startedAt, finishedAt: Date.now(), error };
      this.log.appendLine('[Scripts] ' + name + ' on ' + instance + ' errored: ' + error);
      return { instance, name, status: 'error', error };
    }
  }
}

module.exports = { ScriptRunner };
