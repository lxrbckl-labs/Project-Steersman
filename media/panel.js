// Project Steersman — session-manager webview front-end.
// Plain ES2017, no modules, no bundler. Wrapped in an IIFE to keep the global
// scope clean. Renders everything inside <div id="app"> and speaks the host
// message protocol via acquireVsCodeApi()/postMessage.
(function () {
  'use strict';

  // ── VS Code API ─────────────────────────────────────────────
  const vscode = acquireVsCodeApi();

  // ── State ───────────────────────────────────────────────────
  /** @type {{sessions: Array<{id:string,state:string,url:string,activity:(Object|null)}>, port: (number|string|null), view: ('sessions'|'settings'), settings: (Object|null), scripts: Array<{name:string}>}} */
  let model = { sessions: [], port: null, view: 'sessions', settings: null, scripts: [] };

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
    return svgIcon([
      'M4 4V2.5C4 1.67 4.67 1 5.5 1h8C14.33 1 15 1.67 15 2.5v8c0 .83-.67 1.5-1.5 1.5H12v1.5c0 .83-.67 1.5-1.5 1.5h-8C1.67 14 1 13.33 1 12.5v-8C1 3.67 1.67 3 2.5 3H4V4zm1 0h6.5C12.33 4 13 4.67 13 5.5V11h.5c.28 0 .5-.22.5-.5v-8c0-.28-.22-.5-.5-.5h-8c-.28 0-.5.22-.5.5V4zm-2.5 0c-.28 0-.5.22-.5.5v8c0 .28.22.5.5.5h8c.28 0 .5-.22.5-.5v-8c0-.28-.22-.5-.5-.5h-8z'
    ]);
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

  // ── Per-row script picker — an operator control, never gated on a ──
  // capability toggle. Fires 'runScript' on change, then resets to the
  // placeholder so it reads as a one-shot trigger rather than a selection.
  function scriptPicker(s) {
    const scripts = model.scripts || [];
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
  function sessionRow(s) {
    const connected = s.state === 'connected';
    const secondary = connected && s.url ? s.url : (s.state || 'unknown');

    const dot = h('span', { className: 'dot ' + (s.state || 'disconnected') });

    const body = h(
      'div',
      { className: 'session-body' },
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
      actionButton(s.id, 'copyPrompt', 'Copy prompt', copyIcon()),
      actionButton(s.id, 'focusSession', 'Focus tab', focusIcon()),
      actionButton(s.id, 'closeSession', 'Close session', closeIcon(), 'danger')
    );

    return h('div', { className: 'session-row', dataId: s.id }, dot, body, scriptsCluster, actions);
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
      rows: '3',
      ariaLabel: 'Instruction',
      placeholder: 'Instruction for Claude…'
    });
    instructionArea.value = s.instruction || '';
    wrap.appendChild(instructionArea);

    wrap.appendChild(h('div', { className: 'settings-section-title' }, 'Capabilities'));
    const capList = h('div', { className: 'capability-list' });
    (s.capabilities || []).forEach(function (cap) {
      capList.appendChild(capabilityRow(cap));
    });
    wrap.appendChild(capList);

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
      app.appendChild(settingsView());
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
    app.appendChild(h('div', { className: 'body-toolbar' }, newBtn));

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
    } else if (action === 'copyPrompt' && id) {
      post({ type: 'copyPrompt', id: id });
    } else if (action === 'focusSession' && id) {
      post({ type: 'focusSession', id: id });
    } else if (action === 'closeSession' && id) {
      post({ type: 'closeSession', id: id });
    } else if (action === 'showTabs') {
      model.view = 'sessions';
      render();
    } else if (action === 'showSettings') {
      model.view = 'settings';
      render();
      post({ type: 'getSettings' });
    } else if (action === 'toggleCapability' && id) {
      post({ type: 'setCapabilityEnabled', id: id, enabled: target.checked });
    }
  });

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
    } else if (msg.type === 'copied') {
      flashCopied(msg.id);
    }
  });

  // ── Boot ────────────────────────────────────────────────────
  render();
  post({ type: 'ready' });
  post({ type: 'getSettings' });
})();
