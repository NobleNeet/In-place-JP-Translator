// shared/logger.js
// Classic-script module. Exports: logger.log / setDebug / setVerbose / getLogs
// (loaded as a global-scope script via manifest; see globalThis.__PLAMO__).
//
// Diagnostics first: every record (including trace-level) is kept in a ring
// buffer, so a failure can be inspected AFTER it happened from the page
// (__plamo.getLogs() / __plamo.dumpLogs()) or from the service worker console
// (__PLAMO__.logger.getLogs()).
(function () {
  var ns = (globalThis.__PLAMO__ = globalThis.__PLAMO__ || {});
  var PREFIX = '[PLaMoTranslate]';
  var debugEnabled = true;
  var verboseEnabled = true; // per-step + payload-shape detail (turn off for quiet runs)
  var maxRecords = 600;
  var seq = 0;
  var records = []; // ring buffer, oldest dropped
  var counts = { trace: 0, debug: 0, info: 0, warn: 0, error: 0, batch: 0 };

  // --- value inspection -----------------------------------------------------
  // Never throws, and never dumps a huge or circular object into the console.
  function describeValue(value, maxLen, depth, seen) {
    maxLen = maxLen || 400;
    depth = depth == null ? 2 : depth;
    seen = seen || [];
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    var type = typeof value;
    if (type === 'string') {
      var s = value.length > maxLen ? (value.slice(0, maxLen) + '…(' + value.length + ' chars)') : value;
      return JSON.stringify(s);
    }
    if (type === 'number' || type === 'boolean') return String(value);
    if (type === 'bigint') return String(value) + 'n';
    if (type === 'function') return '[function ' + (value.name || 'anonymous') + ']';
    if (type === 'symbol') return String(value);
    if (value instanceof Error) return '[Error ' + value.name + ': ' + value.message + ']';
    if (value instanceof Date) return '[Date ' + value.toISOString() + ']';
    // DOM nodes: identify only, never walk (walking reaches window/document).
    if (value.nodeType) {
      var tag = value.nodeName ? value.nodeName.toLowerCase() : 'node#' + value.nodeType;
      var id = value.id ? ('#' + value.id) : '';
      var cls = (typeof value.className === 'string' && value.className)
        ? ('.' + value.className.trim().split(/\s+/)[0]) : '';
      var txt = (value.textContent || '').trim().slice(0, 30);
      return '[DOM ' + tag + id + cls + (txt ? (' "' + txt + '…"') : '') + ']';
    }
    if (value instanceof Promise) return '[Promise]';
    if (value instanceof Map) return '[Map size=' + value.size + ' keys~' + describeIterable(Array.from(value.keys()).slice(0, 5)) + ']';
    if (value instanceof Set) return '[Set size=' + value.size + ' ' + describeIterable(Array.from(value).slice(0, 5)) + ']';
    if (seen.indexOf(value) !== -1) return '[Circular]';
    if (depth <= 0) {
      return Array.isArray(value)
        ? '[array len=' + value.length + '…]'
        : '[object keys=' + Object.keys(value).length + '…]';
    }
    seen.push(value);
    var out;
    if (Array.isArray(value)) {
      var items = value.slice(0, 12).map(function (v) { return describeValue(v, 80, depth - 1, seen); });
      out = '[' + items.join(', ') + (value.length > 12 ? (', …+' + (value.length - 12)) : '') + ']';
    } else {
      var allKeys = Object.keys(value);
      var pairs = allKeys.slice(0, 24).map(function (k) {
        return k + ': ' + describeValue(value[k], 80, depth - 1, seen);
      });
      out = '{' + pairs.join(', ') + (allKeys.length > 24 ? (', …+' + (allKeys.length - 24)) : '') + '}';
    }
    seen.pop();
    return out.length > maxLen ? (out.slice(0, maxLen) + '…') : out;
  }

  function describeIterable(list) {
    try { return JSON.stringify(list); } catch (e) { return '[?]'; }
  }

  // --- ring buffer ---------------------------------------------------------
  function record(level, args) {
    seq++;
    counts[level] = (counts[level] || 0) + 1;
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      parts.push(typeof args[i] === 'string' ? args[i] : describeValue(args[i], 600));
    }
    var rec = { i: seq, t: Date.now(), level: level, text: parts.join(' ') };
    records.push(rec);
    while (records.length > maxRecords) records.shift();
    return rec;
  }

  function emit(level, consoleFn, args) {
    var rec = record(level, args);
    if (debugEnabled || level === 'warn' || level === 'error') {
      consoleFn.apply(console, [PREFIX + ' #' + rec.i + ' ' + rec.text]);
    }
    return rec;
  }

  var log = {
    // trace: printed only while verbose, but always stored in the ring buffer.
    trace: function () {
      var rec = record('trace', arguments);
      if (debugEnabled && verboseEnabled) console.log(PREFIX + ' #' + rec.i + ' ' + rec.text);
      return rec;
    },
    debug: function () { return emit('debug', console.log, arguments); },
    info: function () { return emit('info', console.info, arguments); },
    warn: function () { return emit('warn', console.warn, arguments); },
    error: function () { return emit('error', console.error, arguments); },
    batch: function (obj) { return emit('batch', console.log, [JSON.stringify(obj)]); },
    time: function (label, fn) {
      var t0 = performance.now();
      try { return fn(); }
      finally { log.debug(label + ' ' + Math.round(performance.now() - t0) + 'ms'); }
    }
  };

  function setDebug(enabled) { debugEnabled = !!enabled; return debugEnabled; }
  function isDebug() { return debugEnabled; }
  function setVerbose(enabled) { verboseEnabled = !!enabled; return verboseEnabled; }
  function isVerbose() { return verboseEnabled; }
  function setBufferSize(n) {
    var n2 = parseInt(n, 10);
    if (n2 >= 20) maxRecords = n2;
    while (records.length > maxRecords) records.shift();
    return maxRecords;
  }

  // getLogs({ limit, level, since, contains }) -> copy, oldest first
  function getLogs(opts) {
    opts = opts || {};
    var list = records;
    if (opts.level) list = list.filter(function (r) { return r.level === opts.level; });
    if (opts.since) list = list.filter(function (r) { return r.t >= opts.since; });
    if (opts.contains) {
      var needle = String(opts.contains);
      list = list.filter(function (r) { return r.text.indexOf(needle) !== -1; });
    }
    if (opts.limit && list.length > opts.limit) list = list.slice(-opts.limit);
    return list.slice();
  }

  function clearLogs() {
    records.length = 0;
    counts = { trace: 0, debug: 0, info: 0, warn: 0, error: 0, batch: 0 };
    return true;
  }

  function dumpLogs(opts) {
    var list = getLogs(opts);
    console.log(PREFIX + ' dump ' + list.length + ' record(s) counts=' + JSON.stringify(counts));
    list.forEach(function (r) { console.log(PREFIX + ' #' + r.i + ' [' + r.level + '] ' + r.text); });
    return list.length;
  }

  function stats() {
    return {
      stored: records.length, capacity: maxRecords, counts: counts,
      debug: debugEnabled, verbose: verboseEnabled, dropped: Math.max(0, seq - records.length)
    };
  }

  ns.logger = {
    log: log,
    describe: describeValue,
    setDebug: setDebug, isDebug: isDebug,
    setVerbose: setVerbose, isVerbose: isVerbose,
    setBufferSize: setBufferSize,
    getLogs: getLogs, dumpLogs: dumpLogs, clearLogs: clearLogs, stats: stats
  };
})();
