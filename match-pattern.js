// Chrome-extension-style URL match patterns: `<scheme>://<host><path>`, plus the special
// `<all_urls>`. Used by the Extensions feature (Phase 2) to decide whether an extension applies to
// a given page. Throw-free: a malformed pattern parses to null and simply never matches, so bad
// operator input degrades to "no match" instead of an error.
//
// Semantics (matching Chrome):
//   scheme  '*' → http OR https; or an explicit 'http'|'https'|'file'|'ftp'.
//   host    '*' → any host; '*.foo.com' → 'foo.com' AND any subdomain of it; else an exact host.
//           '*' is only valid as the ENTIRE host or as the leading '*.' label. file:// has no host.
//   path    must start with '/'; '*' is the only wildcard and matches any run of characters
//           (including empty). Matched against pathname + query string.
//
// A JS PORT of matchesUrl is embedded in the injected page bootstrap (see cdp-tab.js
// _buildExtensionsBootstrap); keep the two in sync if the semantics change.

// Schemes we accept in a pattern's scheme slot.
const SCHEME_RE = /^(\*|https?|file|ftp)$/;
// Schemes <all_urls> expands to.
const ALL_URLS_SCHEMES = ['http', 'https', 'file', 'ftp'];

// Parse one pattern into { allUrls } | { scheme, host, path } | null (malformed). Exposed so the
// UI can validate a single pattern (null ⇒ reject as malformed).
function parseMatchPattern(pattern) {
  if (typeof pattern !== 'string') return null;
  const p = pattern.trim();
  if (!p) return null;
  if (p === '<all_urls>') return { allUrls: true };

  const sep = p.indexOf('://');
  if (sep === -1) return null;
  const scheme = p.slice(0, sep);
  if (!SCHEME_RE.test(scheme)) return null;

  const rest = p.slice(sep + 3);
  const slash = rest.indexOf('/');
  if (slash === -1) return null; // a path (at least '/') is mandatory
  const host = rest.slice(0, slash);
  const path = rest.slice(slash);
  if (!path.startsWith('/')) return null;

  if (scheme === 'file') {
    // file:// patterns have an empty host.
    if (host !== '') return null;
  } else {
    if (host === '') return null;
    if (host !== '*') {
      if (host.startsWith('*.')) {
        const bare = host.slice(2);
        if (!bare || bare.indexOf('*') !== -1) return null; // '*.' must be followed by a plain host
      } else if (host.indexOf('*') !== -1) {
        return null; // '*' is only valid as the whole host or the leading '*.' label
      }
    }
  }
  return { allUrls: false, scheme, host, path };
}

// Compile a path glob ('*' = any run of chars) to an anchored RegExp.
function globToRegExp(glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') re += '.*';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(re + '$');
}

function matchHost(patternHost, urlHost) {
  if (patternHost === '*') return true;
  if (patternHost.startsWith('*.')) {
    const bare = patternHost.slice(2);
    return urlHost === bare || urlHost.endsWith('.' + bare);
  }
  return urlHost === patternHost;
}

// Does a single parsed pattern match a WHATWG URL object?
function matchesSingle(parsed, u) {
  if (!parsed) return false;
  const scheme = u.protocol.replace(/:$/, '');
  if (parsed.allUrls) return ALL_URLS_SCHEMES.indexOf(scheme) !== -1;
  if (parsed.scheme === '*') {
    if (scheme !== 'http' && scheme !== 'https') return false;
  } else if (parsed.scheme !== scheme) {
    return false;
  }
  if (scheme !== 'file' && !matchHost(parsed.host, u.hostname)) return false;
  return globToRegExp(parsed.path).test(u.pathname + u.search);
}

// OR across an extension's `matches` array. Empty/invalid array ⇒ false (fail-safe: an extension
// with no patterns applies to nothing). A URL that won't parse ⇒ false.
function matchesUrl(patterns, url) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  for (let i = 0; i < patterns.length; i++) {
    const parsed = parseMatchPattern(patterns[i]);
    if (parsed && matchesSingle(parsed, u)) return true;
  }
  return false;
}

module.exports = { parseMatchPattern, matchesUrl };
