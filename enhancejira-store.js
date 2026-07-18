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

// Every known component key handled by this store: the 16 CSS-hide keys plus the move, gap, and
// avatars keys.
const COMPONENT_KEYS = SELECTOR_KEYS.concat(MOVE_KEY, GAP_KEY, SHOW_AVATARS_KEY);

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

  // Full state snapshot: the master flag plus all 7 component flags, safe to serialize.
  getState() {
    return { enabled: this._getEnabled(), components: this._getComponents() };
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
                  var i = cur.indexOf(accountId);
                  if (i >= 0) cur.splice(i, 1); else cur.push(accountId);
                  u.searchParams.delete('assignee');
                  for (var k = 0; k < cur.length; k++) u.searchParams.append('assignee', cur[k]);
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

  // The synthetic extension record for injectExtensions(), or null when the master flag is off or
  // there's nothing to hide. Field names mirror a real ExtensionsStore record (matches/css/js/
  // runAt/world/enabled/bridge/hideFromAgent) so the injector can consume it unmodified.
  getActiveRecord() {
    if (!this._getEnabled()) return null;
    const components = this._getComponents();
    const css = this.composeCss();
    const move = !!components[MOVE_KEY];
    const avatars = !!components[SHOW_AVATARS_KEY];
    // Active whenever master is on AND there is something to do: a CSS hide, the move feature, or the
    // board-avatars feature (both JS-driven features ride along in composeJs()'s injected record).
    if (!css && !move && !avatars) return null;
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
