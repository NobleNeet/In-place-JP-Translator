// translation/cache.js
// Session-only in-memory cache: Map<originalText, translatedText>.
// Structured so a persistent cache can be layered on later.

export class SessionCache {
  constructor() {
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  has(text) {
    return this.map.has(text);
  }

  get(text) {
    return this.map.get(text);
  }

  set(text, translated) {
    this.map.set(text, translated);
  }

  recordHit() {
    this.hits += 1;
  }

  recordMiss() {
    this.misses += 1;
  }

  clear() {
    this.map.clear();
  }
}
