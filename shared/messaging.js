// shared/messaging.js
// Classic-script module. Exports: ns.messaging
//
// chrome.runtime.sendMessage() serializes the payload (structured clone / JSON).
// Anything that cannot survive that trip silently changes shape:
//   - Map / Set  -> {}          (this is what caused "cache.get is not a function")
//   - DOM nodes  -> dropped     (segments used to carry source.element)
//   - functions  -> dropped
// This module builds wire-safe payloads and normalizes what arrives, so both
// sides fail loudly in the logs instead of silently misbehaving.
(function () {
  var ns = globalThis.__PLAMO__;
  var describe = ns.logger.describe;

  var MAX_CACHE_ENTRIES = 4000; // hard cap for a cache payload
  var MAX_CACHE_CHARS = 1500000; // ~1.5 MB of cached text per message

  var reqSeq = 0;
  function makeRequestId(prefix) {
    reqSeq++;
    return (prefix || 'req') + '-' + Date.now().toString(36) + '-' + reqSeq;
  }

  // --- wire-safety inspection ---------------------------------------------
  // Returns a list of { path, kind } for values that serialization would alter
  // or drop. Diagnostics only; never throws.
  function findUnserializable(value, opts) {
    opts = opts || {};
    var out = [];
    var depth = opts.depth == null ? 4 : opts.depth;
    var limit = opts.limit == null ? 8 : opts.limit;
    var seen = [];
    function walk(v, path, d) {
      if (out.length >= limit) return;
      if (v === null || v === undefined) return;
      var t = typeof v;
      if (t === 'string' || t === 'number' || t === 'boolean') return;
      if (t === 'function') { out.push({ path: path, kind: 'function' }); return; }
      if (t !== 'object') { out.push({ path: path, kind: t }); return; }
      if (v.nodeType) { out.push({ path: path, kind: 'dom-node ' + describe(v, 60) }); return; }
      if (v instanceof Promise) { out.push({ path: path, kind: 'promise' }); return; }
      if (v instanceof Map || v instanceof Set) {
        out.push({ path: path, kind: (v instanceof Map ? 'Map' : 'Set') + ' (becomes {} on the wire)' });
        return;
      }
      if (v instanceof Error) { out.push({ path: path, kind: 'error' }); return; }
      if (seen.indexOf(v) !== -1) { out.push({ path: path, kind: 'circular' }); return; }
      if (d <= 0) return;
      seen.push(v);
      var keys = Array.isArray(v) ? v.map(function (_, i) { return i; }) : Object.keys(v);
      for (var i = 0; i < keys.length; i++) walk(v[keys[i]], path + '.' + keys[i], d - 1);
      seen.pop();
    }
    walk(value, opts.root || 'value', depth);
    return out;
  }

  // Logs every field that will not survive serialization.
  function warnUnserializable(payload, label, opts) {
    var issues = findUnserializable(payload, opts);
    if (issues.length) {
      ns.logger.log.warn('payload "' + label + '" has ' + issues.length + ' unsafe field(s): ' +
        issues.map(function (i) { return i.path + ' -> ' + i.kind; }).join(' | '));
    }
    return issues;
  }

  // --- wire payload builders ----------------------------------------------
  function toWireSegment(seg) {
    // Deliberately drops segment.source, which holds a DOM element.
    return {
      id: seg.id,
      text: seg.text,
      estimatedTokens: seg.estimatedTokens,
      viewport: seg.viewport
    };
  }

  function toWireBatch(batch) {
    return {
      index: batch.index,
      estimatedTokens: batch.estimatedTokens,
      segments: (batch.segments || []).map(toWireSegment)
    };
  }

  // Plain-object cache payload limited to this batch's texts, so a long page
  // does not resend its whole cache with every message.
  function toWireCache(cache, segments, opts) {
    opts = opts || {};
    var maxEntries = opts.maxEntries || MAX_CACHE_ENTRIES;
    var maxChars = opts.maxChars || MAX_CACHE_CHARS;
    var wire = {};
    if (!cache || !cache.map || typeof cache.map.has !== 'function') return wire;
    var entries = 0, chars = 0;
    for (var i = 0; i < (segments || []).length; i++) {
      var text = segments[i].text;
      if (!cache.map.has(text)) continue;
      if (entries >= maxEntries || chars >= maxChars) {
        ns.logger.log.warn('toWireCache truncated at entries=' + entries + ' chars=' + chars);
        break;
      }
      var value = cache.map.get(text);
      if (typeof value !== 'string') continue;
      wire[text] = value;
      entries++;
      chars += value.length;
    }
    return wire;
  }

  // Accepts whatever survived the wire (plain object, a Map when called
  // in-process, or nothing) and always exposes the same lookup interface.
  // Never calls .get() on a non-Map, which is what broke translation before.
  function normalizeCache(payload) {
    var store = null;
    var form = 'none';
    if (payload instanceof Map) { store = payload; form = 'map'; }
    else if (payload && typeof payload === 'object' && payload.map instanceof Map) {
      store = payload.map; form = 'session-cache';
    } else if (payload && typeof payload === 'object') { store = payload; form = 'object'; }

    var api = {
      form: form,
      size: store ? ((form === 'object') ? Object.keys(store).length : store.size) : 0,
      hits: 0, misses: 0,
      has: function (text) {
        if (!store) return false;
        var found = (form === 'object')
          ? Object.prototype.hasOwnProperty.call(store, text)
          : store.has(text);
        if (found) api.hits++; else api.misses++;
        return found;
      },
      get: function (text) {
        if (!store) return undefined;
        return (form === 'object') ? store[text] : store.get(text);
      },
      keys: function () {
        if (!store) return [];
        return (form === 'object') ? Object.keys(store) : Array.from(store.keys());
      }
    };
    return api;
  }

  // chrome.runtime.lastError / extension errors are cryptic; this returns the
  // fix that applies, so the log line is actionable on its own.
  function hintFor(message) {
    var m = String(message || '');
    if (m.indexOf('message port closed') !== -1) {
      return ' | hint: an extension listener answered asynchronously without returning true, or the service worker stopped mid-request. Compare the page logs (__plamo.dumpLogs()) with the background ones (__plamo.backgroundLogs()).';
    }
    if (m.indexOf('Receiving end does not exist') !== -1) {
      return ' | hint: no extension listener is alive (extension reloaded or worker asleep). Reload this page, then retry.';
    }
    if (m.indexOf('Extension context invalidated') !== -1) {
      return ' | hint: this page was orphaned by an extension reload/update. Reload the page before translating.';
    }
    if (m.indexOf('No active tab') !== -1 || m.indexOf('Frame with ID') !== -1) {
      return ' | hint: the popup talked to a tab with no content script (chrome:// page or a frame). Open a normal http(s) page.';
    }
    if (m.indexOf('Cannot access') !== -1) {
      return ' | hint: chrome.tabs cannot reach this page (chrome://, the Web Store, or a restricted page). Use a normal web page.';
    }
    return '';
  }

  // --- log summaries -------------------------------------------------------
  function summarizeSegments(segments, n) {
    n = n == null ? 4 : n;
    return (segments || []).slice(0, n).map(function (s) {
      var text = String(s.text || '');
      return '#' + s.id + '(' + text.length + 'ch) ' + JSON.stringify(text.slice(0, 40));
    }).join(' , ');
  }

  function summarizeBatch(batch) {
    if (!batch) return 'null';
    var segs = batch.segments || [];
    var chars = segs.reduce(function (sum, s) { return sum + String(s.text || '').length; }, 0);
    return 'segments=' + segs.length + ' chars=' + chars + ' estTokens=' + batch.estimatedTokens +
      ' ids=[' + segs.slice(0, 12).map(function (s) { return s.id; }).join(',') + ']' +
      (segs.length > 12 ? '…' : '');
  }

  function summarizeMessage(msg) {
    if (!msg || typeof msg !== 'object') return describe(msg, 120);
    var out = 'type=' + msg.type + ' id=' + (msg.id || '-');
    if (msg.batch) out += ' ' + summarizeBatch(msg.batch);
    if (msg.profileName != null) out += ' profile=' + msg.profileName;
    if (msg.concurrency != null) out += ' concurrency=' + msg.concurrency;
    if (msg.timeoutMs != null) out += ' timeoutMs=' + msg.timeoutMs;
    if (msg.cache) out += ' cache=' + Object.keys(msg.cache).length + ' entr(y/ies)';
    return out;
  }

  // Counts outcomes and samples the first few per-segment errors, which is the
  // part that used to be invisible.
  function summarizeResults(results, maxErrorSamples) {
    maxErrorSamples = maxErrorSamples == null ? 3 : maxErrorSamples;
    var ids = Object.keys(results || {});
    var ok = 0, failed = 0, cached = 0, samples = [];
    ids.forEach(function (id) {
      var r = results[id];
      if (r && r.translatedText) ok++;
      if (r && r.cached) cached++;
      if (r && r.error) {
        failed++;
        if (samples.length < maxErrorSamples) {
          samples.push('#' + id + ' ' + (r.errorType || '?') + ': ' + String(r.error).slice(0, 120));
        }
      }
    });
    return {
      total: ids.length, translated: ok, failed: failed, cached: cached,
      text: 'results=' + ids.length + ' ok=' + ok + ' failed=' + failed + ' cached=' + cached +
        (samples.length ? ' samples[' + samples.join(' || ') + ']' : '')
    };
  }

  function summarizeError(err) {
    if (!err) return 'unknown error';
    if (typeof err === 'string') return err;
    return (err.errorType ? ('[' + err.errorType + '] ') : '') +
      (err.error || err.message || describe(err, 200));
  }

  ns.messaging = {
    makeRequestId: makeRequestId,
    findUnserializable: findUnserializable,
    warnUnserializable: warnUnserializable,
    toWireSegment: toWireSegment,
    toWireBatch: toWireBatch,
    toWireCache: toWireCache,
    normalizeCache: normalizeCache,
    hintFor: hintFor,
    summarizeSegments: summarizeSegments,
    summarizeBatch: summarizeBatch,
    summarizeMessage: summarizeMessage,
    summarizeResults: summarizeResults,
    summarizeError: summarizeError
  };
})();