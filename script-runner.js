// Saved-script runner. Scans the central scripts dir for top-level .js AND .py files.
// A .js script is evaluated in a session's page context (same CDP path as /eval). A .py
// script runs as a HOST subprocess that drives the tab over the HTTP API (env vars carry
// the URL/instance/token). Either way a running -> done/error status is stamped onto the
// session so the roster (windows()/window()) and the panel can surface it.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Cap on the stringified script result stored/returned, so a chatty script can't bloat
// the roster snapshot or the HTTP response.
const RESULT_MAX = 2048;

// Cap on captured Python stdout/stderr so a chatty/looping subprocess can't bloat memory
// before we truncate for the roster; ~8KB each.
const STDIO_MAX = 8192;

// Wall-clock budget for a Python subprocess before it is SIGKILLed and marked timed out.
const PY_TIMEOUT_MS = 30000;

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
  // ctx: { manager, getScriptsDir: () => string|null, getPort: () => number|null,
  //        getToken: () => string|null, getPython: () => string, log }
  constructor(ctx) {
    this.manager = ctx.manager;
    this.getScriptsDir = ctx.getScriptsDir;
    this.getPort = ctx.getPort;
    this.getToken = ctx.getToken;
    this.getPython = ctx.getPython;
    this.log = ctx.log;
  }

  _dir() {
    return this.getScriptsDir ? this.getScriptsDir() : null;
  }

  // List the .js and .py scripts directly in scripts/ as [{ name, lang }] (name = filename
  // sans extension, lang = 'js'|'py'), sorted by name. A missing folder (or any read error)
  // yields []; subdirectories and other files are ignored. Base names are expected to be
  // unique across languages — if both foo.js and foo.py exist (a pathological collision)
  // BOTH are listed here, but scriptLang/runScript/deleteScript resolve to the .js.
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
      .filter((e) => e.isFile() && (e.name.endsWith('.js') || e.name.endsWith('.py')))
      .map((e) => ({ name: e.name.slice(0, -3), lang: e.name.endsWith('.py') ? 'py' : 'js' }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.lang.localeCompare(b.lang));
  }

  // Resolve which language a base name runs as: 'js' if <name>.js exists (preferred on a
  // collision), else 'py' if <name>.py exists, else null. Used by the HTTP layer to pick
  // the right capability gate before dispatching. Unsafe names resolve to null.
  scriptLang(name) {
    if (!isSafeScriptName(name)) return null;
    const scriptsDir = path.resolve(this._dir() || '');
    for (const lang of ['js', 'py']) {
      const resolved = path.resolve(scriptsDir, name + '.' + lang);
      if (resolved !== path.resolve(scriptsDir, path.basename(resolved))) continue;
      try {
        if (fs.statSync(resolved).isFile()) return lang;
      } catch {
        // not present in this language; try the next
      }
    }
    return null;
  }

  // Run a saved script against a session's tab, dispatching by resolved extension: a
  // <name>.js is evaluated in the page (unchanged); a <name>.py runs as a host subprocess
  // that drives the tab over the HTTP API. Throws tagged errors the HTTP layer maps to 4xx:
  // 'instance not found' (404), 'session not connected' (409), 'script not found' (404).
  // A failure of the script itself (a JS throw, or a non-zero Python exit) is NOT rethrown —
  // it is recorded as status:'error' and returned so the caller can report ok:false.
  async runScript(instance, name) {
    const session = this.manager.get(instance);
    if (!session) throw tagged('instance not found', 'INSTANCE_NOT_FOUND');
    if (!session.tab || session.state !== 'connected') {
      throw tagged('session not connected', 'NOT_CONNECTED');
    }
    if (!isSafeScriptName(name)) throw tagged('script not found', 'SCRIPT_NOT_FOUND');
    const scriptsDir = path.resolve(this._dir() || '');
    // Resolve by extension, preferring .js on a (pathological) base-name collision.
    const lang = this.scriptLang(name);
    if (!lang) throw tagged('script not found', 'SCRIPT_NOT_FOUND');
    // Containment re-check: even with the whitelist above, belt-and-suspenders against
    // path traversal — confirm the resolved path still lands directly inside scriptsDir.
    const resolved = path.resolve(scriptsDir, name + '.' + lang);
    if (resolved !== path.resolve(scriptsDir, path.basename(resolved))) {
      throw tagged('script not found', 'SCRIPT_NOT_FOUND');
    }
    if (lang === 'py') return this._runPython(session, instance, name, resolved, scriptsDir);

    let content;
    try {
      content = fs.readFileSync(resolved, 'utf8');
    } catch {
      throw tagged('script not found', 'SCRIPT_NOT_FOUND');
    }

    const startedAt = Date.now();
    session.script = { name, lang, status: 'running', startedAt };
    try {
      const result = truncate(stringifyResult(await session.tab.evaluate(content)));
      session.script = { name, lang, status: 'done', startedAt, finishedAt: Date.now(), result };
      return { instance, name, lang, status: 'done', result };
    } catch (e) {
      const error = truncate(e && e.message ? e.message : String(e));
      session.script = { name, lang, status: 'error', startedAt, finishedAt: Date.now(), error };
      this.log.appendLine('[Scripts] ' + name + ' on ' + instance + ' errored: ' + error);
      return { instance, name, lang, status: 'error', error };
    }
  }

  // Run scripts/<name>.py as a host subprocess that drives the tab over the HTTP API. The
  // process is spawned with an ARGS ARRAY (no shell, so `name`/paths are never interpolated
  // into a command line) and given the API URL/instance/token via env. stdout/stderr are
  // capped (~8KB each) and a wall-clock timeout SIGKILLs a runaway process. Resolves to a
  // clean result object for every outcome — a spawn failure (e.g. python missing -> ENOENT)
  // is caught and returned as status:'error', never thrown. The token travels via env only
  // and is NEVER written to a log or included in any error message.
  _runPython(session, instance, name, scriptPath, scriptsDir) {
    const startedAt = Date.now();
    session.script = { name, lang: 'py', status: 'running', startedAt };
    const port = this.getPort ? this.getPort() : null;
    const token = this.getToken ? this.getToken() : null;
    const pythonCmd = (this.getPython && this.getPython()) || 'python3';
    const env = {
      ...process.env,
      STEERSMAN_URL: 'http://localhost:' + port,
      STEERSMAN_INSTANCE: instance,
      STEERSMAN_TOKEN: token || '',
    };

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(pythonCmd, [scriptPath], { env, cwd: scriptsDir });
      } catch (e) {
        // Synchronous spawn failure (rare); treat like an async 'error' event.
        const error = 'failed to start python: ' + (e && e.message ? e.message : String(e));
        session.script = { name, lang: 'py', status: 'error', startedAt, finishedAt: Date.now(), error };
        this.log.appendLine('[Scripts] ' + name + ' on ' + instance + ' failed to start: ' + error);
        return resolve({ instance, name, lang: 'py', status: 'error', error });
      }

      let out = '';
      let err = '';
      let timedOut = false;
      let settled = false;
      const cap = (buf, chunk) => (buf.length >= STDIO_MAX ? buf : (buf + chunk).slice(0, STDIO_MAX));

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, PY_TIMEOUT_MS);

      const finishError = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.script = { name, lang: 'py', status: 'error', startedAt, finishedAt: Date.now(), error };
        this.log.appendLine('[Scripts] ' + name + ' on ' + instance + ' errored: ' + error);
        resolve({ instance, name, lang: 'py', status: 'error', error });
      };

      if (child.stdout) child.stdout.on('data', (d) => { out = cap(out, d.toString()); });
      if (child.stderr) child.stderr.on('data', (d) => { err = cap(err, d.toString()); });

      // ENOENT (python not found) and other spawn errors surface here, not as an exception.
      child.on('error', (e) => {
        const msg = e && e.code === 'ENOENT'
          ? 'python not found: ' + pythonCmd
          : 'python failed: ' + (e && e.message ? e.message : String(e));
        finishError(truncate(msg));
      });

      child.on('close', (code) => {
        if (settled) return;
        if (timedOut) return finishError('timed out after ' + PY_TIMEOUT_MS + 'ms');
        if (code === 0) {
          settled = true;
          clearTimeout(timer);
          const result = truncate(out.trim());
          session.script = { name, lang: 'py', status: 'done', startedAt, finishedAt: Date.now(), result };
          return resolve({ instance, name, lang: 'py', status: 'done', result });
        }
        // Non-zero exit: include a short stderr tail (never env/token) for diagnosis.
        const tail = err.trim().slice(-500);
        finishError(truncate('exited with code ' + code + (tail ? ': ' + tail : '')));
      });
    });
  }

  // Delete the saved script for a base name from the central dir, resolving <name>.js or
  // <name>.py the same way runScript does (preferring .js on a collision — the .py is left
  // behind, matching the "keep base names unique across languages" expectation). Same
  // two-layer path-traversal guard as runScript (whitelist + containment re-check); an unsafe
  // name throws SCRIPT_NOT_FOUND (the HTTP layer maps it to 404), matching runScript's error
  // style. A file that is already gone is treated as success (idempotent delete), so
  // re-deleting never throws an unhandled error.
  deleteScript(name) {
    if (!isSafeScriptName(name)) throw tagged('script not found', 'SCRIPT_NOT_FOUND');
    const scriptsDir = path.resolve(this._dir() || '');
    const lang = this.scriptLang(name) || 'js';
    const resolved = path.resolve(scriptsDir, name + '.' + lang);
    if (resolved !== path.resolve(scriptsDir, path.basename(resolved))) {
      throw tagged('script not found', 'SCRIPT_NOT_FOUND');
    }
    try {
      fs.unlinkSync(resolved);
    } catch (e) {
      if (e && e.code === 'ENOENT') return { name, deleted: false, status: 'not found' };
      throw tagged('script not found', 'SCRIPT_NOT_FOUND');
    }
    this.log.appendLine('[Scripts] deleted ' + name);
    return { name, deleted: true, status: 'deleted' };
  }
}

module.exports = { ScriptRunner };
