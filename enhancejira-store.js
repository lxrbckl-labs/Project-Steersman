// Global, persisted config for the "EnhanceJira" feature: a fixed set of CSS selectors that can
// be individually hidden on a live Jira board, gated behind a master enable flag. Backed by VS
// Code globalState so it's shared across every window. Mirrors ExtensionsStore's discipline:
// normalize on read, persist immediately on every mutation, throw-free throughout.

// globalState key for the master "EnhanceJira" enable flag. Defaults ON, matching
// ExtensionsStore's ENABLED_KEY default (the per-component flags below are the primary gate).
const ENABLED_KEY = 'steersman.enhanceJiraEnabled';

// globalState key for the per-component visibility map. Per-key defaults come from DEFAULTS below
// (the original 7 filter hides default false; the board-action hides and the move feature default
// true) so a saved state predating a key resolves that key to its intended default.
const COMPONENTS_KEY = 'steersman.enhanceJira';

// The toggleable Jira board components and the CSS selector that hides each one. Verbatim,
// validated against a live Jira board — do not alter. The first 7 are filter-bar hides; the next 5
// are board-action (header) hides; the next 2 are the board header's top-right icon-cluster hides
// (share/feedback — insights + fullscreen in that same cluster are deliberately not hideable); the
// last 2 are the title-bar controls (add people / board actions menu) right of the board title. All
// 16 are display:none hides joined by composeCss().
const SELECTORS = {
  version: 'li:has([data-testid="filters.common.ui.list.version-filter"])',
  epic: 'li:has([data-testid="filters.common.ui.list.epic-filter"])',
  type: 'li:has([data-testid="filters.common.ui.list.type-filter"])',
  quickFilters: 'li:has([data-testid="filters.common.ui.list.quick-filters-filter"])',
  more: 'li:has([data-testid="filters.common.ui.overflow-handler.trigger-container"])',
  search: '[data-testid="software-filters.ui.stateless.search-field-container"]',
  assignee: '[data-testid="filters.ui.filters.assignee.stateless.assignee-filter"]',
  completeSprint: '[data-testid="software-board.header.complete-sprint-button"]',
  sprintDetails:
    '[data-testid="software-board.header.sprint-controls.sprint-details.trigger-button.icon-button"]',
  group: '[data-testid="software-board.header.controls-bar.swimlane-switch"]',
  viewSettings: '[data-testid="software-view-settings.ui.view-settings-button.responsive-button"]',
  moreActions: '[data-testid="software-board.header.menu.icon-button"]',
  shareButton: '#po-spotlight-share-button',
  feedbackButton: '[data-testid="feedback-button.horizontal-nav-feedback-button"]',
  addPeople: '[data-testid="invite-people.ui.navigation-add-people-button.trigger"]',
  boardActionsMenu: '[data-testid="navigation-board-action-menu.ui.dropdown"]',
};

// Keys that map to a CSS hide (the 16 entries in SELECTORS).
const SELECTOR_KEYS = Object.keys(SELECTORS);

// The move feature: a boolean component that is NOT a CSS hide — when on, injected JS relocates the
// Sprint-insights button into the board header's right-side action-icon cluster and keeps it there
// across re-renders.
const MOVE_KEY = 'moveSprintInsights';

// The gap feature: a boolean component that is NOT a per-element hide — when on, composeCss appends
// GAP_RULE, which collapses the empty toolbar wrapper left behind once the board-action controls are
// hidden (otherwise its container keeps occupying a ~56px band between the header and the columns).
const GAP_KEY = 'removeToolbarGap';

// The avatars feature: a boolean component that is NOT a CSS hide — when on, injected JS hides Jira's
// capped assignee filter and renders a custom strip of every board member's avatar next to the board
// title (managed by composeJs's __ejAvatars singleton).
const SHOW_AVATARS_KEY = 'showBoardAvatars';

// The PR-coloring feature: a boolean component that is NOT a CSS hide — when on, injected JS colors the
// board's Review-column cards by their Bitbucket PR approval state via Jira's same-origin dev-status API
// (managed by composeJs's __ejPrColor singleton).
const PR_COLORING_KEY = 'prColoring';

// Every known component key handled by this store: the 16 CSS-hide keys plus the move, gap, avatars,
// and PR-coloring keys.
const COMPONENT_KEYS = SELECTOR_KEYS.concat(MOVE_KEY, GAP_KEY, SHOW_AVATARS_KEY, PR_COLORING_KEY);

// Per-key defaults for missing/absent storage. The original 7 filter hides stay off by default; the
// 5 board-action hides, the 2 header-icon-cluster hides, the 2 title-bar hides, and the
// insights-move feature are applied by default (operator preference).
const DEFAULTS = {
  version: false,
  epic: false,
  type: false,
  quickFilters: false,
  more: false,
  search: false,
  assignee: false,
  completeSprint: true,
  sprintDetails: true,
  group: true,
  viewSettings: true,
  moreActions: true,
  shareButton: true,
  feedbackButton: true,
  addPeople: true,
  boardActionsMenu: true,
  moveSprintInsights: true,
  removeToolbarGap: true,
  showBoardAvatars: true,
  prColoring: true,
};

// Selectors used by the injected insights-move manager (composeJs). Verbatim, validated live. The
// button is inserted as the first child of the right-side action-icon cluster, resolved as the
// fullscreen button's parent (preferred), the feedback button's parent (fallback), or the header
// row (last-resort fallback).
const INSIGHTS_SELECTOR = '[data-testid="insights-show-insights-button.ui.insights-button"]';
const FULLSCREEN_SELECTOR = '[data-testid="platform.ui.fullscreen-button.fullscreen-button"]';
const FEEDBACK_SELECTOR = '[data-testid="feedback-button.horizontal-nav-feedback-button"]';
const MOVE_TARGET_SELECTOR = '[data-testid="horizontal-nav-header.ui.board-header.header"]';

// Selectors used by the injected avatars manager (composeJs). Verbatim, validated live. The native
// assignee filter (capped ~5 faces + "+N") is hidden and replaced by a custom strip built from the
// complete roster: inline avatar entries plus the roster scraped from the show-more overflow menu.
// The strip is anchored next to the board title heading inside the header row (board-name-agnostic).
const AVATAR_FILTER_SELECTOR =
  '[data-testid="filters.ui.filters.assignee.stateless.assignee-filter"]';
const AVATAR_SHOWMORE_SELECTOR =
  '[data-testid="filters.ui.filters.assignee.stateless.show-more-button.assignee-filter-show-more"]';
const AVATAR_ENTRY_SELECTOR =
  '[data-testid="filters.ui.filters.assignee.stateless.avatar.assignee-filter-avatar"]';
const AVATAR_HEADER_SELECTOR = '[data-testid="horizontal-nav-header.ui.board-header.header"]';
const AVATAR_CARD_SELECTOR = '[data-testid="board.common.fields.assignee-field-static.avatar"]';

// CSS rule (verbatim, validated live) that composeCss appends when removeToolbarGap is on: collapses
// the empty wrapper around the hidden controls-bar so no ~56px gap remains below the board header.
const GAP_RULE =
  'div:has(> div > [data-testid="software-board.header.controls-bar"]){display:none !important;}';

// globalState key for the PR-coloring minimum-approvals threshold (its own key so it persists like the
// flags but as a number). Missing/corrupt storage resolves to DEFAULT_MIN_APPROVALS; setter clamps 1–20.
const MIN_APPROVALS_KEY = 'steersman.enhanceJiraMinApprovals';
const DEFAULT_MIN_APPROVALS = 3;

// Config baked into the injected PR-color manager (composeJs). Card selector + approval-state colors are
// verbatim/validated live; BOTS is the default reviewer-name exclude list (bot approvals don't count).
// The colors are SOLID full-card surface tints (not a left bar): opaque values that read clearly on the
// dark theme while preserving the card's rounded corners (applied to the card's surface div).
const PR_CARD_SELECTOR = '[data-testid="platform-board-kit.ui.card.card"]';
const PR_GREEN = 'rgb(30, 107, 75)';
const PR_RED = 'rgb(139, 46, 40)';
const PR_BOTS = ['Code Rabbit'];

class EnhanceJiraStore {
  // globalState: a VS Code Memento (context.globalState), same shape as ExtensionsStore's ctor.
  // Nothing to load/normalize eagerly here (unlike ExtensionsStore's list) since both pieces of
  // state are simple flags read fresh from storage on each access.
  constructor(globalState) {
    this._globalState = globalState;
  }

  // The master enable flag, defaulting true when nothing is stored (mirrors ExtensionsStore's
  // getExtensionsEnabled).
  _getEnabled() {
    let stored;
    try {
      stored = this._globalState && this._globalState.get(ENABLED_KEY);
    } catch {
      stored = undefined;
    }
    return stored === undefined ? true : !!stored;
  }

  // Raw component map from storage, normalized to exactly the known keys, each resolving to
  // `saved[key] ?? DEFAULTS[key]` so keys absent from a pre-existing saved state fall back to their
  // intended default (board-action hides + move on, filter hides off). Corrupt storage → all
  // defaults rather than leaving a broken shape.
  _getComponents() {
    let stored;
    try {
      stored = this._globalState && this._globalState.get(COMPONENTS_KEY);
    } catch {
      stored = null;
    }
    const src = stored && typeof stored === 'object' ? stored : {};
    const out = {};
    for (const key of COMPONENT_KEYS) out[key] = !!(src[key] ?? DEFAULTS[key]);
    return out;
  }

  // The PR-coloring minimum-approvals threshold, coerced to an integer and clamped 1–20, defaulting to
  // DEFAULT_MIN_APPROVALS when nothing sane is stored (mirrors _getEnabled's throw-free read).
  _getMinApprovals() {
    let stored;
    try {
      stored = this._globalState && this._globalState.get(MIN_APPROVALS_KEY);
    } catch {
      stored = undefined;
    }
    const n = Math.round(Number(stored));
    if (!Number.isFinite(n)) return DEFAULT_MIN_APPROVALS;
    return Math.min(20, Math.max(1, n));
  }

  // Full state snapshot: the master flag, all component flags, and the PR-coloring approval threshold,
  // safe to serialize. Shape: { enabled, components:{...}, prMinApprovals }.
  getState() {
    return {
      enabled: this._getEnabled(),
      components: this._getComponents(),
      prMinApprovals: this._getMinApprovals(),
    };
  }

  // Persist the master enable flag, coercing to a plain boolean. Fire-and-forget; swallows
  // storage errors so a bad Memento can never throw.
  setEnabled(value) {
    try {
      return this._globalState && this._globalState.update(ENABLED_KEY, !!value);
    } catch {
      return undefined;
    }
  }

  // Persist the PR-coloring approval threshold, coercing to an integer and clamping 1–20 (falling back
  // to DEFAULT_MIN_APPROVALS for NaN). Fire-and-forget; swallows storage errors like the other setters.
  setMinApprovals(n) {
    let v = Math.round(Number(n));
    if (!Number.isFinite(v)) v = DEFAULT_MIN_APPROVALS;
    v = Math.min(20, Math.max(1, v));
    try {
      return this._globalState && this._globalState.update(MIN_APPROVALS_KEY, v);
    } catch {
      return undefined;
    }
  }

  // Persist one component's checked flag. Unknown keys are ignored safely (throw-free, no-op) —
  // callers never need to pre-validate the key.
  setComponent(key, value) {
    if (!COMPONENT_KEYS.includes(key)) return undefined;
    const components = this._getComponents();
    components[key] = !!value;
    try {
      return this._globalState && this._globalState.update(COMPONENTS_KEY, components);
    } catch {
      return undefined;
    }
  }

  // CSS that hides every currently-checked CSS-hide component, joined into one selector list. The
  // move key is not a hide, so it is excluded here. Empty string when nothing is checked.
  composeCss() {
    const components = this._getComponents();
    const selectors = SELECTOR_KEYS.filter((key) => components[key]).map((key) => SELECTORS[key]);
    let css = selectors.length ? `${selectors.join(',')}{display:none !important;}` : '';
    if (components[GAP_KEY]) css += GAP_RULE;
    // Board-avatars ON: hide Jira's native (capped) assignee filter at document-start so it never
    // flashes before composeJs()'s custom strip renders. composeJs still injects __ejHideNativeAssignee
    // live (a harmless duplicate of this rule) and, crucially, REMOVES it when the feature is off — so
    // this rule is gated on the same flag: when showBoardAvatars is off neither hide is present and the
    // native filter shows. A brief empty gap before the strip resolves is accepted; a native flash is not.
    if (components[SHOW_AVATARS_KEY]) css += `${AVATAR_FILTER_SELECTOR}{display:none !important;}`;
    return css;
  }

  // Self-contained IIFE (main world, injected each activation) carrying two independent idempotent
  // singletons: the board-avatars manager (window.__ejAvatars, gated on the showBoardAvatars flag via
  // the baked SHOW_AVATARS literal) which hides Jira's capped assignee filter and renders a custom
  // strip of every board member's avatar next to the board title, and the Sprint-insights
  // move. DESIRED is baked in from the current moveSprintInsights flag. The move manager is an
  // idempotent singleton on window.__ejInsightsMover: a re-inject just updates .desired and
  // re-applies (never a second observer); a single MutationObserver reapplies across board
  // re-renders, and apply() only moves when the position is actually wrong so it can't loop.
  // Live semantics: turning move ON applies immediately and survives re-renders; turning it OFF
  // restores live *while the record stays active* (some hide still on, master on) because the
  // singleton reads the new DESIRED=false. If move is the only active thing and is toggled off,
  // no record is injected to carry DESIRED=false, so the button stays moved until page reload —
  // an accepted limitation consistent with this codebase's non-reverting JS injection.
  composeJs() {
    const desired = !!this._getComponents()[MOVE_KEY];
    const showAvatars = !!this._getComponents()[SHOW_AVATARS_KEY];
    const prColoring = !!this._getComponents()[PR_COLORING_KEY];
    const minApprovals = this._getMinApprovals();
    return `(function(){
  try {
    var SHOW_AVATARS = ${showAvatars ? 'true' : 'false'};
    var AV_FILTER_SEL = ${JSON.stringify(AVATAR_FILTER_SELECTOR)};
    var AV_SHOWMORE_SEL = ${JSON.stringify(AVATAR_SHOWMORE_SELECTOR)};
    var AV_ENTRY_SEL = ${JSON.stringify(AVATAR_ENTRY_SELECTOR)};
    var AV_HEADER_SEL = ${JSON.stringify(AVATAR_HEADER_SELECTOR)};
    var AV_CARD_SEL = ${JSON.stringify(AVATAR_CARD_SELECTOR)};
    var AV_PERSON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5Zm0 2c-4 0-8 2-8 5v1h16v-1c0-3-4-5-8-5Z"/></svg>';
    (function setupAvatars(){
      try {
        var exAv = window.__ejAvatars;
        if (exAv) {
          exAv.desired = SHOW_AVATARS;
          if (SHOW_AVATARS && (!exAv.roster || exAv.roster.size === 0)) {
            exAv.fetchRoster().then(function (map) { exAv.roster = map; exAv.render(); });
          } else { exAv.render(); }
          return;
        }
        var a = {
          desired: SHOW_AVATARS,
          roster: null,
          _scheduled: false,
          observer: null,
          addEntries: function (map) {
            try {
              var nodes = document.querySelectorAll(AV_ENTRY_SEL);
              for (var i = 0; i < nodes.length; i++) {
                var el = nodes[i];
                var label = el.querySelector('[data-testid$="ak-avatar--label"]');
                var name = label ? (label.textContent || '').trim() : '';
                if (!name) continue;
                var img = el.querySelector('img');
                if (!map.has(name) || (img && img.src)) map.set(name, img ? img.src : null);
              }
            } catch (e) {}
          },
          scrapeRoster: function () {
            var self = this;
            return new Promise(function (resolve) {
              var map = new Map();
              try {
                self.addEntries(map);
                var moreBtn = document.querySelector(AV_SHOWMORE_SEL);
                if (!moreBtn) { resolve(map); return; }
                var hide = document.getElementById('__ejAvatarScrapeHide');
                if (!hide) {
                  hide = document.createElement('style');
                  hide.id = '__ejAvatarScrapeHide';
                  hide.textContent = '.atlaskit-portal,[data-testid$="popup"],[role="dialog"]{opacity:0 !important;pointer-events:none !important;}';
                  (document.head || document.documentElement).appendChild(hide);
                }
                moreBtn.click();
                setTimeout(function () {
                  try {
                    var items = document.querySelectorAll('[role="menuitemcheckbox"]');
                    for (var i = 0; i < items.length; i++) {
                      var it = items[i];
                      var nm = (it.textContent || '').trim();
                      if (!nm) continue;
                      var im = it.querySelector('img');
                      if (!map.has(nm) || (im && im.src)) map.set(nm, im ? im.src : null);
                    }
                  } catch (e) {}
                  try { var b2 = document.querySelector(AV_SHOWMORE_SEL); if (b2) b2.click(); } catch (e) {}
                  try { if (hide && hide.parentNode) hide.parentNode.removeChild(hide); } catch (e) {}
                  resolve(map);
                }, 120);
              } catch (e) {
                try { var h = document.getElementById('__ejAvatarScrapeHide'); if (h && h.parentNode) h.parentNode.removeChild(h); } catch (e2) {}
                resolve(map);
              }
            });
          },
          rosterFromCards: function () {
            var map = new Map();
            try {
              var cards = document.querySelectorAll(AV_CARD_SEL);
              for (var i = 0; i < cards.length; i++) {
                var el = cards[i];
                var label = el.querySelector('[data-testid$="avatar--label"]');
                var name = label ? (label.textContent || '').trim().replace(/^Assignee:\\s*/, '') : '';
                if (!name || name === 'Unassigned') continue;
                var img = el.querySelector('img');
                if (!map.has(name) || (img && img.src)) map.set(name, { id: null, avatar: img ? img.src : null });
              }
            } catch (e) {}
            return map;
          },
          fetchRoster: function () {
            var self = this;
            return new Promise(function (resolve) {
              try {
                var mm = location.pathname.match(/\\/boards\\/(\\d+)/);
                var boardId = mm && mm[1];
                if (!boardId) { resolve(self.rosterFromCards()); return; }
                var base = '/rest/agile/1.0/board/' + boardId + '/issue';
                var withJql = base + '?fields=assignee&jql=' + encodeURIComponent('sprint in openSprints()') + '&maxResults=300';
                var noJql = base + '?fields=assignee&maxResults=100';
                var opts = { credentials: 'include', headers: { 'Accept': 'application/json' } };
                function parse(json) {
                  var map = new Map();
                  var sawNull = false;
                  var issues = (json && json.issues) || [];
                  for (var i = 0; i < issues.length; i++) {
                    var as = issues[i] && issues[i].fields && issues[i].fields.assignee;
                    if (!as) { sawNull = true; continue; }
                    var nm = as.displayName;
                    if (!nm) continue;
                    if (!map.has(nm)) map.set(nm, { id: as.accountId || null, avatar: (as.avatarUrls && as.avatarUrls['48x48']) || null });
                  }
                  if (sawNull) map.set('Unassigned', { id: 'unassigned', avatar: null });
                  return map;
                }
                function getJson(url) {
                  return fetch(url, opts).then(function (r) {
                    if (!r.ok) throw new Error('bad status ' + r.status);
                    return r.json();
                  });
                }
                getJson(withJql).then(function (j) {
                  resolve(parse(j));
                }).catch(function () {
                  getJson(noJql).then(function (j) {
                    resolve(parse(j));
                  }).catch(function () {
                    resolve(self.rosterFromCards());
                  });
                });
              } catch (e) {
                resolve(self.rosterFromCards());
              }
            });
          },
          mergeCards: function () {
            try {
              if (!this.roster) return;
              var cards = document.querySelectorAll(AV_CARD_SEL);
              for (var i = 0; i < cards.length; i++) {
                var el = cards[i];
                var label = el.querySelector('[data-testid$="avatar--label"]');
                var name = label ? (label.textContent || '').trim().replace(/^Assignee:\\s*/, '') : '';
                if (!name || name === 'Unassigned') continue;
                var img = el.querySelector('img');
                var cur = this.roster.get(name);
                if (!cur) this.roster.set(name, { id: null, avatar: img ? img.src : null });
                else if (img && img.src && !cur.avatar) cur.avatar = img.src;
              }
            } catch (e) {}
          },
          buildAvatar: function (name, avatar, accountId) {
            var el;
            if (avatar) {
              el = document.createElement('img');
              el.src = avatar;
              el.style.objectFit = 'cover';
            } else {
              el = document.createElement('div');
              el.style.background = '#5e6c84';
              el.style.display = 'inline-flex';
              el.style.alignItems = 'center';
              el.style.justifyContent = 'center';
              el.innerHTML = AV_PERSON_SVG;
            }
            el.title = name;
            el.setAttribute('aria-label', name);
            el.style.width = '24px';
            el.style.height = '24px';
            el.style.borderRadius = '50%';
            el.style.objectFit = 'cover';
            el.style.border = '1px solid rgba(255,255,255,.25)';
            el.style.flex = '0 0 auto';
            if (accountId) {
              el.style.cursor = 'pointer';
              var active = [];
              try {
                active = (new URL(location.href)).searchParams.getAll('assignee');
              } catch (e) {}
              if (active.indexOf(accountId) >= 0) {
                el.style.boxShadow = '0 0 0 2px #4c9aff';
                el.style.border = '1px solid #4c9aff';
              }
              el.addEventListener('click', function () {
                try {
                  var u = new URL(location.href);
                  var cur = u.searchParams.getAll('assignee').filter(Boolean);
                  var isOnlyThis = cur.length === 1 && cur[0] === accountId;
                  u.searchParams.delete('assignee');
                  if (!isOnlyThis) u.searchParams.append('assignee', accountId);  // single-select: just this person, unless it was already the only one -> clear
                  location.assign(u.toString());
                } catch (e) {}
              });
            } else {
              el.style.cursor = 'default';
            }
            return el;
          },
          titleAnchor: function (row) {
            try {
              var h = row.querySelector('h1,[role="heading"]');
              if (h) {
                var node = h;
                while (node && node.parentElement !== row) node = node.parentElement;
                if (node) return node;
              }
            } catch (e) {}
            return row.firstElementChild;
          },
          render: function () {
            try {
              if (!this.desired) {
                var old = document.getElementById('__ej_avatar_strip');
                if (old && old.parentNode) old.parentNode.removeChild(old);
                var hs = document.getElementById('__ejHideNativeAssignee');
                if (hs && hs.parentNode) hs.parentNode.removeChild(hs);
                return;
              }
              var hide = document.getElementById('__ejHideNativeAssignee');
              if (!hide) {
                hide = document.createElement('style');
                hide.id = '__ejHideNativeAssignee';
                hide.textContent = AV_FILTER_SEL + '{display:none !important;}';
                (document.head || document.documentElement).appendChild(hide);
              }
              var row = document.querySelector(AV_HEADER_SEL);
              if (!row) return;
              // Absolute-center the strip in the header row: make the row a positioning context
              // (only when it is otherwise static, so we never fight an existing offset parent).
              try {
                var cs = window.getComputedStyle ? window.getComputedStyle(row) : null;
                if (cs && cs.position === 'static') row.style.position = 'relative';
              } catch (e) {}
              var roster = this.roster || new Map();
              var names = Array.from(roster.keys());
              names.sort(function (x, y) {
                if (x === 'Unassigned') return 1;
                if (y === 'Unassigned') return -1;
                return x.localeCompare(y);
              });
              var activeParam = '';
              try { activeParam = (new URL(location.href)).searchParams.getAll('assignee').slice().sort().join(','); } catch (e) {}
              var sig = activeParam + '||' + names.map(function (n) {
                var r = roster.get(n) || {};
                return n + '|' + (r.id || '') + '|' + (r.avatar || '');
              }).join(',');
              var strip = document.getElementById('__ej_avatar_strip');
              var placed = !!(strip && strip.parentNode === row);
              if (strip && placed && strip.getAttribute('data-sig') === sig) return;
              if (!strip) {
                strip = document.createElement('div');
                strip.id = '__ej_avatar_strip';
                strip.style.display = 'inline-flex';
                strip.style.gap = '4px';
                strip.style.position = 'absolute';
                strip.style.left = '50%';
                strip.style.top = '50%';
                strip.style.transform = 'translate(-50%,-50%)';
                strip.style.margin = '0';
              }
              strip.setAttribute('data-sig', sig);
              strip.innerHTML = '';
              for (var i = 0; i < names.length; i++) {
                var r = roster.get(names[i]) || {};
                strip.appendChild(this.buildAvatar(names[i], r.avatar, r.id));
              }
              if (!placed) row.appendChild(strip);
            } catch (e) {}
          }
        };
        function startAv() {
          if (window.__ejAvatars !== a || a.observer) return;
          var raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : function (cb) { return setTimeout(cb, 16); };
          a.observer = new MutationObserver(function () {
            if (a._scheduled) return;
            a._scheduled = true;
            raf(function () { a._scheduled = false; a.mergeCards(); a.render(); });
          });
          a.observer.observe(document.body, { childList: true, subtree: true });
          if (a.desired) a.fetchRoster().then(function (map) { a.roster = map; a.render(); });
          else a.render();
        }
        window.__ejAvatars = a;
        if (document.body) startAv();
        else document.addEventListener('DOMContentLoaded', startAv, { once: true });
      } catch (e) {}
    })();
    var PR_COLORING = ${prColoring ? 'true' : 'false'};
    var MIN_APPROVALS = ${minApprovals};
    var PR_BOTS = ${JSON.stringify(PR_BOTS)};
    var PR_CARD_SEL = ${JSON.stringify(PR_CARD_SELECTOR)};
    var PR_GREEN = ${JSON.stringify(PR_GREEN)};
    var PR_RED = ${JSON.stringify(PR_RED)};
    var PR_KEY_RE = /^[A-Z][A-Z0-9]*-\\d+$/;
    var PR_TTL = 60000;
    var PR_MAXC = 4;
    (function setupPrColor(){
      try {
        var exPr = window.__ejPrColor;
        if (exPr) {
          var wasOn = exPr.desired;
          exPr.desired = PR_COLORING;
          exPr.minApprovals = MIN_APPROVALS;
          exPr.bots = PR_BOTS;
          if (PR_COLORING) {
            exPr.applyByKey();   // instant repaint from cached counts: honors the new threshold, zero refetch
            exPr.startRepaint(); // ensure the live-states re-apply loop is running after a toggle back on
            var empty = true;
            for (var ck in exPr.cache) { if (exPr.cache.hasOwnProperty(ck)) { empty = false; break; } }
            // Only hit the network if coloring was just turned ON, the cache is empty, or the counts are stale.
            if (!wasOn || empty || (Date.now() - exPr.lastRefresh) > PR_TTL) exPr.refresh();
          } else exPr.clearAll();
          return;
        }
        var p = {
          desired: PR_COLORING,
          minApprovals: MIN_APPROVALS,
          bots: PR_BOTS,
          cache: {},            // issueId -> { key, approved, changesRequested, hasPr, ts } (raw facts; color derived at paint)
          _scheduled: false,
          _refreshing: false,
          _repaintTimer: null,  // setInterval id for the live-states re-apply loop (singleton-guarded)
          lastRefresh: 0,
          observer: null,
          boardId: function () {
            try { var mm = location.pathname.match(/\\/boards\\/(\\d+)/); return mm && mm[1]; } catch (e) { return null; }
          },
          isBot: function (name) {
            if (!name) return false;
            for (var i = 0; i < this.bots.length; i++) {
              if (String(name).toLowerCase() === String(this.bots[i]).toLowerCase()) return true;
            }
            return false;
          },
          getJson: function (url) {
            return fetch(url, { credentials: 'include', headers: { 'Accept': 'application/json' } }).then(function (r) {
              if (!r.ok) throw new Error('bad status ' + r.status);
              return r.json();
            });
          },
          fetchIssues: function () {
            var id = this.boardId();
            if (!id) return Promise.resolve([]);
            var jql = encodeURIComponent('sprint in openSprints() AND status="Review"');
            var url = '/rest/agile/1.0/board/' + id + '/issue?fields=status&jql=' + jql + '&maxResults=100';
            return this.getJson(url).then(function (j) {
              var out = [];
              var issues = (j && j.issues) || [];
              for (var i = 0; i < issues.length; i++) {
                if (issues[i] && issues[i].id != null) out.push({ id: String(issues[i].id), key: issues[i].key });
              }
              return out;
            }).catch(function () { return []; });
          },
          // Read the bridge companion's relayed reviewer facts for an issue KEY from the hidden
          // <script id="__ej_bb_states"> contract node (published by composeBridgeJs's isolated world).
          // Returns the per-issue entry ({ changesRequested, changesRequestedBy, approvedHumans,
          // reviewers }) or null when the bridge isn't ready/on/matched — the null triggers the
          // same-origin dev-status fallback in computeCounts. Never throws.
          bridgeEntry: function (issueKey) {
            try {
              if (!issueKey) return null;
              var n = document.getElementById('__ej_bb_states');
              if (!n) return null;
              var txt = n.textContent || '';
              if (!txt) return null;
              var data = JSON.parse(txt);
              var byIssue = data && data.byIssue;
              return (byIssue && byIssue[issueKey]) || null;
            } catch (e) { return null; }
          },
          // Fetch a PR's raw approval FACTS (not the green/red decision): approved = deduped approved
          // human reviewers (excluding PR_BOTS), hasPr = any PR exists, changesRequested = any reviewer
          // requested changes. PREFERRED source is the bridge companion's relayed Bitbucket facts
          // (#__ej_bb_states, keyed by issueKey) — the only source with a real changes-requested signal;
          // when absent (bridge off/not-ready) we FALL BACK to the same-origin dev-status path (approved
          // count only, changesRequested:false) so green keeps working without the bridge. Cached as-is
          // so a later threshold change repaints from these facts with no refetch. undefined = fetch
          // error (don't hard-cache).
          computeCounts: function (issueId, issueKey) {
            var self = this;
            var relayed = self.bridgeEntry(issueKey);
            if (relayed) {
              return Promise.resolve({
                approved: relayed.approvedHumans || 0,
                changesRequested: !!relayed.changesRequested,
                hasPr: true
              });
            }
            var url = '/rest/dev-status/latest/issue/detail?issueId=' + encodeURIComponent(issueId) + '&applicationType=bitbucket&dataType=pullrequest';
            return this.getJson(url).then(function (j) {
              var prs = [];
              var detail = (j && j.detail) || [];
              for (var i = 0; i < detail.length; i++) {
                var d = detail[i] && detail[i].pullRequests;
                if (d) for (var k = 0; k < d.length; k++) prs.push(d[k]);
              }
              if (!prs.length) return { approved: 0, changesRequested: false, hasPr: false };   // no PR -> no tint
              var approvers = {};             // dedupe approved humans by name across PRs
              for (var a = 0; a < prs.length; a++) {
                var revs = (prs[a] && prs[a].reviewers) || [];
                for (var b = 0; b < revs.length; b++) {
                  var rv = revs[b];
                  if (rv && rv.approved === true && !self.isBot(rv.name)) approvers[rv.name] = true;
                }
              }
              var count = 0; for (var nm in approvers) { if (approvers.hasOwnProperty(nm)) count++; }
              // TODO(bridge): populated from Bitbucket participants[].state in the bridge-fetch path; dev-status has no changes-requested signal
              return { approved: count, changesRequested: false, hasPr: true };
            }).catch(function () { return undefined; });   // undefined = fetch error (don't hard-cache)
          },
          // Pure three-state tint decision from the LIVE threshold (a minApprovals change repaints from
          // cache with zero refetch). RED when any reviewer requested changes (red wins over green); GREEN
          // when approved humans >= minApprovals; otherwise null (no tint — incl. PR-but-neither and no-PR).
          colorFor: function (entry) {
            if (!entry) return null;
            if (entry.changesRequested) return 'red';
            if (entry.hasPr && entry.approved >= this.minApprovals) return 'green';
            return null;
          },
          // Fetch the Review-column issue list, then fill the per-issue FACTS cache using ≤PR_MAXC
          // concurrent dev-status fetches, skipping issues whose cached facts are still fresh (<PR_TTL).
          refresh: function () {
            var self = this;
            if (!self.desired || self._refreshing) return;
            self._refreshing = true;
            self.lastRefresh = Date.now();
            self.fetchIssues().then(function (issues) {
              self.lastRefresh = Date.now();
              var queue = [];
              var now = Date.now();
              for (var i = 0; i < issues.length; i++) {
                var it = issues[i];
                var c = self.cache[it.id];
                if (c && (now - c.ts) < PR_TTL) { c.key = it.key; }   // fresh: keep, refresh key
                else queue.push(it);
              }
              self.applyByKey();   // paint what we already know before any refetch
              var idx = 0;
              function worker() {
                if (idx >= queue.length) return Promise.resolve();
                var issue = queue[idx++];
                return self.computeCounts(issue.id, issue.key).then(function (counts) {
                  if (counts !== undefined) {
                    self.cache[issue.id] = { key: issue.key, approved: counts.approved, changesRequested: counts.changesRequested, hasPr: counts.hasPr, ts: Date.now() };
                  } else {
                    var prev = self.cache[issue.id];   // fetch error: keep prior facts, short TTL so it retries soon
                    self.cache[issue.id] = { key: issue.key, approved: prev ? prev.approved : 0, changesRequested: prev ? prev.changesRequested : false, hasPr: prev ? prev.hasPr : false, ts: Date.now() - PR_TTL + 5000 };
                  }
                  self.applyByKey();
                  return worker();
                }).catch(function () { return worker(); });
              }
              var workers = [];
              for (var w = 0; w < PR_MAXC; w++) workers.push(worker());
              Promise.all(workers).then(function () { self._refreshing = false; self.applyByKey(); })
                .catch(function () { self._refreshing = false; });
            }).catch(function () { self._refreshing = false; });
          },
          // The card's visible rounded SURFACE: the first descendant div that actually paints the card —
          // an OPAQUE background (not transparent) covering ~the whole card (>= 0.9 of the card's area).
          // The card element itself and any ::before overlay are painted over by inner divs, so we tint
          // THIS div; it carries the border-radius, so the rounded corners are preserved. null if none.
          surfaceOf: function (card) {
            try {
              var cr = card.getBoundingClientRect();
              var cardArea = cr.width * cr.height;
              if (!(cardArea > 0)) return null;
              var divs = card.querySelectorAll('div');
              for (var i = 0; i < divs.length; i++) {
                var el = divs[i];
                var cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
                if (!cs) continue;
                var bg = cs.backgroundColor;
                if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') continue;
                var r = el.getBoundingClientRect();
                if ((r.width * r.height) / cardArea >= 0.9) return el;
              }
            } catch (e) {}
            return null;
          },
          // Tint (or restore) the card's surface div. green -> PR_GREEN, red -> PR_RED, anything else -> ''
          // which restores the stylesheet default (no need to store the original). Idempotent: only writes
          // when the value differs (PR_GREEN/PR_RED use the browser's serialized spacing so the guard holds).
          colorCard: function (card, color) {
            try {
              var surface = this.surfaceOf(card);
              if (!surface) return;
              var want = (color === 'green') ? PR_GREEN : (color === 'red') ? PR_RED : '';
              if (surface.style.backgroundColor !== want) surface.style.backgroundColor = want;
            } catch (e) {}
          },
          // A card's issue key = the trimmed text of its first descendant element whose text is EXACTLY a
          // Jira key (e.g. "CMMS-2763"). The whole-card textContent concatenates the story-point badge onto
          // the key with no separator ("...CMMS-27635..."), so a boundary regex over the card text is
          // unreliable; an exact per-element match is both correct and cheaper (and can't collide "-12"/"-123").
          keyOfCard: function (card) {
            try {
              var els = card.querySelectorAll('a,span,div');
              for (var i = 0; i < els.length; i++) {
                var tx = (els[i].textContent || '').trim();
                if (PR_KEY_RE.test(tx)) return tx;
              }
            } catch (e) {}
            return null;
          },
          // Re-apply colors to the DOM (cheap; the observer's hot path — which fires on virtual re-renders
          // as the board scrolls — and the threshold-change repaint path). Build a key->entry lookup from
          // the cache, then tint each rendered card's surface via colorFor (LIVE threshold). Because
          // colorCard resolves the surface fresh each call, a freshly-virtualized card is re-tinted on the
          // next observer tick. Unknown keys / no-tint entries restore the card's default surface.
          applyByKey: function () {
            try {
              if (!this.desired) return;
              var entryByKey = {};
              for (var id in this.cache) {
                if (!this.cache.hasOwnProperty(id)) continue;
                var c = this.cache[id];
                if (c && c.key) entryByKey[c.key] = c;
              }
              var cards = document.querySelectorAll(PR_CARD_SEL);
              for (var i = 0; i < cards.length; i++) {
                var card = cards[i];
                var key = this.keyOfCard(card);
                var color = undefined;
                if (key) {
                  // LIVE source of truth: the relayed states node (on <html>, which our body observer
                  // never sees — so read it fresh at paint). When present it drives the color directly
                  // (real changes_requested + bridge approvedHumans), independent of the computeCounts
                  // cache which may still hold a stale pre-publish dev-status fact. When absent, fall back
                  // to that cached dev-status entry as before (green-only, no changes-requested signal).
                  var be = this.bridgeEntry(key);
                  if (be) {
                    color = this.colorFor({ approved: be.approvedHumans || 0, changesRequested: !!be.changesRequested, hasPr: true });
                  } else if (entryByKey[key]) {
                    color = this.colorFor(entryByKey[key]);
                  }
                }
                this.colorCard(card, color);
              }
            } catch (e) {}
          },
          // Periodic re-apply so cards catch up as the companion publishes/updates #__ej_bb_states even
          // with NO board DOM mutations (the states node lives on <html>, off the observer's body subtree).
          // Singleton-guarded (one interval per manager); started when the manager activates, cleared on
          // clearAll / toggle-off. The observer still handles scroll re-renders.
          startRepaint: function () {
            var self = this;
            if (self._repaintTimer) return;
            try { self._repaintTimer = setInterval(function () { try { self.applyByKey(); } catch (e) {} }, 8000); }
            catch (e) { self._repaintTimer = null; }
          },
          stopRepaint: function () {
            if (this._repaintTimer) { try { clearInterval(this._repaintTimer); } catch (e) {} this._repaintTimer = null; }
          },
          // Feature toggled off: restore every rendered card's surface to its default background. Also
          // removes any stale __ejPrColorStyle node left by an older injected build (defensive no-op now
          // that this version injects no style).
          clearAll: function () {
            try {
              this.stopRepaint();
              var cards = document.querySelectorAll(PR_CARD_SEL);
              for (var i = 0; i < cards.length; i++) this.colorCard(cards[i], null);
              var s = document.getElementById('__ejPrColorStyle');
              if (s && s.parentNode) s.parentNode.removeChild(s);
            } catch (e) {}
          }
        };
        function startPr() {
          if (window.__ejPrColor !== p || p.observer) return;
          var raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : function (cb) { return setTimeout(cb, 16); };
          p.observer = new MutationObserver(function () {
            if (p._scheduled) return;
            p._scheduled = true;
            raf(function () {
              p._scheduled = false;
              if (!p.desired) return;
              p.applyByKey();
              if (Date.now() - p.lastRefresh > PR_TTL) p.refresh();
            });
          });
          // Watch documentElement (NOT body): its subtree still includes <body> (so card re-renders /
          // scroll virtualization keep firing this), AND it catches the #__ej_bb_states node being
          // replaced at the <html> level on every companion publish → the debounced callback runs
          // applyByKey() → reads live states → tints. MutationObservers fire even when the tab is hidden
          // (unlike the throttled 8s timer), so coloring wakes the moment states publish, no visibility
          // dependence. (Only THIS manager widens to documentElement; avatars/insights/popup stay on body.)
          p.observer.observe(document.documentElement, { childList: true, subtree: true });
          if (p.desired) { p.refresh(); p.startRepaint(); }
        }
        window.__ejPrColor = p;
        if (document.body) startPr();
        else document.addEventListener('DOMContentLoaded', startPr, { once: true });
      } catch (e) {}
    })();
    // Stage-2 PR hover-card avatar expansion. Jira's board card PR-icon hover opens a portal popup
    // (testids under 'development-board-pr-details-popup.*') that shows only ~2 reviewer avatars + a
    // "+N" overflow. This manager watches for that popup, reads the issue key from its branch text,
    // looks the reviewers up in the relayed #__ej_bb_states, and REPLACES the capped avatar group with
    // a full strip — EVERY reviewer (bots included), each with a corner status badge (green check =
    // approved, red ✕ = changes requested) and a name+status title tooltip. Gated by PR_COLORING;
    // idempotent per popup instance; never throws; leaves Jira's popup untouched when data isn't ready.
    (function setupPrPopup(){
      try {
        var exPop = window.__ejPrPopup;
        if (exPop) { exPop.desired = PR_COLORING; if (PR_COLORING) exPop.apply(); return; }
        var POP_SEL = '[data-testid^="development-board-pr-details-popup"]';
        var POP_KEY_RE = /[A-Z][A-Z0-9]+-\\d+/;
        var pop = {
          desired: PR_COLORING,
          _scheduled: false,
          observer: null,
          // Read one issue's relayed reviewers from the Stage-1 contract node (same source the coloring
          // reads). Returns the reviewers array or null when the bridge isn't ready/matched. Never throws.
          reviewersFor: function (issueKey) {
            try {
              if (!issueKey) return null;
              var n = document.getElementById('__ej_bb_states');
              if (!n) return null;
              var txt = n.textContent || '';
              if (!txt) return null;
              var data = JSON.parse(txt);
              var e = data && data.byIssue && data.byIssue[issueKey];
              return (e && e.reviewers && e.reviewers.length) ? e.reviewers : null;
            } catch (e) { return null; }
          },
          // The outermost popup element sharing the popup testid prefix (stable node to read text from +
          // mark processed). null when no popup is open.
          root: function () {
            var el = document.querySelector(POP_SEL);
            if (!el) return null;
            var root = el, p = el.parentElement;
            while (p) {
              var t = p.getAttribute && p.getAttribute('data-testid');
              if (t && t.indexOf('development-board-pr-details-popup') === 0) root = p;
              p = p.parentElement;
            }
            return root;
          },
          // The avatar-group CONTAINER inside the popup (holds the shown avatars + the "+N" overflow):
          // the ancestor whose testid names the group itself (not a '--avatar-N--inner' child). Falls
          // back to an avatar img's parent. null if none found.
          group: function (root) {
            try {
              var inner = root.querySelector('[data-testid*="avatar-group"]');
              if (inner) {
                var el = inner;
                while (el && el !== root) {
                  var t = (el.getAttribute && el.getAttribute('data-testid')) || '';
                  if (t.indexOf('avatar-group') !== -1 && t.indexOf('--avatar-') === -1 && t.indexOf('--inner') === -1) return el;
                  el = el.parentElement;
                }
              }
              var img = root.querySelector('[data-testid*="avatar-group"] img') || root.querySelector('img');
              return img ? img.parentElement : inner;
            } catch (e) { return null; }
          },
          initials: function (name) {
            try {
              var parts = String(name).trim().split(/\\s+/);
              var a = parts[0] ? parts[0].charAt(0) : '';
              var b = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
              return (a + b).toUpperCase() || '?';
            } catch (e) { return '?'; }
          },
          // Build one avatar wrapper: circular <img> (or an initials fallback when no avatar URL), a
          // corner status badge, and a name+status title tooltip. Colors match the card tint family.
          buildAvatar: function (rv) {
            var name = rv.name || 'Reviewer';
            var isCr = rv.state === 'changes_requested';
            var isApp = rv.approved || rv.state === 'approved';
            var wrap = document.createElement('div');
            wrap.style.cssText = 'position:relative;width:24px;height:24px;display:inline-block;flex:0 0 auto;';
            wrap.setAttribute('title', name + (isCr ? ' — requested changes' : (isApp ? ' — approved' : '')));
            if (rv.avatar) {
              var img = document.createElement('img');
              img.src = rv.avatar;
              img.alt = name;
              img.referrerPolicy = 'no-referrer';
              img.style.cssText = 'width:24px;height:24px;border-radius:50%;object-fit:cover;display:block;box-shadow:0 0 0 1.5px #fff;';
              wrap.appendChild(img);
            } else {
              var f = document.createElement('div');
              f.textContent = this.initials(name);
              f.style.cssText = 'width:24px;height:24px;border-radius:50%;background:#5E6C84;color:#fff;font-size:10px;font-weight:600;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 1.5px #fff;';
              wrap.appendChild(f);
            }
            if (isCr || isApp) {
              var badge = document.createElement('div');
              badge.textContent = isCr ? '✕' : '✓';
              badge.style.cssText = 'position:absolute;right:-3px;bottom:-3px;width:13px;height:13px;border-radius:50%;border:1.5px solid #fff;color:#fff;font-size:9px;line-height:13px;text-align:center;background:' + (isCr ? '#FF5630' : '#36B37E') + ';';
              wrap.appendChild(badge);
            }
            return wrap;
          },
          // Hide Jira's original avatar-group children and append our full-reviewer strip in their place.
          // Idempotent: an existing strip is removed first so a re-render repaints cleanly.
          render: function (group, reviewers) {
            try {
              var kids = group.children;
              for (var i = 0; i < kids.length; i++) {
                var c = kids[i];
                if (c.getAttribute && c.getAttribute('data-ej-pr-strip') === '1') continue;
                if (c.style) c.style.display = 'none';
              }
              var prev = group.querySelector('[data-ej-pr-strip="1"]');
              if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
              var strip = document.createElement('div');
              strip.setAttribute('data-ej-pr-strip', '1');
              strip.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;align-items:center;';
              for (var j = 0; j < reviewers.length; j++) strip.appendChild(this.buildAvatar(reviewers[j]));
              group.appendChild(strip);
            } catch (e) {}
          },
          apply: function () {
            try {
              if (!this.desired) return;
              var root = this.root();
              if (!root) return;
              var m = (root.textContent || '').match(POP_KEY_RE);
              if (!m) return;
              var key = m[0];
              var reviewers = this.reviewersFor(key);
              if (!reviewers) return;   // companion not ready for this issue -> leave Jira's popup as-is
              var group = this.group(root);
              if (!group) return;
              // Skip only when already rendered for THIS key AND our strip survived Jira's re-renders.
              if (root.getAttribute('data-ej-pr-popup') === key && group.querySelector('[data-ej-pr-strip="1"]')) return;
              this.render(group, reviewers);
              root.setAttribute('data-ej-pr-popup', key);
            } catch (e) {}
          }
        };
        function startPop() {
          if (window.__ejPrPopup !== pop || pop.observer) return;
          var raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : function (cb) { return setTimeout(cb, 16); };
          pop.observer = new MutationObserver(function () {
            if (pop._scheduled) return;
            pop._scheduled = true;
            raf(function () { pop._scheduled = false; if (!pop.desired) return; pop.apply(); });
          });
          pop.observer.observe(document.body, { childList: true, subtree: true });
          if (pop.desired) pop.apply();
        }
        window.__ejPrPopup = pop;
        if (document.body) startPop();
        else document.addEventListener('DOMContentLoaded', startPop, { once: true });
      } catch (e) {}
    })();
    var DESIRED = ${desired ? 'true' : 'false'};
    var INSIGHTS_SEL = ${JSON.stringify(INSIGHTS_SELECTOR)};
    var FULLSCREEN_SEL = ${JSON.stringify(FULLSCREEN_SELECTOR)};
    var FEEDBACK_SEL = ${JSON.stringify(FEEDBACK_SELECTOR)};
    var TARGET_SEL = ${JSON.stringify(MOVE_TARGET_SELECTOR)};
    var existing = window.__ejInsightsMover;
    if (existing) { existing.desired = DESIRED; existing.apply(); return; }
    var m = {
      desired: DESIRED,
      homeMarker: null,
      _scheduled: false,
      observer: null,
      cluster: function () {
        var fs = document.querySelector(FULLSCREEN_SEL);
        if (fs && fs.parentElement) return fs.parentElement;
        var fb = document.querySelector(FEEDBACK_SEL);
        if (fb && fb.parentElement) return fb.parentElement;
        return document.querySelector(TARGET_SEL);
      },
      apply: function () {
        try {
          var btn = document.querySelector(INSIGHTS_SEL);
          var cluster = this.cluster();
          if (!btn || !cluster) return;
          if (this.desired) {
            if (cluster.firstChild !== btn) {
              if (!this.homeMarker && btn.parentNode) {
                this.homeMarker = document.createComment('__ej_insights_home');
                btn.parentNode.insertBefore(this.homeMarker, btn);
              }
              cluster.insertBefore(btn, cluster.firstChild);
              btn.style.marginRight = '8px';
            }
          } else if (this.homeMarker && this.homeMarker.parentNode && btn.nextSibling !== this.homeMarker) {
            this.homeMarker.parentNode.insertBefore(btn, this.homeMarker);
            btn.style.marginRight = '';
          }
        } catch (e) {}
      }
    };
    function start() {
      if (window.__ejInsightsMover !== m || m.observer) return;
      var raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : function (cb) { return setTimeout(cb, 16); };
      m.observer = new MutationObserver(function () {
        if (m._scheduled) return;
        m._scheduled = true;
        raf(function () { m._scheduled = false; m.apply(); });
      });
      m.observer.observe(document.body, { childList: true, subtree: true });
      m.apply();
    }
    window.__ejInsightsMover = m;
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  } catch (e) {}
})();`;
  }

  // Stage-1 DATA-PROVIDER body for the Bitbucket bridge COMPANION record. Emits an idempotent IIFE
  // (singleton window.__ejBbBridge) that runs in the bridge's isolated world and publishes reviewer
  // FACTS for the WHOLE Review column to a hidden <script id="__ej_bb_states"> node that the main-world
  // coloring reads. Flow: same-origin fetch the Review issues + each issue's PR(s) via dev-status, then
  // steersman.fetch each PR's participants from the Bitbucket 2.0 API with sessionCookies:true (host
  // attaches the live session — no token). Bitbucket + dev-status fetches are throttled (<=4 concurrent)
  // and cached per PR (BB_TTL ~60s) so repeated refreshes don't hammer; facts are aggregated PER ISSUE
  // across its PRs and keyed by the SAME Jira issue key the main-world keyOfCard reads (e.g. "CMMS-2846").
  // Refreshes on load + every 90s. Never throws into the page (whole body wrapped in try/catch, every
  // fetch .catch()'d). When steersman.fetch is unavailable it writes NOTHING and returns — the main-world
  // coloring then falls back to its same-origin dev-status path.
  composeBridgeJs() {
    return `(function(){
  try {
    if (window.__ejBbBridge) return;
    if (typeof steersman === 'undefined' || !steersman || !steersman.fetch) return;
    var BB_TTL = 60000;    // per-PR participant cache TTL
    var BB_MAXC = 4;       // max concurrent throttled fetches
    var BB_BOTS = ['Code Rabbit'];
    var bridge = {
      prCache: {},         // 'repo#prId' -> { participants:[...], ts }
      _refreshing: false,
      isBot: function (name) {
        if (!name) return false;
        for (var i = 0; i < BB_BOTS.length; i++) {
          if (String(name).toLowerCase() === String(BB_BOTS[i]).toLowerCase()) return true;
        }
        return false;
      },
      boardId: function () {
        try { var mm = location.pathname.match(/\\/boards\\/(\\d+)/); return mm && mm[1]; } catch (e) { return null; }
      },
      getJson: function (url) {
        return fetch(url, { credentials: 'include', headers: { 'Accept': 'application/json' } }).then(function (r) {
          if (!r.ok) throw new Error('bad status ' + r.status);
          return r.json();
        });
      },
      // Run worker(item) over items with at most maxc in flight; resolves when all settle (errors swallowed).
      runPool: function (items, worker, maxc) {
        return new Promise(function (resolve) {
          var n = items.length, idx = 0, active = 0, done = 0;
          if (!n) return resolve();
          function pump() {
            while (active < maxc && idx < n) {
              var it = items[idx++];
              active++;
              Promise.resolve().then(function () { return worker(it); }).catch(function () {}).then(function () {
                active--; done++;
                if (done >= n) resolve(); else pump();
              });
            }
          }
          pump();
        });
      },
      fetchIssues: function () {
        var id = this.boardId();
        if (!id) return Promise.resolve([]);
        var jql = encodeURIComponent('sprint in openSprints() AND status="Review"');
        var url = '/rest/agile/1.0/board/' + id + '/issue?fields=status&jql=' + jql + '&maxResults=100';
        return this.getJson(url).then(function (j) {
          var out = [], issues = (j && j.issues) || [];
          for (var i = 0; i < issues.length; i++) {
            if (issues[i] && issues[i].id != null) out.push({ id: String(issues[i].id), key: issues[i].key });
          }
          return out;
        }).catch(function () { return []; });
      },
      // dev-status -> [{ repo:'<ws>/<repo>', prId, prKey }]. repo PREFERS pr.repositoryName — dev-status's
      // clean '<workspace>/<repo>' slug (e.g. 'herzog-technologies/cmms') — because pr.repositoryUrl is
      // the '{}/{<repo-uuid>}' placeholder form whose uuid path is FLAKY (returns 0 participants for some
      // PRs). Falls back to parsing the two path segments out of repositoryUrl only when repositoryName is
      // absent/blank.
      extractPrs: function (dj) {
        var out = [], detail = (dj && dj.detail) || [];
        for (var i = 0; i < detail.length; i++) {
          var d = detail[i] && detail[i].pullRequests;
          if (!d) continue;
          for (var k = 0; k < d.length; k++) {
            var pr = d[k];
            var repo = (typeof pr.repositoryName === 'string' && pr.repositoryName.trim()) ? pr.repositoryName.trim() : null;
            if (!repo) {
              var rm = String(pr.repositoryUrl || '').match(/bitbucket\\.org\\/([^\\/]+\\/[^\\/?#]+)/);
              repo = rm && rm[1];
            }
            if (repo && pr.id != null) out.push({ repo: repo, prId: pr.id, prKey: repo + '#' + pr.id });
          }
        }
        return out;
      },
      // Fetch one PR's participants from the Bitbucket 2.0 API (host attaches session cookies). A fresh
      // cache hit (< BB_TTL) skips the network. GOOD data (ok + non-empty participants) is cached for the
      // full BB_TTL; an empty/failed result is TRANSIENT — it's only made available to this cycle's
      // aggregation via a nearly-expired ts (so the next 90s refresh retries), and never overwrites a
      // prior good cache. Errors are swallowed.
      fetchParticipants: function (ref) {
        var self = this;
        var c = self.prCache[ref.prKey];
        if (c && (Date.now() - c.ts) < BB_TTL) return Promise.resolve();
        var url = 'https://bitbucket.org/!api/2.0/repositories/' + ref.repo + '/pullrequests/' + ref.prId +
          '?fields=participants.state,participants.approved,participants.role,participants.user.display_name,participants.user.uuid,participants.user.links.avatar.href';
        return steersman.fetch(url, { sessionCookies: true }).then(function (res) {
          var data = null;
          try { data = res.body ? JSON.parse(res.body) : null; } catch (e) { data = null; }
          var participants = (data && data.participants) || [];
          if (res && res.ok && participants.length) {
            self.prCache[ref.prKey] = { participants: participants, ts: Date.now() };   // good: cache BB_TTL
          } else if (!self.prCache[ref.prKey]) {
            // transient empty/failed: usable this cycle, but stale ts so the next refresh refetches
            self.prCache[ref.prKey] = { participants: participants, ts: Date.now() - BB_TTL + 5000 };
          }
          // else: keep the prior good cache rather than blanking it with a transient empty result
        }).catch(function () {});
      },
      // Aggregate an issue's PRs (from prCache) into reviewer FACTS. reviewers[] carries EVERY
      // participant (bots INCLUDED — the Stage-2 popup shows the full picture), each deduped by display
      // name across PRs; but the human tallies (changesRequested/changesRequestedBy/approvedHumans that
      // drive the RED/GREEN card trigger) EXCLUDE bots (BB_BOTS). Both unioned across the issue's PRs.
      aggregateIssue: function (prs) {
        var self = this;
        var reviewersByName = {}, crBy = {}, apprBy = {};
        for (var i = 0; i < prs.length; i++) {
          var c = self.prCache[prs[i].prKey];
          var parts = (c && c.participants) || [];
          for (var j = 0; j < parts.length; j++) {
            var p = parts[j];
            var name = p && p.user && p.user.display_name;
            if (!name) continue;
            var bot = self.isBot(name);
            var approved = (p.approved === true) || (p.state === 'approved');
            var cr = p.state === 'changes_requested';
            var avatar = p.user && p.user.links && p.user.links.avatar && p.user.links.avatar.href;
            var ex = reviewersByName[name];
            if (!ex) {
              reviewersByName[name] = { name: name, approved: approved, state: (cr ? 'changes_requested' : (approved ? 'approved' : (p.state || null))), avatar: avatar || null };
            } else {
              ex.approved = ex.approved || approved;
              if (cr) ex.state = 'changes_requested';
              else if (approved && ex.state !== 'changes_requested') ex.state = 'approved';
              if (!ex.avatar && avatar) ex.avatar = avatar;
            }
            if (!bot && cr) crBy[name] = true;      // bots never trigger the red card
            if (!bot && approved) apprBy[name] = true;   // bots never count toward the approval threshold
          }
        }
        var changesRequestedBy = [], reviewers = [];
        for (var n1 in crBy) { if (crBy.hasOwnProperty(n1)) changesRequestedBy.push(n1); }
        var apprCount = 0; for (var n2 in apprBy) { if (apprBy.hasOwnProperty(n2)) apprCount++; }
        for (var n3 in reviewersByName) { if (reviewersByName.hasOwnProperty(n3)) reviewers.push(reviewersByName[n3]); }
        return {
          changesRequested: changesRequestedBy.length > 0,
          changesRequestedBy: changesRequestedBy,
          approvedHumans: apprCount,
          reviewers: reviewers
        };
      },
      // Write the whole states map to the hidden contract node the main-world coloring reads. REPLACE the
      // node fresh on every publish (remove old + createElement + append) rather than mutating textContent:
      // the removal+append is a childList mutation on documentElement, which the coloring's documentElement
      // observer catches (fires even when the tab is hidden) — a textContent update would be characterData
      // and go unseen. Kept on document.documentElement (outside <body>) so Jira's React root never
      // reconciles/removes it.
      publish: function (byIssue) {
        try {
          var old = document.getElementById('__ej_bb_states');
          if (old && old.parentNode) old.parentNode.removeChild(old);
          var n = document.createElement('script');
          n.type = 'application/json';
          n.id = '__ej_bb_states';
          n.textContent = JSON.stringify({ updatedAt: Date.now(), byIssue: byIssue });
          if (document.documentElement) document.documentElement.appendChild(n);
        } catch (e) {}
        try {
          var cnt = 0, cr = 0;
          for (var k in byIssue) { if (byIssue.hasOwnProperty(k)) { cnt++; if (byIssue[k].changesRequested) cr++; } }
          console.log('[EJ-BB]', 'published issues=' + cnt + ' changesRequested=' + cr);
        } catch (e) {}
      },
      refresh: function () {
        var self = this;
        if (self._refreshing) return;
        self._refreshing = true;
        var byIssuePrs = {};   // issueKey -> [{ repo, prId, prKey }]
        self.fetchIssues().then(function (issues) {
          // dev-status per issue (same-origin), throttled.
          return self.runPool(issues, function (issue) {
            var devUrl = '/rest/dev-status/latest/issue/detail?issueId=' + encodeURIComponent(issue.id) + '&applicationType=bitbucket&dataType=pullrequest';
            return self.getJson(devUrl).then(function (dj) {
              var prs = self.extractPrs(dj);
              if (prs.length) byIssuePrs[issue.key] = prs;
            }).catch(function () {});
          }, BB_MAXC);
        }).then(function () {
          // Flatten to unique PR refs, then fetch participants throttled + cached.
          var seen = {}, refs = [];
          for (var key in byIssuePrs) {
            if (!byIssuePrs.hasOwnProperty(key)) continue;
            var arr = byIssuePrs[key];
            for (var i = 0; i < arr.length; i++) {
              if (!seen[arr[i].prKey]) { seen[arr[i].prKey] = true; refs.push(arr[i]); }
            }
          }
          return self.runPool(refs, function (ref) { return self.fetchParticipants(ref); }, BB_MAXC);
        }).then(function () {
          var byIssue = {};
          for (var key in byIssuePrs) {
            if (!byIssuePrs.hasOwnProperty(key)) continue;
            byIssue[key] = self.aggregateIssue(byIssuePrs[key]);   // only issues WITH >=1 PR are published
          }
          self.publish(byIssue);
          self._refreshing = false;
        }).catch(function () { self._refreshing = false; });
      }
    };
    window.__ejBbBridge = bridge;
    bridge.refresh();
    try { setInterval(function () { try { bridge.refresh(); } catch (e) {} }, 90000); } catch (e) {}
  } catch (e) {
    try { console.log('[EJ-BB]', 'fatal', e && e.message ? e.message : e); } catch (_) {}
  }
})();`;
  }

  // The synthetic COMPANION extension record for injectExtensions() — a SEPARATE bridge:true record
  // that rides alongside (never replaces) the main-world EnhanceJira record. It runs in its own
  // isolated bridge world (bridgeHosts + bridgeSessionCookies let steersman.fetch reach Bitbucket
  // with the live session), matching the SAME Jira boards as getActiveRecord(). Only active (non-null)
  // when the master EnhanceJira flag is on AND prColoring is on — the same gate as the coloring
  // feature the bridge will eventually feed. Field names mirror a real bridge ExtensionsStore record.
  getBridgeCompanionRecord() {
    if (!this._getEnabled()) return null;
    if (!this._getComponents()[PR_COLORING_KEY]) return null;
    return {
      id: 'enhancejira-bb',
      name: 'EnhanceJira (Bitbucket bridge)',
      matches: ['https://*.atlassian.net/jira/software/*'],
      css: '',
      js: this.composeBridgeJs(),
      runAt: 'document_start',
      world: 'isolated',
      enabled: true,
      bridge: true,
      bridgeHosts: ['bitbucket.org'],
      bridgeSessionCookies: true,
      hideFromAgent: false,
    };
  }

  // The synthetic extension record for injectExtensions(), or null when the master flag is off or
  // there's nothing to hide. Field names mirror a real ExtensionsStore record (matches/css/js/
  // runAt/world/enabled/bridge/hideFromAgent) so the injector can consume it unmodified.
  getActiveRecord() {
    if (!this._getEnabled()) return null;
    const components = this._getComponents();
    const css = this.composeCss();
    const move = !!components[MOVE_KEY];
    const avatars = !!components[SHOW_AVATARS_KEY];
    const prColoring = !!components[PR_COLORING_KEY];
    // Active whenever master is on AND there is something to do: a CSS hide, the move feature, the
    // board-avatars feature, or the PR-coloring feature (all JS-driven features ride along in
    // composeJs()'s injected record).
    if (!css && !move && !avatars && !prColoring) return null;
    return {
      id: '__steersman_enhancejira__',
      matches: ['https://*.atlassian.net/jira/software/*'],
      css,
      js: this.composeJs(),
      runAt: 'document_start',
      world: 'main',
      enabled: true,
      bridge: false,
      hideFromAgent: false,
    };
  }
}

module.exports = { EnhanceJiraStore };
