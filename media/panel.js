// Project Steersman — session-manager webview front-end.
// Plain ES2017, no modules, no bundler. Wrapped in an IIFE to keep the global
// scope clean. Renders everything inside <div id="app"> and speaks the host
// message protocol via acquireVsCodeApi()/postMessage.
(function () {
  'use strict';

  // ── VS Code API ─────────────────────────────────────────────
  const vscode = acquireVsCodeApi();

  // ── State ───────────────────────────────────────────────────
  /** @type {{sessions: Array<{id:string,state:string,url:string,activity:(Object|null)}>, port: (number|string|null), view: ('sessions'|'settings'), settings: (Object|null), scripts: Array<{name:string}>, bookmarks: (Object|null), bookmarksBarEnabled: boolean}} */
  let model = { sessions: [], port: null, view: 'sessions', settings: null, scripts: [], bookmarks: null, bookmarksBarEnabled: true };

  // ── Bookmark-manager UI state — kept at module scope so it survives the
  // full-rebuild render(): which folders are open, which add-form/rename is
  // active, and the in-flight drag's id + its invalid drop targets. ──────────
  const expandedFolders = new Set();
  let addForm = null;     // { parentId: 'root'|<folderId>, kind: 'bookmark'|'folder' }
  let renameId = null;    // id of the node currently being renamed inline
  let draggingId = null;  // id of the node being dragged (null when idle)
  let draggingIsFolder = false; // whether the in-flight drag is a folder (folders may only land at root)
  let invalidIds = null;  // Set of ids the dragged node may NOT drop into (itself + descendants)
  let hoverEl = null;     // current highlighted drop target (dropline or folder row)

  // Debounce timers for textarea edits, keyed by action (+ capability id). ──
  const debounceTimers = {};
  function debounce(key, fn, delay) {
    if (debounceTimers[key]) { clearTimeout(debounceTimers[key]); }
    debounceTimers[key] = setTimeout(function () {
      delete debounceTimers[key];
      fn();
    }, delay || 300);
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
      ariaLabel: 'Run script'
    });
    const placeholder = h('option', {}, scripts.length ? 'Run script…' : 'No scripts');
    placeholder.value = '';
    placeholder.disabled = true;
    select.appendChild(placeholder);
    scripts.forEach(function (sc) {
      const opt = h('option', {}, sc.name);
      opt.value = sc.name;
      select.appendChild(opt);
    });
    select.value = '';
    if (!scripts.length) { select.disabled = true; }
    if (manual) {
      select.disabled = true;
      select.title = 'Manual mode — scripts disabled for this window';
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
  function railTab(label, action, view) {
    const cls = 'rail-item' + (model.view === view ? ' active' : '');
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

  function bookmarksSection() {
    const section = h('div', { className: 'bm-section' });
    const header = h(
      'div', { className: 'bm-section-header' },
      h('span', { className: 'settings-section-title' }, 'Bookmarks'),
      h('div', { className: 'bm-root-actions' }, addBtn('root', 'bookmark'), addBtn('root', 'folder'))
    );
    section.appendChild(header);
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

  function settingsView() {
    const wrap = h('div', { className: 'settings-body' });
    const s = model.settings;

    if (!s) {
      wrap.appendChild(h('div', { className: 'settings-loading' }, 'Loading settings…'));
      return wrap;
    }

    wrap.appendChild(h('div', { className: 'settings-section-title' }, 'Instruction'));
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

    wrap.appendChild(h('div', { className: 'settings-section-title' }, 'Capabilities'));
    const capList = h('div', { className: 'capability-list' });
    (s.capabilities || []).forEach(function (cap) {
      capList.appendChild(capabilityRow(cap));
    });
    wrap.appendChild(capList);

    wrap.appendChild(bookmarksSection());

    wrap.appendChild(
      h('div', { className: 'settings-section-title' }, 'Composed instruction (preview)')
    );
    wrap.appendChild(h('pre', { className: 'settings-preview' }, s.composedPreview || ''));

    return wrap;
  }

  // ── Render ──────────────────────────────────────────────────
  const app = document.getElementById('app');

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

    if (model.view === 'settings') {
      const body = settingsView();
      app.appendChild(body);
      // Restore the captured scroll position (synchronously, then once more on
      // the next frame in case layout wasn't settled) so re-renders don't jump.
      body.scrollTop = prevSettingsScroll;
      requestAnimationFrame(function () { body.scrollTop = prevSettingsScroll; });
      return;
    }

    // Tabs view: a slim body toolbar with the ＋ New Session box button above
    // the list (moved out of the rail).
    const newBtn = h(
      'button',
      {
        className: 'icon-button btn-add',
        type: 'button',
        dataAction: 'newSession',
        title: 'New Session',
        ariaLabel: 'New Session'
      },
      '＋'
    );
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

  // ── Copied! flash on a row's copy button ────────────────────
  function flashCopied(id) {
    const btn = app.querySelector(
      '.session-actions button[data-action="copyPrompt"][data-id="' + cssEscape(id) + '"]'
    );
    if (!btn) { return; }
    const actions = btn.parentNode;
    if (actions.querySelector('.copied-flash')) { return; }
    const flash = h('span', { className: 'copied-flash' }, 'Copied!');
    actions.insertBefore(flash, actions.firstChild);
    setTimeout(function () {
      if (flash.parentNode) { flash.parentNode.removeChild(flash); }
    }, 1200);
  }

  // ── Copied! flash on the fleet copy button (rail-level, no session id) ──
  function flashFleetCopied() {
    const btn = app.querySelector('.body-toolbar button[data-action="copyFleetPrompt"]');
    if (!btn) { return; }
    const toolbar = btn.parentNode;
    if (toolbar.querySelector('.copied-flash')) { return; }
    const flash = h('span', { className: 'copied-flash' }, 'Copied!');
    toolbar.insertBefore(flash, btn);
    setTimeout(function () {
      if (flash.parentNode) { flash.parentNode.removeChild(flash); }
    }, 1200);
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
    } else if (target.matches('textarea[data-action="setCapabilityInstruction"]')) {
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
      // or knock the user off whichever view (sessions/settings) they're on.
      model.sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
      model.port = msg.port != null ? msg.port : model.port;
      model.scripts = Array.isArray(msg.scripts) ? msg.scripts : (model.scripts || []);
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
      model.bookmarksBarEnabled = msg.barEnabled !== undefined ? !!msg.barEnabled : true;
      render();
    } else if (msg.type === 'copied') {
      // The fleet copy reuses this same postback but has no real session id
      // (undefined/null/blank, or a sentinel that matches no row) — route
      // those to the rail flash instead of the per-row one.
      const isRow = msg.id && model.sessions.some(function (s) { return s.id === msg.id; });
      if (isRow) { flashCopied(msg.id); } else { flashFleetCopied(); }
    }
  });

  // ── Boot ────────────────────────────────────────────────────
  render();
  post({ type: 'ready' });
  post({ type: 'getSettings' });
  post({ type: 'getBookmarks' });
})();
