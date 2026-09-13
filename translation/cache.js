// translation/cache.js
// Classic-script module. Exports: ns.SessionCache
// In-memory (session) cache: avoids re-translating the same English text.
(function () {
  var ns = globalThis.__PLAMO__;
  var log = ns.logger.log;

  function SessionCache() {
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  function get(key) {
    if (this.map.has(key)) {
      this.hits++;
      return this.map.get(key);
    }
    this.misses++;
    return undefined;
  }

  function set(key, value) {
    this.map.set(key, value);
  }

  function clear() {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
  }

  SessionCache.prototype.get = get;
  SessionCache.prototype.set = set;
  SessionCache.prototype.clear = clear;

  ns.SessionCache = SessionCache;
})();
