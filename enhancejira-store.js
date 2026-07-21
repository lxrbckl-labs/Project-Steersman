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

// ===================================================================================================
// >>> THE AVATAR DIAL <<<  Edit these three values to change the per-reviewer avatar shading.
// ===================================================================================================
// This shades an INDIVIDUAL reviewer's avatar by THAT PERSON'S own review state (green = they
// approved, red = they requested changes, unshaded = neither yet). It is deliberately a different
// question from the card colour above, which reports the issue's AGGREGATE state — so a red card can
// legitimately carry green avatars, and that is not a bug.
//
// Each shaded avatar gets TWO layers:
//   1. a 2px solid RING around it (the primary, at-a-glance signal), and
//   2. a light TINT wash over it at AVATAR_TINT_ALPHA (secondary, so the whole disc carries the
//      colour) — kept low enough that the face stays recognisable.
//
// WHY THESE ARE NOT LITERALLY THE PR_SOLID_* CARD VALUES: they are the SAME TWO HUES, moved along
// the luminance axis, because the constraint is inverted. A card fill sits BEHIND 12px text, so it
// must be far from the text's luminance (deep in dark theme, pale in light theme) — that is what
// PR_SOLID_* is tuned for. A 2px ring carries NO text; it sits against the board background and must
// simply be SEEN. PR_SOLID_GREEN_DARK rgb(11,71,43) against the dark board surface rgb(36,37,40) is
// only ~1.4:1 — effectively invisible as a hairline. So each ring is a HUE-PRESERVING BRIGHTENING of
// the corresponding dark card solid, i.e. every channel multiplied by one scalar, which leaves the
// hue mathematically identical and only raises luminance:
//
//   green  rgb(11, 71, 43)  x 2.6  ->  rgb(29, 185, 112)   (hue 152 deg, unchanged)
//   red    rgb(112, 28, 22) x 2.0  ->  rgb(224, 56, 44)    (hue 4 deg,   unchanged)
//
// These are deliberately THEME-NEUTRAL (one value used in both light and dark). They are mid-
// luminance, so they read against a dark board (~5.9:1 green, ~3.4:1 red) and against a white one
// (~2.3:1 green, ~4.1:1 red) without needing a second, leak-prone theme-prefixed rule set — and
// unlike the card CSS these are applied as inline styles from JS, where there is no stylesheet to
// prefix in the first place.
//
// If you want them LOUDER, raise AVATAR_TINT_ALPHA (the wash) first — the ring is already saturated.
// Above ~0.45 the tint starts to swallow facial detail, which is the thing this dial trades against.
const AVATAR_RING_GREEN_RGB = '29, 185, 112';   // PR_SOLID_GREEN_DARK x 2.6 (same hue, raised luminance)
const AVATAR_RING_RED_RGB = '224, 56, 44';      // PR_SOLID_RED_DARK   x 2.0 (same hue, raised luminance)
const AVATAR_TINT_ALPHA = 0.28;                 // wash opacity over the photo; keep the face readable

// Whether the BOARD-HEADER avatar strip (#__ej_avatar_strip, next to the board title) is shaded too.
// OFF by default at the operator's request: that strip lists board MEMBERS, not a ticket's reviewers,
// so shading it aggregates one person's state across every issue they review — a board-wide readout
// nobody asked for, sitting on a surface that is not about review at all. The per-ticket hover-popup
// shading (which IS per-reviewer, per-issue) is unaffected by this dial and stays on. Flip to true to
// get the aggregate view back; the code path below is retained in full, just gated.
const AVATAR_SHADE_HEADER_STRIP = false;

// ===================================================================================================
// >>> THE FROSTED-POPUP DIAL <<<  Edit these three values to change the hover card's frosted glass.
// ===================================================================================================
// Turns the PR hover card (Jira's dev-info popup — the per-card approver/denier panel our avatar strip
// renders into) from a solid slab into frosted glass: a SEMI-TRANSPARENT surface over a BLURRED
// backdrop. Transparency is what makes the blur visible at all — over a fully opaque background there
// is nothing showing through to blur — so the alpha and the blur are one setting in two numbers.
//
// backdrop-filter, NOT filter. `filter: blur()` blurs the element AND its content, which would smear
// the reviewer names, avatars and rings into mush. `backdrop-filter` blurs only what is painted BEHIND
// the element; the popup's own content stays pixel-sharp.
//
// THE COMPOSITING TRAP, CHECKED LIVE. An element with backdrop-filter blurs its "backdrop root", and a
// wrongly-placed ancestor silently makes the effect a no-op or blurs the wrong layer. The real ancestry
// (measured on the live board) is:
//     popup  [data-testid="development-board-dev-info-icon.popup"]  fixed, transform, z-index 400
//       -> div.atlaskit-portal            z-index 399
//       -> div.atlaskit-portal-container
//       -> body#jira                      transform: translate(0, 32px)
// A backdrop root is established by filter / opacity < 1 / mask / mix-blend-mode / will-change of
// those / contain:paint — a TRANSFORM IS NOT ONE OF THEM, so body's transform does not clip the
// backdrop and the popup blurs the whole board behind it. Every ancestor was verified to carry
// filter:none, opacity:1, mix-blend-mode:normal, will-change:auto, contain:none. The popup's OWN
// transform is harmless (an element's own transform never gates its own backdrop-filter). This is why
// the property goes on the popup element itself and not on a wrapper.
//
// WHY THERE IS A brightness() AND NOT A SEPARATE SCRIM. A translucent scrim in the SAME colour as the
// surface is mathematically identical to just raising the surface alpha (1-(1-a1)(1-a2)), so it buys
// nothing. The real problem is that blur removes DETAIL but not BRIGHTNESS — a blurred white avatar
// behind pale 14px text is still a smooth bright patch. brightness() is the scrim done properly: it
// clamps the backdrop's luminance BEFORE compositing, killing bright outliers while leaving the
// already-dark board essentially untouched. That is what buys the legibility headroom below.
//
// WHY THERE IS A saturate(), AND WHY THE FIRST CUT OF THIS LOOKED SOLID. The original dials
// (blur 24 / brightness 0.45 / alpha 0.6) were verified live to APPLY correctly — the popup element
// really did compute `background-color: rgba(43,44,47,0.6)` and `backdrop-filter: blur(24px)
// brightness(0.45)`, with no opaque child painting over it — and the popup STILL read as a solid slab.
// The reason is arithmetic, not plumbing. Backdrop detail reaches the eye multiplied by
// (1 - alpha) x brightness = 0.4 x 0.45 = 0.18, and the board behind is already dark and low-contrast,
// so an 18% share of it is nothing. Measured on the live rendered popup, the text-free gutters came out
// at rgb(34,35,38) with a luminance SD of 0.0017 and a max-minus-min channel spread of 4 — i.e. a flat,
// uniform, unmistakably OPAQUE-looking panel. The operator was right.
//
// Raising the transmission alone does not rescue it: sweeping alpha and brightness across the whole
// AA-legal range only ever tripled the surface texture, because a 24px blur of a dark board averages
// out to a near-constant no matter how much of it you let through. The lever that actually works is
// saturate(). WCAG contrast is a function of relative LUMINANCE only, while saturate() moves colour
// away from grey at essentially constant luminance — so it buys visible glassiness almost for free in
// contrast terms. That is the whole trick, and it is why the recipe is blur + saturate + brightness.
//
// MEASURED, not estimated. The binding text is Jira's own --ds-text-subtlest #96999E at 14px/400
// ("Last updated … ago"), so plain-text AA (>= 4.5:1) applies. Against the SOLID popup it scores only
// 4.885:1 — Jira ships just 0.385 of headroom, which is why naive translucency fails immediately.
//
// The binding worst case is a SOLID CARD FILL, not a bright speck. A card fill is ~268x150 CSS px,
// far larger than the blur kernel, so its interior survives the blur essentially unchanged and the
// popup composites against a full field of it. Small bright features (24px avatars, glyphs) are the
// opposite: the blur averages them away, so they never bind. Contrast was therefore evaluated against
// UNIFORM FIELDS of every surface the popup can sit over, computed through Chromium's own filter
// pipeline (canvas ctx.filter, same code path as backdrop-filter) rather than by hand:
//
//   uniform backdrop          -> composite        subtlest  verdict
//   PR_SOLID_RED_DARK            rgb(78,18,19)     5.191:1  PASS   <- binds
//   PR_SOLID_GREEN_DARK          rgb(17,44,25)     5.252:1  PASS
//   QA/lighter card              rgb(32,34,38)     5.580:1  PASS
//   board surface rgb(36,37,40)  rgb(27,28,31)     5.971:1  PASS
//   body bg rgb(31,31,33)        rgb(26,26,29)     6.080:1  PASS
//
// The worst of those, 5.191:1, is BETTER than the 4.885:1 of the untouched solid ADS popup. That is the
// invariant worth keeping: the frosted popup is never less legible than the stock one it replaces,
// on any backdrop the board can put behind it — because brightness() removes more backdrop luminance
// than the reduced surface alpha lets back in.
//
// Confirmed end-to-end on the rendered page (screenshot pixels sampled from the live popup's own
// text-free gutters, frost on vs. the previous dials): surface luminance SD 0.0017 -> 0.0028 and
// channel spread 4 -> 14, with the column gutter and the card edges behind now plainly visible
// through the glass while the popup's own text stays pixel-sharp.
//
// TUNING. POPUP_BACKDROP_SATURATE is the cheap dial — push it for more glass, it costs almost no
// contrast (2.5 -> 3.2 moved the binding case by under 0.02). The expensive dials are brightness and
// alpha; every 0.02 of brightness costs roughly 0.07 of contrast on the binding red-card case, and
// raising brightness past ~0.62 at this alpha is what breaks AA first. Lowering POPUP_BLUR_PX below
// ~14 starts letting card TEXT read through as legible-but-smeared shapes behind our own text, which
// is visually noisy long before it is a contrast problem.
const POPUP_BLUR_PX = 16;               // backdrop blur radius (CSS blur() std deviation)
const POPUP_SURFACE_ALPHA = 0.4;        // opacity of the popup surface; lower = glassier, less legible
const POPUP_BACKDROP_SATURATE = 2.5;    // backdrop colour boost; buys visible glass at ~no contrast cost
const POPUP_BACKDROP_BRIGHTNESS = 0.48; // backdrop luminance clamp; the "scrim", done as a filter

// Jira's own overlay colour (--ds-surface-overlay, #2B2C2F). The HUE is deliberately unchanged — only
// its alpha moves — so the frosted popup still reads as the same ADS surface, just translucent.
const POPUP_SURFACE_RGB = '43, 44, 47';
// The popup element, verified live. Scoped to dark mode with the SAME PR_DARK_PREFIX hook the card
// fills use: light-mode tuning would need its own measured numbers, and this tenant does not even ship
// the light token set (every --ds-* resolves empty under data-color-mode="light"), so light mode keeps
// the untouched solid popup rather than an unmeasured translucent one.
const POPUP_SELECTOR = '[data-testid="development-board-dev-info-icon.popup"]';
// @supports gates BOTH declarations together — that pairing is the whole fallback. Where backdrop-filter
// is unavailable or disabled the block is skipped entirely, so the popup keeps ADS's SOLID background
// instead of becoming a transparent, unreadable panel. Verified live: the integrated browser
// (Chromium 148 / Electron 42) honours the UNPREFIXED form and reports -webkit-backdrop-filter as
// UNSUPPORTED, so gating on the -webkit- spelling would disable the effect outright — do not add it.
const PR_POPUP_FROST_CSS =
  `@supports (backdrop-filter: blur(1px)){` +
  `${PR_DARK_PREFIX}${POPUP_SELECTOR}` +
  `{background-color:rgba(${POPUP_SURFACE_RGB}, ${POPUP_SURFACE_ALPHA}) !important;` +
  `backdrop-filter:blur(${POPUP_BLUR_PX}px) saturate(${POPUP_BACKDROP_SATURATE}) ` +
  `brightness(${POPUP_BACKDROP_BRIGHTNESS}) !important;}}`;

// ===================================================================================================
// >>> THE FROSTED-MODAL DIAL <<<  Edit these values to change the Development-details modal's glass.
// ===================================================================================================
// Extends the frosted-glass treatment from the hover popup above to Jira's DEVELOPMENT DETAILS modal —
// the full-size dialog our PR button opens (and the one the popup's "View all development information"
// footer used to lead to). Same recipe (blur + saturate + brightness over a translucent surface, see
// the popup dial for why each term exists), but DELIBERATELY DIFFERENT NUMBERS, for one reason:
//
// THE MODAL HAS A SCRIM AND THE POPUP DOES NOT. Measured live, the modal's ancestry is
//     section [data-testid="development-details.main.modal-dialog"]      the surface we frost
//       -> div  ...--positioner                                          z-index 510
//       -> div  ...--blanket        background rgba(16,18,20,0.6)        z-index 500   <- the scrim
//       -> div.atlaskit-portal -> div.atlaskit-portal-container -> body#jira
// Every one of those ancestors was checked for the properties that establish a BACKDROP ROOT (filter,
// opacity<1, mask, mix-blend-mode, will-change of those, contain:paint) and ALL are clean — so, exactly
// as with the popup, backdrop-filter on the surface itself reaches the real board behind. The catch is
// that the BLANKET IS AN ANCESTOR, so what the modal's backdrop-filter samples is the board ALREADY
// composited under a 0.6 dark scrim. Board detail therefore arrives at only 40% strength before our
// filter even runs, and stacking the popup's brightness(0.48) on top of Jira's scrim is a DOUBLE scrim.
//
// That is precisely the v1.2.23 failure mode — a rule that applies perfectly and yields a flat panel —
// and it reproduced here. Measured on the rendered modal (screenshot pixels, text-free side/top gutters,
// luminance SD and max-minus-min channel spread; the stock solid modal is the control):
//     stock solid modal                       SD 0.00009  spread 4.3   <- a flat, opaque slab
//     popup's dials verbatim (K 0.48, 0.6 scrim) SD 0.00051  spread 8.7   <- applied, still nearly flat
//     these dials    (K 0.60, 0.25 scrim)     SD 0.00202  spread 19.0  <- 22x the control: real glass
// So the fix is two-sided: RELIEVE Jira's scrim (MODAL_SCRIM_ALPHA, 0.6 -> 0.25) and RAISE brightness
// (0.48 -> 0.60), because with a scrim already present our brightness() no longer has to be the scrim.
// The scrim is relieved, NOT removed: at MODAL_SCRIM_ALPHA 0 the glass is brighter still (SD 0.00179 at
// K 0.48) but the binding contrast falls to 4.683:1 — over AA, yet BELOW the 4.885:1 of the stock solid
// modal, which breaks the invariant the popup established (never less legible than what we replace).
//
// MEASURED, not estimated. The binding text is the same --ds-text-subtlest #96999E that binds the popup
// (14px/400 "#1522", and 12px/600 branch names — 12px semibold is still PLAIN text for WCAG, which
// exempts only 18pt/14pt-bold, so AA >= 4.5:1 applies). Against the stock SOLID modal it scores 4.885:1.
// Contrast was evaluated against UNIFORM FIELDS of every surface the modal can sit over, pushed through
// the scrim and then through Chromium's own filter pipeline; the model was validated against canvas
// ctx.filter (same Skia path as backdrop-filter) and reproduces it EXACTLY — e.g. a red card field
// scrimmed to rgb(88,26,22) filters to rgb(97,4,0) in both the model and Chromium:
//
//   uniform backdrop          -> composite        subtlest  verdict
//   PR_SOLID_RED_DARK            rgb(76,20,19)     5.207:1  PASS   <- binds
//   PR_SOLID_GREEN_DARK          rgb(17,45,27)     5.213:1  PASS
//   QA/lighter card              rgb(33,35,39)     5.529:1  PASS
//   board surface rgb(36,37,40)  rgb(28,29,33)     5.891:1  PASS
//   body bg rgb(31,31,33)        rgb(27,28,31)     5.983:1  PASS
//
// CONFIRMED END-TO-END, not just modelled: a uniform PR_SOLID_RED_DARK field was forced behind the live
// modal and the rendered surface came out rgb(76,20,19) at 5.19:1 — the modelled binding row, to the
// byte. And because a mean can hide a bad corner, local contrast was swept over a 12x12 tile grid of the
// real modal (each tile's darkest-half mean, so the modal's OWN bright glyphs cannot masquerade as
// backdrop): stock solid min 4.874:1 / median 4.877:1, frosted min 5.044:1 / median 5.817:1, with
// 0 of 144 tiles under AA and 0 of 144 under the stock baseline. The frosted modal is more legible than
// the solid one it replaces EVERYWHERE on the surface, not just on average.
//
// WHY THIS MODAL AND NOT THE OTHERS. The surrounding dialogs were surveyed live and deliberately left
// alone; see PR_MODAL_FROST_CSS below for the two that were declined and why.
//
// TUNING. Same shape as the popup dial: MODAL_BACKDROP_SATURATE is the cheap dial (chroma at ~constant
// luminance), brightness and alpha are the expensive ones. MODAL_SCRIM_ALPHA is the lever unique to
// modals — lowering it buys glass fast but spends the legibility headroom that keeps this above the
// stock-solid baseline, and it also weakens the dialog's focus affordance. Flip MODAL_FROST to false to
// ship the modal exactly as Jira does, scrim included.
const MODAL_FROST = true;                // master gate for the modal glass; false = untouched Jira modal
const MODAL_BLUR_PX = 16;                // backdrop blur radius, matched to the popup for one visual family
const MODAL_SURFACE_ALPHA = 0.4;         // opacity of the modal surface; lower = glassier, less legible
const MODAL_BACKDROP_SATURATE = 2.5;     // backdrop colour boost; buys visible glass at ~no contrast cost
const MODAL_BACKDROP_BRIGHTNESS = 0.6;   // higher than the popup's 0.48: Jira's own scrim already clamps
const MODAL_SCRIM_ALPHA = 0.25;          // Jira ships 0.6; relieved so the blur has board detail to show
// Jira's own blanket colour, hue untouched — only its alpha moves, so the scrim still reads as ADS's.
const MODAL_SCRIM_RGB = '16, 18, 20';
// Verified live: each of these matches EXACTLY ONE node. The sibling testids that share this prefix
// (--positioner, --header, --scrollable, --body) are distinct VALUES, so the exact-match form cannot
// collide with them. As everywhere else in this file, the Atlaskit compiled-class hashes on these nodes
// (_16jlidpf, _1r04idpf ...) churn between ADS releases and are NOT targeted.
const MODAL_SELECTOR = '[data-testid="development-details.main.modal-dialog"]';
const MODAL_BLANKET_SELECTOR = '[data-testid="development-details.main.modal-dialog--blanket"]';
// Threads PR_DARK_PREFIX onto EVERY selector rather than the joined string — the same leak that
// prSurfaceTint documents. Today each rule below carries a single selector, so this is defensive; it
// keeps a future comma-separated edit from silently scoping only its first selector.
const prDarkRule = (selectors, decls) =>
  selectors.map((selector) => `${PR_DARK_PREFIX}${selector}`).join(',') + `{${decls}}`;
// A SEPARATE @supports block from the popup's, not a second rule inside it — the two surfaces are tuned
// independently and keeping their blocks apart means neither can be edited into the other's fallback.
// The scrim relief lives INSIDE the guard on purpose: where backdrop-filter is unavailable the modal
// stays solid, and it must then keep Jira's full-strength 0.6 scrim rather than a thinned one that was
// only ever justified by a blur that is not running. Unprefixed spelling only — this Chromium reports
// -webkit-backdrop-filter as UNSUPPORTED, so gating on that form would disable the effect outright.
//
// SURVEYED AND DECLINED (both re-checked live, both would have passed AA — neither is a contrast fail):
//   * The ISSUE DETAIL modal, [data-testid="issue.views.issue-details.issue-modal.modal-dialog"].
//     Identical geometry (907x774), surface and 0.6 blanket, and it measures fine — 12x12 tiles gave
//     min 5.030:1 with 0/144 below AA. It is declined on UNIFORMITY and DWELL, not legibility: it holds
//     2099 characters of long-form copy across ~61% of its area (the dev-details modal holds 217 across
//     ~10%, and the already-frosted popup 62), and it paints several large FULLY OPAQUE interior panels
//     of its own (513x151 and 489x151 at rgb(43,44,47), a 445x90 comment box at rgb(31,31,33), a 285x98
//     at rgb(43,44,47)). Frost cannot reach under those, so the result is glass in some regions and flat
//     slab in others on one surface — and the saturated colour that survives the blur lands directly
//     under paragraphs the operator actually reads, rather than under a five-row list.
//   * MENU / DROPDOWN surfaces (profile, settings, filter and field menus). Structurally these are the
//     EASY case — measured live they carry no scrim and no backdrop root, so the popup's proven dials
//     would drop straight in. They are declined for want of a STABLE HOOK: the surface element carries
//     no role (role=null) and no generic testid, only a per-menu one such as
//     "atlassian-navigation--secondary-actions--profile", and its own classes are compiled hashes
//     (_2rko1mok ...). The only generic alternative is a structural .atlaskit-portal descendant rule,
//     which would also catch tooltips, flags, spotlights and the modals themselves. Not worth the leak.
const PR_MODAL_FROST_CSS = !MODAL_FROST ? '' :
  `@supports (backdrop-filter: blur(1px)){` +
  prDarkRule([MODAL_BLANKET_SELECTOR],
    `background-color:rgba(${MODAL_SCRIM_RGB}, ${MODAL_SCRIM_ALPHA}) !important;`) +
  prDarkRule([MODAL_SELECTOR],
    `background-color:rgba(${POPUP_SURFACE_RGB}, ${MODAL_SURFACE_ALPHA}) !important;` +
    `backdrop-filter:blur(${MODAL_BLUR_PX}px) saturate(${MODAL_BACKDROP_SATURATE}) ` +
    `brightness(${MODAL_BACKDROP_BRIGHTNESS}) !important;`) +
  `}`;

// ===================================================================================================
// >>> THE FROSTED ISSUE-MODAL DIAL <<<  Edit these to change the ISSUE DETAIL modal's glass.
// ===================================================================================================
// Frosts Jira's ISSUE DETAIL modal — the big work-item dialog. The block above declined this surface,
// and the decline was NOT about contrast (it measured 5.030:1 min, 0/144 tiles under AA). It was about
// UNIFORMITY: the modal paints large FULLY OPAQUE interior panels that a parent backdrop-filter cannot
// reach, so frosting the shell alone yields glass at the edges and flat slab in the middle. The
// operator has since asked for this modal frosted, so the panels are the work; the shell is the easy
// part. What follows is how the panels were dealt with WITHOUT flattening the modal's hierarchy.
//
// WHAT THE OPAQUE PANELS ACTUALLY ARE, MEASURED LIVE. A full walk of the open modal found 13 painted
// surfaces over 4000px^2 at alpha > 0.85. The decisive discovery is that almost all of them paint
// rgb(43,44,47) — which is EXACTLY the modal's own surface colour, ADS's --ds-surface-overlay
// (#2B2C2F). They are same-colour repaints: in stock Jira they are INVISIBLE, because they are the
// same colour as the sheet they sit on. They express no hierarchy by fill, and the two biggest (513x151
// and 489x151, in the activity feed) are pure layout paint. Only three colours are actually distinct:
//     --ds-surface-overlay  #2B2C2F  rgb(43,44,47)  the big slabs + the Details/context sections
//     --ds-surface          #1F1F21  rgb(31,31,33)  the comment WELL (recessed, darker than the sheet)
//     --ds-background-input #242528  rgb(36,37,40)  the "Add a comment…" field and friends (raised)
//
// THE HOOK IS A DESIGN TOKEN, NOT A CLASS. None of the big panels carries a data-testid; their only
// classes are Atlaskit compiled hashes (_v5641pm3, _1e0c1txw ...) which churn between ADS releases and
// which this file refuses to target everywhere else. So instead of selecting the panels, we REDEFINE
// THE TOKENS THEY PAINT FROM, scoped to the modal element. Verified live by overriding each token and
// re-reading every panel's computed background: the --ds-surface-overlay panels followed, while the
// well and the input did NOT (they resolve different tokens) — so one declaration reaches exactly the
// intended set and leaves the others their own identity. The tokens are set ON the modal, so they
// inherit to its whole subtree and cannot leak to the page outside it. This is why there is no
// compiled-hash selector anywhere below.
//
// AND CRITICALLY: NO SECOND backdrop-filter. The panels sit INSIDE an already-frosted parent. Giving
// them their own backdrop-filter would blur the already-blurred parent — a double blur that reads as
// muddy grey, not glass. They are made TRANSLUCENT ONLY; the single frost on the shell is what the eye
// sees through them. That is the whole reason this reads as one sheet.
//
// HOW HIERARCHY SURVIVES. The Details card is the case worth naming. Its separation was measured and it
// does NOT come from its fill (which is the sheet colour) — it comes from a 1.11px rgba(227,228,242,.12)
// top border and an 8px corner radius, both of which are untouched here. So taking its fill to alpha 0
// costs nothing visually and buys the frost underneath. The wells and inputs are the opposite case:
// their fill IS their affordance (a comment box must read as a comment box), so they keep a real alpha,
// stepped so the recessed well stays DARKER than the sheet and the raised input stays LIGHTER — the
// same up/down relationship stock Jira uses, just rendered in glass. Hover and pressed keep their own
// stepped alphas so focusing a field still changes it visibly instead of punching an opaque hole.
//
// PANEL_ALPHA IS 0 ON PURPOSE, and 0 is the FAITHFUL value, not the aggressive one: these panels are
// already the sheet colour, so 0 reproduces stock Jira's relationship (panel indistinguishable from
// sheet) exactly, while any positive alpha would make them DARKER than their surroundings and invent a
// hierarchy Jira never had. Raise it only if you want the slabs deliberately picked out.
//
// MEASURED, not estimated — and measured on RENDERED PIXELS, which is the v1.2.23 lesson. The binding
// text was re-derived rather than assumed: every text node in the modal was enumerated with its colour,
// size and weight, and the dimmest real body text is --ds-text-subtlest #96999E (luminance 0.3174) —
// the "Add text" / "Add subtask" / "Add options" placeholders, 15 nodes. Blue link text (#669DF1,
// 0.3329) is BRIGHTER and does not bind. One darker string exists, a 12px rgb(41,42,46) story-point
// count, but it sits on its own opaque rgb(221,222,225) badge that follows none of these tokens and is
// therefore untouched. So #96999E binds, exactly as on the popup and the dev modal.
//
//   12x12 tile sweep (each tile's darkest-half mean, so the modal's own glyphs cannot pose as backdrop):
//     stock solid  min 4.874:1  median 4.918   0/144 under AA
//     frosted      min 5.014:1  median 5.790   0/144 under AA, 0/144 under the stock baseline
//   per-placeholder, sampling the real pixels behind each #96999E node:
//     stock solid  worst 4.982:1 ("None")      0/4 under AA
//     frosted      worst 5.513:1 ("Add text")  0/4 under AA
// The frosted modal is MORE legible than the solid one it replaces, everywhere on the surface — the
// same no-regression invariant the popup and the dev modal hold.
//
// AND THE GLASS IS ACTUALLY VISIBLE (the v1.2.23 failure was a rule that applied but did nothing). On
// the modal's clean text-free top gutter, luminance SD went 0.00005 -> 0.00126 and channel spread 2 ->
// 15: a 25x rise in surface detail off a dead-flat control. That is real, visible glass on real pixels.
//
// TUNING. Same shape as the dials above: SATURATE is cheap (chroma at near-constant luminance),
// BRIGHTNESS and the alphas are expensive. SCRIM_ALPHA is the modal-only lever — lowering it buys glass
// fast but spends the headroom keeping this above the stock baseline. Flip ISSUE_MODAL_FROST to false
// to ship Jira's untouched solid modal, scrim and opaque panels included.
const ISSUE_MODAL_FROST = true;              // master gate; false = untouched Jira issue modal
const ISSUE_MODAL_BLUR_PX = 16;              // backdrop blur radius, matched to the other two surfaces
const ISSUE_MODAL_SURFACE_ALPHA = 0.4;       // opacity of the modal shell; lower = glassier, less legible
const ISSUE_MODAL_BACKDROP_SATURATE = 2.5;   // backdrop colour boost; visible glass at ~no contrast cost
const ISSUE_MODAL_BACKDROP_BRIGHTNESS = 0.6; // matches the dev modal: Jira's own scrim already clamps
const ISSUE_MODAL_SCRIM_ALPHA = 0.25;        // Jira ships 0.6; relieved so the blur has detail to show
// >>> the interior-panel dials <<< — alpha of each token'd surface INSIDE the modal. None of these gets
// a backdrop-filter of its own (see above); they only let the shell's single frost through.
const ISSUE_MODAL_PANEL_ALPHA = 0;           // --ds-surface-overlay slabs; 0 = vanish into the one sheet
const ISSUE_MODAL_WELL_ALPHA = 0.35;         // --ds-surface wells; stays DARKER than the sheet (recessed)
const ISSUE_MODAL_INPUT_ALPHA = 0.45;        // --ds-background-input fields; LIGHTER than the sheet
const ISSUE_MODAL_HOVER_ALPHA = 0.55;        // hover step — a visible state change, not an opaque hole
const ISSUE_MODAL_PRESSED_ALPHA = 0.6;       // pressed/focus step, one notch beyond hover
// THE INTERACTIVE STATES ARE PART OF THE JOB, not an afterthought. Every --ds-* token defined on this
// tenant was enumerated (564 of them) and filtered to the background/surface ones whose value is OPAQUE
// and whose name is a hover/pressed/selected variant. Most of that list is ACCENT colour — the blue,
// red, green, yellow lozenges and status chips — and those are deliberately left alone for the same
// reason the epic-link lozenge is: their fill IS their meaning, they are small, and bleaching them to
// glass would destroy information. What DOES get overridden is the NEUTRAL GREY LADDER, because those
// are the tokens a plain row, field or menu item inside the modal paints when you hover it — and an
// opaque grey appearing under the cursor is precisely the "hole punched in the glass" this feature has
// to avoid. Each rung keeps its own hue and simply gains an alpha, so the up/down relationship between
// rest, hover and pressed survives exactly as ADS ships it.
const ISSUE_MODAL_WELL_RGB = '31, 31, 33';   // --ds-surface                  #1F1F21
const ISSUE_MODAL_INPUT_RGB = '36, 37, 40';  // --ds-background-input, --ds-surface-hovered   #242528
const ISSUE_MODAL_RAISED_RGB = '48, 49, 52'; // --ds-surface-overlay-hovered  #303134
const ISSUE_MODAL_PRESSED_RGB = '61, 63, 67';// --ds-surface-overlay-pressed  #3D3F43
// Verified live: each matches EXACTLY ONE node, and the sibling testids sharing this prefix
// (--positioner, --header, --scrollable, --body) are distinct VALUES, so exact-match cannot collide.
const ISSUE_MODAL_SELECTOR =
  '[data-testid="issue.views.issue-details.issue-modal.modal-dialog"]';
const ISSUE_MODAL_BLANKET_SELECTOR =
  '[data-testid="issue.views.issue-details.issue-modal.modal-dialog--blanket"]';
// Its OWN @supports block, separate from the popup's and the dev modal's, so the three surfaces stay
// independently tunable and none can be edited into another's fallback. Unprefixed spelling only — this
// Chromium reports -webkit-backdrop-filter as UNSUPPORTED, so gating on that form would disable the
// effect outright. The scrim relief and the token overrides both live INSIDE the guard on purpose:
// where backdrop-filter is unavailable the modal must fall back to stock Jira ENTIRELY — full-strength
// scrim AND opaque panels — rather than a thinned scrim and transparent panels floating over nothing,
// which is the one genuinely broken state this feature could ship.
const PR_ISSUE_MODAL_FROST_CSS = !ISSUE_MODAL_FROST ? '' :
  `@supports (backdrop-filter: blur(1px)){` +
  prDarkRule([ISSUE_MODAL_BLANKET_SELECTOR],
    `background-color:rgba(${MODAL_SCRIM_RGB}, ${ISSUE_MODAL_SCRIM_ALPHA}) !important;`) +
  prDarkRule([ISSUE_MODAL_SELECTOR],
    `background-color:rgba(${POPUP_SURFACE_RGB}, ${ISSUE_MODAL_SURFACE_ALPHA}) !important;` +
    `backdrop-filter:blur(${ISSUE_MODAL_BLUR_PX}px) saturate(${ISSUE_MODAL_BACKDROP_SATURATE}) ` +
    `brightness(${ISSUE_MODAL_BACKDROP_BRIGHTNESS}) !important;` +
    // The token redefinitions. Scoped to this element, inherited by its subtree, invisible outside it.
    // Rest states first, then the hover/pressed rungs of the same neutral ladder.
    `--ds-surface-overlay:rgba(${POPUP_SURFACE_RGB}, ${ISSUE_MODAL_PANEL_ALPHA});` +
    `--ds-surface-overlay-hovered:rgba(${ISSUE_MODAL_RAISED_RGB}, ${ISSUE_MODAL_HOVER_ALPHA});` +
    `--ds-surface-overlay-pressed:rgba(${ISSUE_MODAL_PRESSED_RGB}, ${ISSUE_MODAL_PRESSED_ALPHA});` +
    `--ds-surface:rgba(${ISSUE_MODAL_WELL_RGB}, ${ISSUE_MODAL_WELL_ALPHA});` +
    `--ds-surface-hovered:rgba(${ISSUE_MODAL_INPUT_RGB}, ${ISSUE_MODAL_HOVER_ALPHA});` +
    `--ds-surface-pressed:rgba(${POPUP_SURFACE_RGB}, ${ISSUE_MODAL_PRESSED_ALPHA});` +
    `--ds-surface-raised:rgba(${ISSUE_MODAL_INPUT_RGB}, ${ISSUE_MODAL_INPUT_ALPHA});` +
    `--ds-surface-raised-hovered:rgba(${POPUP_SURFACE_RGB}, ${ISSUE_MODAL_HOVER_ALPHA});` +
    `--ds-surface-raised-pressed:rgba(${ISSUE_MODAL_RAISED_RGB}, ${ISSUE_MODAL_PRESSED_ALPHA});` +
    `--ds-background-input:rgba(${ISSUE_MODAL_INPUT_RGB}, ${ISSUE_MODAL_INPUT_ALPHA});` +
    `--ds-background-input-hovered:rgba(${POPUP_SURFACE_RGB}, ${ISSUE_MODAL_HOVER_ALPHA});` +
    `--ds-background-input-pressed:rgba(${ISSUE_MODAL_INPUT_RGB}, ${ISSUE_MODAL_PRESSED_ALPHA});`) +
  `}`;

// Hide the hover popup's native footer — the "View all development information" button AND the 1px rule
// above it — at the operator's request. Flip to false to get Jira's stock footer back.
const POPUP_HIDE_DEV_INFO_FOOTER = true;
// ONE rule does both hides because the divider is the footer's own first child: the footer is a plain
// wrapper <div> holding [ 1px divider , button ], so hiding the wrapper takes the link and the hairline
// together. That pairing is deliberate — killing the button but leaving a stray rule under the avatars
// would read worse than the untouched footer. Measured live: the popup loses exactly 61px (44px footer +
// its 16px margin-top + rounding) and the remaining gap under our avatar strip is 16px, which is the
// content box's OWN symmetric padding — so the removal leaves no dangling hole and needs no spacing fix.
//
// NO TESTID EXISTS on either node (verified live: the footer div, its divider child and the button all
// carry only Atlaskit compiled-CSS hashes like `_19pkpxbi`, which churn between ADS releases and are NOT
// safe to target). So this is structural, and — per the house style for structural rules — it ships two
// selectors, either of which alone does the job. Both are pinned to the popup's CONTENT BOX with the same
// `> div > div > div` child chain (the footer's actual depth) and differ only in how they discriminate:
//   1. the content-box child that DIRECTLY contains a button — the footer is the only such node;
//   2. the LAST content-box child — where the footer sits today.
// TWO INTERLOCKS keep these off our own reviewer strip, which is Jira's avatar-group <ul>:
//   a. `:not(:has([data-testid]))` — the strip is saturated with data-testid attributes, so it can never
//      satisfy either selector even if Jira reorders the popup's children or drops the footer entirely;
//   b. the strict child chain — it confines matching to the content-box LEVEL, so nothing rendered INSIDE
//      the strip (avatars, rings, initials-fallback nodes) is even reachable.
// Both were adversarially verified live. Each selector matched exactly the footer (1 node document-wide);
// the strip's <ul>.matches() was false for both; no node inside the strip matched. Two hostile cases were
// then forced into the live DOM: a testid-less `div > button` injected INTO the strip (the one shape the
// :has() discriminator would otherwise catch — interlock (b) blocks it) and the strip PROMOTED to last
// child of the content box (which interlock (a) blocks). Both stayed unmatched. Note that the strict child
// chain is load-bearing, not cosmetic: a loose descendant form (`popup div:has(> button)`) DID match the
// injected hostile node. The overflow "+N" button is safe on its own — it is a `li > button`, and both
// selectors require a DIV parent.
const PR_POPUP_FOOTER_HIDE_CSS = !POPUP_HIDE_DEV_INFO_FOOTER ? '' :
  `${POPUP_SELECTOR} > div > div > div:has(> button):not(:has([data-testid])),` +
  `${POPUP_SELECTOR} > div > div > div:last-child:not(:has([data-testid]))` +
  `{display:none !important;}`;

// Inject an "open pull request" button into the issue DETAIL view's quick-add action row (the small round
// +/apps buttons). Flip to false to stop injecting it entirely; the module then also removes any button a
// previous apply() had already placed, so toggling off is clean rather than leaving an orphan behind.
const PR_OPEN_BUTTON = true;
// The row is anchored on the ONE stable testid in it — the compact quick-add "+" trigger. Everything else
// in that subtree is Atlaskit compiled-CSS hashes (css-m1gh8r / _ymio1r31 ...) which churn between ADS
// releases and are NOT safe to target, so the module climbs from this node to the flex row at runtime
// rather than hardcoding a class chain. Verified live: exactly 1 match, inside `css-1pjflpu`, whose flex
// row (display:flex, gap:8px) holds the "+" and the apps dropdown as two `div[role=presentation]` kids.
const PR_OPEN_ADD_TRIGGER_SELECTOR =
  '[data-testid="issue-view-foundation.quick-add.quick-add-items-compact.add-button-dropdown--trigger"]';
// The PR/branch glyph LIFTED VERBATIM from Jira's own dev-panel chip — the `1 pull request OPEN` icon
// under [data-testid="development-board-dev-info-icon.container"] (the same popup this file already
// frosts). Captured live from that SVG's <path d>. Reusing Jira's own path is what makes the injected
// button read as native: the neighbouring "+" icon is the SAME shape family — 16x16 viewBox, fill=none on
// the <svg>, a single fill="currentcolor" path, evenodd winding — so the glyph inherits the row's
// currentColor (rgb(169,171,175) in dark mode) and its hover/active shifts with zero extra styling.
const PR_OPEN_ICON_PATH =
  'M4.25 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5M2 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 2 3.25m6-.75h1.75a2.75 2.75 0 0 1 2.75 2.75v5.378a2.251 2.251 0 1 1-1.5 0V5.25C11 4.56 10.44 4 9.75 4H8zM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5m7.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5';
// The ONLY host a PR link may point at. The URL is composed page-side from dev-status `repositoryName`,
// which is untrusted third-party data, so the main-world module re-parses the composed string with
// `new URL()` and requires BOTH https: and exactly this hostname before it ever reaches an href.
const PR_OPEN_HOST = 'bitbucket.org';
// What a plain left-click on the injected button DOES. 'dialog' (default, the operator's request) opens
// Jira's OWN "Development details" modal in place, keeping the user on the issue; 'navigate' restores the
// original behaviour of following the anchor to Bitbucket in the same tab. One flip switches them.
//
// 'dialog' does NOT reimplement anything: it drives Jira's own trigger — the "N pull requests" button in
// the issue detail's Development panel — via .click(). MEASURED LIVE in the integrated browser: that click
// mounts [data-testid="development-details.main.modal-dialog"] (role=dialog, aria-label "Development
// details") with the "Pull requests" TAB PRE-SELECTED, listing every PR in a table with author, id,
// summary, source/target branch, status, reviewer avatars and relative updated time. It is an in-DOM
// modal, NOT a popup window, so the integrated browser's popup suppression does not touch it, and the URL
// never changes. Escape and its "Close Modal" button both dismiss it, returning to the issue view intact.
// Because the dialog lists ALL PRs, multi-PR issues are covered natively and better than the tooltip.
//
// The anchor keeps its validated href in BOTH modes, so 'dialog' degrades to plain navigation whenever the
// native trigger is absent (Development panel not rendered yet, or collapsed), and modifier/middle clicks
// are never intercepted.
const PR_BUTTON_ACTION = 'dialog';
// The native trigger, and the reason it is a TWO-PART selector. The button testid
// `development-summary-common.ui.summary-item.link-formatted-button` is SHARED by every row of the
// Development panel — branches, commits, pull requests, and the "connect dev tools" upsell all use it.
// VERIFIED THE HARD WAY live: an unscoped document.querySelector for it matched the upsell row FIRST and
// clicking it opened the "Connect development tools" popup, not the PR dialog. So the button must be
// looked up INSIDE the pull-request summary item, never document-wide.
const PR_DIALOG_ITEM_SELECTOR = '[data-testid="development-summary-pull-request.ui.summary-item"]';
const PR_DIALOG_TRIGGER_SELECTOR = '[data-testid="development-summary-common.ui.summary-item.link-formatted-button"]';

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
    // Frost the PR hover card (see ">>> THE FROSTED-POPUP DIAL <<<"). Gated on the same flag as the card
    // fills because it is the same feature: the popup only carries our reviewer strip when PR coloring
    // is on, and this keeps the popup solid — Jira's untouched default — whenever the feature is off.
    // Purely presentational; it adds no Jira/Bitbucket traffic. The popup is hover-transient, so the
    // GPU-composited backdrop repaint never rides a scroll.
    if (components[PR_COLORING_KEY]) css += PR_POPUP_FROST_CSS;
    // Frost the Development-details modal our PR button opens (see ">>> THE FROSTED-MODAL DIAL <<<").
    // Same gate as the popup frost and for the same reason — it is the same feature, and turning PR
    // coloring off must hand back stock Jira chrome, scrim strength included. Contributes '' when
    // MODAL_FROST is false. Purely presentational; adds no Jira/Bitbucket traffic. Unlike the popup this
    // surface can stay open for a while, but the board behind a modal does not scroll, so the backdrop
    // is static and the composited blur is painted once rather than re-rasterised per frame.
    if (components[PR_COLORING_KEY]) css += PR_MODAL_FROST_CSS;
    // Frost the ISSUE DETAIL modal (see ">>> THE FROSTED ISSUE-MODAL DIAL <<<"), including the token
    // overrides that make its interior panels translucent so it reads as ONE frosted sheet. Same gate as
    // the other two frosts and for the same reason. Contributes '' when ISSUE_MODAL_FROST is false.
    // Purely presentational; adds no Jira/Bitbucket traffic. This surface DOES scroll its own content —
    // measured live, the backdrop-filter samples what is behind the modal (the board, which does not
    // move), so scrolling the modal body does not re-rasterise the blur; see the dial block.
    if (components[PR_COLORING_KEY]) css += PR_ISSUE_MODAL_FROST_CSS;
    // Hide that popup's native "View all development information" footer and the hairline above it (see
    // POPUP_HIDE_DEV_INFO_FOOTER). Gated on PR coloring for the same reason the frost is: it restyles the
    // surface our reviewer strip renders into, so turning the feature off must restore stock Jira chrome.
    // Contributes '' when the dial is off, so composeCss is unchanged in that case.
    if (components[PR_COLORING_KEY]) css += PR_POPUP_FOOTER_HIDE_CSS;
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
    // Per-reviewer avatar shading (see ">>> THE AVATAR DIAL <<<"). Both the board strip and the PR
    // hover popup draw 24px avatars, so ONE ring width (2px) and ONE tint alpha serve both surfaces —
    // no per-surface scaling was needed. Shared by the two managers below — though the strip only
    // actually shades when AV_SHADE_STRIP is on, so by default these serve the popup alone.
    var AV_RING_GREEN = 'rgb(${AVATAR_RING_GREEN_RGB})';
    var AV_RING_RED = 'rgb(${AVATAR_RING_RED_RGB})';
    var AV_TINT_GREEN = 'rgba(${AVATAR_RING_GREEN_RGB}, ${AVATAR_TINT_ALPHA})';
    var AV_TINT_RED = 'rgba(${AVATAR_RING_RED_RGB}, ${AVATAR_TINT_ALPHA})';
    // The ring is an OUTER box-shadow rather than a border so it never changes the 24px layout box.
    var AV_RING_W = '2px';
    // Gate for the board-header strip only (see AVATAR_SHADE_HEADER_STRIP). The popup never consults it.
    var AV_SHADE_STRIP = ${AVATAR_SHADE_HEADER_STRIP ? 'true' : 'false'};
    function avRing(state) {
      return state === 'red' ? ('0 0 0 ' + AV_RING_W + ' ' + AV_RING_RED)
        : state === 'green' ? ('0 0 0 ' + AV_RING_W + ' ' + AV_RING_GREEN) : '';
    }
    // The wash: a circular, click-through overlay sized to the wrapper. Because it is a SIBLING of the
    // avatar (not a background on it) it lands identically on a real <img> and on an initials/person
    // fallback circle — the fallback needs no special case.
    function avTint(state) {
      var c = state === 'red' ? AV_TINT_RED : state === 'green' ? AV_TINT_GREEN : '';
      if (!c) return null;
      var t = document.createElement('span');
      t.setAttribute('data-ej-tint', '1');
      t.style.cssText = 'position:absolute;left:0;top:0;right:0;bottom:0;border-radius:50%;pointer-events:none;background:' + c + ';';
      return t;
    }
    // One reviewer's OWN state from the relayed contract node, normalised to the same three-way
    // vocabulary colorFor uses ('red' | 'green' | null) and with the same precedence: a requested
    // change is a blocker and outranks an approval.
    function avStateOfReviewer(rv) {
      if (!rv) return null;
      if (rv.state === 'changes_requested') return 'red';
      if (rv.approved === true || rv.state === 'approved') return 'green';
      return null;
    }
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
          // Per-PERSON review state for the whole strip, read fresh from the SAME relayed contract node
          // the card colouring reads (#__ej_bb_states) — no extra request, no new data source, and no
          // local state of its own. Returns a plain name -> 'red' | 'green' object.
          //
          // The strip lists board MEMBERS, so a person can appear as a reviewer on several issues at
          // once. Aggregation follows colorFor's precedence exactly: one requested change anywhere
          // outranks any number of approvals, because a blocker is the thing worth surfacing.
          //
          // MONOTONICITY comes from the data layer, not from here: the companion's publishes only ever
          // ADD issues/facts within a cycle (see mergeBase and the seed overlay), so a person's
          // aggregate can gain 'green' and can be promoted 'green' -> 'red', but a publish cannot take
          // a state away mid-cycle. Deriving at paint time — exactly as colorCard does — therefore
          // inherits that guarantee for free, and clears with no residue when a state genuinely goes
          // away, because nothing is remembered between renders.
          reviewStates: function () {
            var out = {};
            try {
              var n = document.getElementById('__ej_bb_states');
              if (!n) return out;
              var txt = n.textContent || '';
              if (!txt) return out;
              var data = JSON.parse(txt);
              var byIssue = (data && data.byIssue) || {};
              for (var key in byIssue) {
                if (!byIssue.hasOwnProperty(key)) continue;
                var rs = (byIssue[key] && byIssue[key].reviewers) || [];
                for (var i = 0; i < rs.length; i++) {
                  var nm = rs[i] && rs[i].name;
                  if (!nm) continue;
                  var st = avStateOfReviewer(rs[i]);
                  if (!st) continue;
                  if (out[nm] !== 'red') out[nm] = st;   // red is sticky: a blocker outranks approvals
                }
              }
            } catch (e) {}
            return out;
          },
          buildAvatar: function (name, avatar, accountId, reviewState) {
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
            // The review ring and the assignee-filter highlight both want a box-shadow, so they are
            // STACKED rather than allowed to overwrite each other: review ring innermost (the thing
            // this feature is about), blue selection ring pushed out to 4px around it. Either can be
            // absent; the filled slots are joined in order.
            var ring = avRing(reviewState);
            if (ring) el.style.boxShadow = ring;
            if (accountId) {
              el.style.cursor = 'pointer';
              var active = [];
              try {
                active = (new URL(location.href)).searchParams.getAll('assignee');
              } catch (e) {}
              if (active.indexOf(accountId) >= 0) {
                el.style.boxShadow = (ring ? ring + ',0 0 0 4px #4c9aff' : '0 0 0 2px #4c9aff');
                if (!ring) el.style.border = '1px solid #4c9aff';
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
            // UNSHADED reviewers (and non-reviewers) keep the pre-existing shape exactly: the bare
            // avatar element, no wrapper. Only a shaded avatar gets wrapped, and only so the tint has
            // a positioning context to sit in. The tint is pointer-events:none, so the assignee-filter
            // click handler on the avatar itself is unaffected.
            var tint = avTint(reviewState);
            if (!tint) return el;
            var wrap = document.createElement('span');
            wrap.style.cssText = 'position:relative;display:inline-flex;width:24px;height:24px;flex:0 0 auto;';
            wrap.appendChild(el);
            wrap.appendChild(tint);
            return wrap;
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
              // Review state is part of the signature. Without this the strip would render once and
              // then short-circuit forever on the unchanged sig, so a RED ring — which only ever
              // arrives on a later Bitbucket enrichment publish, never on the same-origin base pass —
              // could never appear. Read once per render, not once per avatar.
              // null when the strip is unshaded: it skips the read entirely AND drops the extra
              // signature field, so the sig is byte-identical to the pre-shading one.
              var rstates = AV_SHADE_STRIP ? this.reviewStates() : null;
              var sig = activeParam + '||' + names.map(function (n) {
                var r = roster.get(n) || {};
                return n + '|' + (r.id || '') + '|' + (r.avatar || '') + (rstates ? '|' + (rstates[n] || '') : '');
              }).join(',');
              var strip = document.getElementById('__ej_avatar_strip');
              var placed = !!(strip && strip.parentNode === row);
              if (strip && placed && strip.getAttribute('data-sig') === sig) return;
              if (!strip) {
                strip = document.createElement('div');
                strip.id = '__ej_avatar_strip';
                strip.style.display = 'inline-flex';
                strip.style.position = 'absolute';
                strip.style.left = '50%';
                strip.style.top = '50%';
                strip.style.transform = 'translate(-50%,-50%)';
                strip.style.margin = '0';
              }
              // 6px only when shaded, so adjacent 2px rings do not touch; unshaded keeps the original
              // 4px. Set on EVERY render rather than only at creation: the other style properties above
              // are gate-independent constants, but this one is not, so a strip node that outlives a
              // change of gate would otherwise keep the stale spacing forever (the node is reused
              // whenever it is still in the DOM). Re-asserting it is free and makes the node
              // self-healing; when the gate is off this writes the same '4px' the original code did.
              strip.style.gap = AV_SHADE_STRIP ? '6px' : '4px';
              strip.setAttribute('data-sig', sig);
              strip.innerHTML = '';
              for (var i = 0; i < names.length; i++) {
                var r = roster.get(names[i]) || {};
                strip.appendChild(this.buildAvatar(names[i], r.avatar, r.id, rstates ? (rstates[names[i]] || null) : null));
              }
              if (!placed) row.appendChild(strip);
            } catch (e) {}
          }
        };
        function startAv() {
          if (window.__ejAvatars !== a || a.observer) return;
          var raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : function (cb) { return setTimeout(cb, 16); };
          // Same rAF-latch fix the card painter already carries: rAF does not fire while the tab is
          // hidden (the VS Code integrated browser tab very often is), and clearing _scheduled only
          // inside the rAF callback would latch it true forever, dropping every later publish. Race
          // rAF against a short timer and run whichever wins, exactly once.
          function scheduleAv(cb) {
            var ran = false;
            function run() { if (ran) return; ran = true; cb(); }
            raf(run);
            setTimeout(run, 250);
          }
          a.observer = new MutationObserver(function () {
            if (a._scheduled) return;
            a._scheduled = true;
            scheduleAv(function () { a._scheduled = false; a.mergeCards(); a.render(); });
          });
          // Observation ROOT follows the dial, because it is the shading that decides what this manager
          // needs to see. Unshaded, the strip's only inputs are the roster and the ?assignee param, both
          // of which live under <body> — so body is the correct, narrower root and widening would only
          // buy pointless wakeups on every companion publish. Shaded, the strip additionally consumes
          // #__ej_bb_states, which is replaced at the <html> level on each publish and is the ONLY event
          // that can turn a strip avatar red, so the root must widen to documentElement to see it (its
          // subtree still contains <body>, so card re-renders and scroll virtualisation keep firing it
          // exactly as before, and render() stays signature-guarded).
          // The rAF-latch fix above is NOT part of this trade — it is a correctness fix for a hidden tab
          // and applies to whichever root is in use.
          a.observer.observe(AV_SHADE_STRIP ? document.documentElement : document.body, { childList: true, subtree: true });
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
          // (Only THIS manager widens to documentElement unconditionally; the avatars strip widens only
          // when AVATAR_SHADE_HEADER_STRIP is on — off by default — and insights/popup stay on body.)
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
            // THIS person's own state, shaded with the shared avatar dial rather than the old one-off
            // ADS hues (#36B37E / #FF5630) — so the popup, the board strip and the card colours are one
            // system in two hues instead of three unrelated greens.
            var state = avStateOfReviewer(rv);
            var rs = avRing(state);
            var ring = rs ? ('box-shadow:' + rs + ';') : '';
            var self = this;
            function initialsEl() {
              var f = document.createElement('div');
              f.textContent = self.initials(name);
              f.setAttribute('data-ej-av', '1');
              f.style.cssText = 'width:24px;height:24px;border-radius:50%;background:#5E6C84;color:#fff;font-size:10px;font-weight:600;display:flex;align-items:center;justify-content:center;' + ring;
              return f;
            }
            if (rv.avatar) {
              var img = document.createElement('img');
              img.src = rv.avatar;
              img.alt = name;
              img.referrerPolicy = 'no-referrer';
              img.setAttribute('data-ej-av', '1');
              img.style.cssText = 'width:24px;height:24px;border-radius:50%;object-fit:cover;display:block;' + ring;
              // The tint overlay is a wrap child too, so the old "wrap has no children left" test would
              // wrongly conclude the initials circle was already there and skip it. Test for the AVATAR
              // slot specifically, and insert it FIRST so the tint stays on top.
              img.onerror = function () {
                try {
                  if (img.parentNode === wrap) wrap.removeChild(img);
                  if (!wrap.querySelector('[data-ej-av]')) wrap.insertBefore(initialsEl(), wrap.firstChild);
                } catch (e) {}
              };
              wrap.appendChild(img);
            } else {
              wrap.appendChild(initialsEl());
            }
            // Appended last (and pointer-events:none) so it washes whichever avatar slot ends up under
            // it — real photo or initials fallback — with no per-case handling.
            var tint = avTint(state);
            if (tint) wrap.appendChild(tint);
            return wrap;
          },
          // Hide Jira's original avatar-group children and append our full-reviewer strip in their place.
          // Idempotent: an existing strip is removed first so a re-render repaints cleanly.
          // A stable fingerprint of the reviewer states this strip was drawn from. Stamped on the strip
          // so apply() can tell "already drawn for this issue" from "already drawn, but a reviewer has
          // since approved / requested changes". Names are read-only inputs here and never reach HTML.
          stateSig: function (reviewers) {
            try {
              var parts = [];
              for (var i = 0; i < reviewers.length; i++) {
                parts.push(String(reviewers[i].name) + ':' + (avStateOfReviewer(reviewers[i]) || '-'));
              }
              return parts.join('|');
            } catch (e) { return ''; }
          },
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
              strip.setAttribute('data-ej-state-sig', this.stateSig(reviewers));
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
                // Skip only when already rendered for THIS key, our strip survived Jira's re-renders,
                // AND the per-reviewer states are unchanged. The state check is what lets an OPEN popup
                // pick up a RED that only lands on a later Bitbucket enrichment publish — without it
                // the key match alone would freeze the popup on its first, approvals-only draw.
                var existing = group.querySelector('[data-ej-pr-strip="1"]');
                if (existing && existing.getAttribute('data-ej-key') === key &&
                    existing.getAttribute('data-ej-state-sig') === this.stateSig(reviewers)) continue;
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
    // Stage-3 "open pull request" button for the issue DETAIL view. Clones the quick-add row's own button
    // markup, swaps in Jira's dev-panel PR glyph, and — per PR_BUTTON_ACTION — either opens Jira's own
    // "Development details" dialog in place (default) or navigates to the selected issue's pull request.
    //
    // ZERO NEW REQUESTS: the PR list comes entirely from the existing #__ej_bb_states contract, whose
    // per-issue entries now carry a \`prs\` array (url/status/title/updated) that the companion derives from
    // the dev-status payload it ALREADY fetches for coloring — see prList()/stampPrs() in composeBridgeJs.
    // This module never calls fetch/XHR and never mutates a PR or issue; a click is a navigation and
    // nothing else.
    (function () {
      try {
        var PR_BTN = ${PR_OPEN_BUTTON ? 'true' : 'false'} && ${desired ? 'true' : 'false'};
        var ADD_SEL = ${JSON.stringify(PR_OPEN_ADD_TRIGGER_SELECTOR)};
        var ICON_D = ${JSON.stringify(PR_OPEN_ICON_PATH)};
        var HOST = ${JSON.stringify(PR_OPEN_HOST)};
        var ACTION = ${JSON.stringify(PR_BUTTON_ACTION)};
        var DLG_ITEM = ${JSON.stringify(PR_DIALOG_ITEM_SELECTOR)};
        var DLG_TRIG = ${JSON.stringify(PR_DIALOG_TRIGGER_SELECTOR)};
        var exBtn = window.__ejPrOpenBtn;
        if (exBtn) { exBtn.desired = PR_BTN; exBtn.apply(); return; }
        var b = {
          desired: PR_BTN,
          _scheduled: false,
          observer: null,
          _timer: null,
          // SECURITY GATE. \`raw\` originates in dev-status \`repositoryName\`/PR id — untrusted third-party
          // data that the companion string-concatenates into a URL. Re-parse it here and demand BOTH an
          // https: scheme and exactly the Bitbucket host, so a repositoryName carrying a scheme, a
          // userinfo \`@\`, or path traversal cannot retarget the link. Anything that fails to parse or
          // fails either check returns null and the button simply does not render. Returning \`u.href\`
          // (the PARSED, normalised form) rather than \`raw\` means the string that reaches href is the
          // one the URL parser actually validated, never the attacker-shaped original.
          safeUrl: function (raw) {
            try {
              if (typeof raw !== 'string' || !raw) return null;
              var u = new URL(raw);
              if (u.protocol !== 'https:') return null;
              if (u.hostname !== HOST) return null;
              return u.href;
            } catch (e) { return null; }
          },
          // The issue currently open in the detail view, from the \`selectedIssue\` query param. Read FRESH
          // on every apply() rather than cached, which is what makes retargeting work: this is an SPA, so
          // clicking another card rewrites the param via pushState with no reload. Shape-validated so a
          // hand-edited param can never become a selector or a lookup key for something unexpected.
          currentKey: function () {
            try {
              var v = new URL(location.href).searchParams.get('selectedIssue');
              if (!v || !/^[A-Z][A-Z0-9_]*-[0-9]+$/.test(v)) return null;
              return v;
            } catch (e) { return null; }
          },
          // Every PR for \`key\` that survives URL validation, newest-looking first is NOT assumed — order
          // is whatever the companion published; pick() imposes the ordering.
          prsFor: function (key) {
            try {
              if (!key) return [];
              var n = document.getElementById('__ej_bb_states');
              if (!n) return [];
              var d = JSON.parse(n.textContent || '{}');
              var e = d && d.byIssue && d.byIssue[key];
              var list = (e && e.prs) || [];
              var out = [];
              for (var i = 0; i < list.length; i++) {
                var p = list[i];
                var url = this.safeUrl(p && p.url);
                if (!url) continue;   // unvalidatable target: drop the PR entirely, never render it
                out.push({ url: url, status: (p.status == null ? '' : String(p.status)), title: (p.title == null ? '' : String(p.title)), updated: (p.updated == null ? '' : String(p.updated)) });
              }
              return out;
            } catch (e) { return []; }
          },
          // Default target: the OPEN pull request; when several are open, the most recently updated. Falls
          // back to the most recently updated of ALL PRs when none are open (e.g. every PR merged), so the
          // button still goes somewhere sensible instead of vanishing on a finished issue. \`updated\` is an
          // ISO-8601 timestamp, so a plain string compare is a correct recency compare.
          pick: function (prs) {
            var best = null, bestOpen = null;
            for (var i = 0; i < prs.length; i++) {
              var p = prs[i];
              if (!best || p.updated > best.updated) best = p;
              if (/^open$/i.test(p.status) && (!bestOpen || p.updated > bestOpen.updated)) bestOpen = p;
            }
            return bestOpen || best;
          },
          // Full inventory in the native tooltip so a multi-PR issue hides nothing behind the single
          // default target. Built as a plain string and assigned to .title as a PROPERTY, so the untrusted
          // PR title is text to the DOM and can never be parsed as markup.
          tooltip: function (prs, chosen) {
            // First line states what the click actually DOES, so the tooltip stays truthful when
            // PR_BUTTON_ACTION is flipped. The per-PR inventory below it is still useful in dialog mode as
            // an at-a-glance preview of what the dialog will list.
            var lines = [ACTION === 'dialog' ? 'Show pull requests' : 'Open pull request'];
            for (var i = 0; i < prs.length; i++) {
              var p = prs[i];
              var id = p.url.split('/').pop();
              lines.push((p === chosen ? '\\u2192 ' : '  ') + '#' + id + (p.status ? ' (' + p.status + ')' : '') + (p.title ? ' ' + p.title : ''));
            }
            return lines.join('\\n');
          },
          // Climb from the one stable testid to the flex row that actually holds the round buttons: the
          // nearest ancestor with more than one ELEMENT child. Bounded climb so a Jira restructure degrades
          // to "no button" rather than walking to <html> and injecting somewhere absurd.
          row: function () {
            try {
              var t = document.querySelector(ADD_SEL);
              if (!t) return null;
              var n = t.parentElement;
              for (var i = 0; i < 6 && n; i++) {
                if (n.children.length > 1) return n;
                n = n.parentElement;
              }
              return null;
            } catch (e) { return null; }
          },
          // Jira's OWN "N pull requests" control in the issue detail's Development panel. Scoped lookup —
          // see the PR_DIALOG_TRIGGER_SELECTOR note: the button testid is shared across the panel's rows,
          // and an unscoped query lands on the "connect dev tools" upsell. Returns null when the panel is
          // absent (not rendered yet, collapsed, or no dev data), which is what makes the click handler
          // fall through to plain navigation instead of silently doing nothing.
          dialogTrigger: function () {
            try {
              var item = document.querySelector(DLG_ITEM);
              if (!item) return null;
              var t = item.querySelector(DLG_TRIG);
              return t || null;
            } catch (e) { return null; }
          },
          remove: function (scope) {
            try {
              var root = scope || document;
              var old = root.querySelectorAll('[data-ej-pr-open-wrap="1"]');
              for (var i = 0; i < old.length; i++) { if (old[i].parentNode) old[i].parentNode.removeChild(old[i]); }
            } catch (e) {}
          },
          // Build the link by CLONING the row's own button markup (tpl.innerHTML) instead of hand-rolling
          // spans: size, radius, hover, active and focus-ring all come from Atlaskit's atomic classes read
          // off the live node, so the button matches the row exactly and keeps matching when those hashes
          // churn. Only two things are swapped — the <path d> (Jira's PR glyph) and the visually-hidden
          // label — both via attribute/textContent writes, never innerHTML.
          //
          // It is an <a href> with NO target. MEASURED LIVE in the VS Code integrated browser: window.open
          // returns null and a target="_blank" anchor click is a silent no-op (popups are suppressed
          // outright), while a plain same-tab anchor click navigates correctly. So same-tab is not a
          // preference here, it is the only thing that works — do not "improve" this to a new tab.
          build: function (rowEl, key, url, title, sig) {
            var tpl = rowEl.querySelector('button');
            var wrap = document.createElement('div');
            wrap.setAttribute('data-ej-pr-open-wrap', '1');
            wrap.setAttribute('role', 'presentation');
            var a = document.createElement('a');
            a.setAttribute('data-ej-pr-open', '1');
            a.setAttribute('data-ej-key', key);
            a.setAttribute('data-ej-sig', sig);
            a.className = tpl ? tpl.className : '';
            a.href = url;                       // validated by safeUrl(); never raw contract data
            a.title = title;                    // property write => text, not markup
            a.setAttribute('aria-label', (ACTION === 'dialog' ? 'Show pull requests for ' : 'Open pull request for ') + key);
            if (tpl) {
              a.innerHTML = tpl.innerHTML;      // Jira's OWN markup only — no untrusted string reaches this
              var path = a.querySelector('svg path');
              if (path) {
                path.setAttribute('d', ICON_D);
                path.setAttribute('fill-rule', 'evenodd');
                path.setAttribute('clip-rule', 'evenodd');
              }
              // The template's trailing span is the visually-hidden accessible label ("Add or create work
              // related to this Story"); retarget it rather than leaving the wrong text on our button.
              var spans = a.querySelectorAll('span > span');
              var lbl = spans.length ? spans[spans.length - 1] : null;
              if (lbl && !lbl.querySelector('svg')) lbl.textContent = (ACTION === 'dialog' ? 'Show pull requests for ' : 'Open pull request for ') + key;
            }
            // DIALOG MODE. Intercept the plain left-click and drive Jira's own Development-details trigger
            // instead of following the href. Everything the dialog does — layout, the pre-selected Pull
            // requests tab, focus trapping, Escape/Close-Modal dismissal, and the PR data itself — is
            // Jira's, so this cannot drift from the real state and needs no markup of ours.
            //
            // Three deliberate escape hatches, each of which leaves the ORIGINAL navigation intact:
            //   1. ACTION !== 'dialog'  -> no listener is attached at all, so the anchor behaves exactly as
            //      it did before this change (flip PR_BUTTON_ACTION to 'navigate' to get that back);
            //   2. modifier / non-primary clicks are ignored, so the browser's own open-in-new-tab and
            //      copy-link affordances keep working on the href;
            //   3. the native trigger being missing (Development panel not mounted or collapsed) returns
            //      WITHOUT preventDefault, so the click falls through to navigating to Bitbucket rather
            //      than becoming a dead control.
            // Read-only: .click() on a disclosure button opens a panel and mutates no issue or PR.
            if (ACTION === 'dialog') {
              a.addEventListener('click', function (ev) {
                try {
                  if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
                  var t = b.dialogTrigger();
                  if (!t) return;           // no native trigger -> let the href navigate (fallback)
                  ev.preventDefault();
                  t.click();
                } catch (e) {}
              });
            }
            wrap.appendChild(a);
            return wrap;
          },
          apply: function () {
            try {
              if (!this.desired) { this.remove(); return; }
              var rowEl = this.row();
              // Detail view closed (or not this kind of view): drop any button we left behind. Scoped to
              // the whole document because the row we injected into is gone by definition.
              if (!rowEl) { this.remove(); return; }
              var key = this.currentKey();
              var prs = this.prsFor(key);
              var chosen = this.pick(prs);
              var existing = rowEl.querySelector('[data-ej-pr-open="1"]');
              // No PR (or none with a valid URL): render NOTHING rather than a dead/disabled control, and
              // clear a button left over from a previously selected issue that did have one.
              if (!chosen) { this.remove(rowEl); return; }
              // IDEMPOTENCY: identical issue AND identical rendered content already mounted -> leave it
              // alone. This is the guard that stops the documentElement observer from stacking duplicates
              // on every Jira re-render, and the data-ej-key half is what makes a SELECTED-ISSUE CHANGE
              // retarget (different key -> rebuild) instead of silently pointing at the previous issue's PR.
              //
              // The signature covers the TOOLTIP, not just the href — same reason the hover-popup's
              // stateSig does. Keying on (key, href) alone was measured to freeze the tooltip: when a PR's
              // status flips OPEN -> MERGED, or a second PR appears on an issue whose chosen target is
              // unchanged, the href is identical and the early-return kept the stale tooltip forever.
              var tip = this.tooltip(prs, chosen);
              var sig = key + '|' + chosen.url + '|' + tip;
              if (existing && existing.getAttribute('data-ej-sig') === sig) return;
              this.remove(rowEl);
              rowEl.appendChild(this.build(rowEl, key, chosen.url, tip, sig));
            } catch (e) {}
          }
        };
        function startBtn() {
          if (window.__ejPrOpenBtn !== b || b.observer) return;
          var raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : function (cb) { return setTimeout(cb, 16); };
          // SAME rAF-latch FIX as the coloring manager's schedule() (see the long note there). A bare rAF
          // debounce sets _scheduled true and only clears it inside the rAF callback, and rAF does not fire
          // while the tab is hidden — which the integrated browser tab usually is — so one mutation while
          // hidden LATCHES the flag and every later mutation is dropped forever. Racing rAF against a short
          // timer clears the flag on whichever path fires first, so this can never latch.
          function schedule(cb) {
            var ran = false;
            function run() { if (ran) return; ran = true; cb(); }
            raf(run);
            setTimeout(run, 250);
          }
          b.observer = new MutationObserver(function () {
            if (b._scheduled) return;
            b._scheduled = true;
            schedule(function () { b._scheduled = false; b.apply(); });
          });
          // documentElement, not body — same reason as the coloring manager: the subtree still covers
          // <body> (so detail-panel re-renders and card selection changes fire it) AND it catches
          // #__ej_bb_states being REPLACED at the <html> level on every companion publish, which is what
          // makes the button appear as soon as PR data lands rather than only on the next Jira re-render.
          b.observer.observe(document.documentElement, { childList: true, subtree: true });
          // Backstop, mirroring the coloring manager's startRepaint(): covers a pushState-only selection
          // change that somehow produced no observed mutation, and a first paint that raced the contract
          // node. Cheap — apply() early-returns on the idempotency check whenever nothing has changed.
          if (!b._timer) { try { b._timer = setInterval(function () { try { b.apply(); } catch (e) {} }, 4000); } catch (e) { b._timer = null; } }
          b.apply();
        }
        window.__ejPrOpenBtn = b;
        if (document.body) startBtn();
        else document.addEventListener('DOMContentLoaded', startBtn, { once: true });
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
            // status/name/lastUpdate ride along from the SAME dev-status payload already in hand (no extra
            // request): they are what the detail-view "open pull request" button needs to choose a default
            // target (OPEN, then most recently updated) and to list every PR in its tooltip. Purely
            // additive — repo/prId/prKey are unchanged, so cycle dedup and the Bitbucket enrichment that
            // key off them behave exactly as before.
            if (repo && pr.id != null) out.push({
              repo: repo, prId: pr.id, prKey: repo + '#' + pr.id,
              status: (typeof pr.status === 'string') ? pr.status : null,
              title: (typeof pr.name === 'string') ? pr.name : null,
              updated: (typeof pr.lastUpdate === 'string') ? pr.lastUpdate : null
            });
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
      // Per-issue PR descriptors for the detail-view "open pull request" button. Built ONLY from refs
      // already collected by extractPrs — this adds no request of any kind.
      //
      // The URL is COMPOSED from repo + prId rather than passed through from dev-status's own \`url\`
      // field: dev-status returns the UUID form
      // (bitbucket.org/{c5627d4d-...}/{2e2a07c7-...}/pull-requests/1519), which works but is opaque, while
      // repositoryName gives the readable slug the Referer in fetchParticipants already uses. Composing it
      // also means exactly ONE shape can ever be emitted. repositoryName is still untrusted, so the
      // main-world module re-parses and host-checks the result before it reaches an href — this is the
      // convenience half, safeUrl() is the security half.
      prList: function (refs) {
        var out = [];
        if (!refs) return out;
        for (var i = 0; i < refs.length; i++) {
          var r = refs[i];
          if (!r || !r.repo || r.prId == null) continue;
          out.push({
            url: 'https://bitbucket.org/' + r.repo + '/pull-requests/' + r.prId,
            status: r.status || null,
            title: r.title || null,
            updated: r.updated || null
          });
        }
        return out;
      },
      // Attach prList() output to a map that is ABOUT TO BE PUBLISHED, returning a shallow COPY per
      // touched entry. The copy is deliberate: the map handed in shares object identity with devBase, the
      // enriched map and the cache seed, and mutating those in place would leak \`prs\` into writeCache()
      // and into the monotonic-publish bookkeeping. Copying keeps every settled coloring/caching path
      // byte-identical to before — this only ever ADDS a field to the published snapshot.
      stampPrs: function (map, byIssuePrs) {
        var out = {};
        for (var k in map) {
          if (!map.hasOwnProperty(k)) continue;
          var e = map[k];
          var list = (byIssuePrs && byIssuePrs[k]) ? this.prList(byIssuePrs[k]) : null;
          if (!e || !list || !list.length) { out[k] = e; continue; }
          var c = {};
          for (var f in e) { if (e.hasOwnProperty(f)) c[f] = e[f]; }
          c.prs = list;
          out[k] = c;
        }
        return out;
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
            // stampPrs is the LAST step and applies to the PUBLISHED SNAPSHOT ONLY (it returns copies), so
            // withSeed/mergeBase/writeCache all still see exactly the maps they saw before this feature.
            safePublish(self.stampPrs(withSeed(self.mergeBase(devBase, enriched)), byIssuePrs), label);
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
