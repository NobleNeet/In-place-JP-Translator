// shared/logger.js
// Classic-script module. Exports: logger.log / setDebug / isDebug
// (loaded as a global-scope script via manifest; see globalThis.__PLAMO__).
(function () {
  var ns = (globalThis.__PLAMO__ = globalThis.__PLAMO__ || {});
  var PREFIX = '[PLaMoTranslate]';
  var debugEnabled = true;

  function setDebug(enabled) { debugEnabled = !!enabled; }
  function isDebug() { return debugEnabled; }

  var log = {
    debug: function (...args) { if (debugEnabled) console.log(PREFIX, ...args); },
    info: function (...args) { console.info(PREFIX, ...args); },
    warn: function (...args) { console.warn(PREFIX, ...args); },
    error: function (...args) { console.error(PREFIX, ...args); },
    batch: function (obj) { if (debugEnabled) console.log(PREFIX, JSON.stringify(obj)); },
    time: function (label, fn) {
      var t0 = performance.now();
      try { return fn(); }
      finally { log.debug(label + ' ' + Math.round(performance.now() - t0) + 'ms'); }
    }
  };

  ns.logger = { log: log, setDebug: setDebug, isDebug: isDebug };
})();
