// Persistent shared logins (Stages 2+3). Stores per-origin cookie jars so a signed-in session
// survives reloads and is shared across VS Code windows, then re-injects them into new tabs.
// Mirrors BridgeStore discipline: constructor-injected state + secrets, flat namespaced string
// keys, load/validate defensively, persist on every mutation, throw-free throughout.
//
// TWO-TIER STORAGE: the actual cookie arrays are sensitive, so they live in SecretStorage
// (context.secrets — OS-keychain-backed, NOT enumerable). Because SecretStorage can't be listed,
// we keep a PLAINTEXT INDEX in globalState (shared across windows) recording which origins exist
// plus safe metadata (count, savedAt, autoReinject) — the index carries NO cookie values, so it is
// safe to render in the webview. NEVER log a cookie name, value, or domain.

// Plaintext index (globalState): { origin: { cookieCount, savedAt, autoReinject } }.
const INDEX_KEY = 'steersman.cookies.index';
// SecretStorage key prefix for a single origin's raw cookie array.
const SECRET_PREFIX = 'steersman.cookies.';
// Master "auto for ALL sites" flag (globalState, boolean, default false). When on, the extension's
// background sweep captures the browser jar and calls autoSaveAll so logins persist hands-off.
const AUTOALL_KEY = 'steersman.cookies.autoAll';

class CookieStore {
  // globalState: a VS Code Memento (context.globalState) holding the plaintext index.
  // secrets: context.secrets (SecretStorage) holding the raw per-origin cookie arrays.
  constructor(globalState, secrets) {
    this._globalState = globalState;
    this._secrets = secrets || null;
    this._index = this._loadIndex();
  }

  // Load the plaintext index; fall back to an empty map on absent/corrupt data so a bad stored
  // value can never leave us broken.
  _loadIndex() {
    let stored;
    try {
      stored = this._globalState && this._globalState.get(INDEX_KEY);
    } catch {
      stored = null;
    }
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) return stored;
    return {};
  }

  // Write the index back to globalState (fire-and-forget; the return is a Thenable).
  _persistIndex() {
    try {
      return this._globalState && this._globalState.update(INDEX_KEY, this._index);
    } catch {
      return undefined;
    }
  }

  // The SecretStorage key for one origin's raw cookie array.
  _secretKey(origin) {
    return SECRET_PREFIX + origin;
  }

  // The plaintext index as an array of safe rows (NO cookie values) — safe to send to the webview.
  list() {
    return Object.keys(this._index).map((origin) => {
      const row = this._index[origin] || {};
      return {
        origin,
        cookieCount: typeof row.cookieCount === 'number' ? row.cookieCount : 0,
        savedAt: row.savedAt || '',
        autoReinject: row.autoReinject === true,
      };
    });
  }

  // Persist the RAW cookie objects for an origin into SecretStorage and update the plaintext index.
  // An empty array still records the origin (count 0) so an operator can save before any cookie
  // exists. autoReinject defaults to false for a new origin and is preserved for an existing one.
  // Never throws; never logs cookie data. Public MANUAL-save contract (SWE-2 depends on it): thin
  // wrapper over _saveBucket that never forces autoReinject on.
  async save(origin, rawCookies) {
    return this._saveBucket(origin, rawCookies, {});
  }

  // Core persistence shared by manual save() and the auto-capture sink autoSaveAll(). Writes the raw
  // cookies to SecretStorage and updates the index row. opts.auto === true forces autoReinject:true
  // (an auto bucket must re-inject); otherwise autoReinject defaults to false for a new origin and is
  // preserved for an existing one — leaving the manual save() contract unchanged. Never throws.
  async _saveBucket(origin, rawCookies, opts) {
    opts = opts || {};
    if (!origin || typeof origin !== 'string') return;
    const cookies = Array.isArray(rawCookies) ? rawCookies : [];
    if (this._secrets) {
      try {
        await this._secrets.store(this._secretKey(origin), JSON.stringify(cookies));
      } catch {
        // Secret write failed — leave the index untouched so it doesn't advertise absent data.
        return;
      }
    }
    const prev = this._index[origin] || {};
    this._index[origin] = {
      cookieCount: cookies.length,
      savedAt: new Date().toISOString(),
      autoReinject: opts.auto === true ? true : prev.autoReinject === true,
    };
    this._persistIndex();
  }

  // The raw cookie array stored for an origin (empty array when absent / no SecretStorage /
  // corrupt JSON). Never throws.
  async _rawForOrigin(origin) {
    if (!this._secrets || !origin) return [];
    let raw;
    try {
      raw = await this._secrets.get(this._secretKey(origin));
    } catch {
      return [];
    }
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  // Injection-ready CookieParam[] for one origin (mapped from the stored raw cookies), [] if
  // absent/corrupt. Never throws; never logs cookie data.
  async getForOrigin(origin) {
    const raw = await this._rawForOrigin(origin);
    return raw.map((c) => mapToCookieParam(c)).filter(Boolean);
  }

  // Delete an origin's stored cookies (SecretStorage) and drop its index row. Idempotent; never
  // throws.
  async remove(origin) {
    if (!origin) return;
    if (this._secrets) {
      try {
        await this._secrets.delete(this._secretKey(origin));
      } catch {
        // Fall through — still drop the index row so the origin stops being advertised.
      }
    }
    if (Object.prototype.hasOwnProperty.call(this._index, origin)) {
      delete this._index[origin];
      this._persistIndex();
    }
  }

  // Index-only update of an origin's auto-reinject flag (no-op for an unknown origin). Never throws.
  async setAutoReinject(origin, bool) {
    if (!origin || !this._index[origin]) return;
    this._index[origin].autoReinject = bool === true;
    this._persistIndex();
  }

  // CookieParam[] concatenating getForOrigin for every index row whose autoReinject !== false.
  // Used by the Stage-3 auto-reinject hook. Never throws; never logs cookie data.
  async allCookiesForInjection() {
    const out = [];
    for (const origin of Object.keys(this._index)) {
      const row = this._index[origin] || {};
      if (row.autoReinject === false) continue;
      const params = await this.getForOrigin(origin);
      for (const p of params) out.push(p);
    }
    return out;
  }

  // --- Stage 4: master "auto for ALL sites" mode ---------------------------------------------

  // Whether hands-off auto-capture/auto-restore is on (globalState, default true). Sync so the
  // background sweep can cheaply gate on it every tick. Absent/garbage stored value reads as true
  // (on by default); only an explicit stored false turns it off, so the operator's off-switch sticks.
  isAutoAllEnabled() {
    try {
      const v = this._globalState && this._globalState.get(AUTOALL_KEY);
      return v === false ? false : true;
    } catch {
      return true;
    }
  }

  // Persist the master auto-all flag. Throw-free; returns the update Thenable (or undefined).
  async setAutoAllEnabled(bool) {
    try {
      return this._globalState && this._globalState.update(AUTOALL_KEY, bool === true);
    } catch {
      return undefined;
    }
  }

  // Normalize a cookie domain into a storage bucket key: strip a single leading '.' and lowercase.
  // Returns '' for a non-string/empty domain (caller skips it).
  _normalizeDomain(domain) {
    if (typeof domain !== 'string') return '';
    let d = domain.trim();
    if (!d) return '';
    if (d[0] === '.') d = d.slice(1);
    return d.toLowerCase();
  }

  // Background auto-capture sink: group the whole browser jar by NORMALIZED domain and persist each
  // domain's cookies as its own bucket with autoReinject:true (so it auto-injects into new sessions).
  // Per-domain bucketing keeps two windows logging into different sites from clobbering each other
  // (same-domain concurrent logins are last-write-wins). Obviously-expired cookies (positive numeric
  // expiry already in the past) are pruned; session cookies (expires -1/0/absent) are KEPT — they are
  // often the auth cookie. Reuses the existing _saveBucket/index machinery. Never throws; never logs
  // cookie data.
  async autoSaveAll(rawCookies) {
    try {
      const cookies = Array.isArray(rawCookies) ? rawCookies : [];
      if (!cookies.length) return;
      const nowSec = Date.now() / 1000;
      const buckets = new Map(); // normalized domain -> raw cookie[]
      for (const c of cookies) {
        if (!c || typeof c !== 'object' || typeof c.name !== 'string') continue;
        if (typeof c.expires === 'number' && c.expires > 0 && c.expires < nowSec) continue;
        const domain = this._normalizeDomain(c.domain);
        if (!domain) continue;
        if (!buckets.has(domain)) buckets.set(domain, []);
        buckets.get(domain).push(c);
      }
      for (const [domain, list] of buckets) {
        if (!list.length) continue;
        await this._saveBucket(domain, list, { auto: true });
      }
    } catch {
      // Throw-free: a bad batch never breaks the sweep.
    }
  }

  // Remove EVERY saved bucket (delete each SecretStorage key, reset the index to empty). Leaves the
  // autoAll flag AS-IS (clearing saved data is not the same as turning the mode off). Idempotent;
  // throw-free — tolerates running concurrently with a sweep.
  async clearAll() {
    try {
      const origins = Object.keys(this._index);
      if (this._secrets) {
        for (const origin of origins) {
          try {
            await this._secrets.delete(this._secretKey(origin));
          } catch {
            // Fall through — still reset the index so nothing stays advertised.
          }
        }
      }
      this._index = {};
      this._persistIndex();
    } catch {
      // Throw-free.
    }
  }
}

// Map a CDP Cookie object to a CDP CookieParam (injection-ready). Keep name/value/domain/path/
// secure/httpOnly/sameSite; include `expires` ONLY when it is a real value and NOT -1 (a session
// cookie is expires === -1 — omitting it keeps it a session cookie instead of a bogus 1969 expiry
// that gets dropped). Carry sourceScheme/sourcePort/partitionKey through when present. Drop size/
// session/priority/sameParty (not valid CookieParam inputs). Returns null for a nameless entry.
function mapToCookieParam(c) {
  if (!c || typeof c !== 'object' || typeof c.name !== 'string') return null;
  const p = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
  };
  if (typeof c.expires === 'number' && c.expires !== -1) p.expires = c.expires;
  if (c.sourceScheme !== undefined) p.sourceScheme = c.sourceScheme;
  if (c.sourcePort !== undefined) p.sourcePort = c.sourcePort;
  if (c.partitionKey !== undefined) p.partitionKey = c.partitionKey;
  return p;
}

module.exports = { CookieStore };
