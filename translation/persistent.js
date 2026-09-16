// translation/persistent.js
// Classic-script module. Exports: ns.persistentCache
// The exact-match translation cache that outlives the page: finished
// translations live in chrome.storage.local, so the back button or a page
// opened in another tab before costs only the text nobody has ever translated.
//
// Three rules shape the whole module:
//
// 1. A hit must be a byte-for-byte identical text. Keys are built from a hash
//    of the source, but the hash is only an index: every stored entry keeps
//    its source text, and a lookup hits only when it equals the asked text
//    exactly. A hash collision therefore can never mistranslate a sentence -
//    it degrades to a cache miss.
//
// 2. Only landed translations are stored. content.js feeds this cache from
//    applyBatchResults() and from nothing else, so an echo, a self-identical
//    answer, or a half-written node never enters persistent storage.
//
// 3. Trim order is earned, not chronological. Every lookup hit records a reuse
//    on its entry, and maintain() ages an entry 1/(1+reuses) as fast, so the
//    `About us` a site answers on every page view outlives an article
//    paragraph that was read once. An entry that has never been reused still
//    ages from the day it was stored, which is the rule this module had before
//    the counters existed.
(function () {
  var ns = globalThis.__PLAMO__;
  var C = ns.constants;
  var log = ns.logger.log;

  var PREFIX = 'plamo-t-';
  // Longer than any node the extractor produces (EXTRACT.maxTextLength is
  // 12000) with room to spare; caching a megabyte of one text node would cost
  // more in storage reads than the translation it would save.
  var MAX_TEXT = 65536;

  var settings = Object.assign({}, C.CACHE_SETTINGS);
  // Text remembered since the last maintain(), in source+translation chars.
  var sinceMaintain = 0;
  // text -> { s, t, at, n }; deduplicates a run that sees the same sentence
  // twice and keeps flush() to exactly one storage.set per run.
  var pending = new Map();
  // storage key -> entry for every hit this run read out of storage, so
  // remember() can tell "the page just re-applied what storage already holds"
  // from "a translation nobody has stored yet" (see remember).
  var seen = new Map();
  // storage key -> entry. Hits whose reuse counters have to go back to storage,
  // written by the same flush() that writes `pending` (see bumpUse).
  var touched = new Map();

  function store() {
    return (globalThis.chrome && globalThis.chrome.storage && globalThis.chrome.storage.local) || null;
  }

  function configure(patch) {
    var p = patch || {};
    settings.enabled = p.enabled == null ? C.CACHE_SETTINGS.enabled : !!p.enabled;
    // Clamped, not trusted: a stored typo must not shrink the cache to nothing
    // (0 entries means every lookup re-translates) nor grow it past storage.
    settings.maxEntries = clamp(C.CACHE_SETTINGS.maxEntries, p.maxEntries, 1, 200000);
    settings.maxChars = clamp(C.CACHE_SETTINGS.maxChars, p.maxChars, 1000, 100000000);
    settings.maintainAfterChars = clamp(C.CACHE_SETTINGS.maintainAfterChars, p.maintainAfterChars, 1000, 100000000);
    // 0 means "log every single reuse", which is correct and expensive; the
    // ceiling keeps a stored typo from freezing the counters for a year.
    settings.useLogIntervalMs = clamp(C.CACHE_SETTINGS.useLogIntervalMs, p.useLogIntervalMs, 0, 86400000);
  }

  function clamp(fallback, value, min, max) {
    var n = Math.round(Number(value));
    if (!Number.isFinite(n)) n = fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function enabled() {
    return !!settings.enabled;
  }

  // --- keys ------------------------------------------------------------------
  // Two FNV-1a lanes over the text, one of them reversed, so a single edit at
  // either end of the string moves several bits of the index. The length is
  // mixed in unhashed: same length + both lanes equal is already vanishingly
  // rare, and `s` equality on top of it makes a false hit impossible in
  // practice. Keys must stay ASCII: they are chrome.storage.local keys.
  function fnv1a(str, seed) {
    var h = seed >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function hex8(h) {
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function entryKey(text) {
    var lane1 = fnv1a(text, 0x811c9dc5);
    var lane2 = fnv1a(text.split('').reverse().join(''), 0x811c9dc5) ^ 0x9e3779b9;
    return PREFIX + hex8(lane1) + hex8(lane2) + '-' + text.length;
  }

  // bumpUse(): a hit is an entry earning its keep, so it is counted. The
  // counters live beside the translation, which means a hit can cost a write;
  // `useLogIntervalMs` bounds that. Retention is measured in days, so an hour
  // of resolution is plenty, and a page re-rendered every second stops
  // rewriting the same few hundred entries forever.
  function bumpUse(key, e, now) {
    var last = typeof e.used === 'number' ? e.used : e.at;
    if (now - last < settings.useLogIntervalMs) return false;
    e.n = (typeof e.n === 'number' && e.n > 0 ? e.n : 0) + 1;
    e.used = now;
    touched.set(key, e);
    return true;
  }

  // --- reading ----------------------------------------------------------------
  // lookup(texts): one storage.get for every unique text, resolved with the
  // translations whose stored source matches exactly. The storage mock in the
  // DOM tests (and older Chrome behaviour) may answer with more keys than
  // asked for, so every candidate is re-checked against `PREFIX` and its own
  // source text rather than trusted for being in the response.
  function lookup(texts) {
    if (!settings.enabled) return Promise.resolve({ hits: {}, queried: 0, skipped: texts.length, reused: 0 });
    seen.clear();
    var byKey = {};
    var skipped = 0;
    texts.forEach(function (text) {
      if (!text || typeof text !== 'string' || text.length > MAX_TEXT) { skipped++; return; }
      byKey[entryKey(text)] = text;
    });
    var keys = Object.keys(byKey);
    if (!keys.length) return Promise.resolve({ hits: {}, queried: 0, skipped: skipped, reused: 0 });
    var s = store();
    if (!s) {
      log('warn', 'persistent cache: no chrome.storage.local, every translation will go to the API');
      return Promise.resolve({ hits: {}, queried: 0, skipped: texts.length, reused: 0 });
    }
    return s.get(keys).then(function (raw) {
      var found = {};
      var reused = 0;
      var now = Date.now();
      Object.keys(byKey).forEach(function (key) {
        var text = byKey[key];
        // `touched` first: a reuse counted earlier in this run has not reached
        // storage yet, and a second lookup must not age the entry from scratch
        // and count the same reuse again.
        var e = touched.get(key) || (raw && raw[key]);
        if (!(key.indexOf(PREFIX) === 0 && e && typeof e.t === 'string' && e.s === text)) return;
        found[text] = e.t;
        // Kept so remember() can recognise what storage already holds. It is
        // the very object bumpUse counts on, so the counters this run reads are
        // the ones it writes back.
        seen.set(key, e);
        if (bumpUse(key, e, now)) reused++;
      });
      return { hits: found, queried: keys.length, skipped: skipped, reused: reused };
    }, function (err) {
      // A failed read is a slow page, never a broken one: fall through to the API.
      log('warn', 'persistent cache: storage read failed, skipping the cache this run', String(err && err.message || err));
      return { hits: {}, queried: 0, skipped: texts.length, reused: 0 };
    });
  }

  // --- writing -----------------------------------------------------------------
  // remember() only queues; flush() writes the whole run in one storage.set so
  // a 500-segment page costs one storage write instead of 500.
  function remember(text, translated) {
    if (!settings.enabled) return false;
    if (!text || typeof text !== 'string' || typeof translated !== 'string' || !translated) return false;
    if (text.length > MAX_TEXT || translated.length > MAX_TEXT) return false;
    // A hit that the run just wrote into the page comes back through here as if
    // it were new. Storing it again would rewrite every entry of a page visited
    // daily, and reset the `at` the trim breaks ties on, so leave it alone: its
    // reuse counter is already on its way back to storage through `touched`.
    var known = seen.get(entryKey(text));
    if (known && known.t === translated) return false;
    var old = pending.get(text);
    if (old && old.t === translated) return false;
    // `n` starts at 0: the translation has been produced, not yet reused.
    pending.set(text, { s: text, t: translated, at: Date.now(), n: 0 });
    return true;
  }

  function flush() {
    if (!pending.size && !touched.size) return Promise.resolve({ written: 0, reused: 0 });
    var s = store();
    if (!s) {
      log('warn', 'persistent cache: dropping ' + pending.size + ' remembered translation(s), no storage available');
      pending.clear();
      touched.clear();
      seen.clear();
      return Promise.resolve({ written: 0, reused: 0 });
    }
    // One write for both queues. Writing `pending` after `touched` means that if
    // the same text was both read from storage and answered differently by the
    // API, the translation the page now shows is the one that survives.
    var body = {};
    var chars = 0;
    touched.forEach(function (e, key) { body[key] = e; });
    pending.forEach(function (e, text) {
      body[entryKey(text)] = e;
      chars += e.s.length + e.t.length;
    });
    var written = pending.size;
    var reused = touched.size;
    pending.clear();
    touched.clear();
    seen.clear();
    return s.set(body).then(function () {
      // Only new text grows the store, so only new text asks for a trim; a run
      // that merely re-read what is already stored has nothing to evict.
      sinceMaintain += chars;
      if (sinceMaintain >= settings.maintainAfterChars) {
        sinceMaintain = 0;
        return maintain().then(function (trimmed) { return { written: written, reused: reused, trimmed: trimmed }; });
      }
      return { written: written, reused: reused };
    }, function (err) {
      log('warn', 'persistent cache: storage write failed, ' + written + ' translation(s) not cached', String(err && err.message || err));
      return { written: 0, reused: 0 };
    });
  }

  // maintain(): trim the store back under 90% of its caps, least worth keeping
  // first. 90% instead of 100% so a run that stores a little does not have to
  // enumerate the whole store every single time.
  function maintain() {
    if (!settings.enabled) return Promise.resolve(0);
    var s = store();
    if (!s) return Promise.resolve(0);
    if (typeof s.remove !== 'function') {
      log('warn', 'persistent cache: storage.local.remove is unavailable, the cache cannot be trimmed');
      return Promise.resolve(0);
    }
    return s.get(null).then(function (raw) {
      var keys = Object.keys(raw).filter(function (key) {
        return key.indexOf(PREFIX) === 0 && raw[key] && typeof raw[key].at === 'number';
      });
      var targetEntries = Math.floor(settings.maxEntries * 0.9);
      var targetChars = Math.floor(settings.maxChars * 0.9);
      var now = Date.now();
      var entries = keys.map(function (key) {
        var e = raw[key];
        var used = typeof e.used === 'number' ? e.used : e.at;
        var reuses = typeof e.n === 'number' && e.n > 0 ? e.n : 0;
        return {
          key: key,
          // Effective age. A never-reused entry is exactly as old as it is, so
          // entries written before reuse counters existed (and one-off
          // translations) keep the old oldest-first order; each reuse divides
          // the age by one more, so the hundredth copy of `About us` is the
          // last thing the trim removes. Nothing is immortal: an age still
          // accrues, only slower.
          age: (now - used) / (1 + reuses),
          at: e.at,
          chars: String(e.s || '').length + String(e.t || '').length
        };
      });
      var totalChars = entries.reduce(function (sum, e) { return sum + e.chars; }, 0);
      if (entries.length <= targetEntries && totalChars <= targetChars) return 0;
      // Least worth keeping first, and drop them until BOTH caps are met again:
      // an entry counts once for each cap it violates. Ties go to the entry that
      // has been sitting there longer, which is the old oldest-first rule and
      // keeps the order of a run's own entries (same `used`) reproducible.
      entries.sort(function (a, b) { return b.age - a.age || a.at - b.at; });
      var doomed = [];
      var count = entries.length;
      for (var i = 0; i < entries.length && (count > targetEntries || totalChars > targetChars); i++) {
        doomed.push(entries[i].key);
        totalChars -= entries[i].chars;
        count--;
      }
      return s.remove(doomed).then(function () { return doomed.length; }, function (err) {
        log('warn', 'persistent cache: trim failed', String(err && err.message || err));
        return 0;
      });
    }, function () { return 0; });
  }

  function clear() {
    var dropped = pending.size;
    pending.clear();
    touched.clear();
    seen.clear();
    var s = store();
    if (!s) return Promise.resolve({ removed: 0, pendingDropped: dropped });
    return s.get(null).then(function (raw) {
      var keys = Object.keys(raw).filter(function (key) { return key.indexOf(PREFIX) === 0; });
      if (!keys.length) return { removed: 0, pendingDropped: dropped };
      if (typeof s.remove !== 'function') {
        log('warn', 'persistent cache: storage.local.remove is unavailable, cannot clear');
        return { removed: 0, pendingDropped: dropped };
      }
      return s.remove(keys).then(function () { return { removed: keys.length, pendingDropped: dropped }; });
    });
  }

  // snapshot(): what the console helper and the widget show. Storage-side
  // counts are deliberately not included: enumerating the whole store to
  // answer "how is the cache doing?" would cost more than the question is
  // worth. Use maintain()'s return or DevTools for the exact store size.
  function snapshot() {
    var chars = 0;
    pending.forEach(function (e) { chars += e.s.length + e.t.length; });
    return {
      enabled: !!settings.enabled,
      pending: pending.size,
      pendingChars: chars,
      // Hits already counted this run, waiting for flush() to write them back.
      pendingReuses: touched.size,
      sinceMaintain: sinceMaintain,
      maxEntries: settings.maxEntries,
      maxChars: settings.maxChars,
      maintainAfterChars: settings.maintainAfterChars,
      useLogIntervalMs: settings.useLogIntervalMs
    };
  }

  ns.persistentCache = {
    configure: configure,
    enabled: enabled,
    lookup: lookup,
    remember: remember,
    flush: flush,
    maintain: maintain,
    clear: clear,
    snapshot: snapshot,
    entryKey: entryKey
  };
})();
