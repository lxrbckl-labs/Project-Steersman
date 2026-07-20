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
// verbatim/validated live; BOTS is the reviewer-name exclude list for the approval tally. Per operator
// requirement it is EMPTY: the threshold counts ALL approved reviewers, including Code Rabbit's
// auto-approval (e.g. 2 human approvals + Code Rabbit = 3 = green). The colors are the solid green/red
// values used by the retained edge bar (see PR_BAR_CSS); the shipping look is the PR_TINT_CSS wash.
const PR_CARD_SELECTOR = '[data-testid="platform-board-kit.ui.card.card"]';
const PR_GREEN = 'rgb(30, 107, 75)';
const PR_RED = 'rgb(139, 46, 40)';
const PR_BOTS = [];

// The Review-column coloring paints via an EXTENSION-OWNED pseudo-element on the card, NOT an inline
// background: Atlassian's Design System / Compiled uses a layered `!important` card background that
// inline styles (even inline !important) cannot beat, but a pseudo-element the extension owns renders
// fine. The injected JS manager only toggles `data-ej-pr="green"|"red"` on the card; these rules (part
// of the record's css, so they ride the CSS-injection path AND keep setBypassCSP on) do all the painting.
//
// PR_TINT_CSS (below) is what ships as of the whole-card-wash change: an absolutely-positioned ::before
// covering the WHOLE card instead of a 5px left edge. The mechanism is deliberately identical to the bar's
// — same selector shape, same owned pseudo-element — because that is what beat ADS before. A positioned
// pseudo-element on the card paints AFTER the inner surface div whose opaque `!important` background is
// what swallowed the old inline tint, so it cannot be overridden away or painted over. The cost of
// painting last is that the layer also sits above the card's own text/avatars, which is exactly why it
// MUST stay a low-alpha wash (legibility) and MUST set pointer-events:none (clicks/drag pass through).
// Raised 0.16 -> 0.22 with the move to the under-content surface tint (PR_SURFACE_TINT_CSS). The overlay
// had to stay timid because it sat ON TOP of the text and every extra point of alpha cost legibility;
// beneath the content that tradeoff is gone, so the dial is now free to be set purely for visibility.
// 0.22 over the dark surface rgb(36,37,40) composites to ~rgb(47,77,67) green / ~rgb(84,56,56) red —
// unmistakably colored at a glance while leaving the card's text contrast completely untouched.
// SUPERSEDED as the operator-facing dial: the shipping fills are now the SOLID PR_SOLID_* constants
// below (the operator reported the 0.22 wash "looks transparent"). PR_TINT_ALPHA and the PR_TINT_*
// colors are RETAINED because the PR_TINT_CSS over-content overlay still references them and remains
// available as a fallback look — but nothing in the shipping path reads them any more, so changing
// this number no longer affects the board. Edit PR_SOLID_* instead.
const PR_TINT_ALPHA = 0.22;
// Wash colors. Light values are PR_GREEN/PR_RED at PR_TINT_ALPHA; the dark values are brightened because a
// dark wash over a dark card surface is invisible. Dial saturation here — alpha up = louder, down = subtler.
const PR_TINT_GREEN = `rgba(30, 107, 75, ${PR_TINT_ALPHA})`;
const PR_TINT_RED = `rgba(139, 46, 40, ${PR_TINT_ALPHA})`;
const PR_TINT_GREEN_DARK = `rgba(87, 217, 163, ${PR_TINT_ALPHA})`;
const PR_TINT_RED_DARK = `rgba(255, 118, 108, ${PR_TINT_ALPHA})`;
// border-radius:inherit keeps the wash inside the card's rounded corners; z-index:1 matches the bar's
// stacking; pointer-events:none keeps the full-bleed layer from eating card clicks and drag-to-move.
const PR_TINT_BOX =
  `content:'';position:absolute;left:0;top:0;right:0;bottom:0;background-clip:padding-box;` +
  `border-radius:inherit;pointer-events:none;z-index:1;`;
const PR_TINT_CSS =
  `${PR_CARD_SELECTOR}[data-ej-pr]{position:relative !important;}` +
  `${PR_CARD_SELECTOR}[data-ej-pr="green"]::before{${PR_TINT_BOX}background:${PR_TINT_GREEN};}` +
  `${PR_CARD_SELECTOR}[data-ej-pr="red"]::before{${PR_TINT_BOX}background:${PR_TINT_RED};}` +
  // Dark mode: Atlassian marks the theme with data-color-mode="dark" on <html>. These rules are inert when
  // that hook is absent, so light mode is unaffected whether or not this Jira build ships the attribute.
  `html[data-color-mode="dark"] ${PR_CARD_SELECTOR}[data-ej-pr="green"]::before{background:${PR_TINT_GREEN_DARK};}` +
  `html[data-color-mode="dark"] ${PR_CARD_SELECTOR}[data-ej-pr="red"]::before{background:${PR_TINT_RED_DARK};}`;

// ---------------------------------------------------------------------------------------------------
// SURFACE TINT — what actually ships (supersedes the PR_TINT_CSS overlay above, which is retained).
//
// The overlay above was built on a WRONG premise: that ADS's card background could not be beaten, so the
// tint had to be painted on top. Live DOM inspection of the board disproved it. Two facts:
//   1. The card element itself (PR_CARD_SELECTOR) is TRANSPARENT — computed background-color is
//      rgba(0,0,0,0). The opaque surface is an INNER div (card > ripple > context-menu-wrapper > div),
//      computed rgb(36,37,40) in dark mode. That is why the original inline background "lost": it was set
//      on the card, and the inner surface simply painted over it. It was never an !important contest.
//   2. That surface div's computed background-IMAGE is `none` on every card (verified 38/38 live).
//
// So instead of fighting the surface's background-COLOR, we occupy its unused background-IMAGE layer with
// a flat gradient. Per CSS painting order, background-image paints ABOVE background-color but BENEATH all
// content — so the tint sits under the text and avatars, which render at full contrast (verified live:
// text color/opacity unchanged over the tint). Two further wins over the overlay: ADS's own background-
// color is left intact, so hover/selected/drag surface states still read through underneath, and no
// stacking, z-index or pointer-events games are needed at all.
//
// Selector list is belt-and-braces: the testid-anchored path plus a positional fallback. Both resolved to
// the exact same node on all 38 live cards with zero over-match; the fallback only matters if ADS ever
// drops the ripple testid. Everything stays scoped under [data-ej-pr], so the existing colorCard
// lifecycle (set/remove the attribute) still drives painting and clearing exactly as before.
const PR_SURFACE_SUFFIXES = [
  ' [data-testid="platform-board-kit.ui.card.ripple.div"] > * > div:first-child',
  ' > div > div > div:first-child',
];
// A flat two-stop gradient is just "a solid color as an image" — the only way to put a solid fill on the
// background-image layer. !important beats ADS's atomic (0,1,0) class rules, which carry no !important.
// `prefix` is applied to EVERY selector in the list, not just the first — prefixing the joined string
// once would scope only the leading selector and let the rest leak (e.g. a dark tint applying in light
// mode via the fallback selector).
const prSurfaceTint = (state, color, prefix) =>
  PR_SURFACE_SUFFIXES.map((suffix) => `${prefix || ''}${PR_CARD_SELECTOR}[data-ej-pr="${state}"]${suffix}`).join(',') +
  `{background-image:linear-gradient(${color},${color}) !important;}`;
const PR_DARK_PREFIX = 'html[data-color-mode="dark"] ';

// ===================================================================================================
// >>> THE DIAL <<<  Edit these four values to change the card colors. Nothing else needs touching.
// ===================================================================================================
// SOLID (fully opaque) fills, replacing the low-alpha PR_TINT_* wash. The alpha wash was only ever
// there to protect text legibility back when the tint sat ON TOP of the content (PR_TINT_CSS). Since
// the tint moved UNDER the content (the surface div's background-image layer), transparency buys
// nothing but a washed-out look — so these are opaque, and legibility is instead guaranteed by
// CHOOSING SHADES WITH MEASURED CONTRAST against the card's real text.
//
// Measured live on the CMMS board (computed colors, WCAG 2.x relative-luminance formula). The binding
// constraint in each theme is the DIMMEST text that sits directly on the tint — the issue key, 12px
// normal weight, so plain-text AA (>= 4.5:1) applies:
//
//   DARK theme  (card surface rgb(36,37,40); text rgb(206,207,210) summary / rgb(169,171,175) key)
//     green rgb(11,71,43)     -> 6.91:1 summary, 4.68:1 issue key   PASS
//     red   rgb(112,28,22)    -> 7.22:1 summary, 4.89:1 issue key   PASS
//   LIGHT theme (text rgb(41,42,46) version / rgb(80,82,88) key)
//     green rgb(119,217,171)  -> 8.39:1 version, 4.57:1 issue key   PASS
//     red   rgb(240,186,180)  -> 8.46:1 version, 4.61:1 issue key   PASS
//
// WHY DARK-THEME FILLS ARE DEEP AND LIGHT-THEME FILLS ARE PALE: the fill must sit on the OPPOSITE side
// of the luminance scale from the text it sits behind. Dark theme has light text, so the fill must be
// dark (a bright green here would be unreadable); light theme has dark text, so the fill must be light.
// Both are fully SOLID either way — "solid" is about opacity, not about being dark. This is also why
// the light-theme red reads as a deep salmon rather than a fire-engine red: red is intrinsically a
// low-luminance hue, so a red light enough to clear AA behind dark text cannot also be fully saturated.
// The dark-theme values are the ones that matter in practice — the board is currently in dark mode.
//
// If you want them LOUDER, push these toward the extremes (dark theme: darker/more saturated; light
// theme: lighter). If you push a dark-theme value BRIGHTER or a light-theme value DARKER you will start
// eating into text contrast — the issue key is the first thing that becomes hard to read.
const PR_SOLID_GREEN_DARK = 'rgb(11, 71, 43)';
const PR_SOLID_RED_DARK = 'rgb(112, 28, 22)';
const PR_SOLID_GREEN_LIGHT = 'rgb(119, 217, 171)';
const PR_SOLID_RED_LIGHT = 'rgb(240, 186, 180)';

// Light-theme rules first (unprefixed = the default), then the dark-theme overrides behind the
// data-color-mode hook. Note prSurfaceTint applies the prefix to EVERY selector in the list — see its
// comment; joining once and prefixing the joined string would scope only the leading selector and let
// the dark fills leak into light mode via the fallback selector.
const PR_SURFACE_TINT_CSS =
  prSurfaceTint('green', PR_SOLID_GREEN_LIGHT) +
  prSurfaceTint('red', PR_SOLID_RED_LIGHT) +
  prSurfaceTint('green', PR_SOLID_GREEN_DARK, PR_DARK_PREFIX) +
  prSurfaceTint('red', PR_SOLID_RED_DARK, PR_DARK_PREFIX);

// The pre-wash 5px left-edge bar, RETAINED (no-deletions) but no longer appended by composeCss. Two ways
// to bring a bar back: append PR_EDGE_BAR_CSS after PR_TINT_CSS in composeCss for bar + wash together (it
// uses ::after, so it does not collide with the wash's ::before), or swap PR_TINT_CSS back to PR_BAR_CSS
// there to restore the previous bar-only look exactly.
const PR_BAR_CSS =
  `${PR_CARD_SELECTOR}[data-ej-pr]{position:relative !important;}` +
  `${PR_CARD_SELECTOR}[data-ej-pr="green"]::before{content:'';position:absolute;left:0;top:0;bottom:0;width:5px;background:${PR_GREEN};z-index:1;border-top-left-radius:inherit;border-bottom-left-radius:inherit;}` +
  `${PR_CARD_SELECTOR}[data-ej-pr="red"]::before{content:'';position:absolute;left:0;top:0;bottom:0;width:5px;background:${PR_RED};z-index:1;border-top-left-radius:inherit;border-bottom-left-radius:inherit;}`;

// Same bar on ::after (and pointer-events:none, which the ::before original predated) so it can ride
// ALONGSIDE the PR_TINT_CSS wash. Not appended by default — see the PR_BAR_CSS note above.
const PR_EDGE_BAR_CSS =
  `${PR_CARD_SELECTOR}[data-ej-pr="green"]::after{content:'';position:absolute;left:0;top:0;bottom:0;width:5px;background:${PR_GREEN};z-index:2;pointer-events:none;border-top-left-radius:inherit;border-bottom-left-radius:inherit;}` +
  `${PR_CARD_SELECTOR}[data-ej-pr="red"]::after{content:'';position:absolute;left:0;top:0;bottom:0;width:5px;background:${PR_RED};z-index:2;pointer-events:none;border-top-left-radius:inherit;border-bottom-left-radius:inherit;}`;

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
    // PR-coloring ON: contribute the Review-column whole-card wash rules. This both PAINTS the cards (the
    // reliable CSS-injection path, vs. inline styles ADS overrides) and — critically — guarantees the
    // record carries a non-empty css so cdp-tab keeps setBypassCSP ON while coloring is active, even if
    // the operator turns off every CSS-hide (otherwise the injected color style would be CSP-blocked).
    // Append PR_EDGE_BAR_CSS here as well to restore a left-edge bar on top of the tint. Swap
    // PR_SURFACE_TINT_CSS for PR_TINT_CSS to go back to the over-content overlay, or PR_BAR_CSS for the
    // original left-edge bar — both are retained above.
    if (components[PR_COLORING_KEY]) css += PR_SURFACE_TINT_CSS;
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
          _headerTries: 0,      // bounded retry budget for the header-row race (reset once it appears)
          _headerTimer: null,   // one pending header-retry timer at a time
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
              if (!row) {
                // Header row not in the DOM yet (first/rapid load): the body MutationObserver may have
                // already fired for this tick, so instead of silently giving up (blank strip until an
                // unrelated later mutation), retry on a short bounded timer so the strip paints on the
                // first settle and re-paints after every refresh. Reset below once the row appears.
                if (this.desired && this._headerTries < 40 && !this._headerTimer) {
                  var selfR = this;
                  this._headerTries++;
                  this._headerTimer = setTimeout(function () { selfR._headerTimer = null; selfR.render(); }, 150);
                }
                return;
              }
              this._headerTries = 0;   // header present: replenish the retry budget for the next cycle
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
    // Concurrency for the main-world FALLBACK dev-status pool (used only when the bridge companion is
    // unavailable). Raised 4 -> 10 for the same measured reason as the bridge's DEV_MAXC: these are
    // same-origin HTTP/2 GETs to the Jira host the board is already using, and a 4-wide queue over ~15
    // Review issues was costing ~2.9s of pure queueing before the first card could paint.
    var PR_MAXC = 10;
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
          // Tint decision from the LIVE threshold (a minApprovals change repaints from cache with zero
          // refetch). RED only when a change was requested (an active blocker that outranks approvals, so
          // it is checked FIRST). GREEN when enough approvals (Code Rabbit counted). Otherwise — a PR that
          // is neither blocked nor sufficiently approved — NO wash (leave the card default). No PR -> null.
          colorFor: function (entry) {
            if (!entry || !entry.hasPr) return null;
            if (entry.changesRequested) return 'red';                 // red ONLY when changes were requested (blocker wins)
            if (entry.approved >= this.minApprovals) return 'green';  // green when enough approvals (incl. Code Rabbit)
            return null;                                              // has a PR but neither condition -> no bar (default)
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
          // DEAD as of the ::before-bar switch (v1.2.13): inline backgroundColor on a card surface div
          // could not beat ADS's layered !important background, so coloring now paints via the
          // PR_BAR_CSS ::before bar toggled by data-ej-pr (see colorCard). Kept (no-deletions) but unused.
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
          // Mark (or unmark) the card with data-ej-pr so the extension-owned ::before wash (PR_TINT_CSS)
          // paints: 'green' | 'red' set the attribute, anything else removes it — and because the wash
          // lives entirely in a CSS rule keyed on that attribute, removal drops the whole layer and the
          // card returns to Jira's default surface with no residue to clean up. The wash itself is drawn
          // by the injected CSS, which beats ADS's layered !important background that inline styles
          // cannot. Idempotent: only writes when the attribute actually changes.
          colorCard: function (card, color) {
            try {
              var want = (color === 'green') ? 'green' : (color === 'red') ? 'red' : '';
              var cur = card.getAttribute('data-ej-pr') || '';
              if (cur === want) return;
              if (want) card.setAttribute('data-ej-pr', want);
              else card.removeAttribute('data-ej-pr');
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
          // MEASURED BUG (found live on v1.2.20, the single largest source of late RED): the observer
          // below debounces through requestAnimationFrame, and rAF DOES NOT FIRE WHILE THE TAB IS
          // HIDDEN — which the VS Code integrated browser tab very often is. The failure is worse than
          // a delay: the callback sets _scheduled = true and only ever clears it INSIDE the rAF
          // callback, so one mutation while hidden LATCHES _scheduled true and every subsequent
          // publish is dropped until the tab becomes visible again. Live capture: the companion
          // published two changes-requested issues at 7339ms and the cards did not turn red until
          // 12321ms — a ~5s stall in which the correct data was already sitting in the DOM, repainted
          // only when the 8s startRepaint backstop happened to tick.
          //
          // Fix: race rAF against a short timer and run whichever fires first, exactly once. When the
          // tab is visible this is still the rAF path (frame-aligned, no extra work); when hidden the
          // timer path runs it (background timers are clamped to ~1s, not suspended) and _scheduled is
          // always cleared, so the observer can never latch.
          function schedule(cb) {
            var ran = false;
            function run() { if (ran) return; ran = true; cb(); }
            raf(run);
            setTimeout(run, 250);
          }
          p.observer = new MutationObserver(function () {
            if (p._scheduled) return;
            p._scheduled = true;
            schedule(function () {
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
          // (unlike the throttled 8s timer) — but the DEBOUNCE used to reintroduce the very visibility
          // dependence that claim denied, because rAF is suspended while hidden; see schedule() above,
          // which is what actually makes this path visibility-independent now.
          // (Only THIS manager widens to documentElement; avatars/insights/popup stay on body.)
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
          // Build one avatar wrapper: a circular profile <img> when the reviewer carries an avatar URL,
          // else an initials circle. All values go in via DOM props/setAttribute (never innerHTML), so a
          // reviewer name can't break the raw-injected body. The <img> gets an onerror fallback to the
          // initials circle: reviewer avatar URLs (esp. cross-origin Bitbucket ones) may be blocked/404,
          // so a broken image degrades to initials instead of showing a broken-image glyph.
          buildAvatar: function (rv) {
            var name = rv.name || 'Reviewer';
            var isCr = rv.state === 'changes_requested';
            var isApp = rv.approved || rv.state === 'approved';
            var wrap = document.createElement('div');
            wrap.style.cssText = 'position:relative;width:24px;height:24px;display:inline-block;flex:0 0 auto;';
            wrap.setAttribute('title', name + (isCr ? ' — requested changes' : (isApp ? ' — approved' : '')));
            var ring = isCr ? 'box-shadow:0 0 0 2px #FF5630;' : (isApp ? 'box-shadow:0 0 0 2px #36B37E;' : '');
            var self = this;
            function initialsEl() {
              var f = document.createElement('div');
              f.textContent = self.initials(name);
              f.style.cssText = 'width:24px;height:24px;border-radius:50%;background:#5E6C84;color:#fff;font-size:10px;font-weight:600;display:flex;align-items:center;justify-content:center;' + ring;
              return f;
            }
            if (rv.avatar) {
              var img = document.createElement('img');
              img.src = rv.avatar;
              img.alt = name;
              img.referrerPolicy = 'no-referrer';
              img.style.cssText = 'width:24px;height:24px;border-radius:50%;object-fit:cover;display:block;' + ring;
              img.onerror = function () {
                try { if (img.parentNode === wrap) wrap.removeChild(img); if (!wrap.firstChild) wrap.appendChild(initialsEl()); } catch (e) {}
              };
              wrap.appendChild(img);
            } else {
              wrap.appendChild(initialsEl());
            }
            return wrap;
          },
          // Hide Jira's original avatar-group children and append our full-reviewer strip in their place.
          // Idempotent: an existing strip is removed first so a re-render repaints cleanly.
          render: function (group, reviewers, key) {
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
              if (key) strip.setAttribute('data-ej-key', key);
              strip.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;align-items:center;';
              for (var j = 0; j < reviewers.length; j++) strip.appendChild(this.buildAvatar(reviewers[j]));
              group.appendChild(strip);
            } catch (e) {}
          },
          // Find every open avatar-group container, then cross-reference each against the KNOWN issue keys
          // from the Stage-1 contract node by walking its ancestor text — the popup's issue key lives in a
          // sibling header/branch area (e.g. "Feature/CMMS-2791"), not inside the avatar-group subtree, so a
          // testid-prefix climb never reaches it. Matching against real keys is robust to adjacent badge text.
          apply: function () {
            try {
              if (!this.desired) return;
              var n = document.getElementById('__ej_bb_states');
              if (!n) return;
              var byIssue = {};
              try { byIssue = (JSON.parse(n.textContent || '{}') || {}).byIssue || {}; } catch (e) { return; }
              var keys = Object.keys(byIssue);
              if (!keys.length) return;
              var groups = document.querySelectorAll('[data-testid*="avatar-group--avatar-group"]');
              for (var g = 0; g < groups.length; g++) {
                var group = groups[g], key = null, node = group;
                for (var lvl = 0; lvl < 14 && node; lvl++) {
                  var tx = node.textContent || '';
                  for (var k = 0; k < keys.length; k++) { if (tx.indexOf(keys[k]) > -1) { key = keys[k]; break; } }
                  if (key) break;
                  node = node.parentElement;
                }
                if (!key) continue;
                var entry = byIssue[key];
                var reviewers = entry && entry.reviewers;
                if (!reviewers || !reviewers.length) continue;   // companion not ready for this issue -> leave Jira's popup as-is
                // Skip only when already rendered for THIS key AND our strip survived Jira's re-renders.
                var existing = group.querySelector('[data-ej-pr-strip="1"]');
                if (existing && existing.getAttribute('data-ej-key') === key) continue;
                this.render(group, reviewers, key);
              }
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
    var hasFetch = !(typeof steersman === 'undefined' || !steersman || !steersman.fetch);
    console.log('[EJ-BB]', 'available=' + hasFetch + (hasFetch ? '' : ' — steersman.fetch unavailable; publishing same-origin dev-status base only (no Bitbucket enrichment)'));
    // NOTE (refresh-proof redesign): the companion NO LONGER early-returns when the host bridge is
    // unavailable. Same-origin dev-status works from this isolated world regardless, so the pipeline
    // always runs and always publishes a real states node (coloring + approver list). The cross-origin
    // Bitbucket call is best-effort ENRICHMENT (deniers/changes-requested + avatars), gated on
    // bbAvailable and hard-bounded so it can never block the guaranteed base publish.
    var BB_TTL = 60000;    // per-PR participant cache TTL
    // Max concurrent CROSS-ORIGIN Bitbucket participant fetches. Raised 4 -> 8 on measurement, NOT on
    // hope: the live board runs 14 Review issues carrying 14 PRs, and a single Bitbucket participants
    // round trip costs ~1.5s no matter what (measured 1452ms cold, and again as a ~1490ms/PR drain
    // rate). At 4 wide those 14 PRs take 3.5 waves = ~5.2s, which is exactly the gap that was measured
    // between the base publish (2125ms, when GREEN appears) and the last red landing (7339ms). 8 wide
    // makes it 2 waves for anything up to 16 PRs, roughly halving the drain to ~3.0s.
    //
    // This is still a modest burst — well inside a browser's normal per-host budget, and each request
    // is a single small GET — but it IS more pressure on a rate-limit-sensitive API, so it is paired
    // with the bbLimit backoff below: the first 429/503 collapses the pool to 2 for the rest of the
    // session. Concurrency is adaptive rather than brute-forced.
    var BB_MAXC = 8;
    // Stage-1 (same-origin Jira dev-status) concurrency, split out from BB_MAXC — the two pools have
    // completely different risk profiles and were only ever sharing a number by accident.
    //
    // MEASURED (live cold load, 15 Review issues, from the [EJ-BB] console timeline): stage 1 took
    // 541ms -> 3479ms = ~2.9s of the ~4.9s to first red, because 15 issues drained 4-at-a-time (~4
    // waves x ~730ms). That single queue was the dominant cost of the whole cycle — NOT Bitbucket,
    // whose first response had already landed at 1452ms.
    //
    // 10 is defensible for this pool specifically: these are SAME-ORIGIN GETs to the very Jira host the
    // board is already talking to, over HTTP/2, so they multiplex on one connection rather than
    // contending for the old 6-per-host socket budget. The board's own bootstrap issues far more than
    // 10 parallel requests to this origin. The issue list is capped at maxResults=100 but runs ~15 in
    // practice, so 10 turns ~4 waves into 2 without ever presenting a large burst. Bitbucket stays at
    // BB_MAXC=4 — unchanged load against the rate-limit-sensitive cross-origin API.
    var DEV_MAXC = 10;
    var BB_COALESCE = 300; // ms to batch incremental enrichment publishes (see refresh's schedulePublish)
    var BB_WATCHDOG = 6000; // ms after stage 1 to force-finish if the Bitbucket pool somehow never drains
    var DEV_TO = 8000;     // hard timeout for each same-origin dev-status fetch (page fetch has none)
    var BB_TO = 8000;      // host-abort timeout for the cross-origin Bitbucket participants fetch
    var BB_BOTS = ${JSON.stringify(PR_BOTS)};   // empty (derives from PR_BOTS): count ALL approved reviewers, INCLUDING Code Rabbit, toward the threshold — the operator's rule (e.g. 2 humans + Code Rabbit = 3 = green). The popup lists every reviewer regardless (reviewers[] keeps them).
    // ---- Persisted enrichment cache (stale-while-revalidate) ------------------------------------
    // WHY: green derives from same-origin dev-status the page can already reach (~2.1s measured); red
    // derives ONLY from the cross-origin Bitbucket round trip above. On a genuinely cold load with no
    // prior knowledge, red CANNOT beat that round trip — so the only way red arrives with green is to
    // already know the answer. This cache is that prior knowledge: paint immediately from the last
    // cycle's result, revalidate unconditionally in the background every single load, and correct
    // within the same cycle. It never suppresses or delays a fetch; it only fills the dead time.
    var CACHE_V = 1;              // bump on any stored-shape change to orphan every old payload
    var CACHE_RED_TTL = 300000;   // 5 min — how long a cached RED may still paint (see readCache)
    var CACHE_TTL = 1800000;      // 30 min — how long a cached GREEN / no-colour entry may still paint
    var bridge = {
      bbAvailable: hasFetch, // false => dev-status base only; true => attempt Bitbucket enrichment too
      bbLimit: BB_MAXC,    // live Bitbucket concurrency; collapses to 2 on the first 429/503 (see fetchParticipants)
      prCache: {},         // 'repo#prId' -> { participants:[...], ts }
      _refreshing: false,
      loggedBb: false,     // per-refresh guard: log only the FIRST bridge-fetch outcome each cycle
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
      // sessionStorage key for this board, scoped to the Atlassian TENANT and ACCOUNT that the page
      // itself declares (ajs-cloud-id / ajs-atlassian-account-id meta tags). Because the identity is
      // baked into the key rather than checked after the fact, a different account or a different
      // site cannot read this entry at all — cross-account leakage is structurally impossible rather
      // than merely guarded, and logging out (no account meta) simply yields no key. Storage is
      // sessionStorage, not localStorage, so it is additionally scoped to this tab and dies with it.
      // Returns null when identity is not resolvable yet (document_start runs before <head> parses) —
      // callers then just skip the cache, which is the safe direction.
      cacheKey: function () {
        try {
          var cm = document.querySelector('meta[name="ajs-cloud-id"]');
          var am = document.querySelector('meta[name="ajs-atlassian-account-id"]');
          var b = this.boardId();
          var cid = cm && cm.content, aid = am && am.content;
          if (!cid || !aid || !b) return null;
          return '__ejbb:' + CACHE_V + ':' + cid + ':' + aid + ':' + b;
        } catch (e) { return null; }
      },
      // Read + VALIDATE the stored map, failing SAFE in every direction: a parse error, a wrong
      // version, a non-object payload, or a single malformed entry is DISCARDED rather than painted.
      // Nothing here trusts the stored bytes — every field is shape-checked before it can colour a
      // card, so a poisoned or hand-edited entry degrades to "no cache" (fetch fresh), never to
      // painting from garbage.
      //
      // Ageing is deliberately ASYMMETRIC. A cached RED is the assertive, disruptive claim — it tells
      // the operator a PR is blocked — so it is trusted for only CACHE_RED_TTL (5 min), long enough to
      // cover the reload-while-working loop this cache exists for and short enough that a blocker
      // resolved a while ago is never re-asserted from memory. GREEN / no-colour entries are the
      // quieter claim and hold for CACHE_TTL (30 min). Past its window an entry is simply dropped and
      // that card waits for fresh data.
      readCache: function () {
        try {
          var k = this.cacheKey();
          if (!k) return null;
          var raw = sessionStorage.getItem(k);
          if (!raw) return null;
          var d = JSON.parse(raw);
          if (!d || typeof d !== 'object' || d.v !== CACHE_V || typeof d.ts !== 'number') return null;
          var age = Date.now() - d.ts;
          if (!(age >= 0) || age > CACHE_TTL) return null;   // negative age = clock skew: distrust it
          var src = d.byIssue;
          if (!src || typeof src !== 'object') return null;
          var out = {}, n = 0;
          for (var key in src) {
            if (!src.hasOwnProperty(key)) continue;
            var e = src[key];
            if (!e || typeof e !== 'object') continue;
            if (typeof e.changesRequested !== 'boolean') continue;
            if (typeof e.approvedHumans !== 'number' || !(e.approvedHumans >= 0)) continue;
            if (!(e.reviewers instanceof Array) || !(e.changesRequestedBy instanceof Array)) continue;
            if (e.changesRequested && age > CACHE_RED_TTL) continue;   // stale RED: wait for fresh data
            out[key] = {
              changesRequested: e.changesRequested,
              changesRequestedBy: e.changesRequestedBy,
              approvedHumans: e.approvedHumans,
              reviewers: e.reviewers
            };
            n++;
          }
          return n ? out : null;
        } catch (e) { return null; }
      },
      // Persist a map of FRESH, Bitbucket-settled entries. Never called with the seed (see finish),
      // so a stale red can never refresh its own timestamp and become immortal.
      writeCache: function (map) {
        try {
          var k = this.cacheKey();
          if (!k || !map) return;
          sessionStorage.setItem(k, JSON.stringify({ v: CACHE_V, ts: Date.now(), byIssue: map }));
        } catch (e) {}   // quota/disabled storage: caching is an optimisation, never a requirement
      },
      // Same-origin JSON GET with resilience: the first concurrent batch of dev-status calls (the first ~3
      // issues in order) intermittently fails, dropping those issues from the publish. Retry a failed/non-ok
      // fetch up to 2 more times (~250ms apart) before giving up; returns null on final failure (throw-free),
      // which callers already tolerate.
      // Race a promise against a timeout: resolves the promise's value if it settles first, or the
      // fallback if it rejects OR the timeout elapses. NEVER rejects — so a single hung/erroring fetch
      // can never stall runPool or leave the refresh chain unsettled (the root of "publish never fires").
      withTimeout: function (p, ms, fb) {
        return new Promise(function (resolve) {
          var done = false;
          var t = setTimeout(function () { if (!done) { done = true; resolve(fb); } }, ms);
          Promise.resolve(p).then(
            function (v) { if (!done) { done = true; clearTimeout(t); resolve(v); } },
            function () { if (!done) { done = true; clearTimeout(t); resolve(fb); } }
          );
        });
      },
      getJson: function (url) {
        var self = this;
        var opts = { credentials: 'include', headers: { 'Accept': 'application/json' } };
        function attempt(triesLeft) {
          // Each attempt is hard-bounded (DEV_TO): the page fetch has no native timeout, so without
          // this a stalled same-origin request would hang the whole pipeline. withTimeout resolves
          // null on timeout/failure, which we treat as a retryable miss.
          var f = fetch(url, opts).then(function (r) {
            if (!r.ok) throw new Error('bad status ' + r.status);
            return r.json();
          });
          return self.withTimeout(f, DEV_TO, null).then(function (v) {
            if (v != null) return v;
            if (triesLeft <= 0) return null;
            return new Promise(function (res) { setTimeout(res, 250); }).then(function () { return attempt(triesLeft - 1); });
          });
        }
        return attempt(2);
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
              // Capture item per-iteration: the first pump() synchronously launches maxc workers before any
              // microtask runs, so a shared function-scoped var would leave every worker seeing only the LAST
              // assigned item (dropping items[0..maxc-2]). The IIFE gives each worker its own item.
              (function (item) {
                Promise.resolve().then(function () { return worker(item); }).catch(function () {}).then(function () {
                  active--; done++;
                  if (done >= n) resolve(); else pump();
                });
              })(it);
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
        // XHR-style request headers (A1): the bitbucket.org/!api/2.0 internal endpoint 3xx-REDIRECTs a
        // plain GET, which the host bridge surfaces as a typed 'blocked' error (redirect:'manual' SSRF
        // guard) — the recurring '[EJ-BB] bbFetch ERROR'. These headers make it return JSON directly.
        // Referer is a real bitbucket.org PR URL built from the same repo/id (settable host-side in Node).
        var referer = 'https://bitbucket.org/' + ref.repo + '/pull-requests/' + ref.prId;
        // Hard-bounded on BOTH sides so a non-responding host bridge can never stall runPool: pass
        // timeoutMs so the HOST aborts at BB_TO (the page-side __sm_call would otherwise wait ~33s),
        // and race the whole call (withTimeout) so we give up page-side even if the binding never
        // round-trips. This is best-effort enrichment — on timeout we simply cache nothing for this PR
        // and the already-published dev-status base stands.
        var call = steersman.fetch(url, {
          sessionCookies: true,
          timeoutMs: BB_TO,
          headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json', 'Referer': referer }
        }).then(function (res) {
          if (!self.loggedBb) { self.loggedBb = true; try { console.log('[EJ-BB]', 'bbFetch status=' + (res && res.status) + ' ok=' + (res && res.ok)); } catch (e) {} }
          // THROTTLING SIGNATURE: the raised BB_MAXC is only defensible if it yields the moment
          // Bitbucket pushes back. A 429 (rate limited) or 503 (overloaded) collapses the pool to 2
          // for the rest of the session — in-flight work finishes, but bbPump stops opening new slots
          // past the lower bound. Logged once so a real rate limit is visible rather than silent.
          if (res && (res.status === 429 || res.status === 503) && self.bbLimit > 2) {
            self.bbLimit = 2;
            try { console.log('[EJ-BB]', 'throttled (status ' + res.status + ') — Bitbucket concurrency reduced to 2'); } catch (e) {}
          }
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
        }).catch(function (e) {
          if (!self.loggedBb) {
            self.loggedBb = true;
            // Bridge rejections are typed OBJECTS ({type:'timeout'|'blocked'|'host'|..., message}).
            // String(e) rendered them as the useless '[object Object]', hiding the discriminator that
            // says WHICH failure this is — stringify the structure instead (same cap-and-truncate).
            var d;
            try { d = (e instanceof Error) ? (e.message || String(e)) : JSON.stringify(e); } catch (_) { d = String(e); }
            if (d === undefined) d = String(e);
            try { console.log('[EJ-BB]', 'bbFetch ERROR ' + String(d).slice(0, 200)); } catch (_) {}
          }
        });
        // TIMEOUT ORDERING (do not re-invert): the page-side __sm_call deadline is timeoutMs + 3000
        // (= BB_TO + 3000), so this outer race MUST be strictly LOOSER than that or it discards a
        // reply that arrived inside the transport's own budget. It was BB_TO + 1500 (9.5s) against an
        // 11s transport deadline, i.e. it pre-empted the transport and threw away late-but-valid
        // replies. Keep this margin > 3000 so the transport's typed error always wins the race and
        // this wrapper only ever fires as the last-resort "binding never round-tripped" backstop.
        return self.withTimeout(call, BB_TO + 4500, undefined);
      },
      // Aggregate an issue's PRs (from prCache) into reviewer FACTS. reviewers[] carries EVERY
      // participant (deduped by display name across PRs) for the Stage-2 popup. The tallies
      // (changesRequested/changesRequestedBy/approvedHumans that drive the RED/GREEN card trigger)
      // exclude only names in BB_BOTS — which is EMPTY per the operator's rule, so ALL approvers,
      // including Code Rabbit, count toward the threshold. Both unioned across the issue's PRs.
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
            if (!bot && cr) crBy[name] = true;      // only names in BB_BOTS are skipped (currently none)
            if (!bot && approved) apprBy[name] = true;   // BB_BOTS empty -> every approver counts, incl. Code Rabbit
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
      // Aggregate ONE issue's dev-status response into the SAME reviewer-facts shape as aggregateIssue,
      // using only same-origin data (detail[].pullRequests[].reviewers[].{name, approved}). This is the
      // RELIABLE BASE for red/green (approvedHumans) and the approver list (reviewers[]). dev-status has
      // no changes-requested signal, so changesRequested is always false here (deniers come only from the
      // Bitbucket enrichment). Tally excludes only BB_BOTS (empty per operator), so every approver —
      // including Code Rabbit — counts toward the threshold; reviewers[] keeps everyone regardless.
      aggregateDev: function (dj) {
        var self = this;
        var reviewersByName = {}, apprBy = {};
        var detail = (dj && dj.detail) || [];
        for (var i = 0; i < detail.length; i++) {
          var prs = (detail[i] && detail[i].pullRequests) || [];
          for (var k = 0; k < prs.length; k++) {
            var revs = (prs[k] && prs[k].reviewers) || [];
            for (var b = 0; b < revs.length; b++) {
              var rv = revs[b];
              var name = rv && rv.name;
              if (!name) continue;
              var approved = rv.approved === true;
              // dev-status reviewer avatar field name varies by instance; try the common shapes. Often
              // absent — then the popup uses the Bitbucket-enriched avatar (aggregateIssue) or initials.
              var avatar = rv.avatar || rv.avatarUrl || (rv.avatarUrls && (rv.avatarUrls['48x48'] || rv.avatarUrls['24x24'])) || null;
              var ex = reviewersByName[name];
              if (!ex) {
                reviewersByName[name] = { name: name, approved: approved, state: (approved ? 'approved' : null), avatar: avatar };
              } else {
                ex.approved = ex.approved || approved;
                if (approved && ex.state !== 'changes_requested') ex.state = 'approved';
                if (!ex.avatar && avatar) ex.avatar = avatar;
              }
              if (approved && !self.isBot(name)) apprBy[name] = true;
            }
          }
        }
        var reviewers = [], apprCount = 0;
        for (var n1 in reviewersByName) { if (reviewersByName.hasOwnProperty(n1)) reviewers.push(reviewersByName[n1]); }
        for (var n2 in apprBy) { if (apprBy.hasOwnProperty(n2)) apprCount++; }
        return { changesRequested: false, changesRequestedBy: [], approvedHumans: apprCount, reviewers: reviewers };
      },
      // Merge the dev-status BASE map with the Bitbucket ENRICHED map, keyed by issue key. Prefer the
      // enriched entry only when it actually produced reviewers (it adds the changes-requested/denier
      // signal + real avatars); otherwise keep the reliable base so coloring + the approver list still
      // work for issues whose Bitbucket call timed out. Only base issues (>=1 PR) are emitted.
      mergeBase: function (base, enriched) {
        var out = {};
        for (var key in base) {
          if (!base.hasOwnProperty(key)) continue;
          var e = enriched && enriched[key];
          out[key] = (e && e.reviewers && e.reviewers.length) ? e : base[key];
        }
        return out;
      },
      // Write the whole states map to the hidden contract node the main-world coloring reads. REPLACE the
      // node fresh on every publish (remove old + createElement + append) rather than mutating textContent:
      // the removal+append is a childList mutation on documentElement, which the coloring's documentElement
      // observer catches (fires even when the tab is hidden) — a textContent update would be characterData
      // and go unseen. Kept on document.documentElement (outside <body>) so Jira's React root never
      // reconciles/removes it.
      publish: function (byIssue, label) {
        try {
          var old = document.getElementById('__ej_bb_states');
          if (old && old.parentNode) old.parentNode.removeChild(old);
          var n = document.createElement('script');
          n.type = 'application/json';
          n.id = '__ej_bb_states';
          n.textContent = JSON.stringify({ available: true, bbAvailable: !!this.bbAvailable, updatedAt: Date.now(), byIssue: byIssue });
          if (document.documentElement) document.documentElement.appendChild(n);
        } catch (e) {}
        try {
          var cnt = 0, cr = 0;
          for (var k in byIssue) { if (byIssue.hasOwnProperty(k)) { cnt++; if (byIssue[k].changesRequested) cr++; } }
          console.log('[EJ-BB]', 'published' + (label ? ' (' + label + ')' : '') + ' issues=' + cnt + ' changesRequested=' + cr);
        } catch (e) {}
      },
      // Refresh pipeline, redesigned to ALWAYS publish. Stage 1 (same-origin dev-status) is the RELIABLE
      // BASE and is published as soon as it resolves — coloring + the approver list work immediately,
      // with zero dependence on the cross-origin bridge. Stage 2 (Bitbucket participants) is best-effort
      // ENRICHMENT (deniers/changes-requested + avatars), hard-bounded so it can never block; when it
      // resolves in time we re-publish the merged (richer) map. A safePublish guard + a final .catch
      // guarantee #__ej_bb_states always exists even on error/timeout.
      refresh: function () {
        var self = this;
        if (self._refreshing) return;
        self._refreshing = true;
        self.loggedBb = false;   // fresh cycle: allow one bbFetch-outcome log
        var byIssuePrs = {};     // issueKey -> [{ repo, prId, prKey }]
        var devBase = {};        // issueKey -> reliable reviewer facts from same-origin dev-status
        var published = false;   // ensure publish() fires at least once
        function safePublish(map, label) { try { self.publish(map, label); published = true; } catch (e) {} }
        // ---- Bitbucket enrichment pool (self-pumping) --------------------------------------------
        // Replaces the old runPool(refs, ...) over a list collected AFTER stage 1 finished. Two costs
        // in that shape, both of which only ever delayed RED (green/none come from the same-origin base):
        //   1. BARRIER: no Bitbucket request started until EVERY dev-status call had returned.
        //   2. ALL-OR-NOTHING PUBLISH: the enriched map was published once, after the LAST PR settled, so
        //      one slow PR held back every red card whose own PR had resolved in milliseconds.
        // Now refs are enqueued per-issue the moment that issue's dev-status resolves (stage 2 overlaps
        // stage 1), and landed results are published incrementally. Bitbucket concurrency is UNCHANGED at
        // BB_MAXC and cycle-level dedup is unchanged, so this issues the exact same set of requests at the
        // same peak parallelism — it is re-sequencing, not extra load.
        var bbSeen = {};         // prKey -> true; cycle-level dedup (was the old inline "seen" map)
        var bbPending = {};      // issueKey -> outstanding Bitbucket fetches this cycle
        var bbSettled = {};      // issueKey -> true once THIS cycle holds real Bitbucket evidence for it
        var seed = null;         // cached enrichment from a previous load (stale-while-revalidate)
        var bbQueue = [];        // refs waiting for a slot
        var bbActive = 0;        // in-flight Bitbucket fetches, bounded by the live self.bbLimit
        var stage1Done = false;  // stage 1 finished enqueuing, so a drained queue means truly finished
        var baseDone = false;    // RETAINED: still set at the base publish, but no longer gates publishing (see bbPump)
        var finished = false;    // one-shot terminal publish guard
        var firstPub = true;     // first publish of the cycle skips the coalesce window (see schedulePublish)
        var pubTimer = null;
        var watchdog = null;
        // Build the enriched map from whatever is in prCache RIGHT NOW and publish it merged over the
        // base. Partial enrichment is safe BY CONSTRUCTION: mergeBase prefers an enriched entry only when
        // it actually produced reviewers, so a not-yet-fetched issue silently falls back to its base entry
        // (green/none) instead of being painted from missing data. Cards therefore only ever flip TOWARD
        // red as real evidence lands — never red-then-not-red off a partial read.
        function publishMerged(label) {
          try {
            var enriched = {};
            for (var k in byIssuePrs) {
              if (byIssuePrs.hasOwnProperty(k)) enriched[k] = self.aggregateIssue(byIssuePrs[k]);
            }
            safePublish(withSeed(self.mergeBase(devBase, enriched)), label);
          } catch (e) {}
        }
        // Overlay the cached map UNDER this cycle's fresh map. This is what keeps publishes MONOTONIC
        // across a cached start, and both rules are load-bearing:
        //
        //   1. A key the fresh cycle has not produced AT ALL yet keeps its cached entry, so nothing
        //      the cache painted vanishes in the gap before real data arrives.
        //   2. A cached RED outranks the fresh entry until that issue's Bitbucket calls have actually
        //      SETTLED. This one is subtle and essential: the dev-status base carries NO
        //      changes-requested signal (aggregateDev hardcodes changesRequested:false), so without
        //      this rule the base publish at ~2.1s would clear a cached red and the enrichment would
        //      re-assert it seconds later — precisely the red -> not-red -> red flicker we forbid.
        //
        // Once bbSettled[key] is set the fresh entry wins ABSOLUTELY, cached red or not. That is the
        // self-correction: a card wrongly red from cache goes correct the moment its own Bitbucket
        // reply lands (measured ~1.5s cold, and it is in the first wave), not at the end of the cycle.
        function withSeed(fresh) {
          if (!seed) return fresh;
          var out = {};
          for (var a in fresh) { if (fresh.hasOwnProperty(a)) out[a] = fresh[a]; }
          for (var k in seed) {
            if (!seed.hasOwnProperty(k)) continue;
            if (bbSettled[k]) continue;                        // real evidence in hand: never use cache
            if (!out[k] || seed[k].changesRequested) out[k] = seed[k];
          }
          return out;
        }
        // Paint from cache as early as this load allows. Guarded against ever regressing over a real
        // publish (published), and re-armed on DOMContentLoaded because this companion runs at
        // document_start — before <head> is parsed, so the identity meta tags cacheKey() needs may not
        // exist on the first attempt. Either way the seed lands far ahead of the ~2.1s base publish.
        function seedFromCache() {
          if (seed || published) return;
          // COLD START ONLY. refresh() also runs on the 90s interval, by which point a live states node
          // is already on screen — and the cached map is a SUBSET (only Bitbucket-settled issues with
          // reviewers), so publishing it over a richer live map would blank every card missing from it
          // until the base publish ~2s later. An existing node always beats the cache; seeding is for
          // the load where there is nothing on screen at all.
          try { if (document.getElementById('__ej_bb_states')) return; } catch (e) { return; }
          var c = self.readCache();
          if (!c) return;
          if (!self.bbAvailable) {
            // No host bridge this session means no Bitbucket call will ever arrive to correct a cached
            // red, so a red seeded here could linger unchallenged for its whole TTL. Keep only the
            // green / no-colour entries, which the same-origin base can and does confirm.
            var safe = {}, kept = 0;
            for (var rk in c) {
              if (!c.hasOwnProperty(rk) || c[rk].changesRequested) continue;
              safe[rk] = c[rk]; kept++;
            }
            if (!kept) return;
            c = safe;
          }
          seed = c;
          safePublish(c, 'cache');
        }
        seedFromCache();
        if (!seed) {
          try { document.addEventListener('DOMContentLoaded', seedFromCache, { once: true }); } catch (e) {}
        }
        // Coalesce bursts of landed fetches into at most one publish per BB_COALESCE. Each publish
        // replaces the contract node and wakes the painter for every card, so publishing per-fetch would
        // trade the old latency for repaint thrash.
        //
        // EXCEPT the FIRST publish of a cycle, which goes out immediately (firstPub). That one carries
        // the first red the operator will see, and making it wait a full coalesce window was pure added
        // latency for the single most-noticed paint of the load. Every SUBSEQUENT publish still
        // coalesces, so the thrash protection is intact for the burst that follows.
        function schedulePublish() {
          if (pubTimer || finished) return;
          if (firstPub) { firstPub = false; publishMerged('partial'); return; }
          pubTimer = setTimeout(function () { pubTimer = null; publishMerged('partial'); }, BB_COALESCE);
        }
        function clearTimers() {
          if (pubTimer) { clearTimeout(pubTimer); pubTimer = null; }
          if (watchdog) { clearTimeout(watchdog); watchdog = null; }
        }
        // Terminal publish: fires once, when stage 1 has finished enqueuing AND the pool has drained (or
        // the watchdog gives up). Always clears _refreshing so the 90s interval can never wedge.
        function finish(label) {
          if (finished) return;
          finished = true;
          clearTimers();
          publishMerged(label || 'enriched');
          // Persist ONLY this cycle's own freshly-settled, Bitbucket-backed entries. Deliberately NOT
          // the published (seed-merged) map: re-persisting the seed would let a stale red keep
          // refreshing its own timestamp and outlive CACHE_RED_TTL forever. An entry must earn its
          // place in the cache by being fetched this cycle.
          try {
            var keep = {}, any = false;
            for (var ck in byIssuePrs) {
              if (!byIssuePrs.hasOwnProperty(ck) || !bbSettled[ck]) continue;
              var ce = self.aggregateIssue(byIssuePrs[ck]);
              if (ce && ce.reviewers && ce.reviewers.length) { keep[ck] = ce; any = true; }
            }
            if (any) self.writeCache(keep);
          } catch (e) {}
          self._refreshing = false;
        }
        function maybeFinish() {
          if (!stage1Done || bbActive > 0 || bbQueue.length) return;
          finish('enriched');
        }
        function bbPump() {
          while (bbActive < self.bbLimit && bbQueue.length) {
            var next = bbQueue.shift();
            bbActive++;
            // Same per-iteration capture rationale as runPool's IIFE: the synchronous while-loop launches
            // several workers before any microtask runs, so each needs its own binding.
            (function (ref) {
              Promise.resolve().then(function () { return self.fetchParticipants(ref); })
                .catch(function () {})
                .then(function () {
                  bbActive--;
                  // This issue now holds one more piece of real Bitbucket evidence; when its last
                  // outstanding PR settles, mark it settled so withSeed stops preferring the cache for
                  // it and the fresh answer takes over unconditionally.
                  var ik = ref.issueKey;
                  if (ik && bbPending[ik]) { bbPending[ik]--; if (!bbPending[ik]) bbSettled[ik] = true; }
                  // MEASURED FIX: this used to be gated on baseDone, which withheld every
                  // landed Bitbucket result until stage 1 had fully drained. On the live cold load the
                  // first Bitbucket response arrived at 1452ms but the base publish did not fire until
                  // 3479ms — so ~2s of correct, already-in-hand changes-requested data sat unpublished,
                  // and first red landed at 4866ms. Publishing as it lands removes that dead time.
                  //
                  // Safe by construction, and this is load-bearing: publishMerged -> mergeBase only emits
                  // keys already present in devBase, and only prefers an enriched entry when it actually
                  // produced reviewers. An issue whose dev-status or Bitbucket call has not returned yet
                  // is simply ABSENT from the map, so the painter leaves that card alone rather than
                  // colouring it from missing data. Successive publishes therefore only ever ADD
                  // information — a card can go uncoloured -> green -> red as evidence lands, but never
                  // red -> not-red off a partial read.
                  schedulePublish();
                  bbPump();
                  maybeFinish();
                });
            })(next);
          }
        }
        function bbEnqueue(refs) {
          if (!self.bbAvailable || !refs) return;
          for (var i = 0; i < refs.length; i++) {
            if (bbSeen[refs[i].prKey]) continue;   // already queued/fetched this cycle
            bbSeen[refs[i].prKey] = true;
            if (refs[i].issueKey) bbPending[refs[i].issueKey] = (bbPending[refs[i].issueKey] || 0) + 1;
            bbQueue.push(refs[i]);
          }
          // An issue whose every PR was deduped away (all already queued/fetched this cycle) has
          // nothing outstanding of its own, so its evidence is already in hand. Settle it here or a
          // cached red for that issue would have no event left to clear it.
          for (var j = 0; j < refs.length; j++) {
            var k2 = refs[j].issueKey;
            if (k2 && !bbPending[k2]) bbSettled[k2] = true;
          }
          bbPump();
        }
        // Wrap the whole chain CONSTRUCTION (not just the async .catch): a synchronous throw before the
        // first .then attaches would otherwise escape the trailing .catch, leaving #__ej_bb_states
        // unpublished AND self._refreshing stuck true (which would no-op the 90s auto-refresh until a
        // fresh page load). On a sync throw we still publish the (empty) base and clear the flag.
        try {
          self.fetchIssues().then(function (issues) {
            try { console.log('[EJ-BB]', 'reviewIssues=' + issues.length); } catch (e) {}
            // Stage 1: dev-status per issue (same-origin, throttled) — collects BOTH the PR refs (for the
            // Bitbucket enrichment) AND the reliable base reviewer facts.
            return self.runPool(issues, function (issue) {
              var devUrl = '/rest/dev-status/latest/issue/detail?issueId=' + encodeURIComponent(issue.id) + '&applicationType=bitbucket&dataType=pullrequest';
              return self.getJson(devUrl).then(function (dj) {
                var prs = self.extractPrs(dj);
                if (prs.length) {
                  byIssuePrs[issue.key] = prs;
                  devBase[issue.key] = self.aggregateDev(dj);
                  // Stamp each ref with its issue so the pool can tell when an ISSUE (not just a PR)
                  // has real Bitbucket evidence — the signal withSeed uses to retire a cached entry.
                  for (var pi = 0; pi < prs.length; pi++) prs[pi].issueKey = issue.key;
                  // PIPELINE: start this issue's Bitbucket fetches immediately rather than waiting for the
                  // whole stage-1 pool. By the time the base publish fires, much of the enrichment has
                  // already landed, so the first red appears ~one coalesce window later instead of after
                  // the last PR in the board settles.
                  bbEnqueue(prs);
                }
              }).catch(function () {});
            }, DEV_MAXC);
          }).then(function () {
            // GUARANTEED early publish (coloring + approver list work now).
            //
            // This MUST go through publishMerged, not safePublish(mergeBase(devBase, {})). Now that
            // enrichment publishes as it lands, a Bitbucket-derived red may ALREADY be on screen by the
            // time stage 1 finishes; republishing the bare base would drop the changes-requested signal
            // and visibly flip that card red -> not-red, only for it to flip back on the next publish.
            // publishMerged folds in whatever enrichment has landed, keeping publishes monotonic.
            publishMerged('base');
            firstPub = false;   // the cycle has now published; later enrichment coalesces as normal
            baseDone = true;
            if (!self.bbAvailable) { self._refreshing = false; return; }   // no host bridge: base is final
            // Stage 2 was already started per-issue above; stage 1 is now done enqueuing, so a drained
            // queue means the cycle is genuinely complete.
            stage1Done = true;
            // Anything that already landed during stage 1 publishes on the next coalesce tick.
            if (bbActive > 0 || bbQueue.length) schedulePublish();
            // Backstop: fetchParticipants is withTimeout-bounded and never rejects, so the pool should
            // always drain — but this file has been bitten by "publish never fires" before, and a wedged
            // pool would also leave _refreshing true and no-op every subsequent 90s refresh. Force the
            // terminal publish if the pool has not drained well past the per-fetch ceiling.
            watchdog = setTimeout(function () { finish('enriched'); }, BB_TO + BB_WATCHDOG);
            maybeFinish();   // handles the zero-PR case, where nothing was ever enqueued
          }).catch(function () {
            // Any unexpected error/timeout still leaves a states node standing.
            clearTimers();
            // publishMerged (not a bare mergeBase) so this still folds in the cache seed and any
            // enrichment that landed before the failure — the error path must not be the one place
            // that regresses an already-painted card.
            publishMerged('base');
            self._refreshing = false;
          });
        } catch (e) {
          // Synchronous throw during chain construction: publish the base so the painter has a node,
          // and clear _refreshing so the auto-refresh interval keeps working.
          try { console.log('[EJ-BB]', 'refresh sync error ' + (e && e.message ? e.message : e)); } catch (_) {}
          clearTimers();
          if (!published) safePublish(self.mergeBase(devBase, {}), 'base');
          self._refreshing = false;
        }
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
