// Per-extension key/value storage for the host<->page BRIDGE (B1). One BridgeStore per activation,
// backed by VS Code globalState. Mirrors BookmarksStore/ExtensionsStore discipline: load + validate
// on construction, persist immediately on every mutation, throw-free throughout.
//
// ISOLATION: every entry is namespaced by the extension id, and cdp-tab.js derives that id from the
// TRUSTED contextId->extId map (never from anything the page controls), so extension A can never
// read or write extension B's namespace.
//
// TIERS: B1 is the plain-KV tier (globalState). A SecretStorage tier (context.secrets) is B3 — the
// constructor already accepts `secrets` so B3 can slot in without a signature change; it is unused
// here.

const STORAGE_KEY = 'steersman.bridge';

class BridgeStore {
  // globalState: a VS Code Memento (context.globalState). secrets: context.secrets (reserved for B3).
  constructor(globalState, secrets) {
    this._globalState = globalState;
    this._secrets = secrets || null; // reserved for B3; unused in B1
    this._data = this._load();
  }

  // Load the { extId: { key: value } } map; fall back to an empty map on absent/corrupt data so a
  // bad stored value can never leave us broken.
  _load() {
    let stored;
    try {
      stored = this._globalState && this._globalState.get(STORAGE_KEY);
    } catch {
      stored = null;
    }
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) return stored;
    return {};
  }

  // Write the whole map back to globalState (fire-and-forget; the return is a Thenable).
  _persist() {
    try {
      return this._globalState && this._globalState.update(STORAGE_KEY, this._data);
    } catch {
      return undefined;
    }
  }

  // Resolve (creating if needed) the per-extension namespace object, or null for an invalid id.
  _ns(extId) {
    if (!extId || typeof extId !== 'string') return null;
    if (!this._data[extId] || typeof this._data[extId] !== 'object' || Array.isArray(this._data[extId])) {
      this._data[extId] = {};
    }
    return this._data[extId];
  }

  // Read a value (undefined for a missing key or invalid extId). Never throws.
  get(extId, key) {
    const ns = this._ns(extId);
    if (!ns) return undefined;
    const k = String(key);
    return Object.prototype.hasOwnProperty.call(ns, k) ? ns[k] : undefined;
  }

  // Write a value (must be JSON-serializable — it lands in globalState). Returns true on success,
  // false for an invalid extId.
  set(extId, key, value) {
    const ns = this._ns(extId);
    if (!ns) return false;
    ns[String(key)] = value;
    this._persist();
    return true;
  }

  // Delete a key. Returns true on success (idempotent — a missing key is still success), false for
  // an invalid extId.
  remove(extId, key) {
    const ns = this._ns(extId);
    if (!ns) return false;
    delete ns[String(key)];
    this._persist();
    return true;
  }

  // The keys stored for an extension (empty array for an invalid/empty namespace).
  keys(extId) {
    const ns = this._ns(extId);
    if (!ns) return [];
    return Object.keys(ns);
  }

  // ── Secrets tier (B3) — backed by VS Code SecretStorage (OS keychain, encrypted at rest).
  // SecretStorage is a flat string->string store, so we compose a namespaced key ourselves; the
  // extId comes from the TRUSTED contextId->extId map (cdp-tab.js), so one extension can't read
  // another's secrets. All async and throw-free. NEVER log a secret value.
  _secretKey(extId, key) {
    return 'steersman.bridge.secret.' + extId + '.' + String(key);
  }

  // Resolve a secret value (undefined when absent / no SecretStorage / invalid extId). Never throws.
  async getSecret(extId, key) {
    if (!this._secrets || !extId) return undefined;
    try {
      return await this._secrets.get(this._secretKey(extId, key));
    } catch {
      return undefined;
    }
  }

  // Store a secret (coerced to string). Returns true on success, false otherwise. Never throws.
  async setSecret(extId, key, value) {
    if (!this._secrets || !extId) return false;
    try {
      await this._secrets.store(this._secretKey(extId, key), String(value));
      return true;
    } catch {
      return false;
    }
  }

  // Delete a secret (idempotent). Returns true on success, false otherwise. Never throws.
  async removeSecret(extId, key) {
    if (!this._secrets || !extId) return false;
    try {
      await this._secrets.delete(this._secretKey(extId, key));
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { BridgeStore };
