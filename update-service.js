// Host-level self-update core (shared by the manual Settings badge and the automatic
// background check). This module owns the reusable heavy lifting that used to live inside
// panel.js: the GitHub release/tag version check, the 3-tier git-checkout resolver, and the
// `build/reinstall.sh` reinstall pipeline. panel.js keeps ONLY the webview status-reporting
// (`_post`) and delegates the work here, so both surfaces run one implementation and share a
// single `updating` guard — a timer tick, a manual badge click, and a pending "Update Now"
// notification can never launch two concurrent reinstalls. Ported from ResourceMonitor's
// UpdateService model: auto-CHECK is silent (every failure swallowed to the log, never a
// toast); auto-APPLY is opt-in. Mirrors sibling-module style (bridge-store.js/cookie-store.js).

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// GitHub repo backing the update check; the host does the GitHub release lookup because the
// webview can't fetch external URLs under its CSP.
const REPO = 'lxRbckl/Project-Steersman';
// SecretStorage key for the optional GitHub token used to authenticate the update-check against
// a private repo. Same flat key panel.js's manual token prompt writes, so a token saved through
// the Settings badge authenticates the auto-check too. Host-side only; NEVER logged.
const GITHUB_TOKEN_SECRET_KEY = 'steersman.updateCheck.githubToken';
// Pinned GitHub REST API version (recommended alongside the vnd.github+json Accept header).
const GITHUB_API_VERSION = '2022-11-28';
// OutputChannel name that streams the reinstall script's live logs + swallowed background errors.
const OUTPUT_CHANNEL_NAME = 'Project Steersman Update';

// POSIX single-quote a shell argument so a path with spaces/metacharacters survives the
// `bash -lc "..."` wrapper intact. Bare word when it's already shell-safe.
function shellQuote(arg) {
  if (/^[A-Za-z0-9_/.,:=@%+-]+$/.test(arg)) { return arg; }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

class AutoUpdateService {
  // deps: { extensionUri, version (installed package.json version), secrets (SecretStorage for
  //         the optional GitHub token), log (main OutputChannel), context (optional, unused) }
  constructor(deps) {
    const d = deps || {};
    this._extensionUri = d.extensionUri || null;
    this._version = d.version || null;
    this._secrets = d.secrets || null;
    this._log = d.log || null;
    this._context = d.context || null;
    // Single cross-surface guard: set at the top of runReinstall() (synchronously, before any
    // await) and cleared in its finally, so the manual badge + a timer tick + a pending
    // notification all serialize on one flag.
    this._updating = false;
    // Dedicated OutputChannel, created lazily once and reused (repeated updates don't leak
    // channels). Streams reinstall output and receives swallowed background-check log lines.
    this._channel = null;
  }

  // Whether a reinstall is currently in flight (read by autoCheckForUpdate before it shows a
  // notification, and again after the notification resolves).
  get updating() {
    return this._updating;
  }

  // Lazily create + return the dedicated update OutputChannel (panel.js reveals it via
  // getChannel().show() for its manual "Show Log" action).
  getChannel() {
    if (!this._channel) {
      this._channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    }
    return this._channel;
  }

  // Guarded append to the main log (used for swallowed background-check diagnostics). Never throws.
  _logLine(line) {
    try { if (this._log) this._log.appendLine(line); } catch { /* ignore */ }
  }

  // ---- Version check (GitHub) ----

  // Read the stored GitHub token from SecretStorage. Returns null when none is set, when
  // SecretStorage is unavailable, or on any read error — never throws, never logs the value.
  async _getToken() {
    if (!this._secrets) { return null; }
    try {
      const v = await this._secrets.get(GITHUB_TOKEN_SECRET_KEY);
      return v || null;
    } catch {
      return null;
    }
  }

  // Check GitHub for the latest published version and return a rich verdict object the manual
  // badge posts verbatim and the auto-check reads `updateAvailable` from. Behaviour is identical
  // to panel.js's former `_checkForUpdate` core — every `_post(...)` there is a `return` here.
  // Success -> { current, latest, upToDate, updateAvailable, releasesUrl }. Failure -> a short
  // { current, error } (never a throw): 'offline' (network/timeout), 'check failed' (bad body /
  // unexpected status / non-numeric tag), 'no releases found' (no release AND no tag visible),
  // 'rate limited — try later', or 'auth failed — check token'. Bounded by a 6s AbortController.
  async checkLatest() {
    const current = this._version || '0.0.0';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const headers = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'project-steersman',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    };
    // Authenticate when the operator has stored a token (needed for a private repo). Attached to
    // the header here and never logged; absent, the check stays anonymous and degrades to an
    // honest 'no releases found' rather than a false success.
    const token = await this._getToken();
    if (token) { headers['Authorization'] = 'Bearer ' + token; }
    try {
      let latest = null;
      let releasesUrl = `https://github.com/${REPO}/releases`;
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers,
        signal: controller.signal,
      });
      if (res.ok) {
        // Parsing/shape failures here (bad JSON, missing tag_name) are a bad API response, not a
        // network problem — report 'check failed', not 'offline'.
        try {
          const data = await res.json();
          const tag = typeof data.tag_name === 'string' ? data.tag_name : '';
          latest = tag.replace(/^v/, '').trim();
          if (data.html_url) { releasesUrl = data.html_url; }
        } catch (e) {
          this._logLine('[Update] checkForUpdate: malformed response body: ' + (e && e.message ? e.message : e));
          return { current, error: 'check failed' };
        }
      } else if (res.status === 404) {
        // No published GitHub *Release* — but this project ships versions as git *tags*
        // (the vX.Y.Z tags), so fall back to the newest tag before giving up; a tag-only repo
        // is the normal case here, not a failure.
        this._logLine('[Update] checkForUpdate: releases/latest returned 404 — falling back to tags');
        latest = await this._fetchLatestTag(headers, controller.signal);
        if (latest == null) {
          this._logLine('[Update] checkForUpdate: no releases or tags visible for ' + REPO + ' (private repo or no tags?)');
          return { current, error: 'no releases found' };
        }
      } else if (res.status === 401 || res.status === 403) {
        // Distinguish a bad/insufficient/expired token (auth) from an exhausted rate limit:
        // GitHub sends x-ratelimit-remaining: 0 on rate-limit 403s. The token value is never
        // logged, only whether one was present.
        const remaining = res.headers.get('x-ratelimit-remaining');
        const rateLimited = res.status === 403 && remaining === '0';
        const err = rateLimited ? 'rate limited — try later' : 'auth failed — check token';
        this._logLine('[Update] checkForUpdate: GitHub ' + res.status +
          (rateLimited ? ' rate-limit exhausted' : ' auth/forbidden') +
          ' (x-ratelimit-remaining=' + (remaining == null ? 'n/a' : remaining) +
          ', token ' + (token ? 'present' : 'absent') + ')');
        return { current, error: err };
      } else {
        this._logLine('[Update] checkForUpdate: GitHub returned ' + res.status);
        return { current, error: 'check failed' };
      }
      // Reject anything that isn't a plain dotted-numeric version (e.g. 'nightly', 'release-1')
      // before comparing, so a bad tag never renders a garbage verdict.
      if (!/^\d+(\.\d+)*$/.test(latest)) {
        return { current, error: 'check failed' };
      }
      const cmp = this._compareSemver(latest, current);
      return {
        current,
        latest,
        upToDate: cmp <= 0,
        updateAvailable: cmp > 0,
        releasesUrl,
      };
    } catch (e) {
      this._logLine('[Update] checkForUpdate failed: ' + (e && e.message ? e.message : e));
      return { current, error: 'offline' };
    } finally {
      clearTimeout(timer);
    }
  }

  // Fallback for repos that publish versions as git tags without cutting GitHub Releases: fetch
  // the tag list and return the highest plain dotted-numeric tag (leading "v" stripped), or null
  // if the list is unreachable/empty. A network error throws and bubbles to checkLatest's catch.
  async _fetchLatestTag(headers, signal) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/tags`, { headers, signal });
    if (!res.ok) {
      this._logLine('[Update] checkForUpdate: tags lookup returned ' + res.status);
      return null;
    }
    const tags = await res.json();
    if (!Array.isArray(tags)) { return null; }
    let best = null;
    for (const t of tags) {
      const name = t && typeof t.name === 'string' ? t.name.replace(/^v/, '').trim() : '';
      if (!/^\d+(\.\d+)*$/.test(name)) { continue; }
      if (best == null || this._compareSemver(name, best) > 0) { best = name; }
    }
    return best;
  }

  // Numeric, part-by-part semver compare (missing trailing parts treated as 0). Positive when
  // a > b, negative when a < b, 0 when equal — plain ints, never NaN (a non-numeric part is 0).
  _compareSemver(a, b) {
    const pa = String(a).split('.');
    const pb = String(b).split('.');
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const na = parseInt(pa[i], 10) || 0;
      const nb = parseInt(pb[i], 10) || 0;
      if (na !== nb) return na - nb;
    }
    return 0;
  }

  // ---- Repo resolution ----

  // Resolve the Project-Steersman git checkout the reinstall pipeline runs from. Order:
  // (a) an explicit projectSteersman.repoPath setting pointing at a clone; else (b) an open
  // workspace folder that IS the Project-Steersman clone (`.git` AND a package.json whose name
  // is 'project-steersman', so an unrelated git workspace is never pulled+reinstalled); else
  // (c) this extension's own install path when it is itself a source checkout (`.git` +
  // `extension.js` at the root). Returns an absolute path or null. Reading an undeclared config
  // key is fine — getConfiguration returns the default ('') for it. Never throws.
  resolveRepoRoot() {
    let configured = '';
    try {
      configured = (vscode.workspace.getConfiguration('projectSteersman').get('repoPath', '') || '').trim();
    } catch { configured = ''; }
    if (configured && fs.existsSync(path.join(configured, '.git'))) {
      return configured;
    }
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length) {
      for (const folder of folders) {
        const folderPath = folder && folder.uri && folder.uri.fsPath;
        if (!folderPath || !fs.existsSync(path.join(folderPath, '.git'))) { continue; }
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(folderPath, 'package.json'), 'utf8'));
          if (pkg && pkg.name === 'project-steersman') {
            return folderPath;
          }
        } catch { /* malformed/missing package.json — skip this folder */ }
      }
    }
    const extPath = this._extensionUri && this._extensionUri.fsPath;
    if (extPath &&
        fs.existsSync(path.join(extPath, '.git')) &&
        fs.existsSync(path.join(extPath, 'extension.js'))) {
      return extPath;
    }
    return null;
  }

  // ---- Reinstall pipeline (build/reinstall.sh) ----

  // Run the local git-based reinstall pipeline (build/reinstall.sh) under a `bash -lc` LOGIN
  // shell so the operator's interactive PATH (nvm node/npm, vsce, `code`) is present — the
  // extension-host PATH is not. Output streams to the dedicated OutputChannel; the
  // ALREADY_UP_TO_DATE / "[steersman] Installed:" markers drive the parsed result. The single
  // `updating` guard is claimed synchronously at the top and released in finally. This is the
  // shared primitive: it returns a structured status and shows NO completion toasts — each
  // caller (manual badge vs. background auto-apply) owns its own UX. `onStatus` is an optional
  // hook the manual badge uses to post a 'running' status to its webview mid-flight.
  // Returns one of:
  //   { status: 'busy' }                          — a reinstall is already in flight
  //   { status: 'noRepo' }                        — no Project-Steersman checkout resolved
  //   { status: 'scriptMissing', scriptPath }     — reinstall.sh not found at the checkout
  //   { status: 'upToDate', current }             — script reported ALREADY_UP_TO_DATE
  //   { status: 'installed', version }            — install succeeded (parsed new version)
  //   { status: 'error', error, exitCode? }       — non-zero exit (exitCode set) or spawn failure
  async runReinstall(opts) {
    const onStatus = opts && typeof opts.onStatus === 'function' ? opts.onStatus : null;
    if (this._updating) { return { status: 'busy' }; }
    const repoRoot = this.resolveRepoRoot();
    const channel = this.getChannel();
    if (!repoRoot) {
      channel.appendLine('[Update] selfUpdate: could not locate a Project-Steersman git checkout.');
      channel.appendLine('[Update] Set "projectSteersman.repoPath" to the absolute path of your clone, then try again.');
      channel.show(true);
      return { status: 'noRepo' };
    }
    const scriptPath = path.join(repoRoot, 'build', 'reinstall.sh');
    if (!fs.existsSync(scriptPath)) {
      channel.appendLine('[Update] selfUpdate: update script not found at ' + scriptPath);
      channel.show(true);
      return { status: 'scriptMissing', scriptPath };
    }

    // Claim the guard synchronously (no await between the check above and here), then start.
    this._updating = true;
    channel.clear();
    channel.show(true);
    if (onStatus) { try { onStatus({ status: 'running' }); } catch { /* ignore */ } }
    try {
      let buffer = '';
      const exitCode = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Updating Project Steersman…', cancellable: false },
        () => new Promise((resolve, reject) => {
          // `bash -lc` gives the operator's login PATH; the inner `bash <script>` runs the
          // pipeline. STEERSMAN_INSTALLED_VERSION lets the script decide whether the
          // currently-installed build already matches upstream.
          const child = spawn('bash', ['-lc', `bash ${shellQuote(scriptPath)}`], {
            cwd: repoRoot,
            env: { ...process.env, STEERSMAN_INSTALLED_VERSION: this._version || '' },
          });
          child.stdout.on('data', (chunk) => { const t = chunk.toString(); buffer += t; channel.append(t); });
          child.stderr.on('data', (chunk) => { const t = chunk.toString(); buffer += t; channel.append(t); });
          child.on('error', (err) => reject(err));
          child.on('close', (code) => resolve(code == null ? 0 : code));
        })
      );

      if (/\bALREADY_UP_TO_DATE\b/.test(buffer)) {
        return { status: 'upToDate', current: this._version || null };
      }
      if (exitCode === 0) {
        const m = buffer.match(/\[steersman\]\s+Installed:\s+project-steersman v(\S+)/i);
        const installedVersion = m ? m[1] : 'latest';
        return { status: 'installed', version: installedVersion };
      }
      return { status: 'error', error: 'exit ' + exitCode, exitCode };
    } catch (e) {
      const reason = (e && e.message) ? e.message : String(e);
      channel.appendLine('[Update] selfUpdate: spawn failed: ' + reason);
      return { status: 'error', error: reason };
    } finally {
      this._updating = false;
    }
  }

  // Background install path: run the shared reinstall primitive and, ONLY on a successful
  // install, offer a modal reload (VS Code has no single-extension restart API). Every other
  // outcome (busy / noRepo / scriptMissing / upToDate / error) is swallowed to the log so the
  // automatic path never surprises the operator with a failure toast. The `updating` guard is
  // owned by runReinstall(); this method is entered only after autoCheckForUpdate() has already
  // confirmed the guard is free.
  async installAndReload() {
    const result = await this.runReinstall();
    if (result.status === 'installed') {
      const choice = await vscode.window.showInformationMessage(
        `Project Steersman updated to v${result.version}. Reload window to activate?`,
        { modal: true },
        'Reload Window', 'Later'
      );
      if (choice === 'Reload Window') {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
      return;
    }
    this._logLine('[Update] auto-apply result: ' + result.status + (result.error ? ' (' + result.error + ')' : ''));
  }

  // ---- Automatic background check (the timer entry point) ----

  // Silent update check invoked by the extension-host timers. Checks GitHub; when (and only
  // when) a strictly-newer version is available it either applies directly (autoApplyUpdates on)
  // or shows a NON-MODAL "Update Now / Later" notification and installs on "Update Now". Every
  // failure path is swallowed (logged, never a toast) so startup/ticks never interrupt the
  // operator. Re-checks the `updating` guard after the notification resolves (a manual update may
  // have started while it sat open). Never throws.
  async autoCheckForUpdate() {
    try {
      // An install already running (manual badge, or an overlapping tick) — don't stack.
      if (this._updating) { return; }

      const result = await this.checkLatest();
      if (!result || result.error || !result.updateAvailable) {
        if (result && result.error) {
          this._logLine('[Update] auto-check skipped: ' + result.error);
        }
        return;
      }

      const autoApply = vscode.workspace.getConfiguration('projectSteersman').get('autoApplyUpdates', false);
      if (autoApply) {
        await this.installAndReload();
        return;
      }

      const choice = await vscode.window.showInformationMessage(
        `Project Steersman v${result.latest} is available — you have v${result.current}.`,
        'Update Now', 'Later'
      );
      if (choice !== 'Update Now') { return; }

      // The notification may have sat open while a manual update started; re-check the guard.
      if (this._updating) { return; }
      await this.installAndReload();
    } catch (e) {
      // Belt-and-braces: the automatic path must never surface an error toast.
      this._logLine('[Update] auto-check failed: ' + (e && e.message ? e.message : e));
    }
  }
}

module.exports = { AutoUpdateService };
