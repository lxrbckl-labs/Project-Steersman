// Global, persisted list of "extensions" (userscript-style page modifiers) shared across every
// window. One ExtensionsStore per activation, backed by VS Code globalState so the list survives
// reloads and is identical in all windows. Mirrors BookmarksStore's shape/discipline: load +
// validate on construction, persist immediately on every mutation, throw-free throughout.
//
// Phase 1: records carry every field of the final design, but only `id`/`name`/`enabled`/`js`
// are honoured by the injector yet (matches/css/runAt/world/hideFromAgent exist but are inert).
// Management is OPERATOR-ONLY — there is no agent/MCP authoring surface for extensions.

const crypto = require('crypto');
// Re-exported so a single require('./extensions-store') gives callers both the store and the
// Chrome-match-pattern helpers (Phase 2 uses matchesUrl to decide which extensions apply).
const { parseMatchPattern, matchesUrl } = require('./match-pattern');

// globalState key the whole list lives under.
const STORAGE_KEY = 'steersman.extensions';

// Separate globalState key holding the global "extensions master enable" kill-switch. Kept
// independent of the list (like the bookmarks bar-enabled flag) so flipping the master never
// touches the stored records. Defaults ON — the per-extension `enabled` flag is the primary gate.
const ENABLED_KEY = 'steersman.extensionsEnabled';

// Allowed enum values; anything else is coerced to the safe default in _normalize.
const RUN_AT_VALUES = ['document_start', 'document_idle'];
const WORLD_VALUES = ['main', 'isolated'];

class ExtensionsStore {
  // globalState: a VS Code Memento (context.globalState). Loads + normalizes the stored list, or
  // starts empty when nothing valid is stored (extensions are never seeded).
  constructor(globalState) {
    this._globalState = globalState;
    this._items = this._load();
  }

  // Load + normalize the stored list; fall back to an empty list on absent/corrupt data so a bad
  // stored value can never leave us in a broken state.
  _load() {
    let stored;
    try {
      stored = this._globalState && this._globalState.get(STORAGE_KEY);
    } catch {
      stored = null;
    }
    if (Array.isArray(stored)) return stored.map((r) => this._normalize(r)).filter(Boolean);
    return [];
  }

  // Coerce a raw record into the canonical shape, filling safe defaults for missing/invalid
  // fields. Returns null only when there's nothing usable (not an object). `enabled` defaults to
  // true so a freshly-added extension is on unless explicitly stored false.
  _normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
      name: typeof raw.name === 'string' ? raw.name : '',
      enabled: raw.enabled === undefined ? true : !!raw.enabled,
      matches: Array.isArray(raw.matches) ? raw.matches.filter((m) => typeof m === 'string') : [],
      js: typeof raw.js === 'string' ? raw.js : '',
      css: typeof raw.css === 'string' ? raw.css : '',
      runAt: RUN_AT_VALUES.includes(raw.runAt) ? raw.runAt : 'document_idle',
      world: WORLD_VALUES.includes(raw.world) ? raw.world : 'main',
      hideFromAgent: !!raw.hideFromAgent,
      // Bridge (B1): when true the extension runs in a dedicated isolated world with a host<->page
      // bridge (steersman.storage now; steersman.fetch/secrets in B2/B3). bridgeHosts is the
      // allow-list of hosts it may fetch — stored now for a complete record but UNUSED until B2.
      bridge: !!raw.bridge,
      bridgeHosts: Array.isArray(raw.bridgeHosts) ? raw.bridgeHosts.filter((h) => typeof h === 'string') : [],
      notes: typeof raw.notes === 'string' ? raw.notes : '',
    };
  }

  // Write the current list back to globalState (fire-and-forget; the return is a Thenable).
  _persist() {
    try {
      return this._globalState && this._globalState.update(STORAGE_KEY, this._items);
    } catch {
      return undefined;
    }
  }

  // Locate a record by id, returning { item, index } or null for an unknown id.
  _find(id) {
    for (let i = 0; i < this._items.length; i++) {
      if (this._items[i].id === id) return { item: this._items[i], index: i };
    }
    return null;
  }

  // The full list (safe to serialize and send over the wire).
  list() {
    return this._items;
  }

  // Add a new extension from partial fields; missing fields are filled by _normalize (a fresh id
  // is always stamped, and enabled defaults to true). Returns the created record.
  add(fields) {
    const item = this._normalize(Object.assign({ id: crypto.randomUUID(), enabled: true }, fields || {}));
    if (!item) return null;
    this._items.push(item);
    this._persist();
    return item;
  }

  // Patch an existing record's fields (id is protected — it can never be reassigned). The merged
  // record is re-normalized so a bad value can't corrupt the shape. Returns the updated record, or
  // null for an unknown id.
  update(id, fields) {
    const hit = this._find(id);
    if (!hit) return null;
    const { id: _ignored, ...safe } = fields || {};
    const merged = this._normalize(Object.assign({}, hit.item, safe, { id: hit.item.id }));
    this._items[hit.index] = merged;
    this._persist();
    return merged;
  }

  // Flip one extension's enabled flag. Returns true on success, false for an unknown id.
  toggle(id, enabled) {
    const hit = this._find(id);
    if (!hit) return false;
    hit.item.enabled = !!enabled;
    this._persist();
    return true;
  }

  // Remove an extension. Returns true when a record was removed, false for an unknown id.
  remove(id) {
    const hit = this._find(id);
    if (!hit) return false;
    this._items.splice(hit.index, 1);
    this._persist();
    return true;
  }

  // The global master enable (kill-switch). Defaults to true when nothing is stored, so extensions
  // are gated only by their own per-extension `enabled` flag until the operator flips the master.
  getExtensionsEnabled() {
    let stored;
    try {
      stored = this._globalState && this._globalState.get(ENABLED_KEY);
    } catch {
      stored = undefined;
    }
    return stored === undefined ? true : !!stored;
  }

  // Persist the master enable flag, coercing to a plain boolean. Fire-and-forget; swallows storage
  // errors so a bad Memento can never throw.
  setExtensionsEnabled(value) {
    try {
      return this._globalState && this._globalState.update(ENABLED_KEY, !!value);
    } catch {
      return undefined;
    }
  }

  // The records to actually inject: an empty list when the master flag is off, otherwise every
  // per-extension-enabled record. Both gates are applied here so callers (SessionManager) never
  // have to re-check either flag.
  getActive() {
    if (!this.getExtensionsEnabled()) return [];
    return this._items.filter((e) => e.enabled);
  }
}

module.exports = { ExtensionsStore, parseMatchPattern, matchesUrl };
