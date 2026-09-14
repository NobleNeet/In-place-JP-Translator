// translation/scheduler.js
// Classic-script module. Exports: ns.Semaphore
// Concurrency limiter. Runs a queue of async tasks; keeps in-flight count
// <= max. Used by background to bound API fan-out and by the page queue later.
(function () {
  var ns = globalThis.__PLAMO__;

  function Semaphore(max) {
    if (!Number.isFinite(max) || max < 1) throw new Error('Semaphore: max must be >= 1');
    var maxSlots = max;
    var active = 0;
    var queue = [];

    function pump() {
      while (active < maxSlots && queue.length) {
        var next = queue.shift();
        active++;
        next.fn().then(next.ok, next.err).finally(function () {
          active--;
          pump();
        });
      }
    }

    function run(fn) {
      return new Promise(function (resolve, reject) {
        queue.push({ fn: fn, ok: resolve, err: reject });
        pump();
      });
    }

    // Changes the limit in place (used when the popup concurrency setting
    // changes). Replacing the Semaphore instead would let the old queue and the
    // new one run past the limit at the same time.
    function setMax(next) {
      var prev = maxSlots;
      if (Number.isFinite(next) && next >= 1) maxSlots = Math.floor(next);
      if (maxSlots !== prev) pump();
      return { prev: prev, max: maxSlots, active: active, pending: queue.length };
    }

    return {
      run: run,
      setMax: setMax,
      getMax: function () { return maxSlots; },
      getActive: function () { return active; },
      getPending: function () { return queue.length; }
    };
  }

  ns.Semaphore = Semaphore;
})();
