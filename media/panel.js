// Project Steersman — session-manager webview front-end.
// Plain ES2017, no modules, no bundler. Wrapped in an IIFE to keep the global
// scope clean. Renders everything inside <div id="app"> and speaks the host
// message protocol via acquireVsCodeApi()/postMessage.
(function () {
  'use strict';

  // ── VS Code API ─────────────────────────────────────────────
  const vscode = acquireVsCodeApi();

  // ── State ───────────────────────────────────────────────────
  /** @type {{sessions: Array<{id:string,state:string,url:string,activity:(Object|null)}>, port: (number|string|null), view: ('sessions'|'settings'|'enhancejira'), settings: (Object|null), scripts: Array<{name:string}>, bookmarks: (Object|null), bookmarksBarEnabled: boolean, version: string}} */
  let model = {
    sessions: [], port: null, view: 'sessions', settings: null, scripts: [], bookmarks: null, bookmarksBarEnabled: false,
    extensions: [], extensionsEnabled: true, logins: [], loginsAuto: true, version: '',
    enhanceJira: { enabled: true, components: { version: false, epic: false, type: false, quickFilters: false, search: false, assignee: false, more: false,
      completeSprint: false, sprintDetails: false, group: false, viewSettings: false, moreActions: false, shareButton: false, feedbackButton: false,
      addPeople: false, boardActionsMenu: false, moveSprintInsights: false, removeToolbarGap: false, showBoardAvatars: true } }
  };

  // ── Update-check UI state — module-scoped (like expandedFolders/addForm)
  // so it survives the full-rebuild render() instead of resetting each time
  // model is pushed from the host. { status: 'idle'|'checking'|'upToDate'|
  // 'updateAvailable'|'error', latest, releasesUrl, error, current }.
  let updateState = { status: 'idle' };

  // ── Bookmark-manager UI state — kept at module scope so it survives the
  // full-rebuild render(): which folders are open, which add-form/rename is
  // active, and the in-flight drag's id + its invalid drop targets. ──────────
  const expandedFolders = new Set();
  let addForm = null;     // { parentId: 'root'|<folderId>, kind: 'bookmark'|'folder' }
  let renameId = null;    // id of the node currently being renamed inline
  let extForm = null;     // Extensions add/edit form: null=closed, else { id: null(add)|<extId>(edit), name, js }
  let draggingId = null;  // id of the node being dragged (null when idle)
  let draggingIsFolder = false; // whether the in-flight drag is a folder (folders may only land at root)
  let invalidIds = null;  // Set of ids the dragged node may NOT drop into (itself + descendants)
  let hoverEl = null;     // current highlighted drop target (dropline or folder row)

  // Per-section collapse state for the Settings view, persisted in the webview's vscode.setState
  // (the same store as scroll) so it survives reloads. Shape { sectionKey: true }; absent/false =
  // expanded (the default). Toggled by clicking a section header (see toggleSection).
  let collapsedSections = (function () {
    try {
      const st = vscode.getState();
      return (st && st.collapsed && typeof st.collapsed === 'object') ? st.collapsed : {};
    } catch (e) {
      return {};
    }
  })();

  // Debounce timers for textarea edits, keyed by action (+ capability id). ──
  const debounceTimers = {};
  function debounce(key, fn, delay) {
    if (debounceTimers[key]) { clearTimeout(debounceTimers[key]); }
    debounceTimers[key] = setTimeout(function () {
      delete debounceTimers[key];
      fn();
    }, delay || 300);
  }

  // ── Capability-instruction auto-grow ────────────────────────
  // These textareas size to their content instead of scrolling internally for
  // short/medium text, capped at 250px (matching .capability-instruction's
  // max-height in panel.css) past which they scroll. scrollHeight is only
  // meaningful once the element is laid out, so this is called both on input
  // (as the user types) and after each render() (so a long saved instruction
  // shows at full height immediately). Keep the clamp in sync with the CSS cap.
  const INSTRUCTION_MAX_HEIGHT = 250;
  function autoSizeInstruction(el) {
    if (!el) { return; }
    el.style.height = 'auto';
    const full = el.scrollHeight; // raw content height, measured while unclamped
    el.style.height = Math.min(full, INSTRUCTION_MAX_HEIGHT) + 'px';
    // Only show the internal scrollbar when content actually exceeds the cap —
    // a fitting box stays overflow:hidden so it never grabs the scroll wheel
    // as the user scrolls the Settings page past it.
    el.style.overflowY = full > INSTRUCTION_MAX_HEIGHT ? 'auto' : 'hidden';
  }

  // Compact webview port of match-pattern.js — parse a single pattern (returns a descriptor or null)
  // and test a URL against an array of patterns. Used to (a) reject malformed patterns inline in the
  // Extensions add/edit form and (b) compute the "applies to current page" row indicator. Keep in
  // sync with match-pattern.js / the in-page bootstrap port in cdp-tab.js.
  function webParsePattern(p) {
    if (typeof p !== 'string') { return null; }
    p = p.trim();
    if (!p) { return null; }
    if (p === '<all_urls>') { return { allUrls: true }; }
    const s = p.indexOf('://');
    if (s === -1) { return null; }
    const sc = p.slice(0, s);
    if (!/^(\*|https?|file|ftp)$/.test(sc)) { return null; }
    const rest = p.slice(s + 3);
    const sl = rest.indexOf('/');
    if (sl === -1) { return null; }
    const host = rest.slice(0, sl);
    const path = rest.slice(sl);
    if (path[0] !== '/') { return null; }
    if (sc === 'file') {
      if (host !== '') { return null; }
    } else {
      if (host === '') { return null; }
      if (host !== '*') {
        if (host.indexOf('*.') === 0) {
          const bare = host.slice(2);
          if (!bare || bare.indexOf('*') !== -1) { return null; }
        } else if (host.indexOf('*') !== -1) {
          return null;
        }
      }
    }
    return { allUrls: false, scheme: sc, host: host, path: path };
  }

  function isValidMatchPattern(p) {
    return webParsePattern(p) !== null;
  }

  function webGlob(g) {
    let r = '^';
    for (let i = 0; i < g.length; i++) {
      const c = g[i];
      r += c === '*' ? '.*' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(r + '$');
  }

  function webMatchSingle(pr, u) {
    if (!pr) { return false; }
    const sc = u.protocol.replace(/:$/, '');
    if (pr.allUrls) { return ['http', 'https', 'file', 'ftp'].indexOf(sc) !== -1; }
    if (pr.scheme === '*') { if (sc !== 'http' && sc !== 'https') { return false; } }
    else if (pr.scheme !== sc) { return false; }
    if (sc !== 'file') {
      const uh = u.hostname;
      if (pr.host !== '*') {
        if (pr.host.indexOf('*.') === 0) {
          const b = pr.host.slice(2);
          if (!(uh === b || uh.slice(-(b.length + 1)) === '.' + b)) { return false; }
        } else if (uh !== pr.host) {
          return false;
        }
      }
    }
    return webGlob(pr.path).test(u.pathname + u.search);
  }

  function webMatchesUrl(patterns, url) {
    if (!Array.isArray(patterns) || !patterns.length) { return false; }
    let u;
    try { u = new URL(url); } catch (e) { return false; }
    for (let i = 0; i < patterns.length; i++) {
      const pr = webParsePattern(patterns[i]);
      if (pr && webMatchSingle(pr, u)) { return true; }
    }
    return false;
  }

  // ── DOM helper ──────────────────────────────────────────────
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'className') { el.className = attrs[k]; }
        else if (k === 'textContent') { el.textContent = attrs[k]; }
        else if (k === 'title') { el.title = attrs[k]; }
        else if (k === 'ariaLabel') { el.setAttribute('aria-label', attrs[k]); }
        else if (k === 'dataId') { el.setAttribute('data-id', attrs[k]); }
        else if (k === 'dataAction') { el.setAttribute('data-action', attrs[k]); }
        else if (k === 'type') { el.type = attrs[k]; }
        else { el.setAttribute(k, attrs[k]); }
      });
    }
    children.forEach(function (c) {
      if (c == null) { return; }
      if (typeof c === 'string') { el.appendChild(document.createTextNode(c)); }
      else { el.appendChild(c); }
    });
    return el;
  }

  function post(msg) {
    vscode.postMessage(msg);
  }

  // ── Inline SVG icons (theme-coloured via currentColor) ──────
  function svgIcon(paths) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    paths.forEach(function (d) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('fill-rule', 'evenodd');
      p.setAttribute('clip-rule', 'evenodd');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }

  function copyIcon() {
    // Clipboard glyph — matches Project Nomeda's settings-panel copy icon
    // (src/settings-panel/webview/main.ts COPY_ICON_SVG) so both extensions
    // read the same "copy" affordance.
    const svg = svgIcon([
      'M10 1H6a1 1 0 0 0-1 1v1H3.5A1.5 1.5 0 0 0 2 4.5v10A1.5 1.5 0 0 0 3.5 16h9a1.5 1.5 0 0 0 1.5-1.5v-10A1.5 1.5 0 0 0 12.5 3H11V2a1 1 0 0 0-1-1zM6 2h4v2H6V2zm-2.5 3H5v.5a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5V5h1.5a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5z'
    ]);
    // Shrink ~20% (16 -> 13) vs. the other icons; keep the 0 0 16 16 viewBox
    // so the glyph scales down cleanly instead of clipping.
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    return svg;
  }

  function checkIcon() {
    // Checkmark glyph — briefly swapped in for the copy glyph as the "Copied" affordance
    // (Mandrake-style icon swap, no text). Sized to match copyIcon() (13) for a clean swap.
    const svg = svgIcon([
      'M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z'
    ]);
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    return svg;
  }

  function focusIcon() {
    // "reveal / target" eye-ish glyph
    return svgIcon([
      'M8 3C4.5 3 1.7 5.1 1 8c.7 2.9 3.5 5 7 5s6.3-2.1 7-5c-.7-2.9-3.5-5-7-5zm0 8.5c-2.9 0-5.3-1.6-6-3.5.7-1.9 3.1-3.5 6-3.5s5.3 1.6 6 3.5c-.7 1.9-3.1 3.5-6 3.5zM8 6a2 2 0 100 4 2 2 0 000-4z'
    ]);
  }

  function closeIcon() {
    return svgIcon([
      'M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z'
    ]);
  }

  function editIcon() {
    // Pencil glyph — the "rename" affordance on bookmark/folder rows.
    return svgIcon([
      'M12.146 1.146a.5.5 0 0 1 .708 0l2 2a.5.5 0 0 1 0 .708l-9 9a.5.5 0 0 1-.223.13l-3 .857a.5.5 0 0 1-.618-.618l.857-3a.5.5 0 0 1 .13-.223l9-9zM11.5 3.207 3 11.707V13h1.293l8.5-8.5L11.5 3.207z'
    ]);
  }

  function folderIcon() {
    // Folder glyph — pairs with the ＋ on the "add folder" affordance.
    return svgIcon([
      'M1.75 2.5A1.25 1.25 0 0 0 .5 3.75v8.5A1.25 1.25 0 0 0 1.75 13.5h12.5A1.25 1.25 0 0 0 15.5 12.25v-6.5A1.25 1.25 0 0 0 14.25 4.5H8.06L6.56 3H1.75z'
    ]);
  }

  function bookmarkIcon() {
    // Ribbon/bookmark glyph — pairs with the ＋ on the "add bookmark" affordance.
    return svgIcon([
      'M4 1.5A1.5 1.5 0 0 0 2.5 3v11.5a.5.5 0 0 0 .8.4L8 11.62l4.7 3.28a.5.5 0 0 0 .8-.4V3A1.5 1.5 0 0 0 12 1.5H4z'
    ]);
  }

  function packageIcon() {
    // Closed 3-D parcel glyph for the update badge — matches Project Nomeda's
    // update-extension button icon (src/settings-panel/webview/main.ts
    // UPDATE_EXTENSION_ICON_SVG) so both extensions' update controls read the
    // same "box" affordance. Stroke-based (outline cube, no fill), so — like
    // wheelIcon() above — it bypasses svgIcon's hardcoded fill/evenodd paths
    // and builds the <svg> directly.
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.9');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    [
      'M12 3l8 4.5l0 9l-8 4.5l-8 -4.5l0 -9l8 -4.5',
      'M12 12l8 -4.5',
      'M12 12l0 9',
      'M12 12l-8 -4.5',
      'M16 5.25l-8 4.5'
    ].forEach(function (d) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }

  function githubIcon() {
    // GitHub "Octocat" mark — a single filled glyph on the same 0 0 16 16
    // viewBox svgIcon() uses, sized to sit beside the package glyph in the
    // Settings top bar. Opens the project repo (see githubButton / GITHUB_URL).
    const svg = svgIcon([
      'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z'
    ]);
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    return svg;
  }

  // Project repo — opened via the host's existing openExternal handler
  // (panel.js: vscode.env.openExternal), the same postMessage route the
  // "update available → releases page" badge uses.
  const GITHUB_URL = 'https://github.com/lxRbckl/Project-Steersman';

  function githubButton() {
    return h(
      'button',
      {
        className: 'icon-button settings-github-btn',
        type: 'button',
        dataAction: 'openGithub',
        title: 'Open on GitHub',
        ariaLabel: 'Open on GitHub'
      },
      githubIcon()
    );
  }

  function chevronIcon() {
    // Drawn (not text-glyph) right-pointing triangle, kept roughly square in
    // its bounding box (8 wide x 10 tall here) instead of the old '▸' text
    // glyph's skinny shape, so the folder's toggle button rotates cleanly
    // about its own center for the collapsed-▸/expanded-▾ turn (see
    // .bm-chevron.open in panel.css).
    const svg = svgIcon(['M4.5 3 L12.5 8 L4.5 13 Z']);
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    return svg;
  }

  // ── Steering-wheel glyph — the autopilot toggle. Unlike the other icons,
  // it needs two visibly distinct renderings of the SAME wheel (filled ring/
  // hub/spokes when autopilot is on, hollow stroked outline when it's off),
  // so it bypasses svgIcon's hardcoded fill and builds the <svg> directly.
  function wheelIcon(filled) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    // Rim + hub + 3 spokes (one up, two lower-diagonal), all centered on (8,8).
    if (filled) {
      svg.setAttribute('fill', 'currentColor');
      [
        // Rim — an evenodd donut (outer r7 minus inner r5).
        'M1,8 a7,7 0 1,0 14,0 a7,7 0 1,0 -14,0 Z M3,8 a5,5 0 1,0 10,0 a5,5 0 1,0 -10,0 Z',
        // Hub.
        'M6.4,8 a1.6,1.6 0 1,0 3.2,0 a1.6,1.6 0 1,0 -3.2,0 Z',
        // Spoke, straight up.
        'M8.55,6.4 L8.55,3 L7.45,3 L7.45,6.4 Z',
        // Spoke, lower-right diagonal.
        'M9.11,9.28 L12.06,10.98 L12.61,10.02 L9.66,8.32 Z',
        // Spoke, lower-left diagonal.
        'M6.34,8.32 L3.4,10.02 L3.95,10.98 L6.89,9.28 Z'
      ].forEach(function (d) {
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('fill-rule', 'evenodd');
        p.setAttribute('clip-rule', 'evenodd');
        p.setAttribute('d', d);
        svg.appendChild(p);
      });
    } else {
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.3');
      svg.setAttribute('stroke-linecap', 'round');
      const rim = document.createElementNS(NS, 'circle');
      rim.setAttribute('cx', '8'); rim.setAttribute('cy', '8'); rim.setAttribute('r', '6.3');
      svg.appendChild(rim);
      const hub = document.createElementNS(NS, 'circle');
      hub.setAttribute('cx', '8'); hub.setAttribute('cy', '8'); hub.setAttribute('r', '1.6');
      svg.appendChild(hub);
      [
        [8, 6.4, 8, 1.7],       // spoke, straight up
        [9.39, 8.8, 13.46, 11.15], // spoke, lower-right diagonal
        [6.61, 8.8, 2.54, 11.15]   // spoke, lower-left diagonal
      ].forEach(function (pts) {
        const line = document.createElementNS(NS, 'line');
        line.setAttribute('x1', pts[0]); line.setAttribute('y1', pts[1]);
        line.setAttribute('x2', pts[2]); line.setAttribute('y2', pts[3]);
        svg.appendChild(line);
      });
    }
    return svg;
  }

  // ── Row-action icon button (delegated; carries data-id/data-action) ──
  function actionButton(id, action, title, iconEl, extraClass) {
    return h(
      'button',
      {
        className: 'icon-button' + (extraClass ? ' ' + extraClass : ''),
        type: 'button',
        title: title,
        ariaLabel: title,
        dataId: id,
        dataAction: action
      },
      iconEl
    );
  }

  // ── Autopilot toggle — solid wheel = Claude may drive this window; ──
  // outline wheel = manual/human-only. Missing s.autopilot reads as on
  // (host default), matching SWE-1's default-true contract.
  function autopilotButton(s) {
    const on = s.autopilot !== false;
    const title = on
      ? 'Autopilot on — Claude can control this window (click to take manual control)'
      : 'Manual — only you control this window (click to enable autopilot)';
    return h(
      'button',
      {
        className: 'icon-button bm-rowbtn autopilot-toggle' + (on ? '' : ' autopilot-off'),
        type: 'button',
        title: title,
        ariaLabel: title,
        dataId: s.id,
        dataAction: 'toggleAutopilot'
      },
      wheelIcon(on)
    );
  }

  // ── Per-row script picker — an operator control, never gated on a ──
  // capability toggle. Fires 'runScript' on change, then resets to the
  // placeholder so it reads as a one-shot trigger rather than a selection.
  // Manual windows (s.autopilot === false) are the one exception: scripts are
  // blocked server-side for the agent path, so the picker is disabled here too.
  function scriptPicker(s) {
    const scripts = model.scripts || [];
    const manual = s.autopilot === false;
    const select = h('select', {
      className: 'script-picker',
      dataAction: 'runScript',
      dataId: s.id,
      ariaLabel: 'Run automation'
    });
    const placeholder = h('option', {}, scripts.length ? 'Run automation…' : 'No automations');
    placeholder.value = '';
    placeholder.disabled = true;
    select.appendChild(placeholder);
    scripts.forEach(function (sc) {
      const lang = sc.lang || 'js';
      const opt = h('option', {}, sc.name + '  (' + lang + ')');
      opt.value = sc.name;
      select.appendChild(opt);
    });
    select.value = '';
    if (!scripts.length) { select.disabled = true; }
    if (manual) {
      select.disabled = true;
      select.title = 'Manual mode — automations disabled for this window';
    }
    return select;
  }

  // ── Running-script status badge — reflects s.activity.script, re-pushed ──
  // by the host after a run; null when no script activity is in flight.
  function scriptStatusBadge(s) {
    const script = s.activity && s.activity.script;
    if (!script) { return null; }
    const statusClass = script.status === 'running' ? 'running' : script.status === 'error' ? 'error' : 'done';
    const glyph = statusClass === 'running' ? '▶' : statusClass === 'error' ? '⚠' : '✓';
    return h(
      'span',
      { className: 'script-status script-status-' + statusClass, title: script.name + ' — ' + script.status },
      glyph + ' ' + script.name
    );
  }

  // ── Session row ─────────────────────────────────────────────
  // Two stacked sub-rows: an identity line (dot + bold name + faint url) on
  // top, and a controls line (script picker/status + action buttons) below.
  function sessionRow(s) {
    const connected = s.state === 'connected';
    const secondary = connected && s.url ? s.url : (s.state || 'unknown');

    // Base state class always applies; agent-active is additive so the dot reverts to the
    // plain state color the moment agentActive flips false on a later re-render.
    const dot = h('span', {
      className: 'dot ' + (s.state || 'disconnected') + (s.agentActive ? ' agent-active' : ''),
    });

    const top = h(
      'div',
      { className: 'session-top' },
      dot,
      h('span', { className: 'session-id', title: s.id }, s.id),
      h('span', { className: 'session-url', title: secondary }, secondary)
    );

    const scriptsCluster = h(
      'div',
      { className: 'session-scripts' },
      scriptStatusBadge(s),
      scriptPicker(s)
    );

    const actions = h(
      'div',
      { className: 'session-actions' },
      actionButton(s.id, 'copyPrompt', 'Copy prompt', copyIcon(), 'bm-rowbtn'),
      actionButton(s.id, 'focusSession', 'Focus tab', focusIcon(), 'bm-rowbtn'),
      actionButton(s.id, 'closeSession', 'Close session', closeIcon(), 'danger bm-rowbtn')
    );

    const controls = h(
      'div',
      { className: 'session-controls' },
      autopilotButton(s),
      scriptsCluster,
      actions
    );

    return h('div', { className: 'session-row', dataId: s.id }, top, controls);
  }

  // ── Rail tab (worded, Nomeda-style; active one is bolded via .active) ──
  // The 'settings' tab also reads as active while on the 'enhancejira' sub-page
  // (a nested view reached FROM Settings), so the rail doesn't go tab-less there.
  function railTab(label, action, view) {
    const active = view === 'settings' ? (model.view === 'settings' || model.view === 'enhancejira') : model.view === view;
    const cls = 'rail-item' + (active ? ' active' : '');
    return h(
      'button',
      { className: cls, type: 'button', dataAction: action },
      label
    );
  }

  // ── Settings view — renders host-pushed capability config; the webview ──
  // hardcodes no capability list or defaults, only the layout.
  function capabilityRow(cap) {
    const toggle = h('input', {
      type: 'checkbox',
      className: 'capability-toggle',
      dataAction: 'toggleCapability',
      dataId: cap.id,
      ariaLabel: 'Enable ' + cap.label
    });
    toggle.checked = !!cap.enabled;

    const header = h(
      'label',
      { className: 'capability-header' },
      toggle,
      h('span', { className: 'capability-label' }, cap.label),
      cap.risky ? h('span', { className: 'capability-risky' }, 'risky') : null
    );

    const instrArea = h('textarea', {
      className: 'capability-instruction',
      dataAction: 'setCapabilityInstruction',
      dataId: cap.id,
      rows: '2',
      ariaLabel: cap.label + ' instruction'
    });
    instrArea.value = cap.instruction || '';

    return h('div', { className: 'capability-row' }, header, instrArea);
  }

  // ── Bookmarks manager — a Chrome-style tree the user CRUDs with inline
  // forms + drag-and-drop. Rendered entirely from model.bookmarks (host state);
  // every mutation posts a message and waits for the host's fresh tree. ──────
  //
  // Root parent is carried through the DOM as the sentinel 'root' and mapped
  // back to null when posting (the host contract accepts null/'root').
  function toPid(attr) { return attr === 'root' ? null : attr; }

  // Depth-first lookup of a node by id, plus collection of an id + all its
  // descendant ids (used to forbid dropping a folder into its own subtree).
  function findNode(id, node) {
    node = node || model.bookmarks;
    if (!node) { return null; }
    const kids = node.children || [];
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].id === id) { return kids[i]; }
      const found = findNode(id, kids[i]);
      if (found) { return found; }
    }
    return null;
  }

  function collectIds(node, set) {
    if (!node) { return; }
    if (node.id) { set.add(node.id); }
    (node.children || []).forEach(function (c) { collectIds(c, set); });
  }

  // A thin insertion target between siblings; carries the parent + index the
  // dragged node would land at when dropped here (a reorder, not an into-move).
  function dropLine(parentAttr, index) {
    return h('div', {
      className: 'bm-dropline',
      'data-drop-parent': parentAttr,
      'data-drop-index': String(index)
    });
  }

  // ＋ + glyph button that opens an inline add-form under a parent (root or a
  // folder id). Distinct bookmark/folder glyphs read as two separate actions.
  function addBtn(parentAttr, kind) {
    return h(
      'button',
      {
        className: 'icon-button bm-add bm-rowbtn',
        type: 'button',
        dataAction: kind === 'bookmark' ? 'addBookmark' : 'addFolder',
        dataId: parentAttr,
        title: kind === 'bookmark' ? 'Add bookmark' : 'Add folder',
        ariaLabel: kind === 'bookmark' ? 'Add bookmark' : 'Add folder'
      },
      h('span', { className: 'bm-add-plus' }, '＋'),
      kind === 'bookmark' ? bookmarkIcon() : folderIcon()
    );
  }

  // Inline text input for the add-forms and the rename box; value set post-hoc
  // so h() (which has no value branch) doesn't need to grow one.
  function textInput(field, placeholder, value, extraClass) {
    const inp = h('input', {
      className: 'bm-input' + (extraClass ? ' ' + extraClass : ''),
      type: 'text',
      'data-field': field,
      placeholder: placeholder || ''
    });
    inp.value = value || '';
    return inp;
  }

  // ✓/✕ confirm+cancel pair, shared by the add-form and the rename box.
  function confirmCancel(confirmAction, cancelAction, id, confirmTitle) {
    return [
      h('button', {
        className: 'icon-button bm-confirm', type: 'button',
        dataAction: confirmAction, dataId: id || '',
        title: confirmTitle, ariaLabel: confirmTitle
      }, '✓'),
      h('button', {
        className: 'icon-button bm-cancel', type: 'button',
        dataAction: cancelAction, dataId: id || '',
        title: 'Cancel', ariaLabel: 'Cancel'
      }, '✕')
    ];
  }

  function addFormRow() {
    const box = h('div', { className: 'bm-addform' });
    if (addForm.kind === 'bookmark') {
      box.appendChild(textInput('title', 'Title'));
      box.appendChild(textInput('url', 'https://…'));
    } else {
      box.appendChild(textInput('name', 'Folder name'));
    }
    confirmCancel('submitAdd', 'cancelAdd', '', 'Add').forEach(function (b) { box.appendChild(b); });
    return box;
  }

  function folderRow(node) {
    const isRenaming = renameId === node.id;
    const isOpen = expandedFolders.has(node.id);
    const chevron = h('button', {
      className: 'icon-button bm-chevron' + (isOpen ? ' open' : ''),
      type: 'button', dataAction: 'toggleFolder', dataId: node.id,
      title: isOpen ? 'Collapse' : 'Expand', ariaLabel: 'Expand or collapse folder'
    }, chevronIcon());

    const nameEl = isRenaming
      ? textInput('rename', 'Folder name', node.name, 'bm-rename-input')
      : h('span', { className: 'bm-name', title: node.name || '' }, node.name || 'Untitled folder');

    const actions = h('div', { className: 'bm-actions' });
    if (isRenaming) {
      confirmCancel('submitRename', 'cancelRename', node.id, 'Save name').forEach(function (b) { actions.appendChild(b); });
    } else {
      // Folders live ONLY at root — a folder row offers ＋bookmark, rename and
      // delete, but no ＋folder (no nesting folders inside folders).
      actions.appendChild(addBtn(node.id, 'bookmark'));
      actions.appendChild(actionButton(node.id, 'renameStart', 'Rename folder', editIcon(), 'bm-rowbtn'));
      actions.appendChild(actionButton(node.id, 'deleteNode', 'Delete folder', closeIcon(), 'danger bm-rowbtn'));
    }

    return h(
      'div',
      { className: 'bm-row bm-folder', dataId: node.id, draggable: 'true', 'data-node-type': 'folder' },
      chevron, nameEl, actions
    );
  }

  function bookmarkRow(node) {
    const isRenaming = renameId === node.id;
    const fav = node.favicon
      ? h('img', { className: 'bm-favicon', src: node.favicon, alt: '' })
      : h('span', { className: 'bm-favicon bm-favicon-placeholder' });

    const body = isRenaming
      ? textInput('rename', 'Title', node.title, 'bm-rename-input')
      : h(
          'div', { className: 'bm-body' },
          h('span', { className: 'bm-title', title: node.title || '' }, node.title || 'Untitled'),
          node.url ? h('span', { className: 'bm-url', title: node.url }, node.url) : null
        );

    const actions = h('div', { className: 'bm-actions' });
    if (isRenaming) {
      confirmCancel('submitRename', 'cancelRename', node.id, 'Save title').forEach(function (b) { actions.appendChild(b); });
    } else {
      actions.appendChild(actionButton(node.id, 'renameStart', 'Rename bookmark', editIcon(), 'bm-rowbtn'));
      actions.appendChild(actionButton(node.id, 'deleteNode', 'Delete bookmark', closeIcon(), 'danger bm-rowbtn'));
    }

    return h(
      'div',
      { className: 'bm-row bm-bookmark', dataId: node.id, draggable: 'true', 'data-node-type': 'bookmark' },
      fav, body, actions
    );
  }

  // Renders the children of `node` interleaved with droplines, plus the trailing
  // add-form when one is open against this parent. parentAttr = 'root' | folderId.
  function renderChildren(node, parentAttr, isRoot) {
    const box = h('div', { className: isRoot ? 'bm-tree' : 'bm-children' });
    const kids = node.children || [];
    box.appendChild(dropLine(parentAttr, 0));
    kids.forEach(function (child, i) {
      if (child.type === 'folder') {
        const wrap = h('div', { className: 'bm-node' }, folderRow(child));
        if (expandedFolders.has(child.id)) {
          wrap.appendChild(renderChildren(child, child.id, false));
        }
        box.appendChild(wrap);
      } else {
        box.appendChild(bookmarkRow(child));
      }
      box.appendChild(dropLine(parentAttr, i + 1));
    });
    if (addForm && addForm.parentId === parentAttr) {
      box.appendChild(addFormRow());
    }
    return box;
  }

  // "Show bookmarks bar" toggle — mirrors the capability-toggle look (a plain
  // checkbox + label), but flips the persisted global flag on 'change' instead
  // of a per-capability enable. The bar only controls the in-page bar; the
  // tree editor below stays fully usable either way.
  function barToggle() {
    const toggle = h('input', {
      type: 'checkbox',
      className: 'capability-toggle bm-bar-toggle',
      dataAction: 'toggleBookmarksBarEnabled',
      ariaLabel: 'Show bookmarks bar'
    });
    toggle.checked = !!model.bookmarksBarEnabled;
    return h(
      'label',
      { className: 'bm-bar-toggle-row' },
      toggle,
      h('span', { className: 'capability-label' }, 'Show bookmarks bar'),
      !model.bookmarksBarEnabled ? h('span', { className: 'bm-bar-hint' }, '(bar hidden)') : null
    );
  }

  // ── Collapsible section headers ─────────────────────────────
  function isSectionCollapsed(key) { return !!collapsedSections[key]; }

  function settingsChevron(key) {
    return h('span', { className: 'settings-chevron' + (isSectionCollapsed(key) ? '' : ' open') }, chevronIcon());
  }

  // Clickable header for a PLAIN section (a bare .settings-section-title): caret + label; clicking
  // toggles collapse. The label span inherits the .settings-section-title font from the wrapper.
  function sectionTitleHeader(key, text) {
    return h(
      'div',
      { className: 'settings-section-title settings-section-toggle', dataAction: 'toggleSection', 'data-section-key': key },
      settingsChevron(key),
      h('span', {}, text)
    );
  }

  // Clickable header for a COMPOUND section (.bm-section-header with right-side actions): caret +
  // label grouped left (that group toggles collapse), the action buttons on the right keep their
  // own data-action so clicking them doesn't toggle the section.
  function bmSectionHeader(key, text, actionsEl) {
    return h(
      'div',
      { className: 'bm-section-header settings-section-toggle', dataAction: 'toggleSection', 'data-section-key': key },
      h('div', { className: 'settings-section-titlegroup' }, settingsChevron(key), h('span', { className: 'settings-section-title' }, text)),
      actionsEl
    );
  }

  // ── Scripts section — flat list of the central script-dir entries already
  // pushed in model.scripts (shared, read-only here, with the per-session
  // script pickers); the only affordance is delete.
  function scriptRow(sc) {
    const lang = sc.lang || 'js';
    return h(
      'div',
      { className: 'script-row' },
      h('span', { className: 'script-name', title: sc.name }, sc.name),
      h('span', { className: 'script-lang script-lang-' + lang }, lang.toUpperCase()),
      actionButton(sc.name, 'deleteScript', 'Delete automation', closeIcon(), 'danger bm-rowbtn')
    );
  }

  function scriptsSection() {
    const section = h('div', { className: 'scripts-section' });
    section.appendChild(sectionTitleHeader('automations', 'Automations'));
    if (isSectionCollapsed('automations')) { return section; }
    const scripts = model.scripts || [];
    if (!scripts.length) {
      section.appendChild(h('div', { className: 'settings-loading' }, 'No automations'));
      return section;
    }
    const list = h('div', { className: 'scripts-list' });
    scripts.forEach(function (sc) {
      list.appendChild(scriptRow(sc));
    });
    section.appendChild(list);
    return section;
  }

  // Agent-oriented briefing copied by the "Copy agent briefing" button beside ＋Add. Paste into a
  // dev agent to have it author an extension. Kept as a line array (joined with \n) so markdown code
  // fences (```) don't collide with a JS template literal's backticks. MUST stay accurate to what
  // the feature actually does — update this if the injector/record shape changes.
  const EXTENSIONS_BRIEFING = [
    '# Project Steersman — Extensions: authoring guide',
    '',
    'You are helping author an **Extension** for Project Steersman (a VS Code extension that drives',
    "VS Code's integrated browser). Use this guide to produce a correct extension record.",
    '',
    '## What an Extension is',
    'An operator-authored, **persistent, URL-matched** page modifier: JavaScript and/or CSS that',
    'auto-injects into **every matching page load, across all tabs**, until disabled. (Contrast: an',
    '*Automation* is an on-demand, one-shot script run against a single tab.)',
    '',
    '## Record fields',
    '- `name` — display label (optional).',
    '- `matches` — array of URL match patterns. **Required to run** (empty array ⇒ never runs).',
    '- `js` — JavaScript body run on matching pages (optional; **must be valid JS** — see below).',
    '- `css` — CSS applied on matching pages (optional).',
    '- `runAt` — `document_start` or `document_idle` (default).',
    '- `world` — `main` (default) or `isolated`.',
    '- `hideFromAgent` — boolean, default `false`.',
    '- `enabled` — boolean. Must be true (and the global master toggle on) for the extension to run.',
    '',
    'Minimum to do anything: **at least one match pattern** plus a `js` or `css` body.',
    '',
    '## Match patterns (Chrome-style)',
    'Format `<scheme>://<host><path>`, or the special `<all_urls>`.',
    '- **scheme**: `*` (means http OR https), or explicit `http` / `https` / `file` / `ftp`.',
    '- **host**: `*` (any host), `*.domain.com` (the domain AND all subdomains), or an exact host.',
    '  (`file://` has no host.)',
    '- **path**: must start with `/`; `*` matches any run of characters.',
    '',
    'Examples:',
    '- `*://*.github.com/*` — github.com and all subdomains, http or https.',
    '- `https://example.com/*` — any page on example.com, https only.',
    '- `https://example.com/docs/*` — only the /docs section.',
    '- `<all_urls>` — every http/https/file/ftp page.',
    '',
    'Empty `matches` ⇒ the extension never runs (fail-safe).',
    '',
    '## Gating (when it runs)',
    'Both JS and CSS run **only** when ALL hold: the global Extensions master toggle is ON, the',
    "extension's `enabled` is true, AND one of its match patterns matches the page URL.",
    '',
    '## JS execution',
    '- **world: main** (default) — runs in the page\'s own JS world: can read/call page globals and',
    "  bypasses the page's Content-Security-Policy. Also visible to the page.",
    '- **world: isolated** — runs in a separate JS world: CANNOT see or collide with the page\'s JS',
    '  globals (shares only the DOM). Use when you don\'t need page globals.',
    '- **runAt**: `document_start` runs at document creation (before the page\'s own scripts);',
    '  `document_idle` (default) defers to DOMContentLoaded (or runs immediately if already loaded).',
    '- Each body runs in its own try/catch, so one extension\'s runtime error can\'t break others.',
    '- **JS must be syntactically valid** — a save with an unparseable body is REJECTED with an inline',
    '  error (a syntax error would otherwise break injection for all main-world extensions).',
    '- Your body receives a `steersman` argument: `{ id, mark(node) }` (see hideFromAgent).',
    '',
    '## CSS',
    'Injected as a stable `<style>` node. It **applies and reverts live** on toggle/edit/delete — no',
    'reload needed. It works on strict-CSP sites too (CSP bypass is enabled automatically whenever a',
    'CSS-bearing extension is active).',
    '',
    '## hideFromAgent + steersman.mark(node)',
    'Extensions are **visible to agent page-reads by default** (the agent sees the modified page —',
    'usually the point). If you inject operator-only UI you don\'t want the agent to see, set',
    '`hideFromAgent: true` and call `steersman.mark(el)` on each node your JS creates. Marked nodes',
    '(tagged `data-steersman-ext`) plus the extension\'s own CSS `<style>` node are stripped from',
    'agent DOM/text reads. **Best-effort**: only injected/marked nodes and the CSS node are hidden —',
    'it CANNOT hide arbitrary changes your JS made to pre-existing page DOM.',
    '',
    '## Known limitations',
    '- Disabling/deleting a **JS** extension stops future runs but CANNOT undo DOM mutations it',
    '  already made (CSS fully reverts live).',
    '- **isolated-world JS** takes effect on the NEXT navigation, not instantly on toggle (its CSS',
    '  still applies live).',
    '- **SPA route changes** (same-document history navigation) do NOT re-fire document-start',
    '  injection — it fires on real document loads. Handle in-page SPA nav yourself if needed.',
    '',
    '## Worked example',
    'Name: "Night-dim GitHub diffs"  ·  matches: `*://*.github.com/*`  ·  runAt: document_idle  ·  world: main',
    '',
    'CSS:',
    '```css',
    '.diff-table { filter: brightness(0.9); }',
    '```',
    '',
    'JS:',
    '```js',
    '// runs on every matching github.com page',
    'var banner = document.createElement("div");',
    'banner.textContent = "Steersman extension active";',
    'banner.style.cssText = "position:fixed;bottom:8px;right:8px;z-index:99999;' +
      'background:#222;color:#eee;padding:4px 8px;border-radius:4px;font:12px sans-serif";',
    'steersman.mark(banner);   // lets it be hidden from agent reads when hideFromAgent is on',
    'document.body.appendChild(banner);',
    '```',
    ''
  ].join('\n');

  // ── Extensions section — operator-only CRUD over the userscript-style page modifiers. Surface:
  // a master on/off toggle, an ＋Add button, a list of rows (enabled checkbox + name + JS/CSS badge
  // + match summary + an "applies to current page" dot + edit/delete), and an inline add/edit form
  // (name, match patterns, JS, CSS, and a compact run-at / world / hide-from-agent control row).

  // URLs of every currently-connected tab — the pool the "applies here" indicator tests against.
  // There is no single "active/focused tab" in the webview model, so an extension reads as applying
  // "here" when it matches ANY connected tab's URL (see extAppliesHere). Limitation noted in report.
  function connectedUrls() {
    return (model.sessions || [])
      .filter(function (s) { return s && s.state === 'connected' && s.url; })
      .map(function (s) { return s.url; });
  }

  // Would this extension currently apply to an open tab? Same both-gates-AND-url-match test the
  // injector uses: master on, this extension enabled, and its patterns match a connected tab's URL.
  function extAppliesHere(ext, urls) {
    if (!model.extensionsEnabled || !ext.enabled) { return false; }
    for (let i = 0; i < urls.length; i++) {
      if (webMatchesUrl(ext.matches, urls[i])) { return true; }
    }
    return false;
  }

  function extMasterToggle() {
    const toggle = h('input', {
      type: 'checkbox',
      className: 'capability-toggle',
      dataAction: 'toggleExtensionsEnabled',
      ariaLabel: 'Enable extensions'
    });
    toggle.checked = !!model.extensionsEnabled;
    return h(
      'label',
      { className: 'bm-bar-toggle-row' },
      toggle,
      h('span', { className: 'capability-label' }, 'Enable extensions'),
      !model.extensionsEnabled ? h('span', { className: 'bm-bar-hint' }, '(all disabled)') : null
    );
  }

  // One-line match summary for a row: the sole pattern, a count, or a "no patterns" hint.
  function extMatchSummary(ext) {
    const m = Array.isArray(ext.matches) ? ext.matches : [];
    if (!m.length) { return 'no patterns'; }
    if (m.length === 1) { return m[0]; }
    return m.length + ' patterns';
  }

  function extensionRow(ext, urls) {
    const toggle = h('input', {
      type: 'checkbox',
      className: 'capability-toggle',
      dataAction: 'toggleExtension',
      dataId: ext.id,
      ariaLabel: 'Enable ' + (ext.name || 'extension')
    });
    toggle.checked = !!ext.enabled;
    // "Applies to current page" dot — filled when this extension currently affects an open tab.
    const applies = extAppliesHere(ext, urls);
    const dot = h('span', {
      className: 'ext-here' + (applies ? ' active' : ''),
      title: applies ? 'Active on an open tab' : 'Not matching any open tab'
    });
    const name = h('span', { className: 'ext-name', title: ext.name || '' }, ext.name || 'Untitled extension');
    // Tiny JS/CSS indicator of which payload(s) the extension carries; a lock glyph when hidden.
    const kinds = [];
    if (typeof ext.js === 'string' && ext.js.trim()) { kinds.push('JS'); }
    if (typeof ext.css === 'string' && ext.css.trim()) { kinds.push('CSS'); }
    const kindEl = kinds.length ? h('span', { className: 'ext-kind' }, kinds.join('+')) : null;
    const hiddenEl = ext.hideFromAgent
      ? h('span', { className: 'ext-hidden-badge', title: 'Hidden from agent reads' }, 'hidden')
      : null;
    const bridgeEl = ext.bridge
      ? h('span', { className: 'ext-bridge-badge', title: 'Bridge enabled — host-backed storage/network' }, 'bridge')
      : null;
    const summary = h(
      'span',
      { className: 'ext-summary', title: (Array.isArray(ext.matches) ? ext.matches : []).join('\n') },
      extMatchSummary(ext)
    );
    const actions = h(
      'div', { className: 'bm-actions' },
      actionButton(ext.id, 'editExtension', 'Edit extension', editIcon(), 'bm-rowbtn'),
      actionButton(ext.id, 'deleteExtension', 'Delete extension', closeIcon(), 'danger bm-rowbtn')
    );
    return h('div', { className: 'ext-row', dataId: ext.id }, dot, toggle, name, kindEl, hiddenEl, bridgeEl, summary, actions);
  }

  function extFormRow() {
    const box = h('div', { className: 'ext-form' });
    const nameInp = textInput('name', 'Extension name', extForm.name, 'ext-name-input');

    const matchesArea = h('textarea', {
      className: 'capability-instruction ext-matches',
      'data-field': 'matches',
      rows: '2',
      ariaLabel: 'URL match patterns, one per line',
      placeholder: 'URL match patterns — one per line, e.g.\nhttps://example.com/*\n*://*.foo.com/*\n<all_urls>'
    });
    matchesArea.value = extForm.matches || '';

    const jsArea = h('textarea', {
      className: 'capability-instruction ext-js',
      'data-field': 'js',
      rows: '3',
      ariaLabel: 'Extension JavaScript',
      placeholder: '// JavaScript to run on matching pages'
    });
    jsArea.value = extForm.js || '';

    const cssArea = h('textarea', {
      className: 'capability-instruction ext-css',
      'data-field': 'css',
      rows: '3',
      ariaLabel: 'Extension CSS',
      placeholder: '/* CSS to apply on matching pages */'
    });
    cssArea.value = extForm.css || '';

    const runAtSel = h('select', { className: 'ext-runat', 'data-field': 'runAt', ariaLabel: 'Run at' });
    [['document_idle', 'Run at: idle (default)'], ['document_start', 'Run at: document start']].forEach(function (o) {
      const opt = h('option', {}, o[1]);
      opt.value = o[0];
      if ((extForm.runAt || 'document_idle') === o[0]) { opt.selected = true; }
      runAtSel.appendChild(opt);
    });

    const worldSel = h('select', { className: 'ext-runat ext-world', 'data-field': 'world', ariaLabel: 'Execution world' });
    [['main', 'World: main'], ['isolated', 'World: isolated']].forEach(function (o) {
      const opt = h('option', {}, o[1]);
      opt.value = o[0];
      if ((extForm.world || 'main') === o[0]) { opt.selected = true; }
      worldSel.appendChild(opt);
    });

    const hideToggle = h('input', {
      type: 'checkbox', className: 'capability-toggle', 'data-field': 'hideFromAgent', ariaLabel: 'Hide from agent reads'
    });
    hideToggle.checked = !!extForm.hideFromAgent;
    const hideLabel = h('label', { className: 'ext-hide-row', title: 'Strip this extension\'s injected/tagged nodes from agent page reads' },
      hideToggle, h('span', { className: 'capability-label' }, 'Hide from agent reads'));

    // Compact control row: run-at + world selects, then the hide-from-agent toggle.
    const controls = h('div', { className: 'ext-form-controls' }, runAtSel, worldSel, hideLabel);

    // Bridge (B1): host-backed capabilities. A checkbox + operator warning, and the (B2-reserved)
    // host allow-list textarea so the record is complete.
    const bridgeToggle = h('input', {
      type: 'checkbox', className: 'capability-toggle', 'data-field': 'bridge', ariaLabel: 'Enable bridge'
    });
    bridgeToggle.checked = !!extForm.bridge;
    const bridgeLabel = h('label', { className: 'ext-hide-row', title: 'Runs this extension in a dedicated isolated world with host-backed storage (and later network).' },
      bridgeToggle, h('span', { className: 'capability-label' }, 'Bridge (host storage / network)'));
    const bridgeWarn = h('div', { className: 'ext-bridge-warn' },
      'Bridge lets this extension store data via the host and (later) make network requests. Only enable for extensions you trust.');
    const hostsArea = h('textarea', {
      className: 'capability-instruction ext-bridgehosts',
      'data-field': 'bridgeHosts',
      rows: '2',
      ariaLabel: 'Bridge allowed hosts, one per line',
      placeholder: 'Allowed hosts — one per line (used by network requests in a later phase)\napi.example.com'
    });
    hostsArea.value = extForm.bridgeHosts || '';

    const btns = h(
      'div', { className: 'ext-form-actions' },
      extForm.error ? h('span', { className: 'ext-form-error' }, extForm.error) : null,
      h('button', {
        className: 'icon-button bm-confirm', type: 'button',
        dataAction: 'submitExtension', title: 'Save', ariaLabel: 'Save'
      }, '✓'),
      h('button', {
        className: 'icon-button bm-cancel', type: 'button',
        dataAction: 'cancelExtension', title: 'Cancel', ariaLabel: 'Cancel'
      }, '✕')
    );

    box.appendChild(h('div', { className: 'ext-form-name' }, nameInp));
    box.appendChild(h('div', { className: 'ext-form-label' }, 'Match patterns'));
    box.appendChild(matchesArea);
    box.appendChild(h('div', { className: 'ext-form-label' }, 'JavaScript'));
    box.appendChild(jsArea);
    box.appendChild(h('div', { className: 'ext-form-label' }, 'CSS'));
    box.appendChild(cssArea);
    box.appendChild(controls);
    box.appendChild(bridgeLabel);
    box.appendChild(bridgeWarn);
    box.appendChild(h('div', { className: 'ext-form-label' }, 'Bridge allowed hosts'));
    box.appendChild(hostsArea);
    box.appendChild(btns);
    return box;
  }

  function extensionsSection() {
    const section = h('div', { className: 'ext-section' });
    const actions = h('div', { className: 'bm-root-actions' },
      h('button', {
        className: 'icon-button bm-rowbtn',
        type: 'button',
        dataAction: 'copyBriefing',
        title: 'Copy agent briefing',
        ariaLabel: 'Copy agent briefing (how to author an extension)'
      }, copyIcon()),
      h('button', {
        className: 'icon-button bm-rowbtn',
        type: 'button',
        dataAction: 'addExtension',
        title: 'Add extension',
        ariaLabel: 'Add extension'
      }, h('span', { className: 'bm-add-plus' }, '＋'))
    );
    section.appendChild(bmSectionHeader('extensions', 'Extensions', actions));
    if (isSectionCollapsed('extensions')) { return section; }
    section.appendChild(extMasterToggle());

    const items = model.extensions || [];
    if (items.length) {
      const urls = connectedUrls();
      const list = h('div', { className: 'ext-list' });
      items.forEach(function (ext) { list.appendChild(extensionRow(ext, urls)); });
      section.appendChild(list);
    } else if (!extForm) {
      section.appendChild(h('div', { className: 'settings-loading' }, 'No extensions'));
    }
    if (extForm) { section.appendChild(extFormRow()); }
    return section;
  }

  // ── EnhanceJira section — operator-only toggle set that hides Jira board toolbar components.
  // Pure webview UI: renders from host-pushed model.enhanceJira and posts messages; the host +
  // page injection are handled elsewhere. Master toggle mirrors extMasterToggle() exactly (same
  // .bm-bar-toggle-row/.capability-toggle affordance); the component checkboxes (7 toolbar +
  // 5 board-action + 2 header-icon + 2 title-bar hides, plus 1 "move" toggle set apart below a divider) reuse the same
  // .capability-toggle/.capability-label pair, one per row, in a compact column (.ej-component-list
  // in panel.css — the only new class besides the move-divider, for the column layout).
  const EJ_COMPONENTS = [
    { key: 'version', label: 'Version' },
    { key: 'epic', label: 'Epic' },
    { key: 'type', label: 'Type' },
    { key: 'quickFilters', label: 'Quick filters' },
    { key: 'search', label: 'Search' },
    { key: 'assignee', label: 'Assignee' },
    { key: 'more', label: 'More' }
  ];

  // Board actions — a second hide-group, same {key,label} shape as EJ_COMPONENTS and rendered
  // with the identical enhanceJiraComponentRow()/ej-component-list pairing, just under its own
  // "Board actions" sub-caption (.ext-form-label, the same small-label class the extension
  // add/edit form uses above its match-patterns/JS/CSS editors).
  const EJ_BOARD_ACTIONS = [
    { key: 'completeSprint', label: 'Complete sprint' },
    { key: 'sprintDetails', label: 'Sprint details' },
    { key: 'group', label: 'Group / swimlanes' },
    { key: 'viewSettings', label: 'View settings' },
    { key: 'moreActions', label: 'More actions (…)' },
    { key: 'removeToolbarGap', label: 'Remove toolbar gap' }
  ];

  // Header icons — a third hide-group for the board header's top-right icon cluster, same
  // {key,label} shape and enhanceJiraComponentRow()/ej-component-list pairing as the groups above,
  // under its own "Header icons" sub-caption. Insights + fullscreen in that cluster are deliberately
  // not included here (kept, not hideable).
  const EJ_HEADER_ICONS = [
    { key: 'shareButton', label: 'Share' },
    { key: 'feedbackButton', label: 'Give feedback' }
  ];

  // Title bar — a fourth hide-group for the two controls right of the board title, same
  // {key,label} shape and enhanceJiraComponentRow()/ej-component-list pairing as the groups above,
  // under its own "Title bar" sub-caption.
  const EJ_TITLE_BAR = [
    { key: 'addPeople', label: 'Add people' },
    { key: 'boardActionsMenu', label: 'Board actions menu' }
  ];

  function enhanceJiraMasterToggle() {
    const ej = model.enhanceJira || {};
    const toggle = h('input', {
      type: 'checkbox',
      className: 'capability-toggle',
      dataAction: 'toggleEnhanceJiraEnabled',
      ariaLabel: 'Enable EnhanceJira'
    });
    toggle.checked = !!ej.enabled;
    return h(
      'label',
      { className: 'bm-bar-toggle-row' },
      toggle,
      h('span', { className: 'capability-label' }, 'Enable EnhanceJira'),
      !ej.enabled ? h('span', { className: 'bm-bar-hint' }, '(all disabled)') : null
    );
  }

  function enhanceJiraComponentRow(comp) {
    const ej = model.enhanceJira || {};
    const components = ej.components || {};
    const toggle = h('input', {
      type: 'checkbox',
      className: 'capability-toggle',
      dataAction: 'toggleEnhanceJiraComponent',
      'data-ej-key': comp.key,
      ariaLabel: 'Hide ' + comp.label
    });
    toggle.checked = !!components[comp.key];
    return h(
      'label',
      { className: 'bm-bar-toggle-row' },
      toggle,
      h('span', { className: 'capability-label' }, comp.label)
    );
  }

  // The one MOVE control in the section (relocates a button rather than hiding it). Dispatches
  // through the same generic 'toggleEnhanceJiraComponent' action/data-ej-key as the hide
  // checkboxes above — the host store already treats every component key uniformly — but is
  // called out with its own sub-caption + muted hint line so it doesn't read as another hide.
  function enhanceJiraMoveToggleRow() {
    const ej = model.enhanceJira || {};
    const components = ej.components || {};
    const toggle = h('input', {
      type: 'checkbox',
      className: 'capability-toggle',
      dataAction: 'toggleEnhanceJiraComponent',
      'data-ej-key': 'moveSprintInsights',
      ariaLabel: 'Move Sprint insights to header row'
    });
    toggle.checked = !!components.moveSprintInsights;
    return h(
      'label',
      { className: 'bm-bar-toggle-row' },
      toggle,
      h('span', { className: 'capability-label' }, 'Move Sprint insights to header row')
    );
  }

  // A display toggle (not a hide) for the board's assignee-filter replacement, same generic
  // 'toggleEnhanceJiraComponent' action/data-ej-key dispatch as the move toggle above, with its
  // own sub-caption + muted hint line.
  function enhanceJiraBoardAvatarsToggleRow() {
    const ej = model.enhanceJira || {};
    const components = ej.components || {};
    const toggle = h('input', {
      type: 'checkbox',
      className: 'capability-toggle',
      dataAction: 'toggleEnhanceJiraComponent',
      'data-ej-key': 'showBoardAvatars',
      ariaLabel: 'Show board avatars'
    });
    toggle.checked = !!components.showBoardAvatars;
    return h(
      'label',
      { className: 'bm-bar-toggle-row' },
      toggle,
      h('span', { className: 'capability-label' }, 'Show board avatars')
    );
  }

  // Shared group-rendering body — every sub-caption + toggle-list from the section, minus the
  // header/master toggle. Appended straight onto a container (a section wrapper, or the
  // dedicated EnhanceJira sub-page) so the toggle-list markup/dispatch is defined exactly once
  // and reused by both enhanceJiraSection() (kept for reference/back-compat) and enhanceJiraView()
  // (the new dedicated sub-page — see "EnhanceJira settings view" below).
  function enhanceJiraGroups(container) {
    container.appendChild(h('div', { className: 'ext-form-label' }, 'Hide Jira board toolbar components'));
    const list = h('div', { className: 'ej-component-list' });
    EJ_COMPONENTS.forEach(function (comp) { list.appendChild(enhanceJiraComponentRow(comp)); });
    container.appendChild(list);

    container.appendChild(h('div', { className: 'ext-form-label' }, 'Board actions'));
    const boardList = h('div', { className: 'ej-component-list' });
    EJ_BOARD_ACTIONS.forEach(function (comp) { boardList.appendChild(enhanceJiraComponentRow(comp)); });
    container.appendChild(boardList);

    container.appendChild(h('div', { className: 'ext-form-label' }, 'Header icons'));
    const headerIconList = h('div', { className: 'ej-component-list' });
    EJ_HEADER_ICONS.forEach(function (comp) { headerIconList.appendChild(enhanceJiraComponentRow(comp)); });
    container.appendChild(headerIconList);

    container.appendChild(h('div', { className: 'ext-form-label' }, 'Title bar'));
    const titleBarList = h('div', { className: 'ej-component-list' });
    EJ_TITLE_BAR.forEach(function (comp) { titleBarList.appendChild(enhanceJiraComponentRow(comp)); });
    container.appendChild(titleBarList);

    // Set apart from the hide-checkboxes above: a thin divider (.ej-move-divider) + its own
    // sub-caption + a muted hint explaining it moves rather than hides.
    container.appendChild(h('div', { className: 'ej-move-divider' }));
    container.appendChild(h('div', { className: 'ext-form-label' }, 'Sprint insights'));
    container.appendChild(enhanceJiraMoveToggleRow());
    container.appendChild(h('div', { className: 'bm-bar-hint' }, 'Moves the Sprint insights button up to the board header row.'));

    container.appendChild(h('div', { className: 'ej-move-divider' }));
    container.appendChild(h('div', { className: 'ext-form-label' }, 'Board avatars'));
    container.appendChild(enhanceJiraBoardAvatarsToggleRow());
    container.appendChild(h('div', { className: 'bm-bar-hint' }, "Replaces Jira's assignee filter with a full row of every board member's avatar."));
  }

  // Full collapsible section (master toggle + all groups) — no longer wired into settingsView()
  // (replaced there by the compact enhanceJiraConfigureRow() below, which opens the dedicated
  // enhanceJiraView() sub-page instead), kept as a self-contained renderer built on the same
  // shared enhanceJiraGroups() so nothing here duplicates the toggle-list markup.
  function enhanceJiraSection() {
    const section = h('div', { className: 'ext-section' });
    section.appendChild(bmSectionHeader('enhanceJira', 'EnhanceJira'));
    if (isSectionCollapsed('enhanceJira')) { return section; }
    section.appendChild(enhanceJiraMasterToggle());
    enhanceJiraGroups(section);
    return section;
  }

  // ── Compact "EnhanceJira" row in the main Settings view (Option A) — replaces the old inline
  // section above. Keeps the master enable toggle here for quick access (no need to open the
  // sub-page just to flip it on/off); the rest of the row is a button that switches the sidebar
  // to the dedicated enhanceJiraView() sub-page. The toggle is a plain (unlabeled-wrapper)
  // checkbox — deliberately NOT nested inside the row's clickable button, so a click on the
  // checkbox toggles it (via its own 'toggleEnhanceJiraEnabled' data-action, which the delegate
  // resolves first since it's the nearest data-action ancestor-or-self) without also firing the
  // row's 'openEnhanceJira' navigation.
  function enhanceJiraConfigureRow() {
    const ej = model.enhanceJira || {};
    const toggle = h('input', {
      type: 'checkbox',
      className: 'capability-toggle',
      dataAction: 'toggleEnhanceJiraEnabled',
      ariaLabel: 'Enable EnhanceJira'
    });
    toggle.checked = !!ej.enabled;

    const openBtn = h(
      'button',
      {
        className: 'ej-configure-btn',
        type: 'button',
        dataAction: 'openEnhanceJira',
        title: 'Configure EnhanceJira',
        ariaLabel: 'Configure EnhanceJira'
      },
      h('span', { className: 'capability-label' }, 'EnhanceJira'),
      chevronIcon()
    );

    const section = h('div', { className: 'ext-section' });
    section.appendChild(h('div', { className: 'bm-bar-toggle-row ej-configure-row' }, toggle, openBtn));
    section.appendChild(h('div', { className: 'bm-bar-hint' }, 'Declutter the Jira board + avatar filter — configure'));
    return section;
  }

  // ── Dedicated EnhanceJira settings sub-page (Option A) — reached from the compact row above via
  // 'openEnhanceJira'; a ← Back button (mirroring the top-bar chrome of settingsView()) returns to
  // 'settings' via 'closeEnhanceJira'. Body is the same enhanceJiraGroups() used by
  // enhanceJiraSection() — no duplicated toggle-list/dispatch. Purely a client-side view swap: all
  // toggles below still post the existing 'setEnhanceJiraComponent'/'setEnhanceJiraEnabled'
  // messages and read from model.enhanceJira, which is already fetched (getEnhanceJira is posted
  // on 'showSettings' and at boot), so opening this sub-page needs no extra host round-trip.
  function enhanceJiraView() {
    const wrap = h('div', { className: 'settings-body' });

    const topbar = h(
      'div', { className: 'settings-topbar' },
      h('button', {
        className: 'icon-button ej-back-btn',
        type: 'button',
        dataAction: 'closeEnhanceJira',
        title: 'Back to Settings',
        ariaLabel: 'Back to Settings'
      }, '← Back'),
      h('span', { className: 'settings-title' }, 'EnhanceJira')
    );
    wrap.appendChild(topbar);

    enhanceJiraGroups(wrap);
    return wrap;
  }

  // ── Persistent logins section — operator-only. Snapshot a signed-in tab's cookies (window-wide
  // jar, filtered to the origin's host, host-side) and re-inject them into any window later. The
  // model carries METADATA ONLY (origin, cookieCount, savedAt, autoReinject) — never cookie
  // names/values — so nothing sensitive is ever rendered here.

  // Hands-off master switch — "auto for ALL sites". Reuses the .bm-bar-toggle-row / .capability-toggle
  // affordance the Extensions master toggle and bookmarks-bar toggle use, so it reads as the same
  // control. Flipping it posts setAutoAll; the host (SWE-1 backend) does the background capture +
  // auto-restore sweeps.
  function loginsMasterToggle() {
    const toggle = h('input', {
      type: 'checkbox',
      className: 'capability-toggle',
      dataAction: 'toggleLoginsAuto',
      ariaLabel: 'Automatically keep me logged in on all sites'
    });
    toggle.checked = !!model.loginsAuto;
    return h(
      'label',
      { className: 'bm-bar-toggle-row' },
      toggle,
      h('span', { className: 'capability-label' }, 'Automatically keep me logged in (all sites)')
    );
  }

  function loginsSection() {
    const section = h('div', { className: 'ext-section' });
    section.appendChild(bmSectionHeader('logins', 'Persistent logins'));
    if (isSectionCollapsed('logins')) { return section; }

    // Master toggle + caption at the TOP: the hands-off "auto for ALL sites" switch, then a short
    // caption clarifying what ON means (background saves + auto sign-in for new windows; you still
    // log in the first time; capture happens on the next sweep, not instantly).
    section.appendChild(loginsMasterToggle());
    section.appendChild(h('div', { className: 'ext-form-label' },
      model.loginsAuto
        ? 'On: Steersman periodically saves your logins in the background and signs new windows in automatically. You still log in the first time yourself; a freshly signed-in site is captured on the next background pass.'
        : 'Off: turn this on to have Steersman save your logins in the background and sign new windows in automatically. You still log in the first time yourself.'));

    // Full-logout control: a single prominent "Clear all cookies" button (posts clearAllLogins, which
    // the host now handles as a true sign-out — wipes the live browser jar AND the saved store) plus a
    // description line spelling out the scope. Immediate action (no reliable confirm in a webview).
    section.appendChild(h('button', {
      className: 'btn-primary danger logins-clear-btn', type: 'button',
      dataAction: 'clearAllLogins',
      title: 'Clear all cookies', ariaLabel: 'Clear all cookies'
    }, 'Clear'));
    section.appendChild(h('div', { className: 'ext-form-label' },
      'Signs you out of every site — clears all live browser cookies and deletes every saved login from your keychain. You\'ll need to log in again.'));
    return section;
  }

  function bookmarksSection() {
    const section = h('div', { className: 'bm-section' });
    const actions = h('div', { className: 'bm-root-actions' }, addBtn('root', 'bookmark'), addBtn('root', 'folder'));
    section.appendChild(bmSectionHeader('bookmarks', 'Bookmarks', actions));
    if (isSectionCollapsed('bookmarks')) { return section; }
    section.appendChild(barToggle());

    const tree = model.bookmarks;
    if (!tree) {
      section.appendChild(h('div', { className: 'settings-loading' }, 'Loading bookmarks…'));
      return section;
    }
    const wrap = h('div', { className: 'bm-tree-wrap' }, renderChildren(tree, 'root', true));
    section.appendChild(wrap);
    return section;
  }

  // ── Version/update badge — sits above the Settings body; reads
  // model.version (host-pushed) and updateState (module-scoped, see above)
  // so a check-in-flight or a persisted "update available" survives re-render.
  function updateBadge() {
    const version = model.version || '?';
    const versionTag = 'Project Steersman v' + version;
    let stateClass = '';
    // Clicking the badge now runs the LOCAL git-based reinstall (git pull --ff-only
    // when behind, then npm install + vsce package + code --install-extension) rather
    // than opening the releases web page — hence the update-oriented default title.
    // Icon-only button (no visible version label — see .update-badge in panel.css),
    // so the version string that used to sit beside the icon now lives entirely in
    // this hover title.
    let title = versionTag + ' — click to update';
    let disabled = false;
    if (updateState.status === 'updating') {
      stateClass = 'update-checking';
      title = versionTag + ' — updating (pulling, packaging and reinstalling…)';
      disabled = true;
    } else if (updateState.status === 'updated') {
      stateClass = 'update-uptodate';
      title = 'Project Steersman v' + (updateState.latest || version) + ' — updated, reload the window to activate';
    } else if (updateState.status === 'checking') {
      // Dormant pre-signal path (kept for the version-check message contract).
      stateClass = 'update-checking';
      title = versionTag + ' — checking for updates…';
      disabled = true;
    } else if (updateState.status === 'updateAvailable') {
      stateClass = 'update-available';
      title = 'Project Steersman v' + (updateState.latest || '?') + ' available — click to pull and reinstall';
    } else if (updateState.status === 'upToDate') {
      stateClass = 'update-uptodate';
      title = versionTag + ' — up to date';
    } else if (updateState.status === 'error') {
      // Show the host's actual reason rather than a blanket message that hides
      // what went wrong.
      stateClass = 'update-error';
      title = versionTag + ' — ' + (updateState.error || 'update failed') + ' — click to retry';
    }

    // Icon-only, matching githubButton()'s compact footprint — the state classes
    // below still re-tint the icon (via currentColor) instead of a text label.
    const btn = h(
      'button',
      {
        className: 'update-badge' + (stateClass ? ' ' + stateClass : ''),
        type: 'button',
        dataAction: 'selfUpdate',
        title: title,
        ariaLabel: title
      },
      packageIcon()
    );
    if (disabled) { btn.disabled = true; }
    // Returns just the button now — it lives inside the Settings top bar
    // (see settingsView) rather than its own right-aligned header row.
    return btn;
  }

  function settingsView() {
    const wrap = h('div', { className: 'settings-body' });

    // Top bar: bold title on the left, then the package (update-check) button
    // and the GitHub button pinned to the far right, in that order. The
    // title's margin-right:auto pushes the two buttons right.
    const topbar = h(
      'div', { className: 'settings-topbar' },
      h('span', { className: 'settings-title' }, 'PROJECT STEERSMAN'),
      updateBadge(),
      githubButton()
    );
    wrap.appendChild(topbar);

    const s = model.settings;

    if (!s) {
      wrap.appendChild(h('div', { className: 'settings-loading' }, 'Loading settings…'));
      return wrap;
    }

    wrap.appendChild(sectionTitleHeader('instruction', 'Instruction'));
    if (!isSectionCollapsed('instruction')) {
      const instructionArea = h('textarea', {
        className: 'settings-textarea',
        dataAction: 'setInstruction',
        rows: '7',
        ariaLabel: 'Instruction',
        placeholder: 'Instruction for Claude…',
        readonly: 'readonly'
      });
      instructionArea.value = s.instruction || '';
      wrap.appendChild(instructionArea);
    }

    wrap.appendChild(sectionTitleHeader('capabilities', 'Capabilities'));
    if (!isSectionCollapsed('capabilities')) {
      const capList = h('div', { className: 'capability-list' });
      (s.capabilities || []).forEach(function (cap) {
        capList.appendChild(capabilityRow(cap));
      });
      wrap.appendChild(capList);
    }

    wrap.appendChild(scriptsSection());

    wrap.appendChild(extensionsSection());

    wrap.appendChild(enhanceJiraConfigureRow());

    wrap.appendChild(loginsSection());

    wrap.appendChild(bookmarksSection());

    wrap.appendChild(sectionTitleHeader('preview', 'Composed instruction (preview)'));
    if (!isSectionCollapsed('preview')) {
      wrap.appendChild(h('pre', { className: 'settings-preview' }, s.composedPreview || ''));
    }

    return wrap;
  }

  // ── Render ──────────────────────────────────────────────────
  const app = document.getElementById('app');

  // Is a new session currently being set up? Drives the ＋ New Session button's
  // disabled state — sourced from the host-pushed session state (single source
  // of truth) rather than client-side bookkeeping of "which session did I just
  // create". Keying off "no session is connecting" (rather than waiting for a
  // specific session to go 'connected') means a session that lands 'failed' or
  // 'disconnected' without ever going green still re-enables the button.
  function anySessionConnecting() {
    return (model.sessions || []).some(function (s) { return s && s.state === 'connecting'; });
  }

  function render() {
    // Preserve scroll position of the list across re-renders when possible.
    const prevList = app.querySelector('.session-table');
    const prevScroll = prevList ? prevList.scrollTop : readSavedScroll();

    // Settings view scrolls inside .settings-body — a full render() rebuilds it
    // and would snap to the top (e.g. on folder expand/collapse). Capture its
    // scrollTop now and restore it after the fresh body is appended below.
    const prevSettings = app.querySelector('.settings-body');
    const prevSettingsScroll = prevSettings ? prevSettings.scrollTop : 0;

    app.textContent = '';

    // Rail: two worded tabs. "Tabs" maps to the session-list view (internal key
    // 'sessions'); "Settings" maps to the blank settings view. The tab matching
    // the current view carries .active → bold (Nomeda-style selection cue).
    app.appendChild(
      h(
        'nav',
        { className: 'rail' },
        railTab('Tabs', 'showTabs', 'sessions'),
        railTab('Settings', 'showSettings', 'settings')
      )
    );

    if (model.view === 'settings' || model.view === 'enhancejira') {
      // Both views share the .settings-body wrapper/scroll chrome, so the same
      // scroll-capture (above) and restore logic below covers the EnhanceJira
      // sub-page too — it resets to the top on a real navigation in/out (no
      // '.settings-body' is mounted across that render) and preserves scroll
      // across an in-page re-render (e.g. toggling a component), same as Settings.
      const body = model.view === 'settings' ? settingsView() : enhanceJiraView();
      app.appendChild(body);
      // Auto-grow the capability instruction boxes to fit their (possibly long,
      // host-pushed) content now that they're laid out in the DOM — done before
      // the scroll restore below since it changes the body's total height.
      // (enhanceJiraView() has no .capability-instruction textareas, so this is
      // a harmless no-op there.)
      body.querySelectorAll('.capability-instruction').forEach(autoSizeInstruction);
      // Restore the captured scroll position (synchronously, then once more on
      // the next frame in case layout wasn't settled) so re-renders don't jump.
      body.scrollTop = prevSettingsScroll;
      requestAnimationFrame(function () {
        body.querySelectorAll('.capability-instruction').forEach(autoSizeInstruction);
        body.scrollTop = prevSettingsScroll;
      });
      return;
    }

    // Tabs view: a slim body toolbar with the ＋ New Session box button above
    // the list (moved out of the rail).
    const creatingSession = anySessionConnecting();
    const newBtn = h(
      'button',
      {
        className: 'icon-button btn-add',
        type: 'button',
        dataAction: 'newSession',
        title: creatingSession ? 'Setting up new session…' : 'New Session',
        ariaLabel: creatingSession ? 'Setting up new session…' : 'New Session'
      },
      '＋'
    );
    if (creatingSession) { newBtn.disabled = true; }
    // Fleet-level copy button — rail-scoped sibling of the per-row copy button;
    // no session id, so the host copies the fleet/orchestrator prompt instead.
    // Shares .btn-add with the ＋ button so it reads as the same box control,
    // mirrored to the opposite (right) side of the toolbar via .btn-fleet-copy.
    const fleetCopyBtn = h(
      'button',
      {
        className: 'icon-button btn-add btn-fleet-copy',
        type: 'button',
        dataAction: 'copyFleetPrompt',
        title: 'Copy fleet prompt (manage all windows)',
        ariaLabel: 'Copy fleet prompt (manage all windows)'
      },
      copyIcon()
    );
    app.appendChild(h('div', { className: 'body-toolbar' }, newBtn, fleetCopyBtn));

    // Body: a padded wrap holds a bounded table region that fills the remaining
    // width+height below the ＋ button and scrolls its own overflow. The rows
    // (empty when there are no sessions — no separate empty state) stack inside
    // the .session-table card; once they exceed the space the card scrolls
    // internally while the region itself stays full-size.
    const list = h('div', { className: 'session-table' });
    model.sessions.forEach(function (s) {
      list.appendChild(sessionRow(s));
    });
    app.appendChild(h('div', { className: 'table-wrap' }, list));
    list.scrollTop = prevScroll || 0;
    saveScroll(list.scrollTop);
  }

  // ── Scroll persistence across reloads (via vscode state) ────
  function readSavedScroll() {
    const st = vscode.getState();
    return (st && typeof st.scroll === 'number') ? st.scroll : 0;
  }

  function saveScroll(scroll) {
    const st = vscode.getState() || {};
    st.scroll = scroll;
    vscode.setState(st);
  }

  // Persist the collapse map alongside scroll in the webview's vscode state (survives reload).
  function saveCollapsed() {
    const st = vscode.getState() || {};
    st.collapsed = collapsedSections;
    vscode.setState(st);
  }

  // ── Copied feedback — Mandrake-style: briefly swap the button's copy glyph to a green
  // checkmark, then revert (no text). Shared by all copy buttons (per-row, fleet, briefing).
  // Only touches the icon + title; the clipboard write + host postback are unchanged. A
  // re-render during the swap just rebuilds the button at its resting copy glyph (harmless).
  function flashCopyCheck(btn) {
    if (!btn || btn.getAttribute('data-copied') === '1') { return; }
    btn.setAttribute('data-copied', '1');
    const prevTitle = btn.getAttribute('title') || '';
    btn.textContent = '';
    btn.appendChild(checkIcon());
    btn.classList.add('copied-check');
    btn.setAttribute('title', 'Copied');
    setTimeout(function () {
      if (!btn.parentNode) { return; } // button was re-rendered away
      btn.textContent = '';
      btn.appendChild(copyIcon());
      btn.classList.remove('copied-check');
      btn.setAttribute('title', prevTitle);
      btn.removeAttribute('data-copied');
    }, 1200);
  }

  function flashCopied(id) {
    flashCopyCheck(app.querySelector(
      '.session-actions button[data-action="copyPrompt"][data-id="' + cssEscape(id) + '"]'
    ));
  }

  function flashFleetCopied() {
    flashCopyCheck(app.querySelector('.body-toolbar button[data-action="copyFleetPrompt"]'));
  }

  function flashBriefing() {
    flashCopyCheck(app.querySelector('.ext-section button[data-action="copyBriefing"]'));
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, '\\$&');
  }

  // ── Event delegation (single listener on #app) ──────────────
  app.addEventListener('click', function (ev) {
    const target = ev.target.closest('[data-action]');
    if (!target) { return; }
    const action = target.getAttribute('data-action');
    const id = target.getAttribute('data-id');
    if (action === 'newSession') {
      // Defense in depth: the disabled attribute (set in render() while a
      // session is 'connecting') already suppresses the click in a real
      // browser, but guard the handler too in case that mechanism isn't hit.
      if (target.disabled || anySessionConnecting()) { return; }
      post({ type: 'newSession' });
    } else if (action === 'copyFleetPrompt') {
      post({ type: 'copyFleetPrompt' });
    } else if (action === 'copyPrompt' && id) {
      post({ type: 'copyPrompt', id: id });
    } else if (action === 'focusSession' && id) {
      post({ type: 'focusSession', id: id });
    } else if (action === 'closeSession' && id) {
      post({ type: 'closeSession', id: id });
    } else if (action === 'toggleAutopilot' && id) {
      const s = (model.sessions || []).find(function (x) { return x.id === id; });
      const currentlyOn = !s || s.autopilot !== false;
      post({ type: 'setAutopilot', id: id, enabled: !currentlyOn });
    } else if (action === 'showTabs') {
      model.view = 'sessions';
      render();
    } else if (action === 'showSettings') {
      model.view = 'settings';
      render();
      post({ type: 'getSettings' });
      post({ type: 'getBookmarks' });
      post({ type: 'getExtensions' });
      post({ type: 'getEnhanceJira' });
      post({ type: 'getLogins' });
    } else if (action === 'toggleCapability' && id) {
      post({ type: 'setCapabilityEnabled', id: id, enabled: target.checked });
    } else if (action === 'toggleBookmarksBarEnabled') {
      post({ type: 'setBookmarksBarEnabled', enabled: target.checked });
    } else if (action === 'toggleFolder' && id) {
      if (expandedFolders.has(id)) { expandedFolders.delete(id); } else { expandedFolders.add(id); }
      render();
    } else if (action === 'addBookmark' || action === 'addFolder') {
      // id here is the parent attr ('root' or a folder id); open the folder so
      // the freshly-shown inline form is visible under it.
      addForm = { parentId: id, kind: action === 'addBookmark' ? 'bookmark' : 'folder' };
      if (id && id !== 'root') { expandedFolders.add(id); }
      renameId = null;
      render();
      focusFirst('.bm-addform .bm-input');
    } else if (action === 'submitAdd') {
      submitAdd();
    } else if (action === 'cancelAdd') {
      addForm = null;
      render();
    } else if (action === 'renameStart' && id) {
      renameId = id;
      addForm = null;
      render();
      focusFirst('.bm-rename-input');
    } else if (action === 'submitRename' && id) {
      submitRename(id);
    } else if (action === 'cancelRename') {
      renameId = null;
      render();
    } else if (action === 'deleteNode' && id) {
      post({ type: 'removeBookmark', id: id });
    } else if (action === 'deleteScript' && id) {
      post({ type: 'deleteScript', name: id });
    } else if (action === 'selfUpdate') {
      // Primary update action: trigger the host's local git-based reinstall
      // pipeline. Guard against double-clicks while an install is in flight.
      if (updateState.status === 'updating') { return; }
      updateState = { status: 'updating' };
      post({ type: 'selfUpdate' });
      render();
    } else if (action === 'checkForUpdate') {
      if (updateState.status === 'checking') { return; } // already in flight
      updateState = { status: 'checking' };
      post({ type: 'checkForUpdate' });
      render();
    } else if (action === 'openReleases') {
      if (updateState.releasesUrl) { post({ type: 'openExternal', url: updateState.releasesUrl }); }
    } else if (action === 'openGithub') {
      post({ type: 'openExternal', url: GITHUB_URL });
    } else if (action === 'toggleSection') {
      // Collapse/expand a Settings section; persisted in the webview vscode state (survives reload).
      const key = target.getAttribute('data-section-key');
      if (key) {
        if (collapsedSections[key]) { delete collapsedSections[key]; } else { collapsedSections[key] = true; }
        saveCollapsed();
        render();
      }
    } else if (action === 'copyBriefing') {
      // Reuse the host clipboard path (vscode.env.clipboard.writeText) the copy-prompt buttons use:
      // post the text, host copies it and echoes { type:'copied', id } back for the flash.
      post({ type: 'copyText', text: EXTENSIONS_BRIEFING, flash: 'ext-briefing' });
    } else if (action === 'toggleExtensionsEnabled') {
      post({ type: 'setExtensionsEnabled', enabled: target.checked });
    } else if (action === 'toggleExtension' && id) {
      post({ type: 'toggleExtension', id: id, enabled: target.checked });
    } else if (action === 'addExtension') {
      extForm = { id: null, name: '', js: '', css: '', matches: '', runAt: 'document_idle', world: 'main', hideFromAgent: false, bridge: false, bridgeHosts: '' };
      render();
      focusFirst('.ext-form input[data-field="name"]');
    } else if (action === 'editExtension' && id) {
      const ex = (model.extensions || []).find(function (e) { return e.id === id; });
      extForm = {
        id: id,
        name: ex ? ex.name : '',
        js: ex ? ex.js : '',
        css: ex ? ex.css : '',
        matches: ex && Array.isArray(ex.matches) ? ex.matches.join('\n') : '',
        runAt: ex && ex.runAt ? ex.runAt : 'document_idle',
        world: ex && ex.world === 'isolated' ? 'isolated' : 'main',
        hideFromAgent: !!(ex && ex.hideFromAgent),
        bridge: !!(ex && ex.bridge),
        bridgeHosts: ex && Array.isArray(ex.bridgeHosts) ? ex.bridgeHosts.join('\n') : ''
      };
      render();
      focusFirst('.ext-form input[data-field="name"]');
    } else if (action === 'submitExtension') {
      submitExtension();
    } else if (action === 'cancelExtension') {
      extForm = null;
      render();
    } else if (action === 'deleteExtension' && id) {
      post({ type: 'removeExtension', id: id });
    } else if (action === 'openEnhanceJira') {
      // Client-side only — model.enhanceJira is already loaded (fetched on 'showSettings' and at
      // boot), so opening the sub-page needs no host round-trip, same as showTabs/showSettings.
      model.view = 'enhancejira';
      render();
    } else if (action === 'closeEnhanceJira') {
      model.view = 'settings';
      render();
    } else if (action === 'toggleEnhanceJiraEnabled') {
      post({ type: 'setEnhanceJiraEnabled', enabled: target.checked });
    } else if (action === 'toggleEnhanceJiraComponent') {
      const key = target.getAttribute('data-ej-key');
      if (key) { post({ type: 'setEnhanceJiraComponent', key: key, value: target.checked }); }
    } else if (action === 'restoreLogins') {
      const origin = target.getAttribute('data-origin');
      if (origin) { post({ type: 'restoreLogins', origin: origin }); }
    } else if (action === 'removeLogins') {
      const origin = target.getAttribute('data-origin');
      if (origin) { post({ type: 'removeLogins', origin: origin }); }
    } else if (action === 'toggleLoginAuto') {
      const origin = target.getAttribute('data-origin');
      if (origin) { post({ type: 'setLoginAutoReinject', origin: origin, value: target.checked }); }
    } else if (action === 'toggleLoginsAuto') {
      // Hands-off master switch — background auto-capture + auto-restore across ALL sites.
      post({ type: 'setAutoAll', value: target.checked });
    } else if (action === 'clearAllLogins') {
      // Full logout — the host wipes live browser cookies + every saved login, then reposts the (now-empty) list.
      post({ type: 'clearAllLogins' });
    }
  });

  // ── Bookmark add/rename submit + focus helpers ──────────────
  function focusFirst(selector) {
    const el = app.querySelector(selector);
    if (el && typeof el.focus === 'function') {
      el.focus();
      if (typeof el.select === 'function') { el.select(); }
    }
  }

  function fieldValue(field) {
    const el = app.querySelector('.bm-addform input[data-field="' + field + '"]');
    return el ? el.value.trim() : '';
  }

  function submitAdd() {
    if (!addForm) { return; }
    const pid = toPid(addForm.parentId);
    if (addForm.kind === 'bookmark') {
      const url = fieldValue('url');
      if (!url) { return; } // a bookmark needs at least a url
      post({ type: 'addBookmark', parentId: pid, title: fieldValue('title'), url: url });
    } else {
      const name = fieldValue('name');
      if (!name) { return; } // a folder needs a name
      post({ type: 'addFolder', parentId: pid, name: name });
    }
    // Optimistically close the form; the host push refreshes the tree.
    addForm = null;
    render();
  }

  function submitRename(id) {
    const inp = app.querySelector('.bm-rename-input');
    const name = inp ? inp.value.trim() : '';
    if (name) { post({ type: 'renameBookmark', id: id, name: name }); }
    renameId = null;
    render();
  }

  // Read the Extensions add/edit form and post the right message (add vs update), then close it;
  // the host push refreshes the list. A blank name is allowed (renders as "Untitled extension").
  function submitExtension() {
    if (!extForm) { return; }
    const nameEl = app.querySelector('.ext-form input[data-field="name"]');
    const jsEl = app.querySelector('.ext-form textarea[data-field="js"]');
    const cssEl = app.querySelector('.ext-form textarea[data-field="css"]');
    const matchesEl = app.querySelector('.ext-form textarea[data-field="matches"]');
    const runAtEl = app.querySelector('.ext-form select[data-field="runAt"]');
    const worldEl = app.querySelector('.ext-form select[data-field="world"]');
    const hideEl = app.querySelector('.ext-form input[data-field="hideFromAgent"]');
    const bridgeEl = app.querySelector('.ext-form input[data-field="bridge"]');
    const hostsEl = app.querySelector('.ext-form textarea[data-field="bridgeHosts"]');
    const name = nameEl ? nameEl.value.trim() : '';
    const js = jsEl ? jsEl.value : '';
    const css = cssEl ? cssEl.value : '';
    const rawMatches = matchesEl ? matchesEl.value : '';
    const runAt = runAtEl && runAtEl.value === 'document_start' ? 'document_start' : 'document_idle';
    const world = worldEl && worldEl.value === 'isolated' ? 'isolated' : 'main';
    const hideFromAgent = !!(hideEl && hideEl.checked);
    const bridge = !!(bridgeEl && bridgeEl.checked);
    const rawHosts = hostsEl ? hostsEl.value : '';
    const bridgeHosts = rawHosts.split('\n').map(function (s) { return s.trim(); }).filter(function (s) { return s.length; });
    // Preserve every typed field (raw match/hosts text) across an error re-render.
    const keep = { id: extForm.id, name: name, js: js, css: css, matches: rawMatches, runAt: runAt, world: world, hideFromAgent: hideFromAgent, bridge: bridge, bridgeHosts: rawHosts };
    // One pattern per line; trim and drop blanks. Validate each; a malformed one blocks the save
    // with an inline error (and we preserve the user's typed values across the re-render).
    const lines = rawMatches.split('\n').map(function (s) { return s.trim(); }).filter(function (s) { return s.length; });
    const bad = lines.filter(function (p) { return !isValidMatchPattern(p); });
    if (bad.length) {
      extForm = Object.assign({}, keep, { error: 'Invalid match pattern: ' + bad[0] });
      render();
      return;
    }
    // Best-effort JS syntax pre-check. Main-world bodies are inlined into ONE shared bootstrap, so a
    // PARSE error in one body would break every main extension's JS/CSS/reconcile — contain it here.
    // This is a parse guard, NOT a sandbox: new Function only surfaces SyntaxErrors; runtime errors
    // are already per-body try/caught downstream. This webview's CSP (script-src 'nonce-…', no
    // 'unsafe-eval') refuses Function construction, throwing an EvalError rather than parsing — so we
    // act ONLY on a genuine SyntaxError and swallow anything else. Under strict CSP that makes this a
    // safe no-op that never blocks a save; it activates automatically if the CSP ever allows Function.
    // The AUTHORITATIVE syntax guard runs host-side in panel.js (addExtension/updateExtension →
    // _jsSyntaxError), which parses without CSP and bounces an `extensionError` back if it fails.
    if (js.trim()) {
      let jsSyntaxError = null;
      try {
        new Function(js); // eslint-disable-line no-new-func
      } catch (e) {
        if (e instanceof SyntaxError) { jsSyntaxError = e.message || 'invalid JavaScript'; }
      }
      if (jsSyntaxError) {
        extForm = Object.assign({}, keep, { error: 'JS syntax error: ' + jsSyntaxError });
        render();
        return;
      }
    }
    const fields = { name: name, js: js, css: css, matches: lines, runAt: runAt, world: world, hideFromAgent: hideFromAgent, bridge: bridge, bridgeHosts: bridgeHosts };
    if (extForm.id) {
      post({ type: 'updateExtension', id: extForm.id, fields: fields });
    } else {
      post({ type: 'addExtension', name: name, js: js, css: css, matches: lines, runAt: runAt, world: world, hideFromAgent: hideFromAgent, bridge: bridge, bridgeHosts: bridgeHosts });
    }
    extForm = null;
    render();
  }

  // Delegated 'input' (debounced) for the free-text areas: the top-level
  // instruction and each capability's per-capability instruction override.
  app.addEventListener('input', function (ev) {
    const target = ev.target;
    if (!target || typeof target.matches !== 'function') { return; }
    if (target.matches('textarea[data-action="setInstruction"]')) {
      const value = target.value;
      debounce('setInstruction', function () {
        post({ type: 'setInstruction', value: value });
      });
    } else if (target.matches('textarea.ext-js') || target.matches('textarea.ext-css') || target.matches('textarea.ext-matches') || target.matches('textarea.ext-bridgehosts')) {
      // Extensions JS/CSS/match-patterns editors: auto-grow only (form is submit-based, nothing posted).
      autoSizeInstruction(target);
    } else if (target.matches('textarea[data-action="setCapabilityInstruction"]')) {
      autoSizeInstruction(target);
      const id = target.getAttribute('data-id');
      const value = target.value;
      debounce('setCapabilityInstruction:' + id, function () {
        post({ type: 'setCapabilityInstruction', id: id, value: value });
      });
    }
  });

  // Delegated 'change' for the per-row script picker: fire the run request,
  // then snap the select back to its placeholder (it's a trigger, not state).
  app.addEventListener('change', function (ev) {
    const target = ev.target;
    if (!target || typeof target.matches !== 'function') { return; }
    if (target.matches('select[data-action="runScript"]')) {
      const id = target.getAttribute('data-id');
      const name = target.value;
      if (id && name) {
        post({ type: 'runScript', instance: id, name: name });
      }
      target.value = '';
    }
  });

  // Enter confirms / Escape cancels the bookmark add-form and rename box.
  app.addEventListener('keydown', function (ev) {
    const t = ev.target;
    if (!t || typeof t.matches !== 'function') { return; }
    if (t.matches('.bm-addform .bm-input')) {
      if (ev.key === 'Enter') { ev.preventDefault(); submitAdd(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); addForm = null; render(); }
    } else if (t.matches('.bm-rename-input')) {
      if (ev.key === 'Enter') { ev.preventDefault(); submitRename(renameId); }
      else if (ev.key === 'Escape') { ev.preventDefault(); renameId = null; render(); }
    }
  });

  // ── Bookmark drag-and-drop (native HTML5 DnD, delegated on #app) ───────────
  // Drop ONTO a folder row → move into that folder at its end. Drop on a
  // dropline between siblings → reorder to that parent+index. Droplines/folders
  // whose id is the dragged node or a descendant are refused (no self-nesting).
  function clearHover() {
    if (hoverEl) { hoverEl.classList.remove('bm-drop-active', 'bm-drop-into'); hoverEl = null; }
  }
  function cleanupDrag() {
    clearHover();
    const d = app.querySelector('.bm-dragging');
    if (d) { d.classList.remove('bm-dragging'); }
    draggingId = null;
    draggingIsFolder = false;
    invalidIds = null;
  }

  app.addEventListener('dragstart', function (ev) {
    const row = ev.target && ev.target.closest ? ev.target.closest('.bm-row') : null;
    if (!row) { return; }
    const id = row.getAttribute('data-id');
    draggingId = id;
    invalidIds = new Set();
    const node = findNode(id);
    draggingIsFolder = node ? node.type === 'folder' : row.getAttribute('data-node-type') === 'folder';
    if (node) { collectIds(node, invalidIds); } else { invalidIds.add(id); }
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', id);
    }
    row.classList.add('bm-dragging');
  });

  app.addEventListener('dragover', function (ev) {
    if (!draggingId || !ev.target || !ev.target.closest) { return; }
    const line = ev.target.closest('.bm-dropline');
    if (line) {
      const pid = line.getAttribute('data-drop-parent');
      // A non-root parent is a folder — a dragged folder may only land at root.
      if (pid !== 'root' && (draggingIsFolder || (invalidIds && invalidIds.has(pid)))) { return; }
      ev.preventDefault();
      if (ev.dataTransfer) { ev.dataTransfer.dropEffect = 'move'; }
      if (hoverEl !== line) { clearHover(); hoverEl = line; line.classList.add('bm-drop-active'); }
      return;
    }
    const folder = ev.target.closest('.bm-row.bm-folder');
    if (folder) {
      const fid = folder.getAttribute('data-id');
      // Bookmarks may drop into a folder; folders may not nest inside folders.
      if (draggingIsFolder || (invalidIds && invalidIds.has(fid))) { return; }
      ev.preventDefault();
      if (ev.dataTransfer) { ev.dataTransfer.dropEffect = 'move'; }
      if (hoverEl !== folder) { clearHover(); hoverEl = folder; folder.classList.add('bm-drop-into'); }
      return;
    }
    clearHover();
  });

  app.addEventListener('drop', function (ev) {
    if (!draggingId || !ev.target || !ev.target.closest) { return; }
    const line = ev.target.closest('.bm-dropline');
    if (line) {
      const pid = line.getAttribute('data-drop-parent');
      // Root always accepts; a folder parent accepts only non-folder, non-self drops.
      const okParent = pid === 'root'
        ? true
        : (!draggingIsFolder && (!invalidIds || !invalidIds.has(pid)));
      if (okParent) {
        ev.preventDefault();
        post({
          type: 'moveBookmark', id: draggingId,
          newParentId: toPid(pid),
          index: parseInt(line.getAttribute('data-drop-index'), 10) || 0
        });
      }
      cleanupDrag();
      return;
    }
    const folder = ev.target.closest('.bm-row.bm-folder');
    if (folder) {
      const fid = folder.getAttribute('data-id');
      if (!draggingIsFolder && (!invalidIds || !invalidIds.has(fid))) {
        ev.preventDefault();
        const fnode = findNode(fid);
        post({
          type: 'moveBookmark', id: draggingId,
          newParentId: fid,
          index: fnode && fnode.children ? fnode.children.length : 0
        });
      }
      cleanupDrag();
      return;
    }
    cleanupDrag();
  });

  app.addEventListener('dragend', function () { cleanupDrag(); });

  // Keep saved scroll fresh while the user scrolls the list.
  app.addEventListener(
    'scroll',
    function (ev) {
      if (ev.target && ev.target.classList && ev.target.classList.contains('session-table')) {
        saveScroll(ev.target.scrollTop);
      }
    },
    true
  );

  // ── Host → webview messages ─────────────────────────────────
  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') { return; }
    if (msg.type === 'state') {
      // Merge in place — a session-state push must not clobber model.settings
      // or knock the user off whichever view (sessions/settings/enhancejira)
      // they're on: model.view is simply never assigned here, so all three
      // values survive a state push untouched (see the third model.view value,
      // 'enhancejira', added by enhanceJiraView() below).
      model.sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
      model.port = msg.port != null ? msg.port : model.port;
      model.scripts = Array.isArray(msg.scripts) ? msg.scripts : (model.scripts || []);
      model.version = msg.version != null ? msg.version : model.version;
      render();
    } else if (msg.type === 'settings' && msg.settings) {
      // Likewise: a settings push must not touch model.sessions/view.
      model.settings = msg.settings;
      render();
    } else if (msg.type === 'bookmarks' && msg.tree) {
      // Additive: store the host's bookmark tree (+ the persisted bar-enabled flag,
      // defaulting true) without touching sessions/settings/view or the open
      // add-form/rename state.
      model.bookmarks = msg.tree;
      model.bookmarksBarEnabled = msg.barEnabled !== undefined ? !!msg.barEnabled : false;
      render();
    } else if (msg.type === 'extensions') {
      // Additive: store the host's extensions list + the master-enable flag (defaulting true)
      // without touching sessions/settings/view or the open extension add/edit form state.
      model.extensions = Array.isArray(msg.items) ? msg.items : [];
      model.extensionsEnabled = msg.extensionsEnabled !== undefined ? !!msg.extensionsEnabled : true;
      render();
    } else if (msg.type === 'enhanceJira') {
      // Additive: store the host's EnhanceJira master-enable flag + per-component hide state
      // without touching sessions/settings/view or any other section's state.
      const c = msg.components || {};
      model.enhanceJira = {
        enabled: msg.enabled !== undefined ? !!msg.enabled : true,
        components: {
          version: !!c.version,
          epic: !!c.epic,
          type: !!c.type,
          quickFilters: !!c.quickFilters,
          search: !!c.search,
          assignee: !!c.assignee,
          more: !!c.more,
          completeSprint: !!c.completeSprint,
          sprintDetails: !!c.sprintDetails,
          group: !!c.group,
          viewSettings: !!c.viewSettings,
          moreActions: !!c.moreActions,
          shareButton: !!c.shareButton,
          feedbackButton: !!c.feedbackButton,
          addPeople: !!c.addPeople,
          boardActionsMenu: !!c.boardActionsMenu,
          moveSprintInsights: !!c.moveSprintInsights,
          removeToolbarGap: !!c.removeToolbarGap,
          showBoardAvatars: c.showBoardAvatars !== undefined ? !!c.showBoardAvatars : true
        }
      };
      render();
    } else if (msg.type === 'logins') {
      // Additive: store the host's saved-login METADATA list (origin, cookieCount, savedAt,
      // autoReinject) — never cookie values — plus the hands-off "auto for ALL sites" master
      // flag, without touching sessions/settings/view.
      model.logins = Array.isArray(msg.items) ? msg.items : [];
      model.loginsAuto = !!msg.autoAll;
      render();
    } else if (msg.type === 'extensionError') {
      // The host refused an add/update (authoritative JS syntax guard — see panel.js). Re-open the
      // add/edit form with the operator's values + the inline error, reconciling the optimistic
      // close-on-submit so they can see why the save didn't take and fix it. matches arrives as the
      // parsed array; the form's textarea wants one pattern per line.
      extForm = {
        id: msg.id || null,
        name: msg.name || '',
        js: msg.js || '',
        css: msg.css || '',
        matches: Array.isArray(msg.matches) ? msg.matches.join('\n') : (msg.matches || ''),
        runAt: msg.runAt === 'document_start' ? 'document_start' : 'document_idle',
        world: msg.world === 'isolated' ? 'isolated' : 'main',
        hideFromAgent: !!msg.hideFromAgent,
        bridge: !!msg.bridge,
        bridgeHosts: Array.isArray(msg.bridgeHosts) ? msg.bridgeHosts.join('\n') : (msg.bridgeHosts || ''),
        error: msg.error || 'Save failed'
      };
      render();
    } else if (msg.type === 'updateStatus') {
      // Store the host's answer to our checkForUpdate post; keep it outside
      // model (see updateState above) so it isn't clobbered by state/settings
      // pushes. "Update available" persists until acted on; "up to date" and
      // "error" are transient and fall back to the idle 📦-badge after a beat
      // so the user can dismiss/retry without a stuck banner.
      if (msg.error) {
        updateState = { status: 'error', error: msg.error, current: msg.current };
        render();
        setTimeout(function () {
          if (updateState.status === 'error') { updateState = { status: 'idle' }; render(); }
        }, 4000);
      } else if (msg.updateAvailable) {
        updateState = { status: 'updateAvailable', latest: msg.latest, releasesUrl: msg.releasesUrl, current: msg.current };
        render();
      } else if (msg.upToDate) {
        updateState = { status: 'upToDate', current: msg.current };
        render();
        setTimeout(function () {
          if (updateState.status === 'upToDate') { updateState = { status: 'idle' }; render(); }
        }, 4000);
      } else {
        updateState = { status: 'idle' };
        render();
      }
    } else if (msg.type === 'selfUpdateStatus') {
      // Host progress for the local git-based reinstall. 'running' keeps the badge
      // in its spinner state; 'installed'/'upToDate'/'error' are terminal and fall
      // back to the idle version badge after a beat so the control never sticks.
      if (msg.status === 'running') {
        updateState = { status: 'updating' };
        render();
      } else if (msg.status === 'installed') {
        updateState = { status: 'updated', latest: msg.version };
        render();
        setTimeout(function () {
          if (updateState.status === 'updated') { updateState = { status: 'idle' }; render(); }
        }, 6000);
      } else if (msg.status === 'upToDate') {
        updateState = { status: 'upToDate', current: msg.current };
        render();
        setTimeout(function () {
          if (updateState.status === 'upToDate') { updateState = { status: 'idle' }; render(); }
        }, 4000);
      } else if (msg.status === 'error') {
        updateState = { status: 'error', error: msg.error };
        render();
        setTimeout(function () {
          if (updateState.status === 'error') { updateState = { status: 'idle' }; render(); }
        }, 5000);
      }
    } else if (msg.type === 'copied') {
      // The fleet copy and the extensions-briefing copy reuse this same postback but have no real
      // session id — route the briefing sentinel to its own flash, then the fleet fallback.
      if (msg.id === 'ext-briefing') {
        flashBriefing();
      } else {
        const isRow = msg.id && model.sessions.some(function (s) { return s.id === msg.id; });
        if (isRow) { flashCopied(msg.id); } else { flashFleetCopied(); }
      }
    }
  });

  // ── Boot ────────────────────────────────────────────────────
  render();
  post({ type: 'ready' });
  post({ type: 'getSettings' });
  post({ type: 'getBookmarks' });
  post({ type: 'getExtensions' });
  post({ type: 'getEnhanceJira' });
  post({ type: 'getLogins' });
})();
