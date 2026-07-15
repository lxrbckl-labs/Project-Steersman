/*
 * EnhanceJira — Steersman in-page module (P0 + P1: board-coloring vertical slice)
 * ============================================================================
 *
 * This is the JS BODY for a Steersman "Extension" record. Project Steersman
 * wraps it as `(function (steersman) { <this file> })` and runs it in an
 * ISOLATED world at document-start of each Jira navigation. The isolated world
 * shares the page DOM (so we can read/paint Jira's board) but NOT the page's JS
 * globals, and it cannot be reached by Jira's own scripts.
 *
 * It is a single-context PORT of the EnhanceJira Chrome MV3 extension. Three
 * MV3 contexts collapse into this one file:
 *   - service worker  → the "data service" section below
 *   - content script  → the "board engine" + "coloring orchestrator" sections
 *   - message bus      → GONE (direct function calls; no runtime.sendMessage)
 *
 * Ported (see per-section headers for the exact EnhanceJira source file:line):
 *   - lib/coloring.ts               → deriveCardStateForPR / aggregateCardState
 *   - lib/bitbucket.ts              → canonicalizeIdentity / isReviewerAllowed
 *   - entrypoints/background/bitbucket.ts → mapReviewer, dev-status linkage,
 *                                     PR-detail fetch, throttle, SWR cache,
 *                                     inflight coalesce, getPRState
 *   - entrypoints/content/board.ts  → SELECTORS + board/column/card helpers
 *   - entrypoints/content/observer.ts → board watcher + fast-path repaint
 *   - entrypoints/content/coloring.ts → recolor orchestrator + refresh loop
 *   - entrypoints/content/style.ts  → injected <style> + palette CSS vars
 *   - entrypoints/content/state.ts  → per-key CardState cache (merged in)
 *
 * ORIGIN SPLIT (the crux of the port):
 *   - Jira REST v3 + dev-status calls are SAME-ORIGIN (atlassian.net, session
 *     cookie) → plain in-page fetch(url, { credentials: 'include' }). No bridge.
 *   - api.bitbucket.org PR-detail is CROSS-ORIGIN + Basic auth → steersman.fetch
 *     with host-side auth (`auth: { type:'basic', secretRef, username }`) so the
 *     token NEVER enters page/isolated-world JS.
 *
 * DEFERRED (not in this slice): branch-scan fallback (P2), hover enrichment
 *   (branchHoverCard, P3), settings panel, diagnostics, export/import.
 *
 * ── CONFIG KEYS ─────────────────────────────────────────────────────────────
 *   steersman.storage 'settings'   → {
 *       workspaceSlug: string,          // (only used by P2 scan; harmless now)
 *       minApprovals:  number,          // green-gate threshold (default 2)
 *       approvers:     [{ username, isRequired, isHidden }],
 *       colors:        { green, yellow, red }   // hex; yellow unused for paint
 *   }
 *   steersman.storage 'bbUsername' → string   // Bitbucket username (NON-secret)
 *   steersman.secrets 'bbToken'    → string   // Bitbucket app-password / API
 *                                             // token (secret; host-side only)
 *
 *   The token value is NEVER read by this module. Host-side auth reads it from
 *   the keychain via `secretRef:'bbToken'`. We gate "connected" purely on the
 *   presence of a non-secret `bbUsername`.
 *
 * ── SEED FOR TESTING (settings panel not built yet) ─────────────────────────
 *   Temporarily paste this async IIFE at the TOP of this module body, reload the
 *   Jira tab once so it runs, then DELETE it:
 *
 *     (async function () {
 *       await steersman.storage.set('bbUsername', 'YOUR_BB_USERNAME');
 *       await steersman.secrets.set('bbToken', 'YOUR_BB_APP_PASSWORD');
 *       await steersman.storage.set('settings', {
 *         workspaceSlug: 'YOUR_WORKSPACE_SLUG',
 *         minApprovals: 2,
 *         approvers: [],
 *         colors: { green: '#166534', yellow: '#854d0e', red: '#991b1b' },
 *       });
 *       console.log('[EnhanceJira] seeded config');
 *     })();
 */

(function () {
  'use strict';

  // Bridge handle. `steersman` is the injected wrapper parameter in production;
  // guard defensively so the module is inert (rather than throwing) if it is
  // ever run without the bridge.
  var S = typeof steersman !== 'undefined' && steersman ? steersman : null;
  if (!S || !S.fetch || !S.storage) {
    try {
      console.warn('[EnhanceJira] steersman bridge unavailable — module inert');
    } catch (e) {}
    return;
  }

  var LOG_PREFIX = '[EnhanceJira]';
  var DEBUG = false; // flip to true for verbose per-card logging
  function log() {
    if (!DEBUG) return;
    try {
      console.log.apply(console, [LOG_PREFIX].concat([].slice.call(arguments)));
    } catch (e) {}
  }
  function logInfo() {
    try {
      console.log.apply(console, [LOG_PREFIX].concat([].slice.call(arguments)));
    } catch (e) {}
  }
  function logError() {
    try {
      console.error.apply(console, [LOG_PREFIX].concat([].slice.call(arguments)));
    } catch (e) {}
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CONFIG  (was lib/settings.ts — trimmed to what the coloring slice needs)
  // ───────────────────────────────────────────────────────────────────────────

  // Tailwind-800 defaults, kept in sync with EnhanceJira lib/settings.ts
  // DEFAULT_SETTINGS.colors + entrypoints/content/style.ts DEFAULT_COLORS.
  var DEFAULT_COLORS = { green: '#166534', yellow: '#854d0e', red: '#991b1b' };
  var DEFAULT_MIN_APPROVALS = 2;

  function defaultSettings() {
    return {
      workspaceSlug: '',
      minApprovals: DEFAULT_MIN_APPROVALS,
      approvers: [],
      colors: { green: DEFAULT_COLORS.green, yellow: DEFAULT_COLORS.yellow, red: DEFAULT_COLORS.red },
    };
  }

  // Lenient merge of a stored settings blob onto defaults (mirrors the shape
  // guards in lib/settings.ts mergeSettings/sanitizeApprovers, minus the schema
  // migration — the settings panel will own the canonical write later).
  function mergeSettings(stored) {
    var out = defaultSettings();
    if (!stored || typeof stored !== 'object') return out;
    if (typeof stored.workspaceSlug === 'string') out.workspaceSlug = stored.workspaceSlug;
    if (typeof stored.minApprovals === 'number' && isFinite(stored.minApprovals)) {
      out.minApprovals = stored.minApprovals;
    }
    if (Array.isArray(stored.approvers)) {
      var seen = {};
      var list = [];
      for (var i = 0; i < stored.approvers.length; i++) {
        var r = stored.approvers[i];
        if (!r || typeof r !== 'object') continue;
        if (typeof r.username !== 'string' || r.username.length === 0) continue;
        var key = r.username.toLowerCase();
        if (seen[key]) continue;
        seen[key] = true;
        list.push({
          username: r.username,
          isRequired: r.isRequired === true,
          isHidden: r.isHidden === true,
        });
      }
      out.approvers = list;
    }
    if (stored.colors && typeof stored.colors === 'object') {
      if (typeof stored.colors.green === 'string') out.colors.green = stored.colors.green;
      if (typeof stored.colors.yellow === 'string') out.colors.yellow = stored.colors.yellow;
      if (typeof stored.colors.red === 'string') out.colors.red = stored.colors.red;
    }
    return out;
  }

  // Live config snapshot. Refreshed at boot and on every visibility-gated
  // refresh tick (steersman.storage has no change event in this slice, so we
  // re-read rather than subscribe; changes take effect within one refresh
  // interval or on reload).
  var CONFIG = { settings: defaultSettings(), bbUsername: '', connected: false };

  function loadConfig() {
    return Promise.all([
      S.storage.get('settings').catch(function () { return null; }),
      S.storage.get('bbUsername').catch(function () { return null; }),
    ]).then(function (vals) {
      var settings = mergeSettings(vals[0]);
      var bbUsername = typeof vals[1] === 'string' ? vals[1].trim() : '';
      CONFIG = { settings: settings, bbUsername: bbUsername, connected: bbUsername.length > 0 };
      return CONFIG;
    });
  }

  // Host-side Basic auth descriptor for api.bitbucket.org. The token is read by
  // the host from SecretStorage via `secretRef` — it is never present here.
  function bbAuth() {
    return { type: 'basic', secretRef: 'bbToken', username: CONFIG.bbUsername };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PURE LOGIC  (ported verbatim; no DOM, no I/O)
  // ───────────────────────────────────────────────────────────────────────────

  // lib/bitbucket.ts:45 canonicalizeIdentity
  function canonicalizeIdentity(s) {
    var t = String(s).trim().toLowerCase();
    return t.charAt(0) === '{' && t.charAt(t.length - 1) === '}' ? t.slice(1, -1) : t;
  }

  // lib/bitbucket.ts:57 isReviewerAllowed
  function isReviewerAllowed(r, allowed) {
    if (allowed.size === 0) return true;
    if (r.username && allowed.has(canonicalizeIdentity(r.username))) return true;
    if (r.uuid && allowed.has(canonicalizeIdentity(r.uuid))) return true;
    if (r.displayName && allowed.has(canonicalizeIdentity(r.displayName))) return true;
    return false;
  }

  // lib/coloring.ts:43 deriveCardStateForPR
  function deriveCardStateForPR(pr, settings) {
    var reviewers = pr.reviewers;
    for (var i = 0; i < reviewers.length; i++) {
      if (reviewers[i].changesRequested) return 'red';
    }
    var approvedCount = 0;
    for (var j = 0; j < reviewers.length; j++) {
      if (reviewers[j].approved) approvedCount += 1;
    }
    if (approvedCount < settings.minApprovals) return 'pending';

    var requiredLowered = [];
    for (var k = 0; k < settings.approvers.length; k++) {
      if (settings.approvers[k].isRequired) {
        requiredLowered.push(settings.approvers[k].username.toLowerCase());
      }
    }
    for (var m = 0; m < requiredLowered.length; m++) {
      var required = requiredLowered[m];
      var match = null;
      for (var n = 0; n < reviewers.length; n++) {
        if (reviewers[n].username.toLowerCase() === required && reviewers[n].approved) {
          match = reviewers[n];
          break;
        }
      }
      if (!match) return 'pending';
    }
    return 'green';
  }

  // lib/coloring.ts:91 aggregateCardState
  function aggregateCardState(prs, settings) {
    if (prs.length === 0) return 'no-pr';
    var sawGreen = false;
    for (var i = 0; i < prs.length; i++) {
      var s = deriveCardStateForPR(prs[i], settings);
      if (s === 'red') return 'red';
      if (s === 'green') sawGreen = true;
    }
    return sawGreen ? 'green' : 'pending';
  }

  // entrypoints/background/bitbucket.ts:429 mapReviewer
  function mapReviewer(p) {
    var obj = p || {};
    var user = obj.user;
    if (!user) return null;
    // Drop drive-by commenters at the source — only formal reviewers.
    if (obj.role !== 'REVIEWER') return null;

    // Username priority: username → nickname → uuid.
    var username = '';
    if (typeof user.username === 'string' && user.username.length > 0) {
      username = user.username;
    } else if (typeof user.nickname === 'string' && user.nickname.length > 0) {
      username = user.nickname;
    } else if (typeof user.uuid === 'string' && user.uuid.length > 0) {
      username = user.uuid;
    } else {
      return null;
    }

    var displayName = typeof user.display_name === 'string' ? user.display_name : '';
    // uuid captured independently of the username chain (parallel identity token).
    var uuid = typeof user.uuid === 'string' && user.uuid.length > 0 ? user.uuid : undefined;
    var avatarUrl =
      user.links && user.links.avatar && typeof user.links.avatar.href === 'string'
        ? user.links.avatar.href
        : '';
    // state varies across Cloud/Server: approved / changes_requested / needs_work.
    var stateStr = typeof obj.state === 'string' ? obj.state.toLowerCase() : '';
    var approved = obj.approved === true || stateStr === 'approved';
    var changesRequested = stateStr === 'changes_requested' || stateStr === 'needs_work';

    return {
      username: username,
      uuid: uuid,
      displayName: displayName,
      avatarUrl: avatarUrl,
      approved: approved,
      changesRequested: changesRequested,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // DATA SERVICE  (merge of background/bitbucket.ts + content/state.ts)
  // ───────────────────────────────────────────────────────────────────────────

  var PR_CACHE_TTL_MS = 30000;
  var MAX_CONCURRENT_REQUESTS = 10;
  // bitbucket.ts:54 PR_URL_RE — parses bitbucket.org PR URLs from dev-status.
  var PR_URL_RE =
    /^https:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/;

  // Typed-ish errors (bitbucket.ts:59-91), simplified to the coloring path.
  function BitbucketAuthError() {
    this.name = 'BitbucketAuthError';
    this.message = 'Token rejected';
    this.status = 401;
  }
  function BitbucketScopeError() {
    this.name = 'BitbucketScopeError';
    this.message = 'Token missing required scopes';
    this.status = 403;
  }
  function BitbucketRequestError(status, statusText) {
    this.name = 'BitbucketRequestError';
    this.status = status;
    this.message = statusText || 'Bitbucket API error';
  }

  // ── Throttle: shared 10-concurrent gate across BOTH plain + bridge fetches
  //    (bitbucket.ts:108-135). Recreated in-page because the worker-global
  //    gate is gone; still essential since board-mount fans out ~50 cards.
  var inflight = 0;
  var waiters = [];
  function acquireSlot() {
    if (inflight < MAX_CONCURRENT_REQUESTS) {
      inflight += 1;
      return Promise.resolve();
    }
    return new Promise(function (resolve) {
      waiters.push(resolve);
    }).then(function () {
      inflight += 1;
    });
  }
  function releaseSlot() {
    inflight -= 1;
    var next = waiters.shift();
    if (next) next();
  }
  function withSlot(fn) {
    return acquireSlot().then(function () {
      return Promise.resolve()
        .then(fn)
        .then(
          function (v) { releaseSlot(); return v; },
          function (e) { releaseSlot(); throw e; }
        );
    });
  }

  // One-shot warning dedupe (bitbucket.ts:137-144).
  var warned = {};
  function warnOnce(key, message) {
    if (warned[key]) return;
    warned[key] = true;
    logInfo(message);
  }

  // ── Same-origin plain fetch (Jira dev-status). credentials:'include' sends
  //    the atlassian.net session cookie; the isolated world shares the page
  //    origin so this behaves exactly like the content-script fetch.
  function plainFetch(url) {
    return withSlot(function () {
      return fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });
    });
  }

  // ── Cross-origin bridge fetch (api.bitbucket.org) with host-side Basic auth.
  //    steersman.fetch resolves for 4xx (res.ok reflects 2xx) and rejects only
  //    with typed transport errors {type, message}.
  function bridgeFetch(url) {
    return withSlot(function () {
      return S.fetch(url, {
        method: 'GET',
        responseType: 'json',
        auth: bbAuth(),
      });
    });
  }

  // ── Linkage discovery via Jira dev-status (bitbucket.ts:148 lookupViaDevStatus).
  //    SAME-ORIGIN. Two steps: key → internal issue id, then dev-status detail.
  var jiraIdCache = {}; // `${tenant}:${key}` → issueId (immutable, no TTL)

  function lookupViaDevStatus(tenant, key) {
    var idKey = tenant + ':' + key;
    var idPromise;
    if (jiraIdCache[idKey]) {
      idPromise = Promise.resolve(jiraIdCache[idKey]);
    } else {
      idPromise = plainFetch(
        'https://' + tenant + '/rest/api/3/issue/' + encodeURIComponent(key) + '?fields=summary'
      ).then(
        function (res) {
          if (!res.ok) return null; // 401/403/404 → user not logged into Jira → fall back
          return res.json().then(
            function (body) {
              if (!body || typeof body.id !== 'string' || body.id.length === 0) return null;
              jiraIdCache[idKey] = body.id;
              return body.id;
            },
            function () { return null; }
          );
        },
        function () { return null; }
      );
    }

    return idPromise.then(function (issueId) {
      if (!issueId) return null;
      return plainFetch(
        'https://' + tenant + '/rest/dev-status/1.0/issue/detail?issueId=' +
          encodeURIComponent(issueId) + '&applicationType=bitbucket&dataType=pullrequest'
      ).then(
        function (res) {
          if (!res.ok) {
            warnOnce('dev-status-' + res.status,
              'Jira dev-status returned ' + res.status + ' — no linkage');
            return null;
          }
          return res.json().then(
            function (body) { return parseDevStatusLinks(body); },
            function () { return null; }
          );
        },
        function () {
          warnOnce('dev-status-network', 'Jira dev-status network error — no linkage');
          return null;
        }
      );
    });
  }

  // Shape: { detail: [{ pullRequests: [{ url, status }, ...] }, ...] }
  function parseDevStatusLinks(body) {
    var detail = body && body.detail;
    if (!Array.isArray(detail)) return null;
    var links = [];
    for (var i = 0; i < detail.length; i++) {
      var prs = detail[i] && detail[i].pullRequests;
      if (!Array.isArray(prs)) continue;
      for (var j = 0; j < prs.length; j++) {
        var pr = prs[j] || {};
        if (pr.status !== 'OPEN') continue;
        if (typeof pr.url !== 'string') continue;
        var m = PR_URL_RE.exec(pr.url);
        if (!m) continue;
        var prId = parseInt(m[3], 10);
        if (!isFinite(prId)) continue;
        links.push({ workspace: m[1], repoSlug: m[2], prId: prId });
      }
    }
    return links;
  }

  // ── PR detail (bitbucket.ts:383 fetchPRDetail). CROSS-ORIGIN via bridge.
  function fetchPRDetail(link) {
    var url =
      'https://api.bitbucket.org/2.0/repositories/' +
      encodeURIComponent(link.workspace) + '/' +
      encodeURIComponent(link.repoSlug) + '/pullrequests/' + link.prId;

    return bridgeFetch(url).then(
      function (res) {
        if (res.status === 401) throw new BitbucketAuthError();
        if (res.status === 403) throw new BitbucketScopeError();
        if (res.status === 404) return null;
        if (!res.ok) throw new BitbucketRequestError(res.status, res.statusText);

        var bodyPromise;
        if (res.body != null && typeof res.body === 'object') {
          bodyPromise = Promise.resolve(res.body);
        } else if (typeof res.json === 'function') {
          bodyPromise = res.json();
        } else {
          bodyPromise = Promise.resolve(null);
        }
        return bodyPromise.then(function (body) {
          var reviewers = [];
          if (body && Array.isArray(body.participants)) {
            for (var i = 0; i < body.participants.length; i++) {
              var part = mapReviewer(body.participants[i]);
              if (part) reviewers.push(part);
            }
          }
          return { reviewers: reviewers };
        });
      },
      function (err) {
        // Typed transport rejection {type, message} from the bridge.
        throw new BitbucketRequestError(0, (err && err.message) || 'Bridge fetch failed');
      }
    );
  }

  // ── Linkage + detail orchestration (bitbucket.ts:541 runLinkageAndDetail).
  //    P2 branch-scan fallback intentionally omitted — if dev-status yields no
  //    PR we return [] and the card stays uncolored.
  function runLinkageAndDetail(tenant, key) {
    return lookupViaDevStatus(tenant, key).then(function (links) {
      if (!links || links.length === 0) return [];
      if (!CONFIG.bbUsername) return []; // no creds → can't read PR detail
      return Promise.all(links.map(fetchPRDetail)).then(function (details) {
        var out = [];
        for (var i = 0; i < details.length; i++) {
          if (details[i] !== null) out.push(details[i]);
        }
        return out;
      });
    });
  }

  // ── SWR cache + inflight coalesce (bitbucket.ts:488-539 + state.ts merged).
  var prCache = {}; // `${tenant}:${key}` → { prs, fetchedAt }
  var prInflight = {}; // `${tenant}:${key}` → Promise<PRState[]>

  function fetchAndCache(tenant, key, cacheKey) {
    if (prInflight[cacheKey]) return prInflight[cacheKey];
    var p = runLinkageAndDetail(tenant, key)
      .then(function (prs) {
        prCache[cacheKey] = { prs: prs, fetchedAt: Date.now() };
        return prs;
      })
      .then(
        function (v) { delete prInflight[cacheKey]; return v; },
        function (e) { delete prInflight[cacheKey]; throw e; }
      );
    prInflight[cacheKey] = p;
    return p;
  }

  // Top-level data entrypoint (bitbucket.ts:577 getPRState). Returns
  //   { ok:true, prs } | { ok:false, error, status }.
  //   `force` skips the SWR "return stale immediately" fast path.
  function getPRState(tenant, key, force) {
    if (!tenant || !key) {
      return Promise.resolve({ ok: false, error: 'Missing tenant or key', status: 0 });
    }
    var cacheKey = tenant + ':' + key;
    var cached = prCache[cacheKey];
    if (!force && cached) {
      var age = Date.now() - cached.fetchedAt;
      if (age < PR_CACHE_TTL_MS) {
        return Promise.resolve({ ok: true, prs: cached.prs });
      }
      // Stale-while-revalidate: return stale now, refresh in the background.
      fetchAndCache(tenant, key, cacheKey).catch(function () {});
      return Promise.resolve({ ok: true, prs: cached.prs });
    }
    return fetchAndCache(tenant, key, cacheKey).then(
      function (prs) { return { ok: true, prs: prs }; },
      function (err) { return mapError(err); }
    );
  }

  function mapError(err) {
    if (err instanceof BitbucketAuthError) {
      return { ok: false, error: 'Token rejected — check the Bitbucket token.', status: 401 };
    }
    if (err instanceof BitbucketScopeError) {
      return { ok: false, error: 'Token missing required scopes.', status: 403 };
    }
    if (err instanceof BitbucketRequestError) {
      return { ok: false, error: err.message || 'Bitbucket API error', status: err.status };
    }
    return { ok: false, error: 'Unexpected error fetching PR data', status: 0 };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // STYLE  (ported from entrypoints/content/style.ts)
  // ───────────────────────────────────────────────────────────────────────────

  var STYLE_ID = 'ej-styles';
  var ROOT_RULE_MARKER = '/* ej-root */';

  function buildRootBlock(colors) {
    return ROOT_RULE_MARKER + '\n' +
      ':root {\n' +
      '  --ej-green:  ' + colors.green + ';\n' +
      '  --ej-yellow: ' + colors.yellow + ';\n' +
      '  --ej-red:    ' + colors.red + ';\n' +
      '}';
  }

  // Only green/red are painted; pending/no-pr/unknown/error keep Jira's surface.
  var STATIC_RULES = '\n' +
    '[data-testid="platform-board-kit.ui.card.card"][data-ej-state="green"],\n' +
    '[data-testid="platform-board-kit.ui.card.card"][data-ej-state="green"] [data-testid="platform-card.ui.card.focus-container"],\n' +
    '[data-testid="platform-board-kit.ui.card.card"][data-ej-state="green"] [data-testid="platform-board-kit.ui.card.ripple.div"] {\n' +
    '  background-color: var(--ej-green) !important;\n' +
    '}\n' +
    '[data-testid="platform-board-kit.ui.card.card"][data-ej-state="red"],\n' +
    '[data-testid="platform-board-kit.ui.card.card"][data-ej-state="red"] [data-testid="platform-card.ui.card.focus-container"],\n' +
    '[data-testid="platform-board-kit.ui.card.card"][data-ej-state="red"] [data-testid="platform-board-kit.ui.card.ripple.div"] {\n' +
    '  background-color: var(--ej-red) !important;\n' +
    '}\n';

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = buildRootBlock(DEFAULT_COLORS) + '\n' + STATIC_RULES;
    // Mark so the injected <style> is stripped from agent DOM reads.
    try { if (S.mark) S.mark(style); } catch (e) {}
    (document.head || document.documentElement).appendChild(style);
  }

  function applyColorOverrides(colors) {
    installStyles();
    var style = document.getElementById(STYLE_ID);
    if (!style) return;
    var current = style.textContent || '';
    var markerIdx = current.indexOf(ROOT_RULE_MARKER);
    if (markerIdx === -1) {
      style.textContent = buildRootBlock(colors) + '\n' + STATIC_RULES;
      return;
    }
    var closingBraceIdx = current.indexOf('}', markerIdx);
    if (closingBraceIdx === -1) {
      style.textContent = buildRootBlock(colors) + '\n' + STATIC_RULES;
      return;
    }
    var tail = current.slice(closingBraceIdx + 1);
    style.textContent = buildRootBlock(colors) + tail;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // BOARD DOM HELPERS  (ported from entrypoints/content/board.ts)
  // ───────────────────────────────────────────────────────────────────────────

  var SELECTORS = {
    board: '[data-testid="software-board.board"]',
    columnWrapper: '[data-testid="platform-board-kit.ui.column.draggable-column.styled-wrapper"]',
    columnName: '[data-testid="platform-board-kit.common.ui.column-header.editable-title.column-title.column-name"]',
    card: '[data-testid="platform-board-kit.ui.card.card"]',
    cardKey: '[data-testid="platform-card.common.ui.key.key"]',
  };
  var REVIEW_NAME_RE = /^review$/i;

  function findBoard() { return document.querySelector(SELECTORS.board); }
  function findColumns(board) {
    return [].slice.call(board.querySelectorAll(SELECTORS.columnWrapper));
  }
  function readColumnName(column) {
    var el = column.querySelector(SELECTORS.columnName);
    var text = el && el.textContent ? el.textContent.trim() : '';
    return text ? text : null;
  }
  function isReviewColumn(column) {
    var name = readColumnName(column);
    return name !== null && REVIEW_NAME_RE.test(name);
  }
  function findReviewColumns(board) {
    return findColumns(board).filter(isReviewColumn);
  }
  function findCardsInColumn(column) {
    return [].slice.call(column.querySelectorAll(SELECTORS.card));
  }
  function extractKey(card) {
    var el = card.querySelector(SELECTORS.cardKey);
    var text = el && el.textContent ? el.textContent.trim() : '';
    return text ? text : null;
  }
  function tagCard(card, key) {
    card.dataset.ejKey = key;
    if (!card.dataset.ejState) card.dataset.ejState = 'unknown';
  }
  function untagCard(card) {
    delete card.dataset.ejKey;
    delete card.dataset.ejState;
  }
  function findTaggedCards(root) {
    return [].slice.call((root || document).querySelectorAll('[data-ej-key]'));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PER-KEY CardState CACHE  (ported from entrypoints/content/state.ts)
  // ───────────────────────────────────────────────────────────────────────────

  var lastCardState = {}; // key → CardState (survives virtualization remounts)
  function getCachedCardState(key) { return lastCardState[key]; }
  function setCachedCardState(key, state) { lastCardState[key] = state; }
  // NB: deliberately NOT pruned on unmount (state.ts:170 rationale — avoids the
  // scroll-flicker bug when a virtualized card remounts).

  // ───────────────────────────────────────────────────────────────────────────
  // BOARD WATCHER  (ported from entrypoints/content/observer.ts)
  // ───────────────────────────────────────────────────────────────────────────

  var DEBOUNCE_MS = 100;
  var BOARD_POLL_MS = 500;

  var lastReportedCount = -1;
  var warnedMissingKey = false;
  var pendingTimer = null;
  var boardObserver = null;
  var bodyResilienceObserver = null;
  var observedBoard = null;
  var cardsChangedListeners = [];

  function onCardsChanged(listener) {
    cardsChangedListeners.push(listener);
    return function () {
      var idx = cardsChangedListeners.indexOf(listener);
      if (idx !== -1) cardsChangedListeners.splice(idx, 1);
    };
  }
  function emitCardsChanged() {
    for (var i = 0; i < cardsChangedListeners.length; i++) {
      try { cardsChangedListeners[i](); } catch (e) { logError('cardsChanged listener error', e); }
    }
  }

  function runPass(board) {
    var reviewColumns = findReviewColumns(board);
    if (reviewColumns.length === 0) {
      var stale = findTaggedCards();
      for (var s = 0; s < stale.length; s++) untagCard(stale[s]);
      reportCount(0);
      emitCardsChanged();
      return;
    }
    var currentReviewCards = [];
    var seen = new Set();
    for (var c = 0; c < reviewColumns.length; c++) {
      var cards = findCardsInColumn(reviewColumns[c]);
      for (var d = 0; d < cards.length; d++) {
        if (!seen.has(cards[d])) { seen.add(cards[d]); currentReviewCards.push(cards[d]); }
      }
    }
    var tagged = 0;
    for (var e = 0; e < currentReviewCards.length; e++) {
      var key = extractKey(currentReviewCards[e]);
      if (!key) {
        if (!warnedMissingKey) { logInfo('Card missing key — skipping'); warnedMissingKey = true; }
        continue;
      }
      tagCard(currentReviewCards[e], key);
      tagged += 1;
    }
    var prev = findTaggedCards();
    for (var f = 0; f < prev.length; f++) {
      if (!seen.has(prev[f])) untagCard(prev[f]);
    }
    reportCount(tagged);
    emitCardsChanged();
  }

  function reportCount(n) {
    if (n !== lastReportedCount) {
      logInfo('Tagged ' + n + ' Review-column cards');
      lastReportedCount = n;
    }
  }

  // Synchronous fast-path repaint from cached state (observer.ts:154).
  function runFastPathPaint(board) {
    var reviewColumns = findReviewColumns(board);
    if (reviewColumns.length === 0) return;
    for (var c = 0; c < reviewColumns.length; c++) {
      var cards = findCardsInColumn(reviewColumns[c]);
      for (var d = 0; d < cards.length; d++) {
        var card = cards[d];
        var key = extractKey(card);
        if (!key) continue;
        var cached = getCachedCardState(key);
        if (cached === undefined) continue;
        if (card.dataset.ejKey !== key) card.dataset.ejKey = key;
        if (card.dataset.ejState !== cached) card.dataset.ejState = cached;
      }
    }
  }

  function schedulePass() {
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(function () {
      pendingTimer = null;
      var live = findBoard();
      if (!live) return;
      if (observedBoard !== live) attachBoardObserver(live);
      runPass(live);
    }, DEBOUNCE_MS);
  }

  function attachBoardObserver(board) {
    if (boardObserver !== null) boardObserver.disconnect();
    observedBoard = board;
    boardObserver = new MutationObserver(function () {
      runFastPathPaint(board);
      schedulePass();
    });
    boardObserver.observe(board, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-ej-state', 'data-ej-key'],
    });
  }

  function waitForBoard() {
    return new Promise(function (resolve) {
      var existing = findBoard();
      if (existing) { resolve(existing); return; }
      var resolved = false;
      var bodyObserver;
      var pollHandle;
      var finish = function (board) {
        if (resolved) return;
        resolved = true;
        if (bodyObserver) bodyObserver.disconnect();
        clearInterval(pollHandle);
        resolve(board);
      };
      bodyObserver = new MutationObserver(function () {
        var found = findBoard();
        if (found) finish(found);
      });
      bodyObserver.observe(document.body, { childList: true, subtree: true });
      pollHandle = setInterval(function () {
        var found = findBoard();
        if (found) finish(found);
      }, BOARD_POLL_MS);
    });
  }

  function attachBodyResilience() {
    if (bodyResilienceObserver !== null) return;
    bodyResilienceObserver = new MutationObserver(function () {
      if (observedBoard !== null && observedBoard.isConnected) return;
      if (findBoard() !== null) schedulePass();
    });
    bodyResilienceObserver.observe(document.body, { childList: true, subtree: true });
  }

  function startBoardWatcher() {
    logInfo('Waiting for Jira board...');
    return waitForBoard().then(function (board) {
      logInfo('Board found, starting Review-column watcher');
      runPass(board);
      attachBoardObserver(board);
      attachBodyResilience();
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // COLORING ORCHESTRATOR  (ported from entrypoints/content/coloring.ts)
  // ───────────────────────────────────────────────────────────────────────────

  var REFRESH_INTERVAL_MS = 60000;

  function startColoring() {
    installStyles();
    // Boot config, then paint + wire refresh loop.
    loadConfig().then(function () {
      applyColorOverrides(CONFIG.settings.colors);
      logInfo('coloring active (connected=' + CONFIG.connected + ')');

      onCardsChanged(function () { recolorAll(false); });

      setInterval(function () {
        if (document.visibilityState !== 'visible') return;
        // Re-read config each tick (no storage change event in this slice).
        loadConfig().then(function () {
          applyColorOverrides(CONFIG.settings.colors);
          if (!CONFIG.connected) return;
          var cards = findTaggedCards();
          if (cards.length === 0) return;
          logInfo('refresh tick — ' + cards.length + ' cards');
          recolorAll(true);
        });
      }, REFRESH_INTERVAL_MS);

      recolorAll(false);
    });
  }

  function recolorAll(force) {
    var cards = findTaggedCards();
    // Prune the PR-fetch cache for keys no longer on the board (but NOT
    // lastCardState — see state.ts rationale).
    var liveKeys = {};
    for (var i = 0; i < cards.length; i++) {
      var k = cards[i].dataset.ejKey;
      if (k) liveKeys[k] = true;
    }
    var tenant = window.location.host;
    for (var ck in prCache) {
      if (Object.prototype.hasOwnProperty.call(prCache, ck)) {
        var keyPart = ck.slice(tenant.length + 1);
        if (ck.indexOf(tenant + ':') === 0 && !liveKeys[keyPart]) delete prCache[ck];
      }
    }
    if (!CONFIG.connected) return Promise.resolve();
    return Promise.all(cards.map(function (card) { return recolorCard(card, force); }));
  }

  function recolorCard(card, force) {
    var key = card.dataset.ejKey;
    if (!key) return Promise.resolve();
    var settings = CONFIG.settings;

    // Immediate re-paint from last-known state (closes the virtualization gap).
    var lastKnown = getCachedCardState(key);
    if (lastKnown !== undefined && card.dataset.ejState !== lastKnown) {
      card.dataset.ejState = lastKnown;
    }

    return getPRState(window.location.host, key, force).then(function (response) {
      var state;
      if (!response.ok) {
        state = 'error';
        warnOnce('getPRState-error', 'PR fetch error: ' + response.error);
      } else {
        state = aggregateCardState(response.prs, settings);
      }
      if (!card.isConnected) return;
      if (card.dataset.ejState !== state) card.dataset.ejState = state;
      if (getCachedCardState(key) !== state) {
        log('colored ' + key + ' → ' + state);
        setCachedCardState(key, state);
      }
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // BOOT
  // ───────────────────────────────────────────────────────────────────────────

  function main() {
    // Guard against double-injection within one document (the host live-applies
    // on connect AND registers for future documents).
    if (document.documentElement.getAttribute('data-ej-booted') === '1') {
      log('already booted — skipping');
      return;
    }
    document.documentElement.setAttribute('data-ej-booted', '1');

    logInfo('module alive on', location.href);
    installStyles();
    startBoardWatcher();
    startColoring();
  }

  main();
})();
