// Fetches favicons for bookmarked URLs as data: URIs so the injected in-page bookmarks bar
// (and any editor UI) can render real icons without the target page's img-src CSP blocking a
// live <img src="https://...">. Runs Node-side (uses global fetch, Node 18+) so the result can
// be persisted straight into the bookmarks tree. One FaviconFetcher per activation; results are
// cached in memory per host so repeated bookmarks on the same site are never refetched.

// Google's favicon service; keyed by host, so results are cached per host rather than per URL.
const FAVICON_SERVICE = 'https://www.google.com/s2/favicons';
const FETCH_TIMEOUT_MS = 4000;
const MAX_BYTES = 50 * 1024; // keeps the persisted globalState tree lean
const DEFAULT_CONTENT_TYPE = 'image/png';

class FaviconFetcher {
  constructor() {
    // hostname -> resolved data: URI, or null for a permanent "no favicon found" result.
    this._cache = new Map();
  }

  // Resolve url's favicon as a data: URI, or null on any failure (bad url, non-http(s),
  // network error, timeout, oversized image). Never throws - callers can await it unconditionally.
  async fetch(url) {
    const host = this._hostOf(url);
    if (!host) return null;
    if (this._cache.has(host)) return this._cache.get(host);
    const result = await this._fetchForHost(host);
    this._cache.set(host, result);
    return result;
  }

  // Parse the hostname out of url; null for anything unparseable or non-http(s) (data:, file:,
  // about:, etc. have no meaningful favicon host).
  _hostOf(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.hostname;
    } catch {
      return null;
    }
  }

  // Fetch + base64-encode the favicon for one host, trying multiple sources in order and
  // returning the first that yields real image bytes. Wrapped so every failure mode (network,
  // non-2xx, timeout, oversized body, non-image response) resolves to null rather than throwing.
  async _fetchForHost(host) {
    // Ordered fallback chain: DuckDuckGo, then the site's own /favicon.ico, then Google as a
    // last resort (Google 404s for a large fraction of domains).
    const sources = [
      `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`,
      `https://${host}/favicon.ico`,
      `${FAVICON_SERVICE}?domain=${encodeURIComponent(host)}&sz=32`,
    ];
    for (const url of sources) {
      const result = await this._tryFetchIcon(url);
      if (result) return result;
    }
    return null;
  }

  // Fetch one candidate icon url and return its data: URI, or null on any miss. Each attempt
  // gets its own FETCH_TIMEOUT_MS/abort so a slow source can't hang the whole chain. A response
  // counts as a hit only when it is 2xx, has an image/* content-type, and carries a non-empty
  // body - guarding against e.g. DuckDuckGo's 200 + 0-byte text/plain "no icon" response.
  async _tryFetchIcon(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const contentType = (res.headers && res.headers.get('content-type')) || '';
      if (!contentType.toLowerCase().startsWith('image/')) return null;
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0) return null;
      if (buf.byteLength > MAX_BYTES) return null;
      const b64 = Buffer.from(buf).toString('base64');
      return `data:${contentType};base64,${b64}`;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { FaviconFetcher };
